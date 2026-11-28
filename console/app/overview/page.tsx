import type { Metadata } from "next";
import React from "react";

import { PageBody } from "../../src/components/layout/PageBody.ts";
import { DETAIL_PANEL_CLASS } from "../../src/components/layout/Panel.ts";
import { LiveCountRefresh } from "../../src/components/navigation/LiveCountRefresh.ts";
import { OverviewSignals } from "../../src/features/overview/OverviewSignals.ts";
import type { ControlApiConfig } from "../../src/lib/server/control-api.ts";
import { ConsolePageShell, readNodeContext } from "../_console.ts";
import { readOverview } from "./overview-reads.ts";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Overview" };

/**
Awaits the slow source reads so the landing content can stream first.
*/
async function OverviewSignalsSection({
  config
}: {
  readonly config: ControlApiConfig | null;
}): Promise<React.JSX.Element> {
  const data = await readOverview(config);
  return React.createElement(OverviewSignals, { data });
}

function OverviewSignalsLoading(): React.JSX.Element {
  return React.createElement(
    "p",
    {
      className: `${DETAIL_PANEL_CLASS} text-sm text-fg-secondary`,
      "aria-busy": "true",
      "data-overview-signals-loading": ""
    },
    "Reading live signals from the Runtime, providers, session rollouts and telemetry. No values are shown until each source reports."
  );
}

export default function OverviewPage(): React.JSX.Element {
  const { section, config } = readNodeContext("/overview");
  const signalsFallback = React.createElement(OverviewSignalsLoading);
  const signalsContent = React.createElement(OverviewSignalsSection, {
    config
  });
  const signalsSuspense = React.createElement(
    React.Suspense,
    { fallback: signalsFallback },
    signalsContent
  );

  return React.createElement(
    ConsolePageShell,
    { section },
    React.createElement(
      PageBody,
      { feature: "overview" },
      React.createElement(LiveCountRefresh),
      React.createElement(
        "p",
        {
          className: `${DETAIL_PANEL_CLASS} text-sm leading-6 text-fg-secondary`
        },
        "Live Runtime activity, provider verdicts, recent failures and recent telemetry, each read from its owning source."
      ),
      signalsSuspense
    )
  );
}
