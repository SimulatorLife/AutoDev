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

/**
 * The drawer's header row: identity on the left, dismissal on the right.
 *
 * Below `sm` it stacks instead, and it has to: at 390px the drawer's inner width
 * is about 250px, and a run id and a "Close evaluation detail" label sharing one
 * row meant the row fought over 250px. Letting the label fold put the dismiss
 * control in an 88x68 box across four lines; forbidding the fold squeezed the id
 * into 85px and made the header 227px tall. Stacked, both keep their full width
 * and the header is as tall as its contents.
 */
/**
 * The drawer header carries `min-w-0` on the identity column below it rather
 * than only on the title. Every level between the panel and the title is a
 * flex item whose automatic minimum size is its min-content width, and an
 * unbreakable id sets that minimum high; `overflow-wrap: break-word` breaks a
 * long token only *after* the box is narrowed and does not lower the minimum
 * itself, so the wrap never happens unless the whole chain can shrink.
 */
export const DETAIL_DRAWER_HEADER_CLASS =
  "flex min-w-0 flex-col items-start gap-3 border-b border-border pb-4 sm:flex-row sm:justify-between sm:gap-0";

/**
 * Title and badges share a baseline; the subtitle sits under them.
 *
 * `flex-wrap` is load-bearing, and it was added because of what happens without
 * it at a phone width. The badges are `StatusBadge`/`Chip` pills: `whitespace-
 * nowrap`, so their min-content width is their full width, and as flex items
 * their automatic minimum size is that same min-content width. They therefore
 * cannot shrink at all. The title is the one item carrying `min-w-0`, so it was
 * the only thing that *could* give -- and at 390px the experience drawer gave
 * all of it: `Role: orchestrator` (148px) and `not_run` (79px) plus a 12px gap
 * against a 194px row, so the entity name collapsed to a **zero-width, 224px-
 * tall** box. Nothing painted, and the panel reserved the height of a name it
 * was not showing.
 *
 * That is the wrong item to lose. A title row whose title can be squeezed out
 * of existence by its own accessories has no title at the width where a long id
 * is most likely. Wrapping puts the badges on their own line instead, and the
 * name keeps whatever line it is on.
 */
export const DETAIL_DRAWER_TITLE_ROW_CLASS =
  "flex min-w-0 flex-wrap items-center gap-3";

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
  /**
   * Machine-readable context under the title row.
   *
   * A node rather than a string, so a caller can hand over a `<time>` element
   * instead of a raw wire value. The run detail passes a formatted instant: a
   * bare string here meant the same moment was printed two different ways on one
   * screen, with this one carrying the milliseconds the other had already
   * decided not to show.
   */
  readonly subtitle?: React.ReactNode | undefined;
  /** URL of the list without this selection; the close link's destination. */
  readonly closeHref: string;
  readonly closeLabel?: string | undefined;
  /**
   * Anchor id for the drawer, for the link that opens it to name.
   *
   * The drawer is reached by a URL-addressable Next.js link carrying the
   * selected id. The client transition preserves the document, but without a
   * fragment the viewport and keyboard destination can still remain at the top
   * of the list rather than at the panel that just opened. Naming it here gives
   * that link an explicit arrival target.
   *
   * Opt-in because a fragment is only worth carrying if the id exists on the page
   * the link reaches, and a drawer that no link opens has nothing to land on.
   * `tabIndex: -1` takes focus without adding a stop, so this does not put one
   * more press between the operator and the rest of the page.
   */
  readonly anchorId?: string | undefined;
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
  anchorId,
  dataAttributes,
  children
}: DetailDrawerProps): React.JSX.Element {
  return React.createElement(
    "div",
    {
      className: DETAIL_DRAWER_CLASS,
      ...(anchorId === undefined ? {} : { id: anchorId, tabIndex: -1 }),
      ...dataAttributes
    },
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
