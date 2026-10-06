import type {
  SkillDefinition,
  SkillEligibility
} from "@simulatorlife/autodev-core";
import React from "react";

import { StatCard } from "../../components/cards/StatCard.ts";
import {
  CALLOUT_ERROR_CLASS,
  CALLOUT_WARNING_CLASS
} from "../../components/layout/Callout.ts";
import { SECTION_HEADING_CLASS } from "../../components/layout/Heading.ts";
import { PageBody } from "../../components/layout/PageBody.ts";
import { StatGrid } from "../../components/panels/DetailGrid.ts";
import { StatusBadge } from "../../components/status/StatusBadge.ts";
import { chipList } from "../../components/tables/Chips.ts";
import {
  type ColumnDef,
  DataTable,
  type DataTableProps
} from "../../components/tables/DataTable.ts";

/**
 * Skills resource view.
 *
 * Configuration vs. runtime evidence are separate concerns. A configured
 * skill is only that: configured and possibly eligible. Whether it was
 * exposed, selected, or used must come from runtime telemetry; until the OTel
 * skill exposure/use adapter exists, those values remain `Unknown`.
 */

export interface SkillsViewProps {
  readonly skills: readonly SkillDefinition[];
  readonly eligibility: readonly SkillEligibility[];
  readonly unresolvedAssignments: readonly SkillEligibility[];
  readonly sourceValidity: boolean | null;
}

export function SkillsView({
  skills,
  eligibility,
  unresolvedAssignments,
  sourceValidity
}: SkillsViewProps): React.JSX.Element {
  const catalogNames = new Set(skills.map((skill) => skill.name));
  const eligibleSkills = new Set(
    eligibility
      .filter((item) => item.roles.length > 0 && catalogNames.has(item.skill))
      .map((item) => item.skill)
  );
  const configuredCount =
    sourceValidity === true
      ? skills.length
      : sourceValidity === false
        ? "Invalid"
        : "Not observed";
  const assignedCount =
    sourceValidity === true ? eligibleSkills.size : "Not observed";
  const emptyMessage =
    sourceValidity === false
      ? "RuleSync `.rulesync/skills/` is invalid; no catalog was projected."
      : sourceValidity === null
        ? "RuleSync `.rulesync/skills/` was not observed."
        : "No skills configured in RuleSync `.rulesync/skills/`.";

  const columns: ColumnDef<SkillDefinition>[] = [
    {
      id: "name",
      header: "Skill Name",
      weight: 384,
      // The description below is prose that must wrap inside the column, so
      // this cell opts out of the default single-line truncation.
      align: "prose",
      cell: (skill) =>
        React.createElement(
          "div",
          { className: "min-w-0" },
          React.createElement(
            "span",
            {
              className: "block font-mono font-semibold text-fg truncate",
              // The skill name is the row's identity and the shortest thing
              // that distinguishes one row from another, so the ellipsis has
              // to stay recoverable.
              title: skill.name
            },
            skill.name
          ),
          React.createElement(
            "p",
            {
              className: "mt-0.5 line-clamp-2 text-xs text-fg-muted",
              title: skill.description
            },
            skill.description
          )
        )
    },
    {
      id: "path",
      header: "Path",
      weight: 288,
      cell: (skill) => {
        // A truncated head (".rulesync/skills/autodev-code…") hides the part
        // that distinguishes one skill from another, so the column keeps the
        // leading root for context and always renders the trailing segments.
        const segments = skill.path.split("/");
        const root = segments[0] ?? "";
        const tail = segments.slice(-2).join("/");
        const shorthand =
          segments.length > 2 ? `${root}/…/${tail}` : skill.path;
        return React.createElement(
          "span",
          {
            className: "block truncate font-mono text-xs text-fg-muted",
            title: skill.path
          },
          shorthand
        );
      }
    },
    {
      id: "eligibleRoles",
      header: "Eligible Roles",
      align: "tokens",
      cell: (skill) => {
        const item = eligibility.find((e) => e.skill === skill.name);
        return chipList({
          items: item?.roles ?? [],
          emptyLabel: item === undefined ? "Not observed" : "No roles assigned",
          testId: "skill-roles"
        });
      }
    },
    {
      id: "status",
      header: "State",
      // Sized for the badge. Declared no weight at all, so this column took the
      // 100-unit default and clipped "Configured" at its last glyph.
      weight: 116,
      cell: () =>
        React.createElement(StatusBadge, {
          status: "configured",
          label: "Configured"
        })
    }
  ];

  return React.createElement(
    PageBody,
    {
      feature: "skills",
      attributes: {
        "data-skill-runtime-observed": "false",
        "data-skill-source-validity":
          sourceValidity === null ? "not-observed" : String(sourceValidity)
      }
    },
    sourceValidity === false
      ? React.createElement(
          "p",
          {
            className: CALLOUT_ERROR_CLASS,
            role: "alert"
          },
          "RuleSync `.rulesync/skills/` is invalid; catalog contents are unavailable."
        )
      : sourceValidity === null
        ? React.createElement(
            "p",
            {
              className: CALLOUT_WARNING_CLASS,
              role: "status"
            },
            "RuleSync `.rulesync/skills/` has not been observed."
          )
        : null,
    React.createElement(
      StatGrid,
      { columns: 4 },
      React.createElement(StatCard, {
        title: "Configured",
        value: configuredCount
      }),
      React.createElement(StatCard, {
        title: "Role-assigned",
        value: assignedCount,
        ...(sourceValidity === true
          ? { subtitle: `of ${skills.length} configured` }
          : {})
      }),
      React.createElement(StatCard, {
        title: "Observed Exposure",
        value: "Unknown",
        subtitle: "Awaiting OTel evidence"
      }),
      React.createElement(StatCard, {
        title: "Usage Evidence",
        value: "Unknown",
        subtitle: "skill_used events not wired"
      })
    ),
    unresolvedAssignments.length > 0
      ? React.createElement(
          "section",
          {
            className: CALLOUT_WARNING_CLASS,
            role: "alert",
            "data-unresolved-skill-assignments": unresolvedAssignments.length
          },
          React.createElement(
            "h2",
            { className: "font-semibold" },
            "Unresolved role assignments"
          ),
          React.createElement(
            "p",
            { className: "mt-1 text-xs" },
            "The execution contract assigns these skills, but no canonical RuleSync skill source exists:"
          ),
          React.createElement(
            "ul",
            { className: "mt-2 flex flex-col gap-1" },
            unresolvedAssignments.map((item) =>
              React.createElement(
                "li",
                { key: item.skill },
                React.createElement(StatusBadge, {
                  status: "invalid",
                  label: item.skill
                }),
                React.createElement(
                  "span",
                  { className: "ml-2 text-xs" },
                  `Assigned to: ${item.roles.join(", ")}`
                )
              )
            )
          )
        )
      : null,
    React.createElement(
      "div",
      null,
      React.createElement(
        "h2",
        {
          className: SECTION_HEADING_CLASS
        },
        "Agent Skills"
      ),
      React.createElement<DataTableProps<SkillDefinition>>(DataTable, {
        data: skills,
        columns,
        keyExtractor: (s: SkillDefinition) => s.name,
        emptyMessage
      })
    )
  );
}
