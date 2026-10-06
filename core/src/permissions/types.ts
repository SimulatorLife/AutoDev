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

export interface PermissionPolicy {
  readonly approvalPolicy: ApprovalPolicy;
  readonly sandboxMode: SandboxMode;
  readonly networkAccess: boolean;
  readonly webSearch: boolean;
  readonly approvalsReviewer: string;
  readonly defaultToolsApprovalMode: string;
}

export interface RoleCapabilityMatrix {
  readonly role: AgentRole;
  readonly readOnly: boolean;
  readonly sandboxMode: SandboxMode;
  readonly allowedMcpServers: readonly string[];
  readonly allowedSkills: readonly string[];
}
