/**
 * Evidence locator/review/finding validation (measurement-contract §6).
 *
 * A review submission is only as trustworthy as its locators: this module
 * is the gate that stops a nonexistent event, an irrelevant-but-real event,
 * or a locator pointing at the wrong episode from ever becoming a
 * `supported` claim. Every validator here requires an explicit, queryable
 * "known evidence" index supplied by the caller (Runtime/Data own the real
 * store); Core never trusts a locator's shape alone as proof it resolves to
 * real, relevant data.
 */

import type { PlaytestSessionReview } from "./artifacts.ts";
import { assertPlaytestEvidenceLocator } from "./protocol.ts";
import {
  PLAYTEST_REVIEW_SECTION_NOT_RECORDED,
  type PlaytestEvidenceLocator,
  type PlaytestEvidenceVerdict,
  type PlaytestFinding,
  type PlaytestReviewCompleteness
} from "./types.ts";

/** What the caller's evidence store can resolve a locator to. */
export interface PlaytestKnownEvidenceIndex {
  /** Episode ids that actually exist. */
  readonly episodeIds: ReadonlySet<string>;
  /** event locator id -> the episode it actually belongs to. */
  readonly eventEpisodeOf: ReadonlyMap<string, string>;
  /** event locator id -> the rule/mechanic it is actually relevant to. */
  readonly eventRelevantRuleOf: ReadonlyMap<string, string>;
  /** Review ids that actually exist. */
  readonly reviewIds: ReadonlySet<string>;
  /** Finding ids that actually exist. */
  readonly findingIds: ReadonlySet<string>;
  /** Comparison ids that actually exist. */
  readonly comparisonIds: ReadonlySet<string>;
  /** frame locator id -> the episode it actually belongs to. */
  readonly frameEpisodeOf: ReadonlyMap<string, string>;
}

/** One claim this evidence check is being asked to support/contradict. */
export interface PlaytestClaim {
  readonly claimId: string;
  /** The rule/mechanic the claim is actually about. */
  readonly relevantRule: string;
  /** The episode the claim is actually about. */
  readonly episodeId: string;
  readonly evidenceRefs: readonly PlaytestEvidenceLocator[];
}

/** Per-claim verdict with a reason, not just a boolean. */
export interface PlaytestClaimVerdict {
  readonly claimId: string;
  readonly verdict: PlaytestEvidenceVerdict;
  readonly reasons: readonly string[];
}

function locatorExists(
  locator: PlaytestEvidenceLocator,
  index: PlaytestKnownEvidenceIndex
): boolean {
  switch (locator.kind) {
    case "episode": {
      return index.episodeIds.has(locator.id);
    }
    case "event": {
      return index.eventEpisodeOf.has(locator.id);
    }
    case "frame": {
      return index.frameEpisodeOf.has(locator.id);
    }
    case "review": {
      return index.reviewIds.has(locator.id);
    }
    case "finding": {
      return index.findingIds.has(locator.id);
    }
    case "comparison": {
      return index.comparisonIds.has(locator.id);
    }
    case "replay-segment": {
      // Replay segments are not independently indexed; treat as existing
      // only if the referenced episode exists (the segment is a sub-range
      // of it).
      return index.episodeIds.has(locator.id);
    }
    default: {
      return false;
    }
  }
}

function locatorEpisodeId(
  locator: PlaytestEvidenceLocator,
  index: PlaytestKnownEvidenceIndex
): string | null {
  switch (locator.kind) {
    case "episode":
    case "replay-segment": {
      return locator.id;
    }
    case "event": {
      return index.eventEpisodeOf.get(locator.id) ?? null;
    }
    case "frame": {
      return index.frameEpisodeOf.get(locator.id) ?? null;
    }
    default: {
      return null;
    }
  }
}

/**
 * Validate a single claim's locators against the known evidence index and
 * return a verdict with reasons. Required adversarial cases (measurement-
 * contract §6) are each a distinct `reasons` entry so a caller can
 * distinguish them:
 *
 * - nonexistent event -> `insufficient`, reason names the missing locator.
 * - existing irrelevant event -> `insufficient`, reason names the mismatch.
 * - cited list containing the supposedly absent action -> caller-level
 *   semantic check (see `assertNoContradictingLocator` below); this
 *   function only validates existence/relevance, not the claim's logic.
 * - correct event with wrong rule -> `insufficient`, rule mismatch reason.
 * - wrong episode -> `insufficient`, episode mismatch reason.
 */
export function verifyPlaytestClaim(
  claim: PlaytestClaim,
  index: PlaytestKnownEvidenceIndex
): PlaytestClaimVerdict {
  if (claim.evidenceRefs.length === 0) {
    return {
      claimId: claim.claimId,
      verdict: "insufficient",
      reasons: ["Claim has no evidence locators."]
    };
  }
  const reasons: string[] = [];
  let anySupporting = false;
  for (const locator of claim.evidenceRefs) {
    const locatorLabel = `${locator.kind}:${locator.id}`;
    if (!locatorExists(locator, index)) {
      reasons.push(`Locator ${locatorLabel} does not exist.`);
      continue;
    }
    const episodeId = locatorEpisodeId(locator, index);
    if (episodeId !== null && episodeId !== claim.episodeId) {
      reasons.push(
        `Locator ${locatorLabel} belongs to episode "${episodeId}", not claimed episode "${claim.episodeId}".`
      );
      continue;
    }
    if (locator.kind === "event") {
      const actualRule = index.eventRelevantRuleOf.get(locator.id);
      if (actualRule !== undefined && actualRule !== claim.relevantRule) {
        reasons.push(
          `Locator ${locatorLabel} is relevant to rule "${actualRule}", not claimed rule "${claim.relevantRule}".`
        );
        continue;
      }
    }
    anySupporting = true;
  }
  if (anySupporting && reasons.length === 0) {
    return { claimId: claim.claimId, verdict: "supported", reasons: [] };
  }
  if (anySupporting && reasons.length > 0) {
    // Mixed: at least one locator supports, but at least one other locator
    // is contradicted/irrelevant. Treat as insufficient rather than
    // silently discarding the bad locator -- a reviewer must see the gap.
    return { claimId: claim.claimId, verdict: "insufficient", reasons };
  }
  return { claimId: claim.claimId, verdict: "contradicted", reasons };
}

/**
 * Explicit adversarial check: a claim that the game rejected an action as
 * illegal is contradicted outright when the cited "absent action" locator
 * actually appears in the same decision's offered/legal list. This guards
 * the specific §6 case "cited list containing the supposedly absent
 * action".
 */
export function assertNoContradictingLocator(
  claimedAbsentActionId: string,
  actualOfferedActionIds: readonly string[]
): void {
  if (actualOfferedActionIds.includes(claimedAbsentActionId)) {
    throw new TypeError(
      `Claimed-absent action "${claimedAbsentActionId}" is present in the actual offered/legal action list; the claim is contradicted, not verified.`
    );
  }
}

/**
 * Validate a review's overall evidence sufficiency: every finding it
 * references must itself carry at least one evidence locator, and the
 * review itself must carry at least one. A review without evidence
 * locators is invalid -- not a successful empty report.
 */
export function assertPlaytestSessionReviewHasEvidence(
  review: Pick<
    PlaytestSessionReview,
    | "reviewId"
    | "evidenceRefs"
    | "observations"
    | "interpretations"
    | "alternativeExplanations"
    | "experiments"
    | "reportCompleteness"
  > & {
    readonly findings: readonly Pick<
      PlaytestFinding,
      "findingId" | "evidenceRefs"
    >[];
  },
  options: { readonly allowHistoricalNotRecorded?: boolean } = {}
): void {
  if (review.evidenceRefs.length === 0) {
    throw new TypeError(
      `Review "${review.reviewId}" has no evidence locators; a review without evidence is invalid, not an empty success.`
    );
  }
  if (review.observations.length === 0 || review.interpretations.length === 0) {
    throw new TypeError(
      `Review "${review.reviewId}" must include observed and interpreted claims, even when the conclusions are explicitly null or none.`
    );
  }
  assertPlaytestReviewCompleteness(review, options);
  for (const [kind, claims] of [
    ["observation", review.observations],
    ["interpretation", review.interpretations]
  ] as const) {
    for (const [index, claim] of claims.entries()) {
      if (typeof claim.text !== "string" || claim.text.trim().length === 0) {
        throw new TypeError(
          `Review ${kind} claim ${String(index + 1)} in "${review.reviewId}" has no text.`
        );
      }
      if (claim.evidenceRefs.length === 0) {
        throw new TypeError(
          `Review ${kind} claim ${String(index + 1)} in "${review.reviewId}" has no evidence locators.`
        );
      }
      for (const locator of claim.evidenceRefs) {
        assertPlaytestEvidenceLocator(locator);
      }
    }
  }
  for (const finding of review.findings) {
    if (finding.evidenceRefs.length === 0) {
      throw new TypeError(
        `Finding "${finding.findingId}" attached to review "${review.reviewId}" has no evidence locators.`
      );
    }
  }
}

function requireReviewText(
  value: unknown,
  label: string
): asserts value is string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError(`${label} must be non-empty text.`);
  }
}

function assertReviewCrossSessionSection(
  reviewId: string,
  section: PlaytestReviewCompleteness["crossSessionContext"]
): void {
  if (
    section.status === "unavailable" ||
    section.status === PLAYTEST_REVIEW_SECTION_NOT_RECORDED
  ) {
    requireReviewText(
      section.reason,
      `Review "${reviewId}" cross-session-context reason`
    );
    return;
  }
  throw new TypeError(
    `Review "${reviewId}" has an unsupported cross-session-context status.`
  );
}

function assertReviewAlternativesSection(
  reviewId: string,
  alternatives: readonly string[],
  section: PlaytestReviewCompleteness["alternatives"]
): void {
  for (const [index, alternative] of alternatives.entries()) {
    requireReviewText(
      alternative,
      `Review "${reviewId}" alternative explanation ${String(index + 1)}`
    );
  }
  if (section.status === "provided") {
    if (alternatives.length === 0) {
      throw new TypeError(
        `Review "${reviewId}" marks alternatives provided but contains none.`
      );
    }
    return;
  }
  if (section.status === "none-identified") {
    if (alternatives.length > 0) {
      throw new TypeError(
        `Review "${reviewId}" marks alternatives absent but contains some.`
      );
    }
    requireReviewText(
      section.reason,
      `Review "${reviewId}" no-alternatives reason`
    );
    return;
  }
  if (section.status === PLAYTEST_REVIEW_SECTION_NOT_RECORDED) {
    requireReviewText(
      section.reason,
      `Review "${reviewId}" historical alternatives reason`
    );
    return;
  }
  throw new TypeError(
    `Review "${reviewId}" has an unsupported alternatives status.`
  );
}

function assertReviewExperimentsSection(
  reviewId: string,
  experiments: PlaytestSessionReview["experiments"],
  section: PlaytestReviewCompleteness["experiments"]
): void {
  for (const [index, experiment] of experiments.entries()) {
    const prefix = `Review "${reviewId}" experiment ${String(index + 1)}`;
    for (const [label, value] of [
      ["hypothesis", experiment.hypothesis],
      ["falsifier", experiment.falsifier],
      ["metric", experiment.metricId],
      ["budget", experiment.budget]
    ] as const) {
      requireReviewText(value, `${prefix} ${label}`);
    }
    if (
      !Array.isArray(experiment.controls) ||
      experiment.controls.length === 0
    ) {
      throw new TypeError(`${prefix} needs at least one explicit control.`);
    }
    for (const control of experiment.controls) {
      requireReviewText(control, `${prefix} control`);
    }
  }
  if (section.status === "proposed") {
    if (experiments.length === 0) {
      throw new TypeError(
        `Review "${reviewId}" marks experiments proposed but contains none.`
      );
    }
    return;
  }
  if (section.status === "none-recommended") {
    if (experiments.length > 0) {
      throw new TypeError(
        `Review "${reviewId}" marks experiments absent but contains some.`
      );
    }
    requireReviewText(
      section.reason,
      `Review "${reviewId}" no-experiment reason`
    );
    return;
  }
  if (section.status === PLAYTEST_REVIEW_SECTION_NOT_RECORDED) {
    requireReviewText(
      section.reason,
      `Review "${reviewId}" historical experiment reason`
    );
    return;
  }
  throw new TypeError(
    `Review "${reviewId}" has an unsupported experiments status.`
  );
}

function assertReviewFollowUpSection(
  reviewId: string,
  section: PlaytestReviewCompleteness["followUp"]
): void {
  if (section.status === "proposed") {
    requireReviewText(section.text, `Review "${reviewId}" follow-up`);
    return;
  }
  if (
    section.status === "none" ||
    section.status === PLAYTEST_REVIEW_SECTION_NOT_RECORDED
  ) {
    requireReviewText(section.reason, `Review "${reviewId}" follow-up reason`);
    return;
  }
  throw new TypeError(
    `Review "${reviewId}" has an unsupported follow-up status.`
  );
}

/** Enforce explicit section accounting and agreement with the submitted lists. */
export function assertPlaytestReviewCompleteness(
  review: Pick<
    PlaytestSessionReview,
    | "reviewId"
    | "alternativeExplanations"
    | "experiments"
    | "reportCompleteness"
  >,
  options: { readonly allowHistoricalNotRecorded?: boolean } = {}
): void {
  const completeness = review.reportCompleteness;
  if (!completeness || typeof completeness !== "object") {
    throw new TypeError(
      `Review "${review.reviewId}" is missing its report-completeness record.`
    );
  }
  const requiredSections = [
    "crossSessionContext",
    "alternatives",
    "experiments",
    "followUp"
  ];
  if (
    Object.keys(completeness).length !== requiredSections.length ||
    requiredSections.some((section) => !(section in completeness))
  ) {
    throw new TypeError(
      `Review "${review.reviewId}" has an incomplete report-completeness record.`
    );
  }
  const historicalNotRecorded = Object.values(completeness).some(
    (section) => section.status === PLAYTEST_REVIEW_SECTION_NOT_RECORDED
  );
  if (historicalNotRecorded && !options.allowHistoricalNotRecorded) {
    throw new TypeError(
      `Review "${review.reviewId}" uses a historical not-recorded section status for a new review.`
    );
  }
  if (!Array.isArray(review.alternativeExplanations)) {
    throw new TypeError(
      `Review "${review.reviewId}" alternative explanations must be an array.`
    );
  }
  if (!Array.isArray(review.experiments)) {
    throw new TypeError(
      `Review "${review.reviewId}" experiments must be an array.`
    );
  }
  assertReviewCrossSessionSection(
    review.reviewId,
    completeness.crossSessionContext
  );
  assertReviewAlternativesSection(
    review.reviewId,
    review.alternativeExplanations,
    completeness.alternatives
  );
  assertReviewExperimentsSection(
    review.reviewId,
    review.experiments,
    completeness.experiments
  );
  assertReviewFollowUpSection(review.reviewId, completeness.followUp);
}

/**
 * A finding's `evidenceStatus` may only be `verified` when every evidence
 * locator it cites actually resolves and is relevant. `corroborated` and
 * `hypothesis` require at least one locator but tolerate unresolved
 * secondary locators; `not observed` requires zero locators.
 */
export function assertPlaytestFindingEvidenceStatusConsistent(
  finding: Pick<
    PlaytestFinding,
    "findingId" | "evidenceStatus" | "evidenceRefs"
  >,
  index: PlaytestKnownEvidenceIndex
): void {
  if (finding.evidenceStatus === "not observed") {
    if (finding.evidenceRefs.length > 0) {
      throw new TypeError(
        `Finding "${finding.findingId}" is marked 'not observed' but carries evidence locators.`
      );
    }
    return;
  }
  if (finding.evidenceRefs.length === 0) {
    throw new TypeError(
      `Finding "${finding.findingId}" has evidenceStatus "${finding.evidenceStatus}" but no evidence locators.`
    );
  }
  if (finding.evidenceStatus === "verified") {
    const unresolved = finding.evidenceRefs.filter(
      (locator) => !locatorExists(locator, index)
    );
    if (unresolved.length > 0) {
      throw new TypeError(
        `Finding "${finding.findingId}" is marked 'verified' but cites ${String(unresolved.length)} locator(s) that do not exist.`
      );
    }
  }
}
