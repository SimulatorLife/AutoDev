import type { AgentRole } from "../agents/types.ts";
import type { RuleSyncValidationIssue } from "../validation/types.ts";

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
 * The launch configuration of one MCP server, as the declaration states it.
 *
 * These are the keys that say how a server is started or where it is reached,
 * and they are the whole of the configuration the applied projection carries.
 * A target's own override wins over the base declaration for the same key, so
 * this is what one target would receive for one server.
 *
 * The shape is deliberately lossless about the launch keys: an applied
 * projection is compared against this configuration key by key, and a
 * comparison that cannot see a key cannot see it drift.
 */
export interface McpServerLaunchConfiguration {
  readonly name: string;
  readonly command?: string;
  readonly args?: readonly string[];
  readonly cwd?: string;
  readonly url?: string;
  readonly bearerTokenEnvVar?: string;
  readonly httpHeaders?: Readonly<Record<string, string>>;
}

/**
 * The canonical launch configuration for one target.
 *
 * `valid: null` means the canonical source was not read at all, which is a
 * different fact from `valid: false`, which means it was read and could not be
 * applied. Neither ever produces a server list.
 */
export interface RuleSyncMcpLaunchState {
  readonly source: ".rulesync/mcp.jsonc";
  readonly valid: boolean | null;
  readonly issues: readonly RuleSyncValidationIssue[];
  /** The target whose configuration this is. */
  readonly target: string;
  readonly servers: readonly McpServerLaunchConfiguration[];
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
