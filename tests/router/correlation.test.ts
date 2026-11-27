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
The router's live correlation with the agents it serves.

The OTLP receiver that used to feed this module is gone: the agents export
their telemetry to OpenLIT, and the router keeps only what it observes
itself -- the skills the agents read. MCP server evidence comes from the
shared MCP gateway (`runtime/src/mcp/gateway-observations.ts`), not from here.
*/

function createMockUsageTracker(): UsageTracker {
  return new UsageTracker();
}

test("zeroed initial state", () => {
  const tracker = new CorrelationTracker({
    usageTracker: createMockUsageTracker()
  });
  const status = tracker.correlationStatus();

  assert.equal(status.skills.used.total, 0);
  assert.equal(status.bridgeEvents.skillExposed.total, 0);
  assert.equal(status.bridgeEvents.skillUsed.total, 0);
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

test("bridge skill events: exposure and use", () => {
  const usageTracker = createMockUsageTracker();
  const tracker = new CorrelationTracker({ usageTracker });

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
  assert.equal(status.bridgeEvents.skillExposed.total, 1);
  assert.equal(status.bridgeEvents.skillUsed.total, 1);

  const wsBucket = usageTracker.workspaceBucket(
    usageTracker.usageTelemetry.byWorkspace,
    "AutoDev/Platform"
  );
  assert.equal(wsBucket.skillsCapable, true);
  assert.equal(wsBucket.skillUses, 1);
});

test("bridge observation events: activitySubject is local active correlation, not an OTel dimension", () => {
  const usageTracker = createMockUsageTracker();
  const tracker = new CorrelationTracker({ usageTracker });

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

  tracker.recordBridgeSkillUsed({
    event: { skill: "diagnosing-bugs", eventId: "evt-persist-1" },
    context: { workspace: "AutoDev/Platform" }
  });

  const snapshot = tracker.correlationSnapshot();
  assert.equal(snapshot.schemaVersion, TELEMETRY_CORRELATION_SCHEMA_VERSION);
  assert.equal(snapshot.bridgeEvents.skillUsed.total, 1);

  // Restore into a fresh tracker
  const freshTracker = new CorrelationTracker({
    usageTracker: createMockUsageTracker()
  });
  freshTracker.restoreCorrelation(snapshot);

  const restoredStatus = freshTracker.correlationStatus();
  assert.equal(restoredStatus.bridgeEvents.skillUsed.total, 1);
  assert.equal(restoredStatus.skills.used.total, 1);
});

test("the restore accepts partial snapshots and ignores invalid top-level input", () => {
  const tracker = new CorrelationTracker({
    usageTracker: createMockUsageTracker()
  });

  tracker.restoreCorrelation({
    schemaVersion: TELEMETRY_CORRELATION_SCHEMA_VERSION,
    skills: { used: { total: 4 } }
  });

  const restoredStatus = tracker.correlationStatus();
  assert.equal(restoredStatus.skills.used.total, 4);

  assert.doesNotThrow(() =>
    tracker.restoreCorrelation({
      schemaVersion: TELEMETRY_CORRELATION_SCHEMA_VERSION,
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

  tracker.resetCorrelation();

  const status = tracker.correlationStatus();
  assert.equal(status.skills.used.total, 0);
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
