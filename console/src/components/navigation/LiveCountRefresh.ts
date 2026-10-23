"use client";

import React from "react";

import {
  LIVE_COUNT_REFRESH_EVENT,
  LIVE_COUNT_REFRESH_INTERVAL_MS,
  startLiveCountRefresh
} from "./live-count-refresh.ts";

/**
 * The owner of the five-second refresh for a view that shows live counts.
 *
 * This component used to render a sentence as well: "Live counts refresh every
 * 5 seconds." The Console removed that sentence from `/agents` as redundant --
 * it describes the implementation rather than the operator's task, and it said
 * nothing an operator could act on -- and then left it on `/providers`,
 * `/agents/{id}`, `/providers/{id}` and `/providers/{id}/models/{model}`, so
 * the same product said it on four of the five surfaces that carry live counts
 * and stayed quiet on the fifth.
 *
 * The refresh itself is the point and it stays: the counts these views render
 * are the Runtime's live projection, and an operator watching a number change
 * needs it to change without pressing anything. What goes is the sentence.
 *
 * There is nothing left to render, so this component renders nothing. It is
 * kept because the interval is client behaviour and the views that need it are
 * server components: it is the smallest place that can own the effect without
 * making five views client components.
 */
export function LiveCountRefresh(): React.JSX.Element | null {
  React.useEffect(
    () =>
      startLiveCountRefresh(() =>
        globalThis.window.dispatchEvent(new Event(LIVE_COUNT_REFRESH_EVENT))
      ),
    []
  );

  return null;
}
