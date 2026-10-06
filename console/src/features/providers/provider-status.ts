import type {
  ControlApiProviderHealth,
  ControlApiProviderRecord,
  ConvergenceStatus
} from "@simulatorlife/autodev-core";
import React from "react";

import {
  StatusBadge,
  type StatusBadgeVariant
} from "../../components/status/StatusBadge.ts";

/**
 * Convergence verdict as the shared status vocabulary.
 *
 * `pending` and `converged` map onto the badge variants that already mean
 * "awaiting observation" and "observed correct", so one component speaks one
 * language for health and for desired-vs-actual state.
 */
export function convergenceBadgeVariant(
  convergence: ConvergenceStatus
): StatusBadgeVariant {
  if (convergence === "converged") return "converged";
  if (convergence === "pending") return "pending";
  if (convergence === "error") return "error";
  return "not-observed";
}

/**
 * Desired-vs-actual state for one mutable item.
 *
 * The verdict is a badge; the Runtime-derived explanation and the desired /
 * observed generations are the hover title, so an operator can see why a role
 * is still converging without opening a second page. Nothing here is inferred
 * from configuration: an unobserved item stays `Not observed`.
 */
export function ConvergenceBadge({
  convergence,
  explanation,
  desiredGeneration,
  observedGeneration,
  lastError
}: {
  readonly convergence: ConvergenceStatus;
  readonly explanation: string;
  readonly desiredGeneration: string | null;
  readonly observedGeneration: string | null;
  readonly lastError: string | null;
}): React.JSX.Element {
  const lines = [explanation];
  if (desiredGeneration !== null) lines.push(`Desired: ${desiredGeneration}`);
  if (observedGeneration !== null)
    lines.push(`Observed: ${observedGeneration}`);
  if (lastError !== null) lines.push(`Last error: ${lastError}`);
  return React.createElement(StatusBadge, {
    status: convergenceBadgeVariant(convergence),
    label: convergence === "not-observed" ? "Not observed" : convergence,
    ...(lines.length === 1 ? {} : { title: lines.join("\n") })
  });
}

/** Live readiness from router evidence; never implies health without it. */
export function ProviderHealthBadge({
  health
}: {
  readonly health: ControlApiProviderHealth | null;
}): React.JSX.Element {
  if (health === null) {
    return React.createElement(StatusBadge, {
      status: "not-observed",
      label: "Not observed"
    });
  }
  if (health.cooldown !== null) {
    return React.createElement(StatusBadge, {
      status: "unavailable",
      label: health.cooldown.failureClass
        ? `Cooling down (${health.cooldown.failureClass})`
        : "Cooling down"
    });
  }
  return React.createElement(StatusBadge, { status: "ready", label: "Ready" });
}

/** Credential presence only; values never reach the Console. */
export function CredentialBadge({
  credential
}: {
  readonly credential: ControlApiProviderRecord["credential"];
}): React.JSX.Element {
  if (credential.envKey === null) {
    return React.createElement(StatusBadge, {
      status: "valid",
      label: "Not required"
    });
  }
  return credential.configured
    ? React.createElement(StatusBadge, {
        status: "valid",
        label: "Configured"
      })
    : React.createElement(StatusBadge, {
        status: "invalid",
        label: `Missing ${credential.envKey}`,
        // An environment key is longer than most columns are wide, so the badge
        // ellipsizes. The full key stays reachable on hover instead of being
        // silently shortened to an identifier that no longer exists.
        title: `Missing ${credential.envKey}`
      });
}
