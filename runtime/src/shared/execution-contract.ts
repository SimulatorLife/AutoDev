import { readFileSync } from "node:fs";
import path from "node:path";

import { resolveRuntimeSourceRoot } from "@simulatorlife/autodev-runtime/shared/runtime-source-root";

export interface RoleSkillsPolicy {
  readonly includeInstructions?: boolean;
  readonly bundledEnabled?: boolean;
}

export interface RoleReasoningPolicy {
  readonly effort?: string;
  readonly summary?: string;
}

export interface RoleContract {
  mcp: string[];
  readOnly?: boolean;
  shell?: boolean;
  hooks?: boolean;
  mcpTools?: Record<string, string[]>;
  mcpApprovalMode?: Record<string, string>;
  mcpEnvVars?: Record<string, string[]>;
  skillsPolicy?: RoleSkillsPolicy;
  reasoning?: RoleReasoningPolicy;
  webResearch?: {
    search?: boolean;
    fetch?: boolean;
    optionalMcp?: string[];
  };
  [key: string]: unknown;
}
/**
 * How a provider's transport reaches the role-scoped MCP surfaces.
 *
 * `gateway`: the transport's MCP client reaches AutoDev's shared gateway, so
 * every role the gateway publishes is deliverable to it.
 * `local`: the transport runs the role's MCP servers itself, as the ACP
 * providers do with one role-scoped stdio server per contracted MCP server.
 * `site-native`: the transport reaches a role's tools through the site's own
 * connected integration only, so it can serve roles whose tools the site
 * itself provides and no others.
 * `none`: the transport reaches no MCP surface at all.
 */
export type ProviderMcpIngress = "gateway" | "local" | "site-native" | "none";

/**
 * MCP servers the site itself delivers through its own connected
 * integration. A `site-native` transport can serve only the roles whose MCP
 * surface is made entirely of these.
 */
export const SITE_NATIVE_MCP_SERVERS: readonly string[] = Object.freeze([
  "github"
]);

export interface ProviderContract {
  /**
   * `xacpx`: the provider delegates exclusively through the canonical `xacpx`
   * MCP interface over the shared Supergateway.
   * `none`: the provider cannot serve the orchestrator tier, because its
   * transport cannot reach the delegation surface.
   */
  delegation: "xacpx" | "none";
  permissionMode: string;
  /** How this provider's transport reaches the role-scoped MCP surfaces. */
  mcpIngress?: ProviderMcpIngress;
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

function normalizedRoleKey(role: unknown): string | null {
  if (typeof role !== "string") return null;
  const trimmed = role.trim().toLowerCase();
  return trimmed.length > 0 ? trimmed : null;
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
 * Look up a declared role contract, or return `null` when `role` is missing or
 * undeclared. Never falls back to a writable default role.
 */
export function findRoleContract(
  role: unknown,
  workspace?: string | null
): RoleContract | null {
  const key = normalizedRoleKey(role);
  if (!key || !Object.hasOwn(CONTRACT.roles, key)) return null;
  const global = CONTRACT.roles[key]!;
  if (workspace === undefined || workspace === null) return global;
  const workspaceSkills = contractRoleSkills(CONTRACT, key, workspace);
  if (workspaceSkills.length === 0) return global;
  const skills = [
    ...new Set([...skillNames(global.skills), ...workspaceSkills])
  ].sort();
  return { ...global, skills };
}

/**
 * The canonical role contract, projected for one workspace.
 *
 * Fails closed when `role` is empty or undeclared rather than falling back to
 * the writable `default` role. A workspace adds skills to a role and never
 * widens MCP, shell, or write authority.
 */
export function roleContract(
  role: unknown,
  workspace?: string | null
): RoleContract {
  const contract = findRoleContract(role, workspace);
  if (!contract) {
    throw new Error(`Unknown AutoDev agent role: ${String(role ?? "")}`);
  }
  return contract;
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
      delegation: "none",
      permissionMode: "unknown"
    }
  );
}

/**
 * Whether the contract marks this role as read-only (`readOnly: true`).
 *
 * Fails closed: empty, missing, or undeclared role identifiers are treated as
 * read-only so unknown roles never inherit write authority.
 */
export function isReadOnlyRole(role: string | null | undefined): boolean {
  const contract = findRoleContract(role);
  if (!contract) return true;
  return contract.readOnly === true;
}

/** Whether `role` names an explicit role declared in `config/execution-contract.json`. */
export function hasRoleContract(role: unknown): role is string {
  const key = normalizedRoleKey(role);
  return key !== null && Object.hasOwn(CONTRACT.roles, key);
}

/** Sorted canonical role names declared in `config/execution-contract.json`. */
export function declaredRoleNames(): string[] {
  return Object.keys(CONTRACT.roles).sort();
}
