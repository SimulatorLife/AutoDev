import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  admitPlaytestVisualAction,
  type PlaytestVisualControl,
  type PlaytestVisualObservation,
  type WorkspaceVisualPlaytestTargetApproval
} from "@simulatorlife/autodev-core";

import { OneJevLocalVisualPolicy } from "../src/playtesting/onejev-local-policy.ts";
import {
  buildVisualCandidates,
  buildVisualCandidateSet,
  describeVisualCandidateChoice,
  MAX_VISUAL_CANDIDATES
} from "../src/playtesting/visual-candidates.ts";

const WORKSPACE_ID = "fixture/racing-game";
const ORIGIN = "http://127.0.0.1:5173";
const FRAME_BYTES = new TextEncoder().encode("bounded fixture frame bytes");
/** The charset the Core gives every control id, and the one a candidate keeps. */
const ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/u;

function target(
  overrides: Partial<WorkspaceVisualPlaytestTargetApproval> = {}
): WorkspaceVisualPlaytestTargetApproval {
  return {
    schema: "autodev-workspace-visual-playtest-target-v1",
    workspaceId: WORKSPACE_ID,
    targetId: "racing-target",
    revision: 2,
    approvalId: "approval-racing-target",
    name: "RacingGame local UI",
    entryUrl: ORIGIN + "/",
    allowedOrigins: [ORIGIN],
    inputCapabilities: ["keyboard", "pointer"],
    controlTimingClass: "turn-based",
    entryRequirements: "none",
    sandboxProfile: "transient-browser-profile",
    capturePolicy: "screenshots-only-redact-or-refuse",
    limits: {
      episodeCount: 2,
      maxStepsPerEpisode: 20,
      wallTimeMs: 60_000,
      smartRequestsPerEpisode: 8,
      smartTokensPerEpisode: 4000,
      screenshotCountPerEpisode: 20,
      artifactBytesPerEpisode: 8 * 1024 * 1024
    },
    approvedAt: "2026-10-17T12:00:00.000Z",
    approvedBy: "operator-1",
    revokedAt: null,
    revokedBy: null,
    revocationReason: null,
    ...overrides
  };
}

function control(
  overrides: Partial<PlaytestVisualControl> & { readonly controlId: string }
): PlaytestVisualControl {
  return {
    role: "button",
    name: `Control ${overrides.controlId}`,
    enabled: true,
    focused: false,
    inputKind: "none",
    bounds: { x: 20, y: 20, width: 100, height: 40 },
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
    targetId: "racing-target",
    episodeId: "episode-1",
    origin: ORIGIN,
    capturedAt: "2026-10-17T12:00:00.000Z",
    viewport: { width: 640, height: 480, deviceScaleFactor: 1 },
    frame: {
      artifactId: "frame-1",
      sha256: createHash("sha256").update(FRAME_BYTES).digest("hex"),
      bytes: FRAME_BYTES.byteLength,
      mediaType: "image/png"
    },
    privacyState: "redacted",
    controls: [
      control({
        controlId: "control-start",
        role: "button",
        name: "Start race"
      })
    ],
    visibleWarnings: [],
    phaseEvidence: null,
    progressEvidence: null,
    ...overrides
  };
}

function gridControls(count: number): PlaytestVisualControl[] {
  return Array.from({ length: count }, (_unused, index) =>
    control({
      controlId: `control-${String(index)}`,
      name: `Control ${String(index)}`,
      bounds: {
        x: (index % 8) * 80,
        y: Math.floor(index / 8) * 40,
        width: 60,
        height: 30
      }
    })
  );
}

test("a disabled control is not a candidate: the player cannot act on it", () => {
  const observed = observation({
    controls: [
      control({ controlId: "control-start", name: "Start race" }),
      control({
        controlId: "control-disabled",
        name: "Continue",
        enabled: false
      })
    ]
  });

  const candidates = buildVisualCandidates(observed);

  assert.deepEqual(
    candidates.map((candidate) => candidate.id),
    ["control-start"]
  );
  assert.equal(
    candidates.some(
      (candidate) =>
        candidate.action.kind === "activate-control" &&
        candidate.action.controlId === "control-disabled"
    ),
    false
  );
});

test("a text-entry control is not a candidate: typing into it is not one verifiable action", () => {
  const observed = observation({
    controls: [
      control({ controlId: "control-start", name: "Start race" }),
      control({
        controlId: "control-name",
        role: "textbox",
        name: "Player name",
        inputKind: "text-entry"
      }),
      control({
        controlId: "control-password",
        role: "textbox",
        name: "Password",
        inputKind: "password"
      })
    ]
  });

  const candidates = buildVisualCandidates(observed);

  assert.deepEqual(
    candidates.map((candidate) => candidate.id),
    ["control-start"]
  );
});

test("a text field role is not a candidate even when it claims no input kind: the Runtime refuses to activate it", () => {
  const observed = observation({
    controls: [
      control({ controlId: "control-start", name: "Start race" }),
      control({
        controlId: "control-combobox",
        role: "combobox",
        name: "Track",
        inputKind: "none"
      })
    ]
  });

  const candidates = buildVisualCandidates(observed);

  assert.deepEqual(
    candidates.map((candidate) => candidate.id),
    ["control-start"]
  );
});

test("every candidate action is admitted by the Runtime's own admission check", () => {
  const observed = observation({
    controls: gridControls(3)
  });

  const candidates = buildVisualCandidates(observed);

  assert.equal(candidates.length, 3);
  for (const candidate of candidates) {
    const admission = admitPlaytestVisualAction({
      target: target(),
      observation: observed,
      action: candidate.action,
      runtimeSupportedInputs: ["keyboard", "pointer"],
      currentOrigin: ORIGIN,
      currentViewport: observed.viewport,
      nowMs: Date.parse(observed.capturedAt),
      maxObservationAgeMs: 5000
    });
    assert.deepEqual(admission, { admitted: true });
    assert.equal(candidate.action.kind, "activate-control");
  }
});

test("candidate ids are unique, stable across builds, and safe as JSON object keys", () => {
  const observed = observation({ controls: gridControls(5) });

  const first = buildVisualCandidates(observed);
  const second = buildVisualCandidates(observed);
  const ids = first.map((candidate) => candidate.id);

  assert.deepEqual(
    ids,
    second.map((candidate) => candidate.id)
  );
  assert.deepEqual(first, second);
  assert.equal(new Set(ids).size, ids.length);
  for (const candidate of first) {
    assert.match(candidate.id, ID_PATTERN);
    assert.equal(candidate.id.trim(), candidate.id);
    // The id travels as a JSON object key and comes back unchanged.
    const criteria = { [candidate.id]: candidate.description };
    const roundTripped = structuredClone(criteria) as Record<string, string>;
    assert.deepEqual(Object.keys(roundTripped), [candidate.id]);
    assert.equal(roundTripped[candidate.id], candidate.description);
  }
});

test("the candidate set is capped and the truncation is reported rather than silent", () => {
  const observed = observation({
    controls: gridControls(MAX_VISUAL_CANDIDATES + 8)
  });

  const set = buildVisualCandidateSet(observed);

  assert.equal(set.candidates.length, MAX_VISUAL_CANDIDATES);
  assert.equal(set.actionableControlCount, MAX_VISUAL_CANDIDATES + 8);
  assert.equal(set.truncated, true);
  assert.equal(set.droppedCount, 8);
  assert.equal(buildVisualCandidates(observed).length, MAX_VISUAL_CANDIDATES);
});

test("an observation within the cap is not truncated", () => {
  const set = buildVisualCandidateSet(
    observation({ controls: gridControls(MAX_VISUAL_CANDIDATES) })
  );

  assert.equal(set.truncated, false);
  assert.equal(set.droppedCount, 0);
  assert.equal(set.candidates.length, MAX_VISUAL_CANDIDATES);
});

test("the candidate order is deterministic and follows the observation's control order", () => {
  const controls = [
    control({ controlId: "control-start", name: "Start race" }),
    control({ controlId: "control-options", name: "Options" }),
    control({ controlId: "control-quit", name: "Quit" })
  ];
  const observed = observation({ controls });

  const candidates = buildVisualCandidates(observed);

  assert.deepEqual(
    candidates.map((candidate) => candidate.id),
    ["control-start", "control-options", "control-quit"]
  );
  assert.deepEqual(
    candidates.map((candidate) => candidate.description),
    [
      'Activate the button "Start race".',
      'Activate the button "Options".',
      'Activate the button "Quit".'
    ]
  );
  assert.deepEqual(
    buildVisualCandidates(observation({ controls })).map(
      (candidate) => candidate.id
    ),
    ["control-start", "control-options", "control-quit"]
  );
});

test("the trace explains the candidate a decision chose and stays silent about an action it never offered", () => {
  const observed = observation({ controls: gridControls(2) });
  const candidates = buildVisualCandidates(observed);
  const chosen = candidates[0]!;
  assert.equal(chosen.action.kind, "activate-control");
  if (chosen.action.kind !== "activate-control") return;

  assert.equal(
    describeVisualCandidateChoice(candidates, chosen.action),
    chosen.description
  );
  assert.equal(
    describeVisualCandidateChoice(candidates, {
      ...chosen.action,
      controlId: "control-never-offered"
    }),
    null
  );
});

test("the OneJev backend accepts the built candidates and answers with one of them", async () => {
  const approved = target();
  const observed = observation({ controls: gridControls(3) });
  const candidates = buildVisualCandidates(observed);
  const chosen = candidates[1]!;
  const policy = new OneJevLocalVisualPolicy(approved, {
    endpoint: "http://127.0.0.1:8000",
    now: () => 0,
    fetchImpl: async () =>
      Response.json({
        model: "jev-latest",
        answers: {
          action: {
            type: "choice",
            choice: chosen.id,
            probabilities: { [chosen.id]: 1 },
            confidence: 0.82
          }
        },
        usage: { input_tokens: 120, output_tokens: 8 }
      })
  });

  const decision = await policy.decide({
    target: approved,
    observation: observed,
    frameBytes: FRAME_BYTES,
    areasOfFocus: null,
    history: [],
    deadlineMonotonicMs: 5000,
    candidates
  });

  assert.equal(decision.status, "act");
  assert.deepEqual(decision.action, chosen.action);
  assert.equal(
    describeVisualCandidateChoice(candidates, decision.action),
    chosen.description
  );
});
