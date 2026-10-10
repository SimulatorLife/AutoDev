/** Canonical Console URLs for Workspaces identities (`owner/repository`). */
export const WORKSPACES_PATH = "/workspaces";

const WORKSPACE_ID_PATTERN = /^[^/\s]+\/[^/\s]+$/u;

export function isWorkspaceId(value: string): value is string {
  return WORKSPACE_ID_PATTERN.test(value);
}

function segmentsForWorkspaceId(
  workspaceId: string
): readonly [string, string] {
  if (!isWorkspaceId(workspaceId)) {
    throw new TypeError(
      "Workspace id must be a canonical owner/repository key."
    );
  }
  const [owner, repository] = workspaceId.split("/");
  if (owner === undefined || repository === undefined) {
    throw new TypeError(
      "Workspace id must be a canonical owner/repository key."
    );
  }
  return [owner, repository];
}

export function workspacesPath(): string {
  return WORKSPACES_PATH;
}

/** Use two URL path segments; encoded slashes are not a reliable Next route key. */
export function workspacePath(workspaceId: string): string {
  const [owner, repository] = segmentsForWorkspaceId(workspaceId);
  return `${WORKSPACES_PATH}/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}`;
}

/** Same-origin Console mutation URL for the corresponding Runtime approval route. */
export function workspacePlaytestApprovalPath(
  workspaceId: string,
  revoke = false
): string {
  const [owner, repository] = segmentsForWorkspaceId(workspaceId);
  const base = `/api/workspaces/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/playtesting-approval`;
  return revoke ? `${base}/revoke` : base;
}

/** Only the canonical workspace detail page (or list) may be a return target. */
export function isWorkspacesReturnPath(value: string | null): value is string {
  if (value === null) return false;
  if (value === WORKSPACES_PATH) return true;
  const prefix = `${WORKSPACES_PATH}/`;
  if (!value.startsWith(prefix)) return false;
  const segments = value.slice(prefix.length).split("/");
  if (segments.length !== 2) return false;
  try {
    const workspaceId = `${decodeURIComponent(segments[0]!)}/${decodeURIComponent(segments[1]!)}`;
    return isWorkspaceId(workspaceId) && workspacePath(workspaceId) === value;
  } catch {
    return false;
  }
}
