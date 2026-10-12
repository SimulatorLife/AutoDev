import {
  defaultPlaytestRegistryDefaults,
  expandPlaytestRegistry,
  type GameMetricEvaluation,
  type PlaytestMetricRegistry
} from "@simulatorlife/autodev-core";

export const FIXTURE_SCORE_EVALUATOR_HASH = "f".repeat(64);

export function fixturePlaytestMetricRegistry(
  workspaceId: string,
  metricId = "fixture-score"
): PlaytestMetricRegistry {
  return expandPlaytestRegistry({
    schemaVersion: 2,
    workspaceId,
    audience: "fixture-player",
    registryVersion: "fixture-v2",
    eventSchemaHash: "c".repeat(64),
    defaults: defaultPlaytestRegistryDefaults(),
    metricDefinitions: [
      {
        metricId,
        version: 1,
        mechanicKey: "fixture-scoring",
        scenarioEligibility: ["tutorial"],
        exposurePredicate: "terminal-score-v1",
        aggregationWindow: "phase",
        eventFields: ["outcome.score"],
        evaluatorRef: "fixture/score-v1",
        evaluatorHash: FIXTURE_SCORE_EVALUATOR_HASH,
        numerator: "sum of source-authored terminal score",
        denominator: "completed fixture episodes",
        unit: "proportion",
        polarity: "higher",
        targetBand: [0, 1],
        notObservable: ["unobserved"]
      }
    ],
    coverageRequirements: [
      {
        coverageMetricId: metricId,
        mechanicKey: "fixture-scoring",
        phaseId: "tutorial",
        scenarioFamily: "tutorial",
        cohort: "novice",
        policy: "fixture-heuristic",
        modality: "headless",
        requiredOpportunities: 1,
        requiredIndependentUnits: 1,
        unsupportedReason: null
      },
      {
        coverageMetricId: metricId,
        mechanicKey: "fixture-scoring",
        phaseId: "tutorial",
        scenarioFamily: "tutorial-family",
        cohort: "exploratory",
        policy: "random",
        modality: "headless",
        requiredOpportunities: 1,
        requiredIndependentUnits: 1,
        unsupportedReason: null
      }
    ],
    dimensionRubrics: []
  });
}

export function fixtureScoreEvaluation(
  value: number,
  metricId = "fixture-score"
): GameMetricEvaluation {
  return {
    metricId,
    metricVersion: 1,
    phaseId: "tutorial",
    evaluatorRef: "fixture/score-v1",
    evaluatorHash: FIXTURE_SCORE_EVALUATOR_HASH,
    numerator: value,
    denominator: 1,
    opportunityCount: 1,
    missing: 0,
    independentUnits: 1,
    unit: "proportion",
    missingReasons: []
  };
}
