import { createHash, randomUUID } from "node:crypto";
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
}

export interface ExecutionContractAssignmentResult {
  readonly skill: string;
  readonly roles: readonly string[];
  readonly revision: string;
}

const SKILL_NAME_PATTERN = /^[a-z0-9][a-z0-9-]*$/u;
const ROLE_NAME_PATTERN = /^[a-z0-9][a-z0-9-]*$/u;
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
 * The roles section, with each role's existing skill list.
 *
 * A role whose entry is not an object keeps whatever it had rather than being
 * rewritten: this function assigns skills, and normalising a role it did not
 * touch would silently change a document it was only asked to append to.
 */
function roleSkillLists(
  parsed: Record<string, unknown>
): Record<string, string[]> {
  const existingRoles = isRecord(parsed.roles) ? parsed.roles : {};
  const lists: Record<string, string[]> = {};
  for (const [role, entry] of Object.entries(existingRoles)) {
    if (!isRecord(entry)) continue;
    lists[role] = Array.isArray(entry.skills)
      ? entry.skills.filter(
          (value): value is string =>
            typeof value === "string" && value.trim().length > 0
        )
      : [];
  }
  return lists;
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

  const content = await readBoundedContract(input.file, input.expectedRevision);
  const parsed = parseContract(content);
  const existingRoles = isRecord(parsed.roles) ? parsed.roles : {};
  const roleNames = Object.keys(existingRoles);

  // A role that is not in the contract cannot be assigned. Silently creating one
  // would invent a role no provider spawns under.
  for (const role of roles) {
    if (!roleNames.includes(role)) {
      throw new ExecutionContractValidationError(
        `Role "${role}" is not defined in the execution contract.`
      );
    }
  }

  const current = roleSkillLists(parsed);
  const nextRoles: Record<string, unknown> = { ...existingRoles };
  for (const role of roleNames) {
    const entry = existingRoles[role];
    const existing = current[role];
    if (existing === undefined) continue;
    const updated = roles.includes(role)
      ? [...new Set([...existing, input.skill])].sort()
      : existing.filter((value) => value !== input.skill);
    if (existing.join("\n") === updated.join("\n")) continue;
    nextRoles[role] = { ...(isRecord(entry) ? entry : {}), skills: updated };
  }

  const next = `${JSON.stringify({ ...parsed, roles: nextRoles }, null, 2)}\n`;
  if (next === content) {
    return {
      skill: input.skill,
      roles,
      revision: executionContractRevision(content)
    };
  }

  await persistContract(input.file, next);
  return {
    skill: input.skill,
    roles,
    revision: executionContractRevision(next)
  };
}