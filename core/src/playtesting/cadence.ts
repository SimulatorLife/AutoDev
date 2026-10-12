/**
 * Cadence, tier budgets, retry semantics, and judge calibration (§6 & §10).
 * Normative design in docs/playtesting-measurement-contract.md §6, §10 and
 * docs/playtesting-target-state.md.
 */

import type {
  PlaytestCadenceConfiguration,
  PlaytestJudgeValidation
} from "./artifacts.ts";

export interface PlaytestCadenceTriggerEvent {
  readonly workspaceId: string;
  readonly buildSha: string;
  readonly benchmarkId: string;
  readonly tier: string;
  readonly event: string;
  readonly triggeredAt: string;
}

export type PlaytestCadenceWorkItemKind =
  "reproducible-regression" | "uncovered-critical-cell" | "rotating-discovery";

export interface PlaytestCadenceWorkItem {
  readonly workItemId: string;
  readonly kind: PlaytestCadenceWorkItemKind;
  readonly targetId: string;
  readonly estimatedAssignments: number;
}

export interface PlaytestJudgeCalibrationTolerances {
  readonly minRepeatAgreement: number;
  readonly minSecondJudgeAgreement: number;
  readonly minDiagnosticPrecision: number;
  readonly minDiagnosticRecall: number;
  readonly maxHumanPredictionError: number;
  readonly maxCostPerEpisode: number;
}

export interface PlaytestJudgeCalibrationCheckResult {
  readonly passed: boolean;
  readonly validationId: string;
  readonly status: "passed" | "failed";
  readonly failures: readonly string[];
  readonly quarantinedClaimTypes: readonly string[];
}

export function validatePlaytestCadenceConfig(
  config: PlaytestCadenceConfiguration
): void {
  if (!config.workspaceId || typeof config.workspaceId !== "string") {
    throw new TypeError("workspaceId must be a non-empty string.");
  }
  if (typeof config.enabled !== "boolean") {
    throw new TypeError("enabled must be a boolean.");
  }
  if (!config.tiers || typeof config.tiers !== "object") {
    throw new TypeError("tiers must be an object.");
  }
  for (const [tierName, tier] of Object.entries(config.tiers)) {
    if (!tierName || typeof tierName !== "string") {
      throw new TypeError("Tier name must be non-empty.");
    }
    if (
      typeof tier.assignments !== "number" ||
      tier.assignments <= 0 ||
      typeof tier.critiques !== "number" ||
      tier.critiques <= 0 ||
      typeof tier.wallTimeMs !== "number" ||
      tier.wallTimeMs <= 0
    ) {
      throw new TypeError(`Invalid budget parameters for tier ${tierName}.`);
    }
  }
  if (
    config.retryableInfrastructureAttempts !== 0 &&
    config.retryableInfrastructureAttempts !== 1 &&
    config.retryableInfrastructureAttempts !== 2
  ) {
    throw new TypeError("retryableInfrastructureAttempts must be 0, 1, or 2.");
  }
}

/**
 * Deduplicate triggers by (workspaceId, buildSha, benchmarkId, tier, event).
 */
export function deduplicateCadenceTriggers(
  triggers: readonly PlaytestCadenceTriggerEvent[]
): readonly PlaytestCadenceTriggerEvent[] {
  const seen = new Set<string>();
  const result: PlaytestCadenceTriggerEvent[] = [];

  for (const t of triggers) {
    const key = `${t.workspaceId}:${t.buildSha}:${t.benchmarkId}:${t.tier}:${t.event}`;
    if (!seen.has(key)) {
      seen.add(key);
      result.push(t);
    }
  }

  return result;
}

const WORK_KIND_PRIORITY: Record<PlaytestCadenceWorkItemKind, number> = {
  "reproducible-regression": 0,
  "uncovered-critical-cell": 1,
  "rotating-discovery": 2
};
const WORK_ITEM_ID_COLLATOR = new Intl.Collator();

/**
 * Prioritizes cadence work items:
 * 1. Reproducible regressions first;
 * 2. Uncovered critical cells second;
 * 3. Rotating discovery third.
 */
export function prioritizeCadenceWork(
  items: readonly PlaytestCadenceWorkItem[]
): readonly PlaytestCadenceWorkItem[] {
  return [...items].sort((a, b) => {
    const diff = WORK_KIND_PRIORITY[a.kind] - WORK_KIND_PRIORITY[b.kind];
    if (diff !== 0) return diff;
    return WORK_ITEM_ID_COLLATOR.compare(a.workItemId, b.workItemId);
  });
}

/**
 * Evaluates whether an execution attempt should be retried under cadence rules.
 * Infrastructure failures can be retried at most twice;
 * Game failures (normal loss, engine crash) are observations, never retried!
 */
export function evaluateCadenceRetry(
  attemptCount: number,
  failureClass: "infrastructure" | "game-failure",
  config: PlaytestCadenceConfiguration
): { readonly shouldRetry: boolean; readonly reason: string } {
  if (failureClass === "game-failure") {
    return {
      shouldRetry: false,
      reason:
        "Game failure is an observation, not an infrastructure error; retries to obtain favorable statistics are strictly forbidden."
    };
  }

  if (attemptCount < config.retryableInfrastructureAttempts) {
    return {
      shouldRetry: true,
      reason: `Transient infrastructure failure retry allowed (attempt ${attemptCount + 1} of ${config.retryableInfrastructureAttempts}).`
    };
  }

  return {
    shouldRetry: false,
    reason: `Exceeded maximum infrastructure retries (${config.retryableInfrastructureAttempts}).`
  };
}

/**
 * Evaluates periodic / trigger-based judge calibration against predeclared tolerances (§6/§10).
 * Quarantines affected claim types on failure so stale/unvalidated judges do not masquerade as fresh.
 */
export function evaluateJudgeCalibration(
  validation: PlaytestJudgeValidation,
  tolerances: PlaytestJudgeCalibrationTolerances,
  claimTypesToQuarantineOnFailure: readonly string[] = [
    "agency-critique",
    "clarity-critique",
    "pacing-critique"
  ]
): PlaytestJudgeCalibrationCheckResult {
  const failures: string[] = [];

  if (
    validation.repeatAgreement !== null &&
    validation.repeatAgreement < tolerances.minRepeatAgreement
  ) {
    failures.push(
      `Repeat agreement ${validation.repeatAgreement.toFixed(3)} fell below tolerance ${tolerances.minRepeatAgreement.toFixed(3)}.`
    );
  }
  if (
    validation.secondJudgeAgreement !== null &&
    validation.secondJudgeAgreement < tolerances.minSecondJudgeAgreement
  ) {
    failures.push(
      `Second-judge agreement ${validation.secondJudgeAgreement.toFixed(3)} fell below tolerance ${tolerances.minSecondJudgeAgreement.toFixed(3)}.`
    );
  }
  if (
    validation.diagnosticPrecision !== null &&
    validation.diagnosticPrecision < tolerances.minDiagnosticPrecision
  ) {
    failures.push(
      `Diagnostic precision ${validation.diagnosticPrecision.toFixed(3)} fell below tolerance ${tolerances.minDiagnosticPrecision.toFixed(3)}.`
    );
  }
  if (
    validation.diagnosticRecall !== null &&
    validation.diagnosticRecall < tolerances.minDiagnosticRecall
  ) {
    failures.push(
      `Diagnostic recall ${validation.diagnosticRecall.toFixed(3)} fell below tolerance ${tolerances.minDiagnosticRecall.toFixed(3)}.`
    );
  }
  if (
    validation.humanPredictionError !== null &&
    validation.humanPredictionError > tolerances.maxHumanPredictionError
  ) {
    failures.push(
      `Human prediction error ${validation.humanPredictionError.toFixed(3)} exceeded tolerance ${tolerances.maxHumanPredictionError.toFixed(3)}.`
    );
  }
  if (
    validation.costPerReviewedEpisode !== null &&
    validation.costPerReviewedEpisode > tolerances.maxCostPerEpisode
  ) {
    failures.push(
      `Cost per reviewed episode ${validation.costPerReviewedEpisode.toFixed(3)} exceeded tolerance ${tolerances.maxCostPerEpisode.toFixed(3)}.`
    );
  }

  const passed = failures.length === 0;

  return {
    passed,
    validationId: validation.validationId,
    status: passed ? "passed" : "failed",
    failures,
    quarantinedClaimTypes: passed ? [] : claimTypesToQuarantineOnFailure
  };
}
