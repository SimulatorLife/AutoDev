/**
 * The Runtime notices a game that is not advancing.
 *
 * A run that spends its whole budget on a game that shows the player nothing
 * new is indistinguishable from a run that was making progress right up to
 * the end. The Runtime measures the difference: it compares what the player
 * sees now with what they saw before, and when the game has not advanced for
 * as long as the operator allowed, it ends the episode and says so.
 *
 * The thresholds are the operator's. The measurement is the Runtime's, and the
 * decision backend is told what it says, so a backend that can choose
 * differently is told that it should.
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  ACT_DECISION,
  runVisualEpisode,
  visibleStateOf
} from "./support/playtesting-visual-episode.ts";

/** The stop reason and the progress reading a recorded trace step carries. */
type TraceOutcome = {
  readonly stopReason: string;
  readonly progress: { readonly unchangedSteps: number };
};

test("an episode ends and says so when the game stops advancing", async () => {
  const run = await runVisualEpisode({
    // The game shows the player exactly the same screen every time.
    script: [null, null, null, null],
    phases: ["Simulation Active"],
    decisions: [ACT_DECISION],
    limits: {
      episodeCount: 1,
      maxStepsPerEpisode: 20,
      wallTimeMs: 60_000,
      smartRequestsPerEpisode: 20,
      smartTokensPerEpisode: 200_000,
      screenshotCountPerEpisode: 20,
      artifactBytesPerEpisode: 33_554_432
    },
    progressPolicy: { maxUnchangedDecisions: 3, maxUnchangedMs: 60_000 }
  });

  // The episode stopped on the guard, not on the step cap and not on the
  // usage budget, and it says which guard it was.
  assert.equal(run.episode.status, "budget-truncated");
  assert.deepEqual(run.episode.termination, { reason: "no-progress", step: 3 });
  assert.deepEqual(run.episode.missingReasons, ["budget-truncated"]);

  // The bound is the operator's threshold, not the step cap: the episode
  // stopped after three decisions that showed no advance, not after twenty.
  assert.equal(run.routerRequests.length, 3);
  assert.equal(run.driver.attempts.length, 3);

  // The step that showed the game where it was is in the trace, so the
  // operator's link to the stop step finds a step to look at.
  const stopStep = run.traceSteps.at(-1);
  assert.equal(stopStep?.step, 3);
  const outcome = stopStep?.authoritativeOutcome as TraceOutcome | undefined;
  assert.equal(outcome?.stopReason, "no-progress");
  assert.equal(outcome?.progress.unchangedSteps, 3);

  // The episode's own record counts the step it stopped on, and the frame the
  // player was looking at then is in the evidence.
  assert.equal(run.episode.stepCount, 4);
  assert.equal(run.episode.frames.length, 4);
});

test("an approval without thresholds is never cut short for not advancing", async () => {
  const run = await runVisualEpisode({
    // The game shows the player exactly the same screen every time, and the
    // approval sets no thresholds: the Runtime measures the run and reports
    // it, but it does not end the run on its own.
    script: [null, null, null, null],
    phases: ["Simulation Active"],
    decisions: [ACT_DECISION]
  });

  assert.equal(run.episode.termination.reason, "step-limit");
  assert.equal(run.routerRequests.length, 4);

  // The backend is told what the Runtime measured, and that no threshold is
  // in force.
  const second = visibleStateOf(run.routerRequests[1]!);
  assert.equal(second.progress.advanced, false);
  assert.equal(second.progress.maxUnchangedDecisions, null);
  assert.equal(second.progress.maxUnchangedMs, null);
});

test("the decision backend is told that the game is not advancing", async () => {
  const run = await runVisualEpisode({
    script: [null, null, null, null],
    phases: ["Simulation Active"],
    decisions: [ACT_DECISION],
    limits: {
      episodeCount: 1,
      maxStepsPerEpisode: 20,
      wallTimeMs: 60_000,
      smartRequestsPerEpisode: 20,
      smartTokensPerEpisode: 200_000,
      screenshotCountPerEpisode: 20,
      artifactBytesPerEpisode: 33_554_432
    },
    progressPolicy: { maxUnchangedDecisions: 3, maxUnchangedMs: 60_000 }
  });

  // The first decision sees a game that advanced: the episode has started.
  const first = visibleStateOf(run.routerRequests[0]!);
  assert.equal(first.progress.advanced, true);
  assert.equal(first.progress.unchangedSteps, 0);
  assert.equal(first.progress.maxUnchangedDecisions, 3);
  assert.equal(first.progress.maxUnchangedMs, 60_000);

  // The second one sees that nothing changed, and so does the third.
  const second = visibleStateOf(run.routerRequests[1]!);
  assert.equal(second.progress.advanced, false);
  assert.equal(second.progress.unchangedSteps, 1);
  const third = visibleStateOf(run.routerRequests[2]!);
  assert.equal(third.progress.advanced, false);
  assert.equal(third.progress.unchangedSteps, 2);
});

test("a page that is still loading does not spend the no-progress budget", async () => {
  const run = await runVisualEpisode({
    script: [null, null, null, null, null, null],
    // The screen never changes, but the page reports that it is still loading
    // from the second observation on.
    phases: ["Simulation Active"],
    loading: [false, true],
    decisions: [ACT_DECISION],
    limits: {
      episodeCount: 1,
      maxStepsPerEpisode: 6,
      wallTimeMs: 60_000,
      smartRequestsPerEpisode: 20,
      smartTokensPerEpisode: 200_000,
      screenshotCountPerEpisode: 20,
      artifactBytesPerEpisode: 33_554_432
    },
    progressPolicy: { maxUnchangedDecisions: 2, maxUnchangedMs: 60_000 }
  });

  // The game had not advanced, and the episode still ran to the step cap: a
  // game that is still loading has not had the chance to advance, and the
  // budget is not spent on it.
  assert.equal(run.episode.termination.reason, "step-limit");
  assert.equal(run.routerRequests.length, 6);

  // The backend is told the page is loading, so it does not read an unchanged
  // screen behind a load as a game that is refusing to respond.
  const second = visibleStateOf(run.routerRequests[1]!);
  assert.equal(second.progress.loading, true);
  assert.equal(second.progress.advanced, false);
  assert.equal(second.progress.unchangedSteps, 0);
  const third = visibleStateOf(run.routerRequests[2]!);
  assert.equal(third.progress.loading, true);
  assert.equal(third.progress.unchangedSteps, 0);
});

test("a game that advances is never called stuck", async () => {
  const run = await runVisualEpisode({
    script: [null, null, null, null],
    // The screen changes every observation, so the game is advancing.
    phases: ["Main Menu", "Race Briefing", "Simulation Active", "Results"],
    decisions: [ACT_DECISION],
    limits: {
      episodeCount: 1,
      maxStepsPerEpisode: 20,
      wallTimeMs: 60_000,
      smartRequestsPerEpisode: 40,
      smartTokensPerEpisode: 200_000,
      screenshotCountPerEpisode: 20,
      artifactBytesPerEpisode: 33_554_432
    },
    progressPolicy: { maxUnchangedDecisions: 2, maxUnchangedMs: 60_000 }
  });

  // The episode ran to the step cap instead of being cut short: the guard
  // only fires when the game really is where it was.
  assert.equal(run.episode.termination.reason, "step-limit");
  assert.equal(run.routerRequests.length, 20);
});
