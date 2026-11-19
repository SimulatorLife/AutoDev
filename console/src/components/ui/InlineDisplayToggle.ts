"use client";

import React from "react";

import { NOT_OBSERVED_LABEL } from "../status/StatusBadge.ts";

/**
 * One unit an inline value can be read in.
 *
 * `value` is `null` when the source has not observed that unit. An unobserved
 * unit is still offered -- it reads "Not observed" in that unit's name -- so the
 * operator can see which measurements the data source does not supply yet,
 * instead of the toggle silently skipping a unit or showing a derived guess.
 */
export interface InlineDisplayUnit {
  readonly id: string;
  /** The singular noun after the number, e.g. "byte". */
  readonly singular: string;
  /** The plural noun after the number, e.g. "bytes". */
  readonly plural: string;
  readonly value: number | null;
}

export interface InlineDisplayToggleProps {
  /** What is being measured; names the control for assistive technology. */
  readonly label: string;
  /** At least one unit; the first is shown on first render. */
  readonly units: readonly InlineDisplayUnit[];
  readonly dataAttribute?: string | undefined;
}

const COUNT_FORMATTER = new Intl.NumberFormat("en-US", {
  maximumFractionDigits: 0
});

/**
 * The inline toggle's look: dotted underline and a pointer, which together say
 * "this value changes when clicked" without adding a box around it. A native
 * button supplies Enter/Space activation and the focus order for free.
 */
export const INLINE_DISPLAY_TOGGLE_CLASS =
  "cursor-pointer bg-transparent p-0 text-left font-[inherit] text-inherit underline decoration-dotted underline-offset-4 hover:decoration-solid focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent";

/** The index the toggle moves to when activated: the units cycle in order. */
export function nextUnitIndex(current: number, unitCount: number): number {
  return unitCount <= 0 ? 0 : (current + 1) % unitCount;
}

/** The text one unit displays. */
export function inlineUnitText(unit: InlineDisplayUnit): string {
  if (unit.value === null) return `${NOT_OBSERVED_LABEL} (${unit.plural})`;
  return `${COUNT_FORMATTER.format(unit.value)} ${
    unit.value === 1 ? unit.singular : unit.plural
  }`;
}

/**
 * A value that cycles through the units it can be read in when activated.
 *
 * The shared "Inline display toggle": the unit is local display state, not
 * URL state, so it is a client island; the server render shows the first unit.
 */
export function InlineDisplayToggle({
  label,
  units,
  dataAttribute
}: InlineDisplayToggleProps): React.JSX.Element {
  const [index, setIndex] = React.useState(0);
  const current = units[index] ?? units[0];
  if (current === undefined) {
    return React.createElement("span", null, NOT_OBSERVED_LABEL);
  }
  const next = units[nextUnitIndex(index, units.length)] ?? current;
  return React.createElement(
    "button",
    {
      type: "button",
      className: INLINE_DISPLAY_TOGGLE_CLASS,
      "data-inline-display-toggle": dataAttribute ?? "true",
      "data-unit": current.id,
      "aria-label": `${label}: ${inlineUnitText(current)}. Activate to show ${next.plural}.`,
      onClick: () => {
        setIndex((value) => nextUnitIndex(value, units.length));
      }
    },
    inlineUnitText(current)
  );
}
