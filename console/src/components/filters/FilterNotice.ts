import React from "react";

import { CALLOUT_WARNING_CLASS } from "../layout/Callout.ts";
import type { UnappliedFilter } from "./resolve-filter.ts";

/**
 * Names the filters a page could not apply, instead of applying its default.
 *
 * Every list page resolves bounded URL filters -- `source`, `kind`, `status`,
 * `tab` -- and each one can be handed a value the page does not accept: a
 * bookmark outlives the option it names, a shared URL is edited, a value is
 * typed. Every such page used to answer the same way, by substituting the
 * default and rendering that default as the reader's own choice, so the page
 * asserted a filter state it had not observed.
 *
 * This is a warning rather than an error because the page still works: the list
 * rendered, and it is unfiltered for the one thing the URL asked for. That is a
 * condition the operator should check, which is what the shared warning callout
 * already means, so this reuses it rather than designing a second geometry for
 * a one-line note.
 *
 * No icon: the icon set is closed and deliberately carries no warning glyph,
 * because colour plus a written label survives a monochrome rendering.
 */

export interface FilterNoticeProps {
  /** Carried straight from `resolveFilter`; empty means nothing to report. */
  readonly filters: readonly UnappliedFilter[];
}

export function FilterNotice({
  filters
}: FilterNoticeProps): React.JSX.Element | null {
  if (filters.length === 0) {
    return null;
  }
  const heading =
    filters.length === 1
      ? "1 filter in this URL was not applied."
      : `${filters.length} filters in this URL were not applied.`;
  const named = filters
    .map((filter) => `${filter.name}=${JSON.stringify(filter.value)}`)
    .join(", ");
  return React.createElement(
    "div",
    {
      role: "status",
      className: CALLOUT_WARNING_CLASS,
      "data-feature-filter-notice": "true"
    },
    React.createElement("span", { className: "font-medium" }, heading),
    React.createElement(
      "span",
      { className: "mt-1 block" },
      `This page does not accept: ${named}.`
    )
  );
}
