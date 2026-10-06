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
      // `py-1` reaches the 24px minimum target height, and `-my-1` gives the
      // padding straight back so the drawer's title row does not grow. Measured:
      // this link was 58x20 with zero padding on every width, four pixels under
      // the floor, on the control that dismisses the whole panel.
      className:
        "inline-flex items-center gap-1.5 -my-1 py-1 text-sm text-fg-muted hover:text-fg"
    },
    // Decorative: the adjacent word is the accessible name.
    React.createElement(Icon, { name: "close" }),
    label
  );
}
