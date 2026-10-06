import React from "react";

import { type StatusBadgeVariant, StatusDot } from "../status/StatusBadge.ts";
import { TAG_SHAPE } from "../status/Tag.ts";
import { MUTED_META_CLASS } from "../ui/text-classes.ts";
/**
 * Shared presentation primitives for the repeated "a cell holds a list of
 * short labels" pattern (role assignments, MCP servers, tier priorities).
 *
 * These exist so every table renders such a list the same way: chips laid out
 * inline and wrapped between items, never one per line. A vertical stack
 * triples row height and destroys the density an operator table depends on.
 */

export const CHIP_CLASS = `${TAG_SHAPE} border-border-strong bg-surface-raised text-fg-secondary`;

export interface ChipProps {
  /**
   * Supplied as `React.createElement`'s child argument, so it stays optional
   * here for the type checker as well as for JSX.
   */
  readonly children?: React.ReactNode;
  /** Render the chip as a link when the item leads somewhere. */
  readonly href?: string | undefined;
  /**
   * Overrides the hover text. A chip truncates, so when the content is a plain
   * string the chip titles itself with that string -- otherwise the ellipsis
   * is the only thing the operator can see and the real identifier is gone
   * from the page.
   */
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
  // `title` is the hover affordance for a truncated chip, so it falls back to
  // the visible text. Only a string child qualifies: richer content has no
  // single text to offer and a wrong `title` is worse than none.
  const text = typeof children === "string" ? children : undefined;
  const title = label ?? text;
  if (href !== undefined) {
    return React.createElement(
      "a",
      {
        href,
        className: `${classes} underline-offset-4 hover:text-accent hover:underline`,
        // `aria-label` only when it says something the text does not; a link
        // whose text is already the label must not have its name replaced.
        ...(label === undefined ? {} : { "aria-label": label }),
        ...(title === undefined ? {} : { title })
      },
      children
    );
  }
  return React.createElement(
    "span",
    { className: classes, ...(title === undefined ? {} : { title }) },
    children
  );
}

export interface StatusChipProps {
  readonly status: StatusBadgeVariant;
  /** What the dot means, e.g. "Enabled". Read by assistive tech and on hover. */
  readonly stateLabel: string;
  /** The name being chipped, e.g. `codexcli`. */
  readonly label: string;
  /**
   * The full hover text. A chip carrying two facts truncates, and its children
   * are no longer a plain string, so `Chip` cannot title it from its own text —
   * `codexcli: enabled` is what the reader needs back, not `codexcli`.
   */
  readonly title?: string | undefined;
  readonly href?: string | undefined;
  readonly className?: string | undefined;
}

/**
 * A chip carrying a status dot instead of a spelled-out state.
 *
 * The suffix costs the column more than the name does: `antigravity-cli:
 * enabled` is a 175px chip where `antigravity-cli` with a dot is 112px, and on
 * `/mcps`'s Overrides column that difference was the whole reason every
 * override read `codex…`. The same shape was already hand-written on
 * `/agents`'s provider summary, which is why this is one component rather than
 * the third copy of the same `<Chip><StatusDot/>name</Chip>`.
 */
export function StatusChip({
  status,
  stateLabel,
  label,
  title,
  href,
  className
}: StatusChipProps): React.JSX.Element {
  return React.createElement(
    Chip,
    {
      ...(href === undefined ? {} : { href }),
      label: title ?? label,
      className: className ?? "gap-1.5 font-mono"
    },
    React.createElement(StatusDot, { status, label: stateLabel }),
    label
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
      { className: MUTED_META_CLASS },
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
          // `max-w-full` as well as `min-w-0`: the chip's own `max-w-full`
          // resolves against this element, so without a cap here the li sizes
          // to its content and the chip's limit is measured against a
          // container that was never smaller. A single long identifier then
          // runs out of the panel and the region has to be scrolled sideways
          // to read. With the cap, `truncate` on the chip has a real width to
          // truncate to.
          className: "flex min-w-0 max-w-full items-center"
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
