import type {
  PromptAsset,
  RuleSyncValidationIssue
} from "@simulatorlife/autodev-core";
import React from "react";

import { StatCard } from "../../components/cards/StatCard.ts";
import {
  CALLOUT_ERROR_CLASS,
  CALLOUT_WARNING_CLASS
} from "../../components/layout/Callout.ts";
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
import {
  ENTITY_LINK_CLASS,
  MUTED_TEXT_CLASS
} from "../../components/ui/text-classes.ts";

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
      // The row's primary key, and the one thing on this page that cannot wrap:
      // `/composition-over-inheritance` is a single token with no separator the
      // browser may break at, and the target state forbids breaking discrete
      // content mid-token. It measures 245px, so 277 with the cell's own 32px of
      // padding is the floor. At 208 the cell granted 186px and cut five command
      // names -- including two by more than 50px.
      weight: 264,
      cell: (prompt) =>
        React.createElement(
          "a",
          {
            href: `/prompts/${encodeURIComponent(prompt.name)}`,
            className: `block min-h-6 font-mono font-semibold text-fg ${ENTITY_LINK_CLASS}`,
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
      // rows. A header-width check cannot see this: "Type" is short. "Role
      // prompt" measures 121px as a pill, so 153px of column is the floor, and
      // that is 4px above the header this column would otherwise be sized for.
      weight: 150,
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
      // Sized for its own header rather than its content. `PathText` declares
      // break opportunities with `<wbr>`, so the path wraps between segments and
      // no segment has to fit the column -- which is what makes this the one
      // column on the page that can be sized from a header alone. `.rulesync/`
      // is the constant leading segment and `SKILL.md`-style tails are constant
      // per kind; the varying middle is exactly the part a wrap keeps whole.
      weight: 170,
      cell: (prompt) => React.createElement(PathText, { path: prompt.path })
    },
    {
      id: "description",
      header: "Description",
      align: "prose",
      clampLines: 2,
      // Takes the remainder, because it is the one column on this page whose
      // content is already bounded: a clamped description discards its tail by
      // design, so widening it costs height the operator chose and narrowing it
      // costs rows. Every other column here has to clear a measured width.
      weight: 290,
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
      // Sized for its widest single chip. "Evaluations" is 91px and the chips
      // wrap between items, which is the target state's rule for discrete cell
      // content -- so this is the second column here that can be sized from its
      // content without a wrap being needed.
      weight: 152,
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
        className: LIST_PANEL_CLASS,
        "data-section": "prompts-catalog"
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
              // These were quoted as `` "`${CALLOUT_ERROR_CLASS} mb-3`" `` --
              // a template literal wrapped in a plain string, with the
              // constants never imported at all. The notice rendered its text
              // and its role, and a class attribute reading
              // `class="${CALLOUT_ERROR_CLASS} mb-3"`, so an operator looking
              // at an invalid RuleSync command source saw unstyled prose where
              // every other failure state on the Console is a toned callout.
              // Nothing caught it because the branch only runs when the command
              // source is invalid or unobserved, and this page is valid.
              className:
                commandSourceValidity === false
                  ? `${CALLOUT_ERROR_CLASS} mb-3`
                  : `${CALLOUT_WARNING_CLASS} mb-3`,
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
