import {
  isHistoricalUsageSelection,
  type UsageFilterSelection,
  type UsageHistoricalTimeRange,
  type UsageSessionQuerySelection
} from "@simulatorlife/autodev-core";
import type { Metadata } from "next";
import React from "react";

import {
  type SessionDiagnosticsFailure,
  SessionDiagnosticsView,
  type SessionDiagnosticsViewState
} from "../../src/features/usage/SessionDiagnosticsView.ts";
import {
  UsageFleetDiagnosticsView,
  type UsageFleetFailure
} from "../../src/features/usage/UsageFleetDiagnosticsView.ts";
import {
  type UsageMcpInventory,
  type UsageTraceLookup,
  UsageView
} from "../../src/features/usage/UsageView.ts";
import {
  type ControlApiConfig,
  controlApiFailureCode,
  type ControlApiResult,
  fetchFleetSessionScan,
  fetchHookDenials,
  fetchMcpRuntime,
  fetchMcps,
  fetchSessionDiagnostics
} from "../../src/lib/server/control-api.ts";
import {
  type ConsoleSessionUsageResult,
  type ConsoleUsageResult,
  loadOpenLITSessionUsage,
  loadOpenLITTrace,
  type UsageSearchParams as UsageSearchParameters,
  usageViewStateFromSearchParams as usageViewStateFromSearchParameters
} from "../../src/lib/server/openlit-usage.ts";
import { loadUsageActiveSessions } from "../../src/lib/server/usage-active-sessions.ts";
import { readUsageTelemetry } from "../../src/lib/server/usage-telemetry.ts";
import {
  ConsolePageShell,
  readNodeContext,
  ResourceUnavailable
} from "../_console.ts";

export const dynamic = "force-dynamic";
const NOT_CONFIGURED = "not-configured";
const HTTP_ERROR = "http-error";
const FLEET_SCAN_LIMIT = 20;

interface UsagePageProperties {
  readonly searchParams: Promise<UsageSearchParameters>;
}

export const metadata: Metadata = {
  title: "Usage"
};

type UsageEndpointFailure = Exclude<
  ConsoleUsageResult,
  { readonly kind: typeof NOT_CONFIGURED | "ok" }
>;

function unavailableUsageState(result: UsageEndpointFailure) {
  switch (result.kind) {
    case "unreachable": {
      return {
        title: "Usage telemetry service could not be reached",
        code: "autodev_openlit_usage_unreachable",
        message:
          "The Console could not connect to the configured OpenLIT Usage endpoint.",
        hint: "Check that OpenLIT is running and AUTODEV_OPENLIT_USAGE_URL points to its HTTP service. No sample telemetry is substituted."
      };
    }
    case "invalid-response": {
      return {
        title: "Usage telemetry response was invalid",
        code: "autodev_openlit_usage_invalid_response",
        message:
          "OpenLIT returned data that does not match the validated AutoDev Usage response schema.",
        hint: "Confirm OpenLIT serves the required AutoDev Usage v5 contract. After an upgrade, rebuild and restart the managed Console; metric panels stay hidden until validation succeeds."
      };
    }
    case "unauthorized": {
      return {
        title: "Usage telemetry service rejected the server credential",
        code: "autodev_openlit_usage_unauthorized",
        message: `The Usage endpoint returned HTTP ${result.status}.`,
        hint: "Verify the dedicated server-side Usage credential; it is never sent to the browser."
      };
    }
    case HTTP_ERROR: {
      return {
        title: "Usage query failed",
        code: `autodev_openlit_usage_http_${result.status}`,
        message: `The Usage endpoint returned HTTP ${result.status}.`,
        hint: "Check the OpenLIT Usage endpoint status and keep telemetry unavailable until the read succeeds."
      };
    }
  }
  throw new Error("Unhandled OpenLIT Usage failure result.");
}

function usageTraceLookup(
  result: Awaited<ReturnType<typeof loadOpenLITTrace>>
): UsageTraceLookup {
  switch (result.kind) {
    case "ok": {
      return { kind: "observed", detail: result.data };
    }
    case NOT_CONFIGURED: {
      return { kind: NOT_CONFIGURED };
    }
    case "invalid-span-id": {
      return { kind: "invalid-span-id" };
    }
    case "not-found": {
      return { kind: "not-found" };
    }
    case "unauthorized": {
      return { kind: "unauthorized" };
    }
    case HTTP_ERROR: {
      return { kind: HTTP_ERROR, status: result.status };
    }
    case "unreachable": {
      return { kind: "unavailable" };
    }
    default: {
      throw new Error("Unhandled Usage trace result.");
    }
  }
}

function diagnosticsFailure(
  code: string,
  message: string
): SessionDiagnosticsFailure {
  return { code, message };
}

/**
The span read's refusal, as the failure the view renders.

Every refusal is named: an unreachable telemetry store and a credential the
store rejected are different problems with different next steps, and a
generic "could not be read" would hide which one happened.
*/
function spansFailureFor(
  result: Exclude<ConsoleSessionUsageResult, { readonly kind: "ok" }>
): SessionDiagnosticsFailure {
  switch (result.kind) {
    case "unauthorized": {
      return diagnosticsFailure(
        "autodev_usage_unauthorized",
        `The Usage endpoint returned HTTP ${result.status}; the server-side Usage credential was rejected.`
      );
    }
    case HTTP_ERROR: {
      return diagnosticsFailure(
        `autodev_usage_http_${result.status}`,
        `The Usage endpoint returned HTTP ${result.status}.`
      );
    }
    case "invalid-response": {
      return diagnosticsFailure(
        "autodev_openlit_usage_invalid_response",
        "The telemetry store's span evidence did not match the validated AutoDev session-usage schema."
      );
    }
    case "invalid-session-id": {
      return diagnosticsFailure(
        "autodev_usage_invalid_session_id",
        "That session id is not a valid AutoDev session identity."
      );
    }
    case NOT_CONFIGURED: {
      return diagnosticsFailure(
        "autodev_usage_credentials_disabled",
        "Set AUTODEV_OPENLIT_USAGE_TOKEN in the Next.js server environment to read span evidence."
      );
    }
    default: {
      return diagnosticsFailure(
        "autodev_usage_unavailable",
        "The telemetry store could not be reached for this session's span evidence."
      );
    }
  }
}

/**
A Control API refusal, as the failure the view renders.

The unreachable case has no `code` of its own -- it has a deadline flag --
so the shared failure-code mapping answers for it.
*/
function controlApiFailure(
  result: Exclude<ControlApiResult<unknown>, { readonly kind: "ok" }>
): SessionDiagnosticsFailure {
  if (result.kind === "unreachable") {
    return {
      code: controlApiFailureCode(result),
      message: result.message
    };
  }
  return { code: result.code, message: result.message };
}

function fleetFailure(code: string, message: string): UsageFleetFailure {
  return { code, message };
}

/**
The historical range a session-scoped page queries.

The live-session scope has no interval, so a session scope over it falls
back to the shortest historical window: the span store is queried over a
window, and there has to be one.
*/
function sessionRange(
  selection: UsageFilterSelection
): UsageHistoricalTimeRange | "CUSTOM" {
  if (selection.range === "CUSTOM") return "CUSTOM";
  if (selection.range === "ACTIVE_SESSIONS") return "24H";
  return selection.range;
}

function sessionQuerySelection(
  selection: UsageFilterSelection
): UsageSessionQuerySelection {
  const range = sessionRange(selection);
  if (range === "CUSTOM") {
    return {
      range: "CUSTOM",
      customRange: selection.customRange ?? {
        startDate: "1970-01-01",
        endDate: "1970-01-01"
      }
    };
  }
  return { range };
}

function sessionViewState(
  state: ReturnType<typeof usageViewStateFromSearchParameters>,
  sessionId: string
): SessionDiagnosticsViewState {
  return {
    sessionId,
    range: sessionRange(state.selection),
    tab: state.tab,
    spanOffset: state.spanOffset,
    spanLimit: state.spanLimit,
    spanSort: state.spanSort,
    eventsOffset: state.eventsOffset,
    eventsLimit: state.eventsLimit,
    itemsOffset: state.itemsOffset,
    itemsLimit: state.itemsLimit,
    threadId: state.threadId,
    failureCategory: state.failureCategory
  };
}

export default async function UsagePage({
  searchParams
}: UsagePageProperties): Promise<React.JSX.Element> {
  const { section, config } = readNodeContext("/usage");
  const parameters = await searchParams;
  const state = usageViewStateFromSearchParameters(parameters);
  const selection: UsageFilterSelection = state.selection;

  // A session id in the top bar scopes the whole page to one session. The
  // fleet-wide telemetry query is not run at all in that case: it answers a
  // different question, and running it would put a fleet total beside a
  // session's own evidence.
  if (state.rawSessionId.length > 0) {
    return React.createElement(
      ConsolePageShell,
      { section },
      await renderSessionScopedPage(parameters, state, config ?? null)
    );
  }

  // The live-session scope has no interval, so it is served by the Runtime's
  // read-only control-plane projection rather than by a Usage telemetry query.
  // Asking OpenLIT for it would request a window that does not exist.
  if (!isHistoricalUsageSelection(selection)) {
    const live = await loadUsageActiveSessions(config ?? null);
    if (live.kind === NOT_CONFIGURED) {
      return React.createElement(
        ConsolePageShell,
        { section },
        React.createElement(ResourceUnavailable, {
          title: "Control API credential is not configured",
          code: live.code,
          message:
            "Set AUTODEV_CONTROL_API_TOKEN in the Next.js server environment to read live session state.",
          hint: "Active sessions come from the Runtime's read-only /control/runtime projection."
        }),
        React.createElement(UsageView, { selection })
      );
    }
    if (live.kind === "unavailable") {
      return React.createElement(
        ConsolePageShell,
        { section },
        React.createElement(ResourceUnavailable, {
          title: "Live session state could not be read",
          code: live.code,
          message: live.message,
          hint: "An unavailable read is not an idle Runtime; no session count is shown until the Runtime reports one."
        }),
        React.createElement(UsageView, { selection })
      );
    }
    return React.createElement(
      ConsolePageShell,
      {
        section
      },
      React.createElement(UsageView, {
        selection,
        activeSessions: live.activeSessions
      })
    );
  }

  const rawSpanId = parameters.spanId;
  const selectedSpanId =
    typeof rawSpanId === "string"
      ? rawSpanId
      : rawSpanId?.length === 1
        ? rawSpanId[0]
        : undefined;
  const hasTraceSelection = rawSpanId !== undefined;
  const [result, traceResult] = await Promise.all([
    readUsageTelemetry(selection),
    hasTraceSelection
      ? loadOpenLITTrace(selectedSpanId ?? "")
      : Promise.resolve(undefined)
  ]);
  const traceLookup =
    traceResult === undefined ||
    (result.kind !== "ok" && traceResult.kind !== "ok")
      ? undefined
      : usageTraceLookup(traceResult);

  if (result.kind === NOT_CONFIGURED) {
    return React.createElement(
      ConsolePageShell,
      { section },
      React.createElement(ResourceUnavailable, {
        title: "Usage telemetry credential is not configured",
        code: "autodev_usage_credentials_disabled",
        message:
          "Set AUTODEV_OPENLIT_USAGE_TOKEN in the Next.js server environment to read telemetry.",
        hint: "The Usage token is server-only and is never sent to the browser."
      }),
      React.createElement(UsageView, {
        selection,
        ...(traceLookup !== undefined && { traceLookup })
      })
    );
  }

  if (result.kind !== "ok") {
    return React.createElement(
      ConsolePageShell,
      { section },
      React.createElement(ResourceUnavailable, unavailableUsageState(result)),
      React.createElement(UsageView, {
        selection,
        ...(traceLookup !== undefined && { traceLookup })
      })
    );
  }

  const [fleetView, mcpInventory] = await Promise.all([
    renderFleetView(state, config ?? null),
    loadUsageMcpInventory(config ?? null)
  ]);

  return React.createElement(
    ConsolePageShell,
    {
      section
    },
    React.createElement(UsageView, {
      metrics: result.data.metrics,
      filterOptions: result.data.filterOptions,
      traceList: result.data.traceList,
      selection,
      fleetView,
      mcpInventory,
      ...(traceLookup !== undefined && { traceLookup })
    })
  );
}

/**
MCP server inventory and Runtime usage observations for the Usage page.

Reuses the same two Control API reads as `/mcps`: the catalog read
describes what is configured and exposed, and the runtime read reports
calls and failures accumulated since router start. Unavailability stays
explicit rather than collapsing to an empty server list.
*/
async function loadUsageMcpInventory(
  config: ControlApiConfig | null
): Promise<UsageMcpInventory> {
  if (config === null) {
    return {
      kind: "unavailable",
      code: "autodev_control_api_not_configured",
      message:
        "The Control API credential is not configured, so MCP server inventory and runtime usage cannot be read."
    };
  }
  const [catalogResult, runtimeResult] = await Promise.all([
    fetchMcps(config),
    fetchMcpRuntime(config)
  ]);
  if (catalogResult.kind !== "ok") {
    return {
      kind: "unavailable",
      code: controlApiFailureCode(catalogResult),
      message: catalogResult.message
    };
  }
  return {
    kind: "observed",
    servers: catalogResult.data.servers,
    sourceValidity: catalogResult.data.valid,
    validationIssues: catalogResult.data.issues,
    runtime: runtimeResult.kind === "ok" ? runtimeResult.data : null,
    runtimeFailure:
      runtimeResult.kind === "ok"
        ? null
        : {
            code: controlApiFailureCode(runtimeResult),
            message: runtimeResult.message
          }
  };
}

/**
The unscoped fleet diagnostics view.

Only the selected view is read: the fleet scan walks every recent session's
rollout, and the hook summary reads the whole hook log, so neither is worth
reading for a page that will not show it.
*/
async function renderFleetView(
  state: ReturnType<typeof usageViewStateFromSearchParameters>,
  config: ControlApiConfig | null
): Promise<React.JSX.Element> {
  if (state.view === "overview") {
    return React.createElement(UsageFleetDiagnosticsView, {
      view: "overview",
      range: sessionRange(state.selection),
      scan: null,
      scanFailure: null,
      hooks: null,
      hooksFailure: null,
      hooksSinceDays: state.hooksSinceDays
    });
  }
  if (config === null) {
    return React.createElement(UsageFleetDiagnosticsView, {
      view: state.view,
      range: sessionRange(state.selection),
      scan: null,
      scanFailure: fleetFailure(
        "autodev_control_api_not_configured",
        "The Control API credential is not configured, so the fleet diagnostics cannot be read."
      ),
      hooks: null,
      hooksFailure: fleetFailure(
        "autodev_control_api_not_configured",
        "The Control API credential is not configured, so the fleet diagnostics cannot be read."
      ),
      hooksSinceDays: state.hooksSinceDays
    });
  }
  if (state.view === "sessions") {
    const scan = await fetchFleetSessionScan(FLEET_SCAN_LIMIT, config);
    return React.createElement(UsageFleetDiagnosticsView, {
      view: "sessions",
      range: sessionRange(state.selection),
      scan: scan.kind === "ok" ? scan.data : null,
      scanFailure:
        scan.kind === "ok"
          ? null
          : fleetFailure(controlApiFailureCode(scan), scan.message),
      hooks: null,
      hooksFailure: null,
      hooksSinceDays: state.hooksSinceDays
    });
  }
  const hooks = await fetchHookDenials(state.hooksSinceDays, config);
  return React.createElement(UsageFleetDiagnosticsView, {
    view: "hooks",
    range: sessionRange(state.selection),
    scan: null,
    scanFailure: null,
    hooks: hooks.kind === "ok" ? hooks.data : null,
    hooksFailure:
      hooks.kind === "ok"
        ? null
        : fleetFailure(controlApiFailureCode(hooks), hooks.message),
    hooksSinceDays: state.hooksSinceDays
  });
}

/**
The session-scoped page.

The Control API's diagnostics read and the OpenLIT span page are read in
parallel and degrade independently: a session whose spans the telemetry
store does not have still shows its rollouts, its router requests and its
failures.
*/
async function renderSessionScopedPage(
  parameters: UsageSearchParameters,
  state: ReturnType<typeof usageViewStateFromSearchParameters>,
  config: ControlApiConfig | null
): Promise<React.JSX.Element> {
  if (state.sessionId === null) {
    return React.createElement(UsageView, {
      selection: state.selection,
      sessionScope: {
        sessionId: null,
        invalid: true,
        rawSessionId: state.rawSessionId
      },
      sessionView: React.createElement(
        "p",
        { className: "text-sm text-warning", role: "status" },
        "That session id is not a valid AutoDev session identity. It must start with a letter or digit and may contain letters, digits, dots, colons, dashes and underscores."
      )
    });
  }
  const sessionId = state.sessionId;
  const viewState = sessionViewState(state, sessionId);
  const rawSpanId = parameters.spanId;
  const selectedSpanId =
    typeof rawSpanId === "string"
      ? rawSpanId
      : rawSpanId?.length === 1
        ? rawSpanId[0]
        : undefined;

  // Diagnostics, the requested span page, and selected trace read are
  // independent and degrade separately. Thread provider attribution comes
  // from the Runtime's per-thread router summary in the diagnostics report.
  const [diagnosticsResult, spansResult, traceResult] = await Promise.all([
    config === null
      ? Promise.resolve({
          kind: "failed" as const,
          failure: diagnosticsFailure(
            "autodev_control_api_not_configured",
            "The Control API credential is not configured, so the session diagnostics cannot be read."
          )
        })
      : fetchSessionDiagnostics(
          sessionId,
          {
            includeEfficiency: true,
            includeFailures: true,
            includeEvents: true,
            eventsLimit: viewState.eventsLimit,
            eventsOffset: viewState.eventsOffset,
            includeItems: true,
            itemsLimit: viewState.itemsLimit,
            itemsOffset: viewState.itemsOffset,
            ...(viewState.threadId !== undefined && { threadId: viewState.threadId })
          },
          config
        ).then((result) =>
          result.kind === "ok"
            ? { kind: "ok" as const, report: result.data }
            : { kind: "failed" as const, failure: controlApiFailure(result) }
        ),
    loadOpenLITSessionUsage(sessionId, sessionQuerySelection(state.selection), {
      limit: viewState.spanLimit,
      offset: viewState.spanOffset,
      sortDirection: viewState.spanSort
    }),
    selectedSpanId === undefined
      ? Promise.resolve(undefined)
      : loadOpenLITTrace(selectedSpanId)
  ]);

  const report =
    diagnosticsResult.kind === "ok" ? diagnosticsResult.report : null;
  const diagnosticsFailureValue =
    diagnosticsResult.kind === "ok" ? null : diagnosticsResult.failure;
  const spansEvidence = spansResult.kind === "ok" ? spansResult.data : null;
  const spansFailureValue =
    spansResult.kind === "ok" ? null : spansFailureFor(spansResult);

  const spanHrefFor = (offset: number): string => {
    const parameters2 = new URLSearchParams({
      range: viewState.range,
      sessionId,
      tab: "spans",
      spanLimit: String(viewState.spanLimit),
      spanSort: viewState.spanSort,
      spanOffset: String(offset)
    });
    if (selectedSpanId !== undefined) parameters2.set("spanId", selectedSpanId);
    return `/usage?${parameters2.toString()}`;
  };

  return React.createElement(UsageView, {
    selection: state.selection,
    sessionScope: {
      sessionId,
      invalid: false,
      rawSessionId: state.rawSessionId
    },
    sessionView: React.createElement(SessionDiagnosticsView, {
      state: viewState,
      report,
      diagnosticsFailure: diagnosticsFailureValue,
      spans: spansEvidence,
      spansFailure: spansFailureValue,
      spanHrefFor
    }),
    ...(traceResult !== undefined && { traceLookup: usageTraceLookup(traceResult) })
  });
}
