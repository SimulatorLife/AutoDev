/**
 * Deterministic fixture evaluators for the four §1 measurement-contract
 * metrics: legal-action rejection, competitive-choice-share, repeat-forecast
 * error, and native miniPXI ENJ aggregation.
 *
 * Every evaluator is a pure function over an explicit event array. None
 * executes an arbitrary expression, calls out to an LLM, or imputes a value
 * for a genuinely missing input. Coverage, missing counts and missing
 * reasons are always reported alongside the estimate so a caller cannot
 * read a partial-coverage ratio as a complete one.
 */

import { makePlaytestProvenance } from "./registry.ts";
import {
  type PlaytestMiniPxiCategory,
  type PlaytestMiniPxiEnjAggregation,
  type PlaytestMissingReason,
  type PlaytestNumericResult,
  PLAYTESTS_MINIPXI_CATEGORIES
} from "./types.ts";

/** One fresh advertised legal-action request/response pair. */
export interface LegalActionRequestEvent {
  readonly requestId: string;
  readonly offeredIds: readonly string[];
  readonly expectedRevision: number;
  readonly currentRevision: number;
  readonly executedId: string;
  readonly rejected: boolean;
}

/**
 * fixture/legal-rejection-v1 — numerator: fresh advertised legal requests the
 * engine rejected; denominator: all fresh advertised legal requests. A
 * request is "fresh" only when its expectedRevision matches currentRevision;
 * a stale request (revision drift) is excluded from both numerator and
 * denominator rather than silently counted as a rejection or an acceptance.
 */
export function evaluateLegalActionRejection(
  workspaceId: string,
  measurementVersion: string,
  events: readonly LegalActionRequestEvent[]
): PlaytestNumericResult {
  let denominator = 0;
  let numerator = 0;
  let missing = 0;
  const missingReasons: PlaytestMissingReason[] = [];
  for (const event of events) {
    if (
      event.offeredIds === undefined ||
      event.expectedRevision === undefined ||
      event.currentRevision === undefined
    ) {
      missing += 1;
      missingReasons.push("missing-action-or-revision-events");
      continue;
    }
    if (event.expectedRevision !== event.currentRevision) {
      // Stale request: not a fresh advertised legal request at all.
      continue;
    }
    denominator += 1;
    if (event.rejected) numerator += 1;
  }
  const coverage = events.length === 0 ? 0 : denominator / events.length;
  return {
    metricId: "legal-action-rejection",
    metricVersion: 1,
    numerator,
    denominator,
    coverage,
    unit: "proportion",
    estimate: denominator === 0 ? null : numerator / denominator,
    missing,
    missingReasons,
    independentUnits: denominator,
    provenance: makePlaytestProvenance(workspaceId, measurementVersion, {
      evaluatorHash: "fixture/legal-rejection-v1"
    }),
    notes:
      denominator === 0
        ? "No fresh advertised legal requests were observed."
        : `${String(numerator)}/${String(denominator)} fresh legal requests rejected.`
  };
}

/** One decision's full alternative-reward evaluation under a frozen plan. */
export interface CompetitiveChoiceDecisionEvent {
  readonly decisionId: string;
  /** Present only when every legal alternative was evaluated under the frozen plan. */
  readonly rewards: readonly number[] | null;
  readonly complete: boolean;
}

const COMPETITIVE_CHOICE_WINDOW = 0.05;

/**
 * fixture/competitive-options-v1 — numerator: eligible decisions (complete
 * reward evaluation) with at least two actions within 0.05 of the best
 * expected reward; denominator: decisions with all legal alternatives
 * evaluated under a frozen continuation/RNG plan. An incomplete decision
 * (fork-unsupported or partial-alternatives) is excluded from both and
 * reported as missing — never counted as a zero.
 */
export function evaluateCompetitiveChoiceShare(
  workspaceId: string,
  measurementVersion: string,
  decisions: readonly CompetitiveChoiceDecisionEvent[]
): PlaytestNumericResult {
  let denominator = 0;
  let numerator = 0;
  let missing = 0;
  const missingReasons: PlaytestMissingReason[] = [];
  for (const decision of decisions) {
    if (!decision.complete || decision.rewards === null) {
      missing += 1;
      missingReasons.push("partial-alternatives");
      continue;
    }
    if (decision.rewards.length < 2) {
      missing += 1;
      missingReasons.push("fork-unsupported");
      continue;
    }
    denominator += 1;
    const best = Math.max(...decision.rewards);
    const withinWindow = decision.rewards.filter(
      (reward) => best - reward <= COMPETITIVE_CHOICE_WINDOW
    ).length;
    if (withinWindow >= 2) numerator += 1;
  }
  const totalEligible = decisions.length;
  const coverage = totalEligible === 0 ? 0 : denominator / totalEligible;
  return {
    metricId: "competitive-choice-share",
    metricVersion: 1,
    numerator,
    denominator,
    coverage,
    unit: "proportion",
    estimate: denominator === 0 ? null : numerator / denominator,
    missing,
    missingReasons,
    independentUnits: denominator,
    provenance: makePlaytestProvenance(workspaceId, measurementVersion, {
      evaluatorHash: "fixture/competitive-options-v1"
    }),
    notes:
      denominator === 0
        ? "No decisions had a complete alternative-reward evaluation."
        : `${String(numerator)}/${String(denominator)} decisions had >=2 competitive actions; coverage ${String(denominator)}/${String(totalEligible)}.`
  };
}

/** One revisited-rule prediction after visible feedback. */
export interface RepeatForecastProbeEvent {
  readonly ruleId: string;
  readonly expected: unknown;
  readonly actual: unknown;
  readonly beforeAction: boolean;
  readonly feedbackVisible: boolean;
  /** True when the rule outcome is stochastic without a declared probability target. */
  readonly stochasticWithoutTarget?: boolean;
}

/**
 * fixture/repeated-error-v1 — numerator: wrong preregistered deterministic
 * consequence predictions after visible feedback; denominator: eligible
 * revisits after visible feedback. A probe missing its before-action
 * commitment, missing feedback, or stochastic without a declared probability
 * target is excluded from both and reported as missing.
 */
export function evaluateRepeatForecastError(
  workspaceId: string,
  measurementVersion: string,
  probes: readonly RepeatForecastProbeEvent[]
): PlaytestNumericResult {
  let denominator = 0;
  let numerator = 0;
  let missing = 0;
  const missingReasons: PlaytestMissingReason[] = [];
  for (const probe of probes) {
    if (!probe.beforeAction) {
      missing += 1;
      missingReasons.push("missing-before-action-probe");
      continue;
    }
    if (!probe.feedbackVisible) {
      missing += 1;
      missingReasons.push("missing-feedback");
      continue;
    }
    if (probe.stochasticWithoutTarget === true) {
      missing += 1;
      missingReasons.push("stochastic-outcome-without-probability-target");
      continue;
    }
    denominator += 1;
    if (!deepEqual(probe.expected, probe.actual)) numerator += 1;
  }
  return {
    metricId: "repeat-forecast-error",
    metricVersion: 1,
    numerator,
    denominator,
    coverage: probes.length === 0 ? 0 : denominator / probes.length,
    unit: "proportion",
    estimate: denominator === 0 ? null : numerator / denominator,
    missing,
    missingReasons,
    independentUnits: denominator,
    provenance: makePlaytestProvenance(workspaceId, measurementVersion, {
      evaluatorHash: "fixture/repeated-error-v1"
    }),
    notes:
      denominator === 0
        ? "No eligible visible-feedback revisits were observed."
        : `${String(numerator)}/${String(denominator)} wrong predictions after visible feedback.`
  };
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    return a.every((value, index) => deepEqual(value, b[index]));
  }
  if (
    typeof a === "object" &&
    a !== null &&
    typeof b === "object" &&
    b !== null
  ) {
    const aKeys = Object.keys(a as Record<string, unknown>).sort();
    const bKeys = Object.keys(b as Record<string, unknown>).sort();
    if (aKeys.length !== bKeys.length) return false;
    return aKeys.every(
      (key, index) =>
        key === bKeys[index] &&
        deepEqual(
          (a as Record<string, unknown>)[key],
          (b as Record<string, unknown>)[key]
        )
    );
  }
  return false;
}

/** One native miniPXI ENJ item response before aggregation. */
export interface MiniPxiEnjResponseEvent {
  readonly respondentId: string;
  readonly nativeValue: number | null;
  readonly missingReason?: PlaytestMissingReason;
}

/** Map a native -3..+3 ENJ value to its closed-vocabulary category bucket. */
export function categorizeMiniPxiEnjValue(
  value: number
): PlaytestMiniPxiCategory {
  if (value <= -2) return "low";
  if (value === -1) return "medium-low";
  if (value === 0) return "neutral";
  if (value === 1 || value === 2) return "medium-high";
  return "high";
}

/**
 * fixture/minipxi-enj-v1 — mean of valid native ENJ responses (−3..+3),
 * respondent count, missing count/reasons and category distribution. The
 * mean is reported in the native Likert unit; it is never rescaled into a
 * 0-4 rubric category.
 */
export function aggregateMiniPxiEnj(
  workspaceId: string,
  measurementVersion: string,
  responses: readonly MiniPxiEnjResponseEvent[]
): PlaytestMiniPxiEnjAggregation {
  const categoryCounts = Object.fromEntries(
    PLAYTESTS_MINIPXI_CATEGORIES.map((category) => [category, 0])
  ) as Record<PlaytestMiniPxiCategory, number>;
  let sum = 0;
  let respondentCount = 0;
  let missingCount = 0;
  const missingReasons: PlaytestMissingReason[] = [];
  const seen = new Set<string>();
  for (const response of responses) {
    if (seen.has(response.respondentId)) {
      throw new TypeError(
        `Duplicate miniPXI ENJ response for respondent "${response.respondentId}".`
      );
    }
    seen.add(response.respondentId);
    if (response.nativeValue === null) {
      missingCount += 1;
      missingReasons.push(response.missingReason ?? "missing-ENJ");
      continue;
    }
    if (
      !Number.isInteger(response.nativeValue) ||
      response.nativeValue < -3 ||
      response.nativeValue > 3
    ) {
      throw new TypeError(
        `miniPXI ENJ value for respondent "${response.respondentId}" must be an integer in [-3,3].`
      );
    }
    sum += response.nativeValue;
    respondentCount += 1;
    categoryCounts[categorizeMiniPxiEnjValue(response.nativeValue)] += 1;
  }
  return {
    metricId: "reported-enjoyment",
    metricVersion: 1,
    mean: respondentCount === 0 ? null : sum / respondentCount,
    respondentCount,
    missingCount,
    categoryCounts,
    unit: "native-Likert-minus3-plus3",
    missingReasons,
    independentUnits: respondentCount,
    provenance: makePlaytestProvenance(workspaceId, measurementVersion, {
      instrumentVersion: "miniPXI-ENJ-v1"
    })
  };
}
