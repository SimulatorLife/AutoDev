import assert from "node:assert/strict";
import test from "node:test";

import { createAgentActivityTracker } from "../src/agents/agent-activity.ts";
import { nativeHookObservation } from "../src/hooks/native-session.ts";
import { UsageTracker } from "../src/router/usage.ts";
import {
  nativeSessionIdentity,
  nativeSessionObservationSchema
} from "../src/shared/native-session-observation.ts";

const input = JSON.stringify({
  session_id: "session-123",
  cwd: "/private/project",
  model: "fixture-model",
  agent_type: "worker",
  prompt: "must not be retained"
});

test("native lifecycle hook projects only bounded observation fields and excludes managed sessions", () => {
  const claude = nativeHookObservation(input, "start", { CLAUDECODE: "1" }, []);
  assert.deepEqual(claude, {
    client: "claude_code",
    sessionId: "session-123",
    event: "start",
    model: "fixture-model",
    workspace: "project"
  });
  assert.equal(nativeSessionIdentity(claude!), "native:claude_code:session-123");
  assert.equal(nativeHookObservation(input, "start", {}, []), null);
  assert.equal(nativeHookObservation(input, "start", {
    CLAUDECODE: "1", AUTODEV_SESSION_ID: "managed-session",
    AUTODEV_AGENT_ROLE: "worker"
  }, []), null);
  assert.equal(nativeHookObservation(input, "start", {
    CLAUDECODE: "1", AUTODEV_SESSION_ID: "managed-session"
  }, []), null);
  const minimax = nativeHookObservation(input, "start", {}, ["--client=mcode"]);
  assert.equal(minimax?.client, "minimax_code");
  assert.equal(nativeSessionObservationSchema.safeParse({
    ...claude, role: "orchestrator"
  }).success, false);
  assert.equal(nativeSessionObservationSchema.safeParse({
    ...claude, sessionId: "../private"
  }).success, false);
});

test("standalone sessions share the live projection without becoming managed requests", () => {
  let now = 100;
  const tracker = createAgentActivityTracker({ now: () => now, ttlMs: 50 });
  const usage = new UsageTracker({ activityTracker: tracker });
  const claude = nativeHookObservation(input, "start", { CLAUDECODE: "1" }, [])!;
  const minimax = nativeHookObservation(input, "start", {}, ["--client=mcode"])!;
  tracker.observeNativeSession(claude);
  tracker.observeNativeSession(minimax);
  assert.deepEqual(usage.listLiveSessions(now)?.identitiesObserved.map((row) => [
    row.clientSurface, row.state, row.provider, row.role
  ]), [
    ["claude_code", "user_wait", null, null],
    ["minimax_code", "user_wait", null, null]
  ]);
  now += 1;
  tracker.observeNativeSession({ ...claude, event: "prompt", model: null });
  const id = nativeSessionIdentity(claude)!;
  assert.equal(tracker.getRecord(id)?.model, "fixture-model");
  assert.equal(tracker.getState(id), "active");
  tracker.observeNativeSession({ ...claude, event: "stop" });
  assert.equal(tracker.getState(id), "user_wait");
  tracker.observeNativeSession({ ...claude, event: "end" });
  assert.equal(tracker.getState(id), "finished");
  tracker.observeNativeSession({ ...claude, event: "stop" });
  assert.equal(tracker.getState(id), "finished");
  assert.equal(usage.listLiveSessions(now)?.identifiedSessionCount, 1);
  now += 100;
  assert.equal(usage.listLiveSessions(now)?.identifiedSessionCount, 0);
  tracker.observeNativeSession({ ...claude, event: "start" });
  assert.equal(usage.listLiveSessions(now)?.identifiedSessionCount, 1);
});
