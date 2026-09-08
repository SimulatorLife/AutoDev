import assert from "node:assert/strict";
import test from "node:test";

import {
  decideCloseOnDelegation,
  updateDelegationState,
} from "../scripts/codex-antigravity-cli-responses-proxy.mjs";

const spawnTools = new Set([ "invoke_subagent", "manage_subagents" ]);
const isSpawnTool = (name) => spawnTools.has(name);

const freshState = () => ({ activeTool: null, activeStep: null, activatedAt: 0 });

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
