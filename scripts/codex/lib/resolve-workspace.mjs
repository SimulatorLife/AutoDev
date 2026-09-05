import { statSync } from "node:fs";

export const WORKSPACE_KEYS = Object.freeze(["cwd", "project_root", "working_directory"]);

export class WorkspaceResolutionError extends Error {}

/** More than one workspace in the turn metadata exists on this host. */
export class AmbiguousWorkspaceError extends WorkspaceResolutionError {
  constructor(candidates) {
    super(
      `turn metadata lists ${candidates.length} workspaces that exist on this host ` +
      `(${candidates.join(", ")}) and does not say which is active; refusing to let key order ` +
      "decide which repository this turn edits. Set CODEX_PROJECT_ROOT to pin one."
    );
    this.candidates = candidates;
  }
}

export function isDirectory(path) {
  try {
    return typeof path === "string" && Boolean(path) && statSync(path).isDirectory();
  } catch {
    return false;
  }
}

export function parseTurnMetadataJson(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

// Canonical Codex transport carries turn metadata as the
// `x-codex-turn-metadata` request header; callers that cannot set custom
// headers may instead embed the same JSON under
// `client_metadata["x-codex-turn-metadata"]` in the body.
export function turnMetadataFrom(headerValue, clientMetadata) {
  const fromHeader = parseTurnMetadataJson(Array.isArray(headerValue) ? headerValue[0] : headerValue);
  if (fromHeader) return fromHeader;
  const embedded = clientMetadata && typeof clientMetadata === "object" ? clientMetadata["x-codex-turn-metadata"] : undefined;
  if (embedded && typeof embedded === "object" && !Array.isArray(embedded)) return embedded;
  return parseTurnMetadataJson(embedded);
}

function workspacePathFromEntry(entry) {
  if (typeof entry === "string") return entry;
  if (entry && typeof entry === "object") {
    for (const key of [ ...WORKSPACE_KEYS, "path" ]) {
      if (typeof entry[key] === "string") return entry[key];
    }
  }
  return null;
}

// Codex's canonical transport keys the `workspaces` map by the absolute
// repo/workspace path; each value normally carries only git metadata. Try
// valid map keys first, then structured path fields in each value.
//
// The caller does not identify which workspace is active, so two or more
// resolvable workspaces is an ambiguity, not a choice. Picking the first --
// which is what this used to do -- makes JSON key order decide which
// repository a coding agent edits, and key order carries no meaning and is
// not controlled by the caller. A turn from one repo could land in another,
// silently, and the only trace would be a working tree that changed under
// someone else's session. This resolver already refuses to guess when no
// workspace is resolvable; guessing between several is the same failure with
// worse consequences, so it refuses there too and the operator pins one with
// CODEX_PROJECT_ROOT if a multi-root turn is ever legitimate.
export function resolveWorkspaceFromTurnMetadata(turnMetadata) {
  const workspaces = turnMetadata && typeof turnMetadata === "object" ? turnMetadata.workspaces : null;
  if (!workspaces || typeof workspaces !== "object" || Array.isArray(workspaces)) return null;
  const fromKeys = Object.keys(workspaces).filter(isDirectory);
  if (fromKeys.length > 1) throw new AmbiguousWorkspaceError(fromKeys);
  if (fromKeys.length === 1) return fromKeys[0];
  const fromValues = [ ...new Set(Object.values(workspaces).map(workspacePathFromEntry).filter(isDirectory)) ];
  if (fromValues.length > 1) throw new AmbiguousWorkspaceError(fromValues);
  return fromValues[0] ?? null;
}

/**
 * Resolve a workspace from structured request fields only; task prose is
 * never consulted. The explicit operator override is provider-specific and is
 * passed by the caller after resolving its environment variable.
 */
export function resolveCwd(payload, headers, projectRoot = null) {
  for (const key of WORKSPACE_KEYS) {
    if (isDirectory(payload?.[key])) return payload[key];
  }
  const meta = payload?.metadata;
  if (meta && typeof meta === "object") {
    for (const key of WORKSPACE_KEYS) {
      if (isDirectory(meta[key])) return meta[key];
    }
  }
  const turnMetadata = turnMetadataFrom(headers?.["x-codex-turn-metadata"], payload?.client_metadata);
  let workspacePath = null;
  try {
    workspacePath = resolveWorkspaceFromTurnMetadata(turnMetadata);
  } catch (error) {
    if (!(error instanceof AmbiguousWorkspaceError)) throw error;
    // An explicit operator override is the documented way to pin one repo per
    // bridge, so it settles an ambiguity rather than being shadowed by it.
    if (projectRoot && isDirectory(projectRoot)) return projectRoot;
    throw error;
  }
  if (workspacePath) return workspacePath;
  if (projectRoot) {
    if (isDirectory(projectRoot)) return projectRoot;
    throw new WorkspaceResolutionError(`CODEX_PROJECT_ROOT=${JSON.stringify(projectRoot)} is set but is not a directory`);
  }
  throw new WorkspaceResolutionError(
    "request omitted a valid structured cwd/project_root/working_directory (top-level, metadata, or " +
    "x-codex-turn-metadata workspaces) and CODEX_PROJECT_ROOT is not set; refusing to guess a workspace " +
    "instead of silently landing an unrelated parent in this repository"
  );
}
