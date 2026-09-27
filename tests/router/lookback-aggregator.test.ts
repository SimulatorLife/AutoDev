import assert from "node:assert/strict";
import test from "node:test";

import type { RouterEvent } from "../../src/router/events.ts";
import type { LiveFeedEvent } from "../../src/router/live-feed.ts";
import {
  aggregateLookbackView,
  applyIntervalLookback,
  LOOKBACK_SELECTIONS,
  type LookbackSelection,
  type LookbackSpawnFailureRecord,
  type LookbackSubagentRecord,
  lookbackWindowStartMs
} from "../../src/router/lookback-aggregator.ts";
import type { OtelLookbackEvent } from "../../src/router/otel.ts";

/**
 * Tests in this file drive the production aggregator directly. The
 * fixture mixes timestamps from across every dashboard window so a single
 * `now` value exercises the All / Today / 1h / 2h / 5h / 12h selector at
 * once. The aggregator must not derive interval totals from lifetime
 * cumulative maps -- every counter below is rebuilt from the bounded
 * `recentEvents` + `liveFeed` + `subagentRecent` + `spawnFailureRecent`
 * inputs only.
 */

const NOW = Date.parse("2026-09-27T18:00:00.000Z");

const T_36H_AGO = "2026-09-26T06:00:00.000Z"; // > 12h, outside every window
const T_11H_AGO = "2026-09-27T07:00:00.000Z"; // inside 12h, outside 5h
const T_4H_AGO = "2026-09-27T14:00:00.000Z"; // inside 5h, outside 2h
const T_90_MIN_AGO = "2026-09-27T16:30:00.000Z"; // inside 2h, outside 1h
const T_30_MIN_AGO = "2026-09-27T17:30:00.000Z"; // inside 1h
const T_NOW = "2026-09-27T18:00:00.000Z"; // boundary
const T_FUTURE = "2026-09-27T18:01:00.000Z"; // outside the interval end

function routingEvent(
  partial: Partial<RouterEvent> &
    Pick<RouterEvent, "phase" | "requestId" | "timestamp">
): RouterEvent {
  return {
    schema: "autodev-router-event-v1",
    routerInstanceId: "test-router",
    thread: null,
    role: null,
    requestedModel: null,
    provider: null,
    model: null,
    workspace: null,
    cwd: null,
    outcome: null,
    status: null,
    failureClass: null,
    denialReason: null,
    spawnFailureReason: null,
    elapsedMs: null,
    toolCalls: 0,
    errorName: null,
    errorCode: null,
    syscall: null,
    selection: null,
    normalizedItemIds: 0,
    droppedReasoningItems: 0,
    ...partial
  };
}

function liveFeedEvent(
  partial: Partial<LiveFeedEvent> &
    Pick<LiveFeedEvent, "category" | "type" | "timestamp">
): LiveFeedEvent {
  const { summary, ...fields } = partial;
  return {
    summary: summary ?? `${partial.category}/${partial.type}`,
    ...fields
  };
}

function otelLookbackEvent(
  partial: Partial<OtelLookbackEvent> &
    Pick<OtelLookbackEvent, "timestamp" | "family" | "type" | "name">
): OtelLookbackEvent {
  return {
    source: null,
    server: null,
    status: null,
    countDelta: 1,
    durationCount: null,
    durationSumMs: null,
    workspace: null,
    role: null,
    model: null,
    agent: null,
    resolvedCall: false,
    ...partial,
    timestamp: partial.timestamp,
    family: partial.family,
    type: partial.type,
    name: partial.name
  };
}

function buildFixture(): {
  recentEvents: RouterEvent[];
  liveFeed: LiveFeedEvent[];
  otelLookbackEvents: OtelLookbackEvent[];
  subagents: LookbackSubagentRecord[];
  spawnFailures: LookbackSpawnFailureRecord[];
} {
  const recentEvents: RouterEvent[] = [
    // 36h ago: outside every window
    routingEvent({
      timestamp: T_36H_AGO,
      requestId: "r-old-1",
      phase: "selected",
      provider: "codex",
      model: "gpt-5",
      role: "orchestrator",
      workspace: "/tmp/ws-old"
    }),
    routingEvent({
      timestamp: T_36H_AGO,
      requestId: "r-old-1",
      phase: "result",
      provider: "codex",
      model: "gpt-5",
      role: "orchestrator",
      workspace: "/tmp/ws-old",
      outcome: "success",
      status: 200,
      elapsedMs: 1500,
      toolCalls: 2
    }),
    // 11h ago: inside 12h, outside 5h
    routingEvent({
      timestamp: T_11H_AGO,
      requestId: "r-12h-1",
      phase: "selected",
      provider: "claude",
      model: "sonnet",
      role: "subagent",
      workspace: "/tmp/ws-12h"
    }),
    routingEvent({
      timestamp: T_11H_AGO,
      requestId: "r-12h-1",
      phase: "result",
      provider: "claude",
      model: "sonnet",
      role: "subagent",
      workspace: "/tmp/ws-12h",
      outcome: "failure",
      status: 502,
      failureClass: "upstream_error",
      elapsedMs: 900,
      toolCalls: 1
    }),
    // 4h ago: inside 5h, outside 2h
    routingEvent({
      timestamp: T_4H_AGO,
      requestId: "r-5h-1",
      phase: "selected",
      provider: "codex",
      model: "gpt-5",
      role: "orchestrator",
      workspace: "/tmp/ws-5h"
    }),
    routingEvent({
      timestamp: T_4H_AGO,
      requestId: "r-5h-1",
      phase: "result",
      provider: "codex",
      model: "gpt-5",
      role: "orchestrator",
      workspace: "/tmp/ws-5h",
      outcome: "success",
      status: 200,
      elapsedMs: 600,
      toolCalls: 0
    }),
    routingEvent({
      timestamp: T_4H_AGO,
      requestId: "r-5h-2",
      phase: "skipped",
      provider: "claude",
      model: "sonnet",
      role: "orchestrator",
      workspace: "/tmp/ws-5h",
      failureClass: "provider_disabled"
    }),
    // 90 minutes ago: inside 2h, outside 1h
    routingEvent({
      timestamp: T_90_MIN_AGO,
      requestId: "r-2h-1",
      phase: "selected",
      provider: "codex",
      model: "gpt-5",
      role: "orchestrator",
      workspace: "/tmp/ws-2h"
    }),
    routingEvent({
      timestamp: T_90_MIN_AGO,
      requestId: "r-2h-1",
      phase: "result",
      provider: "codex",
      model: "gpt-5",
      role: "orchestrator",
      workspace: "/tmp/ws-2h",
      outcome: "success",
      status: 200,
      elapsedMs: 300,
      toolCalls: 1
    }),
    // 30 minutes ago: inside 1h
    routingEvent({
      timestamp: T_30_MIN_AGO,
      requestId: "r-1h-1",
      phase: "selected",
      provider: "codex",
      model: "gpt-5",
      role: "orchestrator",
      workspace: "/tmp/ws-1h"
    }),
    routingEvent({
      timestamp: T_30_MIN_AGO,
      requestId: "r-1h-1",
      phase: "result",
      provider: "codex",
      model: "gpt-5",
      role: "orchestrator",
      workspace: "/tmp/ws-1h",
      outcome: "success",
      status: 200,
      elapsedMs: 200,
      toolCalls: 3
    }),
    // Boundary event at `now`
    routingEvent({
      timestamp: T_NOW,
      requestId: "r-now-1",
      phase: "denied",
      role: "orchestrator",
      workspace: "/tmp/ws-now",
      denialReason: "concurrency_limit"
    }),
    routingEvent({
      timestamp: "not-a-timestamp",
      requestId: "r-invalid-time",
      phase: "selected",
      provider: "codex",
      model: "gpt-5"
    }),
    routingEvent({
      timestamp: T_FUTURE,
      requestId: "r-future-time",
      phase: "selected",
      provider: "codex",
      model: "gpt-5"
    })
  ];

  const liveFeed: LiveFeedEvent[] = [
    // Tool executed 11h ago (counts in 12h window, not in 5h)
    liveFeedEvent({
      timestamp: T_11H_AGO,
      category: "tools",
      type: "tool_executed",
      summary: "tool_executed: bash",
      tool: "bash",
      source: "codex",
      outcome: "success",
      status: "ok",
      durationMs: 80
    }),
    // Tool executed 4h ago (counts in 5h window)
    liveFeedEvent({
      timestamp: T_4H_AGO,
      category: "tools",
      type: "tool_executed",
      summary: "tool_executed: edit",
      tool: "edit",
      source: "codex",
      outcome: "success",
      status: "ok",
      durationMs: 50
    }),
    // Tool unavailable 30 minutes ago (counts in 1h)
    liveFeedEvent({
      timestamp: T_30_MIN_AGO,
      category: "tools",
      type: "tool_unavailable",
      summary: "tool_unavailable: read",
      tool: "read",
      source: "codex",
      outcome: "failure",
      status: "error",
      failureClass: "tool_unavailable",
      workspace: "/tmp/ws-1h"
    }),
    // Hook 30 minutes ago
    liveFeedEvent({
      timestamp: T_30_MIN_AGO,
      category: "hooks",
      type: "otel.logs",
      summary: "codex.hooks.run",
      hook: "PreToolUse",
      source: "codex",
      handlerType: "native",
      outcome: "success",
      status: "ok",
      durationMs: 9
    }),
    // Skill used 90 minutes ago (counts in 2h)
    liveFeedEvent({
      timestamp: T_90_MIN_AGO,
      category: "skills",
      type: "skill_used",
      summary: "skill_used: ccc",
      skill: "ccc",
      outcome: "success",
      status: "ok",
      workspace: "/tmp/ws-2h"
    }),
    // Skill exposed 30 minutes ago (counts in 1h)
    liveFeedEvent({
      timestamp: T_30_MIN_AGO,
      category: "skills",
      type: "skill_exposed",
      summary: "skill_exposed: ccc",
      skill: "ccc",
      workspace: "/tmp/ws-1h"
    }),
    // MCP exposure 4h ago (counts in 5h)
    liveFeedEvent({
      timestamp: T_4H_AGO,
      category: "mcp",
      type: "mcp_exposed",
      summary: "mcp_exposed: playwright",
      server: "playwright",
      outcome: "success",
      status: "ok",
      role: "orchestrator",
      model: "gpt-5",
      workspace: "/tmp/ws-5h"
    }),
    liveFeedEvent({
      timestamp: "invalid-time",
      category: "tools",
      type: "tool_executed",
      summary: "invalid timestamp",
      tool: "invalid"
    }),
    liveFeedEvent({
      timestamp: T_FUTURE,
      category: "tools",
      type: "tool_executed",
      summary: "future event",
      tool: "future"
    })
  ];

  const otelLookbackEvents: OtelLookbackEvent[] = [
    otelLookbackEvent({
      timestamp: T_36H_AGO,
      family: "tool",
      type: "counter",
      name: "stale-tool",
      countDelta: 100,
      status: "ok"
    }),
    otelLookbackEvent({
      timestamp: T_11H_AGO,
      family: "tool",
      type: "counter",
      name: "bash",
      countDelta: 1,
      status: "ok"
    }),
    otelLookbackEvent({
      timestamp: T_4H_AGO,
      family: "tool",
      type: "counter",
      name: "edit",
      countDelta: 1,
      status: "ok",
      workspace: "/tmp/ws-5h"
    }),
    otelLookbackEvent({
      timestamp: T_30_MIN_AGO,
      family: "tool",
      type: "counter",
      name: "read",
      countDelta: 1,
      status: "error",
      workspace: "/tmp/ws-1h"
    }),
    otelLookbackEvent({
      timestamp: T_30_MIN_AGO,
      family: "hook",
      type: "counter",
      name: "PreToolUse",
      countDelta: 1,
      status: "ok"
    }),
    otelLookbackEvent({
      timestamp: T_30_MIN_AGO,
      family: "hook",
      type: "duration",
      name: "PreToolUse",
      durationCount: 1,
      durationSumMs: 9
    }),
    otelLookbackEvent({
      timestamp: T_90_MIN_AGO,
      family: "skill",
      type: "used",
      name: "ccc",
      countDelta: 1,
      status: "ok",
      workspace: "/tmp/ws-2h"
    }),
    otelLookbackEvent({
      timestamp: T_4H_AGO,
      family: "skill",
      type: "injected",
      name: "ccc",
      countDelta: 5,
      status: "ok"
    }),
    otelLookbackEvent({
      timestamp: T_4H_AGO,
      family: "mcp",
      type: "use",
      name: "playwright",
      countDelta: 1,
      status: "ready",
      workspace: "/tmp/ws-5h",
      model: "gpt-5",
      role: "orchestrator"
    }),
    otelLookbackEvent({
      timestamp: T_4H_AGO,
      family: "receiver",
      type: "signal",
      name: "logs"
    }),
    otelLookbackEvent({
      timestamp: T_90_MIN_AGO,
      family: "turn",
      type: "prompt",
      name: "prompt"
    }),
    otelLookbackEvent({
      timestamp: T_30_MIN_AGO,
      family: "turn",
      type: "completed",
      name: "completed"
    }),
    otelLookbackEvent({
      timestamp: T_30_MIN_AGO,
      family: "turn",
      type: "ttft",
      name: "ttft",
      durationCount: 1,
      durationSumMs: 200
    }),
    otelLookbackEvent({
      timestamp: T_30_MIN_AGO,
      family: "token",
      type: "delta",
      name: "input",
      countDelta: 50
    }),
    otelLookbackEvent({
      timestamp: T_30_MIN_AGO,
      family: "token",
      type: "delta",
      name: "output",
      countDelta: 10
    }),
    otelLookbackEvent({
      timestamp: T_30_MIN_AGO,
      family: "tool_result",
      type: "result",
      name: "read_file",
      countDelta: 1,
      status: "ok",
      durationCount: 1,
      durationSumMs: 45,
      workspace: "/tmp/ws-1h",
      server: "filesystem",
      resolvedCall: true
    }),
    otelLookbackEvent({
      timestamp: T_30_MIN_AGO,
      family: "receiver",
      type: "signal",
      name: "traces"
    }),
    otelLookbackEvent({
      timestamp: T_30_MIN_AGO,
      family: "receiver",
      type: "signal",
      name: "metrics"
    }),
    otelLookbackEvent({
      timestamp: T_30_MIN_AGO,
      family: "receiver",
      type: "invalid",
      name: "invalid"
    })
  ];

  const subagents: LookbackSubagentRecord[] = [
    {
      timestamp: T_36H_AGO,
      mechanism: "bridge_native",
      provider: "codex",
      role: "subagent",
      status: "success",
      tool: "agent",
      requestId: "s-old-1",
      workspace: "/tmp/ws-old",
      count: 2
    },
    {
      timestamp: T_4H_AGO,
      mechanism: "bridge_native",
      provider: "codex",
      role: "subagent",
      status: "success",
      tool: "agent",
      requestId: "s-5h-1",
      workspace: "/tmp/ws-5h",
      count: 3
    },
    {
      timestamp: T_30_MIN_AGO,
      mechanism: "bridge_native",
      provider: "claude",
      role: "subagent",
      status: "failure",
      tool: "agent",
      requestId: "s-1h-1",
      workspace: "/tmp/ws-1h",
      count: 1
    }
  ];

  const spawnFailures: LookbackSpawnFailureRecord[] = [
    {
      timestamp: T_36H_AGO,
      reason: "spawn_tool_unavailable",
      requestId: "f-old-1",
      role: "subagent"
    },
    {
      timestamp: T_30_MIN_AGO,
      reason: "spawn_tool_unavailable",
      requestId: "f-1h-1",
      role: "subagent"
    }
  ];

  return {
    recentEvents,
    liveFeed,
    otelLookbackEvents,
    subagents,
    spawnFailures
  };
}

test("All selection is a no-op and never reaches for lifetime buckets", () => {
  const fixture = buildFixture();
  const override = aggregateLookbackView({
    recentEvents: fixture.recentEvents,
    liveFeed: fixture.liveFeed,
    otelLookbackEvents: fixture.otelLookbackEvents,
    subagentRecent: fixture.subagents,
    spawnFailureRecent: fixture.spawnFailures,
    now: NOW,
    selection: "all"
  });
  assert.equal(override, null);
});

test("1h window only includes routing/liveFeed/subagent/spawnFailures within 1h", () => {
  const fixture = buildFixture();
  const override = aggregateLookbackView({
    recentEvents: fixture.recentEvents,
    liveFeed: fixture.liveFeed,
    otelLookbackEvents: fixture.otelLookbackEvents,
    subagentRecent: fixture.subagents,
    spawnFailureRecent: fixture.spawnFailures,
    now: NOW,
    selection: "1h"
  });
  assert.ok(override, "expected 1h override");

  // Routing: the 1h window covers `r-1h-1` selected+result + `r-now-1` denied.
  // `r-2h-1` (90m ago) is filtered out by the 1h window. `attempts`
  // counts only `selected` phases (denials are tracked in `skipped`).
  assert.equal(override.usage.totals.attempts, 1);
  assert.equal(override.usage.totals.successes, 1);
  assert.equal(override.usage.totals.failures, 0);
  assert.equal(override.usage.totals.skipped, 1); // the `denied` event
  assert.equal(override.usage.totals.toolCalls, 3);
  assert.equal(override.usage.totals.durationMs, 200);
  assert.equal(override.usage.totals.averageDurationMs, 200);
  assert.equal(override.codexTelemetry.turns.prompts, 0);

  // byRole only sees the orchestrator role inside the 1h window
  assert.deepEqual(Object.keys(override.usage.byRole), ["orchestrator"]);
  const orchestratorUsage = override.usage.byRole.orchestrator;
  assert.ok(orchestratorUsage);
  assert.equal(orchestratorUsage.attempts, 1);
  assert.equal(orchestratorUsage.skipped, 1);

  // byModel sees codex/gpt-5 (the 1h r-1h-1 routing pair) plus an
  // `unattributed` bucket from r-now-1 (the denied event carries no
  // provider/model). All buckets are derived from the recent events.
  assert.deepEqual(Object.keys(override.usage.byModel).sort(), [
    "codex/gpt-5",
    "unattributed"
  ]);

  // byWorkspace only sees the 1h workspace + the boundary `now` workspace
  const wsKeys = Object.keys(override.usage.byWorkspace).sort();
  assert.deepEqual(wsKeys, ["/tmp/ws-1h", "/tmp/ws-now"]);

  // Per-provider attempts/successes/failures: codex has 1 attempt + 1 success
  // from r-1h-1. The denied event at `now` carries no provider, so it
  // surfaces under an `unattributed` key with zero counters.
  const codexProvider = override.providers.codex;
  const unattributedProvider = override.providers.unattributed;
  assert.ok(codexProvider);
  assert.ok(unattributedProvider);
  assert.equal(codexProvider.attempts, 1);
  assert.equal(codexProvider.successes, 1);
  assert.equal(codexProvider.failures, 0);
  assert.equal(unattributedProvider.attempts, 0);
  assert.equal(unattributedProvider.successes, 0);
  assert.deepEqual(Object.keys(override.providers).sort(), [
    "codex",
    "unattributed"
  ]);

  // LiveFeed tool/hook/MCP/skill counters reflect the 1h slice only.
  assert.equal(override.codexTelemetry.tools.byTool.length, 1);
  const intervalTool = override.codexTelemetry.tools.byTool[0];
  assert.ok(intervalTool);
  assert.equal(intervalTool.tool, "read");
  assert.equal(intervalTool.count, 1);
  assert.equal(intervalTool.byStatus.error, 1);
  assert.equal(override.codexTelemetry.bridgeEvents.toolExecuted.total, 0);
  assert.equal(override.codexTelemetry.bridgeEvents.toolUnavailable.total, 1);
  assert.equal(
    override.codexTelemetry.bridgeEvents.toolUnavailable.byReason
      .tool_unavailable,
    1
  );
  assert.equal(override.codexTelemetry.hooks.byHook.length, 1);
  const intervalHook = override.codexTelemetry.hooks.byHook[0];
  assert.ok(intervalHook);
  assert.equal(intervalHook.hook, "PreToolUse");
  // The 1h window has no skill use; the separate bridge exposure remains
  // represented in workspace/bridge coverage without fabricating a use row.
  assert.equal(override.codexTelemetry.skills.used.bySkill.length, 0);
  assert.equal(override.codexTelemetry.skills.used.total, 0);
  assert.equal(override.codexTelemetry.skills.exposed.total, 1);
  assert.equal(override.codexTelemetry.mcpServers.length, 1);
  assert.equal(override.codexTelemetry.mcpServers[0]?.name, "filesystem");
  assert.equal(override.codexTelemetry.mcpSummary.observed, 1);
  assert.equal(override.codexTelemetry.turns.prompts, 0);
  assert.equal(override.codexTelemetry.turns.completed, 1);
  assert.equal(override.codexTelemetry.turns.averageTtftMs, 200);
  assert.equal(override.codexTelemetry.tokens.total, 60);
  assert.equal(override.codexTelemetry.toolResults.total, 1);
  assert.equal(override.codexTelemetry.toolResults.executed, 1);
  assert.equal(override.codexTelemetry.toolResults.causeResolved, 1);
  assert.equal(
    override.codexTelemetry.toolResults.executionDurationMs.average,
    45
  );
  assert.deepEqual(override.codexTelemetry.receiver, {
    logs: 0,
    traces: 1,
    metrics: 1,
    invalid: 1
  });
  const workspace = override.usage.byWorkspace["/tmp/ws-1h"];
  assert.ok(workspace);
  assert.equal(workspace.toolsUnavailable, 1);
  assert.equal(workspace.byTool[0]?.tool, "read");
  assert.equal(workspace.byTool[0]?.count, 1);
  assert.equal(workspace.bridgeTools[0]?.tool, "read");
  assert.equal(workspace.bridgeTools[0]?.count, 1);
  assert.equal(workspace.skillsExposed, 1);
  assert.equal(workspace.bridgeSkills[0]?.skill, "ccc");
  assert.equal(workspace.bridgeSkills[0]?.count, 1);

  // Subagents: only the 1h failure remains in the window
  assert.equal(override.subagents.total, 1);
  assert.deepEqual(override.subagents.byStatus, { failure: 1 });
  assert.equal(override.subagents.byProvider.claude, 1);
  assert.equal(override.subagents.recent.length, 1);

  // Spawn failures: only the 1h failure remains
  assert.equal(override.spawnFailures.total, 1);
  assert.deepEqual(override.spawnFailures.byReason, {
    spawn_tool_unavailable: 1
  });
});

test("2h window expands beyond 1h without recomputing from cumulative maps", () => {
  const fixture = buildFixture();
  const override = aggregateLookbackView({
    recentEvents: fixture.recentEvents,
    liveFeed: fixture.liveFeed,
    otelLookbackEvents: fixture.otelLookbackEvents,
    subagentRecent: fixture.subagents,
    spawnFailureRecent: fixture.spawnFailures,
    now: NOW,
    selection: "2h"
  });
  assert.ok(override);

  // r-2h-1 is the new event vs 1h window: 1 more attempt + success.
  assert.equal(override.usage.totals.attempts, 2); // r-2h-1 + r-1h-1 selected
  assert.equal(override.usage.totals.successes, 2);
  assert.equal(override.usage.totals.skipped, 1); // denied
  assert.equal(override.usage.totals.toolCalls, 4); // 1 (2h) + 3 (1h)
  assert.equal(override.usage.totals.durationMs, 500);
  assert.equal(override.codexTelemetry.turns.prompts, 1);
  assert.equal(override.codexTelemetry.turns.completed, 1);

  // Skill: ccc now has 1 use (2h) + 1 exposed (1h, kept across the wider window)
  const skill = override.codexTelemetry.skills.used.bySkill.find(
    (row) => row.skill === "ccc"
  );
  assert.equal(skill?.uses, 1);
  assert.equal(override.codexTelemetry.skills.exposed.total, 1);
  const skillWorkspace = override.usage.byWorkspace["/tmp/ws-2h"];
  assert.ok(skillWorkspace);
  assert.equal(skillWorkspace.skillUses, 1);
  assert.equal(skillWorkspace.bySkill[0]?.skill, "ccc");
});

test("5h window pulls in 4h-ago events that 1h/2h did not see", () => {
  const fixture = buildFixture();
  const override = aggregateLookbackView({
    recentEvents: fixture.recentEvents,
    liveFeed: fixture.liveFeed,
    otelLookbackEvents: fixture.otelLookbackEvents,
    subagentRecent: fixture.subagents,
    spawnFailureRecent: fixture.spawnFailures,
    now: NOW,
    selection: "5h"
  });
  assert.ok(override);

  // r-5h-1 (selected+result) and r-5h-2 (skipped) join r-2h-1, r-1h-1, denied.
  // attempts counts `selected` only.
  assert.equal(override.usage.totals.attempts, 3); // 5h-1, 2h-1, 1h-1
  assert.equal(override.usage.totals.successes, 3);
  assert.equal(override.usage.totals.skipped, 2); // skipped + denied
  assert.equal(override.usage.totals.durationMs, 1100);
  assert.equal(override.usage.totals.averageDurationMs, 1100 / 3);
  assert.equal(override.usage.totals.toolCalls, 4);

  // claude appears now (5h-2 was a `skipped` for claude)
  assert.equal(override.usage.byRole.subagent, undefined);
  assert.ok(override.usage.byRole.orchestrator);
  const claudeProvider = override.providers.claude;
  assert.ok(claudeProvider);
  assert.equal(claudeProvider.skipped, 1);
  assert.equal(override.codexTelemetry.receiver.logs, 1);
  assert.equal(override.codexTelemetry.skills.injected.total, 5);

  // 4h-ago tool `edit` joins the `read` 1h tool
  const toolNames = override.codexTelemetry.tools.byTool
    .map((row) => row.tool)
    .sort();
  assert.deepEqual(toolNames, ["edit", "read"]);

  // MCP exposure 4h ago surfaces in the 5h window
  assert.equal(override.codexTelemetry.mcpServers.length, 2);
  const mcpServer = override.codexTelemetry.mcpServers.find(
    (server) => server.name === "playwright"
  );
  assert.ok(mcpServer);
  assert.equal(mcpServer.name, "playwright");
  assert.equal(mcpServer.observed, 1);
  assert.equal(mcpServer.ready, 1);
  assert.equal(override.codexTelemetry.mcpSummary.observed, 2);
  assert.equal(override.codexTelemetry.mcpSummary.ready, 1);
  assert.equal(
    override.codexTelemetry.mcpSummary.byRole.orchestrator?.observed,
    1
  );
  assert.equal(
    override.codexTelemetry.mcpSummary.byModel["gpt-5"]?.observed,
    1
  );
  const workspace = override.usage.byWorkspace["/tmp/ws-5h"];
  assert.ok(workspace);
  assert.equal(workspace.mcpExposed[0]?.server, "playwright");
  assert.equal(workspace.mcpExposed[0]?.count, 1);
  assert.deepEqual(workspace.byMcp, { playwright: 1 });
  assert.equal(workspace.mcpUses[0]?.count, 1);

  // Subagents: 36h-ago entry still filtered out, 5h-ago entry joins.
  assert.equal(override.subagents.total, 4); // 3 (5h) + 1 (1h)
  assert.equal(override.subagents.byProvider.codex, 3);
  assert.equal(override.subagents.byProvider.claude, 1);
});

test("12h window pulls in the 11h-ago routing failure that 5h missed", () => {
  const fixture = buildFixture();
  const override = aggregateLookbackView({
    recentEvents: fixture.recentEvents,
    liveFeed: fixture.liveFeed,
    otelLookbackEvents: fixture.otelLookbackEvents,
    subagentRecent: fixture.subagents,
    spawnFailureRecent: fixture.spawnFailures,
    now: NOW,
    selection: "12h"
  });
  assert.ok(override);

  // claude sonnet 11h-ago failure enters
  assert.ok(override.usage.byRole.subagent);
  assert.equal(override.usage.byRole.subagent.attempts, 1);
  assert.equal(override.usage.byRole.subagent.failures, 1);
  assert.ok(override.providers.claude);
  assert.equal(override.providers.claude.attempts, 1);
  assert.equal(override.providers.claude.successes, 0);
  assert.equal(override.providers.claude.failures, 1);
  assert.equal(override.providers.claude.lastFailureAt, T_11H_AGO);

  // Tool `bash` (11h-ago) joins edit + read
  const toolNames = override.codexTelemetry.tools.byTool
    .map((row) => row.tool)
    .sort();
  assert.deepEqual(toolNames, ["bash", "edit", "read"]);

  // ccc skill still has only 1 use (the 36h-ago attempt is filtered).
  // skill `uses` (skill_used) and skill `exposed` total both come from
  // live feed entries; the 90m-ago skill_used is still in window.
  const skill = override.codexTelemetry.skills.used.bySkill[0];
  assert.ok(skill);
  assert.equal(skill.uses, 1);

  // Totals across 12h: attempts counts `selected` only.
  // selected = 11h-1 + 5h-1 + 2h-1 + 1h-1 = 4
  // successes = 5h-1 (600) + 2h-1 (300) + 1h-1 (200) = 3
  // failures = 11h-1 (900)
  // skipped = 5h-2 + denied = 2
  // toolCalls = 11h-1 (1) + 2h-1 (1) + 1h-1 (3) = 5
  assert.equal(override.usage.totals.attempts, 4);
  assert.equal(override.usage.totals.successes, 3);
  assert.equal(override.usage.totals.failures, 1);
  assert.equal(override.usage.totals.skipped, 2);
  assert.equal(override.usage.totals.durationMs, 2000);
  assert.equal(override.usage.totals.toolCalls, 5);
});

test("Today window filters events to the local calendar day in America/New_York", () => {
  // 2026-09-27T18:00:00Z is 14:00 in America/New_York (still on the same
  // calendar day). The local-day start in NY is 2026-09-27T04:00:00Z
  // (EDT -> UTC-4). The 11h-ago event at 2026-09-27T07:00:00Z is on the
  // same NY calendar day, so it counts.
  const fixture = buildFixture();
  const override = aggregateLookbackView({
    recentEvents: fixture.recentEvents,
    liveFeed: fixture.liveFeed,
    otelLookbackEvents: fixture.otelLookbackEvents,
    subagentRecent: fixture.subagents,
    spawnFailureRecent: fixture.spawnFailures,
    now: NOW,
    selection: "today"
  });
  assert.ok(override);

  assert.ok(
    override.lookback.windowStartMs,
    "Today window must resolve a wall-clock start"
  );
  assert.equal(
    override.lookback.windowStartMs,
    lookbackWindowStartMs(NOW, "today")
  );
  // 36h-ago event (2026-09-26T06:00:00Z) is on the previous NY day and
  // must be excluded even though it sits inside the 5h/12h sliding windows.
  const subagentsRecent = override.subagents.recent.map((row) => row.timestamp);
  assert.ok(!subagentsRecent.includes(T_36H_AGO));
});

test("Today window uses the correct New York offset on both DST transition dates", () => {
  const springForwardNow = Date.parse("2026-03-08T16:00:00.000Z");
  const fallBackNow = Date.parse("2026-11-01T16:00:00.000Z");
  assert.equal(
    lookbackWindowStartMs(springForwardNow, "today"),
    Date.parse("2026-03-08T05:00:00.000Z")
  );
  assert.equal(
    lookbackWindowStartMs(fallBackNow, "today"),
    Date.parse("2026-11-01T04:00:00.000Z")
  );
});

test("Aggregator never reads lifetime cumulative maps and never invents values", () => {
  const _fixture = buildFixture();
  const empty = aggregateLookbackView({
    recentEvents: [],
    liveFeed: [],
    subagentRecent: [],
    spawnFailureRecent: [],
    now: NOW,
    selection: "1h"
  });
  assert.ok(empty);
  assert.equal(empty.usage.totals.attempts, 0);
  assert.equal(empty.usage.totals.successes, 0);
  assert.equal(empty.usage.totals.failures, 0);
  assert.equal(empty.usage.totals.skipped, 0);
  assert.equal(empty.usage.totals.durationMs, 0);
  assert.equal(empty.usage.totals.toolCalls, 0);
  assert.equal(empty.usage.totals.averageDurationMs, 0);
  assert.deepEqual(empty.usage.byRole, {});
  assert.deepEqual(empty.usage.byModel, {});
  assert.deepEqual(empty.usage.byWorkspace, {});
  assert.deepEqual(empty.usage.byOrigin, {});
  assert.deepEqual(empty.providers, {});
  assert.equal(empty.subagents.total, 0);
  assert.deepEqual(empty.subagents.byMechanism, {});
  assert.equal(empty.spawnFailures.total, 0);
  assert.deepEqual(empty.spawnFailures.byReason, {});
  assert.equal(empty.codexTelemetry.tools.byTool.length, 0);
  assert.equal(empty.codexTelemetry.hooks.byHook.length, 0);
  assert.equal(empty.codexTelemetry.skills.used.bySkill.length, 0);
  assert.equal(empty.codexTelemetry.skills.used.total, 0);
  assert.equal(empty.codexTelemetry.skills.exposed.total, 0);
  assert.equal(empty.codexTelemetry.mcpServers.length, 0);
  assert.equal(empty.codexTelemetry.bridgeEvents.toolExecuted.total, 0);
  assert.equal(empty.codexTelemetry.bridgeEvents.toolRequested.total, 0);
  assert.equal(empty.codexTelemetry.bridgeEvents.toolUnavailable.total, 0);
  assert.equal(empty.codexTelemetry.bridgeEvents.skillExposed.total, 0);
});

test("applyIntervalLookback spreads interval overrides into a status payload", () => {
  const fixture = buildFixture();
  const lifetime = {
    schema: "autodev-router-status-v2",
    usage: {
      totals: {
        attempts: 999,
        successes: 999,
        failures: 0,
        skipped: 0,
        durationMs: 0,
        maxDurationMs: 0,
        toolCalls: 0,
        averageDurationMs: 0
      },
      byRole: {},
      byModel: {},
      byWorkspace: {},
      byOrigin: {}
    },
    codexTelemetry: {
      tools: {
        byTool: [
          {
            tool: "stale",
            source: null,
            server: null,
            count: 1,
            byStatus: {},
            durationCount: 0,
            durationMs: 0,
            averageDurationMs: 0
          }
        ]
      },
      hooks: { byHook: [] },
      skills: {
        used: { total: 999, bySkill: [] },
        injected: { total: 999, bySkill: [] },
        exposed: { total: 999 }
      },
      lookbackEvents: fixture.otelLookbackEvents,
      mcpServers: [
        {
          name: "stale-server",
          observed: 1,
          ready: 1,
          error: 0,
          stale: 0,
          lastSeenAt: null,
          byModel: {},
          byRole: {}
        }
      ],
      bridgeEvents: {
        toolExecuted: { total: 999, byTool: {} },
        toolRequested: { total: 0, byTool: {} },
        toolUnavailable: { total: 0, byTool: {}, byReason: {} },
        skillExposed: { total: 0 }
      }
    },
    providers: {
      codex: {
        attempts: 999,
        successes: 999,
        failures: 0,
        skipped: 0,
        status: "ready",
        cooldownRemainingMs: 0
      },
      claude: {
        attempts: 999,
        successes: 999,
        failures: 0,
        skipped: 0,
        status: "ready",
        cooldownRemainingMs: 0
      }
    },
    subagents: {
      total: 999,
      recent: fixture.subagents,
      byMechanism: {},
      byProvider: {},
      byRole: {},
      byStatus: {}
    },
    spawnFailures: { total: 999, recent: fixture.spawnFailures, byReason: {} },
    recentEvents: fixture.recentEvents,
    liveFeed: fixture.liveFeed,
    otelLookbackEvents: fixture.otelLookbackEvents,
    codexState: { localTelemetry: { status: "ok" } },
    concurrency: { activeSessions: 1, activeSubagentThreads: 1 }
  };
  const interval = applyIntervalLookback(lifetime, "1h", NOW);
  assert.equal(interval.usage.totals.attempts, 1);
  assert.notEqual(
    (interval.usage.totals as { attempts: number }).attempts,
    999
  );
  assert.equal(
    (interval.codexTelemetry.tools.byTool[0] as { tool: string }).tool,
    "read"
  );
  // No `skill_used` events fall inside the 1h window (the 90m-ago
  // skill_used is filtered out). The 30m-ago event is `skill_exposed`,
  // which counts only toward `skills.exposed.total`.
  assert.equal(interval.codexTelemetry.skills.used.total, 0);
  assert.equal(interval.codexTelemetry.skills.injected.total, 0);
  assert.equal(interval.codexTelemetry.skills.exposed.total, 1);
  assert.equal(interval.subagents.total, 1);
  assert.equal(interval.spawnFailures.total, 1);
  assert.equal(
    interval.providers.codex.attempts,
    1,
    "lifetime cumulative codex attempts must not leak into interval view"
  );
  // claude had no activity in the 1h window, but the merge keeps
  // the provider's configuration (status/cooldownRemainingMs) and
  // resets only the routing counters (attempts/successes/failures).
  assert.ok(
    interval.providers.claude,
    "provider config must survive the interval merge"
  );
  assert.equal(
    interval.providers.claude.attempts,
    0,
    "interval view must not leak lifetime provider counters"
  );
  assert.equal(interval.providers.claude.successes, 0);
  assert.equal(interval.providers.claude.failures, 0);
  assert.equal(interval.providers.claude.status, "ready");
  // Current-state fields must pass through unchanged.
  assert.equal(
    (interval.codexState as { localTelemetry: { status: string } })
      .localTelemetry.status,
    "ok"
  );
  assert.equal(
    (interval.concurrency as { activeSessions: number }).activeSessions,
    1
  );
  assert.ok(interval.lookback);
  assert.equal(interval.lookback?.selection, "1h");
  assert.ok(
    interval.codexTelemetry.lookbackEvents.every(
      (event) =>
        Date.parse(event.timestamp) >= lookbackWindowStartMs(NOW, "1h")! &&
        Date.parse(event.timestamp) <= NOW
    )
  );
  assert.equal(interval.lookback?.boundedByRingBuffer, true);
  assert.ok(
    interval.recentEvents.every(
      (event) =>
        Date.parse(event.timestamp) >= lookbackWindowStartMs(NOW, "1h")! &&
        Date.parse(event.timestamp) <= NOW
    ),
    "router events returned to the dashboard must be inside the selected window"
  );
  assert.ok(
    interval.liveFeed.every(
      (event) =>
        Date.parse(event.timestamp) >= lookbackWindowStartMs(NOW, "1h")! &&
        Date.parse(event.timestamp) <= NOW
    ),
    "live-feed rows returned to the dashboard must be inside the selected window"
  );

  const lifetime2 = applyIntervalLookback(lifetime, "all", NOW);
  assert.strictEqual(lifetime2, lifetime);
});

test("Selection token enumeration covers the dashboard's option values", () => {
  assert.deepEqual(
    [...LOOKBACK_SELECTIONS],
    ["all", "active", "today", "1h", "2h", "5h", "12h"]
  );
});

test("Lookback subagent + spawn-failure recent arrays sort newest-first behavior is preserved", () => {
  const fixture = buildFixture();
  const override = aggregateLookbackView({
    recentEvents: fixture.recentEvents,
    liveFeed: fixture.liveFeed,
    otelLookbackEvents: fixture.otelLookbackEvents,
    subagentRecent: fixture.subagents,
    spawnFailureRecent: fixture.spawnFailures,
    now: NOW,
    selection: "12h"
  });
  assert.ok(override);
  // The aggregator preserves insertion order from the input arrays
  // (subagent telemetry appends to `recent` oldest-first; the server's
  // `subagentStatus()` reverses for display). The aggregator must not
  // duplicate or drop any subagent entry that fell inside the window.
  const fixtureInWindow = fixture.subagents.filter(
    (row) => Date.parse(row.timestamp) >= lookbackWindowStartMs(NOW, "12h")!
  );
  assert.equal(
    override.subagents.recent.length,
    fixtureInWindow.length,
    "interval subagent.recent must equal every window-eligible fixture row"
  );
  const fixtureFailuresInWindow = fixture.spawnFailures.filter(
    (row) => Date.parse(row.timestamp) >= lookbackWindowStartMs(NOW, "12h")!
  );
  assert.equal(
    override.spawnFailures.recent.length,
    fixtureFailuresInWindow.length
  );
});

test("Selection type is statically constrained to dashboard options", () => {
  const selections: LookbackSelection[] = [
    "all",
    "active",
    "today",
    "1h",
    "2h",
    "5h",
    "12h"
  ];
  for (const selection of selections) {
    const view = aggregateLookbackView({
      recentEvents: buildFixture().recentEvents,
      liveFeed: [],
      now: NOW,
      selection
    });
    if (selection === "all") {
      assert.equal(view, null);
    } else {
      assert.ok(view);
      assert.equal(view.lookback.selection, selection);
    }
  }
});

test("Active Sessions rebuilds all activity from exact live-agent identities, not timestamps", () => {
  const activeAgents = [
    { subject: "root-thread", requestId: "root-current" },
    {
      subject: "thread:child-thread",
      requestId: "child-current"
    }
  ];
  const recentEvents = [
    routingEvent({
      timestamp: "2020-01-01T00:00:00.000Z",
      requestId: "root-old",
      thread: "root-thread",
      phase: "selected",
      provider: "codex",
      model: "gpt-5",
      role: "orchestrator",
      workspace: "/tmp/root"
    }),
    routingEvent({
      timestamp: "2020-01-01T00:00:01.000Z",
      requestId: "root-old",
      thread: "root-thread",
      phase: "result",
      provider: "codex",
      model: "gpt-5",
      role: "orchestrator",
      workspace: "/tmp/root",
      outcome: "success",
      elapsedMs: 240,
      toolCalls: 2
    }),
    routingEvent({
      timestamp: "2099-01-01T00:00:00.000Z",
      requestId: "child-old",
      thread: "child-thread",
      phase: "selected",
      provider: "claude",
      model: "sonnet",
      role: "subagent",
      workspace: "/tmp/child"
    }),
    routingEvent({
      timestamp: T_NOW,
      requestId: "inactive-request",
      thread: "inactive-thread",
      phase: "selected",
      provider: "gemini",
      model: "gemini-pro",
      role: "subagent",
      workspace: "/tmp/inactive"
    }),
    routingEvent({
      timestamp: T_NOW,
      requestId: "root-current",
      thread: null,
      phase: "denied",
      failureClass: "concurrency_limit"
    })
  ];
  const liveFeed = [
    liveFeedEvent({
      timestamp: "2020-01-01T00:00:02.000Z",
      category: "tools",
      type: "tool_executed",
      requestId: "root-old",
      workspace: "/tmp/root",
      tool: "exec",
      outcome: "success"
    }),
    liveFeedEvent({
      timestamp: T_NOW,
      category: "tools",
      type: "tool_executed",
      requestId: "inactive-request",
      workspace: "/tmp/inactive",
      tool: "exec",
      outcome: "success"
    }),
    liveFeedEvent({
      timestamp: T_NOW,
      category: "skills",
      type: "skill_used",
      requestId: "root-current",
      workspace: "/tmp/root",
      skill: "active-skill",
      outcome: "success"
    }),
    liveFeedEvent({
      timestamp: T_NOW,
      category: "telemetry",
      type: "otel.metrics",
      summary: "unattributed OTel event"
    }),
    liveFeedEvent({
      timestamp: "2020-01-01T00:00:03.000Z",
      category: "telemetry",
      type: "otel.logs",
      summary: "active OTel event",
      agent: "root-thread"
    }),
    liveFeedEvent({
      timestamp: T_NOW,
      category: "telemetry",
      type: "otel.logs",
      summary: "inactive OTel event",
      agent: "inactive-thread"
    })
  ];
  const otelLookbackEvents = [
    otelLookbackEvent({
      timestamp: "2020-01-01T00:00:00.000Z",
      family: "token",
      type: "delta",
      name: "input",
      agent: "root-thread",
      countDelta: 12
    }),
    otelLookbackEvent({
      timestamp: "2020-01-01T00:00:00.000Z",
      family: "skill",
      type: "duration",
      name: "codex.thread.skills.kept_total",
      agent: "root-thread",
      countDelta: 2,
      sumDelta: 8
    }),
    otelLookbackEvent({
      timestamp: "2020-01-01T00:00:00.000Z",
      family: "tool",
      type: "counter",
      name: "exec",
      source: "codex",
      status: "skipped",
      agent: "root-thread",
      countDelta: 2
    }),
    otelLookbackEvent({
      timestamp: "2020-01-01T00:00:00.000Z",
      family: "turn",
      type: "thread_started",
      name: "codex.thread.started",
      source: "codex",
      agent: "root-thread",
      countDelta: 4
    }),
    otelLookbackEvent({
      timestamp: "2020-01-01T00:00:00.000Z",
      family: "turn",
      type: "thread_spawn",
      name: "codex.multi_agent.spawn",
      status: "started",
      role: "orchestrator",
      model: "gpt-5",
      agent: "root-thread",
      countDelta: 2
    }),
    otelLookbackEvent({
      timestamp: "2099-01-01T00:00:00.000Z",
      family: "token",
      type: "delta",
      name: "output",
      agent: "child-thread",
      countDelta: 3
    }),
    otelLookbackEvent({
      timestamp: T_NOW,
      family: "token",
      type: "delta",
      name: "input",
      agent: "inactive-thread",
      countDelta: 500
    }),
    otelLookbackEvent({
      timestamp: T_NOW,
      family: "token",
      type: "delta",
      name: "input",
      agent: "unattributed",
      countDelta: 1000
    }),
    otelLookbackEvent({
      timestamp: T_NOW,
      family: "turn",
      type: "thread_started",
      name: "codex.thread.started",
      source: "codex",
      agent: "inactive-thread",
      countDelta: 500
    })
  ];
  const subagents: LookbackSubagentRecord[] = [
    {
      timestamp: "2020-01-01T00:00:00.000Z",
      mechanism: "bridge_native",
      provider: "codex",
      role: "subagent",
      status: "started",
      tool: "spawn_agent",
      requestId: "root-old",
      workspace: "/tmp/root",
      count: 1
    },
    {
      timestamp: T_NOW,
      mechanism: "bridge_native",
      provider: "gemini",
      role: "subagent",
      status: "started",
      tool: "spawn_agent",
      requestId: "inactive-request",
      workspace: "/tmp/inactive",
      count: 1
    }
  ];
  const spawnFailures: LookbackSpawnFailureRecord[] = [
    {
      timestamp: "2020-01-01T00:00:00.000Z",
      reason: "provider_exhausted",
      requestId: "root-old"
    },
    {
      timestamp: T_NOW,
      reason: "provider_exhausted",
      requestId: "inactive-request"
    }
  ];

  const view = aggregateLookbackView({
    recentEvents,
    liveFeed,
    otelLookbackEvents,
    subagentRecent: subagents,
    spawnFailureRecent: spawnFailures,
    activeAgents,
    now: NOW,
    selection: "active"
  });

  assert.ok(view);
  assert.equal(view.lookback.windowStartMs, null);
  assert.equal(view.usage.totals.attempts, 2);
  assert.equal(view.usage.totals.successes, 1);
  assert.equal(view.usage.totals.skipped, 1);
  assert.equal(view.usage.totals.toolCalls, 2);
  assert.deepEqual(Object.keys(view.usage.byWorkspace).sort(), [
    "/tmp/child",
    "/tmp/root",
    "unattributed"
  ]);
  assert.equal(view.codexTelemetry.tokens.input, 12);
  assert.equal(view.codexTelemetry.tokens.output, 3);
  assert.equal(view.codexTelemetry.tokens.total, 15);
  assert.deepEqual(view.codexTelemetry.skills.threads.keptTotal, {
    count: 2,
    sum: 8,
    average: 4
  });
  assert.equal(
    view.codexTelemetry.tools.byTool.find((tool) => tool.tool === "exec")
      ?.byStatus.skipped,
    2
  );
  assert.equal(view.codexTelemetry.threads.started.total, 4);
  assert.deepEqual(view.codexTelemetry.threads.started.bySource, { codex: 4 });
  assert.equal(view.codexTelemetry.threads.spawns.total, 2);
  assert.deepEqual(view.codexTelemetry.threads.spawns.byStatus, { started: 2 });
  assert.deepEqual(view.codexTelemetry.threads.spawns.byRole, {
    orchestrator: 2
  });
  assert.deepEqual(view.codexTelemetry.threads.spawns.byModel, { "gpt-5": 2 });
  assert.deepEqual(
    [
      ...new Set(view.codexTelemetry.lookbackEvents.map((event) => event.agent))
    ].sort(),
    ["child-thread", "root-thread"]
  );
  assert.deepEqual(
    view.liveFeed.map((event) => event.requestId),
    ["root-old", "root-current", undefined]
  );
  assert.equal(view.subagents.total, 1);
  assert.equal(view.spawnFailures.total, 1);
  assert.deepEqual(
    view.recentEvents.map((event) => event.requestId),
    ["root-old", "root-old", "child-old", "root-current"]
  );
});

test("Active Sessions is empty when no canonical live-agent identities are supplied", () => {
  const fixture = buildFixture();
  const view = aggregateLookbackView({
    recentEvents: fixture.recentEvents,
    liveFeed: fixture.liveFeed,
    otelLookbackEvents: fixture.otelLookbackEvents,
    subagentRecent: fixture.subagents,
    spawnFailureRecent: fixture.spawnFailures,
    activeAgents: [],
    now: NOW,
    selection: "active"
  });
  assert.ok(view);
  assert.equal(view.usage.totals.attempts, 0);
  assert.equal(view.codexTelemetry.tokens.total, 0);
  assert.equal(view.subagents.total, 0);
  assert.equal(view.spawnFailures.total, 0);
  assert.equal(view.recentEvents.length, 0);
  assert.equal(view.liveFeed.length, 0);
});

test("Active bridge-parent identities join OTel and spawn activity through the exact parent request thread", () => {
  const view = aggregateLookbackView({
    recentEvents: [
      routingEvent({
        timestamp: T_36H_AGO,
        requestId: "parent-request",
        thread: "parent-thread",
        phase: "selected",
        provider: "codex",
        model: "gpt-5",
        role: "orchestrator"
      })
    ],
    liveFeed: [
      liveFeedEvent({
        timestamp: T_36H_AGO,
        category: "tools",
        type: "tool_executed",
        requestId: "parent-request",
        tool: "exec",
        outcome: "success"
      })
    ],
    otelLookbackEvents: [
      otelLookbackEvent({
        timestamp: T_36H_AGO,
        family: "token",
        type: "delta",
        name: "input",
        agent: "parent-thread",
        countDelta: 7
      })
    ],
    subagentRecent: [
      {
        timestamp: T_36H_AGO,
        mechanism: "bridge_native",
        provider: "codex",
        role: "subagent",
        status: "started",
        tool: "spawn_agent",
        requestId: "parent-request",
        workspace: null,
        count: 1
      }
    ],
    activeAgents: [
      {
        subject: "bridge-parent:parent-request",
        requestId: "bridge-parent:parent-request"
      }
    ],
    now: NOW,
    selection: "active"
  });

  assert.ok(view);
  assert.equal(view.usage.totals.attempts, 1);
  assert.equal(view.liveFeed.length, 1);
  assert.equal(view.codexTelemetry.tokens.input, 7);
  assert.equal(view.subagents.total, 1);
});

test("applyIntervalLookback limits agent-state counts to the selected live agents", () => {
  const status = {
    agents: {
      byState: { active: 2, user_wait: 1, finished: 4, stale: 3 }
    },
    recentEvents: [],
    codexTelemetry: {
      receiver: { logs: 11, traces: 12, metrics: 13, invalid: 14 },
      lookbackEvents: [
        otelLookbackEvent({
          timestamp: T_NOW,
          family: "skill",
          type: "duration",
          name: "codex.thread.skills.kept_total",
          agent: "thread-a",
          countDelta: 1,
          sumDelta: 5
        }),
        otelLookbackEvent({
          timestamp: T_NOW,
          family: "skill",
          type: "duration",
          name: "codex.thread.skills.kept_total",
          agent: "inactive-thread",
          countDelta: 50,
          sumDelta: 500
        }),
        otelLookbackEvent({
          timestamp: T_NOW,
          family: "turn",
          type: "thread_started",
          name: "codex.thread.started",
          source: "codex",
          agent: "thread-a",
          countDelta: 2
        }),
        otelLookbackEvent({
          timestamp: T_NOW,
          family: "turn",
          type: "thread_started",
          name: "codex.thread.started",
          source: "codex",
          agent: "inactive-thread",
          countDelta: 100
        })
      ],
      threads: {
        started: { total: 999, bySource: { stale: 999 } },
        spawns: { total: 999, byStatus: {}, byRole: {}, byModel: {} }
      },
      skills: {
        threads: {
          keptTotal: { count: 999, sum: 999, average: 1 }
        }
      }
    },
    liveFeed: [
      liveFeedEvent({
        category: "telemetry",
        type: "otel.logs",
        timestamp: T_NOW,
        agent: "thread-a"
      })
    ]
  };
  const active = applyIntervalLookback(status, "active", NOW, [
    { subject: "thread-a", state: "active" },
    { subject: "thread-b", state: "user_wait" }
  ]);
  assert.deepEqual(active.agents.byState, {
    active: 1,
    user_wait: 1,
    finished: 0,
    stale: 0
  });
  assert.deepEqual(active.codexTelemetry.skills.threads.keptTotal, {
    count: 1,
    sum: 5,
    average: 5
  });
  assert.equal(active.codexTelemetry.threads.started.total, 2);
  assert.deepEqual(active.codexTelemetry.threads.started.bySource, {
    codex: 2
  });
  assert.deepEqual(active.codexTelemetry.receiver, {
    logs: 11,
    traces: 12,
    metrics: 13,
    invalid: 14
  });
  assert.equal(active.liveFeed.length, 1);
  assert.equal(Object.hasOwn(active.liveFeed[0]!, "agent"), false);
  assert.equal(lookbackWindowStartMs(NOW, "active"), null);
});
