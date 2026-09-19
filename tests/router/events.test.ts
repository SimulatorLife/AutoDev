import assert from "node:assert/strict";
import test from "node:test";

import type { RouterEvent } from "../../src/router/events.ts";
import {
  classifyProviderFailure,
  RouterEventRecorder
} from "../../src/router/events.ts";

test("classifyProviderFailure accurately classifies status codes and error bodies", () => {
  assert.equal(classifyProviderFailure(429, "too many requests"), "throttled");
  assert.equal(
    classifyProviderFailure(429, "session limit reached"),
    "session_limit"
  );
  assert.equal(
    classifyProviderFailure(429, "quota exhausted"),
    "quota_exhausted"
  );
  assert.equal(
    classifyProviderFailure(502, "You've hit your weekly limit"),
    "throttled"
  );
  assert.equal(classifyProviderFailure(503, "high demand"), "capacity");
  assert.equal(
    classifyProviderFailure(400, "quota exhausted"),
    "quota_exhausted"
  );
  assert.equal(
    classifyProviderFailure(400, "provider usage limit reached"),
    "quota_exhausted"
  );
  assert.equal(classifyProviderFailure(401, "unauthorized"), "authentication");
  assert.equal(classifyProviderFailure(403, "forbidden"), "authentication");
  assert.equal(classifyProviderFailure(408, "request timed out"), "timeout");
  assert.equal(classifyProviderFailure(502, "bad gateway"), "unavailable");
  assert.equal(
    classifyProviderFailure(503, "temporarily unavailable"),
    "unavailable"
  );
  assert.equal(classifyProviderFailure(504, "gateway error"), "unavailable");
  assert.equal(classifyProviderFailure(504, "gateway timeout"), "timeout");
  assert.equal(
    classifyProviderFailure(404, "unknown model gpt-9"),
    "invalid_model"
  );
  assert.equal(
    classifyProviderFailure(500, "internal server error"),
    "upstream_error"
  );
  assert.equal(
    classifyProviderFailure(400, "malformed request body"),
    "request_error"
  );
});

test("RouterEventRecorder records events and maintains ring buffer", () => {
  const logged: RouterEvent[] = [];
  const listenerEvents: RouterEvent[] = [];

  const recorder = new RouterEventRecorder({
    maxRecentEvents: 3,
    routerInstanceId: "test-router-id",
    logger: (event) => logged.push(event),
    onEvent: (event) => listenerEvents.push(event)
  });

  const event1 = recorder.record({
    phase: "selected",
    requestId: "req-1",
    provider: "claude",
    model: "sonnet",
    role: "worker",
    workspace: { key: "SimulatorLife/AutoDev", cwd: "/Users/henrykirk/AutoDev" }
  });

  assert.equal(event1.schema, "autodev-router-event-v1");
  assert.equal(event1.routerInstanceId, "test-router-id");
  assert.equal(event1.requestId, "req-1");
  assert.equal(event1.workspace, "SimulatorLife/AutoDev");
  assert.equal(event1.cwd, "/Users/henrykirk/AutoDev");
  assert.equal(logged.length, 1);
  assert.equal(listenerEvents.length, 1);

  // String workspace
  recorder.record({
    phase: "selected",
    requestId: "req-2",
    workspace: "SimulatorLife/AutoDev"
  });

  recorder.record({ phase: "selected", requestId: "req-3" });
  assert.equal(recorder.length, 3);

  // 4th event pushes out the first
  recorder.record({ phase: "result", requestId: "req-4" });
  assert.equal(recorder.length, 3);

  const recent = recorder.getRecentEvents();
  assert.equal(recent.length, 3);
  assert.equal(recent[0]?.requestId, "req-2");
  assert.equal(recent[1]?.requestId, "req-3");
  assert.equal(recent[2]?.requestId, "req-4");

  const reversed = recorder.getRecentEvents(true);
  assert.equal(reversed[0]?.requestId, "req-4");
  assert.equal(reversed[1]?.requestId, "req-3");
  assert.equal(reversed[2]?.requestId, "req-2");
});

test("RouterEventRecorder clear and restore handle persistence serialization", () => {
  const recorder = new RouterEventRecorder({
    maxRecentEvents: 2,
    logger: null
  });

  recorder.record({ phase: "selected", requestId: "old-1" });
  recorder.record({ phase: "selected", requestId: "old-2" });
  assert.equal(recorder.length, 2);

  recorder.clear();
  assert.equal(recorder.length, 0);

  recorder.restore([
    { schema: "autodev-router-event-v1", requestId: "restored-1" },
    { schema: "autodev-router-event-v1", requestId: "restored-2" },
    { schema: "autodev-router-event-v1", requestId: "restored-3" }
  ]);

  // Capped to maxRecentEvents = 2
  assert.equal(recorder.length, 2);
  const recent = recorder.getRecentEvents();
  assert.equal(recent[0]?.requestId, "restored-2");
  assert.equal(recent[1]?.requestId, "restored-3");
});

test("RouterEventRecorder uses resolveOrigin to derive orchestrator role for codex provider", () => {
  let passedOrigin: string | null = null;
  const recorder = new RouterEventRecorder({
    logger: null,
    resolveOrigin: (role, provider) => {
      if (role === "orchestrator") return "orchestrator";
      if (role) return "subagent";
      if (provider === "codex") return "orchestrator";
      return "direct";
    },
    onEvent: (_event, _input, effectiveOrigin) => {
      passedOrigin = effectiveOrigin;
    }
  });

  const event = recorder.record({
    phase: "selected",
    requestId: "req-orchestrator",
    requestedModel: "gpt-5.6-sol",
    provider: "codex",
    model: "gpt-5.6-sol"
  });

  assert.equal(event.role, "orchestrator");
  assert.equal(passedOrigin, "orchestrator");
});

test("every event of a request names the Codex thread that sent it", () => {
  // Without it, per-thread diagnostics could only guess by model and time
  // window, and concurrent threads on the same role interleaved.
  const recorder = new RouterEventRecorder({ logger: null });
  recorder.noteRequestThread("req-child", "thread-child");
  assert.equal(
    recorder.record({ phase: "selected", requestId: "req-child" }).thread,
    "thread-child"
  );
  assert.equal(
    recorder.record({
      phase: "result",
      requestId: "req-child",
      outcome: "success"
    }).thread,
    "thread-child"
  );
  assert.equal(
    recorder.record({ phase: "selected", requestId: "req-anonymous" }).thread,
    null
  );
  recorder.noteRequestThread("req-none", null);
  assert.equal(
    recorder.record({ phase: "selected", requestId: "req-none" }).thread,
    null
  );
});
