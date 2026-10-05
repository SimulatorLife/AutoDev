import type {
  ControlApiProviderHealth,
  ControlApiProviderRecord
} from "@simulatorlife/autodev-core";
import React from "react";

import { StatusBadge } from "../../components/status/StatusBadge.ts";

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
        label: `Missing ${credential.envKey}`
      });
}

export function tierPriorityLabel(
  priorities: ControlApiProviderRecord["priorities"]
): string {
  return priorities.length === 0
    ? "Not in any tier"
    : priorities.map(({ tier, group }) => `${tier}: P${group}`).join(" · ");
}
