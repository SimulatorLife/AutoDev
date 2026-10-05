import type { ToolCatalogItem } from "@simulatorlife/autodev-core";

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
    identities.add(`mcp__${tool.server}__${tool.name}`);
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
  if (tool.server) {
    return encodeURIComponent("mcp__" + tool.server + "__" + tool.name);
  }
  return encodeURIComponent(tool.name);
}
