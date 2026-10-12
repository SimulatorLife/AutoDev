import assert from "node:assert/strict";
import test from "node:test";

import type {
  HumanPlaytestStudy,
  PlaytestHumanPreferencePlan
} from "../src/playtesting/artifacts.ts";
import {
  aggregatePlaytestPreferenceResponses,
  assertHumanStudyPreferencePlan,
  classifyPlaytestPreferenceSensitivity
} from "../src/playtesting/human-preference.ts";
import {
  type PlaytestNumericInterval,
  PLAYTESTS_HUMAN_STUDY_SCHEMA
} from "../src/playtesting/types.ts";

const preciseInterval = (
  lower: number,
  upper: number
): PlaytestNumericInterval => ({
  lower,
  upper,
  method: "scipy-binomial-exact",
  libraryVersion: "scipy-1.17.0/numpy-2.3.5/statsmodels-0.14.6",
  confidenceLevel: 0.95,
  resamples: null,
  seed: null
});

function plan(
  overrides: Partial<PlaytestHumanPreferencePlan> = {}
): PlaytestHumanPreferencePlan {
  return {
    analysisPlanRef: "study-plan-v1",
    questionVersion: "preference-question-v1",
    questionHash: "a".repeat(64),
    buildA: { id: "build-A", version: "1", contentHash: "b".repeat(64) },
    buildB: { id: "build-B", version: "1", contentHash: "c".repeat(64) },
    maximumExclusionRate: 0.2,
    practicalMargin: 0.05,
    minimumIndependentParticipants: 10,
    interval: {
      method: "scipy-binomial-exact",
      libraryVersion: "scipy-1.17.0/numpy-2.3.5/statsmodels-0.14.6",
      confidenceLevel: 0.95,
      resamples: null,
      seed: null
    },
    ...overrides
  };
}

function input(
  overrides: Partial<
    Parameters<typeof classifyPlaytestPreferenceSensitivity>[0]
  > = {}
): Parameters<typeof classifyPlaytestPreferenceSensitivity>[0] {
  return {
    counts: {
      eligibleParticipants: 20,
      preferA: 4,
      preferB: 12,
      ties: 1,
      unableToJudge: 1,
      missing: 2
    },
    study: study(plan()),
    interval: preciseInterval(0.6, 0.82),
    ...overrides
  };
}

test("change sensitivity supports B only when its interval clears chance plus the margin", () => {
  const result = classifyPlaytestPreferenceSensitivity(input());
  assert.equal(result.decision, "supports-b-preference");
  assert.equal(result.probabilityBPreferred, 0.75);
  assert.equal(result.decisiveParticipants, 16);
  assert.equal(result.excludedParticipants, 4);
  assert.equal(result.exclusionRate, 0.2);
  assert.equal(result.analysisPlanRef, "study-plan-v1");
});

test("change sensitivity keeps A/B, ties, unable and missing counts distinct", () => {
  const result = classifyPlaytestPreferenceSensitivity(
    input({
      counts: {
        eligibleParticipants: 20,
        preferA: 13,
        preferB: 4,
        ties: 1,
        unableToJudge: 1,
        missing: 1
      },
      interval: preciseInterval(0.1, 0.4)
    })
  );
  assert.equal(result.decision, "supports-a-preference");
  assert.deepEqual(
    [
      result.preferA,
      result.preferB,
      result.ties,
      result.unableToJudge,
      result.missing
    ],
    [13, 4, 1, 1, 1]
  );
});

test("change sensitivity calls an interval inside the practical band no material preference", () => {
  const result = classifyPlaytestPreferenceSensitivity(
    input({ interval: preciseInterval(0.46, 0.54) })
  );
  assert.equal(result.decision, "no-material-preference");
});

test("boundary overlap, wide intervals and unavailable intervals remain inconclusive", () => {
  for (const interval of [
    preciseInterval(0.55, 0.8),
    preciseInterval(0.4, 0.6),
    null
  ]) {
    assert.equal(
      classifyPlaytestPreferenceSensitivity(input({ interval })).decision,
      "inconclusive"
    );
  }
});

test("excess exclusions and low participant counts block preference claims", () => {
  const tooManyExcluded = classifyPlaytestPreferenceSensitivity(
    input({
      counts: {
        eligibleParticipants: 20,
        preferA: 4,
        preferB: 10,
        ties: 2,
        unableToJudge: 2,
        missing: 2
      }
    })
  );
  assert.equal(tooManyExcluded.decision, "inconclusive");
  assert.ok(
    tooManyExcluded.reasons.includes(
      "exclusion-rate-exceeds-preregistered-maximum"
    )
  );

  const tooFew = classifyPlaytestPreferenceSensitivity(
    input({
      counts: {
        eligibleParticipants: 4,
        preferA: 0,
        preferB: 4,
        ties: 0,
        unableToJudge: 0,
        missing: 0
      },
      study: study(
        plan({
          minimumIndependentParticipants: 5,
          maximumExclusionRate: 0
        })
      ),
      interval: preciseInterval(0.6, 1)
    })
  );
  assert.equal(tooFew.decision, "inconclusive");
  assert.ok(tooFew.reasons.includes("insufficient-independent-participants"));
});

test("zero decisive responses are explicit rather than imputed to chance", () => {
  const result = classifyPlaytestPreferenceSensitivity(
    input({
      counts: {
        eligibleParticipants: 5,
        preferA: 0,
        preferB: 0,
        ties: 2,
        unableToJudge: 2,
        missing: 1
      },
      study: study(plan({ maximumExclusionRate: 1 - Number.EPSILON })),
      interval: null
    })
  );
  assert.equal(result.probabilityBPreferred, null);
  assert.equal(result.exclusionRate, 1);
  assert.equal(result.decision, "inconclusive");
});

test("malformed tallies, gates and ungrounded intervals are rejected", () => {
  assert.throws(
    () =>
      classifyPlaytestPreferenceSensitivity(
        input({
          counts: {
            eligibleParticipants: 20,
            preferA: 4,
            preferB: 12,
            ties: 1,
            unableToJudge: 1,
            missing: 1
          }
        })
      ),
    /partition all eligible participants/
  );
  assert.throws(
    () =>
      classifyPlaytestPreferenceSensitivity(
        input({ study: study(plan({ practicalMargin: 0.5 })) })
      ),
    /Human preference plan is invalid/
  );
  assert.throws(
    () =>
      classifyPlaytestPreferenceSensitivity(
        input({ interval: preciseInterval(0.2, 1.1) })
      ),
    /provenance-backed probability interval/
  );
  assert.throws(
    () =>
      classifyPlaytestPreferenceSensitivity(
        input({
          interval: {
            ...preciseInterval(0.6, 0.8),
            resamples: 1000,
            seed: "42"
          }
        })
      ),
    /does not match the frozen study plan/
  );
  assert.throws(
    () =>
      classifyPlaytestPreferenceSensitivity(
        input({
          counts: {
            eligibleParticipants: 5,
            preferA: 0,
            preferB: 0,
            ties: 2,
            unableToJudge: 2,
            missing: 1
          }
        })
      ),
    /requires at least one decisive response/
  );
});

test("preference response aggregation preserves nonresponse classes without returning participant keys", () => {
  const responses = [
    { participantKey: "private-p1", answer: "B" as const },
    { participantKey: "private-p2", answer: "A" as const },
    { participantKey: "private-p3", answer: "tie" as const },
    { participantKey: "private-p4", answer: "unable-to-judge" as const },
    { participantKey: "private-p5", answer: null }
  ];
  const counts = aggregatePlaytestPreferenceResponses(responses);
  assert.deepEqual(counts, {
    eligibleParticipants: 5,
    preferA: 1,
    preferB: 1,
    ties: 1,
    unableToJudge: 1,
    missing: 1
  });
  assert.equal(JSON.stringify(counts).includes("private-p"), false);
});

test("preference response aggregation rejects duplicate participants and invalid answers", () => {
  assert.throws(
    () =>
      aggregatePlaytestPreferenceResponses([
        { participantKey: "p1", answer: "A" },
        { participantKey: "p1", answer: "B" }
      ]),
    /no more than one row per participant/
  );
  assert.throws(
    () =>
      aggregatePlaytestPreferenceResponses([
        { participantKey: "p1", answer: "not-an-answer" as never }
      ]),
    /closed vocabulary/
  );
});

function study(
  preferencePlan: PlaytestHumanPreferencePlan | undefined,
  overrides: Partial<HumanPlaytestStudy> = {}
): HumanPlaytestStudy {
  return {
    schema: PLAYTESTS_HUMAN_STUDY_SCHEMA,
    studyId: "study-1",
    version: 1,
    workspaceId: "workspace-1",
    benchmarkId: "benchmark-1",
    allowedBuilds: [
      { id: "build-A", version: "1", contentHash: "b".repeat(64) },
      { id: "build-B", version: "1", contentHash: "c".repeat(64) }
    ],
    ...(preferencePlan ? { preferencePlan } : {}),
    pxiItemConstructMappingHash: null,
    instrument: "miniPXI",
    instrumentVersion: "miniPXI-v1",
    instrumentHash: "miniPXI-hash",
    consentVersion: "consent-v1",
    consentScope: "study-only",
    approved: true,
    approvedBy: "operator-1",
    responseWindowMs: 60_000,
    minimumExposureMs: 1000,
    orderDesign: "AB/BA",
    independentUnit: "participant",
    missingItemPolicy: "null-construct",
    invitedCount: 20,
    eligibleCount: 20,
    respondedCount: 18,
    withdrawnCount: 0,
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides
  };
}

test("approved preference plan binds the question, exact allowed build pair and statistical gates", () => {
  assert.doesNotThrow(() => assertHumanStudyPreferencePlan(study(plan())));
  assert.doesNotThrow(() => assertHumanStudyPreferencePlan(study(undefined)));
});

test("preference plan refuses unapproved builds, single-build and non-independent designs", () => {
  assert.throws(
    () =>
      assertHumanStudyPreferencePlan(
        study(
          plan({
            buildB: {
              id: "build-C",
              version: "1",
              contentHash: "d".repeat(64)
            }
          })
        )
      ),
    /two allowed builds/
  );
  assert.throws(
    () =>
      assertHumanStudyPreferencePlan(
        study(plan(), { orderDesign: "single-build" })
      ),
    /counterbalanced participant-level study/
  );
  assert.throws(
    () =>
      assertHumanStudyPreferencePlan(
        study(plan(), { independentUnit: "participant-pair" })
      ),
    /counterbalanced participant-level study/
  );
  assert.throws(
    () =>
      assertHumanStudyPreferencePlan(
        study(plan({ questionHash: "not-a-hash" }))
      ),
    /Human preference plan is invalid/
  );
  assert.throws(
    () =>
      assertHumanStudyPreferencePlan(
        study(undefined, {
          preferencePlan: null as unknown as PlaytestHumanPreferencePlan
        })
      ),
    /Human preference plan is invalid/
  );
});

test("preference interval method and version must exactly match the approved plan", () => {
  assert.throws(
    () =>
      classifyPlaytestPreferenceSensitivity(
        input({
          study: study(
            plan({
              interval: {
                method: "other-method",
                libraryVersion: "scipy-1.17.0/numpy-2.3.5/statsmodels-0.14.6",
                confidenceLevel: 0.95,
                resamples: null,
                seed: null
              }
            })
          )
        })
      ),
    /does not match the frozen study plan/
  );
});

test("preference classifier accepts only an approved study with its bound plan", () => {
  assert.throws(
    () =>
      classifyPlaytestPreferenceSensitivity(
        input({ study: study(plan(), { approved: false }) })
      ),
    /approved, counterbalanced/
  );
  assert.throws(
    () =>
      classifyPlaytestPreferenceSensitivity(input({ study: study(undefined) })),
    /no preference plan/
  );
});
