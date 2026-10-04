import type { PromptAsset } from "@simulatorlife/autodev-core";
import React from "react";

import { StatCard } from "../../components/cards/StatCard.ts";
import { StatusBadge } from "../../components/status/StatusBadge.ts";
import {
  type ColumnDef,
  DataTable
} from "../../components/tables/DataTable.ts";

export interface PromptsViewProps {
  readonly commands: readonly PromptAsset[];
}

export function PromptsView({ commands }: PromptsViewProps): React.JSX.Element {
  const commandCount = commands.filter(
    (c) => c.kind === "command" || c.path.includes("commands")
  ).length;
  const rolePromptCount = commands.filter(
    (c) => c.kind === "role" || c.path.includes("roles")
  ).length;

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
          prompt.kind === "role" || prompt.path.includes("roles")
            ? prompt.name
            : `/${prompt.name}`
        )
    },
    {
      id: "kind",
      header: "Type",
      cell: (prompt) => {
        const isRole = prompt.kind === "role" || prompt.path.includes("roles");
        return React.createElement(StatusBadge, {
          status: "configured",
          label: isRole ? "Role prompt" : "Command"
        });
      }
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
    },
    {
      id: "related",
      header: "Related",
      cell: (prompt) => {
        const isRole = prompt.kind === "role" || prompt.path.includes("roles");
        return React.createElement(
          "div",
          { className: "flex flex-wrap gap-2 text-xs" },
          isRole
            ? React.createElement(
                "a",
                {
                  href: `/agents/${encodeURIComponent(prompt.name)}`,
                  className: "text-emerald-400 hover:underline"
                },
                "Agent profile"
              )
            : null,
          React.createElement(
            "a",
            {
              href: `/evaluations?prompt=${encodeURIComponent(prompt.name)}`,
              className: "text-slate-400 hover:underline"
            },
            "Evaluations"
          )
        );
      }
    }
  ];

  return React.createElement(
    "div",
    { className: "flex flex-col gap-6", "data-feature": "prompts" },
    React.createElement(
      "div",
      { className: "grid grid-cols-1 gap-4 md:grid-cols-4" },
      React.createElement(StatCard, {
        title: "Canonical Prompts",
        value: commands.length
      }),
      React.createElement(StatCard, {
        title: "RuleSync Commands",
        value: commandCount,
        subtitle: ".rulesync/commands"
      }),
      React.createElement(StatCard, {
        title: "Agent Role Prompts",
        value: rolePromptCount,
        subtitle: "agents/prompts/roles"
      }),
      React.createElement(StatCard, {
        title: "Authority",
        value: "RuleSync",
        subtitle: "Working-tree Markdown files"
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
