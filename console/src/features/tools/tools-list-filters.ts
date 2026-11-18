/**
 * What the catalogue's address asks for.
 *
 * The address carries three filters, and a page reads them out of the query
 * string before it renders anything. This module is the one reader of that
 * address: the list page asks it what the operator asked for, and the detail
 * page asks it what narrowing the operator carried with them, so both pages
 * read the same address the same way.
 */

/**
 * The value of a query parameter.
 *
 * A repeated parameter takes its first value, which is what the browser's own
 * form submission produces and what the other list surfaces read.
 */
function firstValue(value: string | readonly string[] | undefined): string {
  if (typeof value === "string") return value;
  if (value === undefined) return "";
  return value[0] ?? "";
}

/**
 * Everything the catalogue's address can carry.
 *
 * The three filters compose: a source, a role and a query are all applied,
 * because each one answers a different question about the same list.
 */
export interface ToolsListFilters {
  /** `"all"` and `""` both mean "every source"; neither is written out. */
  readonly source: string;
  readonly role: string;
  readonly query: string;
}

/**
 * The filters an address asks for.
 *
 * The source is returned as the address wrote it, unvalidated: a source the
 * page cannot honour is the page's fact to report, not this module's to
 * quietly answer with "all". The view resolves it and names the one the
 * address asked for and the catalogue does not have.
 */
export function readToolsFilters(
  params: Readonly<Record<string, string | readonly string[] | undefined>>
): ToolsListFilters {
  return {
    source: firstValue(params.source),
    role: firstValue(params.role),
    query: firstValue(params.q)
  };
}
