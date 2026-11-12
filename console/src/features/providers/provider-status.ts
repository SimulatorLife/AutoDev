import {
  type ControlApiModelQuota,
  type ControlApiProviderHealth,
  type ControlApiProviderQuota,
  type ControlApiProviderRecord,
  type ControlApiQuotaStatus,
  type ControlApiQuotaWindow,
  type ControlApiSubproviderQuota,
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
import { MUTED_TEXT_CLASS } from "../../components/ui/text-classes.ts";

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
    if (
      !failureClass &&
      provider.health?.quota?.status === "ok" &&
      provider.health.quota.summaryStatus === "exhausted"
    ) {
      return {
        tone: "unavailable",
        label: "Quota exhausted",
        title:
          "This provider has reached its usage or quota limit until the current window resets."
      };
    }
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
 * Resolve the canonical quota snapshot attached to a provider record or its
 * live health payload.
 */
export function resolveProviderQuota(
  provider: ControlApiProviderRecord | null | undefined
): ControlApiProviderQuota | null {
  if (!provider) return null;
  return provider.quota ?? provider.health?.quota ?? null;
}

/**
 * Resolve quota details for one specific model on a provider, falling back to
 * its subprovider pool or provider-wide windows when applicable.
 */
export function resolveModelQuota(
  provider: ControlApiProviderRecord | null | undefined,
  modelId: string
): ControlApiModelQuota | null {
  const quota = resolveProviderQuota(provider);
  if (!quota || quota.status !== "ok") return null;
  const direct = quota.models?.find((entry) => entry.model === modelId);
  if (direct) return direct;
  const matchingPool = quota.pools?.find((pool) =>
    pool.models.includes(modelId)
  );
  if (matchingPool) {
    return {
      model: modelId,
      pool: matchingPool.pool,
      status: matchingPool.status,
      usedPercent: matchingPool.usedPercent,
      remainingPercent: matchingPool.remainingPercent,
      resetsAt: matchingPool.resetsAt,
      windows: matchingPool.windows,
      ...(matchingPool.cooldown ? { cooldown: matchingPool.cooldown } : {})
    };
  }
  if (quota.windows.length > 0) {
    const primary = quota.windows[0]!;
    return {
      model: modelId,
      pool: null,
      status: quota.summaryStatus,
      usedPercent: primary.usedPercent,
      remainingPercent: primary.remainingPercent,
      resetsAt: primary.resetsAt,
      windows: quota.windows
    };
  }
  return null;
}

/**
 * Format time remaining until a quota window or cooldown resets.
 */
export function formatQuotaResetRemaining(
  resetsAt: string | null | undefined,
  nowMs = Date.now()
): string | null {
  if (!resetsAt) return null;
  const targetMs = Date.parse(resetsAt);
  if (!Number.isFinite(targetMs)) return null;
  const diffMs = targetMs - nowMs;
  if (diffMs <= 0) return "resetting";
  const totalMinutes = Math.ceil(diffMs / 60_000);
  if (totalMinutes < 60) {
    return `in ${totalMinutes}m`;
  }
  const totalHours = Math.floor(totalMinutes / 60);
  const remMinutes = totalMinutes % 60;
  if (totalHours < 24) {
    return remMinutes > 0
      ? `in ${totalHours}h ${remMinutes}m`
      : `in ${totalHours}h`;
  }
  const days = Math.floor(totalHours / 24);
  const remHours = totalHours % 24;
  return remHours > 0 ? `in ${days}d ${remHours}h` : `in ${days}d`;
}

function shortWindowLabel(window: ControlApiQuotaWindow): string {
  switch (window.kind) {
    case "five_hour":
      return "5h";
    case "weekly":
      return "7d";
    case "monthly":
      return "Monthly";
    case "daily":
      return "24h";
    default:
      return window.label;
  }
}

function shortPoolLabel(pool: ControlApiSubproviderQuota): string {
  if (pool.pool === "first_party") return "Gemini";
  if (pool.pool === "third_party") return "Claude";
  return pool.label;
}

function quotaToneClass(status: ControlApiQuotaStatus): string {
  switch (status) {
    case "exhausted":
      return "text-danger";
    case "warning":
      return "text-warning";
    case "available":
    case "unlimited":
      return "text-fg-secondary";
    default:
      return MUTED_TEXT_CLASS;
  }
}

function quotaBarColorClass(status: ControlApiQuotaStatus): string {
  switch (status) {
    case "exhausted":
      return "bg-danger";
    case "warning":
      return "bg-warning";
    default:
      return "bg-accent";
  }
}

export function formatQuotaWindowCompact(
  window: ControlApiQuotaWindow,
  nowMs = Date.now()
): string {
  const label = shortWindowLabel(window);
  if (window.status === "unlimited") {
    return `${label}: Unlimited`;
  }
  const reset = formatQuotaResetRemaining(window.resetsAt, nowMs);
  if (window.usedPercent !== null) {
    const pct = Math.round(window.usedPercent);
    return `${label}: ${pct}% used${reset ? ` (${reset})` : ""}`;
  }
  return `${label}: ${window.status}${reset ? ` (${reset})` : ""}`;
}

export function formatSubproviderPoolCompact(
  pool: ControlApiSubproviderQuota,
  nowMs = Date.now()
): string {
  const label = shortPoolLabel(pool);
  const reset = formatQuotaResetRemaining(
    pool.resetsAt ?? pool.cooldown?.resetsAt ?? pool.cooldown?.until ?? null,
    nowMs
  );
  if (pool.usedPercent !== null) {
    const pct = Math.round(pool.usedPercent);
    return `${label}: ${pct}% used${reset ? ` (${reset})` : ""}`;
  }
  if (pool.status === "exhausted" || pool.cooldown) {
    return `${label}: Exhausted${reset ? ` (${reset})` : ""}`;
  }
  return `${label}: ${pool.status}${reset ? ` (${reset})` : ""}`;
}

/**
 * Compact per-provider quota/limits summary rendered inside the provider's row
 * on `/providers` when quota or subprovider pool cooldown evidence is present.
 *
 * Uses `data-provider-quota` and `data-quota-status` rather than `StatusBadge`
 * so the row's single `StatusBadge` verdict contract remains intact.
 */
export function ProviderQuotaInlineSummary({
  provider,
  nowMs = Date.now()
}: {
  readonly provider: ControlApiProviderRecord;
  readonly nowMs?: number;
}): React.JSX.Element | null {
  const quota = resolveProviderQuota(provider);
  const poolCooldowns = provider.health?.poolCooldowns;
  const hasPoolCooldowns =
    poolCooldowns !== undefined && Object.keys(poolCooldowns).length > 0;
  if (!quota && !hasPoolCooldowns) {
    return null;
  }
  if (quota && quota.status === "ok") {
    const pools = quota.pools ?? [];
    if (pools.length > 0) {
      return React.createElement(
        "div",
        {
          className: "mt-1.5 flex flex-col gap-1 text-micro tabular-nums",
          "data-provider-quota": provider.id,
          "data-quota-status": quota.summaryStatus
        },
        ...pools.map((pool) => {
          const text = formatSubproviderPoolCompact(pool, nowMs);
          const pct =
            pool.usedPercent === null
              ? null
              : Math.max(0, Math.min(100, Math.round(pool.usedPercent)));
          return React.createElement(
            "div",
            {
              key: pool.pool,
              className: "flex flex-col gap-0.5",
              "data-provider-quota-pool": `${provider.id}:${pool.pool}`,
              title: pool.resetsAt
                ? `${pool.label} — ${text} (resets at ${pool.resetsAt})`
                : `${pool.label} — ${text}`
            },
            React.createElement(
              "span",
              { className: `truncate ${quotaToneClass(pool.status)}` },
              text
            ),
            pct === null
              ? null
              : React.createElement(
                  "div",
                  {
                    className:
                      "h-1 w-full overflow-hidden rounded-full bg-surface-raised"
                  },
                  React.createElement("div", {
                    className: `h-full ${quotaBarColorClass(pool.status)}`,
                    style: { width: `${pct}%` }
                  })
                )
          );
        })
      );
    }
    const visibleWindows = quota.windows.filter(
      (w) => w.status !== "unlimited" || quota.windows.length === 1
    );
    if (visibleWindows.length > 0) {
      return React.createElement(
        "div",
        {
          className: "mt-1.5 flex flex-col gap-1 text-micro tabular-nums",
          "data-provider-quota": provider.id,
          "data-quota-status": quota.summaryStatus
        },
        ...visibleWindows.map((window) => {
          const text = formatQuotaWindowCompact(window, nowMs);
          const pct =
            window.usedPercent === null
              ? null
              : Math.max(0, Math.min(100, Math.round(window.usedPercent)));
          return React.createElement(
            "div",
            {
              key: window.id,
              className: "flex flex-col gap-0.5",
              "data-provider-quota-window": `${provider.id}:${window.id}`,
              title: window.resetsAt
                ? `${window.label} — ${text} (resets at ${window.resetsAt})`
                : `${window.label} — ${text}`
            },
            React.createElement(
              "span",
              { className: `truncate ${quotaToneClass(window.status)}` },
              text
            ),
            pct === null
              ? null
              : React.createElement(
                  "div",
                  {
                    className:
                      "h-1 w-full overflow-hidden rounded-full bg-surface-raised"
                  },
                  React.createElement("div", {
                    className: `h-full ${quotaBarColorClass(window.status)}`,
                    style: { width: `${pct}%` }
                  })
                )
          );
        })
      );
    }
  }
  if (hasPoolCooldowns && poolCooldowns) {
    return React.createElement(
      "div",
      {
        className: "mt-1.5 flex flex-col gap-0.5 text-micro tabular-nums",
        "data-provider-quota": provider.id,
        "data-quota-status": "warning"
      },
      ...Object.entries(poolCooldowns).map(([pool, cooldown]) => {
        const label =
          pool === "first_party"
            ? "Gemini"
            : pool === "third_party"
              ? "Claude"
              : pool;
        const reset = formatQuotaResetRemaining(
          cooldown.resetsAt ?? cooldown.until,
          nowMs
        );
        const text = `${label}: Cooling down${reset ? ` (${reset})` : ""}`;
        return React.createElement(
          "span",
          {
            key: pool,
            className: "truncate text-warning",
            title: text,
            "data-provider-quota-pool": `${provider.id}:${pool}`
          },
          text
        );
      })
    );
  }
  return null;
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
          : health.quota?.status === "ok" &&
              health.quota.summaryStatus === "exhausted"
            ? "Quota exhausted"
            : "Unavailable"
    });
  }
  return React.createElement(StatusBadge, { status: "ready", label: "Ready" });
}
