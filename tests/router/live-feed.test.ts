import assert from "node:assert/strict";
import test from "node:test";

import {
  LIVE_FEED_CATEGORIES,
  LIVE_FEED_NUMERIC_KEYS,
  LiveFeedRecorder
} from "../../src/router/live-feed.ts";

test("live feed recorder keeps bounded, categorized, privacy-safe summaries", () => {
  const feed = new LiveFeedRecorder(2);
  feed.record({
    category: "routing",
    type: "routing.selected",
    summary: "selected claude/sonnet",
    requestId: "req-1"
  });
  feed.record({
    category: "tools",
    type: "tool_executed",
    summary: "tool_executed: exec_command",
    requestId: "req-1"
  });
  feed.record({
    category: "mcp",
    type: "otel.traces",
    summary: "make_rmcp_client"
  });

  assert.deepEqual(
    feed.getRecentEvents().map((event) => event.category),
    ["mcp", "tools"]
  );
  assert.equal(feed.getRecentEvents()[0]?.summary, "make_rmcp_client");
  assert.equal(feed.getRecentEvents()[1]?.requestId, "req-1");
  assert.deepEqual(LIVE_FEED_CATEGORIES, [
    "routing",
    "tools",
    "hooks",
    "skills",
    "mcp",
    "telemetry",
    "runtime"
  ]);
});

test("live feed restore rejects unknown categories and preserves known events", () => {
  const feed = new LiveFeedRecorder();
  feed.restore([
    {
      category: "routing",
      type: "routing.result",
      summary: "success",
      timestamp: "2026-09-19T00:00:00.000Z"
    },
    { category: "unknown", type: "secret", summary: "should not render" }
  ]);

  assert.equal(feed.getRecentEvents().length, 1);
  assert.equal(feed.getRecentEvents()[0]?.category, "routing");
});

test("live feed recorder preserves occurrence detail fields from routing events", () => {
  const feed = new LiveFeedRecorder();
  const ts = "2026-09-27T12:00:00.000Z";
  feed.record({
    category: "routing",
    type: "routing.result",
    summary: "result codex/gpt-5",
    timestamp: ts,
    requestId: "req-7",
    provider: "codex",
    model: "gpt-5",
    role: "orchestrator",
    workspace: "/tmp/ws-a",
    phase: "result",
    outcome: "failure",
    status: 502,
    failureClass: "upstream_error",
    denialReason: null,
    spawnFailureReason: null,
    durationMs: 1234,
    name: "codex/gpt-5"
  });

  const [event] = feed.getRecentEvents();
  assert.equal(event?.phase, "result");
  assert.equal(event?.outcome, "failure");
  assert.equal(event?.status, 502);
  assert.equal(event?.failureClass, "upstream_error");
  assert.equal(event?.durationMs, 1234);
  assert.equal(event?.name, "codex/gpt-5");
  assert.equal(event?.timestamp, ts);
});

test("live feed recorder preserves occurrence detail fields from agent/OTEL events", () => {
  const feed = new LiveFeedRecorder();
  const ts = "2026-09-27T12:05:00.000Z";
  feed.record({
    category: "tools",
    type: "tool_executed",
    summary: "tool_executed: exec_command",
    timestamp: ts,
    requestId: "req-9",
    provider: "codex",
    model: "gpt-5",
    role: "orchestrator",
    workspace: "/tmp/ws-b",
    phase: "tool_executed",
    outcome: "success",
    status: "ok",
    durationMs: 87,
    durationSeconds: 0.087,
    name: "exec_command",
    tool: "exec_command",
    server: null,
    source: "codex",
    skill: null,
    hook: null,
    handlerType: "native"
  });
  feed.record({
    category: "hooks",
    type: "otel.logs",
    summary: "codex.hooks.run",
    timestamp: ts,
    name: "codex.hooks.run",
    hook: "PreToolUse",
    source: "codex",
    handlerType: "native",
    durationMs: 9,
    status: "ok"
  });
  feed.record({
    category: "skills",
    type: "skill_used",
    summary: "skill_used: ccc",
    timestamp: ts,
    name: "ccc",
    skill: "ccc",
    outcome: "success"
  });
  feed.record({
    category: "mcp",
    type: "otel.traces",
    summary: "codex.mcp.discover",
    timestamp: ts,
    name: "codex.mcp.discover",
    server: "playwright",
    durationMs: 211
  });

  const events = feed.getRecentEvents().reverse();
  assert.equal(events.length, 4);
  assert.equal(events[0]?.tool, "exec_command");
  assert.equal(events[0]?.durationMs, 87);
  assert.equal(events[0]?.status, "ok");
  assert.equal(events[1]?.hook, "PreToolUse");
  assert.equal(events[1]?.handlerType, "native");
  assert.equal(events[2]?.skill, "ccc");
  assert.equal(events[2]?.outcome, "success");
  assert.equal(events[3]?.server, "playwright");
  assert.equal(events[3]?.durationMs, 211);
  assert.deepEqual(
    [...LIVE_FEED_NUMERIC_KEYS],
    ["durationMs", "durationSeconds"]
  );
});

test("live feed restore round-trips every preserved occurrence field", () => {
  const original = new LiveFeedRecorder();
  const ts = "2026-09-27T13:00:00.000Z";
  original.record({
    category: "tools",
    type: "tool_executed",
    summary: "tool_executed: bash",
    timestamp: ts,
    requestId: "req-12",
    provider: "codex",
    model: "gpt-5",
    role: "subagent",
    workspace: "/tmp/ws-c",
    phase: "tool_executed",
    outcome: "failure",
    status: "error",
    durationMs: 42,
    name: "bash",
    tool: "bash",
    source: "codex",
    handlerType: "native"
  });

  const snapshot = original.getRecentEvents().map((event) => ({ ...event }));
  const restored = new LiveFeedRecorder();
  restored.restore(snapshot);

  const [event] = restored.getRecentEvents();
  assert.equal(event?.category, "tools");
  assert.equal(event?.timestamp, ts);
  assert.equal(event?.requestId, "req-12");
  assert.equal(event?.phase, "tool_executed");
  assert.equal(event?.outcome, "failure");
  assert.equal(event?.status, "error");
  assert.equal(event?.durationMs, 42);
  assert.equal(event?.name, "bash");
  assert.equal(event?.tool, "bash");
  assert.equal(event?.source, "codex");
  assert.equal(event?.handlerType, "native");
  assert.equal(event?.role, "subagent");
  assert.equal(event?.workspace, "/tmp/ws-c");
});

test("OTel agent correlation survives local snapshots but is omitted from public status views", () => {
  const original = new LiveFeedRecorder();
  original.record({
    category: "telemetry",
    type: "otel.logs",
    summary: "codex.tool_result",
    timestamp: "2026-09-27T13:30:00.000Z",
    agent: "thread-17"
  });

  assert.equal(original.getRecentEvents(false)[0]?.agent, undefined);
  const snapshot = original.getRecentEvents(false, true);
  assert.equal(snapshot[0]?.agent, "thread-17");

  const restored = new LiveFeedRecorder();
  restored.restore(snapshot);
  assert.equal(restored.getRecentEvents(false, true)[0]?.agent, "thread-17");
  assert.equal(restored.getRecentEvents(false)[0]?.agent, undefined);
});

test("live feed recorder drops non-positive durations and trims text fields", () => {
  const feed = new LiveFeedRecorder();
  feed.record({
    category: "tools",
    type: "tool_executed",
    summary: " ", // should fall back to default
    timestamp: "2026-09-27T14:00:00.000Z",
    name: "   ",
    tool: "",
    durationMs: -10,
    durationSeconds: Number.NaN,
    status: 0
  });
  const [event] = feed.getRecentEvents();
  assert.equal(event?.summary, "Live telemetry event");
  assert.equal(event?.name, undefined);
  assert.equal(event?.tool, undefined);
  assert.equal(event?.durationMs, undefined);
  assert.equal(event?.durationSeconds, undefined);
  // status of 0 is preserved when it is a finite number, so the dashboard
  // can distinguish "zero" from "unknown" rather than collapsing both into `—`.
  assert.equal(event?.status, 0);
});
