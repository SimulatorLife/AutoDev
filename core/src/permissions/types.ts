import type { AgentRole } from "../agents/types.ts";

/**
Approval policies supported by Codex CLI and Rulesync's `codexcli` permissions
schema (`"never"` for autonomous execution, `"on-request"` for interactive
approval prompts).
*/
export const APPROVAL_POLICIES = ["never", "on-request"] as const;

export type ApprovalPolicy = (typeof APPROVAL_POLICIES)[number];

/**
Is this an approval policy the product supports?
*/
export function isApprovalPolicy(value: unknown): value is ApprovalPolicy {
  return (
    typeof value === "string" &&
    (APPROVAL_POLICIES as readonly string[]).includes(value)
  );
}

/**
The permission policy of a Codex session, declared in `.rulesync/permissions.jsonc`.
*/
export interface PermissionPolicy {
  readonly approvalPolicy: ApprovalPolicy;
  readonly approvalsReviewer: string;
  readonly webSearch: boolean;
}

export interface RoleCapabilityMatrix {
  readonly role: AgentRole;
  /**
  Whether this role is restricted to read-only file/tool capabilities.
  */
  readonly readOnly: boolean;
  readonly allowedMcpServers: readonly string[];
  readonly allowedSkills: readonly string[];
  /**
  Which tools of which MCP server this role may call.
  
  A role with no entry here reaches no MCP tools.
  */
  readonly allowedMcpTools: Readonly<Record<string, readonly string[]>>;
}
