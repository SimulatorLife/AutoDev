/**
 * The Runtime's measurement of whether the game is advancing.
 *
 * The reading is the Runtime's own: it compares what the player sees now with
 * what they saw before, and it has to be right about the difference between a
 * game that changed and a game that did not. A measurement that fires on an
 * animation truncates a healthy run; one that never fires leaves a frozen
 * game running until the budget ends it.
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  PLAYTESTS_VISUAL_LOADING_WARNING,
  PLAYTESTS_VISUAL_PROGRESS_VERSION,
  PLAYTESTS_VISUAL_STUCK_POLICY_VERSION,
  type PlaytestVisualControl,
  type PlaytestVisualObservation,
  playtestVisualProgressOutcome,
  playtestVisualProgressPolicy,
  playtestVisualProgressState,
  playtestVisualProgressStuck,
  type WorkspaceVisualPlaytestTargetApproval
} from "@simulatorlife/autodev-core";

const WORKSPACE_ID = "fixture/visual-progress";

function control(
  overrides: Partial<PlaytestVisualControl> = {}
): PlaytestVisualControl {
  return {
    controlId: "control-start",
    role: "button",
    name: "Start",
    enabled: true,
    focused: false,
    inputKind: "none",
    bounds: { x: 10, y: 10, width: 80, height: 24 },
    ...overrides
  };
}

function observation(
  overrides: Partial<PlaytestVisualObservation> = {}
): PlaytestVisualObservation {
  return {
    schema: "autodev-playtest-visual-observation-v1",
    observationId: "observation-1",
    workspaceId: WORKSPACE_ID,
    targetId: "racing-game-local",
    episodeId: "episode-1",
    origin: "http://127.0.0.1:5173",
    capturedAt: "2026-10-22T00:00:00.000Z",
    viewport: { width: 1280, height: 720, deviceScaleFactor: 1 },
    frame: {
      artifactId: "frame-1",
      sha256: "a".repeat(64),
      bytes: 128,
      mediaType: "image/png"
    },
    privacyState: "clear",
    controls: [control()],
    visibleWarnings: [],
    phaseEvidence: null,
    progressEvidence: null,
    ...overrides
  };
}

function target(
  overrides: Partial<WorkspaceVisualPlaytestTargetApproval> = {}
): WorkspaceVisualPlaytestTargetApproval {
  return {
    schema: "autodev-workspace-visual-playtest-target-v1",
    workspaceId: WORKSPACE_ID,
    targetId: "racing-game-local",
    revision: 1,
    approvalId: "visual-approval-progress-1",
    name: "Visual progress fixture",
    entryUrl: "http://127.0.0.1:5173/",
    allowedOrigins: ["http://127.0.0.1:5173"],
    inputCapabilities: ["keyboard", "pointer"],
    controlTimingClass: "turn-based",
    entryRequirements: "none",
    sandboxProfile: "transient-browser-profile",
    capturePolicy: "screenshots-only-redact-or-refuse",
    limits: {
      episodeCount: 1,
      maxStepsPerEpisode: 50,
      wallTimeMs: 120_000,
      smartRequestsPerEpisode: 30,
      smartTokensPerEpisode: 20_000,
      screenshotCountPerEpisode: 50,
      artifactBytesPerEpisode: 33_554_432
    },
    approvedAt: "2026-10-22T00:00:00.000Z",
    approvedBy: "operator-1",
    revokedAt: null,
    revokedBy: null,
    revocationReason: null,
    ...overrides
  };
}

test("the progress state reads what the player can see, not the frame", () => {
  const state = playtestVisualProgressState(
    observation({
      phaseEvidence: "Simulation Active",
      progressEvidence: "42%",
      controls: [
        control(),
        // A disabled control is not an affordance the player has.
        control({ controlId: "control-paused", name: "Pause", enabled: false })
      ]
    })
  );

  assert.equal(state.version, PLAYTESTS_VISUAL_PROGRESS_VERSION);
  assert.equal(state.phase, "Simulation Active");
  assert.equal(state.progress, "42%");
  assert.deepEqual(state.controls, ["control-start"]);
  assert.equal(state.loading, false);
});

test("a loading page is not a game that failed to advance", () => {
  const state = playtestVisualProgressState(
    observation({ visibleWarnings: [PLAYTESTS_VISUAL_LOADING_WARNING] })
  );

  assert.equal(state.loading, true);
  assert.equal(
    playtestVisualProgressOutcome(state, state),
    "loading",
    "a loading page is not judged while it loads"
  );
});

test("an animation is not progress, because the frame is not part of the state", () => {
  const firstObservation = observation({ phaseEvidence: "Simulation Active" });
  // The same screen with a different frame behind it: the game repainted,
  // and the player sees exactly what they saw before.
  const secondObservation = observation({
    observationId: "observation-2",
    phaseEvidence: "Simulation Active",
    frame: {
      artifactId: "frame-2",
      sha256: "b".repeat(64),
      bytes: 256,
      mediaType: "image/png"
    }
  });
  assert.notEqual(
    firstObservation.frame.artifactId,
    secondObservation.frame.artifactId,
    "the two observations did capture different frames"
  );

  assert.equal(
    playtestVisualProgressOutcome(
      playtestVisualProgressState(firstObservation),
      playtestVisualProgressState(secondObservation)
    ),
    "unchanged",
    "a repaint is not the game advancing"
  );
});

test("the versions are recorded apart, because they change for different reasons", () => {
  // The detector says what the game did; the stuck policy says what the
  // Runtime does about it. A new signal changes the first, a new response
  // changes the second, and a reader of the record has to be able to tell
  // which one moved.
  assert.equal(
    PLAYTESTS_VISUAL_PROGRESS_VERSION,
    "playtest-visual-progress-v1"
  );
  assert.equal(
    PLAYTESTS_VISUAL_STUCK_POLICY_VERSION,
    "playtest-visual-stuck-policy-v1"
  );
  assert.notEqual(
    PLAYTESTS_VISUAL_PROGRESS_VERSION,
    PLAYTESTS_VISUAL_STUCK_POLICY_VERSION
  );
});

test("the game advances when the screen, the progress or the controls change", () => {
  const before = playtestVisualProgressState(
    observation({
      phaseEvidence: "Main Menu",
      progressEvidence: "10%",
      controls: [control()]
    })
  );

  assert.equal(
    playtestVisualProgressOutcome(before, before),
    "unchanged",
    "the same screen twice is no advance"
  );
  assert.equal(
    playtestVisualProgressOutcome(
      before,
      playtestVisualProgressState(
        observation({
          phaseEvidence: "Simulation Active",
          progressEvidence: "10%",
          controls: [control()]
        })
      )
    ),
    "advanced",
    "a new screen is an advance"
  );
  assert.equal(
    playtestVisualProgressOutcome(
      before,
      playtestVisualProgressState(
        observation({
          phaseEvidence: "Main Menu",
          progressEvidence: "20%",
          controls: [control()]
        })
      )
    ),
    "advanced",
    "a new progress reading is an advance"
  );
  assert.equal(
    playtestVisualProgressOutcome(
      before,
      playtestVisualProgressState(
        observation({
          phaseEvidence: "Main Menu",
          progressEvidence: "10%",
          controls: [control(), control({ controlId: "control-pause" })]
        })
      )
    ),
    "advanced",
    "a new affordance is an advance"
  );
});

test("the first observation of an episode counts as an advance", () => {
  const first = playtestVisualProgressState(observation());

  assert.equal(playtestVisualProgressOutcome(null, first), "advanced");
});

test("the episode ends when the game has not advanced for as long as allowed", () => {
  const policy = { maxUnchangedDecisions: 3, maxUnchangedMs: 60_000 };

  assert.equal(
    playtestVisualProgressStuck({
      unchangedSteps: 2,
      unchangedMs: 59_000,
      policy
    }),
    false
  );
  assert.equal(
    playtestVisualProgressStuck({
      unchangedSteps: 3,
      unchangedMs: 1000,
      policy
    }),
    true,
    "the decision threshold ends the episode"
  );
  assert.equal(
    playtestVisualProgressStuck({
      unchangedSteps: 1,
      unchangedMs: 60_000,
      policy
    }),
    true,
    "the time threshold ends the episode"
  );
});

test("an approval that carries no thresholds is never cut short for not advancing", () => {
  // The Runtime measures the run either way, but it does not end a run for
  // not advancing unless the operator asked it to.
  assert.equal(playtestVisualProgressPolicy(target()), null);
  assert.equal(
    playtestVisualProgressStuck({
      unchangedSteps: 10_000,
      unchangedMs: 10_000_000,
      policy: null
    }),
    false,
    "an approval without thresholds never ends the episode"
  );
});

test("a configured policy is the operator's, as written", () => {
  const configured = playtestVisualProgressPolicy(
    target({
      progressPolicy: { maxUnchangedDecisions: 2, maxUnchangedMs: 5000 }
    })
  );
  assert.deepEqual(configured, {
    maxUnchangedDecisions: 2,
    maxUnchangedMs: 5000
  });

  // A threshold the episode can never reach is not rewritten: the episode's
  // own budgets still bound the run, and the operator's number is the number
  // the reader sees.
  const unreachable = playtestVisualProgressPolicy(
    target({
      limits: {
        ...target().limits,
        maxStepsPerEpisode: 3,
        wallTimeMs: 20_000
      },
      progressPolicy: { maxUnchangedDecisions: 50, maxUnchangedMs: 500_000 }
    })
  );
  assert.deepEqual(unreachable, {
    maxUnchangedDecisions: 50,
    maxUnchangedMs: 500_000
  });
  assert.equal(
    playtestVisualProgressStuck({
      unchangedSteps: 2,
      unchangedMs: 19_999,
      policy: unreachable
    }),
    false,
    "a threshold above the step cap never fires"
  );
  assert.equal(
    playtestVisualProgressStuck({
      unchangedSteps: 50,
      unchangedMs: 500_000,
      policy: unreachable
    }),
    true,
    "the operator's threshold is the one that fires"
  );
});
