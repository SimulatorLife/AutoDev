import type {
  SkillDefinition,
  SkillEligibility
} from "@simulatorlife/autodev-core";
import React from "react";

import { StatCard } from "../../components/cards/StatCard.ts";
import { StatusBadge } from "../../components/status/StatusBadge.ts";
import {
  type ColumnDef,
  DataTable
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
      wrap: true,
      cell: (skill) =>
        React.createElement(
          "div",
          null,
          React.createElement(
            "span",
            { className: "font-semibold text-fg font-mono" },
            skill.name
          ),
          React.createElement(
            "p",
            {
              className: "text-xs text-fg-muted mt-0.5 line-clamp-2",
              title: skill.description,
              style: { maxWidth: "28rem", whiteSpace: "normal" }
            },
            skill.description
          )
        )
    },
    {
      id: "path",
      header: "Path",
      wrap: true,
      cell: (skill) =>
        React.createElement(
          "span",
          {
            className:
              "block max-w-64 truncate text-xs font-mono text-fg-muted",
            title: skill.path
          },
          skill.path
        )
    },
    {
      id: "eligibleRoles",
      header: "Eligible Roles",
      cell: (skill) => {
        const item = eligibility.find((e) => e.skill === skill.name);
        if (!item) {
          return React.createElement(
            "span",
            { className: "text-xs text-fg-muted" },
            "Not observed"
          );
        }
        const roles = item.roles;
        if (roles.length === 0) {
          return React.createElement(
            "span",
            { className: "text-xs text-fg-muted" },
            "No roles assigned"
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
                  "text-xs bg-surface-raised text-fg-secondary px-2 py-0.5 rounded border border-border-strong"
              },
              r
            )
          )
        );
      }
    },
    {
      id: "status",
      header: "Configured",
      cell: () =>
        React.createElement(StatusBadge, {
          status: "configured",
          label: "Configured"
        })
    }
  ];

  return React.createElement(
    "div",
    {
      className: "flex flex-col gap-6",
      "data-feature": "skills",
      "data-skill-runtime-observed": "false",
      "data-skill-source-validity":
        sourceValidity === null ? "not-observed" : String(sourceValidity)
    },
    sourceValidity === false
      ? React.createElement(
          "p",
          {
            className:
              "rounded border border-error/40 bg-error/10 p-3 text-sm text-error",
            role: "alert"
          },
          "RuleSync `.rulesync/skills/` is invalid; catalog contents are unavailable."
        )
      : sourceValidity === null
        ? React.createElement(
            "p",
            {
              className:
                "rounded border border-warning/40 bg-warning/10 p-3 text-sm text-warning",
              role: "status"
            },
            "RuleSync `.rulesync/skills/` has not been observed."
          )
        : null,
    React.createElement(
      "div",
      { className: "grid grid-cols-1 md:grid-cols-4 gap-4" },
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
            className:
              "rounded border border-warning/40 bg-warning/10 p-4 text-sm text-warning",
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
          className:
            "text-sm font-semibold uppercase tracking-wider text-fg-muted mb-3"
        },
        "Agent Skills"
      ),
      DataTable({
        data: skills,
        columns,
        keyExtractor: (s: SkillDefinition) => s.name,
        emptyMessage
      })
    )
  );
}
