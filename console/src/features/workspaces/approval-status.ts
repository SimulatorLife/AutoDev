import type { StatusBadgeVariant } from "../../components/status/StatusBadge.ts";

/**
 * One playtesting approval lifecycle, read from the two facts that decide it:
 * whether the workspace carries an approval record at all, and whether that
 * record has been revoked.
 *
 * `unavailable` is kept distinct from `none` on purpose. The Control API
 * failing to answer is not the same claim as it answering "there is no
 * approval" -- the first is missing evidence, the second is observed absence,
 * and collapsing them would let a store outage render as a quiet, confident
 * "Not approved".
 */
export type WorkspaceApprovalStatus =
  "unavailable" | "none" | "active" | "revoked";

export function workspaceApprovalStatus(
  approval: { readonly revokedAt: string | null } | null
): WorkspaceApprovalStatus {
  if (approval === null) return "none";
  return approval.revokedAt === null ? "active" : "revoked";
}

const STATUS_BADGE_VARIANT: Readonly<
  Record<WorkspaceApprovalStatus, StatusBadgeVariant>
> = {
  unavailable: "unavailable",
  none: "not-observed",
  active: "valid",
  revoked: "invalid"
};

const STATUS_LABEL: Readonly<Record<WorkspaceApprovalStatus, string>> = {
  unavailable: "Unavailable",
  none: "Not approved",
  active: "Active",
  revoked: "Revoked"
};

export function workspaceApprovalBadgeVariant(
  status: WorkspaceApprovalStatus
): StatusBadgeVariant {
  return STATUS_BADGE_VARIANT[status];
}

export function workspaceApprovalBadgeLabel(
  status: WorkspaceApprovalStatus
): string {
  return STATUS_LABEL[status];
}
