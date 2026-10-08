import {
  isHistoricalUsageSelection,
  type UsageFilterSelection
} from "@simulatorlife/autodev-core";
import type { Metadata } from "next";
import React from "react";

import {
  type UsageTraceLookup,
  UsageView
} from "../../src/features/usage/UsageView.ts";
import {
  type ConsoleUsageResult,
  loadOpenLITTrace,
  loadOpenLITUsage,
  type UsageSearchParams,
  usageSelectionFromSearchParams
} from "../../src/lib/server/openlit-usage.ts";
import { loadUsageActiveSessions } from "../../src/lib/server/usage-active-sessions.ts";
import {
  ConsolePageShell,
  readNodeContext,
  ResourceUnavailable
} from "../_console.ts";

export const dynamic = "force-dynamic";
const NOT_CONFIGURED = "not-configured";

interface UsagePageProps {
  readonly searchParams: Promise<UsageSearchParams>;
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
        hint: "Update the OpenLIT Usage integration to return validated query data; metric panels stay hidden until then."
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
    case "http-error": {
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
    case "http-error": {
      return { kind: "http-error", status: result.status };
    }
    case "unreachable": {
      return { kind: "unavailable" };
    }
    default: {
      throw new Error("Unhandled Usage trace result.");
    }
  }
}

export default async function UsagePage({
  searchParams
}: UsagePageProps): Promise<React.JSX.Element> {
  const { section, config } = readNodeContext("/usage");
  const params = await searchParams;
  const selection: UsageFilterSelection =
    usageSelectionFromSearchParams(params);

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
      { section },
      React.createElement(UsageView, {
        selection,
        activeSessions: live.activeSessions
      })
    );
  }

  const rawSpanId = params.spanId;
  const selectedSpanId =
    typeof rawSpanId === "string"
      ? rawSpanId
      : rawSpanId?.length === 1
        ? rawSpanId[0]
        : undefined;
  const hasTraceSelection = rawSpanId !== undefined;
  const [result, traceResult] = await Promise.all([
    loadOpenLITUsage(selection),
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
        ...(traceLookup === undefined ? {} : { traceLookup })
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
        ...(traceLookup === undefined ? {} : { traceLookup })
      })
    );
  }

  return React.createElement(
    ConsolePageShell,
    { section },
    React.createElement(UsageView, {
      metrics: result.data.metrics,
      filterOptions: result.data.filterOptions,
      traceList: result.data.traceList,
      selection,
      ...(traceLookup === undefined ? {} : { traceLookup })
    })
  );
}
