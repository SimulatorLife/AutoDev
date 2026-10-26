import { existsSync, readFileSync } from "node:fs";
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
}

/**
 * The catalog at a path, or why it could not be read.
 */
type CatalogLoad =
  | { readonly ok: true; readonly catalog: WorkspaceCatalog }
  | {
      readonly ok: false;
      readonly status: "invalid" | "unavailable";
      readonly reason: string;
    };

function loadCatalogFile(catalogPath: string): CatalogLoad {
  const absolute = path.resolve(catalogPath);
  if (!existsSync(absolute)) {
    return {
      ok: false,
      status: "unavailable",
      reason: `Workspace catalog not found: ${absolute}`
    };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(absolute, "utf8")) as unknown;
  } catch (error) {
    return {
      ok: false,
      status: "invalid",
      reason: `Workspace catalog is not valid JSON: ${
        error instanceof Error ? error.message : String(error)
      }`
    };
  }
  try {
    return { ok: true, catalog: parseWorkspaceCatalog(raw) };
  } catch (error) {
    return {
      ok: false,
      status: "invalid",
      reason:
        error instanceof WorkspaceCatalogError
          ? error.message
          : `Workspace catalog is invalid: ${String(error)}`
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
    return { status: "valid", workspaces: load.catalog.list };
  }
  return { status: load.status, workspaces: [], reason: load.reason };
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
