import type {
  WorkspaceConfigurationHealth,
  WorkspaceRuntimeAvailability
} from "@simulatorlife/autodev-core";

import {
  NOT_OBSERVED_LABEL,
  type StatusBadgeVariant
} from "../../components/status/StatusBadge.ts";

/**
 * How one workspace's canonical configuration reads, and how one workspace's
 * runtime availability reads.
 *
 * Both are pairs of different claims, and both pairs are kept apart on
 * purpose. A configuration fault and a healthy configuration are different
 * facts; an unobserved workspace and an idle workspace are different facts
 * too -- the first is missing evidence, the second is a measurement of zero.
 * Collapsing either pair would let a fault or a gap render as a quiet,
 * confident answer.
 */

/** The badge tone for a workspace's configuration health. */
export function workspaceConfigurationBadgeVariant(
  health: WorkspaceConfigurationHealth
): StatusBadgeVariant {
  return health.status === "configured" ? "valid" : "invalid";
}

/**
 * The badge label for a workspace's configuration health.
 *
 * A role scope that names roles nothing answers to is named in the label:
 * the operator has to see *which* scope is broken, not only that something
 * is.
 */
export function workspaceConfigurationBadgeLabel(
  health: WorkspaceConfigurationHealth
): string {
  if (health.status === "configured") return "Configured";
  if (health.unknownRoles.length === 1) {
    return `Unknown role: ${health.unknownRoles[0]}`;
  }
  return `Unknown roles: ${health.unknownRoles.join(", ")}`;
}

/** The badge tone for a workspace's runtime availability. */
export function workspaceAvailabilityBadgeVariant(
  availability: WorkspaceRuntimeAvailability
): StatusBadgeVariant {
  if (availability.status === "not-observed") return "not-observed";
  return availability.liveAgents > 0 ? "ready" : "configured";
}

/**
 * The badge label for a workspace's runtime availability.
 *
 * The observed state names the count, because a workspace the runtime
 * answered for has a measured number of live agents -- including zero, which
 * is a fact about an idle workspace and not a missing measurement.
 */
export function workspaceAvailabilityBadgeLabel(
  availability: WorkspaceRuntimeAvailability
): string {
  if (availability.status === "not-observed") return NOT_OBSERVED_LABEL;
  if (availability.liveAgents === 0) return "Idle";
  return `${availability.liveAgents} live`;
}
