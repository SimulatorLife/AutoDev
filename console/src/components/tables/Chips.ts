import React from "react";

/**
 * Shared presentation primitives for the repeated "a cell holds a list of
 * short labels" pattern (role assignments, MCP servers, tier priorities).
 *
 * These exist so every table renders such a list the same way: chips laid out
 * inline and wrapped between items, never one per line. A vertical stack
 * triples row height and destroys the density an operator table depends on.
 */

export const CHIP_CLASS =
  "inline-flex max-w-full items-center truncate rounded border border-border-strong bg-surface-raised px-2 py-0.5 text-xs text-fg-secondary";

export interface ChipProps {
  /**
   * Supplied as `React.createElement`'s child argument, so it stays optional
   * here for the type checker as well as for JSX.
   */
  readonly children?: React.ReactNode;
  /** Render the chip as a link when the item leads somewhere. */
  readonly href?: string | undefined;
  /** Screen-reader label for the chip's meaning. */
  readonly label?: string | undefined;
  readonly className?: string | undefined;
}

export function Chip({
  children,
  href,
  label,
  className
}: ChipProps): React.JSX.Element {
  const classes = `${CHIP_CLASS}${className === undefined ? "" : ` ${className}`}`;
  if (href !== undefined) {
    return React.createElement(
      "a",
      {
        href,
        className: `${classes} underline-offset-4 hover:text-accent hover:underline`,
        ...(label === undefined ? {} : { "aria-label": label })
      },
      children
    );
  }
  return React.createElement(
    "span",
    { className: classes, ...(label === undefined ? {} : { title: label }) },
    children
  );
}

export interface ChipListProps {
  readonly items: readonly string[];
  /**
   * How each item is rendered; defaults to a plain label chip. Use this only
   * when an item needs to be something other than a chip (for example a link).
   * To restyle every chip, use `className` instead so the shared chip
   * presentation is preserved.
   */
  readonly renderItem?: ((item: string) => React.ReactNode) | undefined;
  /** Extra classes applied to every chip in the list. */
  readonly className?: string | undefined;
  /** Copy for the empty case, so absence never reads as a blank cell. */
  readonly emptyLabel: string;
  /** Marks the list for tests and for stable browser assertions. */
  readonly testId?: string | undefined;
}

export function ChipList({
  items,
  renderItem,
  className,
  emptyLabel,
  testId
}: ChipListProps): React.JSX.Element {
  if (items.length === 0) {
    return React.createElement(
      "span",
      { className: "text-xs text-fg-muted" },
      emptyLabel
    );
  }
  return React.createElement(
    "ul",
    {
      className: "m-0 flex list-none flex-wrap items-center gap-1 p-0",
      ...(testId === undefined ? {} : { "data-chips": testId })
    },
    ...items.map((item) =>
      React.createElement(
        "li",
        { key: item, className: "flex min-w-0 items-center" },
        renderItem === undefined
          ? React.createElement(
              Chip,
              className === undefined ? null : { className },
              item
            )
          : renderItem(item)
      )
    )
  );
}
