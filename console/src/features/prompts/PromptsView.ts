import type { PromptAsset } from "@simulatorlife/autodev-core";
import React from "react";

import { StatCard } from "../../components/cards/StatCard.ts";
import {
  type ColumnDef,
  DataTable
} from "../../components/tables/DataTable.ts";

export interface PromptsViewProps {
  readonly commands: readonly PromptAsset[];
}

export function PromptsView({ commands }: PromptsViewProps): React.JSX.Element {
  const columns: ColumnDef<PromptAsset>[] = [
    {
      id: "name",
      header: "Command / Prompt",
      cell: (prompt) =>
        React.createElement(
          "a",
          {
            href: `/prompts/${encodeURIComponent(prompt.name)}`,
            className:
              "font-mono font-semibold text-slate-100 underline-offset-4 hover:underline",
            "aria-label": `Open prompt ${prompt.name}`
          },
          `/${prompt.name}`
        )
    },
    {
      id: "path",
      header: "Canonical Source",
      cell: (prompt) =>
        React.createElement(
          "span",
          { className: "font-mono text-xs text-slate-400" },
          prompt.path
        )
    },
    {
      id: "description",
      header: "Description",
      cell: (prompt) =>
        React.createElement(
          "span",
          { className: "text-xs text-slate-300" },
          prompt.description ?? "Description not provided"
        )
    }
  ];

  return React.createElement(
    "div",
    { className: "flex flex-col gap-6", "data-feature": "prompts" },
    React.createElement(
      "div",
      { className: "grid grid-cols-1 gap-4 md:grid-cols-3" },
      React.createElement(StatCard, {
        title: "Canonical Prompts",
        value: commands.length
      }),
      React.createElement(StatCard, {
        title: "Current sources",
        value: "Commands + role prompts",
        subtitle: "Canonical paths are shown per resource"
      }),
      React.createElement(StatCard, {
        title: "Editing and Apply",
        value: "Unavailable",
        subtitle: "Control API mutation flow not implemented"
      })
    ),
    React.createElement(
      "section",
      {
        className: "rounded-lg border border-slate-800 bg-slate-900 p-5 shadow"
      },
      React.createElement(
        "h2",
        {
          className:
            "mb-3 text-sm font-semibold uppercase tracking-wider text-slate-400"
        },
        "Available Prompts & Commands"
      ),
      DataTable({
        data: commands,
        columns,
        keyExtractor: (prompt: PromptAsset) => prompt.path
      })
    )
  );
}
