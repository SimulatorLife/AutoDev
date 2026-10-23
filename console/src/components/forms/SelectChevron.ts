import React from "react";

import { Icon } from "../icons/Icon.ts";

/**
 * The wrapper that lets a select's chevron sit inside the control's own right
 * edge.
 *
 * The shared select chrome reserves 32px of right padding for the chevron, so a
 * select that wears the shared chrome without drawing one reads as a text field
 * with a mystery gap in it.
 */
export const SELECT_CONTROL_WRAPPER_CLASS =
  "relative inline-flex min-w-0 max-w-full items-center";

/**
 * The same wrapper for a select that fills its column.
 *
 * A select inside a labelled grid cell or a stacked form row is expected to
 * span that column. `inline-flex` would shrink it to its widest option, which
 * is how a row of assignment selects ended up with a different width per row.
 * The select carries `w-full` alongside it.
 */
export const SELECT_CONTROL_BLOCK_WRAPPER_CLASS =
  "relative flex min-w-0 max-w-full items-center";

/**
 * The drawn chevron that tells the operator a control opens a list.
 *
 * Native `appearance` is dropped on every select, so the platform's own
 * indicator is gone and this is the only thing that says "there are more
 * choices here". Without it a select is indistinguishable from a text field at
 * a glance, which is exactly the confusion the control's pointer is now there
 * to remove.
 *
 * `pointer-events-none` so the decoration never intercepts the click that
 * opens the native list.
 *
 * 12px rather than the icon set's 16px default: the chevron is part of the
 * control's chrome, sized to the 34px control rather than to a product icon.
 * Stroke weight stays at the set's 2 -- it used to be hand-set to 2.5 here,
 * which made this the one visibly heavier mark in the product.
 */
export function SelectChevron(): React.JSX.Element {
  return React.createElement(
    "span",
    {
      className:
        "pointer-events-none absolute right-2 flex items-center text-fg-muted",
      "aria-hidden": true
    },
    React.createElement(Icon, { name: "chevronDown", size: 12 })
  );
}
