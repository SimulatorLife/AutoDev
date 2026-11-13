import type { ToolUsageEvidence } from "@simulatorlife/autodev-core";

/**
 * Resolve the historical use/error evidence for a single Tools catalog
 * entry from the Usage telemetry's tool-call breakdown.
 *
 * The Tools catalog itself never invents counts; this helper only
 * translates what the dedicated read-only Usage telemetry path already
 * recorded, and renders anything else as explicitly unobserved.
 *
 * The Usage `mcp-by-tool` widget exposes call counts grouped by tool name;
 * the matching algorithm walks each canonical identity the catalog exposes
 * for a tool (bare name, Codex-prefixed MCP form, source-qualified form)
 * and stops at the first hit. `mcp-errors` is a global Usage widget; the
 * per-tool error count is intentionally left null because the canonical
 * Usage telemetry path does not break errors down by tool name. The
 * catalog never synthesises per-tool error counts.
 *
 * The identities are the caller's rather than this helper's: the catalogue
 * owns the identity of a tool, and the telemetry store only knows the names
 * it happened to record.
 */
export function toolUsageEvidence(
  callsByTool:
    readonly { readonly tool: string; readonly count: number }[] | null,
  identities: readonly string[]
): ToolUsageEvidence {
  let observedCalls: number | null = null;
  if (callsByTool !== null) {
    for (const identity of identities) {
      const match = callsByTool.find((entry) => entry.tool === identity);
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

/**
 * What the tool's usage panel shows.
 *
 * The states are the three the evidence can be in, plus the state in which
 * it has not arrived. The pending state is not one of the evidence's states:
 * a panel that is still waiting has not been told that the tool made no
 * calls, and rendering that absence as a measurement is the failure this
 * state exists to prevent.
 */
export type ToolUsageState =
  | { readonly kind: "pending" }
  | { readonly kind: "not-configured" }
  | { readonly kind: "unavailable" }
  | { readonly kind: "not-observed" }
  | { readonly kind: "observed"; readonly calls: number };
