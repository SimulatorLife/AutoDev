import React from "react";

import { NavigationLink } from "./NavigationLink.ts";

/**
 * Page navigation for a bounded Console collection.
 *
 * The target state requires the Console to "reuse generic browsing primitives"
 * over the records a control API pages, and the Memory target names
 * browse/search/pagination as part of the feature. Memory was reading two
 * paged collections through that contract and rendering neither one's second
 * page: `/control/memory/records` and `/control/memory/experiences` both take a
 * bounded `limit`/`offset` and return a `total` beside the page, the Runtime
 * defaults to 50 rows, and the Console sent no page parameters at all. So the
 * views correctly said "50 of 1,204 records" and then gave the operator no way
 * to reach the other 1,154. A count that reports more than the page holds is
 * only useful if something can act on it.
 *
 * Navigation is a pair of server-addressable Next.js links: the page position
 * remains real query state, bookmarkable, shareable, reachable by the back
 * button, and still works without JavaScript. With the client active, Next.js
 * performs an in-place route transition rather than reloading the document.
 *
 * There is a page-number strip as well, because a count that reports more
 * than the page holds is only useful if something can act on it: the Memory
 * records page holds 50 of 1,204 rows, and Previous and Next alone are
 * twenty-three clicks to the last page. The strip's links are safe to build
 * from the total and the page size -- every one of them is an exact multiple
 * of the page size, which is the grid the URL resolver snaps an offset to --
 * and the strip shows a window around the current page rather than every
 * page, so a collection of a hundred pages does not become a row of a hundred
 * links.
 *
 * The unavailable direction renders as inert text rather than a dead `<a>`: an
 * anchor with no `href` is not focusable, so a keyboard operator would have no
 * way to discover that the control exists at all.
 */

/** One page's position in a bounded collection. */
export interface PagePosition {
  /** Rows skipped before this page. Always a multiple of `limit`. */
  readonly offset: number;
  /** Rows the collection asked for. Always one of the accepted page sizes. */
  readonly limit: number;
  /** Rows the collection reports in total, across every page. */
  readonly total: number;
}

export interface PaginationProps extends PagePosition {
  /** What is being paged: "Records", "Experiences". Names the navigation. */
  readonly label: string;
  /** Href for a target offset. The caller owns the surrounding filters. */
  readonly hrefForOffset: (offset: number) => string;
  /** Marks the navigation for tests and stable browser assertions. */
  readonly testId?: string | undefined;
}

const NAV_CLASS =
  "flex flex-wrap items-center gap-3 border-t border-border pt-3 text-sm text-fg-muted";

const LINK_CLASS =
  "rounded border border-border-strong bg-surface-raised px-3 py-1.5 text-sm font-medium text-fg transition-colors hover:bg-hover";

/**
 * An unavailable direction keeps the row's shape so the control does not shift
 * as the operator reaches an edge, and says so to assistive technology rather
 * than pretending to be an action.
 */
const INERT_CLASS = `${LINK_CLASS} cursor-not-allowed opacity-60`;

/** The first row index past this page. */
function endOfPage(page: PagePosition): number {
  return page.offset + page.limit;
}

/**
 * The inclusive row range this page shows.
 *
 * Two states have no range to report. An empty collection would render the
 * impossible `1–0`. An offset past the end -- which a hand-edited or stale
 * bookmark reaches, and which the Runtime answers with an empty page rather
 * than an error -- would render a range starting beyond the total, so it says
 * what is actually true: the collection has rows, this page does not.
 */
export function pageRangeLabel(page: PagePosition): string {
  if (page.total === 0) return "No rows";
  if (page.offset >= page.total) return "No rows on this page";
  const first = page.offset + 1;
  const last = Math.min(endOfPage(page), page.total);
  return `${first}\u2013${last} of ${page.total}`;
}

/** Whether each direction has somewhere to go. */
export function pageDirections(page: PagePosition): {
  readonly hasPrevious: boolean;
  readonly hasNext: boolean;
} {
  return {
    hasPrevious: page.offset > 0,
    hasNext: endOfPage(page) < page.total
  };
}

/** How many pages the collection holds. */
export function pageCount(page: PagePosition): number {
  if (page.limit <= 0) return 0;
  return Math.ceil(page.total / page.limit);
}

/** One entry in the page strip: a page, or a gap where pages are skipped. */
export type PageStripEntry =
  { readonly kind: "page"; readonly page: number } | { readonly kind: "gap" };

/**
 * The pages the strip shows.
 *
 * A short collection shows every page. A long one shows the first, the last,
 * and a window around the page the operator is on -- so the strip is a way
 * into the collection, not the collection itself.
 */
export function pageStrip(page: PagePosition): PageStripEntry[] {
  const count = pageCount(page);
  if (count <= 0) return [];
  const current = Math.floor(page.offset / page.limit) + 1;
  if (count <= 5) {
    return Array.from({ length: count }, (_unused, index) => ({
      kind: "page" as const,
      page: index + 1
    }));
  }
  const entries: PageStripEntry[] = [{ kind: "page", page: 1 }];
  const start = Math.max(2, current - 1);
  const end = Math.min(count - 1, current + 1);
  if (start > 2) entries.push({ kind: "gap" });
  for (let pageNumber = start; pageNumber <= end; pageNumber += 1) {
    entries.push({ kind: "page", page: pageNumber });
  }
  if (end < count - 1) entries.push({ kind: "gap" });
  entries.push({ kind: "page", page: count });
  return entries;
}

/** The page the operator is on, counted from one. */
export function currentPageNumber(page: PagePosition): number {
  if (page.limit <= 0) return 1;
  return Math.floor(page.offset / page.limit) + 1;
}

export function Pagination({
  label,
  offset,
  limit,
  total,
  hrefForOffset,
  testId
}: PaginationProps): React.JSX.Element | null {
  const page = { offset, limit, total };
  const { hasPrevious, hasNext } = pageDirections(page);

  // A collection that fits in one page needs no navigation, *unless* the reader
  // is not on the first page of it: a bookmark past the end of a small
  // collection is exactly the state with nothing to act on and something to
  // recover from, so the bar stays to carry Previous.
  if (total <= limit && offset === 0) return null;

  const direction = (
    text: string,
    target: number,
    rel: "prev" | "next",
    available: boolean
  ): React.JSX.Element =>
    available
      ? React.createElement(
          NavigationLink,
          { href: hrefForOffset(target), rel, className: LINK_CLASS },
          text
        )
      : React.createElement(
          "span",
          { "aria-disabled": "true", className: INERT_CLASS },
          text
        );

  /**
   * The pages themselves.
   *
   * The current page is text rather than a link: it is where the operator
   * already is, and `aria-current` says so to assistive technology.
   */
  const strip = pageStrip(page).map((entry) =>
    entry.kind === "gap"
      ? React.createElement(
          "span",
          {
            key: "gap",
            "aria-hidden": "true",
            className: "px-1 text-fg-muted"
          },
          "…"
        )
      : entry.page === currentPageNumber(page)
        ? React.createElement(
            "span",
            {
              key: `page-${entry.page}`,
              "aria-current": "page",
              className:
                "inline-flex min-h-6 items-center px-2 text-sm font-medium text-fg"
            },
            String(entry.page)
          )
        : React.createElement(
            NavigationLink,
            {
              key: `page-${entry.page}`,
              href: hrefForOffset((entry.page - 1) * page.limit),
              "aria-label": `Page ${entry.page}`,
              className:
                "inline-flex min-h-6 items-center rounded px-2 text-sm text-fg-muted transition-colors hover:bg-hover hover:text-fg"
            },
            String(entry.page)
          )
  );

  return React.createElement(
    "nav",
    {
      "aria-label": `${label} pagination`,
      className: NAV_CLASS,
      ...(testId === undefined ? {} : { "data-pagination": testId })
    },
    React.createElement("span", { className: "ml-auto" }, pageRangeLabel(page)),
    direction("Previous", Math.max(0, offset - limit), "prev", hasPrevious),
    React.createElement(
      "span",
      { className: "flex items-center gap-0.5" },
      ...strip
    ),
    direction("Next", endOfPage(page), "next", hasNext)
  );
}
