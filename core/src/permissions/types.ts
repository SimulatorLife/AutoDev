import type { AgentRole } from "../agents/types.ts";

export type ApprovalPolicy = "never" | "always" | "on-demand";

/**
 * Every sandbox mode the product supports, and the only place the vocabulary
 * is written down.
 *
 * `SandboxMode` is derived from this list rather than written beside it, so the
 * type and the runtime check cannot disagree about what is valid: adding a mode
 * here widens both at once. Consumers validate with {@link isSandboxMode}
 * instead of restating the values, which is what let a drifted mode render as a
 * confident novel policy name in the Console.
 */
export const SANDBOX_MODES = [
  "read-only",
  "workspace-write",
  "unrestricted"
] as const;

export type SandboxMode = (typeof SANDBOX_MODES)[number];

/** Is this a sandbox mode the product supports? */
export function isSandboxMode(value: unknown): value is SandboxMode {
  return (
    typeof value === "string" &&
    (SANDBOX_MODES as readonly string[]).includes(value)
  );
}

/**
 * The permission policy of a session.
 *
 * These are the settings the canonical source declares, and no others. A
 * policy field with no canonical key behind it is a value the product would be
 * inventing: the policy used to carry a `defaultToolsApprovalMode` that no
 * source declared, and the Console rendered a policy that was not the policy
 * the product ran.
 */
export interface PermissionPolicy {
  readonly approvalPolicy: ApprovalPolicy;
  readonly sandboxMode: SandboxMode;
  readonly approvalsReviewer: string;
  readonly networkAccess: boolean;
  readonly webSearch: boolean;
}

export interface RoleCapabilityMatrix {
  readonly role: AgentRole;
  /**
   * Whether this role runs in the read-only sandbox.
   *
   * Derived from the role's own sandbox mode, which is the fact; a mode that
   * could not be observed is neither read-only nor not.
   */
  readonly readOnly: boolean;
  /**
   * The sandbox this role runs in, as its own declaration states it.
   *
   * Null when the declaration could not be read. The matrix used to answer
   * every role but the read-only ones with `workspace-write`, so the
   * orchestrator -- declared `danger-full-access` -- was shown as a sandboxed
   * role, and an unreadable declaration was shown as the nearest mode the
   * product knows rather than as not observed.
   */
  readonly sandboxMode: SandboxMode | null;
  readonly allowedMcpServers: readonly string[];
  readonly allowedSkills: readonly string[];
  /**
   * Which tools of which MCP server this role may call.
   *
   * Server exposure alone does not answer the question an operator actually
   * asks. The execution contract names the servers a role may reach *and*, per
   * server, the tools it may call within them, and the projection used to drop
   * the second half -- so the page could say a role reaches `lsp` and not which
   * of its tools. Reaching a server is not the same as being permitted to call
   * everything on it, and the page implied the latter by omission.
   *
   * A role with no entry here reaches no MCP tools. That is the same
   * distinction the servers column makes: absent is not "everything".
   */
  readonly allowedMcpTools: Readonly<Record<string, readonly string[]>>;
}
