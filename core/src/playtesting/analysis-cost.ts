/**
 * Cost accounting for the critic-versus-deterministic comparison.
 *
 * The measurement contract requires comparing "critic+deterministic versus
 * deterministic-only at matched cost/coverage". `diagnostic-corpus.ts`
 * computes both arms' scores but reports no cost, so nothing could state
 * whether that comparison was legitimate — and an unmatched comparison reads
 * exactly like a matched one on a dashboard.
 *
 * Two boundaries this module holds deliberately:
 *
 * - Coverage is read from the same scored result the scores come from, never
 *   passed separately, so the two cannot describe different runs.
 * - Cost is *supplied as measured*, never derived from a price list. Model
 *   prices change, belong to the operator, and are not AutoDev's to assert.
 *
 * A missing measurement is `null`, never `0`. Zero episodes reviewed does not
 * mean the analysis was free; it means nobody reviewed anything, and reporting
 * a cost of zero would put a fabricated number on a budget decision. This is
 * the same defect the live-run count tiles had, where a key no producer emits
 * rendered as a plausible-looking value.
 */
import type {
  PlaytestDiagnosticCorpusResult,
  PlaytestDiagnosticSourceScore
} from "./diagnostic-corpus.ts";

/** Measured usage for one analysis arm, in the caller's own cost unit. */
export interface PlaytestAnalysisArmUsage {
  readonly arm: "critic" | "deterministic" | "combined";
  /** Cost actually incurred by this arm. Supplied by whatever ran it. */
  readonly measuredCost: number;
  /** Reviews this arm actually performed. */
  readonly critiquesRun: number;
}

export interface PlaytestAnalysisArmCoverage {
  readonly eligibleEpisodes: number;
  readonly adequatelyReviewedEpisodes: number;
}

export interface PlaytestAnalysisCostComparison {
  readonly referenceCorpusVersion: string;
  readonly coverage: Readonly<Record<string, PlaytestAnalysisArmCoverage>>;
  /**
   * Cost per adequately reviewed episode, or `null` when the arm reviewed
   * nothing. Never `0` for "not measured".
   */
  readonly costPerReviewedEpisode: Readonly<Record<string, number | null>>;
  /**
   * Combined-arm cost divided by deterministic-only cost. `null` when the
   * deterministic arm cost nothing per reviewed episode, because the ratio
   * would be a division by zero rather than an infinite cheapness.
   */
  readonly costRatioCombinedOverDeterministic: number | null;
  /** Combined minus deterministic, per reviewed episode. */
  readonly costDeltaPerReviewedEpisode: number | null;
  /**
   * Whether every arm was scored over the same episodes.
   *
   * True by construction today: `evaluatePlaytestDiagnosticCorpus` scores all
   * three sources over one frozen coverage set, and only
   * `outOfCoveragePredictions` varies per source. The field is kept as an
   * explicit guard rather than dropped as redundant, because the one change
   * that could break it — an evaluator that lets arms score over different
   * episode sets — would otherwise produce a silently invalid comparison
   * instead of a named one.
   */
  readonly coverageMatched: boolean;
  /** Names the arms that diverge, or `null` while the invariant holds. */
  readonly coverageMismatchReason: string | null;
  /**
   * Non-null whenever the contract's "at matched cost/coverage" comparison
   * cannot be made. This is the honesty gate: a caller that wants to claim a
   * matched comparison has to clear this, and it cannot clear it by rounding.
   */
  readonly matchedComparisonUnavailable: string | null;
}

const ARM_KEYS = ["critic", "deterministic", "combined"] as const;

function coverageOf(score: PlaytestDiagnosticSourceScore): PlaytestAnalysisArmCoverage {
  return {
    eligibleEpisodes: score.eligibleEpisodes,
    adequatelyReviewedEpisodes: score.adequatelyReviewedEpisodes
  };
}

/**
 * Cost per adequately reviewed episode, or `null` when nothing was reviewed.
 *
 * Dividing by zero episodes would produce `Infinity` or a misleading `0`, and
 * both would be read as a cost claim.
 */
function costPerReviewedEpisode(
  usage: PlaytestAnalysisArmUsage,
  coverage: PlaytestAnalysisArmCoverage
): number | null {
  if (coverage.adequatelyReviewedEpisodes <= 0) return null;
  return usage.measuredCost / coverage.adequatelyReviewedEpisodes;
}

function assertUsage(
  usage: readonly PlaytestAnalysisArmUsage[]
): ReadonlyMap<string, PlaytestAnalysisArmUsage> {
  const byArm = new Map<string, PlaytestAnalysisArmUsage>();
  for (const entry of usage) {
    if (!ARM_KEYS.includes(entry.arm)) {
      throw new TypeError(`Unknown analysis arm "${String(entry.arm)}".`);
    }
    if (!Number.isFinite(entry.measuredCost) || entry.measuredCost < 0) {
      throw new TypeError(
        `${entry.arm} measuredCost must be a finite non-negative number.`
      );
    }
    if (
      !Number.isSafeInteger(entry.critiquesRun) ||
      entry.critiquesRun < 0
    ) {
      throw new TypeError(
        `${entry.arm} critiquesRun must be a non-negative integer.`
      );
    }
    byArm.set(entry.arm, entry);
  }
  return byArm;
}

/**
 * Account for the cost of each arm and state whether the contract's
 * matched-cost/matched-coverage comparison is actually available.
 */
export function comparePlaytestAnalysisCost(
  result: PlaytestDiagnosticCorpusResult,
  usage: readonly PlaytestAnalysisArmUsage[]
): PlaytestAnalysisCostComparison {
  const byArm = assertUsage(usage);
  const coverage: Record<string, PlaytestAnalysisArmCoverage> = {};
  const perEpisode: Record<string, number | null> = {};
  for (const arm of ARM_KEYS) {
    const score = result[arm];
    const armCoverage = coverageOf(score);
    coverage[arm] = armCoverage;
    const armUsage = byArm.get(arm);
    // A missing usage entry is unmeasured, not free.
    perEpisode[arm] =
      armUsage === undefined ? null : costPerReviewedEpisode(armUsage, armCoverage);
  }

  const mismatches: string[] = [];
  for (const arm of ARM_KEYS) {
    const reference = coverage.deterministic!;
    const candidate = coverage[arm]!;
    if (candidate.eligibleEpisodes !== reference.eligibleEpisodes) {
      mismatches.push(
        `${arm} saw ${candidate.eligibleEpisodes} eligible episodes against deterministic's ${reference.eligibleEpisodes}`
      );
    }
    if (
      candidate.adequatelyReviewedEpisodes !== reference.adequatelyReviewedEpisodes
    ) {
      mismatches.push(
        `${arm} had ${candidate.adequatelyReviewedEpisodes} adequately reviewed episodes against deterministic's ${reference.adequatelyReviewedEpisodes}`
      );
    }
  }
  const coverageMatched = mismatches.length === 0;
  const coverageMismatchReason = coverageMatched
    ? null
    : `Coverage differs between arms: ${mismatches.join("; ")}.`;

  const combinedCost = perEpisode.combined ?? null;
  const deterministicCost = perEpisode.deterministic ?? null;
  const ratio =
    combinedCost !== null && deterministicCost !== null && deterministicCost > 0
      ? combinedCost / deterministicCost
      : null;
  const delta =
    combinedCost !== null && deterministicCost !== null
      ? combinedCost - deterministicCost
      : null;

  return {
    referenceCorpusVersion: result.referenceCorpusVersion,
    coverage,
    costPerReviewedEpisode: perEpisode,
    costRatioCombinedOverDeterministic: ratio,
    costDeltaPerReviewedEpisode: delta,
    coverageMatched,
    coverageMismatchReason,
    matchedComparisonUnavailable: coverageMatched
      ? null
      : "The contract's comparison is defined at matched coverage. The arms " +
        "reviewed different episodes, so their scores are not comparable " +
        "regardless of cost."
  };
}
