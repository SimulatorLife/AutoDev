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

export interface ChipListProps<TItem = string> {
  readonly items: readonly TItem[];
  /**
   * How each item is rendered; defaults to a plain label chip. Use this when an
   * item needs to be something other than a chip (a link, or a chip carrying two
   * facts). To restyle every chip, use `className` instead so the shared chip
   * presentation is preserved.
   */
  readonly renderItem?: ((item: TItem) => React.ReactNode) | undefined;
  /**
   * React key for each item. Defaults to the item itself, which is only correct
   * when the items are already unique strings; pass this for any other shape.
   */
  readonly renderKey?: ((item: TItem) => React.Key) | undefined;
  /** Extra classes applied to every chip in the list. */
  readonly className?: string | undefined;
  /** Copy for the empty case, so absence never reads as a blank cell. */
  readonly emptyLabel: string;
  /** Marks the list for tests and for stable browser assertions. */
  readonly testId?: string | undefined;
}

/**
 * Render a wrapping list of chips.
 *
 * This is a function rather than a component on purpose. Every Console view
 * builds elements with `React.createElement`, and TypeScript resolves a generic
 * component's type parameter to its constraint there — every `renderItem`
 * parameter arrived as `unknown`, so passing a list of anything but plain
 * strings could not type-check. Calling a generic function directly keeps the
 * item type inferred from `items`.
 */
export function chipList<TItem = string>({
  items,
  renderItem,
  renderKey,
  className,
  emptyLabel,
  testId
}: ChipListProps<TItem>): React.ReactElement {
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
    ...items.map((item, index) =>
      React.createElement(
        "li",
        {
          // The default key is the item itself, which only works for string
          // items; any other shape supplies `renderKey`, and the fallback keeps
          // React from warning if it does not.
          key:
            renderKey === undefined
              ? ((item as React.Key) ?? `chip-${index}`)
              : renderKey(item),
          className: "flex min-w-0 items-center"
        },
        renderItem === undefined
          ? React.createElement(
              Chip,
              className === undefined ? null : { className },
              // The default chip renders the item as its own label.
              item as string
            )
          : renderItem(item)
      )
    )
  );
}
