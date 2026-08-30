import { statSync } from "node:fs";

export const WORKSPACE_KEYS = Object.freeze(["cwd", "project_root", "working_directory"]);

export class WorkspaceResolutionError extends Error {}

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
// valid map keys first, then structured path fields in each value. The caller
// does not identify the active workspace, so the first valid candidate wins.
export function resolveWorkspaceFromTurnMetadata(turnMetadata) {
  const workspaces = turnMetadata && typeof turnMetadata === "object" ? turnMetadata.workspaces : null;
  if (!workspaces || typeof workspaces !== "object" || Array.isArray(workspaces)) return null;
  for (const key of Object.keys(workspaces)) {
    if (isDirectory(key)) return key;
  }
  for (const entry of Object.values(workspaces)) {
    const candidate = workspacePathFromEntry(entry);
    if (isDirectory(candidate)) return candidate;
  }
  return null;
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
  const workspacePath = resolveWorkspaceFromTurnMetadata(turnMetadata);
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
