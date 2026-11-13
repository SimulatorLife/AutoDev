import assert from "node:assert/strict";
import type { ServerResponse } from "node:http";
import test from "node:test";

import { ResponseStream } from "@simulatorlife/autodev-runtime/providers/claude-turn";

/**
 * A stream with `streaming: false` writes nothing, so the constructor's only
 * contact with `response` is registering the close listener. That leaves the
 * close cascade reachable through a plain stub that captures the handler the
 * stream subscribed with.
 */
function makeStream(): { close: () => void; stream: ResponseStream } {
  let onClose: (() => void) | undefined;
  const response = {
    writeHead() {},
    write() {},
    end() {},
    on(event: string, handler: () => void) {
      if (event === "close") onClose = handler;
    },
    once() {},
    removeListener() {},
    headersSent: false
  } as unknown as ServerResponse;
  const stream = new ResponseStream({
    response,
    streaming: false,
    model: "claude-test",
    sendError: () => {}
  });
  return { close: () => onClose?.(), stream };
}

test("the close cascade runs only the listeners registered before the client went away", () => {
  const { close, stream } = makeStream();
  const calls: string[] = [];
  stream.onClientClose(() => {
    calls.push("first");
    // Registered while the cascade is already running. `ended` is true by now,
    // so this listener can never satisfy its own contract -- it was not
    // registered before the stream ended -- and running it inside this cascade
    // also lets a listener that registers on every call drive the loop without
    // bound.
    stream.onClientClose(() => calls.push("late"));
  });
  close();
  assert.deepEqual(
    calls,
    ["first"],
    "a listener registered during the cascade must not run inside it"
  );
});

test("every listener registered before the cascade runs, in registration order", () => {
  const { close, stream } = makeStream();
  const calls: string[] = [];
  stream.onClientClose(() => calls.push("a"));
  stream.onClientClose(() => calls.push("b"));
  stream.onClientClose(() => calls.push("c"));
  close();
  assert.deepEqual(calls, ["a", "b", "c"]);
});

test("the close cascade is committed once even if close is emitted again", () => {
  const { close, stream } = makeStream();
  const calls: string[] = [];
  stream.onClientClose(() => calls.push("only-once"));
  close();
  close();
  assert.deepEqual(calls, ["only-once"]);
  assert.equal(stream.isEnded, true);
});

test("a listener registered after the stream ended never runs", () => {
  const { close, stream } = makeStream();
  const calls: string[] = [];
  close();
  stream.onClientClose(() => calls.push("too-late"));
  close();
  assert.deepEqual(calls, []);
});

/** Capture the actual wire events without starting an HTTP server. */
function makeRecordingStream(streaming: boolean) {
  const writes: string[] = [];
  const errors: unknown[] = [];
  let httpStatus: number | undefined;
  let headersSent = false;
  let writableEnded = false;
  const response = {
    get headersSent() {
      return headersSent;
    },
    get writableEnded() {
      return writableEnded;
    },
    destroyed: false,
    shouldKeepAlive: true,
    writeHead(status: number) {
      httpStatus = status;
      headersSent = true;
    },
    flushHeaders() {},
    write(value: string) {
      writes.push(value);
      return true;
    },
    end(value?: string) {
      if (value) writes.push(value);
      writableEnded = true;
    },
    on() {}
  } as unknown as ServerResponse;
  const stream = new ResponseStream({
    response,
    streaming,
    model: "claude-test",
    sendError: (_response, failure) => errors.push(failure)
  });
  return {
    stream,
    errors,
    get httpStatus() {
      return httpStatus;
    },
    get wire() {
      return writes.join("");
    },
    get events() {
      return writes
        .join("")
        .split("\n")
        .filter((line) => line.startsWith("data: {"))
        .map((line) => JSON.parse(line.slice(6)) as Record<string, any>);
    }
  };
}

test("pre-output streaming limit emits response.failed with structured limit and no output items", () => {
  const recorder = makeRecordingStream(true);
  const failure = {
    error: new Error("Claude quota exhausted"),
    reason: "provider_limit",
    limit: {
      limitClass: "quota_exhausted" as const,
      limitType: "weekly",
      resetsAt: "2026-11-12T00:00:00Z",
      source: "reported" as const
    }
  };
  recorder.stream.fail(failure, "claude");
  const failures = recorder.events.filter(
    (event) => event.type === "response.failed"
  );
  assert.equal(recorder.httpStatus, 200);
  assert.equal(failures.length, 1, recorder.wire);
  assert.equal(failures[0]?.response?.status, "failed");
  assert.deepEqual(failures[0]?.response?.output, []);
  assert.equal(failures[0]?.response?.error?.type, "rate_limit_error");
  assert.deepEqual(failures[0]?.response?.error?.limit, {
    class: "quota_exhausted",
    type: "weekly",
    resets_at: "2026-11-12T00:00:00Z",
    source: "reported"
  });
  assert.equal(
    recorder.events.some(
      (event) => event.type === "response.output_item.added"
    ),
    false
  );
  assert.equal(
    recorder.events.some((event) => event.type === "response.completed"),
    false
  );
  assert.match(recorder.wire, /data: \[DONE\]/);
  assert.equal(recorder.stream.isEnded, true);
  recorder.stream.fail(failure, "claude");
  assert.equal(
    recorder.events.filter((event) => event.type === "response.failed").length,
    1
  );
});

test("pre-output streaming crash emits a single failure without invented limit", () => {
  const recorder = makeRecordingStream(true);
  recorder.stream.fail(
    { error: new Error("CLI crashed"), reason: "interrupted", limit: null },
    "claude"
  );
  const failures = recorder.events.filter(
    (event) => event.type === "response.failed"
  );
  assert.equal(failures.length, 1, recorder.wire);
  assert.equal(failures[0]?.response?.error?.message, "CLI crashed");
  assert.equal(failures[0]?.response?.error?.type, "upstream_error");
  assert.equal(failures[0]?.response?.error?.limit, undefined);
  assert.deepEqual(failures[0]?.response?.output, []);
  assert.equal(
    recorder.events.some((event) => event.type === "response.completed"),
    false
  );
});

test("post-output streaming failure preserves partial output and closes incomplete", () => {
  const recorder = makeRecordingStream(true);
  recorder.stream.text("partial answer");
  recorder.stream.fail(
    {
      error: new Error("quota exhausted"),
      reason: "provider_limit",
      limit: { limitClass: "quota_exhausted", source: "reported" }
    },
    "claude"
  );
  const completed = recorder.events.find(
    (event) => event.type === "response.completed"
  )?.response;
  assert.equal(
    recorder.events.some((event) => event.type === "response.failed"),
    false
  );
  assert.equal(completed?.status, "incomplete");
  assert.match(completed?.output_text ?? "", /partial answer/);
  assert.equal(
    completed?.incomplete_details?.provider_limit?.class,
    "quota_exhausted"
  );
  assert.match(recorder.wire, /data: \[DONE\]/);
});

test("pre-output non-streaming failure still delegates to HTTP error handler", () => {
  const recorder = makeRecordingStream(false);
  const failure = {
    error: new Error("quota exhausted"),
    reason: "provider_limit",
    limit: null
  };
  recorder.stream.fail(failure, "claude");
  assert.deepEqual(recorder.errors, [failure]);
  assert.equal(recorder.wire, "");
  assert.equal(recorder.stream.isEnded, true);
});
