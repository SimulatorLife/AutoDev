import type { HookDefinition } from "@simulatorlife/autodev-core";
import React from "react";

import { StatCard } from "../../components/cards/StatCard.ts";
import { SECTION_HEADING_CLASS } from "../../components/layout/Heading.ts";
import { LIST_PANEL_CLASS } from "../../components/layout/Panel.ts";

export interface HooksViewProps {
  readonly hooks: readonly HookDefinition[];
  readonly sourceValidity?: boolean | null | undefined;
}

export function HooksView({
  hooks,
  sourceValidity = null
}: HooksViewProps): React.JSX.Element {
  const totalActions = hooks.reduce((acc, h) => acc + h.actions.length, 0);
  const validityLabel =
    sourceValidity === null
      ? "Not observed"
      : sourceValidity
        ? "Valid"
        : "Invalid";

  return React.createElement(
    "div",
    { className: "flex flex-col gap-6", "data-feature": "hooks" },
    React.createElement(
      "div",
      { className: "grid grid-cols-1 md:grid-cols-3 gap-4" },
      React.createElement(StatCard, {
        title: "Hook Events",
        value: hooks.length
      }),
      React.createElement(StatCard, {
        title: "Total Handlers",
        value: totalActions
      }),
      React.createElement(StatCard, {
        title: "Source validation",
        value: validityLabel,
        subtitle: ".rulesync/hooks.jsonc"
      })
    ),
    React.createElement(
      "div",
      { className: "flex flex-col gap-4" },
      React.createElement(
        "h2",
        {
          className: SECTION_HEADING_CLASS
        },
        "Configured Lifecycle Hooks"
      ),
      hooks.length === 0
        ? React.createElement(
            "p",
            {
              className: `${LIST_PANEL_CLASS} text-sm text-fg-muted`,
              "data-hook-state":
                sourceValidity === null
                  ? "not-observed"
                  : sourceValidity
                    ? "empty"
                    : "invalid"
            },
            sourceValidity === null
              ? "Hook source not observed."
              : sourceValidity
                ? "No hook actions configured."
                : "Hook source is invalid; actions are not shown."
          )
        : hooks.map((h) =>
            React.createElement(
              "div",
              {
                key: h.event,
                className:
                  "bg-surface border border-border rounded-lg p-5 flex flex-col gap-3 shadow"
              },
              React.createElement(
                "div",
                {
                  className:
                    "flex items-center justify-between border-b border-border pb-2"
                },
                React.createElement(
                  "span",
                  {
                    className: "font-mono font-semibold text-fg text-sm"
                  },
                  h.event
                )
              ),
              React.createElement(
                "div",
                { className: "flex flex-col gap-2" },
                h.actions.map((act, index) =>
                  React.createElement(
                    "div",
                    {
                      key: index,
                      className:
                        "bg-background p-3 rounded border border-border/80 flex flex-col gap-1 text-xs font-mono"
                    },
                    React.createElement(
                      "div",
                      {
                        className:
                          "flex items-center justify-between text-fg-muted"
                      },
                      React.createElement(
                        "span",
                        null,
                        "Matcher: ",
                        React.createElement(
                          "span",
                          { className: "text-warning" },
                          act.matcher ?? ".*"
                        )
                      ),
                      act.statusMessage
                        ? React.createElement(
                            "span",
                            { className: "text-fg-muted italic" },
                            act.statusMessage
                          )
                        : null
                    ),
                    React.createElement(
                      "div",
                      { className: "text-fg" },
                      React.createElement(
                        "span",
                        { className: "text-fg-muted" },
                        "$ "
                      ),
                      act.command
                    )
                  )
                )
              )
            )
          )
    )
  );
}
