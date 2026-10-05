import React from "react";

import { StatCard } from "../../components/cards/StatCard.ts";

/** Observed scope-wide counts; `null` marks a count that was not observed. */
export interface MemorySummaryCounts {
  readonly records: {
    readonly total: number;
    readonly inScope: number;
    readonly active: number;
  } | null;
  readonly experiences: {
    readonly total: number;
    readonly inScope: number;
  } | null;
  readonly cohortSessions: number | null;
}

export interface MemorySummaryProps {
  /** `undefined` while the first counts for this view are still loading. */
  readonly counts?: MemorySummaryCounts | undefined;
  /** The counts shown belong to the previous scope and are being refreshed. */
  readonly stale?: boolean | undefined;
}

const NOT_OBSERVED_LABEL = "Not observed";
const PENDING_LABEL = "…";

/**
 * Scope-wide Memory summary cards. An unobserved count renders
 * "Not observed" rather than a synthesized zero.
 */
export function MemorySummary({
  counts,
  stale = false
}: MemorySummaryProps): React.JSX.Element {
  const pending = counts === undefined;
  const value = (observed: number | null | undefined): string | number =>
    pending ? PENDING_LABEL : (observed ?? NOT_OBSERVED_LABEL);
  const inScope = (observed: number | undefined): string =>
    pending || observed === undefined ? "" : `${observed} in scope`;
  return React.createElement(
    "div",
    {
      className: `grid grid-cols-2 sm:grid-cols-4 gap-4 transition-opacity ${
        stale ? "opacity-60" : ""
      }`,
      "aria-busy": pending || stale ? "true" : undefined,
      "data-memory-summary": pending ? "pending" : stale ? "stale" : "observed"
    },
    React.createElement(StatCard, {
      title: "Durable Records",
      value: value(counts?.records?.total),
      subtitle: inScope(counts?.records?.inScope)
    }),
    React.createElement(StatCard, {
      title: "Active Claims",
      value: value(counts?.records?.active),
      subtitle: "Verified & in service"
    }),
    React.createElement(StatCard, {
      title: "Experiences",
      value: value(counts?.experiences?.total),
      subtitle: inScope(counts?.experiences?.inScope)
    }),
    React.createElement(StatCard, {
      title: "Cohort Sessions",
      value: value(counts?.cohortSessions),
      subtitle: "In window"
    })
  );
}
