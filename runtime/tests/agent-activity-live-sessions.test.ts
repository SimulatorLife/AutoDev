import assert from "node:assert/strict";
import test from "node:test";

import { CONTROL_API_LIVE_SESSION_IDENTITY_LIMIT } from "@simulatorlife/autodev-core";

import { createAgentActivityTracker } from "../src/agents/agent-activity.ts";
import { UsageTracker } from "../src/router/usage.ts";

test("live session projection distinguishes an observed empty tracker", () => {
  const tracker = createAgentActivityTracker({ now: () => 10 });
  assert.deepEqual(tracker.listLiveSessions(10), {
    identitiesObserved: [],
    identifiedSessionCount: 0,
    partial: false,
    unattributedLiveActivityCount: 0
  });
});

test("only explicit validated IDs identify live sessions; duplicate activity is grouped", () => {
  const tracker = createAgentActivityTracker({ now: () => 10 });
  tracker.beginRequest("request-subject-a", {
    requestId: "request-id-a",
    sessionId: "session-b",
    tag: "tag-is-not-an-identity",
    timestamp: 10
  });
  // An idempotent duplicate for the same request need not re-supply the ID;
  // it retains the identity already confirmed for this exact record.
  tracker.beginRequest("request-subject-a", {
    requestId: "request-id-a",
    timestamp: 15
  });
  tracker.beginRequest("bridge-subject-b", {
    kind: "bridge_subagent",
    requestId: "request-id-b",
    sessionId: "session-b",
    timestamp: 20
  });
  tracker.endRequest("bridge-subject-b", {
    requestId: "request-id-b",
    hasToolCalls: true,
    timestamp: 30
  });

  // A tag that looks like a session and a reserved process-fallback identity
  // do not identify an activity record.
  tracker.beginRequest("anonymous-subject", {
    requestId: "request-id-c",
    tag: "session-c",
    timestamp: 11
  });
  tracker.beginRequest("fallback-subject", {
    requestId: "request-id-d",
    sessionId: "process-scope",
    timestamp: 12
  });
  // Admission slots are bookkeeping, not session activity, and their tags are
  // never used as identities.
  tracker.beginRequest("slot-subject", {
    kind: "subagent_slot",
    tag: "session-slot",
    timestamp: 13
  });

  const projection = tracker.listLiveSessions(30);
  assert.deepEqual(projection, {
    identitiesObserved: [
      { sessionId: "session-b", state: "tool_wait", lastActivityAt: 30 }
    ],
    identifiedSessionCount: 1,
    partial: false,
    unattributedLiveActivityCount: 2
  });
  assert.equal(tracker.getRecord("request-subject-a")?.sessionId, "session-b");
  assert.equal(tracker.getRecord("anonymous-subject")?.sessionId, undefined);
});

test("a later request without a source session ID cannot inherit a prior ID", () => {
  const tracker = createAgentActivityTracker({ now: () => 10 });
  tracker.beginRequest("thread-subject", {
    requestId: "identified-request",
    sessionId: "source-session",
    timestamp: 10
  });
  tracker.endRequest("thread-subject", {
    requestId: "identified-request",
    hasToolCalls: true,
    timestamp: 11
  });
  tracker.beginRequest("thread-subject", {
    requestId: "thread-only-request",
    timestamp: 12
  });

  assert.equal(tracker.getRecord("thread-subject")?.sessionId, undefined);
  assert.deepEqual(tracker.listLiveSessions(12), {
    identitiesObserved: [],
    identifiedSessionCount: 0,
    partial: false,
    unattributedLiveActivityCount: 1
  });
});

test("terminal and stale records do not appear in the live-session projection", () => {
  let now = 10;
  const tracker = createAgentActivityTracker({ ttlMs: 5, now: () => now });
  tracker.beginRequest("finished-subject", {
    requestId: "finished-request",
    sessionId: "finished-session",
    timestamp: 10
  });
  tracker.finish("finished-subject", {
    requestId: "finished-request",
    timestamp: 11
  });
  tracker.beginRequest("stale-subject", {
    requestId: "stale-request",
    sessionId: "stale-session",
    timestamp: 10
  });
  tracker.endRequest("stale-subject", {
    requestId: "stale-request",
    hasToolCalls: true,
    timestamp: 11
  });

  now = 20;
  assert.deepEqual(tracker.listLiveSessions(now), {
    identitiesObserved: [],
    identifiedSessionCount: 0,
    partial: false,
    unattributedLiveActivityCount: 0
  });
  assert.equal(tracker.getState("stale-subject", now), "stale");
});

test("identified session output is deterministic, capped at 100, and reports truncation", () => {
  const tracker = createAgentActivityTracker({ now: () => 10 });
  for (let index = 104; index >= 0; index -= 1) {
    const sessionId = `session-${index.toString().padStart(3, "0")}`;
    tracker.beginRequest(`request-subject-${index}`, {
      sessionId,
      requestId: `request-id-${index}`,
      timestamp: 10 + index
    });
  }

  const projection = tracker.listLiveSessions(200);
  assert.equal(CONTROL_API_LIVE_SESSION_IDENTITY_LIMIT, 100);
  assert.equal(projection.identitiesObserved.length, 100);
  assert.equal(projection.identifiedSessionCount, 105);
  assert.equal(projection.partial, true);
  assert.equal(projection.unattributedLiveActivityCount, 0);
  assert.deepEqual(
    projection.identitiesObserved.map(({ sessionId }) => sessionId),
    Array.from(
      { length: 100 },
      (_, index) => `session-${index.toString().padStart(3, "0")}`
    )
  );
  assert.deepEqual(tracker.listLiveSessions(200), projection);
});

test("session IDs stay out of generic live-agent usage projections", () => {
  const tracker = createAgentActivityTracker({ now: () => 10 });
  tracker.beginRequest("request-subject", {
    requestId: "request-id",
    sessionId: "session-protected",
    provider: "provider-a",
    role: "worker",
    timestamp: 10
  });

  const projection = new UsageTracker({
    activityTracker: tracker
  }).projectLiveAgents(10);
  assert.equal(projection.byRole.worker, 1);
  assert.equal(
    Object.hasOwn(projection.directAgents[0] ?? {}, "sessionId"),
    false
  );
  assert.equal(
    Object.hasOwn(projection.allLiveAgents[0] ?? {}, "sessionId"),
    false
  );
  assert.equal(
    tracker.listLiveSessions(10).identitiesObserved[0]?.sessionId,
    "session-protected"
  );
});

test("lifecycle events cannot inject a session identity", () => {
  const tracker = createAgentActivityTracker({ now: () => 10 });
  tracker.applyLifecycleEvent("request-subject", {
    state: "user_wait",
    eventId: "event-1",
    // Simulate untrusted JSON containing a field the lifecycle contract omits.
    sessionId: "forged-session"
  } as never);

  assert.equal(tracker.getRecord("request-subject")?.sessionId, undefined);
  assert.deepEqual(tracker.listLiveSessions(10), {
    identitiesObserved: [],
    identifiedSessionCount: 0,
    partial: false,
    unattributedLiveActivityCount: 1
  });
});
