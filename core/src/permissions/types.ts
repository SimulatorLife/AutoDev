import type { AgentRole } from "../agents/types.ts";

export type ApprovalPolicy = "never" | "always" | "on-demand";

export type SandboxMode = "read-only" | "workspace-write" | "unrestricted";

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
