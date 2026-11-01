import assert from "node:assert/strict";
import test from "node:test";

import {
  correlationSnapshot,
  correlationStatus,
  CorrelationTracker,
  getDefaultCorrelationTracker,
  setDefaultCorrelationTracker,
  TELEMETRY_CORRELATION_SCHEMA_VERSION
} from "@simulatorlife/autodev-runtime/router/correlation";
import { UsageTracker } from "@simulatorlife/autodev-runtime/router/usage";

/**
 * The router's live correlation with the agents it serves.
 *
 * The OTLP receiver that used to feed this module is gone: the agents export
 * their telemetry to OpenLIT, and the router keeps only what it observes
 * itself -- the calls the bridges report, the servers they called, and the
 * skills they used.
 */

function createMockUsageTracker(): UsageTracker {
  return new UsageTracker();
}

test("zeroed initial state", () => {
  const tracker = new CorrelationTracker({
    usageTracker: createMockUsageTracker()
  });
  const status = tracker.correlationStatus();

  assert.equal(status.mcpServers.length, 0);
  assert.equal(status.mcpSummary.observed, 0);
  assert.equal(status.skills.used.total, 0);
  assert.equal(status.bridgeEvents.toolExecuted.total, 0);
  assert.equal(status.bridgeEvents.toolRequested.total, 0);
  assert.equal(status.bridgeEvents.toolUnavailable.total, 0);
  assert.equal(status.bridgeEvents.skillExposed.total, 0);
  assert.equal(status.bridgeEvents.skillUsed.total, 0);
  assert.equal(status.bridgeEvents.mcpExposed.total, 0);
});

test("request-context correlation preserves exact source request IDs and alias priority", () => {
  const observedRequestIds: string[] = [];
  const tracker = new CorrelationTracker({
    usageTracker: createMockUsageTracker(),
    getBridgeRequestContext: (requestId) => {
      observedRequestIds.push(requestId);
      return null;
    }
  });

  tracker.resolveCorrelationContext({ requestId: " request-native " });
  tracker.resolveCorrelationContext({
    requestId: "  ",
    request_id: "fallback"
  });
  tracker.resolveCorrelationContext({ requestId: "", request_id: "fallback" });

  assert.deepEqual(observedRequestIds, [" request-native ", "  ", "fallback"]);
});

test("bridge observation events: tool, skill, and mcp exposure", () => {
  const usageTracker = createMockUsageTracker();
  const tracker = new CorrelationTracker({ usageTracker });

  tracker.recordBridgeToolObservation({
    event: {
      type: "tool_executed",
      tool: "view_file",
      server: "file-tools",
      status: "ok",
      callId: "c-1"
    },
    context: { workspace: "AutoDev/Platform" }
  });
  tracker.recordBridgeToolObservation({
    event: {
      type: "tool_unavailable",
      tool: "write_file",
      server: "file-tools",
      reason: "policy_denied"
    },
    context: { workspace: "AutoDev/Platform" }
  });

  tracker.recordMcpExposure({
    server: "playwright",
    source: "role_contract",
    context: { workspace: "AutoDev/Platform" },
    requestId: "req-1"
  });

  tracker.recordBridgeSkillExposure({
    event: { skill: "diagnosing-bugs", source: "builtin", pluginId: "core" },
    context: { workspace: "AutoDev/Platform" }
  });

  const skillUsedResult = tracker.recordBridgeSkillUsed({
    event: { skill: "diagnosing-bugs", eventId: "evt-skill-1" },
    context: { workspace: "AutoDev/Platform" }
  });
  assert.equal(skillUsedResult, true);

  const status = tracker.correlationStatus();
  assert.equal(status.bridgeEvents.toolExecuted.total, 1);
  assert.deepEqual(status.bridgeEvents.toolExecuted.byReason, {});
  assert.deepEqual(status.bridgeEvents.toolRequested.byReason, {});
  assert.equal(status.bridgeEvents.toolUnavailable.total, 1);
  assert.equal(status.bridgeEvents.toolUnavailable.byReason.policy_denied, 1);
  assert.equal(status.bridgeEvents.mcpExposed.total, 1);
  assert.equal(status.bridgeEvents.skillExposed.total, 1);
  assert.equal(status.bridgeEvents.skillUsed.total, 1);

  const wsBucket = usageTracker.workspaceBucket(
    usageTracker.usageTelemetry.byWorkspace,
    "AutoDev/Platform"
  );
  assert.equal(wsBucket.toolsExecuted, 1);
  assert.equal(wsBucket.toolsUnavailable, 1);
  assert.equal(wsBucket.mcpCapable, true);
  assert.equal(wsBucket.skillsCapable, true);
  assert.equal(wsBucket.skillUses, 1);
});

test("a call against a server is the evidence the server's health is read from", () => {
  const tracker = new CorrelationTracker({
    usageTracker: createMockUsageTracker()
  });

  tracker.recordBridgeToolObservation({
    event: {
      type: "tool_executed",
      tool: "view_file",
      server: "file-tools",
      status: "ok",
      callId: "c-1",
      durationMs: 40
    },
    context: { workspace: "AutoDev/Platform", role: "orchestrator" }
  });

  const server = tracker
    .correlationStatus()
    .mcpServers.find((entry) => entry.name === "file-tools");
  assert.ok(server, "the observed server is published");
  assert.equal(server.lastStatus, "ready");
  assert.equal(server.health, "ready");
  assert.equal(server.failures, 0);
  assert.equal(server.averageDurationMs, 40);
  assert.ok(server.lastSeenAt, "an observed server carries a last-seen time");
  // The role that made the call saw the server answer, so its own bucket
  // carries the same verdict.
  assert.equal(server.byRole.orchestrator?.lastStatus, "ready");
  assert.equal(server.byRole.orchestrator?.health, "ready");
});

test("a call that failed is a failure of the server, and a refusal is not", () => {
  const tracker = new CorrelationTracker({
    usageTracker: createMockUsageTracker()
  });

  tracker.recordBridgeToolObservation({
    event: {
      type: "tool_executed",
      tool: "view_file",
      server: "file-tools",
      status: "error",
      callId: "c-1"
    },
    context: { workspace: "AutoDev/Platform" }
  });
  tracker.recordBridgeToolObservation({
    event: {
      type: "tool_unavailable",
      tool: "write_file",
      server: "other-tools",
      reason: "policy_denied"
    },
    context: { workspace: "AutoDev/Platform" }
  });

  const status = tracker.correlationStatus();
  const failed = status.mcpServers.find((entry) => entry.name === "file-tools");
  assert.ok(failed);
  assert.equal(failed.lastStatus, "error");
  assert.equal(failed.failures, 1);

  // The refusal was the router's own: the server was never exercised, so it
  // carries no verdict of its own.
  const refused = status.mcpServers.find(
    (entry) => entry.name === "other-tools"
  );
  assert.ok(refused);
  assert.equal(refused.failures, 0);
  assert.notEqual(refused.lastStatus, "error");
});

test("bridge observation events: activitySubject is local active correlation, not an OTel dimension", () => {
  const usageTracker = createMockUsageTracker();
  const tracker = new CorrelationTracker({ usageTracker });

  tracker.recordBridgeToolObservation({
    event: {
      type: "tool_executed",
      tool: "view_file",
      server: "file-tools",
      status: "ok",
      callId: "c-activity-1"
    },
    context: { workspace: "AutoDev/Platform", activitySubject: "child-42" }
  });

  const skillUsedResult = tracker.recordBridgeSkillUsed({
    event: { skill: "racecar-movement", eventId: "evt-skill-activity-1" },
    context: { workspace: "AutoDev/Platform", activitySubject: "child-42" }
  });
  assert.equal(skillUsedResult, true);

  const status = tracker.correlationStatus() as any;

  // The exact activitySubject belongs to local active correlation; it must
  // not be promoted into the cumulative OTel agent dimension.
  const skillBucket = status.skills.used.bySkill.find(
    (entry: any) => entry.skill === "racecar-movement"
  );
  assert.ok(skillBucket, "expected racecar-movement skill-used bucket");
  assert.equal(skillBucket.byAgent["child-42"], undefined);
  assert.equal(skillBucket.byAgent.unattributed, 1);
  assert.equal(status.skills.used.byAgent["child-42"], undefined);
  assert.equal(status.skills.used.byAgent.unattributed, 1);

  // The MCP cumulative agent dimension likewise stays unattributed; the
  // bridge's separate live-feed event carries the exact activity subject.
  const mcpServer = status.mcpServers.find(
    (entry: any) => entry.name === "file-tools"
  );
  assert.ok(mcpServer, "expected file-tools mcp server entry");
  assert.equal(mcpServer.byAgent["child-42"], undefined);
  assert.equal(mcpServer.byAgent.unattributed.observed, 1);

  const activeUsage = usageTracker.activeUsageSnapshot(["child-42"]);
  assert.equal(activeUsage.skillUses, 1);
  assert.deepEqual(activeUsage.bySkill, [
    { skill: "racecar-movement", count: 1 }
  ]);
  const activeWorkspace = activeUsage.byWorkspace["AutoDev/Platform"];
  assert.ok(activeWorkspace);
  assert.equal(activeWorkspace.skillUses, 1);
  assert.deepEqual(activeWorkspace.bySkill, [
    { skill: "racecar-movement", count: 1 }
  ]);
});

test("persistence snapshot and restoration", () => {
  const usageTracker = createMockUsageTracker();
  const tracker = new CorrelationTracker({ usageTracker });

  tracker.recordBridgeToolObservation({
    event: {
      type: "tool_executed",
      tool: "view_file",
      server: "file-tools",
      status: "ok",
      callId: "c-1"
    },
    context: { workspace: "AutoDev/Platform" }
  });

  const snapshot = tracker.correlationSnapshot();
  assert.equal(snapshot.schemaVersion, TELEMETRY_CORRELATION_SCHEMA_VERSION);
  assert.equal(snapshot.bridgeEvents.toolExecuted.total, 1);

  // Restore into a fresh tracker
  const freshTracker = new CorrelationTracker({
    usageTracker: createMockUsageTracker()
  });
  freshTracker.restoreCorrelation(snapshot);

  const restoredStatus = freshTracker.correlationStatus();
  assert.equal(restoredStatus.bridgeEvents.toolExecuted.total, 1);
  assert.equal(restoredStatus.mcpServers.length, 1);
  assert.equal(restoredStatus.mcpServers[0]?.name, "file-tools");
});

test("the restore accepts partial snapshots and ignores invalid top-level input", () => {
  const tracker = new CorrelationTracker({
    usageTracker: createMockUsageTracker()
  });

  tracker.restoreCorrelation({
    schemaVersion: TELEMETRY_CORRELATION_SCHEMA_VERSION,
    mcpServers: [{ name: "partial-server", lastStatus: "ready" }],
    skills: { used: { total: 4 } }
  });

  const restoredStatus = tracker.correlationStatus();
  assert.equal(restoredStatus.skills.used.total, 4);
  assert.equal(restoredStatus.mcpServers.length, 1);
  assert.equal(restoredStatus.mcpServers[0]?.name, "partial-server");

  assert.doesNotThrow(() =>
    tracker.restoreCorrelation({
      schemaVersion: TELEMETRY_CORRELATION_SCHEMA_VERSION,
      mcpServers: [null, { name: 3 }],
      skills: { used: { bySkill: [null, { skill: 1 }] } }
    })
  );

  tracker.restoreCorrelation({ skills: { used: { total: 99 } } });
  tracker.restoreCorrelation({
    schemaVersion: 1,
    skills: { used: { total: 99 } }
  });
  tracker.restoreCorrelation(null);
  assert.equal(tracker.correlationStatus().skills.used.total, 4);
});

test("resetCorrelation clears the correlation and triggers usageTracker reset", () => {
  const usageTracker = createMockUsageTracker();
  const tracker = new CorrelationTracker({ usageTracker });
  tracker.recordSkillUse(
    "orchestration",
    {
      workspace: "AutoDev/Core",
      role: "orchestrator",
      model: "gpt-6-luna",
      agent: "agent-1",
      agentKind: "orchestrator",
      timestamp: "2026-09-27T17:00:00.000Z",
      timestampSource: "source"
    },
    1,
    "2026-09-27T17:00:00.000Z"
  );

  tracker.recordBridgeToolObservation({
    event: {
      type: "tool_executed",
      tool: "view_file",
      server: "file-tools",
      status: "ok",
      callId: "c-1"
    },
    context: { workspace: "AutoDev/Core" }
  });

  tracker.resetCorrelation();

  const status = tracker.correlationStatus();
  assert.equal(status.skills.used.total, 0);
  assert.equal(status.mcpServers.length, 0);
  assert.equal(status.bridgeEvents.toolExecuted.total, 0);
  assert.equal(usageTracker.attributionDiagnostics.total, 0);
});

test("default singleton convenience functions delegate properly", () => {
  const original = getDefaultCorrelationTracker();
  const custom = new CorrelationTracker();
  setDefaultCorrelationTracker(custom);

  try {
    assert.equal(getDefaultCorrelationTracker(), custom);
    assert.equal(typeof correlationStatus(), "object");
    assert.equal(typeof correlationSnapshot(), "object");
  } finally {
    setDefaultCorrelationTracker(original);
  }
});
