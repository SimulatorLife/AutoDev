/**
 * Cohort mix-shift standardization over real runs (§10/§11).
 *
 * `standardizePlaytestCohortRates` is a complete Core policy with no executor:
 * the benchmark's frozen `cohortWeights` exist to drive a mix-shift gate, and
 * nothing in Runtime or Console ever fed the standardizer the per-cohort
 * observations that gate needs. This module is that path.
 *
 * Three rules decide the shape of the whole thing, and all three came from
 * reading the Core validator rather than assuming it.
 *
 * 1. It is a *comparison*. `assertPlaytestCohortStandardizationInput` rejects
 *    fewer than two builds -- "for a changing cohort-mix gate" -- because one
 *    build has no mix to have shifted. The measurement contract's own worked
 *    example (§10) tabulates builds A/B/C, and §11 names "three-build changing
 *    cohort mix" as a required fixture. So this module takes runs and keys the
 *    builds it produces by `batch.buildSha`.
 *
 * 2. Every build must declare *exactly* the benchmark's cohort keys. Core
 *    throws on a missing weighted cohort and on an undeclared extra. The
 *    tempting way to make a run fit is to fill absent cohorts with
 *    `{ numerator: 0, denominator: 0, missing: 0 }`.
 *
 * 3. That filling is a lie, and it is a lie the output would repeat. A zero
 *    denominator is the report "we looked and observed nothing", while an
 *    absent cohort is "we never looked". The vocabulary even names the
 *    difference -- `"unknown-no-observation"` sits in both state lists -- but
 *    no code path emits it, because the validator makes it unreachable. So
 *    this module refuses instead, naming the offending build and cohorts, and
 *    leaves the vocabulary defect recorded in the plan rather than papering
 *    over it with zeros.
 *
 * A refusal the caller can report is the product; a `TypeError` escaping from
 * a deep assertion is not. So every way Core would throw -- a cohort-set
 * mismatch in either direction, too few distinct builds -- is turned into a
 * named refusal here rather than propagated as an exception.
 *
 * Runs that share a `buildSha` are aggregated into one build rather than
 * rejected: `numerator`/`denominator`/`missing` are additive counts, and two
 * batches of the same build measured across separate runs is ordinary
 * operation, not a malformed input.
 */
import {
  type PlaytestBatch,
  type PlaytestBenchmark,
  type PlaytestBuildCohortObservations,
  type PlaytestCohortObservation,
  type PlaytestCohortStandardizationResult,
  type PlaytestEpisode,
  standardizePlaytestCohortRates
} from "@simulatorlife/autodev-core";

export interface DerivePlaytestCohortObservationsInput {
  readonly episodes: readonly PlaytestEpisode[];
  readonly metricId: string;
  /** Metric version the rows must match, so a renamed metric cannot mix. */
  readonly metricVersion?: number | string | undefined;
}

export interface DerivePlaytestCohortObservationsResult {
  /** Keyed by the episode's `policyCohort`; absent when never observed. */
  readonly cohortObservations: Readonly<
    Record<string, PlaytestCohortObservation>
  >;
  readonly contributingEpisodes: number;
  /** Metric rows that were not part of this aggregation. */
  readonly skippedRows: number;
}

interface Accumulator {
  numerator: number;
  denominator: number;
  missing: number;
}

/**
 * Sum each episode's metric row into its cohort.
 *
 * `numerator`, `denominator` and `missing` come straight off
 * `PlaytestNumericResult`, so this aggregates recorded counts rather than
 * re-deriving a rate from estimates. No rate is computed here: a cohort with
 * no eligible opportunity stays a zero denominator, and the standardizer owns
 * the state that reports.
 */
export function derivePlaytestCohortObservations(
  input: DerivePlaytestCohortObservationsInput
): DerivePlaytestCohortObservationsResult {
  const totals = new Map<string, Accumulator>();
  const contributingEpisodes = new Set<string>();
  let skippedRows = 0;

  for (const episode of input.episodes) {
    for (const row of episode.metrics) {
      if (row.metricId !== input.metricId) {
        skippedRows += 1;
        continue;
      }
      if (
        input.metricVersion !== undefined &&
        row.metricVersion !== input.metricVersion
      ) {
        skippedRows += 1;
        continue;
      }
      const cohort = episode.policyCohort;
      const current = totals.get(cohort) ?? {
        numerator: 0,
        denominator: 0,
        missing: 0
      };
      totals.set(cohort, {
        numerator: current.numerator + row.numerator,
        denominator: current.denominator + row.denominator,
        missing: current.missing + row.missing
      });
      contributingEpisodes.add(episode.episodeId);
    }
  }

  const cohortObservations: Record<string, PlaytestCohortObservation> = {};
  for (const cohort of [...totals.keys()].sort()) {
    const total = totals.get(cohort)!;
    cohortObservations[cohort] = {
      numerator: total.numerator,
      denominator: total.denominator,
      missing: total.missing
    };
  }

  return {
    cohortObservations,
    contributingEpisodes: contributingEpisodes.size,
    skippedRows
  };
}

/** Pseudo-build id used when a refusal is about the run set, not one build. */
export const RUN_SET_BUILD_ID = "__runs__";

/** One measured run: the batch that scoped it and the episodes it recorded. */
export interface PlaytestCohortRunInput {
  readonly batch: PlaytestBatch;
  readonly episodes: readonly PlaytestEpisode[];
}

export interface StandardizePlaytestCohortsInput {
  readonly benchmark: PlaytestBenchmark;
  /** At least two runs must resolve to distinct builds; see rule 1. */
  readonly runs: readonly PlaytestCohortRunInput[];
  readonly metricId: string;
  readonly metricVersion?: number | string | undefined;
}

/** Why a build could not enter the comparison. */
export type PlaytestCohortRefusalReason =
  "cohort-set-mismatch" | "insufficient-builds";

export interface PlaytestCohortBuildRefusal {
  /**
   * `buildSha` for a cohort-set mismatch; the literal `"__runs__"` for a gate
   * that never had enough distinct builds to compare, where naming one build
   * would imply the other runs were fine.
   */
  readonly buildId: string;
  readonly reason: PlaytestCohortRefusalReason;
  /** Cohorts the benchmark weights but this build never observed. */
  readonly unobservedCohorts: readonly string[];
  /** Cohorts this build observed that the benchmark does not weight. */
  readonly unweightedCohorts: readonly string[];
}

export interface PlaytestCohortsStandardizationOutcome {
  /** Null whenever any refusal was recorded; see the module comment. */
  readonly result: PlaytestCohortStandardizationResult | null;
  /** Per-build observations, so a refusal still shows what was measured. */
  readonly buildObservations: Readonly<
    Record<string, Readonly<Record<string, PlaytestCohortObservation>>>
  >;
  /** Episodes that contributed a matching metric row, per build. */
  readonly contributingEpisodesByBuild: Readonly<Record<string, number>>;
  /**
   * Metric rows that were present but not aggregated, per build -- other
   * metrics, other metric versions. Surfaced so a reader can tell "the run
   * recorded nothing for this metric" from "the run recorded rows and some did
   * not apply", which are very different statements about coverage.
   */
  readonly skippedRowsByBuild: Readonly<Record<string, number>>;
  readonly refusals: readonly PlaytestCohortBuildRefusal[];
}

/**
 * Standardize a cohort mix across runs against the approved benchmark.
 *
 * Returns a refusal rather than a padded or partial result whenever the
 * observed cohorts and the benchmark's weighted cohorts disagree, or when
 * fewer than two distinct builds were supplied. Observations are returned
 * either way, so a caller can see exactly what the gate would have judged and
 * which build stopped it.
 */
export function standardizePlaytestCohorts(
  input: StandardizePlaytestCohortsInput
): PlaytestCohortsStandardizationOutcome {
  // Merge runs of the same build first: the counts are additive, and one build
  // measured across two batches is a build, not a duplicate.
  const byBuild = new Map<string, Map<string, Accumulator>>();
  const contributingEpisodesByBuild = new Map<string, number>();
  const skippedRowsByBuild = new Map<string, number>();
  for (const run of input.runs) {
    const buildId = run.batch.buildSha;
    const derivation = derivePlaytestCohortObservations({
      episodes: run.episodes,
      metricId: input.metricId,
      ...(input.metricVersion === undefined
        ? {}
        : { metricVersion: input.metricVersion })
    });
    contributingEpisodesByBuild.set(
      buildId,
      (contributingEpisodesByBuild.get(buildId) ?? 0) +
        derivation.contributingEpisodes
    );
    skippedRowsByBuild.set(
      buildId,
      (skippedRowsByBuild.get(buildId) ?? 0) + derivation.skippedRows
    );
    const current = byBuild.get(buildId) ?? new Map<string, Accumulator>();
    for (const [cohort, counts] of Object.entries(
      derivation.cohortObservations
    )) {
      const cohortTotal = current.get(cohort) ?? {
        numerator: 0,
        denominator: 0,
        missing: 0
      };
      current.set(cohort, {
        numerator: cohortTotal.numerator + counts.numerator,
        denominator: cohortTotal.denominator + counts.denominator,
        missing: cohortTotal.missing + counts.missing
      });
    }
    byBuild.set(buildId, current);
  }

  const weighted = Object.keys(input.benchmark.cohortWeights);
  const buildObservations: Record<
    string,
    Record<string, PlaytestCohortObservation>
  > = {};
  const refusals: PlaytestCohortBuildRefusal[] = [];

  for (const buildId of [...byBuild.keys()].sort()) {
    const totals = byBuild.get(buildId)!;
    const observed: Record<string, PlaytestCohortObservation> = {};
    for (const cohort of [...totals.keys()].sort()) {
      observed[cohort] = totals.get(cohort)!;
    }
    buildObservations[buildId] = observed;

    const observedKeys = Object.keys(observed);
    const unobservedCohorts = weighted
      .filter((cohort) => !observedKeys.includes(cohort))
      .sort();
    const unweightedCohorts = observedKeys
      .filter((cohort) => !weighted.includes(cohort))
      .sort();
    if (unobservedCohorts.length > 0 || unweightedCohorts.length > 0) {
      refusals.push({
        buildId,
        reason: "cohort-set-mismatch",
        unobservedCohorts,
        unweightedCohorts
      });
    }
  }

  if (refusals.length === 0 && byBuild.size < 2) {
    // Core requires two builds; naming one build would read as if the others
    // had been accepted, so the refusal is attributed to the run set.
    refusals.push({
      buildId: RUN_SET_BUILD_ID,
      reason: "insufficient-builds",
      unobservedCohorts: [],
      unweightedCohorts: []
    });
  }

  const buildIds = Object.keys(buildObservations).sort();
  return {
    result:
      refusals.length > 0
        ? null
        : standardizePlaytestCohortRates({
            benchmark: input.benchmark,
            builds: buildIds.map(
              (buildId): PlaytestBuildCohortObservations => ({
                buildId,
                cohortObservations: buildObservations[buildId]!
              })
            )
          }),
    buildObservations,
    contributingEpisodesByBuild: Object.fromEntries(
      [...contributingEpisodesByBuild.entries()].sort(([a], [b]) =>
        a < b ? -1 : a > b ? 1 : 0
      )
    ),
    skippedRowsByBuild: Object.fromEntries(
      [...skippedRowsByBuild.entries()].sort(([a], [b]) =>
        a < b ? -1 : a > b ? 1 : 0
      )
    ),
    refusals
  };
}
