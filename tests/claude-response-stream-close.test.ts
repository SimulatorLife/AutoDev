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
