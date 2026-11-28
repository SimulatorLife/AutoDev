/**
The Console's read-only Usage telemetry endpoint.

The Console's surfaces want small answers about the Usage telemetry: the
request breakdown a workspace row shows, the provider attempts one
provider's panel shows, the tool calls one tool's panel shows. This route
is where the browser asks for them.

It does not proxy the Usage dashboard to the browser. The dashboard is an
enormous payload -- every widget the service computes -- and the surfaces
that read it want one number from it, so handing the whole thing over
would move a very large body to answer a small question.

It does not hold the Usage credential either. The credential stays in the
server's environment, the reads happen on the server, and the browser
receives only the scoped answer. The credential is never part of a
response, an error message, or a query string.

The reads behind it are the cached ones in
`src/lib/server/usage-telemetry.ts`, because one read of the Usage
telemetry costs a fan-out of contended queries and the answer is a
historical aggregation rather than a live fact.
*/

import { isHistoricalUsageSelection } from "@simulatorlife/autodev-core";
import { type NextRequest, NextResponse } from "next/server.js";

import {
  ACTIVE_SESSIONS_REFRESH_SCOPE,
  DASHBOARD_REFRESH_SCOPE,
  isUsageProviderId,
  USAGE_API_SCHEMA,
  type UsageApiPayload,
  type UsageProviderAttemptSource,
  type UsageRefreshPayload,
  type UsageToolCallSource,
  type UsageWorkspaceRequestSource
} from "../../../src/features/usage/usage-api.ts";
import { readControlApiConfig } from "../../../src/lib/server/control-api.ts";
import {
  describeUsageEndpointFailure,
  type UsageSearchParams as UsageSearchParameters,
  usageSelectionFromSearchParams
} from "../../../src/lib/server/openlit-usage.ts";
import { loadUsageActiveSessions } from "../../../src/lib/server/usage-active-sessions.ts";
import {
  readUsageTelemetry,
  readUsageTelemetryWithTimestamp
} from "../../../src/lib/server/usage-telemetry.ts";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
The date the tool scope's window may name.

The bound is the shape of a calendar date and nothing else: a date that
does not look like one is not a window, and asking the telemetry store
about a window it cannot read would be answered as an empty interval.
*/
const USAGE_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/u;

/**
What a source that could not be read is reported as.
*/
const UNAVAILABLE = { kind: "unavailable" } as const;

/**
What a source that is not set up is reported as.
*/
const NOT_CONFIGURED = { kind: "not-configured" } as const;

/**
Every answer the route gives is a live read that must not be cached downstream.
*/
const NO_STORE_HEADERS = { "Cache-Control": "no-store" };

/**
The refusal a request the route cannot scope receives.

The refusal names the request and nothing else. It does not echo the
value that was refused back to the caller, because the value is
untrusted input and the route's answer to untrusted input is not a
channel for reflecting it.
*/
function refuse(message: string): NextResponse {
  return NextResponse.json(
    { error: message },
    { status: 400, headers: NO_STORE_HEADERS }
  );
}

function ok(body: UsageApiPayload): NextResponse {
  return NextResponse.json(body, {
    status: 200,
    headers: NO_STORE_HEADERS
  });
}

/**
The workspace request breakdown, as the Console's own vocabulary.

A source that could not be read is unavailable, and a source that read
without a breakdown is not observed. The two are kept apart: the first
says the Console does not know, and the second says the source knows and
reported no breakdown, and a workspace missing from the second is a
measurement of nothing rather than an absence of measurement.
*/
async function workspaceRequestSource(): Promise<UsageWorkspaceRequestSource> {
  const result = await readUsageTelemetry({ range: "24H", values: {} });
  if (result.kind !== "ok") return UNAVAILABLE;
  const breakdown = result.data.metrics.requestsByWorkspace;
  if (breakdown === null) return { kind: "not-observed" };
  return { kind: "observed", breakdown };
}

/**
One provider's attempts, as the Console's own vocabulary.

Only the provider-attempt breakdowns are carried over. Logical requests
can span several providers, so their totals belong to the shared Usage
view rather than to this provider, and a panel that showed them here
would attribute a request to a provider that never served it.
*/
async function providerAttemptSource(
  provider: string
): Promise<UsageProviderAttemptSource> {
  const result = await readUsageTelemetry({
    range: "7D",
    values: { provider: [provider] }
  });
  if (result.kind === "not-configured") return NOT_CONFIGURED;
  if (result.kind !== "ok") return UNAVAILABLE;
  return {
    kind: "available",
    attemptsByProvider: result.data.metrics.attemptsByProvider,
    attemptErrorsByProvider: result.data.metrics.attemptErrorsByProvider
  };
}

/**
The tool calls the source recorded, as the Console's own vocabulary.

The rows are the whole breakdown: which of them are this tool's calls is
a question about the catalogue's identity for the tool, and the
catalogue owns that identity rather than the telemetry store.
*/
async function toolCallSource(
  startDate: string,
  endDate: string
): Promise<UsageToolCallSource> {
  const result = await readUsageTelemetry({
    range: "24H",
    values: {},
    customRange: { startDate, endDate }
  });
  if (result.kind === "not-configured") return NOT_CONFIGURED;
  if (result.kind !== "ok") return UNAVAILABLE;
  return { kind: "available", callsByTool: result.data.metrics.callsByTool };
}

function okRefresh(body: UsageRefreshPayload): NextResponse {
  return NextResponse.json(body, {
    status: 200,
    headers: NO_STORE_HEADERS
  });
}

function usageSearchParameters(
  searchParameters: URLSearchParams
): UsageSearchParameters {
  const collected: Record<string, string | readonly string[]> = {};
  for (const key of new Set(searchParameters.keys())) {
    const values = searchParameters.getAll(key);
    collected[key] = values.length === 1 ? (values[0] ?? "") : values;
  }
  return collected;
}

async function dashboardRefreshResponse(
  searchParameters: URLSearchParams
): Promise<NextResponse> {
  const selection = usageSelectionFromSearchParams(
    usageSearchParameters(searchParameters)
  );
  if (!isHistoricalUsageSelection(selection)) {
    return refuse("Dashboard refresh requires a historical Usage selection.");
  }
  const { result, observedAt } = await readUsageTelemetryWithTimestamp(
    selection,
    { forceRefresh: true }
  );
  if (result.kind === "ok") {
    return okRefresh({
      schema: USAGE_API_SCHEMA,
      scope: DASHBOARD_REFRESH_SCOPE,
      status: "ok",
      observedAt
    });
  }
  const failure = describeUsageEndpointFailure(result);
  return okRefresh({
    schema: USAGE_API_SCHEMA,
    scope: DASHBOARD_REFRESH_SCOPE,
    status: "error",
    observedAt,
    failureCode: failure.code,
    failureMessage: failure.message,
    httpStatus: failure.httpStatus
  });
}

async function activeSessionsRefreshResponse(): Promise<NextResponse> {
  const live = await loadUsageActiveSessions(readControlApiConfig());
  const observedAt = new Date().toISOString();
  if (live.kind === "ok") {
    return okRefresh({
      schema: USAGE_API_SCHEMA,
      scope: ACTIVE_SESSIONS_REFRESH_SCOPE,
      status: "ok",
      observedAt
    });
  }
  return okRefresh({
    schema: USAGE_API_SCHEMA,
    scope: ACTIVE_SESSIONS_REFRESH_SCOPE,
    status: "error",
    observedAt,
    failureCode: live.code,
    failureMessage:
      live.kind === "not-configured"
        ? "Set AUTODEV_CONTROL_API_TOKEN in the Next.js server environment to read live session state."
        : live.message,
    httpStatus: null
  });
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const parameters = request.nextUrl.searchParams;
  const scope = parameters.get("scope");

  if (scope === DASHBOARD_REFRESH_SCOPE) {
    return dashboardRefreshResponse(parameters);
  }

  if (scope === ACTIVE_SESSIONS_REFRESH_SCOPE) {
    return activeSessionsRefreshResponse();
  }

  if (scope === "workspace-requests") {
    return ok({
      schema: USAGE_API_SCHEMA,
      scope: "workspace-requests",
      source: await workspaceRequestSource()
    });
  }

  if (scope === "provider-usage") {
    const provider = parameters.get("provider") ?? "";
    // The provider id names the scope of the read, so an id that is empty,
    // oversized, or not shaped like an identifier is refused rather than
    // answered: the telemetry store would answer a scope it does not know
    // with an empty breakdown, and the panel would read that as a measured
    // zero.
    if (!isUsageProviderId(provider)) {
      return refuse("A provider scope is required and must name a provider.");
    }
    return ok({
      schema: USAGE_API_SCHEMA,
      scope: "provider-usage",
      provider,
      source: await providerAttemptSource(provider)
    });
  }

  if (scope === "tool-usage") {
    const startDate = parameters.get("startDate") ?? "";
    const endDate = parameters.get("endDate") ?? "";
    if (
      (startDate !== "" && !USAGE_DATE_PATTERN.test(startDate)) ||
      (endDate !== "" && !USAGE_DATE_PATTERN.test(endDate))
    ) {
      return refuse("A window must name its bounds as YYYY-MM-DD.");
    }
    return ok({
      schema: USAGE_API_SCHEMA,
      scope: "tool-usage",
      source: await toolCallSource(startDate, endDate)
    });
  }

  return refuse("An unknown usage scope was requested.");
}
