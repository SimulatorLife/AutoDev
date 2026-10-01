import type { AgentRole } from "../agents/types.ts";

export type ToolSource = "native" | "mcp" | "plugin";

export interface ToolCatalogItem {
  readonly name: string;
  readonly source: ToolSource;
  readonly server?: string;
  readonly description?: string;
  readonly exposedRoles: readonly AgentRole[];
  readonly status?: "ready" | "unavailable";
}
