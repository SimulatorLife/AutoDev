/**
 * A refused action that says the page moved is recovered from.
 *
 * The Runtime's driver refuses an action the page no longer offers as the
 * observation promised. That refusal says the thing the policy looked at is
 * not what the page offers now, and the answer to that is to look again: the
 * episode observes the game once more and decides with the refusal in its
 * history, bounded by the budgets the operator approved.
 *
 * A refusal that says anything else -- the action was not allowed, the game
 * needs setup, the episode is out of budget -- is final, and the episode ends
 * on it with the truthful reason rather than with "crashed for no reason".
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  ACT_DECISION,
  runVisualEpisode,
  STOP_DECISION,
  visibleStateOf
} from "./support/playtesting-visual-episode.ts";

test("an episode recovers from a control the page moved", async () => {
  const run = await runVisualEpisode({
    // The first action names a control the page no longer offers; the second
    // reaches the game; the third decision stops the episode. The approval
    // carries no no-progress thresholds, so the guard never ends the episode
    // on its own: the run ends where the decisions end it.
    script: ["control-changed", null, null],
    phases: ["Main Menu", "Simulation Active", "Simulation Active"],
    decisions: [ACT_DECISION, ACT_DECISION, STOP_DECISION]
  });

  // The episode looked again after the refusal instead of ending on it.
  assert.equal(run.driver.attempts.length, 2);
  assert.equal(run.driver.observations, 3);
  assert.equal(run.routerRequests.length, 3);
  assert.equal(run.episode.status, "completed");
  assert.deepEqual(run.episode.termination, { reason: "unknown", step: 2 });

  // The refusal is in the history the next decision read, with what it did.
  const secondRequest = visibleStateOf(run.routerRequests[1]!);
  assert.equal(secondRequest.recentHistory.length, 1);
  assert.equal(
    secondRequest.recentHistory[0]?.outcome,
    "refused: control-changed",
    "the decision backend must see that the refused action never reached the game"
  );
  const thirdRequest = visibleStateOf(run.routerRequests[2]!);
  assert.deepEqual(
    thirdRequest.recentHistory.map((entry) => entry.outcome),
    ["refused: control-changed", "dispatched"]
  );

  // The refusal is in the trace the operator reads, not only in the history.
  const refusedOutcome = run.traceSteps[0]?.authoritativeOutcome as {
    readonly status: string;
    readonly refusalReason: string | null;
    readonly dispatchedAt: string | null;
  };
  assert.equal(run.traceSteps[0]?.selectedActionId, "control-start");
  assert.equal(refusedOutcome.status, "refused");
  assert.equal(refusedOutcome.refusalReason, "control-changed");
  assert.equal(
    refusedOutcome.dispatchedAt,
    null,
    "a refused action never reached the game"
  );
  const dispatchedOutcome = run.traceSteps[1]?.authoritativeOutcome as {
    readonly status: string;
    readonly refusalReason: string | null;
  };
  assert.equal(dispatchedOutcome.status, "dispatched");
  assert.equal(dispatchedOutcome.refusalReason, null);
});

test("a refusal that is final ends the episode with the truthful reason", async () => {
  const run = await runVisualEpisode({
    // The game needs setup before it can be played. Reading the page again
    // does not change that, so the episode ends on the refusal.
    script: ["auth-or-setup-required"],
    phases: ["Main Menu"],
    decisions: [ACT_DECISION]
  });

  assert.equal(run.driver.attempts.length, 1);
  assert.equal(run.driver.observations, 1);
  assert.equal(run.routerRequests.length, 1);
  assert.equal(run.episode.status, "crashed");
  assert.deepEqual(
    run.episode.termination,
    { reason: "action-refused", step: 0 },
    "the episode ended on a refusal, and the recorded reason must say so"
  );
  assert.deepEqual(run.episode.missingReasons, ["unobserved"]);
  assert.equal(run.traceSteps.length, 1);
  assert.equal(
    (
      run.traceSteps[0]?.authoritativeOutcome as {
        readonly refusalReason: string;
      }
    ).refusalReason,
    "auth-or-setup-required"
  );
});
