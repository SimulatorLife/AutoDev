import { CANONICAL_NAV_GROUPS } from "@simulatorlife/autodev-core";
import type { Metadata } from "next";
import React from "react";

import { SECTION_HEADING_CLASS } from "../../src/components/layout/Heading.ts";
import { PageBody } from "../../src/components/layout/PageBody.ts";
import { DETAIL_PANEL_CLASS } from "../../src/components/layout/Panel.ts";
import { NavigationLink } from "../../src/components/navigation/NavigationLink.ts";
import { MUTED_META_CLASS } from "../../src/components/ui/text-classes.ts";
import { OverviewSignals } from "../../src/features/overview/OverviewSignals.ts";
import type { ControlApiConfig } from "../../src/lib/server/control-api.ts";
import { ConsolePageShell, readNodeContext } from "../_console.ts";
import { readOverview } from "./overview-reads.ts";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Overview" };

/** Awaits the slow source reads so the landing content can stream first. */
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

  return React.createElement(
    ConsolePageShell,
    { section },
    React.createElement(
      PageBody,
      { feature: "overview" },
      React.createElement(
        "p",
        {
          className: `${DETAIL_PANEL_CLASS} text-sm leading-6 text-fg-secondary`
        },
        "Configure AutoDev resources, inspect observed activity, and manage the workspaces and workflows that run your agents. Choose a resource below to get started."
      ),
      React.createElement(
        React.Suspense,
        { fallback: React.createElement(OverviewSignalsLoading) },
        React.createElement(OverviewSignalsSection, { config })
      ),
      CANONICAL_NAV_GROUPS.map((group) =>
        React.createElement(
          "section",
          { key: group.id, "aria-labelledby": `overview-${group.id}` },
          React.createElement(
            "h2",
            {
              id: `overview-${group.id}`,
              className: SECTION_HEADING_CLASS
            },
            group.label
          ),
          React.createElement(
            "ul",
            {
              className:
                "grid list-none grid-cols-1 gap-3 p-0 sm:grid-cols-2 xl:grid-cols-3"
            },
            group.sections
              .filter((destination) => destination !== "Overview")
              .map((destination) =>
                React.createElement(
                  "li",
                  {
                    key: destination,
                    className: `${DETAIL_PANEL_CLASS} min-w-0`
                  },
                  React.createElement(
                    NavigationLink,
                    {
                      href: `/${destination.toLowerCase()}`,
                      className:
                        "font-semibold text-fg underline decoration-border underline-offset-4 hover:decoration-fg"
                    },
                    destination
                  ),
                  React.createElement(
                    "p",
                    { className: `${MUTED_META_CLASS} mt-2` },
                    group.id === "Configure"
                      ? "Configure a canonical AutoDev resource."
                      : group.id === "Observe"
                        ? "Inspect observed activity and outcomes."
                        : "Manage workspaces and operator workflows."
                  )
                )
              )
          )
        )
      )
    )
  );
}
