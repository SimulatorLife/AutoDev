import type {
  ExperienceOutcome,
  ExperienceValidationState,
  MemoryReasonCode,
  MemoryStatus
} from "@simulatorlife/autodev-core";

import type { StatusBadgeVariant } from "../../components/status/StatusBadge.ts";

/**
 * The Memory lifecycle vocabulary, in one place.
 *
 * These were three separate declarations split across two files: the labels and
 * the order lived in `MemoryView`, the tone map lived in `MemoryRecordsView`, and
 * the badge label was additionally recomputed per row by capitalizing the wire
 * key. Three ways to say the same five things, which is precisely the arrangement
 * that let the rollup chart and the records table disagree — and which would let
 * a sixth status be added to one and silently missed by the other.
 *
 * `MemoryStatus` is a union, so each table below is exhaustively checked:
 * adding a status without deciding its word, its tone and its place in the order
 * is a typecheck failure rather than a blank cell or a missing bar.
 */

export const NOT_OBSERVED_STATUS = "not-observed" as const;

/**
 * Lifecycle statuses in an order a reader can act on.
 *
 * The order is the argument rather than the vocabulary's: proposed is what a
 * curator still has work to do, active is the healthy middle, and the three
 * terminal states are what a reader is looking for when they ask whether memory
 * is any good. An alphabetical list would put `invalidated` between them.
 */
export const MEMORY_STATUS_ORDER: readonly MemoryStatus[] = [
  "proposed",
  "active",
  "uncertain",
  "superseded",
  "invalidated"
];

/** The word each lifecycle status is called, everywhere it appears. */
export const MEMORY_STATUS_LABEL: Record<MemoryStatus, string> = {
  proposed: "Proposed",
  active: "Active",
  uncertain: "Uncertain",
  superseded: "Superseded",
  invalidated: "Invalidated"
};

/** The shared status tone each lifecycle status wears on a badge. */
export const MEMORY_STATUS_VARIANT: Record<MemoryStatus, StatusBadgeVariant> = {
  active: "ready",
  proposed: "pending",
  invalidated: "invalid",
  superseded: "unavailable",
  uncertain: NOT_OBSERVED_STATUS
};

/**
 * How far an experience's result was checked, in words and in tones.
 *
 * Both call sites used to derive the word from the wire key — one through
 * `state.replace("_", " ")`, which turned `not_run` into a lowercase `not run`
 * on the Validation column, and one which passed `not_run` through untouched so
 * the detail panel's badge showed an operator a raw snake_case token. Keyed by
 * Core's union, so the next state the Runtime adds is a typecheck failure rather
 * than a new string nobody chose.
 *
 * An unrecognised state leaves the label `undefined`, which makes the badge fall
 * back to naming its own tone — `Not observed` — the honest reading of a state
 * this build has no evidence for.
 */
export const MEMORY_VALIDATION_LABEL: Record<
  ExperienceValidationState,
  string
> = {
  passed: "Passed",
  failed: "Failed",
  partial: "Partial",
  not_run: "Not run"
};

export const MEMORY_VALIDATION_VARIANT: Record<
  ExperienceValidationState,
  StatusBadgeVariant
> = {
  passed: "valid",
  failed: "invalid",
  partial: "pending",
  not_run: NOT_OBSERVED_STATUS
};

/**
 * What an experience's run is called, keyed by Core's `ExperienceOutcome`.
 *
 * The column rendered the wire key verbatim, so the table read `success` and
 * `partial` in lowercase beside a Validation column reading `Not run`.
 *
 * `unknown` is the one entry that overlaps the missing-evidence vocabulary, and
 * it is deliberate: Core declares it as a reported outcome, distinct from
 * "nothing was reported". The Console's one-word-for-missing-evidence guard
 * skips this module for the same reason it skips `StatusBadge.ts` — this is a
 * declaration of the vocabulary, not a view inventing a word.
 */
export const MEMORY_OUTCOME_LABEL: Record<ExperienceOutcome, string> = {
  success: "Success",
  partial: "Partial",
  failure: "Failure",
  cancelled: "Cancelled",
  unknown: "Unknown"
};

/**
 * The word each lifecycle reason is called, everywhere it appears.
 *
 * Exhaustive over `MemoryReasonCode` for the same reason as the tables above:
 * the Runtime's reason vocabulary is a union, and a transition that renders
 * `superseded_by_newer_evidence` raw reads as a database key rather than as the
 * answer to "why did this claim stop being trustworthy".
 *
 * Two codes are deliberately given the same word where they mean the same
 * thing. `superseded_by_newer_evidence` is written when *this service* replaced
 * a record with a newer one; `superseded` is written when a verifier found the
 * record's cited evidence had itself been superseded. Those are different
 * provenance and the action column beside them says which happened.
 */
export const MEMORY_REASON_LABEL: Record<MemoryReasonCode, string> = {
  candidate_submitted: "Proposed for review",
  revised_after_review: "Revised after review",
  verified_current_state: "Verified against current state",
  promoted_to_skill: "Promoted to a canonical skill",
  verification_inconclusive: "Verification was inconclusive",
  current_state_conflict: "Conflicts with current state",
  superseded_by_newer_evidence: "Superseded by newer evidence",
  invalidated_by_curator: "Invalidated by a curator",
  stale: "Stale",
  contradicted: "Contradicted by current state",
  superseded: "Cited evidence was superseded",
  low_relevance: "Too low relevance",
  uncertain: "Uncertain",
  rejected: "Rejected",
  scope_mismatch: "Outside this reader's scope",
  missing_provenance: "Provenance is missing",
  invalidated: "Invalidated",
  unknown: "Reason not reported"
};
