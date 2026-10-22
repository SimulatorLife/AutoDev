"use client";

import { useRouter } from "next/navigation.js";
import React, { useEffect } from "react";

export function PlaytestingSessionLiveWatch({
  isLive,
  intervalMs = 1500
}: {
  readonly isLive: boolean;
  readonly intervalMs?: number;
}): React.JSX.Element | null {
  let router: ReturnType<typeof useRouter> | null = null;
  try {
    router = useRouter();
  } catch {
    // In environments without AppRouterContext (such as SSR or unit tests)
  }

  useEffect(() => {
    if (!isLive || !router) {
      // Both paths return a cleanup, so the effect's return type does not
      // depend on whether the watch is live.
      return () => undefined;
    }
    const timer = setInterval(() => {
      router.refresh();
    }, intervalMs);
    return () => {
      clearInterval(timer);
    };
  }, [isLive, intervalMs, router]);

  if (!isLive) return null;

  return React.createElement(
    "span",
    {
      className:
        "inline-flex items-center gap-1.5 rounded-full bg-accent/15 px-2.5 py-0.5 text-xs font-semibold text-accent",
      "data-testid": "session-live-watch"
    },
    React.createElement("span", {
      className: "h-2 w-2 rounded-full bg-accent animate-pulse"
    }),
    "Live · Watching session"
  );
}
