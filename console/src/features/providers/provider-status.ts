import type {
  ControlApiProviderHealth,
  ControlApiProviderRecord
} from "@simulatorlife/autodev-core";
import React from "react";

import {
  NOT_OBSERVED_LABEL,
  NOT_OBSERVED_STATUS,
  StatusBadge,
  type StatusBadgeVariant
} from "../../components/status/StatusBadge.ts";

/**
 * One provider's overall usability, as a single verdict.
 *
 * The target state is explicit that Status "is a single verdict, not a summary
 * of parts": `Ready` only when the provider is healthy *and* fully configured,
 * and otherwise the specific blocking state rather than a generic warning. A
 * provider whose parts are individually fine but which cannot serve a request
 * must not read Ready.
 *
 * `resolveProviderStatus` is a pure function of the record so the ordering is
 * testable without rendering, and so the column cannot drift into showing a
 * summary by accident.
 */
export type ProviderStatus = {
  readonly tone: StatusBadgeVariant;
  readonly label: string;
  readonly title?: string;
};

/**
 * The blocking state that stops this provider serving a request, or null when it
 * can.
 *
 * The order matters and is the whole point: an operator who fixes
 * `Missing CODEX_ROUTE` must not then be told `Missing credential` while the
 * route is still absent, so configuration is checked before credentials, and
 * credentials before live health. The most fundamental blocker is reported, not
 * the most recently discovered one.
 *
 * Health is checked last and reports `Not observed` when the Runtime sent no
 * health evidence at all. That is deliberately not `Ready`: an unreadable
 * health signal is not a healthy one, and rendering it as Ready would
 * synthesize the single claim this column exists to make honestly.
 */
export function resolveProviderStatus(
  provider: ControlApiProviderRecord
): ProviderStatus {
  if (provider.disabled) {
    return {
      tone: "invalid",
      label: "Disabled",
      title: "This provider is disabled. Its priorities, models and limits are preserved and return when it is enabled again."
    };
  }
  if (provider.route === null) {
    return {
      tone: "invalid",
      label: "Missing CODEX_ROUTE",
      title: "No route is configured for this provider, so no request can reach it."
    };
  }
  if (provider.credential.envKey !== null && !provider.credential.configured) {
    return {
      tone: "invalid",
      label: `Missing ${provider.credential.envKey}`,
      // An environment key is longer than the Status column is wide, so the
      // badge ellipsizes; the full key stays on the hover title rather than
      // being cut to a name that no longer identifies the missing variable.
      title: `Missing ${provider.credential.envKey}`
    };
  }
  if (provider.health === null) {
    return {
      tone: "not-observed",
      label: NOT_OBSERVED_LABEL,
      title: "No router health evidence has been observed for this provider."
    };
  }
  if (provider.health.cooldown !== null) {
    const failureClass = provider.health.cooldown.failureClass;
    return {
      tone: "unavailable",
      label: failureClass === null ? "Cooling down" : `Cooling down (${failureClass})`,
      title: "This provider is in cooldown and will not serve requests until it passes."
    };
  }
  return {
    tone: "ready",
    label: "Ready",
    title: "Healthy, routed and credentialed: this provider can serve requests now."
  };
}

/** The Status column: one verdict per provider, never a summary of parts. */
export function ProviderStatusBadge({
  provider
}: {
  readonly provider: ControlApiProviderRecord;
}): React.JSX.Element {
  const status = resolveProviderStatus(provider);
  return React.createElement(StatusBadge, {
    status: status.tone,
    label: status.label,
    ...(status.title === undefined ? {} : { title: status.title })
  });
}

/**
 * Credential presence on its own.
 *
 * This is a detail-page fact, not a Providers column: the four-column table
 * folds credential into the Status verdict, but a provider's detail page lists
 * what is configured as separate labelled facts, where naming the exact
 * environment variable is the point. Values never reach the Console.
 */
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

/**
 * Live readiness on its own, for the same reason as `CredentialBadge`.
 * Never implies health without router evidence.
 */
export function ProviderHealthBadge({
  health
}: {
  readonly health: ControlApiProviderHealth | null;
}): React.JSX.Element {
  if (health === null) {
    return React.createElement(StatusBadge, {
      status: NOT_OBSERVED_STATUS
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