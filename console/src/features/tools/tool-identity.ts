import type { ToolCatalogItem } from "@simulatorlife/autodev-core";

/**
 * The MCP wire name for a catalog entry.
 *
 * The catalog keeps `source`, `server` and `name` as three fields and keys
 * entries on all three, so the joined `mcp__<server>__<name>` form is a
 * composition, not a field. It was being assembled independently in four
 * places -- the URL id, the Usage identity list, the list cell and the detail
 * page -- which is how the list cell came to print
 * `mcp__codegraphcontext__analyze_code_relationships` beside a Source column
 * already reading `mcp (codegraphcontext)`.
 */
export function qualifiedToolName(tool: ToolCatalogItem): string {
  return tool.server ? `mcp__${tool.server}__${tool.name}` : tool.name;
}

/**
 * Canonical identifiers the Usage telemetry breakdown may use for a Tools
 * catalog entry. The dedicated read-only Usage path surfaces the
 * `mcp-by-tool` widget whose rows are matched by tool name; the catalog
 * exposes the same identifiers so callers can map between the two without
 * inventing new authority.
 */
export function canonicalToolIdentity(
  tool: ToolCatalogItem
): readonly string[] {
  const identities = new Set<string>([tool.name]);
  if (tool.server) {
    identities.add(qualifiedToolName(tool));
    identities.add(tool.server + "__" + tool.name);
  }
  return Array.from(identities);
}

/**
 * Stable URL id for a Tools catalog entry. The Console list and detail
 * pages share this id so URL-addressable navigation stays stable across
 * both source and role filter changes.
 */
export function toolId(tool: ToolCatalogItem): string {
  return encodeURIComponent(qualifiedToolName(tool));
}
