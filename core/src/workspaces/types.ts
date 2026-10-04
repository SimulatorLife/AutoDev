import type { AgentRole } from "../agents/types.ts";

/** Canonical AutoDev workspace/repository configuration. */
export interface WorkspaceEntry {
  /** Stable workspace key; currently the canonical GitHub owner/repository. */
  readonly id: string;
  readonly baseBranch: string;
  readonly enabled: boolean;
  /** Null means workspace role scope has not been configured. */
  readonly agentRoles: readonly AgentRole[] | null;
}

export type WorkspaceCatalogStatus = "valid" | "invalid" | "unavailable";

export interface WorkspaceAttribution {
  readonly workspace: string;
  readonly workspaceId?: string;
  readonly isLocal: boolean;
}
