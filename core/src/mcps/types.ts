import type { AgentRole } from "../agents/types.ts";

export interface McpServerConfig {
  readonly name: string;
  readonly command?: string;
  readonly args?: readonly string[];
  readonly env?: Record<string, string>;
  readonly defaultToolsApprovalMode?: string;
}

export interface McpTool {
  readonly name: string;
  readonly server: string;
  readonly description?: string;
  readonly inputSchema?: Record<string, unknown>;
}

export interface McpResource {
  readonly uri: string;
  readonly name: string;
  readonly server: string;
  readonly mimeType?: string;
}

export interface McpPrompt {
  readonly name: string;
  readonly server: string;
  readonly description?: string;
}

export type McpServerTransport = "stdio" | "http" | "unknown";

export interface McpTargetOverride {
  readonly target: string;
  readonly enabled: boolean;
  readonly defaultToolsApprovalMode?: string;
  readonly enabledTools?: readonly string[];
}

/** Safe desired-state summary of one canonical RuleSync MCP declaration. */
export interface McpServerDefinition {
  readonly name: string;
  /** null means the server exists only in target projections, not in the base list. */
  readonly enabled: boolean | null;
  readonly transport: McpServerTransport;
  /** Explicit overrides only; a missing target entry carries no inferred state. */
  readonly targetOverrides: readonly McpTargetOverride[];
  readonly command?: string;
  readonly args?: readonly string[];
  readonly url?: string;
  readonly envKeys?: readonly string[];
  readonly cwd?: string;
  readonly defaultToolsApprovalMode?: string;
}

/** Combined canonical declaration and generated role-exposure projection. */
export interface McpServerResource extends McpServerDefinition {
  readonly declared: boolean;
  readonly roles: readonly AgentRole[];
}

export interface RuleSyncMcpState {
  readonly source: ".rulesync/mcp.jsonc";
  readonly valid: boolean | null;
  readonly servers: readonly McpServerDefinition[];
}
