import assert from "node:assert/strict";
import test from "node:test";

import {
  evaluateDiagnosticLadder,
  type EvaluateDiagnosticLadderInput,
  type PlaytestPreActionForecast
} from "../src/playtesting/comprehension.ts";

const FIXTURE_THRESHOLDS = {
  modelAmbiguityAccuracy: 0.6,
  humanConfusionErrorRate: 0.2
};

test("diagnostic ladder requires stage 1 UI-to-observation equivalence before inferring confusion", () => {
  const result = evaluateDiagnosticLadder({
    mechanicKey: "heat-management",
    thresholds: FIXTURE_THRESHOLDS,
    stage1UiEquivalenceVerified: false,
    stage2VerifiedObserverIds: ["observer-1"],
    stage3Forecasts: []
  });

  assert.equal(
    result.highestStageReached,
    "authoritative-rules-and-ui-equivalence"
  );
  assert.equal(result.confusionCategory, "unverified");
  assert.equal(result.modelForecastAccuracy, null);
  assert.match(result.reasons[0]!, /UI-to-observation equivalence/u);
});

test("diagnostic ladder requires stage 2 observer competence before accepting model forecasts", () => {
  const result = evaluateDiagnosticLadder({
    mechanicKey: "heat-management",
    thresholds: FIXTURE_THRESHOLDS,
    stage1UiEquivalenceVerified: true,
    stage2VerifiedObserverIds: [],
    stage3Forecasts: [
      {
        probeId: "probe-1",
        mechanicKey: "heat-management",
        preActionUiRef: "ui-frame-1",
        actionId: "turbo-boost",
        consequenceVariable: "engine-heat",
        predictedValue: 50,
        confidence: 0.9,
        actualConsequence: 100,
        isCorrect: false,
        cohort: "novice-bot",
        isHuman: false
      }
    ]
  });

  assert.equal(result.highestStageReached, "observer-competence");
  assert.equal(result.confusionCategory, "unverified");
  assert.match(result.reasons[0]!, /Observer competence unverified/u);
});

test("model forecast errors alone never yield human-confirmed-confusing", () => {
  const forecasts: PlaytestPreActionForecast[] = [
    {
      probeId: "probe-1",
      mechanicKey: "heat-management",
      preActionUiRef: "ui-frame-1",
      actionId: "turbo-boost",
      consequenceVariable: "engine-heat",
      predictedValue: 50,
      confidence: 0.8,
      actualConsequence: 100,
      isCorrect: false,
      cohort: "novice-bot",
      isHuman: false
    },
    {
      probeId: "probe-2",
      mechanicKey: "heat-management",
      preActionUiRef: "ui-frame-2",
      actionId: "brake",
      consequenceVariable: "engine-heat",
      predictedValue: 20,
      confidence: 0.9,
      actualConsequence: 20,
      isCorrect: true,
      cohort: "novice-bot",
      isHuman: false
    }
  ];

  const result = evaluateDiagnosticLadder({
    mechanicKey: "heat-management",
    thresholds: FIXTURE_THRESHOLDS,
    stage1UiEquivalenceVerified: true,
    stage2VerifiedObserverIds: ["observer-1"],
    stage3Forecasts: forecasts
  });

  assert.equal(result.highestStageReached, "frozen-preaction-forecasts");
  assert.notEqual(result.confusionCategory, "human-confirmed-confusing");
  assert.equal(result.modelForecastAccuracy, 0.5);
  assert.equal(result.humanErrorRate, null);
});

test("unconsented human evidence is rejected strictly", () => {
  assert.throws(
    () =>
      evaluateDiagnosticLadder({
        mechanicKey: "heat-management",
        thresholds: FIXTURE_THRESHOLDS,
        stage1UiEquivalenceVerified: true,
        stage2VerifiedObserverIds: ["observer-1"],
        stage3Forecasts: [
          {
            probeId: "probe-1",
            mechanicKey: "heat-management",
            preActionUiRef: "ui-frame-1",
            actionId: "turbo-boost",
            consequenceVariable: "engine-heat",
            predictedValue: 50,
            confidence: 0.8,
            actualConsequence: 100,
            isCorrect: false,
            cohort: "novice-bot",
            isHuman: false
          }
        ],
        stage4HumanEvidence: {
          studyId: "study-unconsented",
          consented: false,
          participantCount: 10,
          eligibleExposures: 10,
          correctCount: 2,
          errorRateInterval: null,
          shadowCohort: true
        }
      }),
    /strictly consented/u
  );
});

test("small-cell human sample (<5) suppresses human-confirmed claim", () => {
  const result = evaluateDiagnosticLadder({
    mechanicKey: "heat-management",
    thresholds: FIXTURE_THRESHOLDS,
    stage1UiEquivalenceVerified: true,
    stage2VerifiedObserverIds: ["observer-1"],
    stage3Forecasts: [
      {
        probeId: "probe-1",
        mechanicKey: "heat-management",
        preActionUiRef: "ui-frame-1",
        actionId: "turbo-boost",
        consequenceVariable: "engine-heat",
        predictedValue: 50,
        confidence: 0.8,
        actualConsequence: 100,
        isCorrect: false,
        cohort: "novice-bot",
        isHuman: false
      }
    ],
    stage4HumanEvidence: {
      studyId: "study-small",
      consented: true,
      participantCount: 3,
      eligibleExposures: 3,
      correctCount: 0,
      errorRateInterval: {
        lower: 0.4,
        upper: 1,
        method: "fixture-interval",
        libraryVersion: "fixture-v1",
        confidenceLevel: 0.95,
        resamples: null,
        seed: null
      },
      shadowCohort: true
    }
  });

  assert.equal(result.confusionCategory, "ui-possibly-ambiguous");
  assert.match(result.reasons[0]!, /small-cell threshold/u);
});

test("human confusion requires uncertainty beyond the game-owned threshold", () => {
  const base = {
    mechanicKey: "heat-management",
    thresholds: FIXTURE_THRESHOLDS,
    stage1UiEquivalenceVerified: true,
    stage2VerifiedObserverIds: ["observer-1"],
    stage3Forecasts: [
      {
        probeId: "probe-1",
        mechanicKey: "heat-management",
        preActionUiRef: "ui-frame-1",
        actionId: "turbo-boost",
        consequenceVariable: "engine-heat",
        predictedValue: 50,
        confidence: 0.8,
        actualConsequence: 100,
        isCorrect: false,
        cohort: "novice-bot",
        isHuman: false
      }
    ]
  } as const;
  const result = evaluateDiagnosticLadder({
    ...base,
    stage4HumanEvidence: {
      studyId: "study-uncertain",
      consented: true,
      participantCount: 12,
      eligibleExposures: 12,
      correctCount: 3,
      errorRateInterval: {
        lower: 0.1,
        upper: 0.8,
        method: "fixture-interval",
        libraryVersion: "fixture-v1",
        confidenceLevel: 0.95,
        resamples: null,
        seed: null
      },
      shadowCohort: true
    }
  });
  assert.equal(result.confusionCategory, "ui-possibly-ambiguous");
  assert.equal(result.humanErrorRate, 0.75);
  assert.match(result.reasons[0]!, /interval overlaps/u);
});

test("consented human cohort with adequate sample validates human-confirmed confusion", () => {
  const result = evaluateDiagnosticLadder({
    mechanicKey: "heat-management",
    thresholds: FIXTURE_THRESHOLDS,
    stage1UiEquivalenceVerified: true,
    stage2VerifiedObserverIds: ["observer-1"],
    stage3Forecasts: [
      {
        probeId: "probe-1",
        mechanicKey: "heat-management",
        preActionUiRef: "ui-frame-1",
        actionId: "turbo-boost",
        consequenceVariable: "engine-heat",
        predictedValue: 50,
        confidence: 0.8,
        actualConsequence: 100,
        isCorrect: false,
        cohort: "novice-bot",
        isHuman: false
      }
    ],
    stage4HumanEvidence: {
      studyId: "study-valid",
      consented: true,
      participantCount: 12,
      eligibleExposures: 12,
      correctCount: 3,
      errorRateInterval: {
        lower: 0.5,
        upper: 0.9,
        method: "fixture-interval",
        libraryVersion: "fixture-v1",
        confidenceLevel: 0.95,
        resamples: null,
        seed: null
      },
      shadowCohort: true,
      miniPxiGoalClarity: -1.5
    },
    stage5Intervention: {
      interventionId: "int-warning-redesign",
      treatmentWarningRef: "warning-banner-v2",
      controlErrorRate: 0.75,
      treatmentErrorRate: 0.15,
      controlSampleSize: 12,
      treatmentSampleSize: 12,
      riskDifferenceInterval: {
        lower: -0.8,
        upper: -0.2,
        method: "fixture-interval",
        libraryVersion: "fixture-v1",
        confidenceLevel: 0.95,
        resamples: null,
        seed: null
      }
    }
  });

  assert.equal(result.highestStageReached, "controlled-intervention");
  assert.equal(result.confusionCategory, "human-confirmed-confusing");
  assert.equal(result.humanErrorRate, 0.75);
  assert.equal(result.interventionRiskDifference, -0.6);
  assert.deepEqual(result.interventionRiskDifferenceInterval, {
    lower: -0.8,
    upper: -0.2,
    method: "fixture-interval",
    libraryVersion: "fixture-v1",
    confidenceLevel: 0.95,
    resamples: null,
    seed: null
  });
  assert.match(result.reasons[0]!, /Human-confirmed confusion/u);
});

test("controlled intervention cannot advance without qualified human evidence and an interval", () => {
  const result = evaluateDiagnosticLadder({
    mechanicKey: "heat-management",
    thresholds: FIXTURE_THRESHOLDS,
    stage1UiEquivalenceVerified: true,
    stage2VerifiedObserverIds: ["observer-1"],
    stage3Forecasts: [
      {
        probeId: "probe-1",
        mechanicKey: "heat-management",
        preActionUiRef: "ui-frame-1",
        actionId: "turbo-boost",
        consequenceVariable: "engine-heat",
        predictedValue: 50,
        confidence: 0.8,
        actualConsequence: 100,
        isCorrect: false,
        cohort: "novice-bot",
        isHuman: false
      }
    ],
    stage5Intervention: {
      interventionId: "warning-redesign",
      treatmentWarningRef: "warning-v2",
      controlErrorRate: 0.7,
      treatmentErrorRate: 0.2,
      controlSampleSize: 10,
      treatmentSampleSize: 10,
      riskDifferenceInterval: null
    }
  });
  assert.equal(result.highestStageReached, "frozen-preaction-forecasts");
  assert.equal(result.interventionRiskDifference, null);
  assert.equal(result.interventionRiskDifferenceInterval, null);
  assert.match(
    result.reasons.at(-1)!,
    /requires qualified consented human evidence/u
  );
});

/**
 * Observer competence is a rung of the ladder, not a precondition the caller
 * asserts.
 *
 * `stage2ObserverCompetenceVerified` was a bare boolean: a caller could pass
 * `true` on the strength of nothing and the ladder would go on to
 * human-confusion conclusions, which is exactly the distinction the contract
 * says stage 2 exists to protect — model error cannot be separated from
 * observer deficiency without an independently initialized, competence-checked
 * observer. Naming the observers closes that, and gives `PlayerPolicyValidity`
 * its first consumer.
 */
/** A ladder input that reaches stage 3, so only the observer gate varies. */
function ladderBase(): EvaluateDiagnosticLadderInput {
  return {
    mechanicKey: "heat-management",
    thresholds: FIXTURE_THRESHOLDS,
    stage1UiEquivalenceVerified: true,
    stage2VerifiedObserverIds: ["observer-1"],
    stage3Forecasts: [
      {
        probeId: "probe-1",
        mechanicKey: "heat-management",
        preActionUiRef: "ui-frame-1",
        actionId: "turbo-boost",
        consequenceVariable: "engine-heat",
        predictedValue: 50,
        confidence: 0.8,
        actualConsequence: 100,
        isCorrect: false,
        cohort: "novice-bot",
        isHuman: false
      }
    ]
  };
}

test("an unnamed observer is not a verified observer", () => {
  const base = ladderBase();
  // The old shape: `true` with nothing behind it.
  const unbacked = evaluateDiagnosticLadder({
    ...base,
    stage2VerifiedObserverIds: []
  });
  assert.equal(unbacked.confusionCategory, "unverified");
  assert.equal(unbacked.highestStageReached, "observer-competence");
  assert.equal(unbacked.humanErrorRate, null);
  assert.match(unbacked.reasons.join(" "), /competence unverified/u);

  // A named observer proceeds, which is the difference the list makes.
  const named = evaluateDiagnosticLadder({
    ...base,
    stage2VerifiedObserverIds: ["observer-1"]
  });
  assert.notEqual(named.highestStageReached, "observer-competence");
});

test("an unusable observer reference is refused rather than counted", () => {
  const base = ladderBase();
  for (const ids of [["   "], [""], ["observer-1", "  "]]) {
    const result = evaluateDiagnosticLadder({
      ...base,
      stage2VerifiedObserverIds: ids
    });
    assert.equal(result.confusionCategory, "unverified");
    assert.match(result.reasons.join(" "), /not a usable identifier/u);
  }
});

test("a malformed observer list is refused, not crashed on", () => {
  // Untyped callers can still hand this something that is not a list. The
  // ladder has to name that as unverified rather than throwing a TypeError
  // out of a diagnostic path, which would look like a crash instead of a
  // refusal.
  for (const bad of ["observer-1", 42, null, { length: 1 }]) {
    const result = evaluateDiagnosticLadder({
      ...ladderBase(),
      stage2VerifiedObserverIds: bad as unknown as readonly string[]
    });
    assert.equal(result.confusionCategory, "unverified");
    assert.equal(result.highestStageReached, "observer-competence");
  }
});
