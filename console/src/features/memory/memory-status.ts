import type { MemoryStatus } from "@simulatorlife/autodev-core";

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
