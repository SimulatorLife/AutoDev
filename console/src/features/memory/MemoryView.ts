import React, { useState } from "react";

import type { MemoryConnectorType, MemoryRecord } from "../../../../core/src/index.ts";
import { StatCard } from "../../components/cards/StatCard.ts";

export interface MemoryViewProps {
  readonly records?: readonly MemoryRecord[] | undefined;
  readonly connectors?: readonly MemoryConnectorType[] | undefined;
}

export function MemoryView({
  records = [],
  connectors = ["local", "sqlite"]
}: MemoryViewProps): React.JSX.Element {
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedConnector, setSelectedConnector] = useState<MemoryConnectorType>(
    connectors[0] ?? "local"
  );

  const filtered = records.filter((r) =>
    r.content.toLowerCase().includes(searchQuery.toLowerCase())
  );

  return React.createElement(
    "div",
    { className: "flex flex-col gap-6", "data-feature": "memory" },
    React.createElement(
      "div",
      { className: "grid grid-cols-1 md:grid-cols-3 gap-4" },
      React.createElement(StatCard, { title: "Memory Records", value: records.length }),
      React.createElement(StatCard, { title: "Active Connector", value: selectedConnector }),
      React.createElement(StatCard, {
        title: "Storage Scope",
        value: "AutoDev Local",
        subtitle: "No cloud tenancy"
      })
    ),
    React.createElement(
      "div",
      {
        className:
          "bg-slate-900 border border-slate-800 rounded-lg p-5 flex flex-col gap-4 shadow"
      },
      React.createElement(
        "div",
        {
          className:
            "flex flex-col sm:flex-row gap-3 items-center justify-between"
        },
        React.createElement("input", {
          type: "text",
          value: searchQuery,
          onChange: (e: React.ChangeEvent<HTMLInputElement>) =>
            setSearchQuery(e.target.value),
          placeholder: "Search memory records...",
          className:
            "w-full sm:w-80 bg-slate-950 border border-slate-800 rounded px-3 py-1.5 text-sm text-slate-200 placeholder-slate-500 focus:outline-none focus:border-emerald-500"
        }),
        React.createElement(
          "div",
          { className: "flex items-center gap-2" },
          React.createElement(
            "span",
            { className: "text-xs text-slate-400 font-medium" },
            "Connector:"
          ),
          React.createElement(
            "select",
            {
              value: selectedConnector,
              onChange: (e: React.ChangeEvent<HTMLSelectElement>) =>
                setSelectedConnector(e.target.value as MemoryConnectorType),
              className:
                "bg-slate-950 border border-slate-800 rounded px-2.5 py-1 text-xs text-slate-300 focus:outline-none focus:border-emerald-500"
            },
            connectors.map((c) =>
              React.createElement("option", { key: c, value: c }, c)
            )
          )
        )
      ),
      React.createElement(
        "div",
        { className: "flex flex-col gap-2 mt-2" },
        filtered.length === 0
          ? React.createElement(
              "div",
              { className: "p-8 text-center text-slate-500 text-sm" },
              "No memory records found."
            )
          : filtered.map((record) =>
              React.createElement(
                "div",
                {
                  key: record.id,
                  className:
                    "p-3 bg-slate-950 rounded border border-slate-800/80 flex flex-col gap-1 text-xs"
                },
                React.createElement(
                  "div",
                  {
                    className:
                      "flex items-center justify-between text-slate-500 font-mono text-[11px]"
                  },
                  React.createElement("span", null, `ID: ${record.id}`),
                  React.createElement("span", null, record.createdAt)
                ),
                React.createElement(
                  "p",
                  { className: "text-slate-300 whitespace-pre-wrap mt-1" },
                  record.content
                )
              )
            )
      )
    )
  );
}
