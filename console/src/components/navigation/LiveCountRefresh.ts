"use client";

import React from "react";

import { MUTED_META_CLASS } from "../ui/text-classes.ts";
import {
  LIVE_COUNT_REFRESH_EVENT,
  LIVE_COUNT_REFRESH_INTERVAL_MS,
  startLiveCountRefresh
} from "./live-count-refresh.ts";

export function LiveCountRefresh(): React.JSX.Element {
  React.useEffect(
    () =>
      startLiveCountRefresh(() =>
        globalThis.window.dispatchEvent(new Event(LIVE_COUNT_REFRESH_EVENT))
      ),
    []
  );

  return React.createElement(
    "p",
    {
      className: MUTED_META_CLASS,
      "data-live-count-refresh-ms": LIVE_COUNT_REFRESH_INTERVAL_MS
    },
    "Live counts refresh every 5 seconds."
  );
}
