import React from "react";

import type { SkillDefinition, SkillEligibility } from "../../../../core/src/index.ts";
import { StatCard } from "../../components/cards/StatCard.ts";
import { StatusBadge } from "../../components/status/StatusBadge.ts";
import { type ColumnDef, DataTable } from "../../components/tables/DataTable.ts";

export interface SkillsViewProps {
  readonly skills: readonly SkillDefinition[];
  readonly eligibility?: readonly SkillEligibility[];
}

export function SkillsView({
  skills,
  eligibility = []
}: SkillsViewProps): React.JSX.Element {
  const columns: ColumnDef<SkillDefinition>[] = [
    {
      id: "name",
      header: "Skill Name",
      cell: (skill) =>
        React.createElement(
          "div",
          null,
          React.createElement(
            "span",
            { className: "font-semibold text-slate-100 font-mono" },
            skill.name
          ),
          React.createElement(
            "p",
            { className: "text-xs text-slate-400 mt-0.5" },
            skill.description
          )
        )
    },
    {
      id: "path",
      header: "Path",
      cell: (skill) =>
        React.createElement(
          "span",
          { className: "text-xs font-mono text-slate-400" },
          skill.path
        )
    },
    {
      id: "eligibleRoles",
      header: "Eligible Roles",
      cell: (skill) => {
        const item = eligibility.find((e) => e.skill === skill.name);
        const roles = item?.roles ?? [];
        if (roles.length === 0) {
          return React.createElement(
            "span",
            { className: "text-xs text-slate-500" },
            "Universal / All"
          );
        }
        return React.createElement(
          "div",
          { className: "flex flex-wrap gap-1" },
          roles.map((r) =>
            React.createElement(
              "span",
              {
                key: r,
                className:
                  "text-xs bg-slate-800 text-slate-300 px-2 py-0.5 rounded border border-slate-700"
              },
              r
            )
          )
        );
      }
    },
    {
      id: "status",
      header: "Status",
      cell: () =>
        React.createElement(StatusBadge, {
          status: "configured",
          label: "Configured"
        })
    }
  ];

  return React.createElement(
    "div",
    { className: "flex flex-col gap-6", "data-feature": "skills" },
    React.createElement(
      "div",
      { className: "grid grid-cols-1 md:grid-cols-4 gap-4" },
      React.createElement(StatCard, {
        title: "Configured",
        value: skills.length
      }),
      React.createElement(StatCard, {
        title: "Eligible",
        value: skills.length,
        subtitle: "Role-assigned"
      }),
      React.createElement(StatCard, {
        title: "Observed Exposure",
        value: "Active",
        subtitle: "Via OTel"
      }),
      React.createElement(StatCard, {
        title: "Usage Evidence",
        value: "Recorded",
        subtitle: "skill_used events"
      })
    ),
    React.createElement(
      "div",
      null,
      React.createElement(
        "h2",
        {
          className:
            "text-sm font-semibold uppercase tracking-wider text-slate-400 mb-3"
        },
        "Agent Skills"
      ),
      DataTable({
        data: skills,
        columns,
        keyExtractor: (s: SkillDefinition) => s.name
      })
    )
  );
}
