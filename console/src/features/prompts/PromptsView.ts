import React, { useState } from "react";

import type { PromptAsset } from "../../../../core/src/index.ts";
import { StatCard } from "../../components/cards/StatCard.ts";
import { type ColumnDef, DataTable } from "../../components/tables/DataTable.ts";

export interface PromptsViewProps {
  readonly commands: readonly PromptAsset[];
}

export function PromptsView({ commands }: PromptsViewProps): React.JSX.Element {
  const [selectedPromptName, setSelectedPromptName] = useState<string | null>(
    commands[0]?.name ?? null
  );

  const selected = commands.find((c) => c.name === selectedPromptName);

  const columns: ColumnDef<PromptAsset>[] = [
    {
      id: "name",
      header: "Command / Prompt",
      cell: (cmd) =>
        React.createElement(
          "span",
          { className: "font-semibold text-slate-100 font-mono" },
          `/${cmd.name}`
        )
    },
    {
      id: "path",
      header: "Canonical Source",
      cell: (cmd) =>
        React.createElement(
          "span",
          { className: "text-xs font-mono text-slate-400" },
          cmd.path
        )
    },
    {
      id: "description",
      header: "Description",
      cell: (cmd) =>
        React.createElement(
          "span",
          { className: "text-xs text-slate-300" },
          cmd.description
        )
    }
  ];

  return React.createElement(
    "div",
    { className: "flex flex-col gap-6", "data-feature": "prompts" },
    React.createElement(
      "div",
      { className: "grid grid-cols-1 md:grid-cols-3 gap-4" },
      React.createElement(StatCard, { title: "Canonical Prompts", value: commands.length }),
      React.createElement(StatCard, {
        title: "Authority",
        value: "RuleSync",
        subtitle: ".rulesync/commands"
      }),
      React.createElement(StatCard, {
        title: "Sync Status",
        value: "Deterministic",
        subtitle: "Lossless round-trip"
      })
    ),
    React.createElement(
      "div",
      { className: "grid grid-cols-1 lg:grid-cols-2 gap-6" },
      React.createElement(
        "div",
        null,
        React.createElement(
          "h2",
          {
            className:
              "text-sm font-semibold uppercase tracking-wider text-slate-400 mb-3"
          },
          "Available Prompts & Commands"
        ),
        DataTable({
          data: commands,
          columns,
          keyExtractor: (c: PromptAsset) => c.name,
          onRowClick: (c: PromptAsset) => setSelectedPromptName(c.name)
        })
      ),
      React.createElement(
        "div",
        {
          className:
            "bg-slate-900 border border-slate-800 rounded-lg p-5 flex flex-col gap-4 shadow"
        },
        selected
          ? React.createElement(
              "div",
              { className: "flex flex-col gap-3" },
              React.createElement(
                "div",
                {
                  className:
                    "flex items-center justify-between border-b border-slate-800 pb-2"
                },
                React.createElement(
                  "span",
                  { className: "font-mono font-bold text-slate-100 text-sm" },
                  `/${selected.name}`
                ),
                React.createElement(
                  "span",
                  { className: "text-xs text-slate-500 font-mono" },
                  selected.path
                )
              ),
              React.createElement(
                "h4",
                { className: "text-xs font-semibold uppercase text-slate-400" },
                "Prompt Preview"
              ),
              React.createElement(
                "pre",
                {
                  className:
                    "text-xs font-mono bg-slate-950 p-4 rounded border border-slate-800 text-slate-300 overflow-y-auto max-h-[500px] whitespace-pre-wrap"
                },
                selected.content || `# ${selected.name}\n\n${selected.description}`
              )
            )
          : React.createElement(
              "div",
              { className: "text-center text-slate-500 py-16" },
              "Select a command to preview"
            )
      )
    )
  );
}
