import type {
  ToolCatalogItem,
  ToolUsageEvidence,
  UsageSnapshot
} from "@simulatorlife/autodev-core";

import { canonicalToolIdentity } from "./tool-identity.ts";

/**
 * Resolve the historical use/error evidence for a single Tools catalog
 * entry from a Usage snapshot. The Tools catalog itself never invents
 * counts; this helper only translates what the dedicated read-only Usage
 * telemetry path already recorded, and renders anything else as explicitly
 * unobserved.
 *
 * The Usage `mcp-by-tool` widget exposes call counts grouped by tool name;
 * the matching algorithm walks each canonical identity the catalog exposes
 * for a tool (bare name, Codex-prefixed MCP form, source-qualified form)
 * and stops at the first hit. `mcp-errors` is a global Usage widget; the
 * per-tool error count is intentionally left null because the canonical
 * Usage telemetry path does not break errors down by tool name. The
 * catalog never synthesises per-tool error counts.
 */
export function filterToolCatalogUsage(
  snapshot: UsageSnapshot,
  tool: ToolCatalogItem
): ToolUsageEvidence {
  const identities = canonicalToolIdentity(tool);
  const calls = snapshot.metrics.callsByTool;
  let observedCalls: number | null = null;
  if (calls !== null) {
    for (const identity of identities) {
      const match = calls.find((entry) => entry.tool === identity);
      if (match) {
        observedCalls = match.count;
        break;
      }
    }
  }
  return {
    calls: observedCalls,
    errors: null,
    observed: observedCalls !== null
  };
}
