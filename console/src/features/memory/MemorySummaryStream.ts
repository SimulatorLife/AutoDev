"use client";

import React from "react";

import { MemorySummary, type MemorySummaryCounts } from "./MemorySummary.ts";

const UNOBSERVED_COUNTS: MemorySummaryCounts = {
  records: null,
  experiences: null,
  cohortSessions: null
};

interface ResolvedCounts {
  readonly source: PromiseLike<MemorySummaryCounts>;
  readonly counts: MemorySummaryCounts;
}

/**
 * Delivers the streamed counts to `settle` once they arrive, or unobserved
 * counts when the stream fails, so a failed stream is an unobserved summary
 * and never a stuck spinner.
 *
 * React Flight hands the client a thenable, not a native promise: it has no
 * `catch`, and its `then` returns nothing to chain from. `Promise.resolve`
 * adopts it into a native promise before anything is chained.
 */
export function observeSummaryCounts(
  counts: PromiseLike<MemorySummaryCounts>,
  settle: (counts: MemorySummaryCounts) => void
): Promise<void> {
  return Promise.resolve(counts).then(settle, () => settle(UNOBSERVED_COUNTS));
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
  readonly counts: PromiseLike<MemorySummaryCounts>;
}): React.JSX.Element {
  const [resolved, setResolved] = React.useState<ResolvedCounts | null>(null);
  React.useEffect(() => {
    let current = true;
    void observeSummaryCounts(counts, (value) => {
      if (current) setResolved({ source: counts, counts: value });
    });
    return () => {
      current = false;
    };
  }, [counts]);
  return React.createElement(MemorySummary, {
    counts: resolved?.counts,
    stale: resolved !== null && resolved.source !== counts
  });
}
