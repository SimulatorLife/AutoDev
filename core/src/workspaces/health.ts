import type {
  WorkspaceConfigurationHealth,
  WorkspaceEntry
} from "./types.ts";

/**
 * Judge one workspace's canonical configuration entry.
 *
 * The catalog reader already rejects a malformed entry, so the only fault
 * left for this rule to find is a role scope that names roles AutoDev does
 * not define. That entry is not a catalog error -- it parses, it is unique,
 * it is non-empty -- but it is a configuration fault: the scope excludes
 * every agent that could work in the workspace, and nothing else in the
 * product says so.
 *
 * `knownRoles` is the canonical role list, and the caller owns it: core does
 * not read the execution contract, because the contract is a data-owned
 * source and this rule is a pure judgement about one entry.
 */
export function workspaceConfigurationHealth(
  workspace: WorkspaceEntry,
  knownRoles: readonly string[]
): WorkspaceConfigurationHealth {
  if (workspace.agentRoles === null) return { status: "configured" };
  const known = new Set(knownRoles);
  const unknownRoles = workspace.agentRoles.filter((role) => !known.has(role));
  if (unknownRoles.length === 0) return { status: "configured" };
  return { status: "invalid-role-scope", unknownRoles: [...unknownRoles] };
}
