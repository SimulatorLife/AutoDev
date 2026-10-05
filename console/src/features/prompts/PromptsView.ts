import type { PromptAsset } from "@simulatorlife/autodev-core";
import React from "react";

import { StatCard } from "../../components/cards/StatCard.ts";
import { ConsoleLink } from "../../components/navigation/ConsoleLink.ts";
import { StatusBadge } from "../../components/status/StatusBadge.ts";
import {
  type ColumnDef,
  DataTable
} from "../../components/tables/DataTable.ts";

export interface PromptsViewProps {
  readonly commands: readonly PromptAsset[];
  readonly commandSourceValidity: boolean | null;
}

export function PromptsView({
  commands,
  commandSourceValidity
}: PromptsViewProps): React.JSX.Element {
  const commandCount = commands.filter(
    (c) => c.kind === "command" || c.path.includes("commands")
  ).length;
  const rolePromptCount = commands.filter(
    (c) => c.kind === "role" || c.path.includes("roles")
  ).length;
  const canonicalPromptCount =
    commandSourceValidity === true
      ? commands.length
      : commandSourceValidity === false
        ? "Invalid"
        : "Not observed";
  const commandCountValue =
    commandSourceValidity === true
      ? commandCount
      : commandSourceValidity === false
        ? "Invalid"
        : "Not observed";
  const commandSourceNotice =
    commandSourceValidity === false
      ? "RuleSync `.rulesync/commands/` is invalid; slash-command results are unavailable."
      : commandSourceValidity === null
        ? "RuleSync `.rulesync/commands/` was not observed."
        : null;

  const columns: ColumnDef<PromptAsset>[] = [
    {
      id: "name",
      header: "Command / Prompt",
      cell: (prompt) =>
        React.createElement(
          ConsoleLink,
          {
            href: `/prompts/${encodeURIComponent(prompt.name)}`,
            className:
              "font-mono font-semibold text-fg underline-offset-4 hover:underline",
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
      wrap: true,
      cell: (prompt) =>
        React.createElement(
          "span",
          { className: "font-mono text-xs text-fg-muted" },
          prompt.path
        )
    },
    {
      id: "description",
      header: "Description",
      wrap: true,
      cell: (prompt) =>
        React.createElement(
          "span",
          { className: "text-xs text-fg-secondary" },
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
                ConsoleLink,
                {
                  href: `/agents/${encodeURIComponent(prompt.name)}`,
                  className: "text-accent hover:underline"
                },
                "Agent profile"
              )
            : null,
          React.createElement(
            ConsoleLink,
            {
              href: `/evaluations?prompt=${encodeURIComponent(prompt.name)}`,
              className: "text-fg-muted hover:underline"
            },
            "Evaluations"
          )
        );
      }
    }
  ];

  return React.createElement(
    "div",
    {
      className: "flex flex-col gap-6",
      "data-feature": "prompts",
      "data-prompt-command-source":
        commandSourceValidity === null
          ? "not-observed"
          : String(commandSourceValidity)
    },
    React.createElement(
      "div",
      { className: "grid grid-cols-1 gap-4 md:grid-cols-4" },
      React.createElement(StatCard, {
        title: "Canonical Prompts",
        value: canonicalPromptCount
      }),
      React.createElement(StatCard, {
        title: "RuleSync Commands",
        value: commandCountValue,
        subtitle: ".rulesync/commands"
      }),
      React.createElement(StatCard, {
        title: "Agent Role Prompts",
        value: rolePromptCount,
        subtitle: "agents/prompts/roles"
      }),
      React.createElement(StatCard, {
        title: "Authority",
        value: "Canonical files",
        subtitle: "RuleSync commands + role prompts"
      })
    ),
    React.createElement(
      "section",
      {
        className: "rounded-lg border border-border bg-surface p-5 shadow"
      },
      React.createElement(
        "h2",
        {
          className:
            "mb-3 text-sm font-semibold uppercase tracking-wider text-fg-muted"
        },
        "Available Prompts & Commands"
      ),
      commandSourceNotice
        ? React.createElement(
            "p",
            {
              className:
                commandSourceValidity === false
                  ? "mb-3 rounded border border-error/40 bg-error/10 p-3 text-sm text-error"
                  : "mb-3 rounded border border-warning/40 bg-warning/10 p-3 text-sm text-warning",
              role: commandSourceValidity === false ? "alert" : "status",
              "data-prompt-source-validity":
                commandSourceValidity === false ? "invalid" : "not-observed"
            },
            commandSourceNotice
          )
        : null,
      DataTable({
        data: commands,
        columns,
        keyExtractor: (prompt: PromptAsset) => prompt.path,
        emptyMessage:
          commandSourceValidity === false
            ? "No prompt entries are available while the canonical command source is invalid."
            : commandSourceValidity === null
              ? "The canonical command source has not been observed."
              : "No canonical prompts or commands are configured."
      })
    )
  );
}
