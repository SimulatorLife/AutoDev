import type { ToolCatalogItem, ToolSource } from "@simulatorlife/autodev-core";

/**
 * The one owner of the tool catalogue's address.
 *
 * The catalogue is the largest list in the Console -- 56 entries in the live
 * instance -- and it was the only catalogue that could not be searched. It
 * could be narrowed by source and by role, but only by clicking a facet: there
 * was no way to ask for a tool by name, so an operator who already knew the
 * tool they wanted still had to read the table to find it.
 *
 * So the catalogue takes the product's own filter bar, like the prompt
 * catalogue beside it, and the address that carries it is built in one place.
 * Four filters share one address, so each of them has to carry the others:
 *
 * - a query submitted by the form keeps the source and role already chosen;
 * - a facet clicked from a narrowed list keeps the query;
 * - the entry a row links to carries the list's state, so the breadcrumb
 *   returns the operator to the list they came from rather than to the whole
 *   catalogue;
 * - the role a detail page links back with carries the same state.
 *
 * Before this module each of those rebuilt the query string by hand, and the
 * facet links dropped the query entirely -- so narrowing by search and then
 * clicking a source facet silently widened the list back to everything.
 */

/** The route the tool catalogue lives at. */
export const TOOLS_LIST_PATH = "/tools";

/**
 * Every source the catalogue can be filtered by.
 *
 * `"all"` is a real answer to `?source=all`, not a request for an unknown
 * source, so it belongs in the set the page accepts.
 */
export const TOOL_SOURCE_FILTERS = ["all", "native", "mcp", "plugin"] as const;

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

export function isToolSource(value: string): value is ToolSource {
  return value === "native" || value === "mcp" || value === "plugin";
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

/**
 * The list's query string, without the route.
 *
 * Exposed on its own because an entry's own address needs it: the detail route
 * is a path, so the list's state travels beside it as a query.
 */
export function toolsListQuery(filters: ToolsListFilters): string {
  const params = new URLSearchParams();
  if (filters.source && filters.source !== "all") {
    params.set("source", filters.source);
  }
  if (filters.role) params.set("role", filters.role);
  if (filters.query) params.set("q", filters.query);
  return params.toString();
}

/**
 * The address of the list.
 *
 * An unfiltered list is written without a query at all rather than with an
 * empty one: a bare `?q=` is a different address from no address, and the list
 * should have one address.
 */
export function toolsListHref(filters: ToolsListFilters): string {
  const query = toolsListQuery(filters);
  return query ? `${TOOLS_LIST_PATH}?${query}` : TOOLS_LIST_PATH;
}

/** The same list, narrowed to one source. */
export function toolsSourceHref(
  filters: ToolsListFilters,
  source: ToolSource | "all"
): string {
  return toolsListHref({ ...filters, source });
}

/** The same list, narrowed to one role -- or to every role, when the role is empty. */
export function toolsRoleHref(filters: ToolsListFilters, role: string): string {
  return toolsListHref({ ...filters, role });
}

/**
 * The address of one catalogue entry, with the list's state carried along.
 *
 * The detail route is a path, so the state the operator narrowed the list with
 * travels beside it. Without this the breadcrumb on the detail page returned
 * the operator to the whole catalogue and they had to search for the same tool
 * a second time.
 */
export function toolDetailHref(filters: ToolsListFilters, id: string): string {
  const query = toolsListQuery(filters);
  const path = `${TOOLS_LIST_PATH}/${id}`;
  return query ? `${path}?${query}` : path;
}

/**
 * The catalogue's entries a set of filters keeps.
 *
 * The query is matched against the tool's own identifiers -- its name, the
 * server it belongs to and its description -- because an operator looking for a
 * tool knows it by any of the three: the command they type, the MCP server
 * that serves it, or the sentence that describes what it does. Matching is on
 * substrings rather than whole words, so "goto" finds "lsp_goto_definition",
 * and it ignores case because a tool name is typed in lower case.
 *
 * The source and the role are not matched against the query. They are the
 * facets, and the facets are chosen by clicking; a free-text query that also
 * matched them would make "smart" return the tools exposed to the smart role
 * and every tool whose description happened to contain the word.
 */
export function filterTools(
  tools: readonly ToolCatalogItem[],
  filters: ToolsListFilters
): readonly ToolCatalogItem[] {
  const source = isToolSource(filters.source) ? filters.source : null;
  const role = filters.role;
  // Trimmed here rather than by the caller: a query that is only whitespace
  // is not a query, and the module that owns the matching rule owns what
  // counts as one.
  const needle = filters.query.trim().toLowerCase();
  if (source === null && role === "" && needle === "") return tools;
  return tools.filter((tool) => {
    if (source !== null && tool.source !== source) return false;
    if (role !== "" && !tool.exposedRoles.includes(role)) return false;
    if (needle !== "" && !toolMatchesQuery(tool, needle)) return false;
    return true;
  });
}

function toolMatchesQuery(tool: ToolCatalogItem, needle: string): boolean {
  return [tool.name, tool.server ?? "", tool.description ?? ""].some((field) =>
    field.toLowerCase().includes(needle)
  );
}
