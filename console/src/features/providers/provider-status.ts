import {
  type ControlApiProviderHealth,
  type ControlApiProviderRecord,
  providerHealthReadiness,
  providerSignInRequired,
  SIGN_IN_REQUIRED_FAILURE_CLASS
} from "@simulatorlife/autodev-core";
import React from "react";

import { Button } from "../../components/forms/Button.ts";
import { Icon } from "../../components/icons/Icon.ts";
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
 * Health is checked last and reports `Not observed` until Runtime has observed
 * a successful provider request. A configured route with no successful
 * observation is not `Ready`. A provider whose account must be signed in
 * again -- a web-chat site signed out in the browser it is driven through --
 * reads `Sign-in required`: it is an action for the operator, not an outage
 * that passes by itself.
 */
export function resolveProviderStatus(
  provider: ControlApiProviderRecord
): ProviderStatus {
  if (provider.disabled) {
    return {
      tone: "invalid",
      label: "Disabled",
      title:
        "This provider is disabled. Its priorities, models and limits are preserved and return when it is enabled again."
    };
  }
  if (provider.route === null) {
    return {
      tone: "invalid",
      label: "Missing CODEX_ROUTE",
      title:
        "No route is configured for this provider, so no request can reach it."
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
  if (providerSignInRequired(provider.health)) {
    const check = provider.health?.lastCheck;
    return {
      tone: "invalid",
      label: "Sign-in required",
      title:
        check &&
        !check.ok &&
        check.failureClass === SIGN_IN_REQUIRED_FAILURE_CLASS
          ? `Action needed: ${check.detail}`
          : "Action needed: the provider's account is signed out. Sign in to it in the browser it is driven through, then re-check."
    };
  }
  const readiness = providerHealthReadiness(provider.health);
  if (readiness === "not-observed") {
    return {
      tone: "not-observed",
      label: NOT_OBSERVED_LABEL,
      title: "No successful provider health observation is available yet."
    };
  }
  if (readiness === "unavailable") {
    if (provider.health?.cooldown) {
      const failureClass = provider.health.cooldown.failureClass;
      return {
        tone: "unavailable",
        label:
          failureClass === null
            ? "Cooling down"
            : `Cooling down (${failureClass})`,
        title:
          "This provider is in cooldown and will not serve requests until it passes."
      };
    }
    const failureClass = provider.health?.lastFailure?.failureClass;
    return {
      tone: "unavailable",
      label: failureClass ? `Unavailable (${failureClass})` : "Unavailable",
      title: "The latest provider health evidence is a failure."
    };
  }
  return {
    tone: "ready",
    label: "Ready",
    title:
      "Healthy, routed and credentialed: this provider can serve requests now."
  };
}

/**
 * The re-check control inside a provider's verdict.
 *
 * Every verdict carries one, not only a failing one. Routing re-probes a
 * provider when a request is about to use it, so a verdict nobody has
 * re-checked is only as current as the moment it was observed -- and it can be
 * stale in either direction. An operator who wants to know whether a provider
 * is serving now should not have to wait for it to fail first, and a provider
 * that has recovered reads `Ready` only after somebody looked at it again.
 *
 * It submits the enclosing form (`ProviderStatusBadge`), and the Console's
 * form owner marks that form `aria-busy` while the check runs -- which is what
 * swaps the refresh symbol for a spinning circle, with no client state of its
 * own. The redirected page then carries the new verdict.
 */
function ProviderCheckButton({
  provider
}: {
  readonly provider: string;
}): React.JSX.Element {
  return React.createElement(
    Button,
    {
      type: "submit",
      variant: "inline",
      size: "icon",
      className:
        "ml-1.5 -mr-1 shrink-0 group-aria-busy:pointer-events-none group-aria-busy:cursor-default",
      ariaLabel: `Re-check provider ${provider}`,
      title: "Re-check this provider now: its live probe and model listing.",
      dataAttributes: { "data-provider-check": provider }
    },
    React.createElement(Icon, {
      name: "refresh",
      size: 12,
      className: "group-aria-busy:hidden"
    }),
    React.createElement(Icon, {
      name: "spinner",
      size: 12,
      className: "hidden animate-spin group-aria-busy:block"
    })
  );
}

/**
 * The Status column: one verdict per provider, never a summary of parts.
 *
 * Every verdict carries the re-check control, because every verdict is
 * evidence that was observed at some moment and can go stale. The control
 * rides inside the badge so it reads as part of the verdict it acts on, and
 * the form wraps the badge -- a form cannot sit inside the badge's inline
 * box -- and it is the form's busy state that turns the control into a
 * spinner.
 *
 * `returnTo` is required rather than optional. The check is a redirect back to
 * the page it was started from, and the Console's check route refuses a
 * submission that does not carry one, so a badge without a return path could
 * only ever render a control that fails.
 */
export function ProviderStatusBadge({
  provider,
  returnTo
}: {
  readonly provider: ControlApiProviderRecord;
  readonly returnTo: string;
}): React.JSX.Element {
  const status = resolveProviderStatus(provider);
  const badge = React.createElement(StatusBadge, {
    status: status.tone,
    label: status.label,
    // The control is on every verdict, not only on the failing ones: an
    // operator who wants a provider's status re-checked should not have to
    // wait for it to look broken first.
    action: React.createElement(ProviderCheckButton, { provider: provider.id }),
    // The title carries the verdict as well as the explanation of it.
    //
    // A badge's title is the only way back to a label the column could not
    // hold: the Status column gives "Unavailable (probe_unavailable)" a box
    // narrower than the verdict, so the verdict's tail is cut and what is left
    // is "Unavailable (probe…". A title that only explains the verdict --
    // "The latest provider health evidence is a failure" -- leaves the part
    // that was cut unavailable, so the verdict is named in the title and the
    // explanation follows it.
    ...(status.title === undefined
      ? {}
      : { title: `${status.label} — ${status.title}` })
  });
  return React.createElement(
    "form",
    {
      action: `/api/providers/${encodeURIComponent(provider.id)}/check`,
      method: "POST",
      className: "group inline-flex max-w-full",
      "data-provider-check-form": provider.id
    },
    React.createElement("input", {
      type: "hidden",
      name: "provider",
      value: provider.id
    }),
    React.createElement("input", {
      type: "hidden",
      name: "returnTo",
      value: returnTo
    }),
    badge
  );
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
  const readiness = providerHealthReadiness(health);
  if (readiness === "not-observed") {
    return React.createElement(StatusBadge, {
      status: NOT_OBSERVED_STATUS
    });
  }
  if (readiness === "unavailable") {
    return React.createElement(StatusBadge, {
      status: "unavailable",
      label: health.cooldown?.failureClass
        ? `Cooling down (${health.cooldown.failureClass})`
        : health.lastFailure?.failureClass
          ? `Unavailable (${health.lastFailure.failureClass})`
          : "Unavailable"
    });
  }
  return React.createElement(StatusBadge, { status: "ready", label: "Ready" });
}
