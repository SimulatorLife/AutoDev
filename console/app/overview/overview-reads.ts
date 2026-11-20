/**
 * The Overview's reads: one bounded read per authoritative source, in parallel.
 *
 * Server-only. Every source keeps its own outcome -- observed, not configured,
 * or unavailable -- so a failed read is never presented as an empty list or a
 * zero, and one failing source does not hide the others. Verdicts and quota
 * exhaustion come from the same projections the Providers page uses; nothing
 * here derives readiness from raw health values.
 */

import type {
  ControlApiProvidersResponse,
  UsageFilterSelection,
  UsageMetricsData
} from "@simulatorlife/autodev-core";

import type {
  OverviewData,
  OverviewFailures,
  OverviewLiveActivity,
  OverviewProviderVerdicts,
  OverviewRead
} from "../../src/features/overview/overview-types.ts";
import { resolveProviderStatus } from "../../src/features/providers/provider-status.ts";
import {
  exhaustedQuotaByProvider,
  quotaExhaustionEvidence
} from "../../src/features/providers/ProviderQuota.ts";
import {
  type ControlApiConfig,
  controlApiFailureCode,
  type ControlApiResult,
  fetchFleetSessionScan,
  fetchProviders,
  fetchRuntime
} from "../../src/lib/server/control-api.ts";
import type { ConsoleUsageResult } from "../../src/lib/server/openlit-usage.ts";
import { activeSessionsFromRuntime } from "../../src/lib/server/usage-active-sessions.ts";
import { readUsageTelemetry } from "../../src/lib/server/usage-telemetry.ts";

/** The fixed telemetry window; the shared telemetry cache may be up to 5 minutes old. */
export const OVERVIEW_TELEMETRY_SELECTION: UsageFilterSelection = {
  range: "24H",
  values: {}
};

/** How many of the newest sessions the failure scan reads. */
export const OVERVIEW_FLEET_SCAN_LIMIT = 10;

/** How many failing sessions the Overview lists. */
export const OVERVIEW_FAILING_SESSION_LIMIT = 5;

const NOT_CONFIGURED_CODE = "autodev_control_api_disabled";

function controlFailure(
  result: Exclude<ControlApiResult<unknown>, { readonly kind: "ok" }>
): OverviewRead<never> {
  return {
    status: "unavailable",
    code: controlApiFailureCode(result),
    message: result.message
  };
}

function notConfigured(): OverviewRead<never> {
  return {
    status: "not-configured",
    code: NOT_CONFIGURED_CODE,
    message: "The Control API credential is not configured."
  };
}

/** A read that threw is an unavailable source, never an empty one. */
async function settle<T>(read: () => Promise<OverviewRead<T>>) {
  try {
    return await read();
  } catch (error) {
    return {
      status: "unavailable",
      code: "autodev_overview_read_failed",
      message: error instanceof Error ? error.message : String(error)
    } satisfies OverviewRead<never>;
  }
}

/** Fold providers into verdict counts using the Providers page's own verdict. */
export function countProviderVerdicts(
  response: Pick<ControlApiProvidersResponse, "quotaAxi" | "providers">
): OverviewProviderVerdicts {
  const exhaustion = exhaustedQuotaByProvider(response.quotaAxi);
  let ready = 0;
  let quotaExhausted = 0;
  let notObserved = 0;
  let unavailable = 0;
  let needsAttention = 0;
  for (const provider of response.providers) {
    const status = resolveProviderStatus(provider, exhaustion.get(provider.id));
    if (status.verdict === "quota-exhausted") quotaExhausted += 1;
    else if (status.verdict === "ready") ready += 1;
    else if (status.tone === "not-observed") notObserved += 1;
    else if (status.tone === "unavailable") unavailable += 1;
    else needsAttention += 1;
  }
  const quotaEvidence = quotaExhaustionEvidence(response.quotaAxi);
  return {
    total: response.providers.length,
    ready,
    quotaExhausted:
      quotaEvidence === "fresh" || quotaEvidence === "partial"
        ? quotaExhausted
        : null,
    notObserved,
    unavailable,
    needsAttention,
    quotaEvidence
  };
}

function telemetryFailure(code: string, message: string): OverviewRead<never> {
  return { status: "unavailable", code, message };
}

function telemetryRead(
  result: ConsoleUsageResult
): OverviewRead<UsageMetricsData> {
  if (result.kind === "ok") return { status: "ok", data: result.data.metrics };
  if (result.kind === "not-configured") {
    return {
      status: "not-configured",
      code: "autodev_usage_credentials_disabled",
      message: "The Usage telemetry credential is not configured."
    };
  }
  if (result.kind === "unauthorized") {
    return telemetryFailure(
      "autodev_openlit_usage_unauthorized",
      `The Usage endpoint returned HTTP ${result.status}.`
    );
  }
  if (result.kind === "http-error") {
    return telemetryFailure(
      `autodev_openlit_usage_http_${result.status}`,
      `The Usage endpoint returned HTTP ${result.status}.`
    );
  }
  if (result.kind === "invalid-response") {
    return telemetryFailure(
      "autodev_openlit_usage_invalid_response",
      "OpenLIT returned an invalid Usage response."
    );
  }
  return telemetryFailure(
    "autodev_openlit_usage_unreachable",
    "The Usage telemetry service could not be reached."
  );
}

/** The four source readers; production uses the Console's existing APIs. */
export interface OverviewReaders {
  readonly runtime: typeof fetchRuntime;
  readonly providers: typeof fetchProviders;
  readonly fleetScan: typeof fetchFleetSessionScan;
  readonly telemetry: typeof readUsageTelemetry;
}

const DEFAULT_OVERVIEW_READERS: OverviewReaders = {
  runtime: fetchRuntime,
  providers: fetchProviders,
  fleetScan: fetchFleetSessionScan,
  telemetry: readUsageTelemetry
};

/** Read every Overview source once, in parallel. */
export async function readOverview(
  config: ControlApiConfig | null,
  readers: OverviewReaders = DEFAULT_OVERVIEW_READERS
): Promise<OverviewData> {
  const [liveActivity, providers, failures, telemetry] = await Promise.all([
    settle<OverviewLiveActivity>(async () => {
      if (config === null) return notConfigured();
      const result = await readers.runtime(config);
      if (result.kind !== "ok") return controlFailure(result);
      return {
        status: "ok",
        data: {
          activeSessions: activeSessionsFromRuntime(result.data),
          liveAgents: result.data.liveAgents
        }
      };
    }),
    settle<OverviewProviderVerdicts>(async () => {
      if (config === null) return notConfigured();
      const result = await readers.providers(config);
      if (result.kind !== "ok") return controlFailure(result);
      return { status: "ok", data: countProviderVerdicts(result.data) };
    }),
    settle<OverviewFailures>(async () => {
      if (config === null) return notConfigured();
      const result = await readers.fleetScan(OVERVIEW_FLEET_SCAN_LIMIT, config);
      if (result.kind !== "ok") return controlFailure(result);
      const failing = result.data.sessions
        .filter((row) => row.toolFailures > 0 || row.routerFailures > 0)
        .toSorted(
          (a, b) =>
            b.toolFailures +
            b.routerFailures -
            (a.toolFailures + a.routerFailures)
        );
      return {
        status: "ok",
        data: {
          scannedSessions: result.data.sessions.length,
          scanLimit: result.data.limit,
          toolFailures: result.data.sessions.reduce(
            (sum, row) => sum + row.toolFailures,
            0
          ),
          routerFailures: result.data.sessions.reduce(
            (sum, row) => sum + row.routerFailures,
            0
          ),
          failingSessionCount: failing.length,
          failingSessions: failing
            .slice(0, OVERVIEW_FAILING_SESSION_LIMIT)
            .map((row) => ({
              id: row.id,
              lastWrite: row.lastWrite,
              toolFailures: row.toolFailures,
              routerFailures: row.routerFailures
            }))
        }
      };
    }),
    settle<UsageMetricsData>(async () =>
      telemetryRead(await readers.telemetry(OVERVIEW_TELEMETRY_SELECTION))
    )
  ]);
  return { liveActivity, providers, failures, telemetry };
}
