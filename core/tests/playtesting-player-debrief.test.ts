import assert from "node:assert/strict";
import test from "node:test";

import {
  assertPlaytestPlayerDebrief,
  assertPlaytestPlayerDebriefForEpisode,
  type PlaytestPlayerDebriefV1
} from "../src/playtesting/index.ts";

const source = {
  authorRole: "player",
  policyId: "smart-direct",
  policyVersion: "1",
  modelId: "autodev/smart",
  modelVersion: null
} as const;
const evidence = {
  kind: "frame",
  id: "frame-episode-1-step-2",
  step: 2,
  frameIndex: 2
} as const;
const focusInterpretation = {
  schema: "autodev-playtest-focus-interpretation-v1",
  requestedFocus: "Inspect the setup menu without beginning a race.",
  objective: "Inspect the setup menu.",
  inScope: ["Visible setup controls"],
  forbiddenScope: ["Starting a race"],
  stopCriteria: ["Stop when the setup menu is visible."],
  outcome: "achieved",
  assessmentSource: "smart-direct-self-report",
  evidence: [evidence]
} as const;

function completeReport(): PlaytestPlayerDebriefV1 {
  return {
    schema: "autodev-playtest-player-debrief-v1",
    status: "complete",
    source,
    focusInterpretation,
    summary: "I opened the setup menu and stopped before starting a race."
  };
}

test("PlayerDebriefV1 accepts an evidence-linked self-report without claiming game truth", () => {
  assert.doesNotThrow(() => assertPlaytestPlayerDebrief(completeReport()));
  assert.doesNotThrow(() =>
    assertPlaytestPlayerDebriefForEpisode({
      executionMode: "autonomous-visual",
      policyId: "smart-direct",
      episodeStatus: "completed",
      playerDebrief: completeReport(),
      frames: [evidence]
    })
  );
  assert.throws(
    () =>
      assertPlaytestPlayerDebriefForEpisode({
        executionMode: "autonomous-visual",
        policyId: "smart-direct",
        episodeStatus: "started",
        playerDebrief: completeReport(),
        frames: [evidence]
      }),
    /requires a terminal visual episode/u
  );
});

test("PlayerDebriefV1 distinguishes absent, pending, not-applicable and unavailable states", () => {
  const states: readonly PlaytestPlayerDebriefV1[] = [
    {
      schema: "autodev-playtest-player-debrief-v1",
      status: "absent",
      reason: "legacy-no-report"
    },
    {
      schema: "autodev-playtest-player-debrief-v1",
      status: "pending",
      reason: "episode-in-progress"
    },
    {
      schema: "autodev-playtest-player-debrief-v1",
      status: "not-applicable",
      reason: "non-reflective-policy"
    },
    {
      schema: "autodev-playtest-player-debrief-v1",
      status: "unavailable",
      reason: "interrupted-before-checkpoint"
    }
  ];
  for (const state of states) {
    assert.doesNotThrow(() => assertPlaytestPlayerDebrief(state));
  }
  assert.doesNotThrow(() =>
    assertPlaytestPlayerDebriefForEpisode({
      executionMode: "adapter-accelerated",
      policyId: "random",
      episodeStatus: "completed",
      playerDebrief: states[2]!,
      frames: []
    })
  );
  assert.throws(
    () =>
      assertPlaytestPlayerDebriefForEpisode({
        executionMode: "autonomous-visual",
        policyId: "smart-direct",
        episodeStatus: "completed",
        playerDebrief: states[2]!,
        frames: []
      }),
    /requires a non-reflective policy/u
  );
});

test("PlayerDebriefV1 accepts only an authored checkpoint for a partial report", () => {
  const partial: PlaytestPlayerDebriefV1 = {
    schema: "autodev-playtest-player-debrief-v1",
    status: "partial",
    reason: "episode-interrupted",
    source,
    checkpoint: {
      schema: "autodev-playtest-player-checkpoint-v1",
      intention: "Open the setup menu.",
      predictedVisibleEffect: "The setup controls will become visible.",
      evidence
    }
  };
  assert.doesNotThrow(() => assertPlaytestPlayerDebrief(partial));
  assert.doesNotThrow(() =>
    assertPlaytestPlayerDebriefForEpisode({
      executionMode: "autonomous-visual",
      policyId: "smart-direct",
      episodeStatus: "started",
      playerDebrief: partial,
      frames: [evidence]
    })
  );
  assert.throws(
    () =>
      assertPlaytestPlayerDebriefForEpisode({
        executionMode: "autonomous-visual",
        policyId: "smart-direct",
        episodeStatus: "started",
        playerDebrief: partial,
        frames: []
      }),
    /does not resolve to a stored episode frame/u
  );
});

test("focus claims without evidence or an operator focus are refused", () => {
  assert.throws(
    () =>
      assertPlaytestPlayerDebrief({
        ...completeReport(),
        focusInterpretation: {
          ...focusInterpretation,
          evidence: []
        }
      }),
    /requires resolvable player-visible evidence/u
  );
  assert.throws(
    () =>
      assertPlaytestPlayerDebrief({
        ...completeReport(),
        focusInterpretation: {
          ...focusInterpretation,
          requestedFocus: null
        }
      }),
    /without operator focus must remain unattempted/u
  );
});

test("focus interpretation rejects out-of-vocabulary outcomes and over-budget collections", () => {
  assert.throws(
    () =>
      assertPlaytestPlayerDebrief({
        ...completeReport(),
        focusInterpretation: {
          ...focusInterpretation,
          outcome: "win"
        }
      }),
    /Player focus interpretation is invalid/u
  );
  assert.throws(
    () =>
      assertPlaytestPlayerDebrief({
        ...completeReport(),
        focusInterpretation: {
          ...focusInterpretation,
          inScope: Array.from({ length: 4 }, () => "item")
        }
      }),
    /in-scope items is invalid/u
  );
});
