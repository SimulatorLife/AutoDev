import React from "react";

import type { HookDefinition } from "../../../../core/src/index.ts";
import { StatCard } from "../../components/cards/StatCard.ts";
import { StatusBadge } from "../../components/status/StatusBadge.ts";

export interface HooksViewProps {
  readonly hooks: readonly HookDefinition[];
}

export function HooksView({ hooks }: HooksViewProps): React.JSX.Element {
  const totalActions = hooks.reduce((acc, h) => acc + h.actions.length, 0);

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
        title: "Source",
        value: "RuleSync",
        subtitle: ".rulesync/hooks.jsonc"
      })
    ),
    React.createElement(
      "div",
      { className: "flex flex-col gap-4" },
      React.createElement(
        "h2",
        {
          className:
            "text-sm font-semibold uppercase tracking-wider text-slate-400"
        },
        "Configured Lifecycle Hooks"
      ),
      hooks.map((h) =>
        React.createElement(
          "div",
          {
            key: h.event,
            className:
              "bg-slate-900 border border-slate-800 rounded-lg p-5 flex flex-col gap-3 shadow"
          },
          React.createElement(
            "div",
            {
              className:
                "flex items-center justify-between border-b border-slate-800 pb-2"
            },
            React.createElement(
              "span",
              {
                className:
                  "font-mono font-semibold text-emerald-400 text-sm"
              },
              h.event
            ),
            React.createElement(StatusBadge, { status: "valid", label: "Valid" })
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
                    "bg-slate-950 p-3 rounded border border-slate-800/80 flex flex-col gap-1 text-xs font-mono"
                },
                React.createElement(
                  "div",
                  {
                    className:
                      "flex items-center justify-between text-slate-400"
                  },
                  React.createElement(
                    "span",
                    null,
                    "Matcher: ",
                    React.createElement(
                      "span",
                      { className: "text-amber-300" },
                      act.matcher ?? ".*"
                    )
                  ),
                  act.statusMessage
                    ? React.createElement(
                        "span",
                        { className: "text-slate-500 italic" },
                        act.statusMessage
                      )
                    : null
                ),
                React.createElement(
                  "div",
                  { className: "text-slate-200" },
                  React.createElement(
                    "span",
                    { className: "text-slate-500" },
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
