import React from "react";

/**
 * Inline feedback for a client-side navigation that is still waiting on the
 * server. Client navigation keeps the current page visible until the
 * destination's server data arrives and suppresses the browser's own loading
 * indicator, so the control that started the navigation signals it instead.
 * The spinner fades in after a short delay so fast navigations never flash
 * it.
 */
export function PendingSpinner(): React.JSX.Element {
  return React.createElement(
    "span",
    {
      role: "status",
      "aria-label": "Loading",
      "data-navigation-pending": "true",
      className:
        "ml-2 inline-flex shrink-0 align-middle animate-link-pending-in"
    },
    React.createElement("span", {
      className:
        "block size-3 rounded-full border-2 border-accent border-t-transparent animate-spin"
    })
  );
}
