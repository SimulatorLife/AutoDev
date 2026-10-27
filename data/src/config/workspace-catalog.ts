import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The canonical workspace catalog's schema, and the one place it is decided.
 *
 * `config/workspaces.json` is the target's owner for workspace identity,
 * enablement and scope, and every reader of that file -- the Console, the
 * Runtime, and the workflows that dispatch work to a workspace -- has to
 * agree on what the file means. Four readers once did not: the Data
 * repository, the CI's catalog script, the scheduler and the metrics
 * dashboard each decided validity on their own, and a catalog could be
 * refused by one and accepted by another.
 *
 * So the rules live here, once, and the readers call them.
 *
 * The rules are:
 *
 *   - the document declares `schema: "autodev-workspaces-v1"` and a
 *     `workspaces` array;
 *   - every entry carries all four of `id`, `baseBranch`, `enabled` and
 *     `agentRoles` -- a canonical file has one shape, not two;
 *   - `id` is an `owner/name` pair with no whitespace in either half;
 *   - `enabled` is a boolean;
 *   - `baseBranch` is a non-empty branch name;
 *   - `agentRoles` is either `null` (the workspace declares no role scope)
 *     or a list of distinct role names;
 *   - the ids are unique.
 *
 * Every string is normalised by trimming it, so two readers cannot disagree
 * about the *value* of a workspace even when they agree about its validity.
 *
 * The module is deliberately free of imports beyond Node's own: the CI runs
 * it straight out of a checkout of this repository, where no package is
 * installed.
 */

/** The schema the canonical catalog declares. */
export const WORKSPACE_CATALOG_SCHEMA = "autodev-workspaces-v1";

/** The identity form a workspace key takes: an owner and a name. */
export const WORKSPACE_ID_PATTERN = /^[^/\s]+\/[^/\s]+$/u;

/**
 * One workspace as the catalog declares it.
 */
export interface WorkspaceCatalogEntry {
  readonly id: string;
  readonly baseBranch: string;
  readonly enabled: boolean;
  /** Null means the workspace declares no role scope. */
  readonly agentRoles: readonly string[] | null;
}

/**
 * The validated catalog.
 */
export interface WorkspaceCatalog {
  readonly workspaces: ReadonlyMap<string, WorkspaceCatalogEntry>;
  readonly list: readonly WorkspaceCatalogEntry[];
}

/**
 * Why the catalog could not be used.
 */
export class WorkspaceCatalogError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkspaceCatalogError";
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * One entry's role scope.
 *
 * `null` is a scope of "no roles declared", and a list of names is a scope of
 * "these roles". A list that repeats a role is a scope that cannot be read:
 * the same role twice says nothing about which agents may run.
 */
function readAgentRoles(value: unknown, id: string): readonly string[] | null {
  if (value === null) return null;
  if (!Array.isArray(value)) {
    throw new WorkspaceCatalogError(
      `Workspace ${id} has agent roles that are not a list of role names.`
    );
  }
  const roles: string[] = [];
  for (const role of value) {
    if (typeof role !== "string") {
      throw new WorkspaceCatalogError(
        `Workspace ${id} has an agent role that is not a name.`
      );
    }
    const trimmed = role.trim();
    if (trimmed.length === 0) {
      throw new WorkspaceCatalogError(
        `Workspace ${id} has an empty agent role.`
      );
    }
    if (roles.includes(trimmed)) {
      throw new WorkspaceCatalogError(
        `Workspace ${id} repeats the agent role ${trimmed}.`
      );
    }
    roles.push(trimmed);
  }
  return roles;
}

/**
 * One entry, normalised.
 *
 * Every fault is named, because a catalog that is refused is a file an
 * operator has to fix, and "the catalog is invalid" does not say which entry
 * or which field.
 */
function readWorkspaceEntry(value: unknown): WorkspaceCatalogEntry {
  if (!isPlainRecord(value)) {
    throw new WorkspaceCatalogError(
      "Workspace catalog contains an entry that is not a workspace."
    );
  }
  const id = typeof value.id === "string" ? value.id.trim() : "";
  if (!WORKSPACE_ID_PATTERN.test(id)) {
    throw new WorkspaceCatalogError(
      "Workspace catalog contains an invalid identity or enabled flag."
    );
  }
  if (typeof value.enabled !== "boolean") {
    throw new WorkspaceCatalogError(
      "Workspace catalog contains an invalid identity or enabled flag."
    );
  }
  const baseBranch =
    typeof value.baseBranch === "string" ? value.baseBranch.trim() : "";
  if (baseBranch.length === 0) {
    throw new WorkspaceCatalogError(`Workspace ${id} has no base branch.`);
  }
  const agentRoles = readAgentRoles(value.agentRoles, id);
  return { id, baseBranch, enabled: value.enabled, agentRoles };
}

/**
 * The catalog a parsed document declares.
 *
 * The document is validated rather than coerced: a catalog that is not the
 * shape it claims to be is refused, because a reader that carried on would
 * be reporting a workspace the workflows cannot act on.
 */
export function parseWorkspaceCatalog(raw: unknown): WorkspaceCatalog {
  if (
    !isPlainRecord(raw) ||
    raw.schema !== WORKSPACE_CATALOG_SCHEMA ||
    !Array.isArray(raw.workspaces)
  ) {
    throw new WorkspaceCatalogError("Workspace catalog is invalid.");
  }
  const workspaces = new Map<string, WorkspaceCatalogEntry>();
  for (const entry of raw.workspaces) {
    const workspace = readWorkspaceEntry(entry);
    if (workspaces.has(workspace.id)) {
      throw new WorkspaceCatalogError(`Duplicate workspace: ${workspace.id}`);
    }
    workspaces.set(workspace.id, workspace);
  }
  return { workspaces, list: [...workspaces.values()] };
}

/**
 * The result of reading the catalog from disk.
 *
 * A catalog that is not there and a catalog that is there and is wrong are
 * different facts, and a reader that reported them the same way would say a
 * repository has no workspaces when it has a broken one.
 */
export interface WorkspaceCatalogRead {
  readonly status: "valid" | "invalid" | "unavailable";
  readonly workspaces: readonly WorkspaceCatalogEntry[];
  readonly reason?: string;
  /**
   * The revision of the file the catalog was read from: the sha256 of its
   * exact bytes, or null when the file could not be read at all.
   */
  readonly revision: string | null;
}

/**
 * The catalog at a path, or why it could not be read.
 */
type CatalogLoad =
  | {
      readonly ok: true;
      readonly catalog: WorkspaceCatalog;
      readonly revision: string;
    }
  | {
      readonly ok: false;
      readonly status: "invalid" | "unavailable";
      readonly reason: string;
      readonly revision: string | null;
    };

function loadCatalogFile(catalogPath: string): CatalogLoad {
  const absolute = path.resolve(catalogPath);
  if (!existsSync(absolute)) {
    return {
      ok: false,
      status: "unavailable",
      reason: `Workspace catalog not found: ${absolute}`,
      revision: null
    };
  }
  let bytes: Buffer;
  try {
    bytes = readFileSync(absolute);
  } catch (error) {
    return {
      ok: false,
      status: "unavailable",
      reason: `Workspace catalog could not be read: ${
        error instanceof Error ? error.message : String(error)
      }`,
      revision: null
    };
  }
  // The revision is a handle on the file's exact bytes, so it is taken from
  // the bytes themselves rather than from the text they decode to.
  const revision = workspaceCatalogRevision(bytes);
  let raw: unknown;
  try {
    raw = JSON.parse(bytes.toString("utf8")) as unknown;
  } catch (error) {
    return {
      ok: false,
      status: "invalid",
      reason: `Workspace catalog is not valid JSON: ${
        error instanceof Error ? error.message : String(error)
      }`,
      revision
    };
  }
  try {
    return { ok: true, catalog: parseWorkspaceCatalog(raw), revision };
  } catch (error) {
    return {
      ok: false,
      status: "invalid",
      reason:
        error instanceof WorkspaceCatalogError
          ? error.message
          : `Workspace catalog is invalid: ${String(error)}`,
      revision
    };
  }
}

/**
 * The catalog at a path, or why it could not be read.
 *
 * This is the reader for a surface that has to *report* the catalog rather
 * than act on it: it says which of the three facts is true -- the file is
 * there and valid, the file is there and wrong, or the file is not there --
 * instead of refusing to answer.
 */
export function readWorkspaceCatalogFile(
  catalogPath: string
): WorkspaceCatalogRead {
  const load = loadCatalogFile(catalogPath);
  if (load.ok) {
    return {
      status: "valid",
      workspaces: load.catalog.list,
      revision: load.revision
    };
  }
  return {
    status: load.status,
    workspaces: [],
    reason: load.reason,
    revision: load.revision
  };
}

/**
 * The catalog at a path, or the reason it could not be read.
 *
 * This is the reader for a surface that has to *act* on the catalog: a
 * dispatch that cannot name its target fails closed rather than dispatching
 * into a catalog nobody validated.
 */
export function loadWorkspaceCatalog(catalogPath: string): WorkspaceCatalog {
  const load = loadCatalogFile(catalogPath);
  if (load.ok) return load.catalog;
  throw new WorkspaceCatalogError(load.reason);
}

/**
 * The revision of a catalog file: the sha256 of its exact bytes.
 *
 * A revision is a handle, not a summary. Two readers that read the same bytes
 * get the same string, and a writer that was handed the revision from an
 * earlier read can tell that the file moved before its write landed. It is
 * the same handle the Console's other canonical-source writes compare
 * against, so one write surface speaks one vocabulary.
 */
export function workspaceCatalogRevision(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * The revision of the catalog file at a path, or null when it cannot be read.
 */
export function readWorkspaceCatalogRevision(
  catalogPath: string
): string | null {
  try {
    return workspaceCatalogRevision(readFileSync(path.resolve(catalogPath)));
  } catch {
    return null;
  }
}

/**
 * The fields one workspace update may change.
 *
 * `id` is not among them: a workspace's identity is what the catalog is
 * indexed by, and renaming one is a different operation from configuring it.
 * A field that is absent is not written; a field that is present replaces the
 * value the catalog holds.
 */
export interface WorkspaceCatalogUpdate {
  readonly enabled?: boolean | undefined;
  readonly baseBranch?: string | undefined;
  readonly agentRoles?: readonly string[] | null | undefined;
}

/**
 * One field of a workspace's canonical configuration.
 *
 * The names are the catalog's own, so the write reports what it changed in the
 * vocabulary the file uses rather than in a second vocabulary the caller has to
 * translate.
 */
export type WorkspaceCatalogField = "enabled" | "baseBranch" | "agentRoles";

/**
 * What a write to the catalog did.
 */
export interface WorkspaceCatalogWrite {
  /** The revision of the catalog after the write. */
  readonly revision: string;
  /** The workspace as the catalog now declares it. */
  readonly workspace: WorkspaceCatalogEntry;
  /** Whether the write moved the catalog. */
  readonly changed: boolean;
  /**
   * The fields whose value the write actually changed.
   *
   * A write that sets a field to the value the catalog already holds changed
   * nothing, so it is not reported as a change: the operator is told what moved,
   * not what they asked for. The fields are the catalog's own names, because
   * the write is the only place that knows which of them moved.
   */
  readonly changedFields: readonly WorkspaceCatalogField[];
}

/**
 * The write was decided on a catalog that has since moved.
 *
 * The write is refused rather than applied over the newer catalog, because a
 * write that overwrites a change it never saw is how two operators lose each
 * other's work.
 */
export class WorkspaceCatalogConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkspaceCatalogConflictError";
  }
}

/**
 * The write could not be expressed, or the catalog could not be written.
 */
export class WorkspaceCatalogValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkspaceCatalogValidationError";
  }
}

/**
 * The catalog does not declare the workspace the write names.
 */
export class WorkspaceCatalogUnknownWorkspaceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkspaceCatalogUnknownWorkspaceError";
  }
}

/** The shape of a revision a write may name. */
const REVISION_PATTERN = /^[a-f0-9]{64}$/u;

/** The change a write asks for, validated against the catalog's own rules. */
interface WorkspaceCatalogChange {
  readonly enabled?: boolean | undefined;
  readonly baseBranch?: string | undefined;
  readonly agentRoles?: readonly string[] | null | undefined;
}

/**
 * The enablement flag a write asks for.
 *
 * The rules are the ones `parseWorkspaceCatalog` enforces, checked here so a
 * write that could not be expressed is refused before it touches the file.
 */
function readEnabledFlag(value: unknown): boolean {
  if (typeof value !== "boolean") {
    throw new WorkspaceCatalogValidationError(
      "A workspace enablement flag must be true or false."
    );
  }
  return value;
}

/** The base branch a write asks for. */
function readBaseBranch(value: unknown): string {
  if (typeof value !== "string") {
    throw new WorkspaceCatalogValidationError(
      "A workspace base branch must be a branch name."
    );
  }
  const baseBranch = value.trim();
  if (baseBranch.length === 0) {
    throw new WorkspaceCatalogValidationError(
      "A workspace base branch must not be empty."
    );
  }
  return baseBranch;
}

/**
 * The role scope a write asks for.
 *
 * A scope that is not configured and a scope that names no role are different
 * facts, and a scope that names the same role twice is not a scope at all:
 * the catalog's own parser refuses all three, and so does this.
 */
function readRoleScope(value: unknown): readonly string[] | null {
  if (value === null) return null;
  if (!Array.isArray(value)) {
    throw new WorkspaceCatalogValidationError(
      "A workspace role scope must be a list of role names or null."
    );
  }
  const roles: string[] = [];
  for (const role of value) {
    if (typeof role !== "string") {
      throw new WorkspaceCatalogValidationError(
        "A workspace role scope must be a list of role names or null."
      );
    }
    const trimmed = role.trim();
    if (trimmed.length === 0) {
      throw new WorkspaceCatalogValidationError(
        "A workspace role scope must not name an empty role."
      );
    }
    if (roles.includes(trimmed)) {
      throw new WorkspaceCatalogValidationError(
        `A workspace role scope must not repeat the role ${trimmed}.`
      );
    }
    roles.push(trimmed);
  }
  return roles;
}

/**
 * The change a write asks for, validated against the catalog's own rules.
 *
 * The rules are the ones `parseWorkspaceCatalog` enforces, checked here so a
 * write that could not be expressed is refused before it touches the file.
 */
function readCatalogUpdate(
  update: WorkspaceCatalogUpdate
): WorkspaceCatalogChange {
  const change: {
    enabled?: boolean | undefined;
    baseBranch?: string | undefined;
    agentRoles?: readonly string[] | null | undefined;
  } = {};
  if (update.enabled !== undefined) {
    change.enabled = readEnabledFlag(update.enabled);
  }
  if (update.baseBranch !== undefined) {
    change.baseBranch = readBaseBranch(update.baseBranch);
  }
  if (update.agentRoles !== undefined) {
    change.agentRoles = readRoleScope(update.agentRoles);
  }
  if (
    change.enabled === undefined &&
    change.baseBranch === undefined &&
    change.agentRoles === undefined
  ) {
    throw new WorkspaceCatalogValidationError(
      "A workspace update must change at least one of enablement, base branch or role scope."
    );
  }
  return change;
}

/**
 * The temporary file a write lands in before it replaces the catalog.
 *
 * It is in the catalog's own directory, because a rename is only atomic
 * within a filesystem, and it is hidden, because a reader that lists the
 * directory must not see a half-written catalog.
 */
let writeCounter = 0;

function temporaryCatalogPath(catalogPath: string): string {
  writeCounter += 1;
  return path.join(
    path.dirname(catalogPath),
    `.${path.basename(catalogPath)}.${process.pid}.${writeCounter}.tmp`
  );
}

/** The catalog's bytes, or the reason they could not be read. */
function readCatalogBytes(catalogPath: string): Buffer {
  try {
    return readFileSync(catalogPath);
  } catch (error) {
    throw new WorkspaceCatalogValidationError(
      `Workspace catalog could not be read: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
}

/**
 * The catalog's document, checked against the catalog's own rules.
 *
 * A catalog that cannot be read as a catalog is not written: the write would
 * land in a file the catalog's own parser refuses, and the next reader would
 * find a broken catalog where a working one was.
 */
function readCatalogDocument(bytes: Buffer): Record<string, unknown> {
  let raw: unknown;
  try {
    raw = JSON.parse(bytes.toString("utf8")) as unknown;
  } catch (error) {
    throw new WorkspaceCatalogValidationError(
      `Workspace catalog is not valid JSON: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
  if (!isPlainRecord(raw) || !Array.isArray(raw.workspaces)) {
    throw new WorkspaceCatalogValidationError("Workspace catalog is invalid.");
  }
  try {
    parseWorkspaceCatalog(raw);
  } catch (error) {
    throw new WorkspaceCatalogValidationError(
      error instanceof WorkspaceCatalogError
        ? error.message
        : `Workspace catalog is invalid: ${String(error)}`
    );
  }
  return raw;
}

/** The catalog's entry for one workspace. */
function findCatalogEntry(
  document: Record<string, unknown>,
  workspaceId: string
): Record<string, unknown> {
  const id = workspaceId.trim();
  const entries = document.workspaces as readonly unknown[];
  const index = entries.findIndex(
    (entry) =>
      isPlainRecord(entry) &&
      typeof entry.id === "string" &&
      entry.id.trim() === id
  );
  if (index === -1) {
    throw new WorkspaceCatalogUnknownWorkspaceError(
      `Workspace ${workspaceId} is not in the canonical catalog.`
    );
  }
  return entries[index] as Record<string, unknown>;
}

/**
 * Replace the catalog with the document the write produced.
 *
 * The write lands in a temporary file in the catalog's own directory and is
 * moved into place with a rename, so a reader never sees a half-written
 * catalog. The catalog keeps the permissions it had: a rename replaces the
 * file, and a file that came back with different permissions would be a
 * change the operator never asked for.
 */
function replaceCatalogFile(catalogPath: string, text: string): void {
  const temporary = temporaryCatalogPath(catalogPath);
  try {
    writeFileSync(temporary, text, { encoding: "utf8" });
    chmodSync(temporary, statSync(catalogPath).mode & 0o777);
    renameSync(temporary, catalogPath);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw new WorkspaceCatalogValidationError(
      `Workspace catalog could not be written: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
}

/**
 * Write one workspace's configuration to the canonical catalog.
 *
 * The write is a compare-and-swap on the catalog's revision: the caller names
 * the revision it decided on, and a catalog that has moved since is refused
 * rather than overwritten. The file is rewritten in place -- same shape, same
 * key order, same indentation -- and replaced atomically, so a reader never
 * sees a half-written catalog and a diff shows the fields that changed.
 *
 * The catalog's own rules are the rules this write obeys: an update that
 * could not be expressed is refused before the file is touched, and the
 * document the write produces is validated again before it lands.
 */
export function updateWorkspaceCatalogEntry(
  catalogPath: string,
  workspaceId: string,
  expectedRevision: string,
  update: WorkspaceCatalogUpdate
): WorkspaceCatalogWrite {
  const absolute = path.resolve(catalogPath);
  const change = readCatalogUpdate(update);
  if (!REVISION_PATTERN.test(expectedRevision)) {
    throw new WorkspaceCatalogValidationError(
      "A workspace write must name the revision it was decided on."
    );
  }
  const bytes = readCatalogBytes(absolute);
  const revision = workspaceCatalogRevision(bytes);
  if (revision !== expectedRevision) {
    throw new WorkspaceCatalogConflictError(
      "The workspace catalog changed after it was read, so the write was not applied."
    );
  }
  const document = readCatalogDocument(bytes);
  const entry = findCatalogEntry(document, workspaceId);
  // The fields the catalog already declares are written in place, so the
  // document keeps the key order it was written in and the diff shows the
  // value that changed rather than a rewritten file.
  //
  // A field is reported as changed only when its value actually moved: a write
  // that sets a field to the value the catalog already holds changed nothing,
  // and saying it changed would put a change in the diff that did not happen.
  const changedFields: WorkspaceCatalogField[] = [];
  if (change.enabled !== undefined) {
    if (entry.enabled !== change.enabled) changedFields.push("enabled");
    entry.enabled = change.enabled;
  }
  if (change.baseBranch !== undefined) {
    if (entry.baseBranch !== change.baseBranch)
      changedFields.push("baseBranch");
    entry.baseBranch = change.baseBranch;
  }
  if (change.agentRoles !== undefined) {
    const next = change.agentRoles === null ? null : [...change.agentRoles];
    if (!sameRoleScope(entry.agentRoles, next)) {
      changedFields.push("agentRoles");
    }
    entry.agentRoles = next;
  }
  let updated: WorkspaceCatalog;
  try {
    updated = parseWorkspaceCatalog(document);
  } catch (error) {
    throw new WorkspaceCatalogValidationError(
      error instanceof WorkspaceCatalogError
        ? error.message
        : `Workspace catalog is invalid: ${String(error)}`
    );
  }
  const workspace = updated.workspaces.get(workspaceId.trim());
  if (workspace === undefined) {
    throw new WorkspaceCatalogUnknownWorkspaceError(
      `Workspace ${workspaceId} is not in the canonical catalog.`
    );
  }
  replaceCatalogFile(absolute, `${JSON.stringify(document, null, 2)}\n`);
  const written = workspaceCatalogRevision(readFileSync(absolute));
  return {
    revision: written,
    workspace,
    changed: written !== expectedRevision,
    changedFields
  };
}

/**
 * Whether two role scopes name the same roles in the same order.
 *
 * A scope is a list, and the list is the scope: a scope that names the same
 * roles in a different order is a different list, and the write reports it as
 * the change it is. The current scope is read from the document as it stands,
 * so it is whatever the catalog holds -- a list of names, or null.
 */
function sameRoleScope(
  current: unknown,
  next: readonly string[] | null
): boolean {
  if (next === null) return current === null;
  if (!Array.isArray(current)) return false;
  return (
    current.length === next.length &&
    current.every((role, index) => role === next[index])
  );
}

/**
 * Whether a workspace's role scope admits an agent.
 *
 * A scope of `null` means the workspace declares no role scope, so every
 * agent may work there; a scope that names roles admits only those. The
 * catalog's own type says so ("null means workspace role scope has not been
 * configured"), and the scheduler and the runtime's configuration health
 * already read it that way.
 */
export function workspaceAdmitsRole(
  workspace: WorkspaceCatalogEntry,
  agentRole: string
): boolean {
  if (workspace.agentRoles === null) return true;
  return workspace.agentRoles.includes(agentRole);
}

/**
 * The workspace a target repository names, when it may be worked on.
 *
 * Every reason is a refusal: an unknown repository, a disabled one, a base
 * branch that does not match the registry and a role the workspace does not
 * allow are all "not this workspace".
 */
export function resolveTarget(
  catalog: WorkspaceCatalog,
  repoId: string,
  options: {
    readonly baseBranch?: string | undefined;
    readonly agentRole?: string | undefined;
  } = {}
):
  | { readonly ok: true; readonly workspace: WorkspaceCatalogEntry }
  | {
      readonly ok: false;
      readonly reason: string;
    } {
  if (typeof repoId !== "string" || !WORKSPACE_ID_PATTERN.test(repoId)) {
    return {
      ok: false,
      reason: "target_repository must use the owner/name form."
    };
  }
  const workspace = catalog.workspaces.get(repoId);
  if (!workspace) {
    return { ok: false, reason: `Unconfigured target repository: ${repoId}` };
  }
  if (!workspace.enabled) {
    return {
      ok: false,
      reason: `target_repository is disabled in the canonical workspace catalog: ${repoId}`
    };
  }
  const { baseBranch, agentRole } = options;
  if (
    typeof baseBranch === "string" &&
    baseBranch.length > 0 &&
    workspace.baseBranch !== baseBranch
  ) {
    return {
      ok: false,
      reason: `base_branch must match the Workspace registry for ${repoId}.`
    };
  }
  if (
    typeof agentRole === "string" &&
    agentRole.length > 0 &&
    !workspaceAdmitsRole(workspace, agentRole)
  ) {
    return {
      ok: false,
      reason: `agent '${agentRole}' is not allowed for workspace ${repoId}.`
    };
  }
  return { ok: true, workspace };
}

/**
 * The workspace a prompt repository names, when it may be read from.
 */
export function resolvePrompt(
  catalog: WorkspaceCatalog,
  repoId: string
):
  | { readonly ok: true; readonly workspace: WorkspaceCatalogEntry }
  | {
      readonly ok: false;
      readonly reason: string;
    } {
  if (typeof repoId !== "string" || !WORKSPACE_ID_PATTERN.test(repoId)) {
    return {
      ok: false,
      reason: "prompt_repository must use the owner/name form."
    };
  }
  const workspace = catalog.workspaces.get(repoId);
  if (!workspace) {
    return {
      ok: false,
      reason: `prompt_repository is not present in the canonical workspace catalog: ${repoId}`
    };
  }
  if (!workspace.enabled) {
    return {
      ok: false,
      reason: `prompt_repository is not enabled in the canonical workspace catalog: ${repoId}`
    };
  }
  return { ok: true, workspace };
}

/**
 * The ids of the workspaces a scheduled run may dispatch to.
 */
export function listEnabled(catalog: WorkspaceCatalog): readonly string[] {
  return catalog.list
    .filter((workspace) => workspace.enabled)
    .map((workspace) => workspace.id);
}

function parseCliOptions(tokens: readonly string[]): {
  readonly baseBranch?: string | undefined;
  readonly agentRole?: string | undefined;
} {
  const options: { baseBranch?: string; agentRole?: string } = {};
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === "--base-branch") {
      options.baseBranch = tokens[index + 1] ?? "";
      index += 1;
    } else if (token === "--agent-role") {
      options.agentRole = tokens[index + 1] ?? "";
      index += 1;
    } else {
      throw new WorkspaceCatalogError(`Unknown option: ${token}`);
    }
  }
  return options;
}

function runCli(argv: readonly string[]): void {
  const [command, ...rest] = argv;
  switch (command) {
    case "load": {
      const [catalogPath] = rest;
      if (!catalogPath) {
        throw new WorkspaceCatalogError("load requires <catalogPath>");
      }
      loadWorkspaceCatalog(catalogPath);
      return;
    }
    case "resolve-target": {
      const [catalogPath, repoId, ...optionTokens] = rest;
      if (!catalogPath || !repoId) {
        throw new WorkspaceCatalogError(
          "resolve-target requires <catalogPath> <repoId>"
        );
      }
      const catalog = loadWorkspaceCatalog(catalogPath);
      const result = resolveTarget(
        catalog,
        repoId,
        parseCliOptions(optionTokens)
      );
      if (!result.ok) {
        throw new WorkspaceCatalogError(result.reason);
      }
      process.stdout.write(`${JSON.stringify(result.workspace)}\n`);
      return;
    }
    case "resolve-prompt": {
      const [catalogPath, repoId] = rest;
      if (!catalogPath || !repoId) {
        throw new WorkspaceCatalogError(
          "resolve-prompt requires <catalogPath> <repoId>"
        );
      }
      const catalog = loadWorkspaceCatalog(catalogPath);
      const result = resolvePrompt(catalog, repoId);
      if (!result.ok) {
        throw new WorkspaceCatalogError(result.reason);
      }
      process.stdout.write(`${JSON.stringify(result.workspace)}\n`);
      return;
    }
    case "list-enabled": {
      const [catalogPath] = rest;
      if (!catalogPath) {
        throw new WorkspaceCatalogError("list-enabled requires <catalogPath>");
      }
      const catalog = loadWorkspaceCatalog(catalogPath);
      process.stdout.write(`${JSON.stringify(listEnabled(catalog))}\n`);
      return;
    }
    default: {
      throw new WorkspaceCatalogError(`Unknown command: ${command ?? ""}`);
    }
  }
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  try {
    runCli(process.argv.slice(2));
  } catch (error) {
    const message =
      error instanceof WorkspaceCatalogError
        ? error.message
        : `Workspace catalog CLI failed: ${error instanceof Error ? error.message : String(error)}`;
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  }
}
