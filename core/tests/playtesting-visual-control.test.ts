import assert from "node:assert/strict";
import test from "node:test";

import {
  admitPlaytestVisualAction,
  assertPlaytestVisualAction,
  assertPlaytestVisualObservation,
  PLAYTEST_VISUAL_ACTION_SCHEMA,
  PLAYTEST_VISUAL_OBSERVATION_SCHEMA,
  playtestActionRefusalMeansPageMoved,
  type PlaytestVisualAction,
  type PlaytestVisualActionRefusalReason,
  type PlaytestVisualObservation,
  type WorkspaceVisualPlaytestTargetApproval
} from "@simulatorlife/autodev-core";

const WORKSPACE = "fixture/game";
const TARGET_ID = "browser-game";
const EPISODE_ID = "episode-visual-1";
const OBSERVATION_ID = "observation-1";
const ORIGIN = "http://localhost:5173";
const CAPTURED_AT = "2026-10-16T12:00:00.000Z";
const FRAME_ID = "frame-1";
const VIEWPORT = {
  width: 1024,
  height: 768,
  deviceScaleFactor: 1
} as const;

const target: WorkspaceVisualPlaytestTargetApproval = {
  schema: "autodev-workspace-visual-playtest-target-v1",
  workspaceId: WORKSPACE,
  targetId: TARGET_ID,
  revision: 1,
  approvalId: "visual-approval-1",
  name: "Fixture browser game",
  entryUrl: ORIGIN + "/",
  allowedOrigins: [ORIGIN],
  inputCapabilities: ["keyboard", "pointer", "gamepad"],
  controlTimingClass: "turn-based",
  entryRequirements: "none",
  sandboxProfile: "transient-browser-profile",
  capturePolicy: "screenshots-only-redact-or-refuse",
  limits: {
    episodeCount: 1,
    maxStepsPerEpisode: 20,
    wallTimeMs: 60_000,
    smartRequestsPerEpisode: 5,
    smartTokensPerEpisode: 5000,
    screenshotCountPerEpisode: 20,
    artifactBytesPerEpisode: 1024 * 1024
  },
  approvedAt: CAPTURED_AT,
  approvedBy: "operator-1",
  revokedAt: null,
  revokedBy: null,
  revocationReason: null
};

function observation(
  overrides: Partial<PlaytestVisualObservation> = {}
): PlaytestVisualObservation {
  return {
    schema: PLAYTEST_VISUAL_OBSERVATION_SCHEMA,
    observationId: OBSERVATION_ID,
    workspaceId: WORKSPACE,
    targetId: TARGET_ID,
    episodeId: EPISODE_ID,
    origin: ORIGIN,
    capturedAt: CAPTURED_AT,
    viewport: VIEWPORT,
    frame: {
      artifactId: FRAME_ID,
      sha256: "a".repeat(64),
      bytes: 1024,
      mediaType: "image/png"
    },
    privacyState: "clear",
    controls: [
      {
        controlId: "start-button",
        role: "button",
        name: "Start race",
        enabled: true,
        focused: false,
        inputKind: "none",
        bounds: { x: 10, y: 10, width: 140, height: 48 }
      },
      {
        controlId: "player-name",
        role: "textbox",
        name: "Player name",
        enabled: true,
        focused: false,
        inputKind: "text-entry",
        bounds: { x: 180, y: 10, width: 180, height: 48 }
      }
    ],
    visibleWarnings: [],
    phaseEvidence: "main menu",
    progressEvidence: null,
    ...overrides
  };
}

function action(
  overrides: Readonly<Record<string, unknown>> = {}
): PlaytestVisualAction {
  const base = {
    schema: PLAYTEST_VISUAL_ACTION_SCHEMA,
    workspaceId: WORKSPACE,
    targetId: TARGET_ID,
    episodeId: EPISODE_ID,
    observationId: OBSERVATION_ID,
    ...overrides
  };
  return ("kind" in overrides
    ? base
    : {
        ...base,
        kind: "activate-control",
        controlId: overrides.controlId ?? "start-button"
      }) as unknown as PlaytestVisualAction;
}

function admission(
  overrides: Partial<Parameters<typeof admitPlaytestVisualAction>[0]> = {}
): ReturnType<typeof admitPlaytestVisualAction> {
  return admitPlaytestVisualAction({
    target,
    observation: observation(),
    action: action(),
    runtimeSupportedInputs: ["keyboard", "pointer"],
    currentOrigin: ORIGIN,
    currentViewport: VIEWPORT,
    nowMs: Date.parse(CAPTURED_AT) + 250,
    maxObservationAgeMs: 1000,
    ...overrides
  });
}

test("visual observations admit only bounded sanitized player-visible data", () => {
  assert.doesNotThrow(() =>
    assertPlaytestVisualObservation(observation(), target)
  );
  assert.throws(
    () =>
      assertPlaytestVisualObservation(
        observation({ origin: "http://localhost:5174" }),
        target
      ),
    /Visual observation fields are invalid/u
  );
  assert.throws(
    () =>
      assertPlaytestVisualObservation(
        observation({
          controls: [...observation().controls, observation().controls[0]!]
        }),
        target
      ),
    /duplicate control IDs/u
  );
});

test("fresh semantic actions are admitted only against the exact live session", () => {
  assert.deepEqual(admission(), { admitted: true });
  assert.deepEqual(
    admission({
      action: action({ observationId: "observation-from-another-step" })
    }),
    { admitted: false, reason: "stale-observation" }
  );
  assert.deepEqual(
    admission({ action: action({ episodeId: "episode-from-another-run" }) }),
    { admitted: false, reason: "session-mismatch" }
  );
});

test("admission rejects stale captures, origin changes, and viewport changes", () => {
  assert.deepEqual(admission({ nowMs: Date.parse(CAPTURED_AT) + 1001 }), {
    admitted: false,
    reason: "stale-observation"
  });
  assert.deepEqual(admission({ currentOrigin: "http://localhost:5174" }), {
    admitted: false,
    reason: "origin-not-approved"
  });
  assert.deepEqual(
    admission({
      target: {
        ...target,
        allowedOrigins: [ORIGIN, "https://another.example"]
      },
      currentOrigin: "https://another.example"
    }),
    { admitted: false, reason: "stale-observation" }
  );
  assert.deepEqual(
    admission({
      currentViewport: { ...VIEWPORT, width: VIEWPORT.width + 1 }
    }),
    { admitted: false, reason: "viewport-changed" }
  );
});

test("only a refusal that says the page moved is recoverable", () => {
  // The two owners of a refusal both say the same thing when the page no
  // longer offers what the observation promised, and the episode answers that
  // by looking again.
  assert.equal(playtestActionRefusalMeansPageMoved("control-changed"), true);
  assert.equal(playtestActionRefusalMeansPageMoved("stale-observation"), true);
  // Every other refusal is final: the action was not allowed, the game needs
  // setup, or the episode is out of budget, and none of those changes because
  // the page was read again.
  const finalRefusals: readonly PlaytestVisualActionRefusalReason[] = [
    "control-unavailable",
    "auth-or-setup-required",
    "sensitive-visual-unredactable",
    "action-budget-exhausted",
    "wall-time-limit",
    "driver-state-unavailable",
    "event-budget-exhausted",
    "origin-not-approved",
    "input-not-approved"
  ];
  for (const reason of finalRefusals) {
    assert.equal(
      playtestActionRefusalMeansPageMoved(reason),
      false,
      `${reason} must not send the episode back to observe`
    );
  }
});

test("semantic and coordinate inputs cannot target text-entry surfaces or stale frames", () => {
  assert.deepEqual(
    admission({ action: action({ controlId: "player-name" }) }),
    { admitted: false, reason: "sensitive-control" }
  );
  assert.deepEqual(
    admission({
      action: action({
        kind: "pointer-click",
        frameArtifactId: FRAME_ID,
        x: 200,
        y: 20
      })
    }),
    { admitted: false, reason: "sensitive-control" }
  );
  assert.deepEqual(
    admission({
      action: action({
        kind: "pointer-click",
        frameArtifactId: "old-frame",
        x: 20,
        y: 20
      })
    }),
    { admitted: false, reason: "frame-mismatch" }
  );
  assert.deepEqual(
    admission({
      action: action({
        kind: "pointer-click",
        frameArtifactId: FRAME_ID,
        x: VIEWPORT.width,
        y: 20
      })
    }),
    { admitted: false, reason: "coordinate-out-of-bounds" }
  );
});

test("keyboard text entry is refused and only a finite key set is valid", () => {
  const focusedText = observation({
    controls: observation().controls.map((control) =>
      control.controlId === "player-name"
        ? { ...control, focused: true }
        : control
    )
  });
  assert.deepEqual(
    admission({
      observation: focusedText,
      action: action({ kind: "key-press", key: "Space" })
    }),
    { admitted: false, reason: "text-entry-not-supported" }
  );
  assert.throws(
    () =>
      assertPlaytestVisualAction(action({ kind: "key-press", key: "hello" })),
    /Visual key action is malformed/u
  );
});

test("unapproved input, revoked targets, and unsupported real-time targets fail closed", () => {
  assert.deepEqual(
    admission({
      action: action({ kind: "gamepad-press", button: "a" }),
      target: { ...target, inputCapabilities: ["pointer"] }
    }),
    { admitted: false, reason: "input-not-approved" }
  );
  assert.deepEqual(
    admission({
      action: action({ kind: "gamepad-press", button: "a" }),
      runtimeSupportedInputs: ["keyboard", "pointer"]
    }),
    { admitted: false, reason: "input-unsupported" }
  );
  assert.deepEqual(
    admission({
      target: {
        ...target,
        revokedAt: "2026-10-17T00:00:00.000Z",
        revokedBy: "operator-1",
        revocationReason: "Withdrawn."
      }
    }),
    { admitted: false, reason: "target-revoked" }
  );
  assert.deepEqual(
    admission({ target: { ...target, controlTimingClass: "continuous" } }),
    { admitted: false, reason: "unsupported-target" }
  );
});
