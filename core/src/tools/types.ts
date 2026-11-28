import type { AgentRole } from "../agents/types.ts";

/**
Composite Tools catalog surface.

Tools is a read model that joins the canonical authorities (RuleSync
MCP declarations and the execution-contract role projection) plus the
Codex-hosted and bridge-injected native tools. It does not introduce a
second configuration authority; mutation/edit ownership stays with the
originating MCP/plugin/runtime owner and the catalog only links to the
canonical edit surface.
*/

export type ToolSource = "native" | "mcp" | "plugin";

/**
Authoritative source that produced this tool entry. The Tools catalog
never claims a tool is ready without an authoritative source.
*/
export type ToolSourceAuthority =
  "rulesync-mcp" | "rulesync-plugin" | "execution-contract" | "codex-native";

/**
Availability states for a Tools catalog entry. The catalog never fabricates
ready/healthy values; missing or invalid authority remains explicit.
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
Historical use/error evidence for one tool. Both counters are nullable so
that missing telemetry is rendered explicitly rather than defaulted to
zero; `observed` distinguishes a genuine zero from unobserved telemetry.
*/
export interface ToolUsageEvidence {
  readonly calls: number | null;
  readonly errors: number | null;
  readonly observed: boolean;
}

/**
How complete the catalogue's content is.

This is a statement about the entries that arrived, not about whether every
source behind them was read: `coverage` says what the catalogue holds, and
`validity` and `executionContractObserved` say what was read.

- `complete`: the catalogue holds RuleSync-declared tools.
- `partial`: the catalogue holds tools, but none the RuleSync source
  declared -- only the execution contract's role projection contributed.
- `unavailable`: no tool entry was rendered.
- `unknown`: the RuleSync source was not observed, so the catalogue's
  content is not known.
*/
export type ToolCatalogCoverage =
  "complete" | "partial" | "unavailable" | "unknown";

export type ToolCatalogValidity = "valid" | "invalid" | "not-observed";
