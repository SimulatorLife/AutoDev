"use client";

import React from "react";

import { MUTED_META_CLASS } from "../ui/text-classes.ts";
import {
  LIVE_COUNT_REFRESH_EVENT,
  LIVE_COUNT_REFRESH_INTERVAL_MS,
  startLiveCountRefresh
} from "./live-count-refresh.ts";

export interface LiveCountRefreshProps {
  readonly silent?: boolean | undefined;
}

export function LiveCountRefresh(
  props: LiveCountRefreshProps
): React.JSX.Element | null {
  const silent = props?.silent ?? false;
  React.useEffect(
    () =>
      startLiveCountRefresh(() =>
        globalThis.window.dispatchEvent(new Event(LIVE_COUNT_REFRESH_EVENT))
      ),
    []
  );

  if (silent) return null;

  return React.createElement(
    "p",
    {
      className: MUTED_META_CLASS,
      "data-live-count-refresh-ms": LIVE_COUNT_REFRESH_INTERVAL_MS
    },
    "Live counts refresh every 5 seconds."
  );
}
