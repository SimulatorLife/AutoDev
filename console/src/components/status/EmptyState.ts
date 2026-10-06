import React from "react";

import { Icon } from "../icons/Icon.ts";

/**
 * The Console's empty states.
 *
 * The target state requires empty/loading/error/unavailable states to be a
 * shared primitive. Empty was being rendered three ways: a bordered box that
 * stands in for a whole empty table, and an inline italic line written by hand
 * in three places -- two of which matched and one of which had silently lost
 * its `text-xs`, so the same "nothing here" line rendered at two different
 * sizes on two different pages.
 *
 * Empty means *observed and genuinely nothing*. It is not the unobserved state:
 * a source that was never wired reports `Not observed` through its own
 * vocabulary, and a resource that could not be read renders the failure shell.
 * Keeping those three apart is the whole point, so this primitive only ever
 * renders a caller-supplied message and never invents one.
 */

/**
 * The treatment for a region that would otherwise be a whole table. It keeps
 * the table's border so the box reads as the thing standing in for it rather
 * than as a stray notice floating on the page.
 */
export const EMPTY_BOX_CLASS =
  "bg-surface/40 text-fg-muted rounded-lg border border-border p-8 text-center";

/**
 * The treatment for an empty series inside an existing region -- a chart, a
 * list within a panel. It stays inline and italic because it occupies a slot
 * rather than replacing a surface.
 */
export const EMPTY_INLINE_CLASS = "py-2 text-xs italic text-fg-muted";

export interface EmptyStateProps {
  /**
   * What was looked for and why it is absent, in the caller's own words. The
   * Console never synthesizes this: "no rows" and "source not wired" are
   * different facts and only the caller knows which one it is rendering.
   */
  readonly message: string;
  /**
   * `box` replaces a whole empty region; `inline` fills a slot inside one.
   */
  readonly variant?: "box" | "inline" | undefined;
  /** Marks the state for tests and stable browser assertions. */
  readonly testId?: string | undefined;
  readonly dataAttributes?: Readonly<Record<string, string>> | undefined;
}

export function EmptyState({
  message,
  variant = "box",
  testId,
  dataAttributes
}: EmptyStateProps): React.JSX.Element {
  if (variant === "inline") {
    return React.createElement(
      "p",
      {
        className: EMPTY_INLINE_CLASS,
        ...(testId === undefined ? {} : { "data-empty-state": testId }),
        ...dataAttributes
      },
      message
    );
  }
  return React.createElement(
    "div",
    {
      className: EMPTY_BOX_CLASS,
      ...(testId === undefined ? {} : { "data-empty-state": testId }),
      ...dataAttributes
    },
    // Decorative: it repeats the message directly beneath it, so announcing
    // it would just read the same sentence twice.
    React.createElement(Icon, {
      name: "empty",
      size: 24,
      className: "mx-auto mb-3"
    }),
    React.createElement("p", { className: "text-sm" }, message)
  );
}
