import { createHash } from "node:crypto";
import { isRecord } from "@simulatorlife/autodev-core";

/**
 * The execution contract's reads.
 *
 * Separate from the Runtime because the execution contract is not RuleSync
 * source and never was: it is the document that decides which skills and MCP
 * servers each agent role may reach, it lives outside `.rulesync/`, and it is
 * read by the router rather than projected from a catalog. Putting this beside
 * the command reader would have implied the same ownership and the same
 * validation, and neither is true.
 *
 * The contract is generated from the canonical role declarations, so it is read
 * and never written here: a write would be an alternate way to change the role
 * assignments, and one that bypasses the declarations they are generated from.
 */

export class ExecutionContractValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExecutionContractValidationError";
  }
}

export function executionContractRevision(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

/**
 * The skills one role entry declares.
 *
 * `null` for an entry that is not an object: such an entry keeps whatever it
 * had rather than being rewritten, because this function assigns skills and
 * normalising a role it did not touch would silently change a document it was
 * only asked to append to.
 */
function entrySkillList(entry: unknown): string[] | null {
  if (!isRecord(entry)) return null;
  return Array.isArray(entry.skills)
    ? entry.skills.filter(
        (value): value is string =>
          typeof value === "string" && value.trim().length > 0
      )
    : [];
}

/**
 * The role entries one scope of the contract declares.
 *
 * The global scope is the contract's own `roles` section; a workspace scope is
 * that workspace's section inside `workspaces`. A workspace that declares no
 * section declares no roles, which is not the same as a workspace whose roles
 * are empty.
 */
function contractRoleEntries(
  contract: Record<string, unknown>,
  workspace: string | undefined
): Record<string, unknown> {
  const section =
    workspace === undefined
      ? contract
      : isRecord(contract.workspaces) &&
          isRecord(contract.workspaces[workspace])
        ? contract.workspaces[workspace]
        : undefined;
  if (!isRecord(section)) return {};
  return isRecord(section.roles) ? section.roles : {};
}

/**
 * The skills each role declares, for one workspace or globally.
 *
 * A workspace's section overrides the skill list and nothing else: the MCP
 * servers, the read-only flag, and every other field a role carries stay
 * global, so a workspace can add a skill to a role without restating the role.
 */
export function contractSkillRoles(
  contract: Record<string, unknown>,
  workspace?: string | undefined
): Readonly<Record<string, readonly string[]>> {
  const entries = contractRoleEntries(contract, workspace);
  const roles: Record<string, string[]> = {};
  for (const [role, entry] of Object.entries(entries)) {
    const list = entrySkillList(entry);
    if (list === null) continue;
    roles[role] = list;
  }
  return roles;
}
