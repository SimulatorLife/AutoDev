import type { MemoryRecord } from "@simulatorlife/autodev-core";
import React from "react";

import { StatCard } from "../../components/cards/StatCard.ts";

export interface MemoryViewProps {
  readonly records?: readonly MemoryRecord[] | null | undefined;
}

export function MemoryView({ records }: MemoryViewProps): React.JSX.Element {
  const observed = records !== null && records !== undefined;
  const availableRecords = records ?? [];

  return React.createElement(
    "div",
    { className: "flex flex-col gap-6", "data-feature": "memory" },
    React.createElement(
      "div",
      { className: "grid grid-cols-1 gap-4 md:grid-cols-3" },
      React.createElement(StatCard, {
        title: "Memory Records",
        value: observed ? availableRecords.length : "Not observed"
      }),
      React.createElement(StatCard, {
        title: "Connector",
        value: "Not observed",
        subtitle: "Connector integration is not wired"
      }),
      React.createElement(StatCard, {
        title: "Scope",
        value: "Per-record",
        subtitle: "Workspace and agent scope are shown with each record"
      })
    ),
    React.createElement(
      "section",
      {
        className:
          "flex flex-col gap-4 rounded-lg border border-slate-800 bg-slate-900 p-5 shadow",
        "aria-label": "Memory records"
      },
      observed
        ? availableRecords.length === 0
          ? React.createElement(
              "p",
              {
                className: "p-8 text-center text-sm text-slate-500",
                "data-memory-state": "empty"
              },
              "No memory records found."
            )
          : availableRecords.map((record) =>
              React.createElement(
                "article",
                {
                  key: record.id,
                  className:
                    "flex flex-col gap-2 rounded border border-slate-800 bg-slate-950 p-4",
                  "data-memory-id": record.id
                },
                React.createElement(
                  "div",
                  {
                    className:
                      "flex flex-wrap items-center justify-between gap-2"
                  },
                  React.createElement(
                    "h3",
                    { className: "font-medium text-slate-200" },
                    record.claim
                  ),
                  React.createElement(
                    "span",
                    { className: "font-mono text-xs text-slate-400" },
                    `${record.kind} · ${record.status}`
                  )
                ),
                React.createElement(
                  "p",
                  { className: "font-mono text-xs text-slate-500" },
                  `Scope: ${record.scope.kind}`
                ),
                React.createElement(
                  "p",
                  { className: "text-xs text-slate-500" },
                  `${record.provenance.experienceIds.length} provenance experiences`
                )
              )
            )
        : React.createElement(
            "p",
            {
              className: "p-8 text-center text-sm text-slate-400",
              "data-memory-state": "not-observed"
            },
            "Memory records are not observed because no connector adapter is configured."
          )
    )
  );
}
