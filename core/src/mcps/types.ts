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

/**
 * One reason a canonical source cannot be applied.
 *
 * `location` names the part of the document at fault in the same terms the
 * operator is looking at -- a server name, a target's override of a server, an
 * event name, an action index, or a source line -- and `message` says what is
 * wrong with it. Neither is a diagnosis of the fix; both are the fact the loader
 * observed and would otherwise have discarded.
 *
 * Lives here rather than in the loader because two independent loaders produce
 * it, and a shared shape is what lets the Control API and the Console validate
 * one form across every canonical source instead of per resource.
 */
export interface RuleSyncValidationIssue {
  readonly location: string;
  readonly message: string;
}

export interface RuleSyncMcpState {
  readonly source: ".rulesync/mcp.jsonc";
  readonly valid: boolean | null;
  /**
   * Why the source is invalid; empty when it is valid or was not observed.
   *
   * Required rather than optional so `valid: false` cannot arrive alone. The
   * loader knows which server name, or which target's override of which server,
   * it could not apply; reporting only the flag sent an operator back into the
   * file to re-find a position the system had already located.
   */
  readonly issues: readonly RuleSyncValidationIssue[];
  readonly servers: readonly McpServerDefinition[];
}
