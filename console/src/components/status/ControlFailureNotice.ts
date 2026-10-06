import React from "react";

import { CALLOUT_WARNING_CLASS } from "../layout/Callout.ts";

/**
 * Shown after a mutation could not be confirmed.
 *
 * One notice for every mutation surface, so a failed provider toggle, model
 * edit, or memory transition reads identically. It deliberately claims only
 * that the change is unconfirmed: the refreshed value the redirect lands on is
 * the authoritative answer, so the notice must not invent a more specific
 * outcome it cannot know.
 *
 * It carries the shared warning callout rather than its own geometry, so a
 * mutation that could not be confirmed looks like every other warning the
 * Console shows.
 */
export function ControlFailureNotice(): React.JSX.Element {
  return React.createElement(
    "div",
    {
      role: "status",
      "data-control-outcome": "failed",
      className: CALLOUT_WARNING_CLASS
    },
    "The change could not be confirmed. Check the current state before retrying."
  );
}
