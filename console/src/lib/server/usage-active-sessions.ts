/** Server-only read of the live-session evidence behind the Usage scope. */

import type {
  ControlApiRuntimeResponse,
  UsageActiveSessions
} from "@simulatorlife/autodev-core";

import {
  type ControlApiConfig,
  type ControlApiResult,
  controlApiFailureCode,
  fetchRuntime
} from "./control-api.ts";

export type UsageActiveSessionsResult =
  | {
      readonly kind: "not-configured";
      readonly code: string;
    }
  | {
      readonly kind: "unavailable";
      readonly code: string;
      readonly message: string;
    }
  | { readonly kind: "ok"; readonly activeSessions: UsageActiveSessions };

/**
 * Narrow a possibly-absent counter.
 *
 * The whole point of this module is that `undefined` and `0` stay different
 * facts, so nothing here may fall back to a default. `/control/runtime` declares
 * the concurrency counters optional precisely because a Runtime that has not
 * measured one is not reporting zero of them.
 */
function observedCount(value: number | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : null;
}

/**
 * Project the Runtime's read-only `/control/runtime` response into the Usage
 * live-session scope.
 *
 * Exported separately from the fetch so the projection is testable without a
 * transport, and so the Console never has to re-derive "unavailable means
 * unavailable" at the point of render.
 */
export function activeSessionsFromRuntime(
  runtime: ControlApiRuntimeResponse
): UsageActiveSessions {
  const concurrency = runtime.concurrency;
  return {
    schema: "autodev-usage-active-sessions-v1",
    lifecycle: runtime.lifecycle?.state ?? null,
    lifecycleChangedAt: runtime.lifecycle?.changedAt ?? null,
    activeSessions: observedCount(concurrency?.activeSessions),
    activeSubagentThreads: observedCount(concurrency?.activeSubagentThreads),
    inFlightRequests: observedCount(runtime.inFlightRequestCount),
    // The Runtime publishes a scalar count and no per-session identity, so the
    // scope has no session list to render. Stating that here is what lets the
    // view explain the absence instead of showing an empty table.
    perSessionIdentityAvailable: false
  };
}

/** Read live-session evidence, failing closed rather than defaulting to zero. */
export async function loadUsageActiveSessions(
  config: ControlApiConfig | null
): Promise<UsageActiveSessionsResult> {
  if (!config) {
    return {
      kind: "not-configured",
      code: "autodev_control_api_disabled"
    };
  }
  const result: ControlApiResult<ControlApiRuntimeResponse> =
    await fetchRuntime(config);
  if (result.kind !== "ok") {
    return {
      kind: "unavailable",
      code: controlApiFailureCode(result),
      message: result.message
    };
  }
  return { kind: "ok", activeSessions: activeSessionsFromRuntime(result.data) };
}
