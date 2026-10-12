import assert from "node:assert/strict";
import test from "node:test";

import {
  assertPlaytestAdapterResult,
  assertPlaytestNumericResults,
  defaultPlaytestRegistryDefaults,
  expandPlaytestRegistry,
  type GameMetricEvaluation,
  normalizeGameMetricEvaluations,
  type PlaytestMetricRegistry
} from "../src/playtesting/index.ts";

const EVALUATOR_HASH = "f".repeat(64);
const RUBRIC_HASH = "e".repeat(64);
const BUILD_SHA = "a".repeat(40);

function registry(
  overrides: Partial<{
    readonly metricId: string;
    readonly modality: "headless" | "browser" | "human-post-play";
    readonly scenarioEligibility: readonly string[];
    readonly aggregationWindow: "phase" | "whole-episode";
    readonly evaluatorHash: string;
  }> = {}
): PlaytestMetricRegistry {
  const metric = {
    metricId: "fixture-rate",
    version: 3,
    mechanicKey: "fixture-mechanic",
    scenarioEligibility: ["tutorial"],
    exposurePredicate: "fixture-opportunity-v1",
    aggregationWindow: "phase",
    eventFields: ["fact.value"],
    evaluatorRef: "game/evaluators.ts#fixture-rate",
    evaluatorHash: EVALUATOR_HASH,
    numerator: "successes",
    denominator: "eligible opportunities",
    unit: "proportion",
    polarity: "higher",
    targetBand: [0, 1],
    notObservable: ["unobserved"],
    ...overrides
  };
  return expandPlaytestRegistry({
    schemaVersion: 2,
    workspaceId: "owner/game",
    audience: "fixture-player",
    registryVersion: "fixture-v2",
    eventSchemaHash: "d".repeat(64),
    defaults: defaultPlaytestRegistryDefaults(),
    metricDefinitions: [metric],
    coverageRequirements: [
      {
        coverageMetricId: metric.metricId,
        mechanicKey: metric.mechanicKey,
        phaseId:
          metric.aggregationWindow === "whole-episode"
            ? null
            : "tutorial-phase",
        scenarioFamily: "tutorial",
        cohort: "novice",
        policy: "fixture-heuristic",
        modality: metric.modality ?? "headless",
        requiredOpportunities: metric.modality === "human-post-play" ? 0 : 1,
        requiredIndependentUnits: metric.modality === "human-post-play" ? 0 : 1,
        unsupportedReason:
          metric.modality === "human-post-play" ? "consented-study-only" : null
      }
    ],
    dimensionRubrics: []
  });
}

function evaluation(
  overrides: Partial<GameMetricEvaluation> = {}
): GameMetricEvaluation {
  return {
    metricId: "fixture-rate",
    metricVersion: 3,
    phaseId: "tutorial-phase",
    evaluatorRef: "game/evaluators.ts#fixture-rate",
    evaluatorHash: EVALUATOR_HASH,
    numerator: 2,
    denominator: 4,
    opportunityCount: 5,
    missing: 1,
    independentUnits: 1,
    unit: "proportion",
    missingReasons: ["unobserved"],
    ...overrides
  };
}

const context = {
  registry: registry(),
  workspaceId: "owner/game",
  buildSha: BUILD_SHA,
  rubricHash: RUBRIC_HASH,
  measurementVersion: "measurement-v2",
  generatedAt: "2026-10-12T00:00:00.000Z",
  scenarioId: "tutorial",
  scenarioFamily: "tutorial",
  cohort: "novice",
  policy: "fixture-heuristic",
  modality: "headless" as const
};

test("game.outcome wire contract carries typed, unique, bounded evaluator facts", () => {
  const params = { episodeId: "episode-1", expectedRevision: 2 };
  const base = {
    episodeId: "episode-1",
    revision: 2,
    state: "terminal",
    outcome: { kind: "win" },
    metrics: { score: 12 },
    evaluations: [evaluation()],
    missingReasons: []
  };
  assert.doesNotThrow(() =>
    assertPlaytestAdapterResult("game.outcome", params, base)
  );
  assert.throws(
    () =>
      assertPlaytestAdapterResult("game.outcome", params, {
        ...base,
        evaluations: undefined
      }),
    /must be a bounded array/u
  );
  assert.throws(
    () =>
      assertPlaytestAdapterResult("game.outcome", params, {
        ...base,
        evaluations: [evaluation(), evaluation()]
      }),
    /unique metric\/phase pairs/u
  );
  assert.throws(
    () =>
      assertPlaytestAdapterResult("game.outcome", params, {
        ...base,
        evaluations: [evaluation({ opportunityCount: 3 })]
      }),
    /counts are inconsistent/u
  );
});

test("adapter sufficient statistics normalize against frozen metric version, code hash, unit and provenance", () => {
  const [result] = normalizeGameMetricEvaluations({
    ...context,
    evaluations: [evaluation()]
  });
  assert.ok(result);
  assert.equal(result.metricId, "fixture-rate");
  assert.equal(result.metricVersion, 3);
  assert.equal(result.numerator, 2);
  assert.equal(result.denominator, 4);
  assert.equal(result.opportunityCount, 5);
  assert.equal(result.estimate, 0.5);
  assert.equal(result.coverage, 0.8);
  assert.equal(result.missing, 1);
  assert.equal(result.unit, "proportion");
  assert.deepEqual(result.provenance, {
    workspaceId: "owner/game",
    buildSha: BUILD_SHA,
    evaluatorHash: EVALUATOR_HASH,
    rubricHash: RUBRIC_HASH,
    measurementVersion: "measurement-v2",
    generatedAt: "2026-10-12T00:00:00.000Z"
  });
});

test("phase-window metrics require and preserve a separate evaluation for every frozen phase", () => {
  const base = context.registry;
  const firstCell = base.coverageRequirements[0]!;
  const phaseRegistry = expandPlaytestRegistry({
    schemaVersion: 2,
    workspaceId: base.workspaceId,
    audience: base.audience,
    registryVersion: base.registryVersion,
    eventSchemaHash: base.eventSchemaHash,
    defaults: base.defaults,
    metricDefinitions: base.metricDefinitions,
    coverageRequirements: [firstCell, { ...firstCell, phaseId: "final-phase" }],
    dimensionRubrics: []
  });
  const results = normalizeGameMetricEvaluations({
    ...context,
    registry: phaseRegistry,
    evaluations: [
      evaluation(),
      evaluation({ phaseId: "final-phase", numerator: 1, denominator: 2 })
    ]
  });
  assert.deepEqual(
    results.map((result) => result.phaseId),
    ["tutorial-phase", "final-phase"]
  );
  assert.doesNotThrow(() => assertPlaytestNumericResults(results));
  assert.throws(
    () => assertPlaytestNumericResults([...results, results[0]!]),
    /unique metric\/phase pairs/u
  );
  assert.throws(
    () =>
      normalizeGameMetricEvaluations({
        ...context,
        registry: phaseRegistry,
        evaluations: [evaluation()]
      }),
    /omitted required evaluator output/u
  );
});

test("whole-episode metrics use a null phase and retain normal evaluator validation", () => {
  const wholeEpisodeRegistry = registry({
    aggregationWindow: "whole-episode"
  });
  const [result] = normalizeGameMetricEvaluations({
    ...context,
    registry: wholeEpisodeRegistry,
    evaluations: [evaluation({ phaseId: null })]
  });
  assert.equal(result?.phaseId, null);
  assert.equal(result?.estimate, 0.5);
});

test("omitting an eligible evaluator output fails closed instead of imputing zero", () => {
  assert.throws(
    () => normalizeGameMetricEvaluations({ ...context, evaluations: [] }),
    /omitted required evaluator output/u
  );
});

test("an explicitly unsupported target evaluator is null with a named reason", () => {
  const [result] = normalizeGameMetricEvaluations({
    ...context,
    evaluations: [
      evaluation({
        numerator: 0,
        denominator: 0,
        opportunityCount: 0,
        missing: 0,
        independentUnits: 0,
        missingReasons: ["unsupported-evaluator"]
      })
    ]
  });
  assert.ok(result);
  assert.equal(result.estimate, null);
  assert.deepEqual(result.missingReasons, [
    "unsupported-evaluator",
    "unobserved"
  ]);
});

test("human metrics are excluded from gameplay episodes and out-of-scope modalities remain null", () => {
  const humanRegistry = registry({ modality: "human-post-play" });
  assert.deepEqual(
    normalizeGameMetricEvaluations({
      ...context,
      registry: humanRegistry,
      evaluations: []
    }),
    []
  );
  const browserRegistry = registry({ modality: "browser" });
  const [browser] = normalizeGameMetricEvaluations({
    ...context,
    registry: browserRegistry,
    evaluations: []
  });
  assert.equal(browser?.estimate, null);
  assert.deepEqual(browser?.missingReasons, ["unsupported-modality"]);
});

test("unknown, duplicate, unregistered and mismatched game evaluator outputs fail closed", () => {
  assert.throws(
    () =>
      normalizeGameMetricEvaluations({
        ...context,
        evaluations: [evaluation({ evaluatorHash: "1".repeat(64) })]
      }),
    /code hash/u
  );
  assert.throws(
    () =>
      normalizeGameMetricEvaluations({
        ...context,
        evaluations: [evaluation({ evaluatorRef: "another/ref" })]
      }),
    /reference, version, code hash, or unit/u
  );
  assert.throws(
    () =>
      normalizeGameMetricEvaluations({
        ...context,
        evaluations: [evaluation({ metricVersion: 2 })]
      }),
    /reference, version, code hash, or unit/u
  );
  assert.throws(
    () =>
      normalizeGameMetricEvaluations({
        ...context,
        evaluations: [evaluation({ unit: "points" })]
      }),
    /reference, version, code hash, or unit/u
  );
  assert.throws(
    () =>
      normalizeGameMetricEvaluations({
        ...context,
        evaluations: [evaluation(), evaluation()]
      }),
    /duplicate metric\/phase/u
  );
  assert.throws(
    () =>
      normalizeGameMetricEvaluations({
        ...context,
        evaluations: [evaluation({ opportunityCount: 3 })]
      }),
    /inconsistent sufficient statistics/u
  );
  assert.throws(
    () =>
      normalizeGameMetricEvaluations({
        ...context,
        evaluations: [evaluation({ numerator: 5 })]
      }),
    /inconsistent sufficient statistics/u
  );
});

test("scenario eligibility and evaluator evidence remain separate", () => {
  assert.deepEqual(
    normalizeGameMetricEvaluations({
      ...context,
      scenarioId: "arena",
      evaluations: []
    }),
    []
  );
});
