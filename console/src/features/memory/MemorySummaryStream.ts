"use client";

import React from "react";

import { MemorySummary, type MemorySummaryCounts } from "./MemorySummary.ts";

const UNOBSERVED_COUNTS: MemorySummaryCounts = {
  records: null,
  experiences: null,
  cohortSessions: null
};

interface ResolvedCounts {
  readonly source: Promise<MemorySummaryCounts>;
  readonly counts: MemorySummaryCounts;
}

/**
 * Renders summary counts that the server streams after the page itself.
 *
 * The promise is resolved outside React's suspension: a Suspense boundary
 * that is already showing content cannot fall back during a navigation
 * transition, so suspending here would hold every tab switch until the
 * summary reads finish. Instead the previous counts stay visible (dimmed and
 * marked busy) until the new ones arrive, and the active tab commits as soon
 * as its own data is ready.
 */
export function MemorySummaryStream({
  counts
}: {
  readonly counts: Promise<MemorySummaryCounts>;
}): React.JSX.Element {
  const [resolved, setResolved] = React.useState<ResolvedCounts | null>(null);
  React.useEffect(() => {
    let current = true;
    const settle = (value: MemorySummaryCounts): void => {
      if (current) setResolved({ source: counts, counts: value });
    };
    // A failed stream is an unobserved summary, never a stuck spinner.
    counts.then(settle).catch(() => settle(UNOBSERVED_COUNTS));
    return () => {
      current = false;
    };
  }, [counts]);
  return React.createElement(MemorySummary, {
    counts: resolved?.counts,
    stale: resolved !== null && resolved.source !== counts
  });
}
