"use client";

import React from "react";

import { Button } from "../../components/forms/Button.ts";
import { Icon } from "../../components/icons/Icon.ts";
import { CALLOUT_WARNING_CLASS } from "../../components/layout/Callout.ts";
import { FILTER_PANEL_CLASS } from "../../components/layout/Panel.ts";
import {
  LIVE_COUNT_REFRESH_EVENT,
  shouldRefreshLiveCounts
} from "../../components/navigation/live-count-refresh.ts";
import {
  NOT_OBSERVED_STATUS,
  StatusBadge,
  type StatusBadgeVariant
} from "../../components/status/StatusBadge.ts";
import { InstantDisplay } from "../../components/ui/InstantDisplay.ts";
import { MUTED_META_CLASS } from "../../components/ui/text-classes.ts";
import {
  ACTIVE_SESSIONS_REFRESH_SCOPE,
  parseUsageRefreshPayload,
  type UsageRefreshScope,
  usageRefreshUrl
} from "./usage-api.ts";
import {
  ACTIVE_SESSIONS_REFRESH_INTERVAL_MS,
  HISTORICAL_USAGE_REFRESH_INTERVAL_MS,
  startUsageRefreshLoop
} from "./usage-refresh.ts";

export interface UsageFreshnessProperties {
  readonly scope: UsageRefreshScope;
  readonly queryString: string;
  readonly initialObservedAt: string;
  readonly initialLastSuccessAt: string | null;
  readonly hasSnapshot: boolean;
  readonly intervalMs?: number | undefined;
}

interface RefreshFailure {
  readonly code: string;
  readonly message: string;
}

function cadenceText(
  scope: UsageRefreshScope,
  isPaused: boolean,
  intervalMs: number,
  scheduledDelayMs: number
): string {
  if (isPaused) return "Auto-refresh paused";
  if (scheduledDelayMs > intervalMs) {
    return `Auto-refresh backed off (${Math.round(scheduledDelayMs / 1000)}s)`;
  }
  return scope === ACTIVE_SESSIONS_REFRESH_SCOPE
    ? "Auto-refreshes every 5s while visible"
    : "Auto-refreshes every 60s while visible";
}

function freshnessBadge(
  hasSnapshot: boolean,
  isStale: boolean,
  isPaused: boolean
): {
  readonly status: StatusBadgeVariant;
  readonly label: string;
} {
  if (!hasSnapshot) return { status: "unavailable", label: "Unavailable" };
  if (isStale) return { status: "unavailable", label: "Stale" };
  if (isPaused) return { status: NOT_OBSERVED_STATUS, label: "Paused" };
  return { status: "ready", label: "Current" };
}

function renderTimestampsMeta(
  observedAt: string,
  lastSuccessAt: string | null,
  cadence: string
): React.JSX.Element {
  return React.createElement(
    "span",
    { className: `flex flex-wrap items-center gap-3 ${MUTED_META_CLASS}` },
    React.createElement(
      "span",
      null,
      "Observed ",
      React.createElement(InstantDisplay, {
        value: observedAt,
        label: "Observation time"
      })
    ),
    React.createElement(
      "span",
      null,
      "Last success ",
      React.createElement(InstantDisplay, {
        value: lastSuccessAt,
        label: "Last successful refresh"
      })
    ),
    React.createElement("span", null, cadence)
  );
}

function renderActionButtons(
  isRefreshing: boolean,
  isPaused: boolean,
  onRefresh: () => void,
  onTogglePaused: () => void
): React.JSX.Element {
  const refreshIcon = React.createElement(Icon, {
    name: isRefreshing ? "spinner" : "refresh",
    size: 14,
    className: isRefreshing ? "animate-spin" : undefined
  });
  const refreshText = React.createElement(
    "span",
    null,
    isRefreshing ? "Refreshing" : "Refresh"
  );
  const refreshContent = React.createElement(
    "span",
    { className: "inline-flex items-center gap-1.5" },
    refreshIcon,
    refreshText
  );

  return React.createElement(
    "div",
    { className: "flex flex-wrap items-center gap-2" },
    React.createElement(
      Button,
      {
        type: "button",
        variant: "secondary",
        size: "compact",
        busy: isRefreshing,
        testId: "usage-refresh-now",
        onClick: onRefresh
      },
      refreshContent
    ),
    React.createElement(
      Button,
      {
        type: "button",
        variant: "quiet",
        size: "compact",
        ariaPressed: isPaused,
        testId: "usage-refresh-toggle",
        onClick: onTogglePaused
      },
      isPaused ? "Resume auto-refresh" : "Pause auto-refresh"
    )
  );
}

function renderRefreshFailureBanner(
  hasSnapshot: boolean,
  failure: RefreshFailure | null
): React.JSX.Element | null {
  if (failure === null) return null;
  const text = hasSnapshot
    ? `Showing the last confirmed snapshot (stale): refresh failed (${failure.code}) — ${failure.message}`
    : `Latest refresh attempt failed (${failure.code}) — ${failure.message}`;
  return React.createElement(
    "p",
    {
      className: CALLOUT_WARNING_CLASS,
      role: "status",
      "data-usage-freshness-error": failure.code
    },
    text
  );
}

function requestPageRefresh(): void {
  if (globalThis.window === undefined) return;
  globalThis.window.dispatchEvent(new Event(LIVE_COUNT_REFRESH_EVENT));
}

/**
Freshness bar and visibility-aware auto-refresh controller for `/usage`.

Displays the observation and last-success timestamps, provides manual refresh
and pause/resume controls, backs off on failures, and labels a retained
last-known snapshot as stale when a subsequent refresh fails instead of
clearing or zeroing rendered metrics.
*/
export function UsageFreshnessControls({
  scope,
  queryString,
  initialObservedAt,
  initialLastSuccessAt,
  hasSnapshot,
  intervalMs
}: UsageFreshnessProperties): React.JSX.Element {
  const baseIntervalMs =
    intervalMs ??
    (scope === ACTIVE_SESSIONS_REFRESH_SCOPE
      ? ACTIVE_SESSIONS_REFRESH_INTERVAL_MS
      : HISTORICAL_USAGE_REFRESH_INTERVAL_MS);
  const scopeKey = `${scope}:${queryString}`;

  const [observedAt, setObservedAt] = React.useState(initialObservedAt);
  const [lastSuccessAt, setLastSuccessAt] = React.useState<string | null>(
    initialLastSuccessAt
  );
  const [isStale, setIsStale] = React.useState(false);
  const [isPaused, setIsPaused] = React.useState(false);
  const [isRefreshing, setIsRefreshing] = React.useState(false);
  const [failure, setFailure] = React.useState<RefreshFailure | null>(null);
  const [scheduledDelayMs, setScheduledDelayMs] =
    React.useState(baseIntervalMs);

  const pausedReference = React.useRef(isPaused);
  pausedReference.current = isPaused;
  const previousScopeKey = React.useRef(scopeKey);
  const loopReference = React.useRef<{
    readonly stop: () => void;
    readonly triggerNow: () => void;
  } | null>(null);

  React.useEffect(() => {
    const hasScopeChanged = previousScopeKey.current !== scopeKey;
    previousScopeKey.current = scopeKey;
    setObservedAt(initialObservedAt);
    if (hasScopeChanged || initialLastSuccessAt !== null) {
      setLastSuccessAt(initialLastSuccessAt);
    }
    if (!hasScopeChanged && hasSnapshot) return;
    setIsStale(false);
    setFailure(null);
    setScheduledDelayMs(baseIntervalMs);
  }, [
    baseIntervalMs,
    hasSnapshot,
    initialLastSuccessAt,
    initialObservedAt,
    scopeKey
  ]);

  const performRefresh = React.useCallback(async (): Promise<boolean> => {
    setIsRefreshing(true);
    try {
      const response = await fetch(usageRefreshUrl(scope, queryString), {
        headers: { accept: "application/json" },
        cache: "no-store"
      });
      let json: unknown = null;
      try {
        json = await response.json();
      } catch {
        json = null;
      }
      const parsed = response.ok ? parseUsageRefreshPayload(json) : null;
      if (parsed === null) {
        setObservedAt(new Date().toISOString());
        setFailure({
          code: response.ok
            ? "autodev_usage_refresh_invalid_response"
            : `autodev_usage_refresh_http_${response.status}`,
          message: response.ok
            ? "Usage refresh returned an unreadable response."
            : `Usage refresh returned HTTP ${response.status}.`
        });
        if (hasSnapshot) setIsStale(true);
        return false;
      }

      setObservedAt(parsed.observedAt);
      if (parsed.status === "ok") {
        setLastSuccessAt(parsed.observedAt);
        setIsStale(false);
        setFailure(null);
        setScheduledDelayMs(baseIntervalMs);
        if (shouldRefreshLiveCounts()) requestPageRefresh();
        return true;
      }

      setFailure({
        code: parsed.failureCode,
        message: parsed.failureMessage
      });
      if (hasSnapshot) setIsStale(true);
      return false;
    } catch {
      setObservedAt(new Date().toISOString());
      setFailure({
        code: "autodev_usage_refresh_unreachable",
        message: "The Console could not complete the Usage refresh request."
      });
      if (hasSnapshot) setIsStale(true);
      return false;
    } finally {
      setIsRefreshing(false);
    }
  }, [baseIntervalMs, hasSnapshot, queryString, scope]);

  React.useEffect(() => {
    const loop = startUsageRefreshLoop({
      baseIntervalMs,
      refresh: performRefresh,
      isPaused: () => pausedReference.current,
      onScheduledDelay: (delayMs) => setScheduledDelayMs(delayMs)
    });
    loopReference.current = loop;
    return () => {
      loop.stop();
      if (loopReference.current === loop) loopReference.current = null;
    };
  }, [baseIntervalMs, isPaused, performRefresh, scopeKey]);

  const freshnessState = hasSnapshot
    ? isStale
      ? "stale"
      : isPaused
        ? "paused"
        : "current"
    : "unavailable";
  const badge = freshnessBadge(hasSnapshot, isStale, isPaused);
  const cadence = cadenceText(
    scope,
    isPaused,
    baseIntervalMs,
    scheduledDelayMs
  );

  const summary = React.createElement(
    "div",
    { className: "flex min-w-0 flex-wrap items-center gap-3" },
    React.createElement(StatusBadge, {
      status: badge.status,
      label: badge.label
    }),
    renderTimestampsMeta(observedAt, lastSuccessAt, cadence)
  );
  const actions = renderActionButtons(
    isRefreshing,
    isPaused,
    () => loopReference.current?.triggerNow(),
    () => setIsPaused((current) => !current)
  );
  const bar = React.createElement(
    "div",
    {
      className: `${FILTER_PANEL_CLASS} flex flex-wrap items-center justify-between gap-3`
    },
    summary,
    actions
  );

  return React.createElement(
    "div",
    {
      className: "flex flex-col gap-2",
      "data-usage-freshness": freshnessState,
      "data-usage-refresh-paused": isPaused ? "true" : "false"
    },
    bar,
    renderRefreshFailureBanner(hasSnapshot, failure)
  );
}
