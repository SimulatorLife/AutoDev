import type {
  RuleSyncValidationIssue,
  ScopedSkillDefinition,
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
import { Chip, chipList } from "../../components/tables/Chips.ts";
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
  NOT_INSTALLED_LABEL,
  SKILL_SCOPE_LABEL,
  skillScopePlace
} from "./skill-scope.ts";
import type { SkillObservation, SkillTelemetry } from "./skill-telemetry.ts";
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
 * exposed, selected, or used must come from runtime telemetry.
 *
 * A skill's reach is a third fact again, and it is not a setting: where the
 * skill is installed decides which roles can reach it at all. A skill in the
 * catalogue and installed nowhere is a configuration defect, so the page says
 * so instead of listing it as though it were live.
 *
 * The catalog table and role assignment controls are merged into one view:
 * each row displays its identity and metadata alongside its assignment control.
 * Checkbox changes submit immediately through the canonical FormNavigationOwner
 * POST route with expectedRevision conflict protection.
 */

export interface SkillsViewProps {
  readonly skills: readonly ScopedSkillDefinition[];
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
  /**
   * The exposure and use the Runtime has observed.
   *
   * Required rather than defaulted: a page that cannot say whether any
   * telemetry has been observed must not claim that nothing happened.
   */
  readonly telemetry: SkillTelemetry;
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

/**
 * How many times the Runtime saw something happen.
 *
 * `null` is "nothing has been observed" and `0` is "observed, and it never
 * happened". The two are different facts, so a count of zero is printed as a
 * zero and never as "not observed".
 */
function observedCountLabel(count: number | null, noun: string): string {
  if (count === null) return NOT_OBSERVED_LABEL;
  return `${count} ${noun}`;
}

/**
 * What the Runtime has observed about one skill.
 *
 * A skill with no observation says so once, rather than twice: "Not observed ·
 * Not observed" reads like two facts where there is one.
 */
function skillObservationLine(
  observation: SkillObservation | undefined
): string {
  const exposure = observation?.observedExposure ?? null;
  const use = observation?.observedUse ?? null;
  if (exposure === null && use === null) return NOT_OBSERVED_LABEL;
  return `${observedCountLabel(exposure, "exposed")} · ${observedCountLabel(
    use,
    "used"
  )}`;
}

/**
 * The state of one skill, as the State column says it.
 *
 * A skill that is installed nowhere comes first: it cannot be invoked by
 * anybody, so saying it is "Assigned" would report the contract's opinion
 * instead of what an agent can actually reach.
 */
function skillStateBadge(
  skill: ScopedSkillDefinition,
  item: SkillEligibility | undefined,
  executionContractRevision: string | null
): React.JSX.Element {
  if (skill.scope === null) {
    return React.createElement(StatusBadge, {
      status: "invalid",
      label: "Unreachable",
      title:
        "In the skill catalog, but installed nowhere on this machine, so no agent role can invoke it."
    });
  }
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

export function SkillsView({
  skills,
  eligibility,
  unresolvedAssignments,
  validationIssues,
  sourceValidity,
  assignmentRoles,
  executionContractRevision,
  telemetry,
  saveOutcome,
  role = ""
}: SkillsViewProps): React.JSX.Element {
  const catalogNames = new Set(skills.map((skill) => skill.name));
  const eligibleSkills = new Set(
    eligibility
      .filter((item) => item.roles.length > 0 && catalogNames.has(item.skill))
      .map((item) => item.skill)
  );
  // A skill that is installed nowhere cannot be reached by any role, so it is
  // not a configured skill: it is a catalogue entry whose install is missing.
  // Counting it as configured would say a skill is live when no agent can
  // invoke it.
  const installedSkills = skills.filter((skill) => skill.scope !== null);
  const configuredCount =
    sourceValidity === true
      ? installedSkills.length
      : sourceValidity === false
        ? "Invalid"
        : NOT_OBSERVED_LABEL;
  const assignedCount =
    sourceValidity === true ? eligibleSkills.size : NOT_OBSERVED_LABEL;

  // What the Runtime has observed. The totals are over the skills that were
  // observed, and a skill with no observation contributes nothing rather than
  // a zero: "no evidence" and "observed and never happened" are different
  // facts, and the cards below say which one they are.
  const observedExposureTotal = skills.reduce(
    (total, skill) =>
      total + (telemetry.bySkill.get(skill.name)?.observedExposure ?? 0),
    0
  );
  const observedUseTotal = skills.reduce(
    (total, skill) =>
      total + (telemetry.bySkill.get(skill.name)?.observedUse ?? 0),
    0
  );

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
  const columns: ColumnDef<ScopedSkillDefinition>[] = [
    {
      id: "name",
      header: "Skill Name",
      weight: 290,
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
      id: "scope",
      header: "Scope",
      // The help says what the column is, because the column has no control in
      // it and an operator looking for a way to change it has to be told there
      // is none: the scope is read from the install on this machine.
      headerHelp:
        "Where the skill is installed, read from this machine. It is a fact about the install, not a setting, so the Console cannot change it.",
      align: "tokens",
      weight: 150,
      cell: (skill) => {
        const place = skillScopePlace(skill);
        return React.createElement(
          "div",
          {
            className: "flex min-w-0 flex-col gap-1",
            "data-skill-scope": skill.scope ?? "not-installed"
          },
          // One label, so it is a chip rather than a list of them. A skill that
          // is installed nowhere says so in muted text instead: it is not a
          // scope like the others, it is the absence of one.
          skill.scope === null
            ? React.createElement(
                "span",
                { className: MUTED_META_CLASS },
                NOT_INSTALLED_LABEL
              )
            : React.createElement(Chip, null, SKILL_SCOPE_LABEL[skill.scope]),
          place === null
            ? null
            : React.createElement(PathText, {
                path: place,
                className: "font-mono text-xs text-fg-secondary break-normal"
              })
        );
      }
    },
    {
      id: "eligibleRoles",
      header: "Eligible Roles",
      align: "tokens",
      weight: 250,
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
      weight: 188,
      cell: (skill) => {
        const item = eligibility.find((e) => e.skill === skill.name);
        const badge = skillStateBadge(skill, item, executionContractRevision);
        const observed = skillObservationLine(
          telemetry.bySkill.get(skill.name)
        );
        return React.createElement(
          "div",
          { className: "flex min-w-0 flex-col gap-1" },
          badge,
          React.createElement("span", { className: MUTED_META_CLASS }, observed)
        );
      }
    }
  ];

  return React.createElement(
    PageBody,
    {
      feature: "skills",
      attributes: {
        "data-skill-runtime-observed": String(telemetry.observed),
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
        value: configuredCount,
        ...(sourceValidity === true
          ? { subtitle: `of ${skills.length} in the catalog` }
          : {})
      }),
      React.createElement(StatCard, {
        title: "Role-assigned",
        value: assignedCount,
        // The denominator is the catalogue, not the installed skills: this card
        // counts what the execution contract assigns, and a skill it assigns
        // that is installed nowhere is still assigned -- it is simply
        // unreachable, and the row says so.
        ...(sourceValidity === true
          ? { subtitle: `of ${skills.length} in the catalog` }
          : {})
      }),
      React.createElement(StatCard, {
        title: "Observed Exposure",
        value: telemetry.observed ? observedExposureTotal : NOT_OBSERVED_LABEL,
        subtitle: telemetry.observed
          ? "times a skill was exposed to an agent"
          : "Awaiting OTel evidence"
      }),
      React.createElement(StatCard, {
        title: "Usage Evidence",
        value: telemetry.observed ? observedUseTotal : NOT_OBSERVED_LABEL,
        subtitle: telemetry.observed
          ? "times a skill was used"
          : "Awaiting OTel evidence"
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
      React.createElement<DataTableProps<ScopedSkillDefinition>>(DataTable, {
        data: narrowed,
        columns,
        keyExtractor: (s: ScopedSkillDefinition) => s.name,
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
