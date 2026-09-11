import assert from "node:assert/strict";
import test from "node:test";

import {
  createSpawnTracker,
  decideCloseOnDelegation,
  isCommandStep,
  isDelegationActive,
  isWaitStep,
  updateDelegationState,
} from "../scripts/codex-antigravity-cli-responses-proxy.mjs";

const spawnTools = new Set([ "invoke_subagent", "manage_subagents" ]);
const isSpawnTool = (name) => spawnTools.has(name);

const freshState = () => ({ activeTool: null, activeStep: null, activatedAt: 0, pendingChildren: 0 });

function recordingReporter() {
  const spawns = [];
  const results = [];
  return {
    spawns,
    results,
    isSpawnTool: (name) => name === "invoke_subagent",
    reportSpawns: async (event) => { spawns.push(event); },
    reportResults: async (event) => { results.push(event); },
  };
}

test("a non-spawn tool never marks the turn as delegating", () => {
  const state = freshState();
  const result = updateDelegationState(state, { step_index: 1, state: "ACTIVE", tool_name: "run_command" }, isSpawnTool);
  assert.deepEqual(result, { kind: "unchanged" });
  assert.equal(state.activeTool, null);
});

test("entering a delegator step records the tool and step index", () => {
  const state = freshState();
  const result = updateDelegationState(state, { step_index: 3, state: "ACTIVE", tool_name: "invoke_subagent" }, isSpawnTool);
  assert.equal(result.kind, "entered");
  assert.equal(result.tool, "invoke_subagent");
  assert.equal(state.activeTool, "invoke_subagent");
  assert.equal(state.activeStep, 3);
  assert.ok(state.activatedAt > 0);
});

test("a second delegator overwrites the first when the first has not closed", () => {
  // Defensive: agy normally runs one tool at a time, but the state machine
  // must cope with a step_index jump (the prior step's DONE may never arrive
  // because the upstream closed mid-flight).
  const state = freshState();
  updateDelegationState(state, { step_index: 3, state: "ACTIVE", tool_name: "invoke_subagent" }, isSpawnTool);
  const result = updateDelegationState(state, { step_index: 4, state: "ACTIVE", tool_name: "manage_subagents" }, isSpawnTool);
  assert.equal(result.kind, "entered");
  assert.equal(state.activeTool, "manage_subagents");
  assert.equal(state.activeStep, 4);
});

test("DONE on the same step_index clears the active tool", () => {
  const state = freshState();
  updateDelegationState(state, { step_index: 3, state: "ACTIVE", tool_name: "invoke_subagent" }, isSpawnTool);
  const result = updateDelegationState(state, { step_index: 3, state: "DONE", tool_name: "invoke_subagent" }, isSpawnTool);
  assert.equal(result.kind, "exited");
  assert.equal(result.tool, "invoke_subagent");
  assert.equal(state.activeTool, null);
});

test("a non-spawn tool event also clears the tracker for the same step", () => {
  // Once the delegator step's DONE arrives, the next event for the same step
  // is usually a non-spawn tool (agy sometimes emits a wrap-up event after
  // the spawn step). The close handler must not still see the delegator as
  // active by the time it fires.
  const state = freshState();
  updateDelegationState(state, { step_index: 3, state: "ACTIVE", tool_name: "invoke_subagent" }, isSpawnTool);
  const result = updateDelegationState(state, { step_index: 3, state: "DONE", tool_name: "agent_response" }, isSpawnTool);
  assert.equal(result.kind, "exited");
  assert.equal(state.activeTool, null);
});

test("ERROR / FAILED / CANCELLED on the active step also clears the tracker", () => {
  for (const terminal of [ "ERROR", "FAILED", "CANCELLED" ]) {
    const state = freshState();
    updateDelegationState(state, { step_index: 5, state: "ACTIVE", tool_name: "invoke_subagent" }, isSpawnTool);
    const result = updateDelegationState(state, { step_index: 5, state: terminal, tool_name: "invoke_subagent" }, isSpawnTool);
    assert.equal(result.kind, "exited", `terminal state ${terminal} must exit`);
    assert.equal(state.activeTool, null, `terminal state ${terminal} must clear`);
  }
});

test("DONE on a different step_index is treated as unchanged", () => {
  // A step_index mismatch usually means a stale event from an earlier turn
  // surfaced late; we must not clear the active tracker based on it.
  const state = freshState();
  updateDelegationState(state, { step_index: 7, state: "ACTIVE", tool_name: "invoke_subagent" }, isSpawnTool);
  const result = updateDelegationState(state, { step_index: 6, state: "DONE", tool_name: "invoke_subagent" }, isSpawnTool);
  assert.equal(result.kind, "unchanged");
  assert.equal(state.activeTool, "invoke_subagent");
});

test("a step_update without an index still tracks but cannot be paired by id", () => {
  // Some agy versions omit step_index on certain synthetic events. The
  // tracker tolerates this: it tracks state, but the close-handler cannot
  // later tell which step it belonged to. We accept that by clearing the
  // tracker when ANY non-spawn tool or terminal event arrives.
  const state = freshState();
  updateDelegationState(state, { state: "ACTIVE", tool_name: "invoke_subagent" }, isSpawnTool);
  assert.equal(state.activeTool, "invoke_subagent");
  const result = updateDelegationState(state, { state: "DONE", tool_name: "invoke_subagent" }, isSpawnTool);
  assert.equal(result.kind, "exited");
});

test("updateDelegationState tolerates a null state object", () => {
  const result = updateDelegationState(null, { step_index: 1, state: "ACTIVE", tool_name: "invoke_subagent" }, isSpawnTool);
  assert.deepEqual(result, { kind: "unchanged" });
});

test("updateDelegationState tolerates a missing isSpawnTool callback", () => {
  const state = freshState();
  // Without an isSpawnTool callback every tool is treated as non-spawn. The
  // call must not throw -- the bridge must keep working when the router did
  // not advertise a spawn-tools header (and isSpawnTool is therefore falsy).
  const result = updateDelegationState(state, { step_index: 1, state: "ACTIVE", tool_name: "invoke_subagent" }, undefined);
  assert.deepEqual(result, { kind: "unchanged" });
  assert.equal(state.activeTool, null);
});

test("decideCloseOnDelegation says do-not-kill when a delegator is active", () => {
  // The whole point of the new behavior: if the upstream closes while a
  // delegator step is ACTIVE, the bridge must NOT kill agy. Killing here
  // strands the children agy has already spawned and is waiting on, and
  // throws away any partial work they had produced.
  const state = { activeTool: "invoke_subagent", activeStep: 4, activatedAt: Date.now() };
  const decision = decideCloseOnDelegation(state);
  assert.equal(decision.kill, false);
  assert.equal(decision.reason, "client_disconnected");
  assert.equal(decision.tool, "invoke_subagent");
});

test("decideCloseOnDelegation says kill when no delegator is active", () => {
  // Pre-existing behavior is preserved for non-delegation closes: kill the
  // child, report the original interrupted reason. The new branch only
  // activates when a delegator step is the most recent ACTIVE state.
  const state = freshState();
  const decision = decideCloseOnDelegation(state);
  assert.equal(decision.kill, true);
  assert.equal(decision.reason, "provider_interrupted");
  assert.equal(decision.tool, null);
});

test("decideCloseOnDelegation tolerates a null state", () => {
  const decision = decideCloseOnDelegation(null);
  assert.equal(decision.kill, true);
  assert.equal(decision.reason, "provider_interrupted");
});

// --- Pending-children lifecycle: ACTIVE -> DONE closes the dispatch step,
// not the children invoke_subagent handed work off to. The bridge must not
// read that DONE as "delegation is over" while the spawn tracker still has
// children open.

test("isDelegationActive stays true after ACTIVE -> DONE while children are still pending", () => {
  const state = freshState();
  updateDelegationState(state, { step_index: 3, state: "ACTIVE", tool_name: "invoke_subagent" }, isSpawnTool);
  assert.equal(isDelegationActive(state), true, "an active dispatch step is delegation in flight");

  // The dispatch step closes -- agy handed the work off successfully -- but
  // the child it dispatched is still running, so pendingChildren stays > 0.
  // A caller (the request handler) is responsible for keeping this in sync
  // with the spawn tracker's openSpawnCount(); this test drives it directly.
  const transition = updateDelegationState(state, { step_index: 3, state: "DONE", tool_name: "invoke_subagent" }, isSpawnTool);
  state.pendingChildren = 1;
  assert.equal(transition.kind, "exited");
  assert.equal(state.activeTool, null, "the dispatch step itself is no longer active");
  assert.equal(isDelegationActive(state), true, "a pending child keeps delegation active even with no active step");

  // Once the child closes, both signals agree delegation is over.
  state.pendingChildren = 0;
  assert.equal(isDelegationActive(state), false);
});

test("decideCloseOnDelegation does not kill while pending children exist, even with no active step", () => {
  const state = { activeTool: null, activeStep: null, activatedAt: 0, pendingChildren: 2 };
  const decision = decideCloseOnDelegation(state);
  assert.equal(decision.kill, false, "children invoke_subagent dispatched must not be stranded by a kill");
  assert.equal(decision.reason, "client_disconnected");
  assert.equal(decision.tool, null, "no dispatch step is active, so there is no tool to name");
  assert.equal(decision.pendingChildren, 2);
});

test("decideCloseOnDelegation still kills an ordinary disconnected turn with nothing pending", () => {
  // No delegator ever ran, or every dispatched child has already closed:
  // an ordinary idle/disconnected turn must still be killed, not left to run
  // to PRINT_TIMEOUT for no reason.
  const state = { activeTool: null, activeStep: null, activatedAt: 0, pendingChildren: 0 };
  const decision = decideCloseOnDelegation(state);
  assert.equal(decision.kill, true);
  assert.equal(decision.reason, "provider_interrupted");
  assert.equal(decision.pendingChildren, 0);
});

test("the heartbeat's own gate (isDelegationActive) stays open across a dispatch DONE with open children", () => {
  // This mirrors the request handler's setInterval guard directly, so a
  // regression in that gate (reverting to `!delegation.activeTool`) is
  // caught without spinning up the HTTP server.
  const state = freshState();
  const heartbeatShouldTick = () => isDelegationActive(state);

  updateDelegationState(state, { step_index: 1, state: "ACTIVE", tool_name: "invoke_subagent" }, isSpawnTool);
  state.pendingChildren = 1;
  assert.equal(heartbeatShouldTick(), true, "ticks while the dispatch step is active");

  updateDelegationState(state, { step_index: 1, state: "DONE", tool_name: "invoke_subagent" }, isSpawnTool);
  assert.equal(heartbeatShouldTick(), true, "keeps ticking after DONE because a child is still pending");

  state.pendingChildren = 0;
  assert.equal(heartbeatShouldTick(), false, "stops once the last pending child has closed");
});

test("an end-to-end dispatch: spawn tracker + delegation state agree children outlive the DONE step", () => {
  // Wires createSpawnTracker's openSpawnCount() into a delegation object the
  // same way the request handler does, so this exercises the actual
  // integration rather than two isolated units that happen to agree.
  const reporter = recordingReporter();
  const tracker = createSpawnTracker(reporter);
  const state = freshState();

  const active = { step_index: 3, state: "ACTIVE", step_type: "tool", tool_name: "invoke_subagent", tool_info: { args: { Subagents: [ { TypeName: "explorer" } ] } } };
  tracker.observeSpawnStep(active);
  state.pendingChildren = tracker.openSpawnCount();
  updateDelegationState(state, active, isSpawnTool);
  assert.equal(decideCloseOnDelegation(state).kill, false);

  const done = { step_index: 3, state: "DONE", step_type: "tool", tool_name: "invoke_subagent" };
  tracker.observeSpawnStep(done);
  state.pendingChildren = tracker.openSpawnCount();
  const transition = updateDelegationState(state, done, isSpawnTool);
  assert.equal(transition.kind, "exited");
  assert.equal(state.activeTool, null);
  // The dispatch closed, but the child it started never got a matching close
  // event (agy emits none), so the tracker -- and therefore the delegation
  // state -- still consider it open.
  assert.equal(tracker.openSpawnCount(), 1);
  assert.equal(decideCloseOnDelegation(state).kill, false, "a disconnect here must not strand the open child");

  // The parent turn settles: every child still open closes with it, exactly
  // once, and delegation is then correctly inactive.
  tracker.flushSpawns("success");
  state.pendingChildren = tracker.openSpawnCount();
  assert.equal(tracker.openSpawnCount(), 0);
  assert.equal(reporter.results.length, 1, "the pending child's telemetry closes exactly once");
  assert.equal(decideCloseOnDelegation(state).kill, true, "nothing is pending any more, so an ordinary disconnect kills agy");

  // A second flush (e.g. a stray extra call on another exit path) must not
  // double-report the same child's close.
  tracker.flushSpawns("success");
  assert.equal(reporter.results.length, 1, "closing an already-closed spawn is a no-op");
});

test("delegation tracking still recognizes agy's own spawn tool when the router sent no reporter", () => {
  // No AgentEventReporter -- the router did not send telemetry headers, or
  // the caller is not the router -- must not silently disable pending-child
  // tracking (and therefore the kill decision). It must, however, still send
  // no telemetry anywhere, since nothing authorized a report.
  const tracker = createSpawnTracker(null);

  const active = { step_index: 1, state: "ACTIVE", step_type: "tool", tool_name: "invoke_subagent" };
  tracker.observeSpawnStep(active);
  assert.equal(tracker.openSpawnCount(), 1, "agy's own spawn tool is still recognized without a reporter");

  const done = { step_index: 1, state: "DONE", step_type: "tool", tool_name: "invoke_subagent" };
  tracker.observeSpawnStep(done);
  assert.equal(tracker.openSpawnCount(), 1, "DONE still does not close the child without a reporter");

  tracker.flushSpawns("success");
  assert.equal(tracker.openSpawnCount(), 0);

  // A tool that is not agy's spawn tool must still be ignored.
  const other = createSpawnTracker(null);
  other.observeSpawnStep({ step_index: 2, state: "ACTIVE", step_type: "tool", tool_name: "manage_subagents" });
  assert.equal(other.openSpawnCount(), 0);
});

test("isDelegationActive treats active commands as live", () => {
  const state = { activeTool: null, activeStep: null, activatedAt: 0, pendingChildren: 0, activeCommands: 1 };
  assert.equal(isDelegationActive(state), true);
  state.activeCommands = 0;
  state.activeCommand = "run_command";
  assert.equal(isDelegationActive(state), true);
  state.activeCommand = null;
  assert.equal(isDelegationActive(state), false);
});

test("isDelegationActive treats active waits as live", () => {
  const state = { activeTool: null, activeStep: null, activatedAt: 0, pendingChildren: 0, activeWaits: 1 };
  assert.equal(isDelegationActive(state), true);
  state.activeWaits = 0;
  state.activeWait = "ask_question";
  assert.equal(isDelegationActive(state), true);
  state.activeWait = null;
  assert.equal(isDelegationActive(state), false);
});

test("decideCloseOnDelegation does not kill while active commands or waits are running", () => {
  const cmdState = { activeTool: null, activeStep: null, activatedAt: 0, pendingChildren: 0, activeCommands: 1, activeWaits: 0 };
  const cmdDecision = decideCloseOnDelegation(cmdState);
  assert.equal(cmdDecision.kill, false);
  assert.equal(cmdDecision.reason, "client_disconnected");
  assert.equal(cmdDecision.activeCommands, 1);
  assert.equal(cmdDecision.activeWaits, 0);

  const waitState = { activeTool: null, activeStep: null, activatedAt: 0, pendingChildren: 0, activeCommands: 0, activeWaits: 1 };
  const waitDecision = decideCloseOnDelegation(waitState);
  assert.equal(waitDecision.kill, false);
  assert.equal(waitDecision.reason, "client_disconnected");
  assert.equal(waitDecision.activeCommands, 0);
  assert.equal(waitDecision.activeWaits, 1);
});

test("heartbeat gate stays open across tool execution while active commands or waits exist", () => {
  const state = freshState();
  state.activeCommands = 1;
  assert.equal(isDelegationActive(state), true);

  state.activeCommands = 0;
  assert.equal(isDelegationActive(state), false);

  state.activeWaits = 2;
  assert.equal(isDelegationActive(state), true);
  state.activeWaits = 0;
  assert.equal(isDelegationActive(state), false);
});

test("isCommandStep and isWaitStep classify execution steps accurately", () => {
  assert.equal(isCommandStep({ step_type: "command" }), true);
  assert.equal(isCommandStep({ tool_name: "run_command" }), true);
  assert.equal(isCommandStep({ tool_name: "bash" }), true);
  assert.equal(isCommandStep({ tool_name: "read_file" }), false);

  assert.equal(isWaitStep({ step_type: "wait" }), true);
  assert.equal(isWaitStep({ tool_name: "ask_question" }), true);
  assert.equal(isWaitStep({ tool_name: "schedule" }), true);
  assert.equal(isWaitStep({ tool_name: "run_command" }), false);
});
