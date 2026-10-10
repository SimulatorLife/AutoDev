/**
 * Metric-specific compatibility classification and per-metric/overall
 * comparison decision logic (measurement-contract §4).
 *
 * Core supplies quantity definitions, grouping, and the classification
 * rules below; it does not implement bootstrap/permutation inference.
 * `PlaytestNumericInterval` is produced by a separately selected, pinned,
 * tested statistics library (e.g. SciPy bootstrap) and handed in as a
 * plain typed value. A caller that cannot produce a valid interval reports
 * `null` and the classifier below honestly returns `inconclusive`; it never
 * invents one.
 */

import {
  type PlaytestComparison,
  type PlaytestCompatibilityMode,
  type PlaytestDecisionStatus,
  type PlaytestDeltaClassification,
  type PlaytestMetricArmSummary,
  type PlaytestMetricComparison,
  type PlaytestNumericInterval,
  type PlaytestPreferenceAnswer,
  type PlaytestProvenance,
  PLAYTESTS_COMPARISON_SCHEMA,
  PLAYTESTS_NOT_COMPARABLE_MODE,
  type PlaytestVersionedRef
} from "./types.ts";
import {
  assessPlaytestMetricCompatibility,
  assessPlaytestPairing,
  type PlaytestMetricSemantics,
  type PlaytestPairingEvidence
} from "./compatibility.ts";

/** Is this a finite, non-degenerate (lower <= upper) numeric interval? */
export function isValidPlaytestInterval(
  interval: PlaytestNumericInterval | null
): interval is PlaytestNumericInterval {
  if (interval === null) return false;
  if (!Number.isFinite(interval.lower) || !Number.isFinite(interval.upper)) {
    return false;
  }
  if (interval.lower > interval.upper) return false;
  if (!Number.isFinite(interval.confidenceLevel)) return false;
  if (interval.confidenceLevel <= 0 || interval.confidenceLevel >= 1) {
    return false;
  }
  if (!interval.method || interval.method.trim().length === 0) return false;
  if (!interval.libraryVersion || interval.libraryVersion.trim().length === 0) {
    return false;
  }
  return true;
}

/** Inputs required to classify one metric's oriented benefit delta. */
export interface PlaytestMetricClassificationInput {
  readonly metricId: string;
  readonly metricVersion: number | string;
  readonly compatibility: PlaytestCompatibilityMode;
  readonly meaningfulMargin: number | null;
  readonly guardrailMargin: number | null;
  readonly orientedBenefitDelta: number | null;
  readonly interval: PlaytestNumericInterval | null;
  readonly baseline: PlaytestMetricArmSummary;
  readonly candidate: PlaytestMetricArmSummary;
  /** True when missingness/precision bounds already fail regardless of the interval. */
  readonly missingnessOrPrecisionFailed?: boolean;
}

/**
 * Classify a single metric delta per §4:
 *
 * - not-comparable overrides everything when semantic eligibility fails.
 * - Missingness/precision failures and invalid intervals yield inconclusive.
 * - improved when lower bound > meaningful margin; regressed when upper
 *   bound < -meaningful margin; no-material-change when the whole interval
 *   is within [-margin, margin]; otherwise inconclusive.
 * - A guardrail margin g>=0 passes noninferiority only when lower > -g;
 *   upper < -g is a breach; overlap is uncertain.
 */
export function classifyPlaytestMetricComparison(
  input: PlaytestMetricClassificationInput
): PlaytestMetricComparison {
  const guardrailStatus = computeGuardrailStatus(input);
  const classification = computeClassification(input);
  return {
    metricId: input.metricId,
    metricVersion: input.metricVersion,
    compatibility: input.compatibility,
    meaningfulMargin: input.meaningfulMargin,
    guardrailMargin: input.guardrailMargin,
    orientedBenefitDelta: input.orientedBenefitDelta,
    classification,
    baseline: input.baseline,
    candidate: input.candidate,
    interval: input.interval,
    sourceSemantics: null,
    guardrailStatus,
    notes: classificationNotes(input, classification, guardrailStatus)
  };
}

function computeClassification(
  input: PlaytestMetricClassificationInput
): PlaytestDeltaClassification {
  if (input.compatibility === PLAYTESTS_NOT_COMPARABLE_MODE)
    return PLAYTESTS_NOT_COMPARABLE_MODE;
  if (input.missingnessOrPrecisionFailed === true) return "inconclusive";
  if (input.meaningfulMargin === null) {
    // Descriptive-only metric: no confirmatory claim is permitted.
    return "inconclusive";
  }
  if (!isValidPlaytestInterval(input.interval)) return "inconclusive";
  const { lower, upper } = input.interval;
  const margin = input.meaningfulMargin;
  if (lower > margin) return "improved";
  if (upper < -margin) return "regressed";
  if (lower >= -margin && upper <= margin) return "no-material-change";
  return "inconclusive";
}

function computeGuardrailStatus(
  input: PlaytestMetricClassificationInput
): "passed" | "breached" | "uncertain" | "not-applicable" {
  if (input.guardrailMargin === null) return "not-applicable";
  if (input.compatibility === PLAYTESTS_NOT_COMPARABLE_MODE)
    return "not-applicable";
  if (input.missingnessOrPrecisionFailed === true) return "uncertain";
  if (!isValidPlaytestInterval(input.interval)) return "uncertain";
  const { lower, upper } = input.interval;
  const guardrail = input.guardrailMargin;
  if (lower > -guardrail) return "passed";
  if (upper < -guardrail) return "breached";
  return "uncertain";
}

function classificationNotes(
  input: PlaytestMetricClassificationInput,
  classification: PlaytestDeltaClassification,
  guardrailStatus: "passed" | "breached" | "uncertain" | "not-applicable"
): string {
  if (classification === PLAYTESTS_NOT_COMPARABLE_MODE) {
    return `Metric "${input.metricId}" is ${PLAYTESTS_NOT_COMPARABLE_MODE}: semantic eligibility failed.`;
  }
  if (
    classification === "inconclusive" &&
    !isValidPlaytestInterval(input.interval)
  ) {
    return `Metric "${input.metricId}" has no valid interval; classification is inconclusive, not equivalence.`;
  }
  return `Metric "${input.metricId}" classified ${classification}; guardrail ${guardrailStatus}.`;
}

/** Decide overall promotion eligibility from classified metrics (§4). */
export interface PlaytestDecisionInput {
  readonly metrics: readonly PlaytestMetricComparison[];
  readonly primaryMetricId: string;
}

/** A comparison metric plus the frozen source semantics from both arms. */
export interface PlaytestComparisonMetricInput extends Omit<
  PlaytestMetricClassificationInput,
  "compatibility"
> {
  readonly baselineSemantics: PlaytestMetricSemantics;
  readonly candidateSemantics: PlaytestMetricSemantics;
  /** Every preregistered assigned unit, including one with a missing outcome. */
  readonly baselineUnitIds: readonly string[];
  readonly candidateUnitIds: readonly string[];
}

/**
 * `eligible-for-owner-promotion` only when the preregistered primary metric
 * improved and every guardrail-bearing metric passed with adequate
 * coverage. A breach yields hold-regression; uncertain evidence yields
 * hold-inconclusive; incompatibility yields hold-not-comparable. Precedence
 * (checked in order): not-comparable > breach > inconclusive > promotion.
 */
export function decidePlaytestComparisonStatus(
  input: PlaytestDecisionInput
): PlaytestDecisionStatus {
  const primary = input.metrics.find(
    (metric) => metric.metricId === input.primaryMetricId
  );
  if (!primary) {
    throw new TypeError(
      `Primary metric "${input.primaryMetricId}" was not found among classified metrics.`
    );
  }
  if (
    input.metrics.some(
      (metric) => metric.classification === PLAYTESTS_NOT_COMPARABLE_MODE
    )
  ) {
    return "hold-not-comparable";
  }
  if (input.metrics.some((metric) => metric.guardrailStatus === "breached")) {
    return "hold-regression";
  }
  if (
    primary.classification !== "improved" ||
    input.metrics.some(
      (metric) =>
        metric.guardrailMargin !== null && metric.guardrailStatus !== "passed"
    )
  ) {
    return "hold-inconclusive";
  }
  return "eligible-for-owner-promotion";
}

/** Build the full comparison envelope from classified metrics + provenance. */
export function buildPlaytestComparison(args: {
  readonly comparisonId: string;
  readonly version: number;
  readonly benchmarkId: string;
  readonly experimentId: string | null;
  readonly baseline: PlaytestVersionedRef;
  readonly candidate: PlaytestVersionedRef;
  readonly freezeStatus: "frozen" | "spent" | "not-comparable";
  readonly pairingEvidence: PlaytestPairingEvidence;
  readonly sourceFindingIds: readonly string[];
  readonly episodeRefs: PlaytestComparison["episodeRefs"];
  readonly measurementVersion: string;
  readonly metrics: readonly PlaytestComparisonMetricInput[];
  readonly primaryMetricId: string;
  readonly humanPreference?: {
    readonly answer: PlaytestPreferenceAnswer | "not-collected";
    readonly interval: PlaytestNumericInterval | null;
  };
  readonly provenance: PlaytestProvenance;
  readonly notes?: string;
}): PlaytestComparison {
  const assessedPairing = assessPlaytestPairing(args.pairingEvidence);
  const expectedBaselineUnits = new Set(
    args.pairingEvidence.pairs.map((pair) => pair.baseline.episodeId)
  );
  const expectedCandidateUnits = new Set(
    args.pairingEvidence.pairs.map((pair) => pair.candidate.episodeId)
  );
  const matchesAssignments = (
    actual: readonly string[],
    expected: ReadonlySet<string>
  ): boolean =>
    actual.length === expected.size &&
    new Set(actual).size === actual.length &&
    actual.every((unitId) => expected.has(unitId));
  const assignedCountsMatchPairing = args.metrics.every(
    (metric) =>
      metric.baseline.assigned === args.pairingEvidence.pairs.length &&
      metric.candidate.assigned === args.pairingEvidence.pairs.length &&
      matchesAssignments(metric.baselineUnitIds, expectedBaselineUnits) &&
      matchesAssignments(metric.candidateUnitIds, expectedCandidateUnits)
  );
  const pairing = assignedCountsMatchPairing
    ? assessedPairing
    : {
        ...assessedPairing,
        mode: PLAYTESTS_NOT_COMPARABLE_MODE,
        couplingDiagnostics: [
          ...assessedPairing.couplingDiagnostics,
          "Assigned arm counts do not match the frozen pair inventory."
        ]
      };
  const seenMetrics = new Set<string>();
  const metrics = args.metrics.map((input) => {
    if (seenMetrics.has(input.metricId)) {
      throw new TypeError(
        `Comparison metric "${input.metricId}" is duplicated.`
      );
    }
    seenMetrics.add(input.metricId);
    for (const semantics of [
      input.baselineSemantics,
      input.candidateSemantics
    ]) {
      if (
        semantics.metricId !== input.metricId ||
        semantics.metricVersion !== input.metricVersion
      ) {
        throw new TypeError(
          `Comparison metric "${input.metricId}" does not match its frozen source semantics.`
        );
      }
    }
    const semantics = assessPlaytestMetricCompatibility(
      input.baselineSemantics,
      input.candidateSemantics
    );
    const compatibility =
      pairing.mode === PLAYTESTS_NOT_COMPARABLE_MODE || !semantics.compatible
        ? PLAYTESTS_NOT_COMPARABLE_MODE
        : pairing.mode;
    const {
      baselineSemantics: _baseline,
      candidateSemantics: _candidate,
      ...measurement
    } = input;
    const classified = classifyPlaytestMetricComparison({
      ...measurement,
      compatibility
    });
    const diagnostics = [
      ...semantics.reasons,
      ...(pairing.mode === PLAYTESTS_NOT_COMPARABLE_MODE
        ? pairing.couplingDiagnostics
        : [])
    ];
    return {
      ...classified,
      sourceSemantics: {
        baseline: input.baselineSemantics,
        candidate: input.candidateSemantics
      },
      ...(diagnostics.length > 0
        ? { notes: [classified.notes, ...diagnostics].join(" ") }
        : {})
    };
  });
  const decision = decidePlaytestComparisonStatus({
    metrics,
    primaryMetricId: args.primaryMetricId
  });
  return {
    schema: PLAYTESTS_COMPARISON_SCHEMA,
    comparisonId: args.comparisonId,
    version: args.version,
    benchmarkId: args.benchmarkId,
    experimentId: args.experimentId,
    baseline: args.baseline,
    candidate: args.candidate,
    freezeStatus: args.freezeStatus,
    pairing,
    sourceFindingIds: args.sourceFindingIds,
    episodeRefs: args.episodeRefs,
    measurementVersion: args.measurementVersion,
    metrics,
    decision,
    ownerDecisionAt: null,
    ownerDecisionReason: null,
    humanPreference: args.humanPreference ?? {
      answer: "not-collected",
      interval: null
    },
    provenance: args.provenance,
    notes: args.notes ?? ""
  };
}

/**
 * Record an owner decision onto an existing comparison, returning a new
 * immutable revision rather than mutating the original. The decision
 * status itself is derived from classified metrics, not freely overridden
 * here; this function only attaches the owner's authored reason/timestamp.
 */
export function recordPlaytestOwnerDecision(
  comparison: PlaytestComparison,
  decidedAt: string,
  reason: string
): PlaytestComparison {
  if (!reason || reason.trim().length === 0) {
    throw new TypeError("Owner decision requires a non-empty reason.");
  }
  return {
    ...comparison,
    ownerDecisionAt: decidedAt,
    ownerDecisionReason: reason
  };
}
