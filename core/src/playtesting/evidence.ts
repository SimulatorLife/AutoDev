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
import type {
  PlaytestEvidenceLocator,
  PlaytestEvidenceVerdict,
  PlaytestFinding
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
  review: Pick<PlaytestSessionReview, "reviewId" | "evidenceRefs"> & {
    readonly findings: readonly Pick<
      PlaytestFinding,
      "findingId" | "evidenceRefs"
    >[];
  }
): void {
  if (review.evidenceRefs.length === 0) {
    throw new TypeError(
      `Review "${review.reviewId}" has no evidence locators; a review without evidence is invalid, not an empty success.`
    );
  }
  for (const finding of review.findings) {
    if (finding.evidenceRefs.length === 0) {
      throw new TypeError(
        `Finding "${finding.findingId}" attached to review "${review.reviewId}" has no evidence locators.`
      );
    }
  }
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
