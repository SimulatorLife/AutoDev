import {
  isHistoricalUsageSelection,
  type UsageFilterSelection
} from "@simulatorlife/autodev-core";
import React from "react";

import { UsageView } from "../../src/features/usage/UsageView.ts";
import {
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

interface UsagePageProps {
  readonly searchParams: Promise<UsageSearchParams>;
}

export default async function UsagePage({
  searchParams
}: UsagePageProps): Promise<React.JSX.Element> {
  const { section, config } = readNodeContext("/usage");
  const selection: UsageFilterSelection = usageSelectionFromSearchParams(
    await searchParams
  );

  // The live-session scope has no interval, so it is served by the Runtime's
  // read-only control-plane projection rather than by a Usage telemetry query.
  // Asking OpenLIT for it would request a window that does not exist.
  if (!isHistoricalUsageSelection(selection)) {
    const live = await loadUsageActiveSessions(config ?? null);
    if (live.kind === "not-configured") {
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

  const result = await loadOpenLITUsage(selection);
  if (result.kind === "not-configured") {
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
      React.createElement(UsageView, { selection })
    );
  }

  if (result.kind !== "ok") {
    const code =
      result.kind === "unreachable"
        ? "autodev_openlit_usage_unreachable"
        : result.kind === "unauthorized"
          ? "autodev_openlit_usage_unauthorized"
          : `autodev_openlit_usage_http_${result.status}`;
    const title =
      result.kind === "unreachable"
        ? "Usage telemetry service could not be reached"
        : result.kind === "unauthorized"
          ? "Usage telemetry service rejected the server credential"
          : "Usage query failed";
    return React.createElement(
      ConsolePageShell,
      { section },
      React.createElement(ResourceUnavailable, {
        title,
        code,
        message:
          result.kind === "unreachable"
            ? "The read-only Usage endpoint is unavailable or returned an invalid response."
            : `The Usage endpoint returned HTTP ${result.status}.`,
        hint: "Telemetry values remain not observed until the Usage endpoint returns validated query data."
      }),
      React.createElement(UsageView, { selection })
    );
  }

  return React.createElement(
    ConsolePageShell,
    { section },
    React.createElement(UsageView, {
      metrics: result.data.metrics,
      filterOptions: result.data.filterOptions,
      selection
    })
  );
}
