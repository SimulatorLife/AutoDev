/** Canonical Console URLs for the permission policy. */
export const PERMISSIONS_PATH = "/permissions";

/** Same-origin Console mutation URL for the canonical permission policy. */
export function permissionPolicyPath(): string {
  return "/api/permissions";
}

/**
 * Only the canonical permissions page may be a return target.
 *
 * The write answers with a redirect, and a redirect the browser chooses is a
 * redirect off this Console, so the destination is checked against the one
 * path the policy is shown on.
 */
export function isPermissionsReturnPath(value: string | null): value is string {
  return value === PERMISSIONS_PATH;
}
