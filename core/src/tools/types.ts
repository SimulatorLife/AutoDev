import type { AgentRole } from "../agents/types.ts";

/**
 * Composite Tools catalog surface.
 *
 * Tools is a read model that joins the canonical authorities (RuleSync
 * MCP declarations and the execution-contract role projection) plus the
 * Codex-hosted and bridge-injected native tools. It does not introduce a
 * second configuration authority; mutation/edit ownership stays with the
 * originating MCP/plugin/runtime owner and the catalog only links to the
 * canonical edit surface.
 */

export type ToolSource = "native" | "mcp" | "plugin";

/**
 * Authoritative source that produced this tool entry. The Tools catalog
 * never claims a tool is ready without an authoritative source.
 */
export type ToolSourceAuthority =
  "rulesync-mcp" | "rulesync-plugin" | "execution-contract" | "codex-native";

/**
 * Availability states for a Tools catalog entry. The catalog never fabricates
 * ready/healthy values; missing or invalid authority remains explicit.
 */
export type ToolAvailability = "configured" | "not-observed" | "invalid";

export interface ToolCatalogItem {
  readonly name: string;
  readonly source: ToolSource;
  readonly sourceAuthority: ToolSourceAuthority;
  readonly server?: string;
  readonly description?: string;
  readonly exposedRoles: readonly AgentRole[];
  readonly availability: ToolAvailability;
  readonly canonicalEditSurface?: ToolCanonicalEditSurface;
  readonly usage?: ToolUsageEvidence;
}

export interface ToolCanonicalEditSurface {
  readonly section: "mcps" | "agents" | "prompts";
  readonly identifier: string;
  readonly label?: string;
}

/**
 * Historical use/error evidence for one tool. Both counters are nullable so
 * that missing telemetry is rendered explicitly rather than defaulted to
 * zero; `observed` distinguishes a genuine zero from unobserved telemetry.
 */
export interface ToolUsageEvidence {
  readonly calls: number | null;
  readonly errors: number | null;
  readonly observed: boolean;
}

/**
 * Top-level Tools view contract returned by `/control/tools`.
 *
 * Schema bumped from `autodev-control-tools-v1` to `-v2` so the payload
 * carries `availability`, `sourceAuthority`, and `canonicalEditSurface`.
 * The v1 shape was a narrower configuration projection; the v2 shape is
 * the composite effective catalog documented in the Console target.
 *
 * `source` remains the originating authority for the catalog projections;
 * `coverage` now distinguishes the four real states the catalog can be in.
 */
export interface ToolCatalogView {
  readonly schema: "autodev-control-tools-v2";
  readonly source: string;
  readonly readOnly: true;
  readonly coverage: ToolCatalogCoverage;
  readonly validity: ToolCatalogValidity;
  readonly totalTools: number | null;
  readonly tools: readonly ToolCatalogItem[];
  readonly usageLink: string;
}

export type ToolCatalogCoverage =
  "complete" | "partial" | "unavailable" | "unknown";

export type ToolCatalogValidity = "valid" | "invalid" | "not-observed";
