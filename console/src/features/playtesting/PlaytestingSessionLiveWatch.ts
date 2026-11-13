"use client";

import { useRouter } from "next/navigation.js";
import React, { useEffect } from "react";

import {
  browserVisibilitySource,
  type VisibilitySource
} from "../../components/navigation/visibility.ts";

export function PlaytestingSessionLiveWatch({
  isLive,
  intervalMs = 1500,
  visibility
}: {
  readonly isLive: boolean;
  readonly intervalMs?: number;
  /**
   * Whether the operator is looking at the page.
   *
   * The watch is a read of the live session, and the session page is the
   * largest page in the Console: every tick re-reads and re-renders the
   * whole session. Doing that for a tab nobody is reading is work nobody
   * asked for.
   */
  readonly visibility?: VisibilitySource | undefined;
}): React.JSX.Element | null {
  let router: ReturnType<typeof useRouter> | null = null;
  try {
    router = useRouter();
  } catch {
    // In environments without AppRouterContext (such as SSR or unit tests)
  }

  // The visibility source is created once: a new one on every render would
  // re-create the interval on every render, which is the thing the gate
  // exists to stop.
  const visibilitySource = React.useMemo(
    () => visibility ?? browserVisibilitySource(),
    [visibility]
  );

  useEffect(() => {
    if (!isLive || !router) {
      // Both paths return a cleanup, so the effect's return type does not
      // depend on whether the watch is live.
      return () => undefined;
    }
    // A watch the operator cannot see is a watch that costs a full
    // re-render of the session page every interval and shows the operator
    // nothing. The page refreshes the moment it is shown again, so the
    // session it comes back to is the live one.
    const refreshIfVisible = (): void => {
      if (!visibilitySource.isVisible()) return;
      router.refresh();
    };
    const timer = setInterval(refreshIfVisible, intervalMs);
    const stopWatchingVisibility = visibilitySource.onVisible(refreshIfVisible);
    return () => {
      clearInterval(timer);
      stopWatchingVisibility();
    };
  }, [isLive, intervalMs, router, visibilitySource]);

  if (!isLive) return null;

  return React.createElement(
    "span",
    {
      className:
        "inline-flex items-center gap-1.5 rounded-full bg-accent/15 px-2.5 py-0.5 text-xs font-semibold text-accent",
      "data-testid": "session-live-watch"
    },
    React.createElement("span", {
      // The dot says the session is live. It does not need to pulse to say
      // so, and a pulse that never stops is motion an operator may have asked
      // the system not to show them.
      className:
        "h-2 w-2 rounded-full bg-accent animate-pulse motion-reduce:animate-none"
    }),
    "Live · Watching session"
  );
}
