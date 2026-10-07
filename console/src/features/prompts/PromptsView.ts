import type {
  PromptAsset,
  RuleSyncValidationIssue} from "@simulatorlife/autodev-core";
import React from "react";

import { StatCard } from "../../components/cards/StatCard.ts";
import { SECTION_HEADING_CLASS } from "../../components/layout/Heading.ts";
import { PageBody } from "../../components/layout/PageBody.ts";
import { LIST_PANEL_CLASS } from "../../components/layout/Panel.ts";
import { StatGrid } from "../../components/panels/DetailGrid.ts";
import { SourceValidationIssues } from "../../components/status/SourceValidationIssues.ts";
import {
  NOT_OBSERVED_LABEL,
  StatusBadge
} from "../../components/status/StatusBadge.ts";
import { Chip } from "../../components/tables/Chips.ts";
import {
  type ColumnDef,
  DataTable,
  type DataTableProps
} from "../../components/tables/DataTable.ts";
import { PathText } from "../../components/tables/PathText.ts";
import { MUTED_TEXT_CLASS } from "../../components/ui/text-classes.ts";

export interface PromptsViewProps {
  readonly commands: readonly PromptAsset[];
  readonly commandSourceValidity: boolean | null;
  /**
   * Why the catalog is invalid.
   *
   * Required rather than defaulted to `[]`: an invalid catalog renders an
   * empty command list, so without the reasons the page says "no commands"
   * for a directory that holds several and cannot apply them.
   */
  readonly validationIssues: readonly RuleSyncValidationIssue[];
}

export function PromptsView({
  commands,
  validationIssues,
  commandSourceValidity
}: PromptsViewProps): React.JSX.Element {
  const sourceIssues = React.createElement(SourceValidationIssues, {
    issues: validationIssues,
    testId: "command-validation-issues",
    subject: "Command catalog"
  });
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
        : NOT_OBSERVED_LABEL;
  const commandCountValue =
    commandSourceValidity === true
      ? commandCount
      : commandSourceValidity === false
        ? "Invalid"
        : NOT_OBSERVED_LABEL;
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
      weight: 208,
      cell: (prompt) =>
        React.createElement(
          "a",
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
      // Sized against the pill, not the word. A `StatusBadge` is the widest thing
      // in this column by a wide margin -- status dot, rounded padding and all
      // -- and at 96 the cell cut it to "Comman" on every one of the 63 command
      // rows. A header-width check cannot see this: "Type" is short. The width
      // is a share of the whole table rather than a pixel count, so it is sized
      // against the table's 864px floor rather than against the viewport it was
      // measured at: "Role prompt" is a 105px pill and needs 137px of column.
      weight: 163,
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
      align: "path",
      weight: 208,
      cell: (prompt) => React.createElement(PathText, { path: prompt.path })
    },
    {
      id: "description",
      header: "Description",
      align: "prose",
      clampLines: 2,
      // Gives the share the Type column needs for its pill. A clamped
      // description is the cheapest column to narrow on this page: it already
      // discards its tail by design, and the command name beside it is the
      // row's primary key.
      weight: 287,
      cell: (prompt) => {
        const description = prompt.description;
        return React.createElement(
          "span",
          {
            className: "text-xs text-fg-secondary",
            title: description ?? undefined
          },
          description ?? "Description not provided"
        );
      }
    },
    {
      id: "related",
      header: "Related",
      align: "tokens",
      weight: 160,
      cell: (prompt) => {
        const isRole = prompt.kind === "role" || prompt.path.includes("roles");
        return React.createElement(
          "div",
          { className: "flex flex-wrap items-center gap-1" },
          isRole
            ? React.createElement(
                Chip,
                {
                  href: `/agents/${encodeURIComponent(prompt.name)}`,
                  className: "text-accent"
                },
                "Agent profile"
              )
            : null,
          React.createElement(
            Chip,
            {
              href: `/evaluations?prompt=${encodeURIComponent(prompt.name)}`,
              className: MUTED_TEXT_CLASS
            },
            "Evaluations"
          )
        );
      }
    }
  ];

  return React.createElement(
    PageBody,
    {
      feature: "prompts",
      attributes: {
        "data-prompt-command-source":
          commandSourceValidity === null
            ? "not-observed"
            : String(commandSourceValidity)
      }
    },
    sourceIssues,
    React.createElement(
      StatGrid,
      { columns: 4 },
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
        className: LIST_PANEL_CLASS
      },
      React.createElement(
        "h2",
        {
          className: SECTION_HEADING_CLASS
        },
        "Available Prompts & Commands"
      ),
      commandSourceNotice
        ? React.createElement(
            "p",
            {
              className:
                commandSourceValidity === false
                  ? "`${CALLOUT_ERROR_CLASS} mb-3`"
                  : "`${CALLOUT_WARNING_CLASS} mb-3`",
              role: commandSourceValidity === false ? "alert" : "status",
              "data-prompt-source-validity":
                commandSourceValidity === false ? "invalid" : "not-observed"
            },
            commandSourceNotice
          )
        : null,
      React.createElement<DataTableProps<PromptAsset>>(DataTable, {
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
