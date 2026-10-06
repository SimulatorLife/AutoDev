import React from "react";

/**
 * Shown after a mutation could not be confirmed.
 *
 * One notice for every mutation surface, so a failed provider toggle, model
 * edit, or memory transition reads identically. It deliberately claims only
 * that the change is unconfirmed: the refreshed value the redirect lands on is
 * the authoritative answer, so the notice must not invent a more specific
 * outcome it cannot know.
 */
export function ControlFailureNotice(): React.JSX.Element {
  return React.createElement(
    "div",
    {
      role: "status",
      "data-control-outcome": "failed",
      className:
        "rounded border border-warning/40 bg-warning/15 px-3 py-2 text-xs font-medium text-warning"
    },
    "The change could not be confirmed. Check the current state before retrying."
  );
}
