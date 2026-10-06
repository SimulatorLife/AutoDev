import React from "react";

import { Button } from "../forms/Button.ts";
import { FIELD_CONTROL_CLASS } from "../forms/SelectField.ts";
import { FILTER_PANEL_CLASS } from "../layout/Panel.ts";

/**
 * The Console's filter bar.
 *
 * The target state requires filters to be a shared primitive so that every
 * list surface produces "consistent spacing, density, keyboard/focus behavior,
 * and status vocabulary". Four surfaces had their own version of this row and
 * they had drifted apart: two used one spelling of the box, a third used
 * another, and the fourth rendered no box at all. One of them bypassed both the
 * `Button` and the shared control chrome entirely, hand-typing its own submit
 * button, and dropped the accessible name from its search input — so two
 * filters that look like one feature did not behave like one feature.
 *
 * The primitive owns the things that drifted, rather than offering the parts
 * and trusting each caller to reassemble them:
 *
 * - the `<form>` element, its GET method, and its action;
 * - the panel surface and the wrapping control row;
 * - an accessible name, so the form is a named landmark rather than an
 *   anonymous one;
 * - the query state that must survive the submit (`tab`, workspace scope);
 * - the submit button, from the shared `Button` vocabulary;
 * - the result-count summary, aligned to the trailing edge.
 *
 * It deliberately does NOT own the controls themselves. A filter bar holds
 * selects, a free-text query, and occasionally a custom range, and those are
 * real form controls that belong to the feature. Callers pass them as children.
 *
 * There is no client-side filtering and no JS: filtering is a normal GET
 * navigation, so every filtered view stays URL-addressable, bookmarkable, and
 * shareable.
 */

/**
 * Query state carried through a filter submission unchanged.
 *
 * A filter submit rebuilds the query string from the form, so anything not
 * represented by a control on the bar would silently reset — losing the active
 * tab, or dropping a list out of the workspace scope the user selected. Sites
 * pass that state here instead of hand-rolling hidden inputs per view.
 */
export interface FilterBarField {
  readonly name: string;
  readonly value: string;
}

export interface FilterBarProps {
  /** Accessible name for the form, e.g. "Usage filters". */
  readonly label: string;
  /** Route the form submits to. Omit to submit back to the current URL. */
  readonly action?: string | undefined;
  /** Query state preserved across the submission. */
  readonly preserved?: readonly FilterBarField[] | undefined;
  /**
   * Controls: `SelectField`, `FilterSearchField`, custom range inputs.
   *
   * Optional in the type only so callers can pass controls as
   * `createElement`'s child argument; a bar always renders controls in
   * practice.
   */
  readonly children?: React.ReactNode | undefined;
  /**
   * Trailing result count or state hint. Sits on the trailing edge of the bar
   * and wraps onto its own line on narrow screens rather than crowding a
   * control off the row.
   */
  readonly summary?: React.ReactNode | undefined;
  /**
   * Submit label. The vocabulary is shared deliberately: one primary action
   * per bar, named the same way on every surface.
   */
  readonly submitLabel?: string | undefined;
  /** Marks the submit control for tests and stable browser assertions. */
  readonly submitTestId?: string | undefined;
  /** Extra attributes, for state flags the Console asserts on. */
  readonly dataAttributes?: Readonly<Record<string, string>> | undefined;
}

const FILTER_BAR_CLASS = `${FILTER_PANEL_CLASS} flex flex-wrap items-center gap-3`;

/**
 * A filter bar's result summary. `ml-auto` pushes it to the trailing edge on a
 * wide bar; because the row wraps rather than scrolling, it simply starts a
 * new line when there is no room for it.
 */
export const FILTER_SUMMARY_CLASS = "ml-auto text-xs text-fg-muted";

export function FilterBar({
  label,
  action,
  preserved,
  children,
  summary,
  submitLabel = "Apply filters",
  submitTestId,
  dataAttributes
}: FilterBarProps): React.JSX.Element {
  return React.createElement(
    "form",
    {
      method: "GET",
      ...(action === undefined ? {} : { action }),
      "aria-label": label,
      className: FILTER_BAR_CLASS,
      ...dataAttributes
    },
    ...(preserved ?? []).map((field) =>
      React.createElement("input", {
        key: field.name,
        type: "hidden",
        name: field.name,
        value: field.value
      })
    ),
    children,
    React.createElement(
      Button,
      { type: "submit", variant: "primary", testId: submitTestId },
      submitLabel
    ),
    summary === undefined
      ? null
      : React.createElement(
          "span",
          { className: FILTER_SUMMARY_CLASS },
          summary
        )
  );
}

export interface FilterSearchFieldProps {
  readonly name: string;
  readonly defaultValue: string;
  /**
   * Accessible name. Required rather than optional because the placeholder is
   * not a substitute: it disappears the moment the field has a value, leaving
   * the control with no name at all. One of the two filter bars relied on a
   * placeholder alone and shipped exactly that.
   */
  readonly label: string;
  readonly placeholder?: string | undefined;
  /** Marks the control for tests and stable browser assertions. */
  readonly testId?: string | undefined;
}

/**
 * The free-text query control for a filter bar.
 *
 * Carries the shared control chrome so a text field beside a `SelectField`
 * matches it. The pair previously disagreed on padding, border colour, text
 * size, and focus treatment, which read as two different products rather than
 * one filter.
 */
export function FilterSearchField({
  name,
  defaultValue,
  label,
  placeholder,
  testId
}: FilterSearchFieldProps): React.JSX.Element {
  const id = `filter-${name}`;
  return React.createElement(
    "div",
    { className: "flex min-w-0 flex-1 basis-48 items-center" },
    React.createElement("label", { htmlFor: id, className: "sr-only" }, label),
    React.createElement("input", {
      id,
      type: "search",
      name,
      defaultValue,
      ...(placeholder === undefined ? {} : { placeholder }),
      className: `${FIELD_CONTROL_CLASS} w-full min-w-0 placeholder-fg-muted`,
      ...(testId === undefined ? {} : { "data-filter-search": testId })
    })
  );
}
