import { createHash, randomUUID } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

/**
 * The execution contract's role-assignment write.
 *
 * Separate from the Runtime because the execution contract is not RuleSync
 * source and never was: it is the document that decides which skills and MCP
 * servers each agent role may reach, it lives outside `.rulesync/`, and it is
 * read by the router rather than projected from a catalog. Putting this beside
 * the command writer would have implied the same ownership and the same
 * validation, and neither is true.
 *
 * The write follows the command writer's discipline exactly, because the failure
 * it protects against is the same one: two operators assigning roles at once,
 * where a last-writer-wins merge quietly discards the first assignment and both
 * of them believe theirs took.
 */

export class ExecutionContractConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExecutionContractConflictError";
  }
}

export class ExecutionContractValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExecutionContractValidationError";
  }
}

export interface ExecutionContractRoleAssignment {
  readonly role: string;
  readonly skills: readonly string[];
}

export interface AssignSkillRolesInput {
  readonly file: string;
  /** The contract's own digest, so a stale read cannot overwrite a newer one. */
  readonly expectedRevision: string;
  readonly skill: string;
  /** The complete set of roles this skill should reach. Replaces what is there. */
  readonly roles: readonly string[];
  /**
   * The workspace the assignment belongs to.
   *
   * Omitted for a global assignment; set for one that belongs to a workspace.
   * A skill installed inside a repository belongs to that repository's
   * workspace alone, so its assignment is written into the workspace's section
   * of the contract and the global section is left alone.
   */
  readonly workspace?: string | undefined;
}

export interface ExecutionContractAssignmentResult {
  readonly skill: string;
  readonly roles: readonly string[];
  /** The workspace the assignment was written to, or null for a global one. */
  readonly workspace: string | null;
  readonly revision: string;
}

const SKILL_NAME_PATTERN = /^[a-z0-9][a-z0-9-]*$/u;
const ROLE_NAME_PATTERN = /^[a-z0-9][a-z0-9-]*$/u;
/**
 * The workspace id grammar the contract and the workspace catalogue share: a
 * canonical `owner/repository` key. Anything else is not a workspace id, and a
 * section named by one could never be looked up again.
 */
const WORKSPACE_ID_PATTERN = /^[^/\s]+\/[^/\s]+$/u;
const CONTRACT_MAX_BYTES = 1_000_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function executionContractRevision(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

/**
 * Read the contract and refuse anything that is not a bounded regular file.
 *
 * Size is bounded before parsing rather than after, so a pathological file
 * cannot be read into memory to be measured.
 */
async function readBoundedContract(
  file: string,
  expectedRevision: string
): Promise<string> {
  let content: string;
  try {
    const fileStat = await stat(file);
    if (!fileStat.isFile()) {
      throw new ExecutionContractConflictError(
        "The execution contract is not a regular file."
      );
    }
    content = await readFile(file, "utf8");
  } catch (error) {
    if (error instanceof ExecutionContractConflictError) throw error;
    throw new ExecutionContractValidationError(
      "The execution contract could not be read, so nothing was changed."
    );
  }
  if (Buffer.byteLength(content, "utf8") > CONTRACT_MAX_BYTES) {
    throw new ExecutionContractValidationError(
      "The execution contract exceeds its safe size bound and was not modified."
    );
  }
  // Checked against the bytes actually on disk, not against a parse of them, so
  // a reformatting edit that preserves meaning still counts as the change it is.
  if (executionContractRevision(content) !== expectedRevision) {
    throw new ExecutionContractConflictError(
      "The execution contract changed since it was loaded."
    );
  }
  return content;
}

function parseContract(content: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new ExecutionContractValidationError(
      "The execution contract is not valid JSON and was not modified."
    );
  }
  if (!isRecord(parsed)) {
    throw new ExecutionContractValidationError(
      "The execution contract is not an object and was not modified."
    );
  }
  return parsed;
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
 * The roles section, with each role's existing skill list.
 */
function roleSkillLists(
  parsed: Record<string, unknown>
): Record<string, string[]> {
  const existingRoles = isRecord(parsed.roles) ? parsed.roles : {};
  const lists: Record<string, string[]> = {};
  for (const [role, entry] of Object.entries(existingRoles)) {
    const list = entrySkillList(entry);
    if (list === null) continue;
    lists[role] = list;
  }
  return lists;
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

/**
 * The roles a skill is assigned to, in one workspace or globally.
 *
 * The exact inverse of the write: a skill in `workspaces[W].roles[R].skills` is
 * assigned to `R` in `W` and to nobody globally.
 */
export function assignedSkillRoles(input: {
  readonly file: string;
  readonly skill: string;
  readonly workspace?: string | undefined;
}): readonly string[] {
  const parsed = parseContract(readContractFile(input.file));
  const roles = contractSkillRoles(parsed, input.workspace);
  return Object.entries(roles)
    .filter(([, skills]) => skills.includes(input.skill))
    .map(([role]) => role)
    .sort();
}

/**
 * Read the contract without throwing.
 *
 * The read side refuses as loudly as the write side: a contract that cannot be
 * read has no assignments to report, and reporting "none" for a file that
 * exists but cannot be opened would be an answer the operator cannot act on.
 */
function readContractFile(file: string): string {
  let content: string;
  try {
    if (!statSync(file).isFile()) {
      throw new ExecutionContractValidationError(
        "The execution contract is not a regular file."
      );
    }
    content = readFileSync(file, "utf8");
  } catch (error) {
    if (error instanceof ExecutionContractValidationError) throw error;
    throw new ExecutionContractValidationError(
      "The execution contract could not be read."
    );
  }
  if (Buffer.byteLength(content, "utf8") > CONTRACT_MAX_BYTES) {
    throw new ExecutionContractValidationError(
      "The execution contract exceeds its safe size bound."
    );
  }
  return content;
}

/**
 * Write through a temporary file and rename over the target, then confirm the
 * bytes landed.
 *
 * The rename is what makes this a replace rather than a truncate, so a reader
 * never observes a half-written contract. The confirmation is separate because
 * the write reporting success is not evidence that it succeeded.
 */
async function persistContract(file: string, next: string): Promise<void> {
  const temporaryPath = path.join(
    path.dirname(file),
    `.${path.basename(file)}.${randomUUID()}.tmp`
  );
  try {
    await writeFile(temporaryPath, next, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o644
    });
    await rename(temporaryPath, file);
  } catch (error) {
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
  const persisted = await readFile(file, "utf8");
  if (persisted !== next) {
    throw new ExecutionContractConflictError(
      "The execution contract changed during the update."
    );
  }
}

/**
 * Assign a skill to exactly the roles named, removing it from every other role.
 *
 * Removal is the point: the input is the complete desired set rather than an
 * addition, so "unassign this skill" is the same call with an empty list and
 * there is no second verb to get wrong.
 *
 * A workspace writes into that workspace's section of the contract and leaves
 * the global section untouched. The two sections are separate assignments
 * rather than two views of one: a skill installed inside a repository is that
 * repository's alone, and a contract that listed it globally as well would
 * claim it for workspaces it does not belong to.
 */
export async function assignSkillRoles(
  input: AssignSkillRolesInput
): Promise<ExecutionContractAssignmentResult> {
  if (!SKILL_NAME_PATTERN.test(input.skill)) {
    throw new ExecutionContractValidationError(
      "Skill name must be a lowercase hyphenated slug."
    );
  }
  const roles = [...new Set(input.roles)].sort();
  for (const role of roles) {
    if (!ROLE_NAME_PATTERN.test(role)) {
      throw new ExecutionContractValidationError(
        "Role name must be a lowercase hyphenated slug."
      );
    }
  }
  if (
    input.workspace !== undefined &&
    !WORKSPACE_ID_PATTERN.test(input.workspace)
  ) {
    throw new ExecutionContractValidationError(
      "Workspace id must be a canonical owner/repository key."
    );
  }

  const content = await readBoundedContract(input.file, input.expectedRevision);
  const parsed = parseContract(content);
  const existingRoles = isRecord(parsed.roles) ? parsed.roles : {};
  const roleNames = Object.keys(existingRoles);

  // A role that is not in the contract cannot be assigned. Silently creating one
  // would invent a role no provider spawns under. A workspace names the same
  // roles the contract defines: the workspace decides which skills a role
  // reaches there, not which roles exist.
  for (const role of roles) {
    if (!roleNames.includes(role)) {
      throw new ExecutionContractValidationError(
        `Role "${role}" is not defined in the execution contract.`
      );
    }
  }

  const next =
    input.workspace === undefined
      ? assignGlobally(parsed, roles, input.skill)
      : assignInWorkspace(parsed, roles, input.skill, input.workspace);

  const nextContent = `${JSON.stringify(next, null, 2)}\n`;
  if (nextContent === content) {
    return {
      skill: input.skill,
      roles,
      workspace: input.workspace ?? null,
      revision: executionContractRevision(content)
    };
  }

  await persistContract(input.file, nextContent);
  return {
    skill: input.skill,
    roles,
    workspace: input.workspace ?? null,
    revision: executionContractRevision(nextContent)
  };
}

/**
 * Assign a skill in the contract's global roles section.
 */
function assignGlobally(
  parsed: Record<string, unknown>,
  roles: readonly string[],
  skill: string
): Record<string, unknown> {
  const existingRoles = isRecord(parsed.roles) ? parsed.roles : {};
  const current = roleSkillLists(parsed);
  const nextRoles: Record<string, unknown> = { ...existingRoles };
  for (const role of Object.keys(existingRoles)) {
    const entry = existingRoles[role];
    const existing = current[role];
    if (existing === undefined) continue;
    const updated = roles.includes(role)
      ? [...new Set([...existing, skill])].sort()
      : existing.filter((value) => value !== skill);
    if (existing.join("\n") === updated.join("\n")) continue;
    nextRoles[role] = { ...(isRecord(entry) ? entry : {}), skills: updated };
  }
  return { ...parsed, roles: nextRoles };
}

/**
 * Assign a skill in one workspace's section of the contract.
 *
 * The workspace's list for a role is complete in the same way the global one
 * is: the skill is added to the roles named and removed from the others. The
 * global section is not touched, so the two never claim the same skill.
 */
function assignInWorkspace(
  parsed: Record<string, unknown>,
  roles: readonly string[],
  skill: string,
  workspace: string
): Record<string, unknown> {
  const workspaces = isRecord(parsed.workspaces) ? parsed.workspaces : {};
  const section = isRecord(workspaces[workspace])
    ? workspaces[workspace]
    : ({} as Record<string, unknown>);
  const existingRoles = isRecord(section.roles) ? section.roles : {};
  const nextRoles: Record<string, unknown> = { ...existingRoles };
  for (const role of Object.keys(existingRoles)) {
    const entry = existingRoles[role];
    const existing = entrySkillList(entry);
    if (existing === null) continue;
    const updated = roles.includes(role)
      ? [...new Set([...existing, skill])].sort()
      : existing.filter((value) => value !== skill);
    if (existing.join("\n") === updated.join("\n")) continue;
    nextRoles[role] = { ...(isRecord(entry) ? entry : {}), skills: updated };
  }
  // A role the workspace has not named yet gets its own entry: the assignment
  // has to be recorded somewhere, and the global role it names is not the same
  // thing as a workspace-scoped assignment of that role.
  for (const role of roles) {
    if (existingRoles[role] !== undefined) continue;
    nextRoles[role] = { skills: [skill] };
  }
  return {
    ...parsed,
    workspaces: { ...workspaces, [workspace]: { ...section, roles: nextRoles } }
  };
}
