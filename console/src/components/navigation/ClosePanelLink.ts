import React from "react";

import { Icon } from "../icons/Icon.ts";

/**
 * Dismiss a selected detail panel and return to the list behind it.
 *
 * Both Memory selection panels used to render their own `✕ Close` link with an
 * identical class string and a raw glyph, so the affordance could drift and the
 * glyph did not share the product's stroke grid, sizing, or `currentColor`
 * behaviour. One component keeps the two panels identical and lets the icon set
 * own the mark.
 */
export function ClosePanelLink({
  href,
  label = "Close"
}: {
  readonly href: string;
  readonly label?: string | undefined;
}): React.JSX.Element {
  return React.createElement(
    "a",
    {
      href,
      className:
        "inline-flex items-center gap-1.5 text-sm text-fg-muted hover:text-fg"
    },
    // Decorative: the adjacent word is the accessible name.
    React.createElement(Icon, { name: "close" }),
    label
  );
}
