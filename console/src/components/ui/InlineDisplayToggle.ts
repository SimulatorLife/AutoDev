"use client";

import React from "react";

import { NOT_OBSERVED_LABEL } from "../status/StatusBadge.ts";

/**
 * One way the same value can be read: its visible text, and the noun the
 * control uses when it announces what activating it will show next.
 */
export interface InlineRepresentation {
  readonly id: string;
  /** The visible text in this representation. */
  readonly text: string;
  /** What this representation is called, e.g. "characters" or "relative time". */
  readonly name: string;
}

export interface InlineDisplayToggleProps {
  /** What is being shown; names the control for assistive technology. */
  readonly label: string;
  /** At least one representation; the first is shown on first render. */
  readonly representations: readonly InlineRepresentation[];
  readonly dataAttribute?: string | undefined;
  /** Hover title, e.g. the value in a representation that is not showing. */
  readonly title?: string | undefined;
}

/**
 * The inline toggle's look: dotted underline and a pointer, which together say
 * "this value changes when clicked" without adding a box around it. A native
 * button supplies Enter/Space activation and the focus order for free.
 */
const INLINE_DISPLAY_TOGGLE_CLASS =
  "cursor-pointer bg-transparent p-0 text-left font-[inherit] text-inherit underline decoration-dotted underline-offset-4 hover:decoration-solid focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent";

/** The index the toggle moves to when activated: representations cycle in order. */
export function nextRepresentationIndex(
  current: number,
  count: number
): number {
  return count <= 0 ? 0 : (current + 1) % count;
}

/**
 * The shared "Inline display toggle": one value, cycled through the ways it can
 * be read when activated.
 *
 * Which representation is showing is local display state, not URL state, so
 * this is a client island; the server render shows the first representation.
 * A value with a single representation is plain text: a control that changes
 * nothing when activated is not a control.
 */
export function InlineDisplayToggle({
  label,
  representations,
  dataAttribute,
  title
}: InlineDisplayToggleProps): React.JSX.Element {
  const [index, setIndex] = React.useState(0);
  const current = representations[index] ?? representations[0];
  if (current === undefined) {
    return React.createElement("span", null, NOT_OBSERVED_LABEL);
  }
  if (representations.length === 1) {
    return React.createElement(
      "span",
      { "data-inline-display-value": dataAttribute ?? "true", title },
      current.text
    );
  }
  const next =
    representations[nextRepresentationIndex(index, representations.length)] ??
    current;
  return React.createElement(
    "button",
    {
      type: "button",
      className: INLINE_DISPLAY_TOGGLE_CLASS,
      "data-inline-display-toggle": dataAttribute ?? "true",
      "data-representation": current.id,
      title,
      "aria-label": `${label}: ${current.text}. Activate to show ${next.name}.`,
      onClick: () => {
        setIndex((value) =>
          nextRepresentationIndex(value, representations.length)
        );
      }
    },
    current.text
  );
}
