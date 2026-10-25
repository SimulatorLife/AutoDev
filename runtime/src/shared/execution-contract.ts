import { readFileSync } from "node:fs";
import path from "node:path";

import { resolveRuntimeSourceRoot } from "@simulatorlife/autodev-runtime/shared/runtime-source-root";

export interface RoleContract {
  mcp: string[];
  mcpEnvVars?: Record<string, string[]>;
  roleScopedMcp?: string[];
  webResearch?: {
    search?: boolean;
    fetch?: boolean;
    optionalMcp?: string[];
  };
  [key: string]: unknown;
}
export interface ProviderContract {
  spawnTools: string[];
  delegation: "native" | "codex-shim" | "bridge-native" | "none";
  permissionMode: string;
  roleMcpInjection?: boolean;
  [key: string]: unknown;
}

/**
 * A role's entry in one workspace's section of the contract.
 *
 * Only the skill list is per-workspace: the MCP servers, the read-only flag,
 * and everything else a role carries stay global, so a workspace adds a skill
 * to a role without restating the role.
 */
export interface WorkspaceRoleContract {
  skills?: string[];
  [key: string]: unknown;
}

/** One workspace's section of the contract. */
export interface WorkspaceContract {
  roles?: Record<string, WorkspaceRoleContract>;
  [key: string]: unknown;
}

export interface ExecutionContract {
  roles: Record<string, RoleContract>;
  providers: Record<string, ProviderContract>;
  /**
   * The per-workspace skill assignments.
   *
   * A skill installed inside a repository belongs to that repository's
   * workspace alone, so its assignment lives here rather than in the global
   * roles: the global list would claim it for workspaces it does not belong
   * to.
   */
  workspaces?: Record<string, WorkspaceContract>;
  [key: string]: unknown;
}

export type SandboxMode = "read-only" | "workspace-write";

/**
 * The workspace id grammar the contract and the workspace catalogue share: a
 * canonical `owner/repository` key.
 */
const WORKSPACE_ID_PATTERN = /^[^/\s]+\/[^/\s]+$/u;

// The contract lives with the Runtime's configuration, not with the module:
// the installed tree at `CODEX_HOME/src` sits one level shallower than the
// source checkout, so a path relative to this file would miss the installed
// copy.
const CONTRACT_PATH = path.join(
  resolveRuntimeSourceRoot(import.meta.dirname),
  "config",
  "execution-contract.json"
);
const CONTRACT = Object.freeze(
  JSON.parse(readFileSync(CONTRACT_PATH, "utf8")) as ExecutionContract
);

export const EXECUTION_CONTRACT = CONTRACT;

function contractRoleKey(role: unknown): string {
  return typeof role === "string" && role.trim()
    ? role.trim().toLowerCase()
    : "default";
}

function skillNames(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter(
        (entry): entry is string =>
          typeof entry === "string" && entry.trim().length > 0
      )
    : [];
}

/**
 * The skills one role gains in one workspace of a contract.
 *
 * A workspace that declares nothing for the role grants it nothing, and the
 * global list stands unchanged.
 */
export function contractRoleSkills(
  contract: ExecutionContract,
  role: string,
  workspace: string | null | undefined
): string[] {
  if (!workspace) return [];
  return skillNames(contract.workspaces?.[workspace]?.roles?.[role]?.skills);
}

/**
 * The role contract, projected for one workspace.
 *
 * A workspace adds skills to a role; it never removes them and never changes
 * anything else about the role. The global contract is frozen, so a workspace
 * that adds something yields a new object rather than a mutated one.
 *
 * A turn that names no workspace gets the global contract: a role's skills are
 * the contract's business, and a guess about which workspace a turn is for
 * would hand it skills it must not have.
 */
export function roleContract(
  role: unknown,
  workspace?: string | null
): RoleContract {
  const key = contractRoleKey(role);
  const global = CONTRACT.roles[key] ?? CONTRACT.roles.default ?? { mcp: [] };
  if (workspace === undefined || workspace === null) return global;
  const workspaceSkills = contractRoleSkills(CONTRACT, key, workspace);
  if (workspaceSkills.length === 0) return global;
  const skills = [
    ...new Set([...skillNames(global.skills), ...workspaceSkills])
  ].sort();
  return { ...global, skills };
}

/**
 * The workspace id a workspace key names, or null when it names none.
 *
 * A workspace key is the router's identity for a turn's workspace. It is an
 * `owner/repository` id when the client named the repository and a path label
 * otherwise, so only the first kind can select a workspace in the contract: a
 * label is not a workspace id, and treating one as an id would attach a turn
 * to a workspace nobody configured.
 */
export function workspaceIdFromKey(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const key = value.trim();
  return WORKSPACE_ID_PATTERN.test(key) ? key : null;
}

export function providerContract(provider: string): ProviderContract {
  return (
    CONTRACT.providers[provider] ?? {
      spawnTools: [],
      delegation: "none",
      permissionMode: "unknown",
      roleMcpInjection: false
    }
  );
}

/** MCP servers that must be launched inside a role-scoped provider session. */
export function roleScopedMcp(role: unknown): string[] {
  return roleContract(role).roleScopedMcp ?? [];
}

/** Whether a provider bridge owns MCP startup and role-specific tool filtering. */
export function providerInjectsRoleMcp(provider: string): boolean {
  return providerContract(provider).roleMcpInjection === true;
}

/**
 * Resolve the role's sandbox mode from the execution contract.
 *
 * The contract's `readOnly` flag is the authoritative source. The orchestrator
 * tier is never read-only by design (it owns the workspace-write budget for
 * the session); unknown / empty role names return null so callers can decide
 * whether to default to workspace-write or refuse.
 *
 *   readOnly: true               -> "read-only"
 *   readOnly: false, any tier    -> "workspace-write"
 *   unknown / empty role         -> null
 */
export function resolveSandboxMode(
  role: string | null | undefined
): SandboxMode | null {
  if (typeof role !== "string") return null;
  const key = role.trim().toLowerCase();
  if (!key) return null;
  const contract = CONTRACT.roles[key];
  if (!contract) return null;
  if (contract.readOnly === true) return "read-only";
  if (contract.readOnly === false) return "workspace-write";
  return null;
}
