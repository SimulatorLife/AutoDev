import type {
  RuleSyncValidationIssue,
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
import { SourceValidationIssues } from "../../components/status/SourceValidationIssues.ts";
import {
  NOT_OBSERVED_LABEL,
  StatusBadge
} from "../../components/status/StatusBadge.ts";
import { chipList } from "../../components/tables/Chips.ts";
import {
  type ColumnDef,
  DataTable,
  type DataTableProps
} from "../../components/tables/DataTable.ts";
import { PathText } from "../../components/tables/PathText.ts";
import {
  type SkillAssignmentSaveOutcome,
  SkillRoleAssignment
} from "./SkillRoleAssignment.ts";

/**
 * Skills resource view.
 *
 * Configuration vs. runtime evidence are separate concerns. A configured
 * skill is only that: configured and possibly eligible. Whether it was
 * exposed, selected, or used must come from runtime telemetry; until the OTel
 * skill exposure/use adapter exists, those values remain `Not observed`.
 */

export interface SkillsViewProps {
  readonly skills: readonly SkillDefinition[];
  readonly eligibility: readonly SkillEligibility[];
  readonly unresolvedAssignments: readonly SkillEligibility[];
  readonly sourceValidity: boolean | null;
  /**
   * Why the canonical catalog is invalid.
   *
   * Required rather than defaulted to `[]`: an invalid catalog renders no
   * skills, so without the reasons the page says "the catalog is empty" for a
   * directory that holds six and cannot apply one of them.
   */
  readonly validationIssues: readonly RuleSyncValidationIssue[];
  /**
   * Roles the execution contract declares, and its digest.
   *
   * Required rather than optional: the reason this view grew a write surface is
   * that a skill promoted from a procedural memory arrived in the catalog
   * assigned to nothing with no control anywhere on the page able to fix it. An
   * optional pair here would let a later caller drop the assignment section
   * without a compile error and reopen exactly that dead end.
   */
  readonly assignmentRoles: readonly string[];
  readonly executionContractRevision: string | null;
  readonly saveOutcome?: SkillAssignmentSaveOutcome | undefined;
}

export function SkillsView({
  skills,
  eligibility,
  unresolvedAssignments,
  validationIssues,
  sourceValidity,
  assignmentRoles,
  executionContractRevision,
  saveOutcome
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
        : NOT_OBSERVED_LABEL;
  const assignedCount =
    sourceValidity === true ? eligibleSkills.size : NOT_OBSERVED_LABEL;
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
      weight: 373,
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
      // Gives the share the State column needs for its badge. A path can wrap
      // between its segments and keep every one of them, so it is the cheaper
      // place to take width than the skill name, which is the row's primary key.
      align: "path",
      weight: 269,
      cell: (skill) => React.createElement(PathText, { path: skill.path })
    },
    {
      id: "eligibleRoles",
      header: "Eligible Roles",
      align: "tokens",
      cell: (skill) => {
        const item = eligibility.find((e) => e.skill === skill.name);
        return chipList({
          items: item?.roles ?? [],
          emptyLabel:
            item === undefined ? NOT_OBSERVED_LABEL : "No roles assigned",
          testId: "skill-roles"
        });
      }
    },
    {
      id: "status",
      header: "State",
      // Sized for the badge. Declared no weight at all, so this column took the
      // 100-unit default and clipped "Configured" at its last glyph.
      //
      // The badge needs 86px of text plus 32px of cell padding, and the table
      // is at its 864px floor below that, so 131 is the share that fits it at
      // 390px rather than at the width it was measured at. `StatusBadge` now
      // truncates recoverably regardless, because a share of a container is not
      // a width: this number is the difference between a badge that reads whole
      // and one that reads "Configure…", not the difference between one that
      // reads "Configure…" and one that reads nothing at all.
      weight: 146,
      // Three states, because being in the catalog, being reachable, and our
      // knowledge of whether it is reachable are three different facts. This cell
      // used to ignore the row entirely and badge every skill "Configured", so a
      // skill promoted from a procedural memory — which lands in the catalog with
      // no role assignment — sat beside "No roles assigned" under a green badge
      // saying it was fine. It is not fine: no agent can reach it, and the
      // promotion that created it reported success.
      //
      // The assignment section below the table is what makes "Not assigned" a
      // problem the operator can do something about rather than a row they can
      // only read.
      //
      // An eligibility entry we never resolved stays "Not observed". Collapsing
      // it into "Not assigned" would claim we checked and found nothing, which is
      // the same confusion the roles column already refuses.
      cell: (skill) => {
        const item = eligibility.find((e) => e.skill === skill.name);
        if (item === undefined) {
          return React.createElement(StatusBadge, {
            status: "not-observed",
            label: NOT_OBSERVED_LABEL
          });
        }
        if (item.roles.length === 0) {
          return React.createElement(StatusBadge, {
            status: "unavailable",
            label: "Not assigned",
            title:
              "In the skill catalog, but assigned to no agent role, so nothing can invoke it."
          });
        }
        return React.createElement(StatusBadge, {
          status: "ready",
          label: "Assigned",
          title: `Assigned to ${item.roles.join(", ")}`
        });
      }
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
        value: NOT_OBSERVED_LABEL,
        subtitle: "Awaiting OTel evidence"
      }),
      React.createElement(StatCard, {
        title: "Usage Evidence",
        value: NOT_OBSERVED_LABEL,
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
    ),
    // The catalog above is a projection and always was; this is what makes the
    // page something more than a report. A skill promoted from a procedural
    // memory lands assigned to nothing, and until this existed there was no
    // control anywhere that could reach the execution contract and change that.
    React.createElement(SourceValidationIssues, {
      issues: validationIssues,
      testId: "skill-catalog-validation-issues",
      subject: "Skill catalog"
    }),
    React.createElement(SkillRoleAssignment, {
      skills,
      eligibility,
      assignmentRoles,
      executionContractRevision,
      sourceValidity,
      ...(saveOutcome === undefined ? {} : { saveOutcome })
    })
  );
}
