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
 * The sandbox modes Codex configures a session in.
 *
 * This is the vocabulary the portable source and the role declarations are
 * written in, and it is not the product's: Codex calls the unrestricted mode
 * `danger-full-access` and the product calls it `unrestricted`. The two are
 * related by {@link productSandboxMode} and {@link codexSandboxMode}, so the
 * translation lives in one place instead of in every reader.
 */
export const CODEX_SANDBOX_MODES = [
  "read-only",
  "workspace-write",
  "danger-full-access"
] as const;

export type CodexSandboxMode = (typeof CODEX_SANDBOX_MODES)[number];

/** Is this a sandbox mode Codex configures a session in? */
export function isCodexSandboxMode(value: unknown): value is CodexSandboxMode {
  return (
    typeof value === "string" &&
    (CODEX_SANDBOX_MODES as readonly string[]).includes(value)
  );
}

/**
 * How much authority each product sandbox mode carries, from least to most.
 *
 * The order is what "a role may tighten the session but never widen it" is
 * expressed in: the effective sandbox of a role is the *lower* of the two
 * modes, and a lower mode is one with a lower number.
 */
const SANDBOX_MODE_AUTHORITY: Readonly<Record<SandboxMode, number>> = {
  "read-only": 0,
  "workspace-write": 1,
  unrestricted: 2
};

/** The product's name for a sandbox mode Codex configures a session in. */
export function productSandboxMode(mode: CodexSandboxMode): SandboxMode {
  return mode === "danger-full-access" ? "unrestricted" : mode;
}

/** The name Codex configures a session in for a product sandbox mode. */
export function codexSandboxMode(mode: SandboxMode): CodexSandboxMode {
  return mode === "unrestricted" ? "danger-full-access" : mode;
}

/**
 * The stricter of two sandbox modes.
 *
 * A role may narrow the sandbox it runs in; it may never widen it. That is
 * Codex's own rule for a spawned agent -- a role customizes the child or
 * reduces its capabilities, never replaces the parent session's authority --
 * and it is the rule the product's role declarations are read under.
 */
export function tighterSandboxMode(
  a: SandboxMode,
  b: SandboxMode
): SandboxMode {
  return SANDBOX_MODE_AUTHORITY[a] <= SANDBOX_MODE_AUTHORITY[b] ? a : b;
}

/**
 * The sandbox a role actually runs in.
 *
 * The role's own declaration and the session's sandbox are both ceilings: a
 * role may narrow the sandbox it runs in, never widen it. A role that declares
 * no sandbox inherits the session's, and a role that declares a wider one than
 * the session runs in gets the session's.
 *
 * `null` means the mode could not be observed -- neither the declaration nor
 * the session's sandbox was readable -- which is not the same as any mode.
 */
export function effectiveSandboxMode(
  declared: SandboxMode | null,
  session: SandboxMode | null
): SandboxMode | null {
  if (session === null) return declared;
  if (declared === null) return session;
  return tighterSandboxMode(declared, session);
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
   * Derived from the role's effective sandbox mode, which is the fact; a mode
   * that could not be observed is neither read-only nor not.
   */
  readonly readOnly: boolean;
  /**
   * The sandbox this role actually runs in.
   *
   * The stricter of the role's own declaration and the session's sandbox: a
   * role may narrow the sandbox it runs in, never widen it. Null when neither
   * could be observed.
   */
  readonly sandboxMode: SandboxMode | null;
  /**
   * The sandbox this role declares for itself.
   *
   * Kept beside the effective mode because the two answer different
   * questions, and a role that asks for more than the session allows is a
   * fact an operator wants to see rather than a value to fold away.
   */
  readonly declaredSandboxMode: SandboxMode | null;
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
