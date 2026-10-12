/** Human change-sensitivity decision rules; interval estimation stays external. */
import type {
  HumanPlaytestStudy,
  PlaytestHumanPreferencePlan
} from "./artifacts.ts";
import { samePlaytestBuild } from "./build-identity.ts";
import {
  type PlaytestNumericInterval,
  PLAYTESTS_HUMAN_STUDY_SCHEMA
} from "./types.ts";

const SHA256_PATTERN = /^[a-f\d]{64}$/u;

export interface PlaytestHumanPreferenceCounts {
  /** Unique eligible participants assigned to the two-build preference task. */
  readonly eligibleParticipants: number;
  readonly preferA: number;
  readonly preferB: number;
  readonly ties: number;
  readonly unableToJudge: number;
  readonly missing: number;
}

export interface PlaytestHumanPreferenceResponse {
  /** Restricted pseudonymous key used only to enforce one response per person. */
  readonly participantKey: string;
  readonly answer: "A" | "B" | "tie" | "unable-to-judge" | null;
}

export interface ClassifyPlaytestPreferenceInput {
  readonly counts: PlaytestHumanPreferenceCounts;
  /** Approved study is the authority for the frozen plan and build pair. */
  readonly study: HumanPlaytestStudy;
  /** External interval for p(B preferred | decisive answer), matching the plan. */
  readonly interval: PlaytestNumericInterval | null;
}

export type PlaytestPreferenceSensitivityDecision =
  | "supports-b-preference"
  | "supports-a-preference"
  | "no-material-preference"
  | "inconclusive";

export interface PlaytestPreferenceSensitivityResult {
  readonly analysisPlanRef: string;
  readonly eligibleParticipants: number;
  readonly decisiveParticipants: number;
  readonly preferA: number;
  readonly preferB: number;
  readonly ties: number;
  readonly unableToJudge: number;
  readonly missing: number;
  readonly excludedParticipants: number;
  readonly exclusionRate: number | null;
  readonly probabilityBPreferred: number | null;
  readonly interval: PlaytestNumericInterval | null;
  readonly decision: PlaytestPreferenceSensitivityDecision;
  readonly reasons: readonly string[];
}

/**
 * Counts one project-authored A/B preference response per eligible participant.
 * Include a null answer for eligible nonresponders so missingness is retained.
 * Participant keys are checked for duplicates and are never returned.
 */
export function aggregatePlaytestPreferenceResponses(
  responses: readonly PlaytestHumanPreferenceResponse[]
): PlaytestHumanPreferenceCounts {
  const seen = new Set<string>();
  const counts = {
    eligibleParticipants: responses.length,
    preferA: 0,
    preferB: 0,
    ties: 0,
    unableToJudge: 0,
    missing: 0
  };
  for (const response of responses) {
    if (
      typeof response.participantKey !== "string" ||
      response.participantKey.trim().length === 0
    ) {
      throw new TypeError("Preference participantKey must be non-empty.");
    }
    const participantKey = response.participantKey.trim();
    if (seen.has(participantKey)) {
      throw new TypeError(
        "Preference data must contain no more than one row per participant."
      );
    }
    seen.add(response.participantKey.trim());
    switch (response.answer) {
      case "A": {
        counts.preferA += 1;
        break;
      }
      case "B": {
        counts.preferB += 1;
        break;
      }
      case "tie": {
        counts.ties += 1;
        break;
      }
      case "unable-to-judge": {
        counts.unableToJudge += 1;
        break;
      }
      case null: {
        counts.missing += 1;
        break;
      }
      default: {
        throw new TypeError(
          "Preference answer is outside its closed vocabulary."
        );
      }
    }
  }
  return counts;
}

function assertCount(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(label + " must be a non-negative safe integer.");
  }
}

function assertInterval(interval: PlaytestNumericInterval): void {
  if (
    !Number.isFinite(interval.lower) ||
    !Number.isFinite(interval.upper) ||
    interval.lower < 0 ||
    interval.upper > 1 ||
    interval.lower > interval.upper ||
    typeof interval.method !== "string" ||
    interval.method.trim().length === 0 ||
    typeof interval.libraryVersion !== "string" ||
    interval.libraryVersion.trim().length === 0 ||
    !Number.isFinite(interval.confidenceLevel) ||
    interval.confidenceLevel <= 0 ||
    interval.confidenceLevel >= 1 ||
    (interval.resamples !== null &&
      (!Number.isSafeInteger(interval.resamples) || interval.resamples < 1)) ||
    (interval.seed !== null &&
      (typeof interval.seed !== "string" ||
        interval.seed.trim().length === 0)) ||
    (interval.resamples !== null && interval.seed === null)
  ) {
    throw new TypeError(
      "Preference interval must be a valid, provenance-backed probability interval."
    );
  }
}

function assertPreferencePlanShape(plan: PlaytestHumanPreferencePlan): void {
  if (
    typeof plan !== "object" ||
    plan === null ||
    typeof plan.interval !== "object" ||
    plan.interval === null
  ) {
    throw new TypeError("Human preference plan is invalid.");
  }
  if (
    typeof plan.analysisPlanRef !== "string" ||
    plan.analysisPlanRef.trim().length === 0 ||
    typeof plan.questionVersion !== "string" ||
    plan.questionVersion.trim().length === 0 ||
    typeof plan.questionHash !== "string" ||
    !SHA256_PATTERN.test(plan.questionHash) ||
    !Number.isFinite(plan.maximumExclusionRate) ||
    plan.maximumExclusionRate < 0 ||
    plan.maximumExclusionRate >= 1 ||
    !Number.isFinite(plan.practicalMargin) ||
    plan.practicalMargin < 0 ||
    plan.practicalMargin >= 0.5 ||
    !Number.isSafeInteger(plan.minimumIndependentParticipants) ||
    plan.minimumIndependentParticipants < 1 ||
    typeof plan.interval.method !== "string" ||
    plan.interval.method.trim().length === 0 ||
    typeof plan.interval.libraryVersion !== "string" ||
    plan.interval.libraryVersion.trim().length === 0 ||
    !Number.isFinite(plan.interval.confidenceLevel) ||
    plan.interval.confidenceLevel <= 0 ||
    plan.interval.confidenceLevel >= 1 ||
    (plan.interval.resamples !== null &&
      (!Number.isSafeInteger(plan.interval.resamples) ||
        plan.interval.resamples < 1)) ||
    (plan.interval.seed !== null &&
      (typeof plan.interval.seed !== "string" ||
        plan.interval.seed.trim().length === 0)) ||
    (plan.interval.resamples !== null && plan.interval.seed === null) ||
    (plan.interval.resamples === null && plan.interval.seed !== null)
  ) {
    throw new TypeError("Human preference plan is invalid.");
  }
  assertVersionedReference(plan.buildA, "buildA");
  assertVersionedReference(plan.buildB, "buildB");
  if (samePlaytestBuild(plan.buildA, plan.buildB)) {
    throw new TypeError(
      "Human preference plan must compare two distinct builds."
    );
  }
}

function assertVersionedReference(
  build: PlaytestHumanPreferencePlan["buildA"],
  label: string
): void {
  if (
    !build ||
    typeof build.id !== "string" ||
    build.id.trim().length === 0 ||
    !(typeof build.version === "string"
      ? build.version.trim().length > 0
      : Number.isSafeInteger(build.version) && build.version >= 1) ||
    typeof build.contentHash !== "string" ||
    !SHA256_PATTERN.test(build.contentHash)
  ) {
    throw new TypeError(
      "Human preference plan " + label + " reference is invalid."
    );
  }
}

/** Bind the optional plan to the exact builds in an approved, counterbalanced study. */
export function assertHumanStudyPreferencePlan(
  study: HumanPlaytestStudy
): void {
  const plan = study.preferencePlan;
  if (plan === undefined) return;
  assertPreferencePlanShape(plan);
  const matchesAllowedBuild = (
    planned: PlaytestHumanPreferencePlan["buildA"]
  ): boolean =>
    study.allowedBuilds.some((allowed) => samePlaytestBuild(allowed, planned));
  if (
    study.schema !== PLAYTESTS_HUMAN_STUDY_SCHEMA ||
    study.approved !== true ||
    study.orderDesign !== "AB/BA" ||
    study.independentUnit !== "participant" ||
    !matchesAllowedBuild(plan.buildA) ||
    !matchesAllowedBuild(plan.buildB)
  ) {
    throw new TypeError(
      "Preference plan requires an approved, counterbalanced participant-level study of two allowed builds."
    );
  }
}

function assertInput(
  input: ClassifyPlaytestPreferenceInput
): PlaytestHumanPreferencePlan {
  const { counts } = input;
  assertCount(counts.eligibleParticipants, "eligibleParticipants");
  assertCount(counts.preferA, "preferA");
  assertCount(counts.preferB, "preferB");
  assertCount(counts.ties, "ties");
  assertCount(counts.unableToJudge, "unableToJudge");
  assertCount(counts.missing, "missing");
  const partitionTotal =
    counts.preferA +
    counts.preferB +
    counts.ties +
    counts.unableToJudge +
    counts.missing;
  if (
    !Number.isSafeInteger(partitionTotal) ||
    partitionTotal !== counts.eligibleParticipants
  ) {
    throw new TypeError(
      "Preference response counts must partition all eligible participants."
    );
  }
  assertHumanStudyPreferencePlan(input.study);
  const plan = input.study.preferencePlan;
  if (plan === undefined) {
    throw new TypeError("Approved human study has no preference plan.");
  }
  assertPreferencePlanShape(plan);
  if (input.interval !== null) {
    if (counts.preferA + counts.preferB === 0) {
      throw new TypeError(
        "A preference interval requires at least one decisive response."
      );
    }
    assertInterval(input.interval);
    if (
      input.interval.method !== plan.interval.method ||
      input.interval.libraryVersion !== plan.interval.libraryVersion ||
      input.interval.confidenceLevel !== plan.interval.confidenceLevel ||
      input.interval.resamples !== plan.interval.resamples ||
      input.interval.seed !== plan.interval.seed
    ) {
      throw new TypeError(
        "Preference interval provenance does not match the frozen study plan."
      );
    }
  }
  return plan;
}

/**
 * Applies the preregistered exclusion, precision and practical-margin gates
 * to an externally estimated participant-level preference interval. This
 * function does not calculate confidence intervals or promote a game build.
 */
export function classifyPlaytestPreferenceSensitivity(
  input: ClassifyPlaytestPreferenceInput
): PlaytestPreferenceSensitivityResult {
  const plan = assertInput(input);
  const { counts } = input;
  const decisiveParticipants = counts.preferA + counts.preferB;
  const excludedParticipants =
    counts.ties + counts.unableToJudge + counts.missing;
  const exclusionRate =
    counts.eligibleParticipants === 0
      ? null
      : excludedParticipants / counts.eligibleParticipants;
  const probabilityBPreferred =
    decisiveParticipants === 0 ? null : counts.preferB / decisiveParticipants;
  const reasons: string[] = [];

  if (
    counts.eligibleParticipants < plan.minimumIndependentParticipants ||
    decisiveParticipants < plan.minimumIndependentParticipants
  ) {
    reasons.push("insufficient-independent-participants");
  }
  if (exclusionRate === null || exclusionRate > plan.maximumExclusionRate) {
    reasons.push("exclusion-rate-exceeds-preregistered-maximum");
  }
  if (input.interval === null) reasons.push("preference-interval-unavailable");

  let decision: PlaytestPreferenceSensitivityDecision = "inconclusive";
  if (reasons.length === 0 && input.interval !== null) {
    const chance = 0.5;
    const lowerMeaningful = chance + plan.practicalMargin;
    const upperMeaningful = chance - plan.practicalMargin;
    if (input.interval.lower > lowerMeaningful) {
      decision = "supports-b-preference";
    } else if (input.interval.upper < upperMeaningful) {
      decision = "supports-a-preference";
    } else if (
      input.interval.lower >= upperMeaningful &&
      input.interval.upper <= lowerMeaningful
    ) {
      decision = "no-material-preference";
    } else {
      reasons.push("interval-does-not-clear-preference-or-equivalence-margin");
    }
  }

  return {
    analysisPlanRef: plan.analysisPlanRef,
    eligibleParticipants: counts.eligibleParticipants,
    decisiveParticipants,
    preferA: counts.preferA,
    preferB: counts.preferB,
    ties: counts.ties,
    unableToJudge: counts.unableToJudge,
    missing: counts.missing,
    excludedParticipants,
    exclusionRate,
    probabilityBPreferred,
    interval: input.interval,
    decision,
    reasons
  };
}
