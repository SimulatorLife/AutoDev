import assert from "node:assert/strict";
import test from "node:test";

import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import type { VisibilitySource } from "../src/components/navigation/visibility.ts";
import {
  ACTIVE_SESSIONS_REFRESH_SCOPE,
  DASHBOARD_REFRESH_SCOPE,
  parseUsageRefreshPayload,
  USAGE_API_SCHEMA,
  usageRefreshUrl
} from "../src/features/usage/usage-api.ts";
import {
  ACTIVE_SESSIONS_REFRESH_INTERVAL_MS,
  computeUsageRefreshDelayMs,
  HISTORICAL_USAGE_REFRESH_INTERVAL_MS,
  MAX_USAGE_BACKOFF_INTERVAL_MS,
  startUsageRefreshLoop,
  type UsageRefreshScheduler
} from "../src/features/usage/usage-refresh.ts";
import { UsageFreshnessControls } from "../src/features/usage/UsageFreshnessControls.ts";

function fakeVisibility(): VisibilitySource & {
  readonly setVisible: (isNextVisible: boolean) => void;
} {
  let isVisible = true;
  let listeners: (() => void)[] = [];
  return {
    isVisible: () => isVisible,
    onVisible: (listener: () => void) => {
      listeners.push(listener);
      return () => {
        listeners = listeners.filter((item) => item !== listener);
      };
    },
    setVisible: (isNextVisible: boolean) => {
      const hasBecomeVisible = !isVisible && isNextVisible;
      isVisible = isNextVisible;
      if (hasBecomeVisible) {
        for (const listener of listeners) listener();
      }
    }
  };
}

function fakeTimerQueue(): {
  readonly scheduler: UsageRefreshScheduler;
  readonly delays: number[];
  readonly flushNext: () => void;
  readonly pendingCount: () => number;
} {
  let nextId = 1;
  const tasks = new Map<number, () => void>();
  const delays: number[] = [];
  return {
    scheduler: {
      setTimeout: (callback: () => void, delayMs: number) => {
        const id = nextId;
        nextId += 1;
        delays.push(delayMs);
        tasks.set(id, callback);
        return id;
      },
      clearTimeout: (handle: number) => {
        tasks.delete(handle);
      }
    } as unknown as UsageRefreshScheduler,
    delays,
    flushNext: () => {
      const first = tasks.entries().next();
      if (first.done) return;
      const [id, callback] = first.value;
      tasks.delete(id);
      callback();
    },
    pendingCount: () => tasks.size
  };
}

test("Usage refresh constants and backoff follow the target-state cadence", () => {
  assert.equal(HISTORICAL_USAGE_REFRESH_INTERVAL_MS, 60_000);
  assert.equal(ACTIVE_SESSIONS_REFRESH_INTERVAL_MS, 5000);
  assert.equal(computeUsageRefreshDelayMs(60_000, 0), 60_000);
  assert.equal(computeUsageRefreshDelayMs(60_000, 1), 120_000);
  assert.equal(computeUsageRefreshDelayMs(60_000, 2), 240_000);
  assert.equal(
    computeUsageRefreshDelayMs(60_000, 4),
    MAX_USAGE_BACKOFF_INTERVAL_MS
  );
  assert.equal(computeUsageRefreshDelayMs(5000, 1), 10_000);
});

test("startUsageRefreshLoop pauses when hidden, backs off on failures, and resumes on visibility", async () => {
  const queue = fakeTimerQueue();
  const visibility = fakeVisibility();
  let hasSucceeded = true;
  let calls = 0;

  const handle = startUsageRefreshLoop({
    baseIntervalMs: HISTORICAL_USAGE_REFRESH_INTERVAL_MS,
    refresh: async () => {
      calls += 1;
      return hasSucceeded;
    },
    isPaused: () => false,
    scheduler: queue.scheduler,
    visibility,
    canRefresh: () => true
  });

  assert.deepEqual(queue.delays, [60_000]);

  hasSucceeded = false;
  queue.flushNext();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(calls, 1);
  assert.deepEqual(queue.delays, [60_000, 120_000]);

  hasSucceeded = true;
  queue.flushNext();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(calls, 2);
  assert.deepEqual(queue.delays, [60_000, 120_000, 60_000]);

  visibility.setVisible(false);
  queue.flushNext();
  await Promise.resolve();
  assert.equal(calls, 2, "hidden page does not trigger scheduled refresh");

  visibility.setVisible(true);
  await Promise.resolve();
  assert.equal(
    calls,
    3,
    "becoming visible triggers an immediate catch-up tick"
  );

  handle.stop();
  assert.equal(queue.pendingCount(), 0);
});

test("startUsageRefreshLoop honors pause state and supports manual refresh", async () => {
  const queue = fakeTimerQueue();
  const visibility = fakeVisibility();
  let calls = 0;

  const handle = startUsageRefreshLoop({
    baseIntervalMs: HISTORICAL_USAGE_REFRESH_INTERVAL_MS,
    refresh: async () => {
      calls += 1;
      return true;
    },
    isPaused: () => true,
    scheduler: queue.scheduler,
    visibility,
    canRefresh: () => true
  });

  assert.equal(queue.pendingCount(), 0);
  handle.triggerNow();
  await Promise.resolve();
  assert.equal(
    calls,
    1,
    "manual trigger still runs while auto-refresh is paused"
  );
  assert.equal(queue.pendingCount(), 0);

  handle.stop();
});

test("usageRefreshUrl and parseUsageRefreshPayload enforce the typed refresh contract", () => {
  assert.equal(
    usageRefreshUrl(DASHBOARD_REFRESH_SCOPE, "range=7D&workspace=a%2Fb"),
    "/api/usage?range=7D&workspace=a%2Fb&scope=dashboard-refresh"
  );

  assert.deepEqual(
    parseUsageRefreshPayload({
      schema: USAGE_API_SCHEMA,
      scope: DASHBOARD_REFRESH_SCOPE,
      status: "ok",
      observedAt: "2026-11-27T12:00:00.000Z"
    }),
    {
      schema: USAGE_API_SCHEMA,
      scope: DASHBOARD_REFRESH_SCOPE,
      status: "ok",
      observedAt: "2026-11-27T12:00:00.000Z"
    }
  );

  assert.deepEqual(
    parseUsageRefreshPayload({
      schema: USAGE_API_SCHEMA,
      scope: ACTIVE_SESSIONS_REFRESH_SCOPE,
      status: "error",
      observedAt: "2026-11-27T12:00:00.000Z",
      failureCode: "autodev_openlit_usage_http_503",
      failureMessage: "Service unavailable",
      httpStatus: 503
    }),
    {
      schema: USAGE_API_SCHEMA,
      scope: ACTIVE_SESSIONS_REFRESH_SCOPE,
      status: "error",
      observedAt: "2026-11-27T12:00:00.000Z",
      failureCode: "autodev_openlit_usage_http_503",
      failureMessage: "Service unavailable",
      httpStatus: 503
    }
  );

  for (const invalid of [
    null,
    {
      schema: "wrong",
      scope: DASHBOARD_REFRESH_SCOPE,
      status: "ok",
      observedAt: "2026-11-27T12:00:00.000Z"
    },
    {
      schema: USAGE_API_SCHEMA,
      scope: "workspace-requests",
      status: "ok",
      observedAt: "2026-11-27T12:00:00.000Z"
    },
    {
      schema: USAGE_API_SCHEMA,
      scope: DASHBOARD_REFRESH_SCOPE,
      status: "ok",
      observedAt: ""
    },
    {
      schema: USAGE_API_SCHEMA,
      scope: DASHBOARD_REFRESH_SCOPE,
      status: "error",
      observedAt: "2026-11-27T12:00:00.000Z",
      failureCode: "",
      failureMessage: "bad",
      httpStatus: null
    }
  ]) {
    assert.equal(parseUsageRefreshPayload(invalid), null);
  }
});

test("UsageFreshnessControls renders observation timestamps and accessible controls", () => {
  const observed = "2026-11-27T12:00:00.000Z";
  const markup = renderToStaticMarkup(
    React.createElement(UsageFreshnessControls, {
      scope: DASHBOARD_REFRESH_SCOPE,
      queryString: "range=24H",
      initialObservedAt: observed,
      initialLastSuccessAt: observed,
      hasSnapshot: true
    })
  );

  assert.match(markup, /data-usage-freshness="current"/u);
  assert.match(markup, /Current/u);
  assert.match(markup, /2026-11-27 12:00:00 UTC/u);
  assert.match(markup, /Auto-refreshes every 60s while visible/u);
  assert.match(markup, /data-button="usage-refresh-now"/u);
  assert.match(markup, /data-button="usage-refresh-toggle"/u);
  assert.match(markup, /Pause auto-refresh/u);
});
