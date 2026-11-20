import type { Metadata } from "next";
import React from "react";

import { NavigationLink } from "../../src/components/navigation/NavigationLink.ts";
import { PageBody } from "../../src/components/layout/PageBody.ts";
import { SECTION_HEADING_CLASS } from "../../src/components/layout/Heading.ts";
import { DETAIL_PANEL_CLASS } from "../../src/components/layout/Panel.ts";
import { MUTED_META_CLASS } from "../../src/components/ui/text-classes.ts";
import { CANONICAL_NAV_GROUPS } from "@simulatorlife/autodev-core";
import { ConsolePageShell, readNodeContext } from "../_console.ts";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Overview" };

export default function OverviewPage(): React.JSX.Element {
  const { section } = readNodeContext("/overview");

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
