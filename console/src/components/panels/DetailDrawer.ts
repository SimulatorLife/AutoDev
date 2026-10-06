import React from "react";

import { EntityTitle } from "../layout/Heading.ts";
import { ClosePanelLink } from "../navigation/ClosePanelLink.ts";

/**
 * The Console's detail drawer: the panel a list opens when one of its rows is
 * selected.
 *
 * The target state requires dialogs/drawers to be a shared primitive. The two
 * Memory selection panels had grown their own, and although they had not yet
 * visibly diverged they shared four hand-copied class strings between them --
 * the surface, the header row, the title cluster, and the subtitle -- so the
 * only thing keeping two panels identical was nobody editing one of them.
 *
 * This is a disclosure panel, not a modal: it renders inline beneath the list
 * it belongs to and is reached by a normal link carrying the selected id in
 * the URL. That is what keeps the selected detail addressable and shareable,
 * and it is why there is no dialog element, no focus trap, and no dismissal
 * script anywhere in the Console. The close control is a plain link back to
 * the list without the selection, so the same behaviour works with no
 * JavaScript at all.
 */

/**
 * The drawer's surface. A selected item is lifted off the page behind it, so
 * it carries the selected background, an accent edge, and a deeper shadow than
 * the panels it sits over.
 */
export const DETAIL_DRAWER_CLASS =
  "rounded-lg border border-accent/60 bg-selected p-6 flex flex-col gap-6 shadow-xl";

/** The drawer's header row: identity on the left, dismissal on the right. */
/**
 * The drawer header carries `min-w-0` on the identity column below it rather
 * than only on the title. Every level between the panel and the title is a
 * flex item whose automatic minimum size is its min-content width, and an
 * unbreakable id sets that minimum high; `overflow-wrap: break-word` breaks a
 * long token only *after* the box is narrowed and does not lower the minimum
 * itself, so the wrap never happens unless the whole chain can shrink.
 */
export const DETAIL_DRAWER_HEADER_CLASS =
  "flex min-w-0 items-start justify-between border-b border-border pb-4";

/** Title and badges share a baseline; the subtitle sits under them. */
export const DETAIL_DRAWER_TITLE_ROW_CLASS = "flex min-w-0 items-center gap-3";

/** A machine-readable fact about the selected item, such as its scope. */
export const DETAIL_DRAWER_SUBTITLE_CLASS = "text-xs text-fg-muted font-mono";

export interface DetailDrawerProps {
  /** The entity id, rendered as the drawer's title. */
  readonly title: string;
  /**
   * Tag and status affordances beside the title. They belong to the entity,
   * so the feature supplies them rather than the drawer guessing a vocabulary.
   */
  readonly badges?: React.ReactNode | undefined;
  /** Machine-readable context under the title row. */
  readonly subtitle?: string | undefined;
  /** URL of the list without this selection; the close link's destination. */
  readonly closeHref: string;
  readonly closeLabel?: string | undefined;
  /** Extra attributes, for the state flags the Console asserts on. */
  readonly dataAttributes?: Readonly<Record<string, string>> | undefined;
  /** Optional here so callers can pass the body as `createElement`'s child. */
  readonly children?: React.ReactNode | undefined;
}

export function DetailDrawer({
  title,
  badges,
  subtitle,
  closeHref,
  closeLabel,
  dataAttributes,
  children
}: DetailDrawerProps): React.JSX.Element {
  return React.createElement(
    "div",
    { className: DETAIL_DRAWER_CLASS, ...dataAttributes },
    React.createElement(
      "div",
      { className: DETAIL_DRAWER_HEADER_CLASS },
      React.createElement(
        "div",
        { className: "flex min-w-0 flex-col gap-1" },
        React.createElement(
          "div",
          { className: DETAIL_DRAWER_TITLE_ROW_CLASS },
          React.createElement(EntityTitle, { mono: true }, title),
          badges
        ),
        subtitle === undefined
          ? null
          : React.createElement(
              "span",
              { className: DETAIL_DRAWER_SUBTITLE_CLASS },
              subtitle
            )
      ),
      React.createElement(ClosePanelLink, {
        href: closeHref,
        label: closeLabel
      })
    ),
    children
  );
}
