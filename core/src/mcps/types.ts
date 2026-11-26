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

/**
 * The operator-approved catalogue one Runtime home serves.
 *
 * A backend whose commands are catalogued has two copies of the catalogue: the
 * proposal in the checkout and the approved copy outside every workspace. The
 * approved copy is the one the backend serves, so its approval state is the
 * operator's answer to "which revision is live?".
 *
 * The states are four because the two reads are independent. An installed copy
 * with no proposal to compare it against is not pending approval; it is
 * approved by nobody and known to be running.
 */
export interface McpServerApprovedCatalogue {
  /** The Runtime home whose approved copy this is. */
  readonly home: string;
  /**
   * `approved`: the installed copy is the checkout's proposal.
   * `pending`: it is a different revision than the checkout's proposal.
   * `unavailable`: no approved copy is installed, so the backend serves none.
   * `unknown`: the proposal could not be read, so the two cannot be compared.
   */
  readonly state: "approved" | "pending" | "unavailable" | "unknown";
  /** The digest of the approved copy, or null when none is installed. */
  readonly approvedDigest: string | null;
  /** The digest the checkout proposes, or null when it could not be read. */
  readonly proposedDigest: string | null;
  /** Where the approved copy lives. */
  readonly approvedPath: string;
}

/** Combined canonical declaration and generated role-exposure projection. */
export interface McpServerResource extends McpServerDefinition {
  readonly declared: boolean;
  readonly roles: readonly AgentRole[];
  /**
   * The operator-approved catalogues this backend serves, one per Runtime home.
   *
   * Absent for a backend with no catalogued commands: the declaration says
   * nothing about approvals, so the field is absent rather than empty, and a
   * reader does not have to tell "no approval exists" from "no approval was
   * read".
   */
  readonly approvedCatalogues?: readonly McpServerApprovedCatalogue[] | undefined;
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

/** Tool grants by MCP server, as the shared gateway publishes them. */
export type McpGatewayGrants = Record<string, string[]>;

/**
 * Secret-free operator view of the optional ChatGPT tunnel ingress.
 *
 * Tunnel facts only: the gateway's role surfaces, workspace and grants are
 * published once, on the MCP catalog's `gateway`.
 */
export const CHATGPT_TUNNEL_CONTROL_PATH = "/control/chatgpt-tunnel";
export interface ChatgptTunnelStatus {
  readonly schema: "autodev-chatgpt-tunnel-v2";
  /** The compare-and-swap handle every tunnel mutation carries. */
  readonly revision: string;
  readonly configured: boolean;
  readonly enabled: boolean;
  readonly ready: boolean;
  /** The gateway roles the tunnel publishes as channels, primary role first. */
  readonly roles: readonly string[];
  readonly tunnelId: string | null;
}
export type ChatgptTunnelMutation =
  | { action: "disable" | "enable" | "forget"; expectedRevision: string }
  | { action: "rotate"; expectedRevision: string; runtimeKey: string };
