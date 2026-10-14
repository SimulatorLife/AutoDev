/**
 * Cohort mix-shift derivation over real runs (§10/§11).
 *
 * The central rule under test is the refusal. The standardizer's validator
 * demands the observed cohort set be exactly the benchmark's weighted cohort
 * set, and the tempting way to satisfy that is to fill a gap with zeros. Zeros
 * say "we looked and observed nothing"; an absent cohort says "we never
 * looked". These tests pin the refusal so the padding cannot come back quietly.
 *
 * The behavioural oracle is §10's own worked example, tabulated in the
 * measurement contract: builds A/B/C with fixed easy/hard weights of 50/50 and
 * deliberately different sample mixes. Reproducing those exact numbers is
 * stronger evidence than invented ones, because a drift in the weighting would
 * have to disagree with the contract to pass.
 *
 * Every fixture is validated by the canonical Core assertion as it is built
 * (`assertPlaytestNumericResults`, `assertPlaytestBenchmark`). That is
 * deliberate: an earlier hand-written fixture passed this file's behavioural
 * assertions while carrying rows no real run could produce -- provenance with
 * no evaluator or rubric hash, and `coverage`/`estimate` that did not
 * reconcile with the counts. A fixture the canonical validator rejects makes
 * every assertion about it vacuous, so the fixture now has to be real before
 * any test can run.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  assertPlaytestBenchmark,
  assertPlaytestNumericResults,
  type PlaytestBatch,
  type PlaytestBenchmark,
  playtestBenchmarkHashInput,
  type PlaytestEpisode,
  type PlaytestNumericResult,
  PLAYTESTS_BATCH_SCHEMA,
  PLAYTESTS_EPISODE_SCHEMA
} from "@simulatorlife/autodev-core";

import {
  RUN_SET_BUILD_ID,
  standardizePlaytestCohorts
} from "../src/playtesting/cohort-standardization-run.ts";

const WORKSPACE_ID = "owner/mix-shift";
const EVALUATOR_HASH = "9".repeat(64);
const RUBRIC_HASH = "3".repeat(64);
/** §10 names these cohorts "easy"/"hard" with a 50/50 fixed weight. */
const EASY = "easy";
const HARD = "hard";

function closeTo(actual: number, expected: number): void {
  assert.equal(
    typeof actual === "number" && Math.abs(actual - expected) < 1e-12,
    true,
    `expected ${String(actual)} to equal ${String(expected)}`
  );
}

/**
 * A metric row whose derived fields agree with its counts.
 *
 * `estimate`, `coverage` and `opportunityCount` are computed from the resolved
 * counts rather than hand-written, which is both what a real producer does and
 * what keeps an override from quietly producing an incoherent row. The
 * canonical assertion runs last, so an impossible row fails here, loudly, with
 * Core's own message.
 */
function metricRow(
  overrides: Partial<PlaytestNumericResult> = {}
): PlaytestNumericResult {
  const numerator = overrides.numerator ?? 3;
  const denominator = overrides.denominator ?? 4;
  const missing = overrides.missing ?? 1;
  const opportunityCount = overrides.opportunityCount ?? denominator + missing;

  const row: PlaytestNumericResult = {
    metricId: "task-completion",
    metricVersion: 1,
    phaseId: "tutorial",
    numerator,
    denominator,
    opportunityCount,
    coverage: opportunityCount === 0 ? 0 : denominator / opportunityCount,
    unit: "proportion",
    estimate: denominator === 0 ? null : numerator / denominator,
    missing,
    missingReasons: missing > 0 ? ["outside-window"] : [],
    independentUnits: 1,
    provenance: {
      workspaceId: WORKSPACE_ID,
      buildSha: "a".repeat(40),
      evaluatorHash: EVALUATOR_HASH,
      rubricHash: RUBRIC_HASH,
      measurementVersion: "playtesting-measurement-v2",
      generatedAt: "2026-10-12T00:00:00.000Z"
    },
    notes: "fixture",
    ...overrides
  };
  assertPlaytestNumericResults([row]);
  return row;
}

function episode(
  episodeId: string,
  policyCohort: string,
  buildSha: string,
  rows: readonly PlaytestNumericResult[]
): PlaytestEpisode {
  // The same reason the rows validate individually: an episode carrying rows
  // Core would reject is not the shape the aggregator ever sees in production.
  assertPlaytestNumericResults(rows);
  return {
    schema: PLAYTESTS_EPISODE_SCHEMA,
    episodeId,
    revision: 1,
    batchId: `batch-${buildSha}`,
    assignmentId: `assignment-${episodeId}`,
    branchLineage: null,
    identity: {
      workspaceId: WORKSPACE_ID,
      repository: WORKSPACE_ID,
      buildSha,
      gameBuild: "fixture-build-1",
      scenarioId: "tutorial",
      configHash: "b".repeat(64),
      seed: `seed-${episodeId}`,
      rngInitialStateHash: null,
      rngAlgorithm: null,
      rngVersion: null,
      policyId: "random",
      policyVersion: "hmac-sha256-v1",
      modelId: null,
      modelRevision: null,
      observationSchemaHash: "c".repeat(64),
      actionSchemaHash: "d".repeat(64),
      eventSchemaHash: "e".repeat(64),
      protocolVersion: 1,
      runtimeVersion: "1.0.0",
      environmentHash: "f".repeat(64)
    },
    scenarioFamily: "onboarding",
    policyCohort,
    strategy: "fixture",
    status: "completed",
    outcome: "completed",
    outcomeMetrics: {},
    completionCounts: {
      assigned: 1,
      started: 1,
      completed: 1,
      crashed: 0,
      infrastructureFailed: 0,
      cancelled: 0,
      budgetTruncated: 0,
      reviewed: 0,
      eligible: 1
    },
    replayStatus: { status: "not-requested" },
    trace: null,
    frames: [],
    stepCount: 10,
    metrics: [...rows],
    findingIds: [],
    assignedAt: "2026-10-12T00:00:00.000Z",
    startedAt: "2026-10-12T00:00:00.000Z",
    completedAt: "2026-10-12T00:00:01.000Z",
    simulationWallMs: null,
    logicalTicks: null,
    policyInferenceMs: null,
    nativeDurationMs: null,
    completeness: "complete",
    missingReasons: []
  } as unknown as PlaytestEpisode;
}

function benchmark(cohortWeights: Record<string, number>): PlaytestBenchmark {
  const withoutHash = {
    benchmarkId: "benchmark-mix-shift",
    version: 1,
    workspaceId: WORKSPACE_ID,
    referenceBuildSha: "a".repeat(40),
    scenarioInventory: [
      { scenarioId: "tutorial", family: "onboarding", weight: 1 }
    ],
    seedInventory: [{ seed: "seed-a", purpose: "discovery" as const }],
    policyVersions: { random: "hmac-sha256-v1" },
    competenceReportRefs: [],
    memoryResetRules: "One isolated episode; no shared learning memory.",
    engineEnvironmentHash: "1".repeat(64),
    actionSchemaHash: "d".repeat(64),
    observationSchemaHash: "c".repeat(64),
    eventSchemaHash: "e".repeat(64),
    metricRegistryHash: "2".repeat(64),
    rubricHash: RUBRIC_HASH,
    captureMode: "headless" as const,
    measurementVersion: "playtesting-measurement-v2",
    primaryMetricIds: ["task-completion"],
    guardrailMetricIds: [],
    practicalMargins: { "task-completion": 0.02 },
    independentUnit: "episode" as const,
    precisionPlanRef: "fixture-descriptive-only",
    missingnessBound: 0.1,
    refreshPolicy: "manual operator review only",
    createdAt: "2026-10-10T00:00:00.000Z",
    createdBy: "fixture-operator",
    cohortWeights
  };
  // A real content hash, not a placeholder: the standardizer checks the
  // benchmark's own hash, so a fake one would let every other assertion in
  // this file pass against an artifact the canonical validator rejects.
  return {
    ...withoutHash,
    contentHash: createHash("sha256")
      .update(playtestBenchmarkHashInput(withoutHash))
      .digest("hex")
  } as PlaytestBenchmark;
}

function batch(buildSha: string, cohortIds: readonly string[]): PlaytestBatch {
  return {
    schema: PLAYTESTS_BATCH_SCHEMA,
    batchId: `batch-${buildSha}`,
    revision: 1,
    workspaceId: WORKSPACE_ID,
    repository: WORKSPACE_ID,
    buildSha,
    gameBuild: "fixture-build-1",
    configHash: "b".repeat(64),
    rubricHash: RUBRIC_HASH,
    actionSchemaHash: "d".repeat(64),
    observationSchemaHash: "c".repeat(64),
    eventSchemaHash: "e".repeat(64),
    measurementVersion: "playtesting-measurement-v2",
    protocolVersion: 1,
    policyIds: ["random"],
    cohortIds,
    scenarioIds: ["tutorial"],
    // The only honest inventory for a batch with no manifest: it records that
    // the inventory was unavailable, rather than claiming an empty one.
    assignmentInventory: {
      status: "unavailable",
      reason: "recorded-before-assignment-manifests"
    },
    coverageManifest: null,
    unobservedAssignments: [],
    reviewPackets: [],
    reviewSelection: { status: "pending" },
    reviewReceipts: [],
    status: "completed",
    cancellationReason: null,
    failureReason: null,
    counts: {
      assigned: 2,
      started: 2,
      completed: 2,
      crashed: 0,
      infrastructureFailed: 0,
      cancelled: 0,
      budgetTruncated: 0,
      reviewed: 0,
      eligible: 2
    },
    budget: {
      assignedEpisodes: 2,
      maxStepsPerEpisode: 20,
      wallTimeMs: 60_000,
      critiqueBudget: 4,
      actualCritiques: 0
    },
    startedAt: "2026-10-12T00:00:00.000Z",
    completedAt: "2026-10-12T00:00:02.000Z",
    createdAt: "2026-10-12T00:00:00.000Z",
    provenance: {
      workspaceId: WORKSPACE_ID,
      buildSha,
      measurementVersion: "playtesting-measurement-v2",
      generatedAt: "2026-10-12T00:00:00.000Z"
    },
    evaluationIds: [],
    spanIds: []
  } as unknown as PlaytestBatch;
}

/** One measured build: its batch plus one episode per cohort it exercised. */
function run(
  buildSha: string,
  cohortRows: Readonly<Record<string, readonly PlaytestNumericResult[]>>
) {
  const cohortIds = Object.keys(cohortRows).sort();
  return {
    batch: batch(buildSha, cohortIds),
    episodes: cohortIds.map((cohort) =>
      episode(`ep-${buildSha}-${cohort}`, cohort, buildSha, cohortRows[cohort]!)
    )
  };
}

const BUILD_A = "a".repeat(40);
const BUILD_B = "b".repeat(40);
const BUILD_C = "c".repeat(40);

test("reproduces §10's worked example: three builds with changing cohort mix", () => {
  // §11 names "three-build changing cohort mix" as a required fixture, and §10
  // tabulates the expected fixed-weight and raw numbers for each build.
  const outcome = standardizePlaytestCohorts({
    benchmark: benchmark({ [EASY]: 0.5, [HARD]: 0.5 }),
    metricId: "task-completion",
    runs: [
      // A: rates 90%/50%, sample mix 50/50. Missingness is added here only to
      // exercise source coverage; it cannot move a rate.
      run(BUILD_A, {
        [EASY]: [metricRow({ numerator: 9, denominator: 10, missing: 4 })],
        [HARD]: [metricRow({ numerator: 5, denominator: 10, missing: 6 })]
      }),
      // B: rates 90%/40%, sample mix 90/10.
      run(BUILD_B, {
        [EASY]: [metricRow({ numerator: 81, denominator: 90, missing: 0 })],
        [HARD]: [metricRow({ numerator: 4, denominator: 10, missing: 0 })]
      }),
      // C: rates 90%/50%, sample mix 90/10.
      run(BUILD_C, {
        [EASY]: [metricRow({ numerator: 81, denominator: 90, missing: 0 })],
        [HARD]: [metricRow({ numerator: 5, denominator: 10, missing: 0 })]
      })
    ]
  });

  assert.deepEqual(outcome.refusals, []);
  assert.equal(outcome.result !== null, true);
  const builds = outcome.result!.builds;
  assert.deepEqual(
    builds.map((build) => build.buildId),
    [BUILD_A, BUILD_B, BUILD_C]
  );

  for (const build of builds) {
    assert.equal(build.standardizationState, "standardized");
    assert.equal(build.rawObservedState, "observed");
  }

  const bySha = new Map(builds.map((build) => [build.buildId, build]));
  const a = bySha.get(BUILD_A)!;
  closeTo(a.standardizedRate ?? Number.NaN, 0.7);
  closeTo(a.rawObservedRate ?? Number.NaN, 0.7);

  const b = bySha.get(BUILD_B)!;
  // The §10 finding: the raw number rises while the fixed-weight number falls.
  closeTo(b.standardizedRate ?? Number.NaN, 0.65);
  closeTo(b.rawObservedRate ?? Number.NaN, 0.85);
  assert.equal(
    (b.rawObservedRate ?? 0) > (a.rawObservedRate ?? 0),
    true,
    "B's raw rate must look like a gain over A, which is what makes it misleading"
  );
  assert.equal(
    (b.standardizedRate ?? 0) < (a.standardizedRate ?? 0),
    true,
    "B's fixed-weight rate must show the regression the raw rate hides"
  );

  const c = bySha.get(BUILD_C)!;
  closeTo(c.standardizedRate ?? Number.NaN, 0.7);
  closeTo(c.rawObservedRate ?? Number.NaN, 0.86);

  // The two rates are reported separately, and the comparison between the two
  // is what carries the finding. A's rates coincide because its sample mix
  // equals the benchmark weights -- exactly why §10 lists it at "70% | 70%" --
  // while B and C diverge. A composite would erase that difference.
  assert.equal(a.standardizedRate === a.rawObservedRate, true);
  assert.equal(b.standardizedRate !== b.rawObservedRate, true);
  assert.equal(c.standardizedRate !== c.rawObservedRate, true);

  // Missingness never became a rate, but it is still reported: A observed 20
  // of 30 eligible opportunities.
  closeTo(a.sourceCoverage ?? Number.NaN, 20 / 30);
  assert.equal(a.totalObserved, 20);
  assert.equal(a.totalMissing, 10);
  closeTo(b.sourceCoverage ?? Number.NaN, 1);
});

test("per-cohort counts are summed from the metric rows each episode recorded", () => {
  const outcome = standardizePlaytestCohorts({
    benchmark: benchmark({ [EASY]: 0.5, [HARD]: 0.5 }),
    metricId: "task-completion",
    runs: [
      run(BUILD_A, {
        [EASY]: [
          metricRow({ numerator: 3, denominator: 4, missing: 1 }),
          // A second phase on the same episode: an episode may not carry two
          // rows for one metric/phase pair, but it may carry two phases.
          metricRow({
            phaseId: "beta",
            numerator: 5,
            denominator: 6,
            missing: 0
          })
        ],
        [HARD]: [metricRow({ numerator: 1, denominator: 2, missing: 2 })]
      }),
      run(BUILD_B, {
        [EASY]: [metricRow({ numerator: 1, denominator: 2, missing: 0 })],
        [HARD]: [metricRow({ numerator: 1, denominator: 1, missing: 0 })]
      })
    ]
  });

  assert.deepEqual(outcome.refusals, []);
  assert.deepEqual(outcome.buildObservations[BUILD_A], {
    [EASY]: { numerator: 8, denominator: 10, missing: 1 },
    [HARD]: { numerator: 1, denominator: 2, missing: 2 }
  });
  // One episode per cohort, even though easy recorded two phases: the count
  // is episodes that contributed a row, not rows.
  assert.equal(outcome.contributingEpisodesByBuild[BUILD_A], 2);
  assert.equal(outcome.skippedRowsByBuild[BUILD_A], 0);
});

test("two runs of the same build aggregate into one build, not two", () => {
  // Counts are additive and one build measured across two batches is a build,
  // not a duplicate; Core also rejects a repeated buildId outright.
  const outcome = standardizePlaytestCohorts({
    benchmark: benchmark({ [EASY]: 0.5, [HARD]: 0.5 }),
    metricId: "task-completion",
    runs: [
      run(BUILD_A, {
        [EASY]: [metricRow({ numerator: 9, denominator: 10, missing: 0 })],
        [HARD]: [metricRow({ numerator: 5, denominator: 10, missing: 0 })]
      }),
      run(BUILD_A, {
        [EASY]: [metricRow({ numerator: 1, denominator: 10, missing: 0 })],
        [HARD]: [metricRow({ numerator: 0, denominator: 10, missing: 0 })]
      }),
      run(BUILD_B, {
        [EASY]: [metricRow({ numerator: 5, denominator: 10, missing: 0 })],
        [HARD]: [metricRow({ numerator: 2, denominator: 10, missing: 0 })]
      })
    ]
  });

  assert.deepEqual(outcome.refusals, []);
  assert.deepEqual(Object.keys(outcome.buildObservations), [BUILD_A, BUILD_B]);
  // A's two batches summed: 10/20 on easy, 5/20 on hard.
  assert.deepEqual(outcome.buildObservations[BUILD_A], {
    [EASY]: { numerator: 10, denominator: 20, missing: 0 },
    [HARD]: { numerator: 5, denominator: 20, missing: 0 }
  });
  assert.equal(outcome.contributingEpisodesByBuild[BUILD_A], 4);
  assert.equal(outcome.result!.builds.length, 2);
});

test("a weighted cohort a build never observed refuses instead of being padded", () => {
  // Core requires every weighted cohort, and zeros would satisfy it while
  // claiming the run looked and observed nothing.
  const outcome = standardizePlaytestCohorts({
    benchmark: benchmark({ [EASY]: 0.5, [HARD]: 0.5 }),
    metricId: "task-completion",
    runs: [
      run(BUILD_A, {
        [EASY]: [metricRow({ numerator: 9, denominator: 10, missing: 0 })]
      }),
      run(BUILD_B, {
        [EASY]: [metricRow({ numerator: 5, denominator: 10, missing: 0 })],
        [HARD]: [metricRow({ numerator: 5, denominator: 10, missing: 0 })]
      })
    ]
  });

  assert.equal(outcome.result, null);
  assert.deepEqual(outcome.refusals, [
    {
      buildId: BUILD_A,
      reason: "cohort-set-mismatch",
      unobservedCohorts: [HARD],
      unweightedCohorts: []
    }
  ]);
  // What was observed is still returned, so the caller can see the basis.
  assert.deepEqual(outcome.buildObservations[BUILD_A], {
    [EASY]: { numerator: 9, denominator: 10, missing: 0 }
  });
});

test("a cohort observed but not weighted by the benchmark is named, not dropped", () => {
  // Core throws on an undeclared cohort key, so without an explicit refusal
  // here this would escape as a validator TypeError instead of a reportable
  // outcome. The observation is real and must be named, not discarded.
  const outcome = standardizePlaytestCohorts({
    benchmark: benchmark({ [EASY]: 0.5, [HARD]: 0.5 }),
    metricId: "task-completion",
    runs: [
      run(BUILD_A, {
        [EASY]: [metricRow({ numerator: 9, denominator: 10, missing: 0 })],
        [HARD]: [metricRow({ numerator: 5, denominator: 10, missing: 0 })]
      }),
      run(BUILD_B, {
        [EASY]: [metricRow({ numerator: 5, denominator: 10, missing: 0 })],
        [HARD]: [metricRow({ numerator: 5, denominator: 10, missing: 0 })],
        veteran: [metricRow({ numerator: 5, denominator: 10, missing: 0 })]
      })
    ]
  });

  assert.equal(outcome.result, null);
  assert.deepEqual(outcome.refusals, [
    {
      buildId: BUILD_B,
      reason: "cohort-set-mismatch",
      unobservedCohorts: [],
      unweightedCohorts: ["veteran"]
    }
  ]);
  // The unweighted observation survives in the returned basis.
  assert.deepEqual(Object.keys(outcome.buildObservations[BUILD_B]!), [
    EASY,
    HARD,
    "veteran"
  ]);
});

test("one build alone cannot show a mix shift", () => {
  const outcome = standardizePlaytestCohorts({
    benchmark: benchmark({ [EASY]: 0.5, [HARD]: 0.5 }),
    metricId: "task-completion",
    runs: [
      run(BUILD_A, {
        [EASY]: [metricRow({ numerator: 9, denominator: 10, missing: 0 })],
        [HARD]: [metricRow({ numerator: 5, denominator: 10, missing: 0 })]
      })
    ]
  });

  assert.equal(outcome.result, null);
  assert.deepEqual(outcome.refusals, [
    {
      buildId: RUN_SET_BUILD_ID,
      reason: "insufficient-builds",
      unobservedCohorts: [],
      unweightedCohorts: []
    }
  ]);
});

test("rows for other metrics and other metric versions are not aggregated", () => {
  // Distinct phases, because an episode may not carry two rows for the same
  // metric/phase pair -- that constraint is enforced, not assumed.
  const outcome = standardizePlaytestCohorts({
    benchmark: benchmark({ [EASY]: 0.5, [HARD]: 0.5 }),
    metricId: "task-completion",
    metricVersion: 1,
    runs: [
      run(BUILD_A, {
        [EASY]: [
          metricRow({
            metricId: "crash-rate",
            numerator: 99,
            denominator: 99
          }),
          metricRow({
            metricVersion: 2,
            phaseId: "beta",
            numerator: 50,
            denominator: 100
          }),
          metricRow({ numerator: 9, denominator: 10, missing: 0 })
        ],
        [HARD]: [metricRow({ numerator: 5, denominator: 10, missing: 0 })]
      }),
      run(BUILD_B, {
        [EASY]: [metricRow({ numerator: 5, denominator: 10, missing: 0 })],
        [HARD]: [metricRow({ numerator: 5, denominator: 10, missing: 0 })]
      })
    ]
  });

  assert.deepEqual(outcome.refusals, []);
  assert.deepEqual(outcome.buildObservations[BUILD_A], {
    [EASY]: { numerator: 9, denominator: 10, missing: 0 },
    [HARD]: { numerator: 5, denominator: 10, missing: 0 }
  });
  // Both foreign rows are counted as skipped rather than silently dropped:
  // had either been aggregated, easy's numerator would not be 9.
  assert.equal(outcome.skippedRowsByBuild[BUILD_A], 2);
  assert.equal(outcome.contributingEpisodesByBuild[BUILD_A], 2);
  assert.equal(outcome.skippedRowsByBuild[BUILD_B], 0);
});

test("a run with no rows for the metric reports no cohorts rather than zeros", () => {
  const outcome = standardizePlaytestCohorts({
    benchmark: benchmark({ [EASY]: 0.5, [HARD]: 0.5 }),
    metricId: "task-completion",
    runs: [
      run(BUILD_A, {
        [EASY]: [metricRow({ metricId: "other-metric" })]
      }),
      run(BUILD_B, {
        [EASY]: [metricRow({ numerator: 5, denominator: 10, missing: 0 })],
        [HARD]: [metricRow({ numerator: 5, denominator: 10, missing: 0 })]
      })
    ]
  });

  assert.equal(outcome.result, null);
  assert.deepEqual(outcome.buildObservations[BUILD_A], {});
  assert.equal(outcome.contributingEpisodesByBuild[BUILD_A], 0);
  assert.deepEqual(outcome.refusals, [
    {
      buildId: BUILD_A,
      reason: "cohort-set-mismatch",
      unobservedCohorts: [EASY, HARD],
      unweightedCohorts: []
    }
  ]);
});

test("the fixtures are real artifacts, so the assertions above are not vacuous", () => {
  // Guards the fixture itself: rows and benchmarks the canonical validators
  // reject would make every other assertion in this file meaningless.
  assert.doesNotThrow(() => metricRow());
  assert.doesNotThrow(() =>
    assertPlaytestBenchmark(benchmark({ [EASY]: 0.5, [HARD]: 0.5 }))
  );
  assert.throws(() =>
    assertPlaytestBenchmark(benchmark({ [EASY]: 0.5, [HARD]: 0.5, missing: 0 }))
  );
  // The exposure statistics must reconcile with the counts; a row whose
  // coverage disagrees is one no real run could produce.
  assert.throws(() => metricRow({ coverage: 0.99 }));
  assert.throws(() => metricRow({ estimate: 0.1 }));
  assert.throws(() => metricRow({ opportunityCount: 2 }));
  assert.throws(() =>
    metricRow({ numerator: 3, denominator: 4, missing: 9, opportunityCount: 5 })
  );
});
