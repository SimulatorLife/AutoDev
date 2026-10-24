import type {
  RuleSyncValidationIssue,
  SkillDefinition,
  SkillEligibility
} from "@simulatorlife/autodev-core";
import React from "react";

import { StatCard } from "../../components/cards/StatCard.ts";
import { FilterBar } from "../../components/filters/FilterBar.ts";
import { AutoSubmitSelectField } from "../../components/forms/AutoSubmitSelectField.ts";
import {
  CALLOUT_ERROR_CLASS,
  CALLOUT_WARNING_CLASS
} from "../../components/layout/Callout.ts";
import { SECTION_HEADING_CLASS } from "../../components/layout/Heading.ts";
import { PageBody } from "../../components/layout/PageBody.ts";
import { NavigationLink } from "../../components/navigation/NavigationLink.ts";
import { StatGrid } from "../../components/panels/DetailGrid.ts";
import { SourceValidationIssues } from "../../components/status/SourceValidationIssues.ts";
import {
  NOT_OBSERVED_LABEL,
  NOT_OBSERVED_STATUS,
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
  ACTION_LINK_CLASS,
  MONO_META_CLASS,
  MUTED_META_CLASS
} from "../../components/ui/text-classes.ts";
import {
  assignmentUnavailableReason,
  SAVE_OUTCOME_MESSAGES,
  type SkillAssignmentSaveOutcome
} from "./SkillRoleAssignment.ts";
import { SkillRoleAssignmentControl } from "./SkillRoleAssignmentControl.ts";
import {
  filterSkills,
  SKILLS_LIST_PATH,
  type SkillsListFilters
} from "./skills-list-url.ts";

/**
 * Skills resource view.
 *
 * Configuration vs. runtime evidence are separate concerns. A configured
 * skill is only that: configured and possibly eligible. Whether it was
 * exposed, selected, or used must come from runtime telemetry; until the OTel
 * skill exposure/use adapter exists, those values remain `Not observed`.
 *
 * The catalog table and role assignment controls are merged into one view:
 * each row displays its identity and metadata alongside its assignment control.
 * Checkbox changes submit immediately through the canonical FormNavigationOwner
 * POST route with expectedRevision conflict protection.
 */

export interface SkillsViewProps {
  readonly skills: readonly SkillDefinition[];
  readonly eligibility: readonly SkillEligibility[];
  readonly unresolvedAssignments: readonly SkillEligibility[];
  readonly sourceValidity: boolean | null;
  /**
   * How the canonical catalog is invalid.
   *
   * Required rather than defaulted to `[]`: an invalid catalog renders no
   * skills, so without the reasons the page says "the catalog is empty" for a
   * directory that holds six and cannot apply one of them.
   */
  readonly validationIssues: readonly RuleSyncValidationIssue[];
  /**
   * Roles the execution contract declares, and its digest.
   */
  readonly assignmentRoles: readonly string[];
  readonly executionContractRevision: string | null;
  readonly saveOutcome?: SkillAssignmentSaveOutcome | undefined;
  /**
   * The role the list is narrowed to.
   *
   * Optional, because a caller that does not narrow by role says so by
   * leaving it out rather than by passing an empty string.
   */
  readonly role?: string | undefined;
}

function skillAssignmentSaveNotice(
  saveOutcome: SkillAssignmentSaveOutcome | undefined
): React.JSX.Element | null {
  if (saveOutcome === undefined) return null;
  const isUnconfirmed =
    saveOutcome === "failed" ||
    saveOutcome === "pending" ||
    saveOutcome === "not-observed" ||
    saveOutcome === "unconfirmed";
  return React.createElement(
    "p",
    {
      className: isUnconfirmed ? CALLOUT_WARNING_CLASS : CALLOUT_ERROR_CLASS,
      role: isUnconfirmed ? "status" : "alert",
      "data-testid": isUnconfirmed
        ? "skill-assignment-status"
        : "skill-assignment-failure",
      "data-save-outcome": saveOutcome
    },
    SAVE_OUTCOME_MESSAGES[saveOutcome]
  );
}

/**
 * What an empty skill table has to say.
 *
 * Three different facts end with an empty table: the source is invalid, the
 * source was not observed, a role excluded everything, and the catalogue is
 * genuinely empty. Only the caller knows which one it is rendering, and the
 * operator needs to know too -- "no skills configured" when the role was
 * "worker" says the catalogue is empty, and it is not.
 */
function skillEmptyMessage(
  sourceValidity: boolean | null,
  narrowed: boolean
): string {
  if (sourceValidity === false) {
    return "RuleSync `.rulesync/skills/` is invalid; no catalog was projected.";
  }
  if (sourceValidity === null) {
    return "RuleSync `.rulesync/skills/` was not observed.";
  }
  if (narrowed) {
    // Not "no skills configured": the catalogue holds them, and the role is
    // what removed them from view.
    return "No skills found matching the current criteria.";
  }
  return "No skills configured in RuleSync `.rulesync/skills/`.";
}

export function SkillsView({
  skills,
  eligibility,
  unresolvedAssignments,
  validationIssues,
  sourceValidity,
  assignmentRoles,
  executionContractRevision,
  saveOutcome,
  role = ""
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

  // The roles each skill is assigned to, by name. The narrowing is applied
  // here rather than by the page, because the facts above it are about the
  // catalogue and not about the view of it: the "Role-assigned" card counts
  // every eligible skill in the catalogue, and that number must not shrink
  // because the operator narrowed the list.
  const rolesBySkill = new Map<string, readonly string[]>(
    eligibility.map((item) => [item.skill, item.roles] as const)
  );

  const listFilters: SkillsListFilters = { role: role.trim() };
  const narrowed = filterSkills(skills, listFilters, rolesBySkill);
  const isNarrowed = listFilters.role !== "";

  const emptyMessage = skillEmptyMessage(sourceValidity, isNarrowed);

  const unavailable = assignmentUnavailableReason({
    executionContractRevision,
    assignmentRoles,
    skills,
    sourceValidity
  });
  const columns: ColumnDef<SkillDefinition>[] = [
    {
      id: "name",
      header: "Skill Name",
      weight: 320,
      align: "prose",
      cell: (skill) =>
        React.createElement(
          "div",
          { className: "min-w-0" },
          React.createElement(
            NavigationLink,
            {
              href: `/skills/${encodeURIComponent(skill.name)}`,
              className: `${ACTION_LINK_CLASS} block truncate font-mono font-semibold`,
              title: skill.name
            },
            skill.name
          ),
          React.createElement(
            "p",
            {
              className: `mt-0.5 line-clamp-2 ${MUTED_META_CLASS}`,
              title: skill.description
            },
            skill.description
          )
        )
    },
    {
      id: "path",
      header: "Path",
      align: "path",
      weight: 240,
      cell: (skill) => React.createElement(PathText, { path: skill.path })
    },
    {
      id: "eligibleRoles",
      header: "Eligible Roles",
      align: "tokens",
      weight: 360,
      cell: (skill) => {
        const item = eligibility.find((e) => e.skill === skill.name);
        if (executionContractRevision === null) {
          return chipList({
            items: [],
            emptyLabel: NOT_OBSERVED_LABEL,
            testId: "skill-roles"
          });
        }
        if (unavailable !== null) {
          return chipList({
            items: item?.roles ?? [],
            emptyLabel:
              item === undefined ? NOT_OBSERVED_LABEL : "No roles assigned",
            testId: "skill-roles"
          });
        }
        return React.createElement(SkillRoleAssignmentControl, {
          skill,
          roles: item?.roles ?? [],
          assignmentRoles,
          executionContractRevision,
          isObserved: item !== undefined,
          // The narrowing travels on the assignment's action, so the redirect
          // back from the POST lands the operator on the list they narrowed
          // rather than on all sixteen rows.
          listRole: listFilters.role
        });
      }
    },
    {
      id: "status",
      header: "State",
      weight: 146,
      cell: (skill) => {
        const item = eligibility.find((e) => e.skill === skill.name);
        if (item === undefined || executionContractRevision === null) {
          return React.createElement(StatusBadge, {
            status: NOT_OBSERVED_STATUS
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
      "section",
      {
        className: "flex flex-col gap-3",
        "data-skill-assignment-revision": executionContractRevision ?? "none",
        "data-skill-assignment-roles": assignmentRoles.length
      },
      React.createElement(
        FilterBar,
        {
          label: "Skill filters",
          action: SKILLS_LIST_PATH,
          // No submit button, and that is the point rather than an omission.
          // Every control on this page applies the moment it changes -- a role
          // assignment saves itself -- and a "Save" button beside them would
          // be a second way to do the same thing, and one an operator could
          // walk past believing the change had not been written. So the bar
          // takes the shared primitive's on-change mode, whose single-choice
          // control is exactly a role.
          submitMode: "on-change",
          // The count of what is in view belongs to the filter that narrowed
          // it, and only when something was narrowed: an unfiltered catalogue
          // reporting "16 of 16 skills" says nothing the stat row above it does
          // not already say.
          summary: isNarrowed
            ? `Showing ${narrowed.length} of ${skills.length} skills`
            : undefined,
          dataAttributes: { "data-feature-filter": "skills" }
        },
        assignmentRoles.length === 0
          ? null
          : React.createElement(AutoSubmitSelectField, {
              name: "role",
              label: "Role:",
              defaultValue: listFilters.role,
              testId: "skills-role",
              options: [
                { value: "", label: "All roles" },
                ...assignmentRoles.map((name) => ({ value: name, label: name }))
              ]
            })
      ),
      React.createElement(
        "h2",
        {
          className: SECTION_HEADING_CLASS
        },
        "Agent Skills"
      ),
      skillAssignmentSaveNotice(saveOutcome),
      unavailable === null
        ? null
        : React.createElement(
            "p",
            { className: CALLOUT_WARNING_CLASS, role: "status" },
            unavailable
          ),
      React.createElement<DataTableProps<SkillDefinition>>(DataTable, {
        data: narrowed,
        columns,
        keyExtractor: (s: SkillDefinition) => s.name,
        emptyMessage
      }),
      unavailable === null && narrowed.length > 0
        ? React.createElement(
            "p",
            { className: MONO_META_CLASS },
            "Checked boxes replace the whole set, so clearing the last one unassigns the skill. Roles come from the execution contract."
          )
        : null
    ),
    React.createElement(SourceValidationIssues, {
      issues: validationIssues,
      testId: "skill-catalog-validation-issues",
      subject: "Skill catalog"
    })
  );
}
