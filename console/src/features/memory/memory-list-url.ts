import {
  resolveFilter,
  type UnappliedFilter
} from "../../components/filters/resolve-filter.ts";

/**
 * The one owner of a Memory list's address.
 *
 * A list is identified by more than its route: the tab, the workspace scope,
 * the query, the kind and status filters, the time window, and the page
 * position. Every link that navigates within Memory has to carry that state or
 * lose some of it, and before this module each call site assembled a partial
 * version by hand. The record row linked `?tab=records&workspaceId=…&recordId=…`
 * and the drawer's Close link linked `?tab=records&workspaceId=…`, so opening a
 * record and closing it again returned the operator to an *unfiltered* list
 * with a 30-day window -- the `query`, `kind`, `status`, `from`, and `until`
 * they had just narrowed the collection with. Neither link was wrong about the
 * route; both were wrong about the list.
 *
 * So the address is built once, here, and the views take hrefs rather than
 * composing them. A new filter on a list is a different navigation from a new
 * page on the same list, and the difference is not cosmetic: see
 * `memoryFilterHref`, which resets the position because page 7 of a freshly
 * filtered result is usually a page that does not exist.
 */

export type MemoryTab = "records" | "experiences" | "cohorts";

/** The query keys that identify which row a Memory tab has selected. */
export type MemoryDetailKey = "recordId" | "experienceId";

/**
 * Everything that identifies the list being looked at, independent of any
 * selected row.
 */
export interface MemoryListScope {
  readonly tab: MemoryTab;
  readonly workspaceId: string;
  readonly query?: string | undefined;
  /** `"all"` and `undefined` both mean "unfiltered"; neither is written out. */
  readonly kind?: string | undefined;
  readonly status?: string | undefined;
  readonly from: string;
  readonly until: string;
  readonly limit: number;
  readonly offset: number;
  /**
   * Cohort-tab filters.
   *
   * These belong to the Outcome Cohorts tab alone, and `listParams` writes them
   * only while that tab is selected. Carrying them across to Records or
   * Experiences would put a bounded filter in the URL of a list that cannot
   * honour it — the page would report it as applied and nothing would narrow.
   * Scoping them to the tab that understands them means switching tab drops
   * them, which is also what the Runtime does with an unknown key.
   */
  readonly memoryMode?: string | undefined;
  readonly injectionResult?: string | undefined;
  readonly reportKind?: string | undefined;
  readonly outcomeKind?: string | undefined;
  readonly useKind?: string | undefined;
}

/** The page position of a bounded Memory collection. */
export interface MemoryPage {
  readonly limit: number;
  readonly offset: number;
}

/**
 * Page sizes the Console offers, and the Runtime's own bound.
 *
 * `/control/memory/records` and `/control/memory/experiences` reject a `limit`
 * outside 1-100 with a `TypeError`, so anything else here would turn a bookmark
 * into a 500. The default matches the Runtime's, so a URL that says nothing
 * pages identically on both sides of the boundary.
 */
export const MEMORY_PAGE_SIZES = [25, 50, 100] as const;

export const DEFAULT_MEMORY_PAGE_SIZE = 50;

/**
 * The Runtime refuses to skip further than this, so a URL past it cannot be
 * honoured and is reported rather than forwarded.
 */
export const MAX_MEMORY_OFFSET = 100_000;

const ROUTE = "/memory";

/**
 * The cohort-tab filter keys, in the order the URL writes them.
 *
 * One list so the scope type, the URL writer, and the page's parser cannot
 * disagree about which keys exist.
 */
export const COHORT_FILTER_KEYS = [
  "memoryMode",
  "injectionResult",
  "reportKind",
  "outcomeKind",
  "useKind"
] as const;

/**
 * Assemble the list's query string. `offset` is omitted at the first page so
 * that the common case is the short, readable URL an operator would type.
 */
function listParams(scope: MemoryListScope, offset: number): URLSearchParams {
  const params = new URLSearchParams({
    tab: scope.tab,
    workspaceId: scope.workspaceId,
    from: scope.from,
    until: scope.until,
    limit: String(scope.limit)
  });
  if (scope.query) params.set("query", scope.query);
  if (scope.kind && scope.kind !== "all") params.set("kind", scope.kind);
  if (scope.status && scope.status !== "all")
    params.set("status", scope.status);
  if (scope.tab === "cohorts") {
    for (const key of COHORT_FILTER_KEYS) {
      const value = scope[key];
      if (value && value !== "all") params.set(key, value);
    }
  }
  if (offset > 0) params.set("offset", String(offset));
  return params;
}

/**
 * The list's query string, without the route.
 *
 * Exposed separately because a governed action has to carry the list forward
 * too: the Console's mutation route redirects back to `/memory`, and a redirect
 * that rebuilds the query from scratch is how an operator loses the filters
 * they had just acted within. The route re-parses these keys rather than
 * trusting this string, so it is a set of facts and not a URL to be followed.
 */
export function memoryListQuery(
  scope: MemoryListScope,
  offset: number = scope.offset
): string {
  return listParams(scope, offset).toString();
}

/** The current list, with nothing selected. */
export function memoryListHref(scope: MemoryListScope): string {
  return `${ROUTE}?${memoryListQuery(scope)}`;
}

/**
 * One row of the current list, opened for inspection.
 *
 * The filters and position are carried deliberately: an operator comparing
 * records inside a narrowed list should come back to that list, not to the
 * top of an unfiltered one.
 */
export function memoryDetailHref(
  scope: MemoryListScope,
  detailKey: MemoryDetailKey,
  id: string
): string {
  const params = listParams(scope, scope.offset);
  params.set(detailKey, id);
  return `${ROUTE}?${params.toString()}`;
}

/**
 * One experience, opened from another tab.
 *
 * A record says which experiences it was derived from, and those ids were
 * rendered as a bare count — the operator could read that a claim had three
 * sources and had no way to reach any of them. This crosses tabs deliberately,
 * because the thing being identified is only addressable on the Experiences
 * tab.
 *
 * The current window travels with it, so the drawer closes back into the list
 * the operator came from rather than into an unfiltered default.
 */
export function memoryExperienceHref(
  scope: MemoryListScope,
  id: string
): string {
  const params = listParams({ ...scope, tab: "experiences" }, scope.offset);
  params.set("experienceId", id);
  return `${ROUTE}?${params.toString()}`;
}

/** A different page of the same list, with the same filters. */
export function memoryPageHref(scope: MemoryListScope, offset: number): string {
  return `${ROUTE}?${listParams(scope, Math.max(0, offset)).toString()}`;
}

/**
 * The same list after its filter controls are submitted.
 *
 * The page position is dropped rather than preserved, and that is the point:
 * these are the controls that change *which* rows match, so the result is a new
 * list, and a new list starts at its first page. Carrying the old offset
 * forward would land the operator on page 7 of a result that has two pages --
 * an empty table with a working Previous link and nothing explaining why.
 *
 * The controls that are *not* on this bar (the workspace scope, the time
 * window, the page size) are preserved instead, because they describe the list
 * being narrowed rather than the narrowing itself.
 */
export function memoryFilterHref(scope: MemoryListScope): string {
  return `${ROUTE}?${listParams(scope, 0).toString()}`;
}

/**
 * Resolve the page position a URL asked for.
 *
 * `limit` goes through the shared bounded-filter resolver, so an unrecognised
 * page size is reported through the same notice as an unrecognised kind rather
 * than silently becoming the default. `offset` has no such vocabulary -- it is
 * a free integer -- so it is bounded here and reported the same way when the
 * bound or the page grid rejects it.
 *
 * The grid matters because the page links are built from it. Previous and Next
 * produce exact multiples of `limit`, so an offset that is not a multiple can
 * only have come from a hand-edited URL; reading it as written would report a
 * range the operator cannot navigate back from, because Previous would then
 * land off-grid itself.
 */
export function resolveMemoryPage(
  rawLimit: string | undefined,
  rawOffset: string | undefined
): {
  readonly page: MemoryPage;
  readonly unapplied: readonly UnappliedFilter[];
} {
  const unapplied: UnappliedFilter[] = [];

  const limitResult = resolveFilter(rawLimit, {
    name: "limit",
    allowed: MEMORY_PAGE_SIZES.map(String),
    fallback: String(DEFAULT_MEMORY_PAGE_SIZE)
  });
  if (limitResult.unapplied !== null) unapplied.push(limitResult.unapplied);
  const limit = Number(limitResult.value);

  const requested = (rawOffset ?? "").trim();
  let offset = 0;
  if (requested !== "") {
    const parsed = Number(requested);
    const inBounds =
      Number.isInteger(parsed) && parsed >= 0 && parsed <= MAX_MEMORY_OFFSET;
    if (inBounds) {
      // Snap to the page grid; report it when snapping changed the request.
      const onGrid = Math.floor(parsed / limit) * limit;
      if (onGrid !== parsed) {
        unapplied.push({ name: "offset", value: requested.slice(0, 40) });
      }
      offset = onGrid;
    } else {
      unapplied.push({ name: "offset", value: requested.slice(0, 40) });
    }
  }

  return { page: { limit, offset }, unapplied };
}
