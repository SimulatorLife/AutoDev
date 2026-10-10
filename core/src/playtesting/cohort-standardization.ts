/**
 * Cohort-mix standardization gate for measurement-contract §11's
 * three-build changing cohort-mix fixture.
 *
 * Given a single frozen {@link PlaytestBenchmark} (whose `cohortWeights`
 * vector is the §10 fixed-weight basis) and per-build per-cohort
 * numerator, denominator and explicit missing counts, the function
 * separates the **raw sample-weighted observed rate** from the
 * **fixed-weight benchmark-standardized rate** for every build. The
 * fixture at the end of §10 ("three-build changing cohort mix" in §11)
 * relies on exactly this separation: build A's raw 70% and fixed-weight
 * 70% coincide on a 50/50 sample mix, build B's raw 85% hides a 65%
 * fixed-weight rate on the same 50/50 frozen weights (and therefore the
 * apparent gain is a regression), and build C's raw 86% returns to a
 * 70% fixed-weight rate that matches A but does not exceed it.
 *
 * The function is intentionally non-inferential:
 *
 * - It never imputes missing counts. A benchmark stratum with zero
 *   denominator, or a stratum that is entirely unobserved in a build,
 *   makes the standardized rate honestly `null` for that build rather
 *   than being silently dropped or zero-filled.
 * - It never computes a confidence interval or other homegrown
 *   inference; inference is the responsibility of an external
 *   statistics library that is bound by `PlaytestNumericInterval`. This
 *   module intentionally has no interval plumbing.
 * - It never produces a composite score, never rolls multiple builds
 *   into one number, and never composes a synthetic 0–4 category or a
 *   human-label proxy. The two rates per build stand on their own.
 *
 * Validation rules (every rule is a hard rejection; no synthetic
 * fallback exists):
 *
 * - The benchmark must already carry the frozen `cohortWeights` vector
 *   declared on `PlaytestBenchmark`. The standardizer re-validates the
 *   vector defensively (unique non-empty cohort keys, finite positive
 *   weights summing to 1.0 within the canonical hash tolerance) so it
 *   cannot be tricked by an unverified benchmark, but the canonical
 *   ownership boundary is `assertPlaytestBenchmark`.
 * - Each `cohortObservations` map declares exactly the benchmark
 *   cohorts (no unknown and no missing keys); cohort keys inside a map
 *   are also unique.
 * - `numerator`, `denominator` and `missing` are non-negative safe
 *   integers; `numerator` cannot exceed `denominator` and must be zero
 *   when `denominator` is zero.
 *
 * Output:
 *
 * - `PlaytestCohortStandardizationResult` includes one
 *   `PlaytestBuildCohortStandardization` per build with separate
 *   `rawObservedRate`, `standardizedRate`, `sourceCoverage` and an
 *   explicit closed-vocabulary `PlaytestCohortStandardizationState`.
 * - Each per-cohort row carries the inputs that fed it (numerator,
 *   denominator, missing, eligible) plus the derived observed rate,
 *   sample-mix proportion, benchmark weight and per-cohort coverage,
 *   so an independent audit can replay the math from the artifact.
 * - The result carries the benchmark `contentHash` so a downstream
 *   consumer can prove the standardized rates were computed against
 *   the exact frozen benchmark that produced the comparison.
 */

import type { PlaytestBenchmark } from "./artifacts.ts";
import { assertPlaytestCohortWeights } from "./benchmark.ts";

export const PLAYTESTS_COHORT_STANDARDIZATION_SCHEMA =
  "autodev-playtest-cohort-standardization-v1" as const;

/**
 * Closed vocabulary for the non-inferential verdict on a build's
 * standardization. The state is reported verbatim in
 * `PlaytestBuildCohortStandardization.standardizationState` so a
 * consumer never has to guess why the fixed-weight rate is null.
 */
export const PLAYTESTS_COHORT_STANDARDIZATION_STATES = [
  "standardized",
  "unknown-incomplete-source-coverage",
  "unknown-zero-denominator-stratum",
  "unknown-no-observation"
] as const;
export type PlaytestCohortStandardizationState =
  (typeof PLAYTESTS_COHORT_STANDARDIZATION_STATES)[number];

/**
 * A single closed-vocabulary verdict for one build's sample-mix
 * weighted observed rate. Mirrors the standardization state because
 * the two rates share the same data dependency: every condition that
 * nulls the standardized rate also nulls the raw observed rate.
 */
export const PLAYTESTS_COHORT_OBSERVED_STATES = [
  "observed",
  "unknown-incomplete-source-coverage",
  "unknown-zero-denominator-stratum",
  "unknown-no-observation"
] as const;
export type PlaytestCohortObservedState =
  (typeof PLAYTESTS_COHORT_OBSERVED_STATES)[number];

/**
 * Raw per-cohort counts for one build. `numerator` is the count of
 * successful / favourable observations under the metric's polarity;
 * `denominator` is the count of observed eligible opportunities;
 * `missing` is the count of eligible opportunities that the source
 * could not observe for any of the §3 `PlaytestMissingReason`s.
 */
export interface PlaytestCohortObservation {
  readonly numerator: number;
  readonly denominator: number;
  readonly missing: number;
}

/** Per-build cohort observations keyed by benchmark cohort. */
export interface PlaytestBuildCohortObservations {
  readonly buildId: string;
  readonly cohortObservations: Readonly<
    Record<string, PlaytestCohortObservation>
  >;
}

/**
 * Full input envelope: the frozen benchmark that owns the cohort
 * weights, plus one or more builds.
 */
export interface PlaytestCohortStandardizationInput {
  readonly benchmark: PlaytestBenchmark;
  readonly builds: readonly PlaytestBuildCohortObservations[];
}

/**
 * Per-cohort row inside a build's standardization breakdown. Surfacing
 * the inputs alongside the derived numbers preserves an auditable link
 * back to the raw observation counts.
 */
export interface PlaytestCohortStandardizationRow {
  readonly cohortKey: string;
  readonly benchmarkWeight: number;
  readonly numerator: number;
  readonly denominator: number;
  readonly missing: number;
  readonly eligible: number;
  /** `numerator / denominator`; null when `denominator === 0`. */
  readonly observedRate: number | null;
  /** `denominator / totalObserved`; null when this cohort or the build was unobserved. */
  readonly sampleProportion: number | null;
  /** `denominator / (denominator + missing)`; null when no eligibility reported. */
  readonly cohortCoverage: number | null;
}

/**
 * Per-build standardization row with explicit non-inferential state.
 * The raw and standardized rates intentionally travel as separate
 * fields; combining them into a single composite would be a band-aid
 * that violates §10's "no composite score" rule.
 */
export interface PlaytestBuildCohortStandardization {
  readonly schema: typeof PLAYTESTS_COHORT_STANDARDIZATION_SCHEMA;
  readonly benchmarkId: string;
  readonly benchmarkVersion: number;
  readonly buildId: string;
  /** Weighted by the actual sample mix (denominator_c / totalObserved). */
  readonly rawObservedRate: number | null;
  readonly rawObservedState: PlaytestCohortObservedState;
  /** Weighted by the frozen benchmark weights; null on incomplete source coverage or zero-denominator stratum. */
  readonly standardizedRate: number | null;
  readonly standardizationState: PlaytestCohortStandardizationState;
  /** `totalObserved / (totalObserved + totalMissing)`; null when no eligibility reported. */
  readonly sourceCoverage: number | null;
  readonly totalObserved: number;
  readonly totalMissing: number;
  readonly totalEligible: number;
  readonly cohorts: readonly PlaytestCohortStandardizationRow[];
}

/** Full envelope returned by `standardizePlaytestCohortRates`. */
export interface PlaytestCohortStandardizationResult {
  readonly schema: typeof PLAYTESTS_COHORT_STANDARDIZATION_SCHEMA;
  readonly benchmarkId: string;
  readonly benchmarkVersion: number;
  readonly benchmarkContentHash: string;
  readonly builds: readonly PlaytestBuildCohortStandardization[];
}

/** ---------- internal validation helpers (typed `unknown` -> assertion) ---------- */

function isPlainRecord(
  value: unknown
): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function assertNonNegativeSafeInteger(
  value: unknown,
  label: string
): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new TypeError(`${label} must be a non-negative safe integer.`);
  }
}

function assertPlaytestCohortObservation(
  value: unknown,
  label: string
): asserts value is PlaytestCohortObservation {
  if (!isPlainRecord(value)) {
    throw new TypeError(`${label} must be an object.`);
  }
  assertNonNegativeSafeInteger(value.numerator, `${label}.numerator`);
  assertNonNegativeSafeInteger(value.denominator, `${label}.denominator`);
  assertNonNegativeSafeInteger(value.missing, `${label}.missing`);
  if (value.denominator > 0 && value.numerator > value.denominator) {
    throw new TypeError(
      `${label}.numerator (${String(
        value.numerator
      )}) cannot exceed .denominator (${String(value.denominator)}).`
    );
  }
  if (value.denominator === 0 && value.numerator !== 0) {
    throw new TypeError(
      `${label}.numerator must be zero when .denominator is zero.`
    );
  }
}

function assertPlaytestBuildCohortObservations(
  value: unknown,
  label: string,
  benchmarkKeys: ReadonlySet<string>
): asserts value is PlaytestBuildCohortObservations {
  if (!isPlainRecord(value)) {
    throw new TypeError(`${label} must be an object.`);
  }
  if (!nonEmptyString(value.buildId)) {
    throw new TypeError(`${label}.buildId must be a non-empty string.`);
  }
  if (!isPlainRecord(value.cohortObservations)) {
    throw new TypeError(`${label}.cohortObservations must be an object.`);
  }
  const cohortKeys = Object.keys(value.cohortObservations);
  if (cohortKeys.length === 0) {
    throw new TypeError(
      `${label}.cohortObservations must declare at least one cohort.`
    );
  }
  const seen = new Set<string>();
  for (const key of cohortKeys) {
    if (!nonEmptyString(key) || seen.has(key)) {
      throw new TypeError(
        `${label}.cohortObservations contains an empty or duplicate cohort key "${key}".`
      );
    }
    seen.add(key);
    if (!benchmarkKeys.has(key)) {
      throw new TypeError(
        `${label}.cohortObservations[${key}] is not declared in the benchmark weights.`
      );
    }
    assertPlaytestCohortObservation(
      value.cohortObservations[key],
      `${label}.cohortObservations[${key}]`
    );
  }
  for (const benchmarkKey of benchmarkKeys) {
    if (!seen.has(benchmarkKey)) {
      throw new TypeError(
        `${label}.cohortObservations is missing the benchmark cohort "${benchmarkKey}".`
      );
    }
  }
}

function assertPlaytestCohortStandardizationInput(
  value: unknown,
  label: string
): asserts value is PlaytestCohortStandardizationInput {
  if (!isPlainRecord(value)) {
    throw new TypeError(`${label} must be an object.`);
  }
  if (!isPlainRecord(value.benchmark)) {
    throw new TypeError(`${label}.benchmark must be an object.`);
  }
  // Re-validate cohortWeights defensively. The canonical validator lives
  // in benchmark.ts and is what Runtime/Data flow into; this gate
  // exists so the standardizer cannot be tricked by an unverified
  // benchmark that bypassed the canonical ownership boundary.
  assertPlaytestCohortWeights(
    value.benchmark.cohortWeights,
    `${label}.benchmark.cohortWeights`
  );
  // After the assertion above, the cohortWeights projection is a
  // Readonly<Record<string, number>>; capture it as such for downstream
  // narrowing of the benchmark record.
  const cohortWeights: Readonly<Record<string, number>> =
    value.benchmark.cohortWeights as Readonly<Record<string, number>>;
  if (!nonEmptyString(value.benchmark.benchmarkId)) {
    throw new TypeError(
      `${label}.benchmark.benchmarkId must be a non-empty string.`
    );
  }
  if (
    !Number.isSafeInteger(value.benchmark.version) ||
    (value.benchmark.version as number) < 1
  ) {
    throw new TypeError(
      `${label}.benchmark.version must be a positive safe integer.`
    );
  }
  if (!nonEmptyString(value.benchmark.contentHash)) {
    throw new TypeError(
      `${label}.benchmark.contentHash must be a non-empty string.`
    );
  }
  const benchmarkKeys = new Set(Object.keys(cohortWeights));
  if (!Array.isArray(value.builds)) {
    throw new TypeError(`${label}.builds must be an array.`);
  }
  if (value.builds.length < 2) {
    throw new TypeError(
      `${label}.builds must contain at least two builds for a changing cohort-mix gate.`
    );
  }
  const seenBuilds = new Set<string>();
  for (let index = 0; index < value.builds.length; index += 1) {
    const build = value.builds[index];
    const labelForBuild = `${label}.builds[${String(index)}]`;
    if (!isPlainRecord(build)) {
      throw new TypeError(`${labelForBuild} must be an object.`);
    }
    if (!nonEmptyString(build.buildId)) {
      throw new TypeError(`${labelForBuild}.buildId must be a non-empty string.`);
    }
    if (seenBuilds.has(build.buildId)) {
      throw new TypeError(
        `${labelForBuild}.buildId duplicates an earlier build id "${build.buildId}".`
      );
    }
    seenBuilds.add(build.buildId);
    assertPlaytestBuildCohortObservations(build, labelForBuild, benchmarkKeys);
  }
}

/** ---------- internal computation helpers ---------- */

function observedRateOf(
  observation: PlaytestCohortObservation
): number | null {
  if (observation.denominator === 0) return null;
  return observation.numerator / observation.denominator;
}

function cohortCoverageOf(
  observation: PlaytestCohortObservation
): number | null {
  const eligible = observation.denominator + observation.missing;
  if (eligible === 0) return null;
  return observation.denominator / eligible;
}

/**
 * Standardize per-build cohort observations against the frozen cohort
 * weight vector that lives on the {@link PlaytestBenchmark} artifact.
 * The function is a pure and total function over its inputs: any
 * failure in the strict validation rules above throws a `TypeError`;
 * any build whose source coverage is incomplete produces a `null`
 * standardized rate with an explicit closed-vocabulary state.
 *
 * The function never accepts an interval, never computes a confidence
 * interval or p-value, and never produces a composite score; integration
 * with an external statistics library is the responsibility of an
 * upstream consumer that wraps the returned rates in
 * `PlaytestNumericInterval`.
 */
export function standardizePlaytestCohortRates(
  input: PlaytestCohortStandardizationInput
): PlaytestCohortStandardizationResult {
  assertPlaytestCohortStandardizationInput(input, "cohortStandardization");
  const benchmark = input.benchmark;
  const cohortWeights = benchmark.cohortWeights;
  const benchmarkKeys = Object.keys(cohortWeights);

  const builds = input.builds.map((build) =>
    standardizeBuild(build, benchmark, cohortWeights, benchmarkKeys)
  );

  return {
    schema: PLAYTESTS_COHORT_STANDARDIZATION_SCHEMA,
    benchmarkId: benchmark.benchmarkId,
    benchmarkVersion: benchmark.version,
    benchmarkContentHash: benchmark.contentHash,
    builds
  };
}

function standardizeBuild(
  build: PlaytestBuildCohortObservations,
  benchmark: PlaytestBenchmark,
  cohortWeights: Readonly<Record<string, number>>,
  benchmarkKeys: readonly string[]
): PlaytestBuildCohortStandardization {
  // Step 1: aggregate totals and detect coverage / zero-denominator issues.
  let totalObserved = 0;
  let totalMissing = 0;
  for (const key of benchmarkKeys) {
    const obs = build.cohortObservations[key];
    if (obs === undefined) {
      // Validation already guarantees the key is present; this is a defence
      // against silent loosening of the validator in the future.
      throw new TypeError(
        `Build "${build.buildId}" is missing benchmark cohort "${key}" after validation.`
      );
    }
    totalObserved += obs.denominator;
    totalMissing += obs.missing;
  }
  const totalEligible = totalObserved + totalMissing;
  const sourceCoverage =
    totalEligible === 0 ? null : totalObserved / totalEligible;

  // Step 2: classify the build's standardization verdict.
  let standardizationState: PlaytestCohortStandardizationState = "standardized";
  for (const key of benchmarkKeys) {
    const obs = build.cohortObservations[key];
    if (obs === undefined) {
      standardizationState = "unknown-incomplete-source-coverage";
      break;
    }
    if (obs.denominator === 0) {
      standardizationState = "unknown-zero-denominator-stratum";
      break;
    }
  }

  let standardizedRate: number | null;
  if (standardizationState !== "standardized") {
    standardizedRate = null;
  } else {
    let weighted = 0;
    for (const key of benchmarkKeys) {
      const obs = build.cohortObservations[key];
      const weight = cohortWeights[key];
      if (obs === undefined || weight === undefined) {
        // unreachable after validation + state classification above
        throw new TypeError(
          `Internal error: cohort "${key}" referenced without observation or benchmark weight.`
        );
      }
      weighted += weight * (obs.numerator / obs.denominator);
    }
    standardizedRate = weighted;
  }

  // Step 3: classify the raw sample-mix weighted verdict.
  let rawObservedState: PlaytestCohortObservedState = "observed";
  if (totalObserved === 0) {
    rawObservedState = "unknown-no-observation";
  } else if (standardizationState === "unknown-zero-denominator-stratum") {
    rawObservedState = "unknown-zero-denominator-stratum";
  } else if (
    standardizationState === "unknown-incomplete-source-coverage"
  ) {
    rawObservedState = "unknown-incomplete-source-coverage";
  }

  let rawObservedRate: number | null;
  if (rawObservedState !== "observed") {
    rawObservedRate = null;
  } else {
    let weighted = 0;
    for (const key of benchmarkKeys) {
      const obs = build.cohortObservations[key];
      if (obs === undefined) {
        // unreachable after validation
        throw new TypeError(
          `Internal error: cohort "${key}" referenced without observation.`
        );
      }
      const sampleProportion = obs.denominator / totalObserved;
      weighted += sampleProportion * (obs.numerator / obs.denominator);
    }
    rawObservedRate = weighted;
  }

  // Step 4: per-cohort rows for downstream auditability.
  const cohorts: PlaytestCohortStandardizationRow[] = benchmarkKeys.map(
    (key): PlaytestCohortStandardizationRow => {
      const obs = build.cohortObservations[key];
      const weight = cohortWeights[key];
      if (obs === undefined || weight === undefined) {
        // unreachable after validation
        throw new TypeError(
          `Internal error: cohort "${key}" referenced without observation or benchmark weight.`
        );
      }
      const eligible = obs.denominator + obs.missing;
      return {
        cohortKey: key,
        benchmarkWeight: weight,
        numerator: obs.numerator,
        denominator: obs.denominator,
        missing: obs.missing,
        eligible,
        observedRate: observedRateOf(obs),
        sampleProportion:
          obs.denominator === 0 || totalObserved === 0
            ? null
            : obs.denominator / totalObserved,
        cohortCoverage: cohortCoverageOf(obs)
      };
    }
  );

  return {
    schema: PLAYTESTS_COHORT_STANDARDIZATION_SCHEMA,
    benchmarkId: benchmark.benchmarkId,
    benchmarkVersion: benchmark.version,
    buildId: build.buildId,
    rawObservedRate,
    rawObservedState,
    standardizedRate,
    standardizationState,
    sourceCoverage,
    totalObserved,
    totalMissing,
    totalEligible,
    cohorts
  };
}
