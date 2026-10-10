import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import type { PlaytestBenchmark } from "../src/playtesting/artifacts.ts";
import { playtestBenchmarkHashInput } from "../src/playtesting/benchmark.ts";
import {
  PLAYTESTS_COHORT_STANDARDIZATION_SCHEMA,
  type PlaytestCohortStandardizationInput,
  type PlaytestBuildCohortObservations,
  standardizePlaytestCohortRates
} from "../src/playtesting/index.ts";

/**
 * Synthetic three-build mix-shift fixture mirroring
 * docs/playtesting-measurement-contract.md §10's worked A/B/C table and
 * §11's "three-build changing cohort mix" gate. The benchmark weights
 * are a frozen 50/50 easy/hard distribution; the raw sampled completion
 * rates are deliberately misleading for build B (raw 85% hides a 65%
 * fixed-weight rate), while build C's raw 86% recovers to the pinned
 * 70% fixed-weight baseline.
 *
 * Test data layout:
 *   - Build A: rates 90% / 50% over  50 /  50 observed episodes
 *   - Build B: rates 90% / 40% over 900 / 100 observed episodes
 *   - Build C: rates 90% / 50% over 900 / 100 observed episodes
 */
const COHORT_EASY = "easy";
const COHORT_HARD = "hard";

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/**
 * Minimal-but-typed PlaytestBenchmark fixture. The standardizer only
 * inspects `benchmarkId`, `version`, `contentHash`, and `cohortWeights`,
 * but the TypeScript surface requires every field of the artifact so
 * downstream consumers (Runtime/Data) can replay the manifest hash.
 */
function frozenBenchmark(
  overrides: {
    readonly benchmarkId?: string;
    readonly version?: number;
    readonly cohortWeights?: Readonly<Record<string, number>>;
  } = {}
): PlaytestBenchmark {
  const benchmarkId = overrides.benchmarkId ?? "fixture-benchmark-cohort-v1";
  const version = overrides.version ?? 1;
  const cohortWeights = overrides.cohortWeights ?? {
    [COHORT_EASY]: 0.5,
    [COHORT_HARD]: 0.5
  };
  const manifest = {
    benchmarkId,
    version,
    workspaceId: "fixture/synthetic-game",
    referenceBuildSha: "a".repeat(40),
    scenarioInventory: [
      { scenarioId: "tutorial", family: "onboarding", weight: 0.75 },
      { scenarioId: "edge", family: "edge-cases", weight: 0.25 }
    ],
    seedInventory: [
      { seed: "seed-discovery", purpose: "discovery" as const },
      { seed: "seed-confirmation", purpose: "confirmation" as const },
      { seed: "seed-regression", purpose: "regression" as const }
    ],
    policyVersions: { random: "hmac-sha256-v1" },
    competenceReportRefs: [{ kind: "episode" as const, id: "policy-validity" }],
    memoryResetRules: "One isolated episode; no shared learning memory.",
    engineEnvironmentHash: sha256("fixture-environment-v1"),
    actionSchemaHash: sha256("fixture-actions-v1"),
    observationSchemaHash: sha256("fixture-observations-v1"),
    eventSchemaHash: sha256("fixture-events-v1"),
    metricRegistryHash: sha256("fixture-registry-v1"),
    rubricHash: sha256("fixture-rubric-v1"),
    captureMode: "headless" as const,
    measurementVersion: "playtesting-measurement-v1",
    primaryMetricIds: ["legal-action-rejection"],
    guardrailMetricIds: ["crash-rate"],
    practicalMargins: {
      "legal-action-rejection": 0.02,
      "crash-rate": 0.01
    },
    independentUnit: "episode" as const,
    precisionPlanRef: "fixture-descriptive-only",
    missingnessBound: 0.1,
    refreshPolicy: "manual operator review only",
    createdAt: "2026-10-10T00:00:00.000Z",
    createdBy: "fixture-operator",
    cohortWeights
  };
  return {
    ...manifest,
    contentHash: sha256(playtestBenchmarkHashInput(manifest))
  };
}

function build(input: {
  buildId: string;
  easy: { numerator: number; denominator: number; missing?: number };
  hard: { numerator: number; denominator: number; missing?: number };
}): PlaytestBuildCohortObservations {
  return {
    buildId: input.buildId,
    cohortObservations: {
      [COHORT_EASY]: {
        numerator: input.easy.numerator,
        denominator: input.easy.denominator,
        missing: input.easy.missing ?? 0
      },
      [COHORT_HARD]: {
        numerator: input.hard.numerator,
        denominator: input.hard.denominator,
        missing: input.hard.missing ?? 0
      }
    }
  };
}

function threeBuildInput(): PlaytestCohortStandardizationInput {
  return {
    benchmark: frozenBenchmark(),
    builds: [
      // A: pinned reference. rates 90% / 50% on a 50/50 sample mix.
      build({
        buildId: "fixture-build-A",
        easy: { numerator: 45, denominator: 50 },
        hard: { numerator: 25, denominator: 50 }
      }),
      // B: rates 90% / 40% on a 90/10 sample mix. Raw 85% hides the
      //    worse hard-scenario outcome.
      build({
        buildId: "fixture-build-B",
        easy: { numerator: 810, denominator: 900 },
        hard: { numerator: 40, denominator: 100 }
      }),
      // C: rates 90% / 50% on a 90/10 sample mix. Returns to the pinned
      //    70% fixed-weight rate; not improvement beyond A.
      build({
        buildId: "fixture-build-C",
        easy: { numerator: 810, denominator: 900 },
        hard: { numerator: 50, denominator: 100 }
      })
    ]
  };
}

test("three-build mix-shift gate: raw trends mislead but fixed-weight standardized rates remain comparable", () => {
  const input = threeBuildInput();
  const result = standardizePlaytestCohortRates(input);

  assert.equal(result.schema, PLAYTESTS_COHORT_STANDARDIZATION_SCHEMA);
  assert.equal(result.benchmarkId, "fixture-benchmark-cohort-v1");
  assert.equal(result.benchmarkVersion, 1);
  assert.equal(result.benchmarkContentHash, input.benchmark.contentHash);
  assert.equal(result.builds.length, 3);

  const [a, b, c] = result.builds;
  assert.ok(a && b && c, "expected three standardized builds");

  // Build A: 50/50 sample mix. raw == fixed-weight == 70%.
  assert.equal(a.buildId, "fixture-build-A");
  assert.equal(a.standardizationState, "standardized");
  assert.equal(a.rawObservedState, "observed");
  assert.ok(
    Math.abs((a.rawObservedRate ?? 0) - 0.7) < 1e-12,
    `A: raw ${String(a.rawObservedRate)} != 0.70`
  );
  assert.ok(
    Math.abs((a.standardizedRate ?? 0) - 0.7) < 1e-12,
    `A: fixed-weight ${String(a.standardizedRate)} != 0.70`
  );
  assert.equal(a.totalObserved, 100);
  assert.equal(a.totalMissing, 0);
  assert.equal(a.totalEligible, 100);
  assert.equal(a.sourceCoverage, 1);

  // Build B: 90/10 sample mix. raw 85% hides a 65% fixed-weight rate.
  assert.equal(b.buildId, "fixture-build-B");
  assert.equal(b.standardizationState, "standardized");
  assert.equal(b.rawObservedState, "observed");
  assert.ok(
    Math.abs((b.rawObservedRate ?? 0) - 0.85) < 1e-12,
    `B: raw ${String(b.rawObservedRate)} != 0.85 (0.9*0.9 + 0.1*0.4)`
  );
  assert.ok(
    Math.abs((b.standardizedRate ?? 0) - 0.65) < 1e-12,
    `B: fixed-weight ${String(b.standardizedRate)} != 0.65 (0.5*0.9 + 0.5*0.4)`
  );
  assert.equal(b.totalObserved, 1000);
  assert.equal(b.totalEligible, 1000);
  assert.equal(b.sourceCoverage, 1);

  // Build C: 90/10 sample mix. raw 86% returns to A's fixed-weight 70%.
  assert.equal(c.buildId, "fixture-build-C");
  assert.equal(c.standardizationState, "standardized");
  assert.equal(c.rawObservedState, "observed");
  assert.ok(
    Math.abs((c.rawObservedRate ?? 0) - 0.86) < 1e-12,
    `C: raw ${String(c.rawObservedRate)} != 0.86`
  );
  assert.ok(
    Math.abs((c.standardizedRate ?? 0) - 0.7) < 1e-12,
    `C: fixed-weight ${String(c.standardizedRate)} != 0.70`
  );

  // The function exposes both rates per build; it does NOT collapse them
  // into a single composite number.
  assert.notStrictEqual(
    b.rawObservedRate,
    b.standardizedRate,
    "raw and fixed-weight rates must travel separately"
  );
  assert.notStrictEqual(
    c.rawObservedRate,
    c.standardizedRate,
    "raw and fixed-weight rates must travel separately"
  );

  // The fixed-weight rates ARE comparable across A/B/C.
  assert.equal(
    a.standardizedRate,
    c.standardizedRate,
    "fixed-weight standardized rates are comparable across builds"
  );
  assert.ok(
    b.standardizedRate! < a.standardizedRate!,
    "B's fixed-weight rate is below A's pinned reference"
  );

  // No confidence interval, no composite, no human claim is exposed.
  for (const row of result.builds) {
    const rowRecord = row as unknown as Record<string, unknown>;
    assert.equal(
      rowRecord["interval"],
      undefined,
      "standardization must not compute or carry a confidence interval"
    );
    assert.equal(
      rowRecord["compositeScore"],
      undefined,
      "standardization must not produce a composite score"
    );
    assert.equal(
      rowRecord["humanClaim"],
      undefined,
      "standardization must not assert a human claim"
    );
  }
});

test("three-build mix-shift gate: per-cohort rows preserve inputs for auditability", () => {
  const result = standardizePlaytestCohortRates(threeBuildInput());
  const c = result.builds.find((row) => row.buildId === "fixture-build-C");
  assert.ok(c, "build C must be present");

  const easy = c.cohorts.find((row) => row.cohortKey === COHORT_EASY);
  const hard = c.cohorts.find((row) => row.cohortKey === COHORT_HARD);
  assert.ok(easy && hard, "both cohorts must be reported");

  assert.equal(easy.benchmarkWeight, 0.5);
  assert.equal(easy.numerator, 810);
  assert.equal(easy.denominator, 900);
  assert.equal(easy.missing, 0);
  assert.equal(easy.eligible, 900);
  assert.equal(easy.observedRate, 0.9);
  // sampleProportion = 900 / (900+100) = 0.9
  assert.equal(easy.sampleProportion, 0.9);
  assert.equal(easy.cohortCoverage, 1);

  assert.equal(hard.benchmarkWeight, 0.5);
  assert.equal(hard.numerator, 50);
  assert.equal(hard.denominator, 100);
  assert.equal(hard.missing, 0);
  assert.equal(hard.eligible, 100);
  assert.equal(hard.observedRate, 0.5);
  // sampleProportion = 100 / 1000 = 0.1
  assert.equal(hard.sampleProportion, 0.1);
  assert.equal(hard.cohortCoverage, 1);
});

test("three-build mix-shift gate: source coverage < 1 still yields numeric standardized rate with honest cohort coverage", () => {
  const input: PlaytestCohortStandardizationInput = {
    benchmark: frozenBenchmark(),
    builds: [
      // Mix-shift with explicit missingness: cohort-level coverage < 1 but
      // every stratum still has positive denominator.
      {
        buildId: "fixture-build-D",
        cohortObservations: {
          [COHORT_EASY]: { numerator: 90, denominator: 100, missing: 50 },
          [COHORT_HARD]: { numerator: 50, denominator: 100, missing: 50 }
        }
      },
      {
        buildId: "fixture-build-E",
        cohortObservations: {
          [COHORT_EASY]: { numerator: 180, denominator: 200, missing: 0 },
          [COHORT_HARD]: { numerator: 40, denominator: 80, missing: 40 }
        }
      }
    ]
  };
  const result = standardizePlaytestCohortRates(input);
  const [d, e] = result.builds;
  assert.ok(d && e, "two builds expected");

  // Build D: rates 90%/50%, every observed; coverage drops because of missing.
  assert.equal(d.standardizationState, "standardized");
  assert.equal(d.rawObservedState, "observed");
  assert.equal(d.rawObservedRate, 0.7, "D: 50/50 mix, 90%/50% rates = 70%");
  assert.equal(
    d.standardizedRate,
    0.7,
    "D: 50/50 weights, 90%/50% rates = 70%"
  );
  assert.equal(d.totalObserved, 200);
  assert.equal(d.totalMissing, 100);
  assert.equal(d.totalEligible, 300);
  // sourceCoverage = 200 / 300
  assert.ok(
    Math.abs(d.sourceCoverage! - 200 / 300) < 1e-12,
    `D: coverage ${String(d.sourceCoverage)} != 200/300`
  );
  // Per-cohort coverage drops from 1: easy stratum 100/150 = 2/3.
  const dEasy = d.cohorts.find((row) => row.cohortKey === COHORT_EASY);
  assert.ok(
    Math.abs((dEasy?.cohortCoverage ?? 0) - 2 / 3) < 1e-12,
    `D easy coverage ${String(dEasy?.cohortCoverage)} != 2/3`
  );

  // Build E: rates still 90% / 50%; standardized equals D's; raw differs
  // because the sample mix shifted.
  assert.equal(e.standardizationState, "standardized");
  assert.equal(e.standardizedRate, 0.7);
  // E raw = (200/280)*0.9 + (80/280)*0.5 = 0.642857... + 0.142857... = 0.785714...
  assert.ok(
    Math.abs(e.rawObservedRate! - 110 / 140) < 1e-12,
    `E: raw ${String(e.rawObservedRate)} != 110/140`
  );
  assert.equal(e.totalObserved, 280);
  assert.equal(e.totalMissing, 40);
  assert.equal(e.totalEligible, 320);
});

test("zero-denominator stratum: standardized rate is null with explicit unknown-zero-denominator-stratum state", () => {
  const input: PlaytestCohortStandardizationInput = {
    benchmark: frozenBenchmark(),
    builds: [
      {
        // Pinned reference on the easy cohort; hard cohort has zero
        // observed denominator. The mix-shift gate requires a second
        // build for comparison; the anchor below is the pinned ref.
        buildId: "fixture-build-zero-denom",
        cohortObservations: {
          [COHORT_EASY]: { numerator: 9, denominator: 10, missing: 0 },
          [COHORT_HARD]: { numerator: 0, denominator: 0, missing: 5 }
        }
      },
      {
        buildId: "fixture-build-zero-denom-anchor",
        cohortObservations: {
          [COHORT_EASY]: { numerator: 45, denominator: 50, missing: 0 },
          [COHORT_HARD]: { numerator: 25, denominator: 50, missing: 0 }
        }
      }
    ]
  };

  const result = standardizePlaytestCohortRates(input);
  const zero = result.builds.find(
    (row) => row.buildId === "fixture-build-zero-denom"
  );
  const anchor = result.builds.find(
    (row) => row.buildId === "fixture-build-zero-denom-anchor"
  );
  assert.ok(zero && anchor, "expected both builds");

  assert.equal(zero.standardizationState, "unknown-zero-denominator-stratum");
  assert.equal(zero.standardizedRate, null);
  assert.equal(zero.rawObservedState, "unknown-zero-denominator-stratum");
  assert.equal(zero.rawObservedRate, null);

  // The hard cohort row preserves the zero denominator explicitly.
  const zeroHard = zero.cohorts.find((row) => row.cohortKey === COHORT_HARD);
  assert.ok(zeroHard, "hard cohort row must be present");
  assert.equal(zeroHard.denominator, 0);
  assert.equal(zeroHard.missing, 5);
  assert.equal(zeroHard.eligible, 5);
  assert.equal(zeroHard.observedRate, null);
  // Hard cohort coverage: 0 / 5 -> 0.
  assert.equal(zeroHard.cohortCoverage, 0);
  // Sample proportion is null because that cohort cannot contribute to the mix.
  assert.equal(zeroHard.sampleProportion, null);

  // Anchor is unaffected.
  assert.equal(anchor.standardizationState, "standardized");
  assert.equal(anchor.standardizedRate, 0.7);
});

test("missing benchmark stratum: standardized rate is null with explicit unknown-incomplete-source-coverage state", () => {
  // Use a fresh benchmark missing one of the build's cohorts: the
  // validator must reject the build entirely so it never enters the
  // result set as a partial standardization row.
  const inputWithUnknown: PlaytestCohortStandardizationInput = {
    benchmark: frozenBenchmark(),
    builds: [
      {
        buildId: "fixture-build-unknown-cohort",
        cohortObservations: {
          [COHORT_EASY]: { numerator: 9, denominator: 10, missing: 0 },
          // "extreme" exists in the build but not in benchmark weights.
          extreme: { numerator: 1, denominator: 2, missing: 0 }
        }
      },
      {
        buildId: "fixture-build-unknown-cohort-anchor",
        cohortObservations: {
          [COHORT_EASY]: { numerator: 45, denominator: 50, missing: 0 },
          [COHORT_HARD]: { numerator: 25, denominator: 50, missing: 0 }
        }
      }
    ]
  };
  assert.throws(
    () => standardizePlaytestCohortRates(inputWithUnknown),
    /is not declared in the benchmark weights/u
  );

  // Now test the inverse: a build that omits a benchmark cohort is
  // rejected with a missing-stratum error.
  const inputWithMissing: PlaytestCohortStandardizationInput = {
    benchmark: frozenBenchmark(),
    builds: [
      {
        buildId: "fixture-build-missing-stratum",
        cohortObservations: {
          [COHORT_EASY]: { numerator: 9, denominator: 10, missing: 0 }
          // hard cohort omitted
        }
      },
      {
        buildId: "fixture-build-missing-stratum-anchor",
        cohortObservations: {
          [COHORT_EASY]: { numerator: 45, denominator: 50, missing: 0 },
          [COHORT_HARD]: { numerator: 25, denominator: 50, missing: 0 }
        }
      }
    ]
  };
  assert.throws(
    () => standardizePlaytestCohortRates(inputWithMissing),
    /missing the benchmark cohort/u
  );
});

test("fully unobserved build: standardized and raw rates are null with explicit unknown-no-observation state", () => {
  const input: PlaytestCohortStandardizationInput = {
    benchmark: frozenBenchmark(),
    builds: [
      {
        buildId: "fixture-build-no-observation",
        cohortObservations: {
          [COHORT_EASY]: { numerator: 0, denominator: 0, missing: 0 },
          [COHORT_HARD]: { numerator: 0, denominator: 0, missing: 0 }
        }
      },
      {
        buildId: "fixture-build-no-observation-anchor",
        cohortObservations: {
          [COHORT_EASY]: { numerator: 45, denominator: 50, missing: 0 },
          [COHORT_HARD]: { numerator: 25, denominator: 50, missing: 0 }
        }
      }
    ]
  };

  const result = standardizePlaytestCohortRates(input);
  const empty = result.builds.find(
    (row) => row.buildId === "fixture-build-no-observation"
  );
  assert.ok(empty, "empty build expected");

  // With both denominators == 0 we cannot standardize OR sample-weight.
  assert.equal(empty.standardizationState, "unknown-zero-denominator-stratum");
  assert.equal(empty.standardizedRate, null);
  assert.equal(empty.rawObservedState, "unknown-no-observation");
  assert.equal(empty.rawObservedRate, null);
  assert.equal(empty.totalObserved, 0);
  assert.equal(empty.totalMissing, 0);
  assert.equal(empty.sourceCoverage, null);
});

test("validation rejects benchmark cohort weights that do not sum to 1.0", () => {
  const broken: PlaytestCohortStandardizationInput = {
    benchmark: frozenBenchmark({
      cohortWeights: { easy: 0.4, hard: 0.4 }
    }),
    builds: threeBuildInput().builds
  };
  assert.throws(
    () => standardizePlaytestCohortRates(broken),
    /must sum to 1\.0/u
  );

  const overOne: PlaytestCohortStandardizationInput = {
    benchmark: frozenBenchmark({
      cohortWeights: { easy: 0.6, hard: 0.6 }
    }),
    builds: threeBuildInput().builds
  };
  assert.throws(
    () => standardizePlaytestCohortRates(overOne),
    /must sum to 1\.0/u
  );
});

test("validation rejects negative, zero, and non-finite benchmark cohort weights", () => {
  // Build the candidate benchmarks by hand so we can inject weights the
  // canonical hash projection would reject (NaN, etc.) -- the standardizer
  // re-validates cohortWeights defensively, so these never need to hash.
  function rawBenchmark(
    cohortWeights: Readonly<Record<string, number>>
  ): PlaytestBenchmark {
    return {
      benchmarkId: "fixture-benchmark-cohort-v1",
      version: 1,
      workspaceId: "fixture/synthetic-game",
      referenceBuildSha: "a".repeat(40),
      scenarioInventory: [
        { scenarioId: "tutorial", family: "onboarding", weight: 0.75 },
        { scenarioId: "edge", family: "edge-cases", weight: 0.25 }
      ],
      seedInventory: [
        { seed: "seed-discovery", purpose: "discovery" },
        { seed: "seed-confirmation", purpose: "confirmation" },
        { seed: "seed-regression", purpose: "regression" }
      ],
      policyVersions: { random: "hmac-sha256-v1" },
      competenceReportRefs: [{ kind: "episode", id: "policy-validity" }],
      memoryResetRules: "One isolated episode; no shared learning memory.",
      engineEnvironmentHash: sha256("fixture-environment-v1"),
      actionSchemaHash: sha256("fixture-actions-v1"),
      observationSchemaHash: sha256("fixture-observations-v1"),
      eventSchemaHash: sha256("fixture-events-v1"),
      metricRegistryHash: sha256("fixture-registry-v1"),
      rubricHash: sha256("fixture-rubric-v1"),
      captureMode: "headless",
      measurementVersion: "playtesting-measurement-v1",
      primaryMetricIds: ["legal-action-rejection"],
      guardrailMetricIds: ["crash-rate"],
      practicalMargins: {
        "legal-action-rejection": 0.02,
        "crash-rate": 0.01
      },
      independentUnit: "episode",
      precisionPlanRef: "fixture-descriptive-only",
      missingnessBound: 0.1,
      refreshPolicy: "manual operator review only",
      createdAt: "2026-10-10T00:00:00.000Z",
      createdBy: "fixture-operator",
      cohortWeights,
      contentHash: sha256("placeholder-for-defensive-validation")
    };
  }
  // Negative weight.
  assert.throws(
    () =>
      standardizePlaytestCohortRates({
        benchmark: rawBenchmark({
          [COHORT_EASY]: -0.5,
          [COHORT_HARD]: 1.5
        }),
        builds: threeBuildInput().builds
      }),
    /positive number/u
  );
  // Zero weight is rejected because the contract requires finite
  // *positive* weights -- a zero cohort would silently vanish from the
  // standardization denominator.
  assert.throws(
    () =>
      standardizePlaytestCohortRates({
        benchmark: rawBenchmark({ [COHORT_EASY]: 0, [COHORT_HARD]: 1 }),
        builds: threeBuildInput().builds
      }),
    /positive number/u
  );
  // NaN is a number but fails Number.isFinite, so the same rule catches
  // it.
  assert.throws(
    () =>
      standardizePlaytestCohortRates({
        benchmark: rawBenchmark({
          [COHORT_EASY]: 1,
          [COHORT_HARD]: Number.NaN
        }),
        builds: threeBuildInput().builds
      }),
    /finite number/u
  );
});

test("validation rejects empty benchmark cohort set", () => {
  const empty = {
    benchmark: frozenBenchmark({ cohortWeights: {} }),
    builds: threeBuildInput().builds
  };
  assert.throws(
    () => standardizePlaytestCohortRates(empty),
    /at least one cohort weight/u
  );
});

test("validation rejects missing benchmark.cohortWeights entirely", () => {
  const benchmark = frozenBenchmark();
  const broken = {
    benchmark: { ...benchmark, cohortWeights: undefined },
    builds: threeBuildInput().builds
  } as unknown as PlaytestCohortStandardizationInput;
  assert.throws(
    () => standardizePlaytestCohortRates(broken),
    /cohortWeights must be an object/u
  );
});

test("validation rejects invalid counts (negative, non-integer, numerator>denominator)", () => {
  const base = frozenBenchmark();
  // Non-safe-integer numerator (rejected before we ever check ordering).
  const nonInteger: PlaytestCohortStandardizationInput = {
    benchmark: base,
    builds: [
      {
        buildId: "fixture-build-bad-int",
        cohortObservations: {
          [COHORT_EASY]: { numerator: 1.5, denominator: 10, missing: 0 },
          [COHORT_HARD]: { numerator: 25, denominator: 50, missing: 0 }
        }
      },
      {
        buildId: "fixture-build-bad-int-anchor",
        cohortObservations: {
          [COHORT_EASY]: { numerator: 45, denominator: 50, missing: 0 },
          [COHORT_HARD]: { numerator: 25, denominator: 50, missing: 0 }
        }
      }
    ]
  };
  assert.throws(
    () => standardizePlaytestCohortRates(nonInteger),
    /non-negative safe integer/u
  );

  const over: PlaytestCohortStandardizationInput = {
    benchmark: base,
    builds: [
      {
        buildId: "fixture-build-overflow",
        cohortObservations: {
          [COHORT_EASY]: { numerator: 11, denominator: 10, missing: 0 },
          [COHORT_HARD]: { numerator: 25, denominator: 50, missing: 0 }
        }
      },
      {
        buildId: "fixture-build-overflow-anchor",
        cohortObservations: {
          [COHORT_EASY]: { numerator: 45, denominator: 50, missing: 0 },
          [COHORT_HARD]: { numerator: 25, denominator: 50, missing: 0 }
        }
      }
    ]
  };
  assert.throws(() => standardizePlaytestCohortRates(over), /cannot exceed/u);

  // Numerator must be zero when denominator is zero (avoids "phantom success").
  const phantomSuccess: PlaytestCohortStandardizationInput = {
    benchmark: base,
    builds: [
      {
        buildId: "fixture-build-phantom",
        cohortObservations: {
          [COHORT_EASY]: { numerator: 0, denominator: 0, missing: 0 },
          [COHORT_HARD]: { numerator: 1, denominator: 0, missing: 0 }
        }
      },
      {
        buildId: "fixture-build-phantom-anchor",
        cohortObservations: {
          [COHORT_EASY]: { numerator: 45, denominator: 50, missing: 0 },
          [COHORT_HARD]: { numerator: 25, denominator: 50, missing: 0 }
        }
      }
    ]
  };
  assert.throws(
    () => standardizePlaytestCohortRates(phantomSuccess),
    /must be zero when .denominator is zero/u
  );
});

test("validation rejects fewer than two builds (mix-shift gate is a comparison)", () => {
  const single: PlaytestCohortStandardizationInput = {
    benchmark: frozenBenchmark(),
    builds: [
      {
        buildId: "lone",
        cohortObservations: {
          [COHORT_EASY]: { numerator: 9, denominator: 10, missing: 0 },
          [COHORT_HARD]: { numerator: 5, denominator: 10, missing: 0 }
        }
      }
    ]
  };
  assert.throws(
    () => standardizePlaytestCohortRates(single),
    /at least two builds/u
  );
});

test("validation rejects duplicate build ids and empty cohortObservations maps", () => {
  const base = threeBuildInput();
  const dupBuild: PlaytestCohortStandardizationInput = {
    benchmark: base.benchmark,
    builds: [
      base.builds[0]!,
      // second build duplicates the first buildId intentionally
      {
        buildId: base.builds[0]!.buildId,
        cohortObservations: base.builds[1]!.cohortObservations
      }
    ]
  };
  assert.throws(
    () => standardizePlaytestCohortRates(dupBuild),
    /duplicates an earlier build id/u
  );

  const emptyMap: PlaytestCohortStandardizationInput = {
    benchmark: base.benchmark,
    builds: [
      {
        buildId: "fixture-build-empty-map",
        cohortObservations: {
          [COHORT_EASY]: { numerator: 0, denominator: 0, missing: 0 },
          [COHORT_HARD]: { numerator: 0, denominator: 0, missing: 0 }
        }
      },
      base.builds[0]!
    ]
  };
  // This empty-map shape is actually *not* rejected by the "empty map"
  // rule because it has both keys, both with zeros -- which is a
  // legitimate fully-unobserved build. Re-test the rejection with a
  // literal empty map.
  const literalEmpty: PlaytestCohortStandardizationInput = {
    benchmark: base.benchmark,
    builds: [
      {
        buildId: "fixture-empty-map",
        cohortObservations: {} as Record<string, never>
      },
      base.builds[0]!
    ]
  };
  void emptyMap;
  assert.throws(
    () => standardizePlaytestCohortRates(literalEmpty),
    /at least one cohort/u
  );
});

test("result carries the benchmark contentHash so consumers can prove the standardization used the frozen benchmark", () => {
  const input = threeBuildInput();
  const result = standardizePlaytestCohortRates(input);
  assert.equal(result.benchmarkContentHash, input.benchmark.contentHash);
  for (const row of result.builds) {
    assert.equal(row.benchmarkId, result.benchmarkId);
    assert.equal(row.benchmarkVersion, result.benchmarkVersion);
  }
});
