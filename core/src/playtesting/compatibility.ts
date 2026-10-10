/** Semantic compatibility gates for the single canonical PlaytestComparison. */

import type {
  PlaytestCompatibilityMode,
  PlaytestMetricSemantics
} from "./types.ts";

const SHA256_PATTERN = /^[a-f\d]{64}$/iu;

export interface PlaytestMetricCompatibility {
  readonly compatible: boolean;
  readonly reasons: readonly string[];
}

function assertMetricSemantics(
  value: PlaytestMetricSemantics,
  label: string
): void {
  if (
    typeof value.metricId !== "string" ||
    value.metricId.trim().length === 0 ||
    (typeof value.metricVersion !== "string" &&
      (!Number.isSafeInteger(value.metricVersion) ||
        value.metricVersion < 1)) ||
    (typeof value.metricVersion === "string" &&
      value.metricVersion.trim().length === 0) ||
    typeof value.modality !== "string" ||
    value.modality.trim().length === 0 ||
    typeof value.independentUnit !== "string" ||
    value.independentUnit.trim().length === 0
  ) {
    throw new TypeError(`${label} metric semantics are incomplete.`);
  }
  if (
    value.source !== "deterministic" &&
    value.source !== "critic" &&
    value.source !== "human"
  ) {
    throw new TypeError(`${label} metric source is unsupported.`);
  }
  if (
    !SHA256_PATTERN.test(value.quantityHash) ||
    !SHA256_PATTERN.test(value.sourceHash)
  ) {
    throw new TypeError(
      `${label} metric semantics require SHA-256 quantity and source hashes.`
    );
  }
}

/**
 * Decide whether two runs measure the same metric. A changed critic only
 * invalidates critic-produced dimensions; it does not invalidate an
 * unchanged game-owned deterministic evaluator. Missing or malformed source
 * fingerprints are rejected instead of treated as a compatible default.
 */
export function assessPlaytestMetricCompatibility(
  baseline: PlaytestMetricSemantics,
  candidate: PlaytestMetricSemantics
): PlaytestMetricCompatibility {
  assertMetricSemantics(baseline, "Baseline");
  assertMetricSemantics(candidate, "Candidate");

  const reasons: string[] = [];
  if (baseline.metricId !== candidate.metricId) {
    reasons.push("Metric identifiers differ.");
  }
  if (baseline.metricVersion !== candidate.metricVersion) {
    reasons.push("Metric versions differ.");
  }
  if (baseline.source !== candidate.source) {
    reasons.push("Measurement sources differ.");
  }
  if (baseline.quantityHash !== candidate.quantityHash) {
    reasons.push("Metric quantity definitions differ.");
  }
  if (baseline.sourceHash !== candidate.sourceHash) {
    reasons.push(
      baseline.source === "critic" || candidate.source === "critic"
        ? "Critic/rubric source changed; scores are not directly comparable."
        : "Metric-producing source changed; scores are not directly comparable."
    );
  }
  if (baseline.modality !== candidate.modality) {
    reasons.push("Evidence modalities differ.");
  }
  if (baseline.independentUnit !== candidate.independentUnit) {
    reasons.push("Independent analysis units differ.");
  }
  return { compatible: reasons.length === 0, reasons };
}

export interface PlaytestPairingSideEvidence {
  readonly episodeId: string;
  readonly scenarioId: string;
  /** Stable assignment identity from the frozen experiment allocation. */
  readonly seedAllocationId: string;
  /** Hash of the policy, knowledge and memory-reset contract. */
  readonly policyInformationHash: string;
  /** Exact initial state when the adapter can provide it, otherwise unobserved. */
  readonly initialStateHash: string | null;
  readonly rngAlgorithm: string | null;
  readonly rngStreamVersion: string | null;
  /** Hash of the observed exogenous random-draw sequence, not the seed text. */
  readonly rngSequenceHash: string | null;
}

export interface PlaytestPairEvidence {
  readonly pairId: string;
  readonly baseline: PlaytestPairingSideEvidence;
  readonly candidate: PlaytestPairingSideEvidence;
}

export interface PlaytestPairingEvidence {
  readonly requestedMode: "paired-initial-condition" | "paired-counterfactual";
  /** SHA-256 of the immutable allocation manifest, including seed assignment. */
  readonly allocationPlanHash: string;
  /** All planned pairs are retained, including units with missing outcomes. */
  readonly pairs: readonly PlaytestPairEvidence[];
}

export interface PlaytestPairingAssessment {
  readonly mode: PlaytestCompatibilityMode;
  readonly pairMap: Readonly<Record<string, string>>;
  readonly allocationPlanHash: string | null;
  readonly rngAlgorithm: string | null;
  readonly rngStreamVersion: string | null;
  readonly couplingDiagnostics: readonly string[];
  readonly exclusions: readonly string[];
}

function assertPairSide(
  value: PlaytestPairingSideEvidence,
  label: string
): void {
  if (
    typeof value.episodeId !== "string" ||
    value.episodeId.trim().length === 0 ||
    typeof value.scenarioId !== "string" ||
    value.scenarioId.trim().length === 0 ||
    typeof value.seedAllocationId !== "string" ||
    value.seedAllocationId.trim().length === 0 ||
    !SHA256_PATTERN.test(value.policyInformationHash) ||
    (value.initialStateHash !== null &&
      !SHA256_PATTERN.test(value.initialStateHash))
  ) {
    throw new TypeError(`${label} pair evidence is incomplete or malformed.`);
  }
  const rngValues = [
    value.rngAlgorithm,
    value.rngStreamVersion,
    value.rngSequenceHash
  ];
  if (rngValues.some((entry) => entry !== null && typeof entry !== "string")) {
    throw new TypeError(`${label} RNG provenance is malformed.`);
  }
  if (
    [value.rngAlgorithm, value.rngStreamVersion].some(
      (entry) => entry !== null && entry.trim().length === 0
    )
  ) {
    throw new TypeError(`${label} RNG provenance is incomplete.`);
  }
  if (
    value.rngSequenceHash !== null &&
    !SHA256_PATTERN.test(value.rngSequenceHash)
  ) {
    throw new TypeError(`${label} RNG sequence hash must be SHA-256 or null.`);
  }
}

/**
 * Validate a preregistered paired assignment. A stream mismatch (including an
 * extra random draw) downgrades a counterfactual claim to initial-condition
 * pairing without discarding any assigned pair. A mismatched initial state,
 * scenario, seed assignment or policy/information contract is not-comparable.
 */
export function assessPlaytestPairing(
  evidence: PlaytestPairingEvidence
): PlaytestPairingAssessment {
  if (!SHA256_PATTERN.test(evidence.allocationPlanHash)) {
    throw new TypeError("Pairing requires a SHA-256 allocation-plan hash.");
  }
  if (evidence.pairs.length === 0) {
    throw new TypeError("Pairing requires at least one frozen assigned pair.");
  }

  const pairIds = new Set<string>();
  const episodeIds = new Set<string>();
  const pairMap: Record<string, string> = {};
  const incompatibilities: string[] = [];
  const counterfactualLimitations: string[] = [];
  const algorithms = new Set<string>();
  const streamVersions = new Set<string>();
  let allCounterfactualEvidenceMatches = true;

  for (const pair of evidence.pairs) {
    if (!pair.pairId.trim() || pairIds.has(pair.pairId)) {
      throw new TypeError(
        "Frozen pair identifiers must be non-empty and unique."
      );
    }
    pairIds.add(pair.pairId);
    assertPairSide(pair.baseline, `Baseline ${pair.pairId}`);
    assertPairSide(pair.candidate, `Candidate ${pair.pairId}`);
    for (const side of [pair.baseline, pair.candidate]) {
      if (episodeIds.has(side.episodeId)) {
        throw new TypeError("An episode may belong to only one frozen pair.");
      }
      episodeIds.add(side.episodeId);
    }
    pairMap[pair.pairId] = JSON.stringify([
      pair.baseline.episodeId,
      pair.candidate.episodeId
    ]);

    if (pair.baseline.scenarioId !== pair.candidate.scenarioId) {
      incompatibilities.push(`${pair.pairId}: scenario assignments differ.`);
    }
    if (pair.baseline.seedAllocationId !== pair.candidate.seedAllocationId) {
      incompatibilities.push(`${pair.pairId}: seed assignments differ.`);
    }
    if (
      pair.baseline.policyInformationHash !==
      pair.candidate.policyInformationHash
    ) {
      incompatibilities.push(
        `${pair.pairId}: policy or player-information contracts differ.`
      );
    }
    if (
      pair.baseline.initialStateHash !== null &&
      pair.candidate.initialStateHash !== null &&
      pair.baseline.initialStateHash !== pair.candidate.initialStateHash
    ) {
      incompatibilities.push(`${pair.pairId}: initial-state hashes differ.`);
    }

    for (const algorithm of [
      pair.baseline.rngAlgorithm,
      pair.candidate.rngAlgorithm
    ]) {
      if (algorithm !== null) algorithms.add(algorithm);
    }
    for (const version of [
      pair.baseline.rngStreamVersion,
      pair.candidate.rngStreamVersion
    ]) {
      if (version !== null) streamVersions.add(version);
    }

    const initialStateMatches =
      pair.baseline.initialStateHash !== null &&
      pair.baseline.initialStateHash === pair.candidate.initialStateHash;
    if (!initialStateMatches) {
      allCounterfactualEvidenceMatches = false;
      counterfactualLimitations.push(
        `${pair.pairId}: identical initial-state hash was not established; counterfactual coupling is unavailable.`
      );
    }
    if (
      pair.baseline.rngAlgorithm === null ||
      pair.baseline.rngStreamVersion === null ||
      pair.baseline.rngSequenceHash === null ||
      pair.baseline.rngAlgorithm !== pair.candidate.rngAlgorithm ||
      pair.baseline.rngStreamVersion !== pair.candidate.rngStreamVersion ||
      pair.baseline.rngSequenceHash !== pair.candidate.rngSequenceHash
    ) {
      allCounterfactualEvidenceMatches = false;
      counterfactualLimitations.push(
        `${pair.pairId}: exogenous RNG stream was not proven identical; extra draws or stream divergence invalidate counterfactual coupling.`
      );
    }
  }

  if (incompatibilities.length > 0) {
    return {
      mode: "not-comparable",
      pairMap,
      allocationPlanHash: evidence.allocationPlanHash,
      rngAlgorithm: algorithms.size === 1 ? [...algorithms][0]! : null,
      rngStreamVersion:
        streamVersions.size === 1 ? [...streamVersions][0]! : null,
      couplingDiagnostics: incompatibilities,
      exclusions: []
    };
  }

  const counterfactual =
    evidence.requestedMode === "paired-counterfactual" &&
    allCounterfactualEvidenceMatches;
  const couplingDiagnostics =
    evidence.requestedMode === "paired-counterfactual" && !counterfactual
      ? counterfactualLimitations
      : [];

  return {
    mode: counterfactual ? "paired-counterfactual" : "paired-initial-condition",
    pairMap,
    allocationPlanHash: evidence.allocationPlanHash,
    rngAlgorithm: algorithms.size === 1 ? [...algorithms][0]! : null,
    rngStreamVersion:
      streamVersions.size === 1 ? [...streamVersions][0]! : null,
    couplingDiagnostics,
    exclusions: []
  };
}
