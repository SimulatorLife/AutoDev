import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  readRouterEvents,
  routerEventsForThread,
  routerLogFiles,
  summarizeRouter
} from "../../src/diagnostics/router-events.ts";
import { traceThread } from "../../src/diagnostics/thread-tracer.ts";
import { CHILD, fixture, routerEvent } from "./fixture.ts";

function childTrace(home: string) {
  const file = path.join(
    home,
    "sessions",
    "2026",
    "09",
    "18",
    `rollout-2026-09-18T17-00-00-${CHILD}.jsonl`
  );
  return traceThread(file, { items: false });
}

test("the rotated logs are read with the live one, newest file first", () => {
  const { routerLog, cleanup } = fixture();
  try {
    const rotated = `${routerLog}.1`;
    writeFileSync(
      rotated,
      `${routerEvent("2026-09-18T21:19:00.000Z", {
        requestId: "req-old",
        phase: "selected",
        provider: "claude"
      })}\n`
    );
    const files = routerLogFiles(routerLog);
    assert.equal(files.length, 2);
    assert.equal(files[0], routerLog);
    assert.equal(files[1], rotated);
  } finally {
    cleanup();
  }
});

test("a router log that does not exist is not an error", () => {
  assert.deepEqual(
    routerLogFiles("/nowhere/codex-model-router.launchd.err.log"),
    []
  );
});

test("the events of a window are read in the order they happened", async () => {
  const { routerLog, cleanup } = fixture();
  try {
    const rows = await readRouterEvents(
      routerLog,
      "2026-09-18T00:00:00.000Z",
      "2026-09-19T00:00:00.000Z"
    );
    assert.equal(rows.length, 4);
    assert.deepEqual(
      rows.map((row) => row.requestId),
      ["req-a", "req-a", "req-b", "req-b"]
    );
  } finally {
    cleanup();
  }
});

test("an event outside the window is not read", async () => {
  const { routerLog, cleanup } = fixture();
  try {
    const rows = await readRouterEvents(
      routerLog,
      "2026-09-18T21:20:30.000Z",
      "2026-09-18T21:26:00.000Z"
    );
    assert.equal(rows.length, 2);
    assert.deepEqual(
      rows.map((row) => row.requestId),
      ["req-a", "req-b"]
    );
  } finally {
    cleanup();
  }
});

test("a thread's requests are summarized by provider, with the failures named", async () => {
  const { home, routerLog, cleanup } = fixture();
  try {
    const rows = await readRouterEvents(
      routerLog,
      "2026-09-18T00:00:00.000Z",
      "2026-09-19T00:00:00.000Z"
    );
    const summary = summarizeRouter(childTrace(home), rows, false);
    assert.equal(summary.requests, 2);
    assert.equal(summary.matchedBy, "model-window");
    assert.deepEqual(summary.providerSequence, ["antigravity", "claude"]);
    assert.deepEqual(summary.modelSequence, ["gemini", "sonnet"]);
    assert.equal(summary.failures.length, 1);
    assert.equal(summary.failures[0]?.provider, "antigravity");
    assert.equal(summary.failures[0]?.status, 502);
  } finally {
    cleanup();
  }
});

test("an event that names its thread matches exactly and never by window", async () => {
  const { home, routerLog, cleanup } = fixture();
  try {
    const rows = await readRouterEvents(
      routerLog,
      "2026-09-18T00:00:00.000Z",
      "2026-09-19T00:00:00.000Z"
    );
    const trace = childTrace(home);
    const named = rows.map((row) => ({ ...row, thread: trace.id }));
    const summary = summarizeRouter(
      { ...trace, start: null, end: null },
      named,
      false
    );
    assert.equal(summary.matchedBy, "thread");
    assert.equal(summary.requests, 2);

    const otherThread = rows.map((row) => ({
      ...row,
      thread: "another-thread"
    }));
    const exact = routerEventsForThread(
      { ...trace, start: null, end: null },
      otherThread
    );
    assert.deepEqual(exact, []);
  } finally {
    cleanup();
  }
});

test("skips, retries, exhaustion waits and transport errors are counted", async () => {
  const { home, cleanup } = fixture();
  try {
    const dir = path.join(home, "run");
    const log = path.join(dir, "router.err.log");
    writeFileSync(
      log,
      [
        routerEvent("2026-09-18T21:20:00.000Z", {
          requestId: "req-s",
          phase: "selected",
          provider: "claude",
          requestedModel: "autodev/worker"
        }),
        routerEvent("2026-09-18T21:20:01.000Z", {
          requestId: "req-s",
          phase: "skipped",
          provider: "claude",
          reason: "probe_unavailable",
          elapsedMs: 12
        }),
        routerEvent("2026-09-18T21:20:02.000Z", {
          requestId: "req-r",
          phase: "retry",
          provider: "claude",
          requestedModel: "autodev/worker"
        }),
        routerEvent("2026-09-18T21:20:03.000Z", {
          requestId: "req-e",
          phase: "exhaustion_wait",
          provider: "claude",
          requestedModel: "autodev/worker",
          elapsedMs: 1500
        }),
        routerEvent("2026-09-18T21:20:04.000Z", {
          requestId: "req-t",
          phase: "transport_error",
          provider: "claude",
          requestedModel: "autodev/worker"
        })
      ].join("\n")
    );
    const rows = await readRouterEvents(
      log,
      "2026-09-18T00:00:00.000Z",
      "2026-09-19T00:00:00.000Z"
    );
    const summary = summarizeRouter(childTrace(home), rows, false);
    assert.equal(summary.skipped?.length, 1);
    assert.equal(summary.skipped?.[0]?.reason, "probe_unavailable");
    assert.equal(summary.retries, 1);
    assert.equal(summary.exhaustionWaits?.count, 1);
    assert.equal(summary.transportErrors, 1);
  } finally {
    cleanup();
  }
});
