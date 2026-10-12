/**
 * Human comprehension protocol and ordered diagnostic ladder (§8).
 * Normative design in docs/playtesting-measurement-contract.md §8 and
 * docs/playtesting-target-state.md §1 & §4.
 *
 * Separates model-misunderstood, UI-possibly-ambiguous, and
 * human-confirmed-confusing with eligible exposures and uncertainty.
 * Several LLMs are not several people: human claims strictly require
 * actual consented human cohort evidence.
 */

import { HUMAN_STUDY_SMALL_CELL_SUPPRESSION_THRESHOLD } from "./human-study-aggregation.ts";
import type { PlaytestNumericInterval } from "./types.ts";

const CONSENTED_HUMAN_EVIDENCE = "consented-human-evidence" as const;
export const PLAYTEST_DIAGNOSTIC_LADDER_STAGES = [
  "authoritative-rules-and-ui-equivalence",
  "observer-competence",
  "frozen-preaction-forecasts",
  CONSENTED_HUMAN_EVIDENCE,
  "controlled-intervention"
] as const;

export type PlaytestDiagnosticLadderStage =
  (typeof PLAYTEST_DIAGNOSTIC_LADDER_STAGES)[number];

const HUMAN_CONFIRMED_CONFUSING = "human-confirmed-confusing" as const;
export const PLAYTEST_CONFUSION_CATEGORIES = [
  "model-misunderstood",
  "ui-possibly-ambiguous",
  HUMAN_CONFIRMED_CONFUSING,
  "unverified"
] as const;

export type PlaytestConfusionCategory =
  (typeof PLAYTEST_CONFUSION_CATEGORIES)[number];

export interface PlaytestPreActionForecast {
  readonly probeId: string;
  readonly mechanicKey: string;
  readonly preActionUiRef: string;
  readonly actionId: string;
  readonly consequenceVariable: string;
  readonly predictedValue: unknown;
  readonly confidence: number;
  readonly explanation?: string;
  readonly actualConsequence: unknown;
  readonly isCorrect: boolean | number;
  readonly correctiveBehaviorObserved?: boolean | null;
  readonly cohort: string;
  readonly isHuman: boolean;
}

export interface PlaytestHumanComprehensionEvidence {
  readonly studyId: string;
  readonly consented: boolean;
  readonly participantCount: number;
  readonly eligibleExposures: number;
  readonly correctCount: number;
  readonly errorRateInterval: PlaytestNumericInterval | null;
  readonly shadowCohort: boolean;
  readonly miniPxiGoalClarity?: number | null;
}

export interface PlaytestControlledIntervention {
  readonly interventionId: string;
  readonly treatmentWarningRef: string;
  readonly controlErrorRate: number;
  readonly treatmentErrorRate: number;
  readonly controlSampleSize: number;
  readonly treatmentSampleSize: number;
  readonly riskDifferenceInterval: PlaytestNumericInterval | null;
}

export interface EvaluateDiagnosticLadderInput {
  readonly mechanicKey: string;
  readonly stage1UiEquivalenceVerified: boolean;
  readonly stage2ObserverCompetenceVerified: boolean;
  readonly thresholds: {
    /** Game-owned threshold below which model-only errors trigger ambiguity review. */
    readonly modelAmbiguityAccuracy: number;
    /** Game-owned minimum error rate required for a human-confusion claim. */
    readonly humanConfusionErrorRate: number;
  };
  readonly stage3Forecasts: readonly PlaytestPreActionForecast[];
  readonly stage4HumanEvidence?: PlaytestHumanComprehensionEvidence | null;
  readonly stage5Intervention?: PlaytestControlledIntervention | null;
}

export interface PlaytestDiagnosticLadderResult {
  readonly mechanicKey: string;
  readonly highestStageReached: PlaytestDiagnosticLadderStage;
  readonly confusionCategory: PlaytestConfusionCategory;
  readonly modelForecastAccuracy: number | null;
  readonly humanErrorRate: number | null;
  readonly interventionRiskDifference: number | null;
  readonly interventionRiskDifferenceInterval: PlaytestNumericInterval | null;
  readonly reasons: readonly string[];
}

const FROZEN_PREACTION_FORECASTS: PlaytestDiagnosticLadderStage =
  "frozen-preaction-forecasts";
const UI_POSSIBLY_AMBIGUOUS: PlaytestConfusionCategory =
  "ui-possibly-ambiguous";

function unverifiedResult(
  mechanicKey: string,
  highestStageReached: PlaytestDiagnosticLadderStage,
  reason: string
): PlaytestDiagnosticLadderResult {
  return {
    mechanicKey,
    highestStageReached,
    confusionCategory: "unverified",
    modelForecastAccuracy: null,
    humanErrorRate: null,
    interventionRiskDifference: null,
    interventionRiskDifferenceInterval: null,
    reasons: [reason]
  };
}

function assertForecastRows(
  forecasts: readonly PlaytestPreActionForecast[],
  mechanicKey: string
): void {
  for (const forecast of forecasts) {
    if (
      typeof forecast.probeId !== "string" ||
      forecast.probeId.trim().length === 0 ||
      forecast.mechanicKey !== mechanicKey ||
      typeof forecast.preActionUiRef !== "string" ||
      forecast.preActionUiRef.trim().length === 0 ||
      typeof forecast.actionId !== "string" ||
      forecast.actionId.trim().length === 0 ||
      typeof forecast.consequenceVariable !== "string" ||
      forecast.consequenceVariable.trim().length === 0 ||
      typeof forecast.confidence !== "number" ||
      !Number.isFinite(forecast.confidence) ||
      forecast.confidence < 0 ||
      forecast.confidence > 1 ||
      typeof forecast.isHuman !== "boolean" ||
      typeof forecast.cohort !== "string" ||
      forecast.cohort.trim().length === 0 ||
      (typeof forecast.isCorrect !== "boolean" &&
        (typeof forecast.isCorrect !== "number" ||
          !Number.isFinite(forecast.isCorrect) ||
          forecast.isCorrect < 0 ||
          forecast.isCorrect > 1))
    ) {
      throw new TypeError("Malformed or mismatched pre-action forecast row.");
    }
  }
}

function modelForecastAccuracy(
  forecasts: readonly PlaytestPreActionForecast[]
): number | null {
  const modelForecasts = forecasts.filter((forecast) => !forecast.isHuman);
  if (modelForecasts.length === 0) return null;
  const totalScore = modelForecasts.reduce<number>((sum, forecast) => {
    const score =
      typeof forecast.isCorrect === "number"
        ? forecast.isCorrect
        : forecast.isCorrect
          ? 1
          : 0;
    return sum + score;
  }, 0);
  return totalScore / modelForecasts.length;
}

function assertHumanEvidence(human: PlaytestHumanComprehensionEvidence): void {
  if (
    typeof human.studyId !== "string" ||
    !human.studyId.trim() ||
    typeof human.consented !== "boolean" ||
    !Number.isSafeInteger(human.participantCount) ||
    human.participantCount < 0 ||
    human.participantCount > human.eligibleExposures ||
    !Number.isSafeInteger(human.eligibleExposures) ||
    human.eligibleExposures < 1 ||
    !Number.isSafeInteger(human.correctCount) ||
    human.correctCount < 0 ||
    human.correctCount > human.eligibleExposures ||
    typeof human.shadowCohort !== "boolean"
  ) {
    throw new TypeError("Malformed human comprehension evidence.");
  }
  if (!human.consented) {
    throw new TypeError(
      "Human comprehension evidence must be strictly consented."
    );
  }
  const interval = human.errorRateInterval;
  if (
    interval !== null &&
    (!Number.isFinite(interval.lower) ||
      !Number.isFinite(interval.upper) ||
      interval.lower < 0 ||
      interval.upper > 1 ||
      interval.lower > interval.upper ||
      !interval.method.trim() ||
      !interval.libraryVersion.trim() ||
      !Number.isFinite(interval.confidenceLevel) ||
      interval.confidenceLevel <= 0 ||
      interval.confidenceLevel >= 1 ||
      (interval.resamples !== null &&
        (!Number.isSafeInteger(interval.resamples) ||
          interval.resamples < 1)) ||
      (interval.seed !== null && !interval.seed.trim()) ||
      (interval.resamples !== null && interval.seed === null))
  ) {
    throw new TypeError("Malformed human-comprehension uncertainty interval.");
  }
}

function classifyHumanEvidence(
  human: PlaytestHumanComprehensionEvidence | null | undefined,
  modelAccuracy: number | null,
  thresholds: EvaluateDiagnosticLadderInput["thresholds"],
  reasons: string[]
): {
  readonly reachedStage: PlaytestDiagnosticLadderStage;
  readonly category: PlaytestConfusionCategory;
  readonly errorRate: number | null;
} {
  if (human) {
    assertHumanEvidence(human);
    if (human.participantCount < HUMAN_STUDY_SMALL_CELL_SUPPRESSION_THRESHOLD) {
      reasons.push(
        "Human evidence sample below small-cell threshold (n < " +
          HUMAN_STUDY_SMALL_CELL_SUPPRESSION_THRESHOLD +
          "); human confusion remains unverified."
      );
      return {
        reachedStage: FROZEN_PREACTION_FORECASTS,
        category: UI_POSSIBLY_AMBIGUOUS,
        errorRate: null
      };
    }
    const errorRate =
      (human.eligibleExposures - human.correctCount) / human.eligibleExposures;
    const interval = human.errorRateInterval;
    if (interval === null) {
      reasons.push(
        "Human error-rate uncertainty is unavailable; human confusion remains unverified."
      );
      return {
        reachedStage: CONSENTED_HUMAN_EVIDENCE,
        category: UI_POSSIBLY_AMBIGUOUS,
        errorRate
      };
    }
    if (interval.lower > thresholds.humanConfusionErrorRate) {
      reasons.push(
        `Human-confirmed confusion observed in tested cohort (${Math.round(errorRate * 100)}% error rate; interval lower bound exceeds the game threshold).`
      );
      return {
        reachedStage: CONSENTED_HUMAN_EVIDENCE,
        category: HUMAN_CONFIRMED_CONFUSING,
        errorRate
      };
    }
    if (interval.upper <= thresholds.humanConfusionErrorRate) {
      reasons.push(
        "Human error interval remains within the game's non-confusion range; errors are restricted to the model cohort."
      );
      return {
        reachedStage: CONSENTED_HUMAN_EVIDENCE,
        category: "model-misunderstood",
        errorRate
      };
    }
    reasons.push(
      "Human error interval overlaps the game's confusion threshold; human confusion remains unverified."
    );
    return {
      reachedStage: CONSENTED_HUMAN_EVIDENCE,
      category: UI_POSSIBLY_AMBIGUOUS,
      errorRate
    };
  }

  if (
    modelAccuracy !== null &&
    modelAccuracy < thresholds.modelAmbiguityAccuracy
  ) {
    reasons.push(
      "Low model forecast accuracy observed without human evidence; classified as UI-possibly-ambiguous."
    );
    return {
      reachedStage: FROZEN_PREACTION_FORECASTS,
      category: UI_POSSIBLY_AMBIGUOUS,
      errorRate: null
    };
  }
  reasons.push(
    "Isolated model misunderstanding without verified human confusion."
  );
  return {
    reachedStage: FROZEN_PREACTION_FORECASTS,
    category: "model-misunderstood",
    errorRate: null
  };
}

function interventionRiskDifference(
  intervention: PlaytestControlledIntervention | null | undefined,
  humanEvidenceQualified: boolean,
  reasons: string[]
): {
  readonly difference: number | null;
  readonly interval: PlaytestNumericInterval | null;
} {
  if (!intervention) return { difference: null, interval: null };
  if (
    !intervention.interventionId.trim() ||
    !intervention.treatmentWarningRef.trim() ||
    !Number.isSafeInteger(intervention.controlSampleSize) ||
    intervention.controlSampleSize < 1 ||
    !Number.isSafeInteger(intervention.treatmentSampleSize) ||
    intervention.treatmentSampleSize < 1 ||
    !Number.isFinite(intervention.controlErrorRate) ||
    intervention.controlErrorRate < 0 ||
    intervention.controlErrorRate > 1 ||
    !Number.isFinite(intervention.treatmentErrorRate) ||
    intervention.treatmentErrorRate < 0 ||
    intervention.treatmentErrorRate > 1 ||
    (intervention.riskDifferenceInterval !== null &&
      (!Number.isFinite(intervention.riskDifferenceInterval.lower) ||
        !Number.isFinite(intervention.riskDifferenceInterval.upper) ||
        intervention.riskDifferenceInterval.lower < -1 ||
        intervention.riskDifferenceInterval.upper > 1 ||
        intervention.riskDifferenceInterval.lower >
          intervention.riskDifferenceInterval.upper ||
        !intervention.riskDifferenceInterval.method.trim() ||
        !intervention.riskDifferenceInterval.libraryVersion.trim() ||
        !Number.isFinite(intervention.riskDifferenceInterval.confidenceLevel) ||
        intervention.riskDifferenceInterval.confidenceLevel <= 0 ||
        intervention.riskDifferenceInterval.confidenceLevel >= 1))
  ) {
    throw new TypeError("Malformed controlled-intervention evidence.");
  }
  if (!humanEvidenceQualified) {
    reasons.push(
      "Controlled warning/UI intervention requires qualified consented human evidence before causal interpretation."
    );
    return { difference: null, interval: null };
  }
  if (intervention.riskDifferenceInterval === null) {
    reasons.push(
      "Controlled warning/UI intervention uncertainty is unavailable; no causal interpretation is made."
    );
    return { difference: null, interval: null };
  }
  const difference =
    intervention.treatmentErrorRate - intervention.controlErrorRate;
  reasons.push(
    `Controlled warning/UI intervention evaluated: risk difference ${difference >= 0 ? "+" : ""}${difference.toFixed(3)} with a qualified interval.`
  );
  return { difference, interval: intervention.riskDifferenceInterval };
}

/**
 * Evaluates pre-action comprehension forecasts and human evidence against
 * the ordered 5-stage diagnostic ladder.
 */
export function evaluateDiagnosticLadder(
  input: EvaluateDiagnosticLadderInput
): PlaytestDiagnosticLadderResult {
  if (typeof input.mechanicKey !== "string" || !input.mechanicKey.trim()) {
    throw new TypeError("mechanicKey must be a non-empty string.");
  }
  if (!input.stage1UiEquivalenceVerified) {
    return unverifiedResult(
      input.mechanicKey,
      "authoritative-rules-and-ui-equivalence",
      "UI-to-observation equivalence and authoritative rules are not verified; cannot infer understanding or confusion."
    );
  }
  if (!input.stage2ObserverCompetenceVerified) {
    return unverifiedResult(
      input.mechanicKey,
      "observer-competence",
      "Observer competence unverified; model error cannot be distinguished from observer deficiency."
    );
  }
  if (
    !Array.isArray(input.stage3Forecasts) ||
    input.stage3Forecasts.length === 0
  ) {
    return unverifiedResult(
      input.mechanicKey,
      "observer-competence",
      "No pre-action forecasts recorded."
    );
  }

  assertForecastRows(input.stage3Forecasts, input.mechanicKey);
  const accuracy = modelForecastAccuracy(input.stage3Forecasts);
  const reasons: string[] = [];
  if (
    !Number.isFinite(input.thresholds.modelAmbiguityAccuracy) ||
    input.thresholds.modelAmbiguityAccuracy < 0 ||
    input.thresholds.modelAmbiguityAccuracy > 1 ||
    !Number.isFinite(input.thresholds.humanConfusionErrorRate) ||
    input.thresholds.humanConfusionErrorRate < 0 ||
    input.thresholds.humanConfusionErrorRate > 1
  ) {
    throw new TypeError(
      "Game-owned comprehension thresholds must be in [0,1]."
    );
  }
  const human = classifyHumanEvidence(
    input.stage4HumanEvidence,
    accuracy,
    input.thresholds,
    reasons
  );
  const intervention = interventionRiskDifference(
    input.stage5Intervention,
    human.reachedStage === CONSENTED_HUMAN_EVIDENCE,
    reasons
  );
  const highestStageReached =
    intervention.difference === null
      ? human.reachedStage
      : "controlled-intervention";

  return {
    mechanicKey: input.mechanicKey,
    highestStageReached,
    confusionCategory: human.category,
    modelForecastAccuracy: accuracy,
    humanErrorRate: human.errorRate,
    interventionRiskDifference: intervention.difference,
    interventionRiskDifferenceInterval: intervention.interval,
    reasons
  };
}
