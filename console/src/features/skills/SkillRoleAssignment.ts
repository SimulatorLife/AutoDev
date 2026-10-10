import type {
  SkillDefinition,
  SkillEligibility
} from "@simulatorlife/autodev-core";
import React from "react";

import { Button } from "../../components/forms/Button.ts";
import {
  CALLOUT_ERROR_CLASS,
  CALLOUT_WARNING_CLASS
} from "../../components/layout/Callout.ts";
import { SECTION_HEADING_CLASS } from "../../components/layout/Heading.ts";
import {
  MONO_ID_CLASS,
  MONO_META_CLASS
} from "../../components/ui/text-classes.ts";

/**
 * The write half of the skill catalog.
 *
 * `/control/skills` was a read-only projection and role assignment lived in the
 * execution contract, so a memory promoted to a skill landed in the catalog
 * assigned to nothing and stayed there. The promotion reported success, the
 * catalog listed it, and no agent could reach it -- a dead end with no control
 * anywhere on the page that could close it. This is that control.
 *
 * Forms below the table rather than a column inside it, because the input is a
 * set of checkboxes drawn from every role the contract defines -- eight today --
 * and no row height in a four-column table survives that. It also keeps the page
 * from gaining a `<th>`: the Console's column-width guard measures every table
 * header against a browser-measured minimum, and a column nobody has measured
 * fails that guard for a reason that has nothing to do with the control it was
 * meant to check.
 *
 * One form per skill posts the *complete* set of roles, so unchecking the last
 * box unassigns the skill and there is no second verb to get wrong. The
 * revision rides in a hidden field: it is the contract digest this page was
 * drawn from, and it is what turns two operators assigning at once into a
 * refusal rather than a silently discarded first write.
 */
export type SkillAssignmentSaveOutcome =
  "conflict" | "validation" | "not-found" | "failed";

export function skillSaveOutcome(
  value: string | readonly string[] | undefined
): SkillAssignmentSaveOutcome | undefined {
  const outcome = typeof value === "string" ? value : value?.[0];
  return outcome === "conflict" ||
    outcome === "validation" ||
    outcome === "not-found" ||
    outcome === "failed"
    ? outcome
    : undefined;
}

const SAVE_OUTCOME_MESSAGES: Readonly<
  Record<SkillAssignmentSaveOutcome, string>
> = {
  conflict:
    "The execution contract changed after this page was loaded, so nothing was written. Reload to see the current assignments and try again.",
  validation:
    "The execution contract refused that assignment, so nothing was written. One of these roles may no longer exist in it.",
  "not-found":
    "That skill is not in the RuleSync catalog any more, so nothing was written. Reload to see the current catalog.",
  failed: "The role assignment was not applied."
};

/**
 * Why there is nothing to assign, in one sentence, or `null` to render forms.
 *
 * Four different operator problems, collapsed into one message they would send
 * someone to fix the wrong one: no contract file, a contract with no roles, an
 * unreadable catalog, and an empty catalog are not the same repair.
 */
function assignmentUnavailableReason({
  executionContractRevision,
  assignmentRoles,
  skills,
  sourceValidity
}: {
  readonly executionContractRevision: string | null;
  readonly assignmentRoles: readonly string[];
  readonly skills: readonly SkillDefinition[];
  readonly sourceValidity: boolean | null;
}): string | null {
  if (executionContractRevision === null) {
    return "No execution contract was found, so no skill can be assigned to a role. Roles are declared there, and there is nothing to edit.";
  }
  if (assignmentRoles.length === 0) {
    return "The execution contract declares no roles, so there is nothing to assign a skill to.";
  }
  if (sourceValidity === false) {
    return "The RuleSync skill catalog is invalid, so the skills that could be assigned are not known.";
  }
  if (skills.length === 0) {
    return "No skills are in the catalog, so there is nothing to assign.";
  }
  return null;
}

export function SkillRoleAssignment({
  skills,
  eligibility,
  assignmentRoles,
  executionContractRevision,
  sourceValidity,
  saveOutcome
}: {
  readonly skills: readonly SkillDefinition[];
  readonly eligibility: readonly SkillEligibility[];
  readonly assignmentRoles: readonly string[];
  readonly executionContractRevision: string | null;
  readonly sourceValidity: boolean | null;
  readonly saveOutcome?: SkillAssignmentSaveOutcome | undefined;
}): React.JSX.Element {
  const unavailable = assignmentUnavailableReason({
    executionContractRevision,
    assignmentRoles,
    skills,
    sourceValidity
  });
  return React.createElement(
    "section",
    {
      className: "mt-6 flex flex-col gap-3",
      "data-skill-assignment-revision": executionContractRevision ?? "none",
      "data-skill-assignment-roles": assignmentRoles.length
    },
    React.createElement(
      "h2",
      { className: SECTION_HEADING_CLASS },
      "Role assignment"
    ),
    saveOutcome === undefined
      ? null
      : React.createElement(
          "p",
          {
            className: CALLOUT_ERROR_CLASS,
            role: "alert",
            "data-testid": "skill-assignment-failure",
            "data-save-outcome": saveOutcome
          },
          SAVE_OUTCOME_MESSAGES[saveOutcome]
        ),
    // The `revision === null` arm is not redundant with `unavailable`: it is
    // what narrows the revision to a string for every form below, so the
    // revision never has to be cast.
    executionContractRevision === null || unavailable !== null
      ? React.createElement(
          "p",
          { className: CALLOUT_WARNING_CLASS, role: "status" },
          unavailable
        )
      : React.createElement(
          "ul",
          { className: "flex flex-col gap-2" },
          skills.map((skill) =>
            React.createElement(SkillAssignmentForm, {
              key: skill.name,
              skill,
              // An eligibility entry we never resolved has no roles, which is
              // "not observed" rather than "assigned to nothing". The form
              // still renders: it posts the complete set either way, and an
              // operator replacing an unresolved assignment is the case this
              // page exists for.
              roles:
                eligibility.find((e) => e.skill === skill.name)?.roles ?? [],
              assignmentRoles,
              executionContractRevision
            })
          )
        ),
    React.createElement(
      "p",
      { className: MONO_META_CLASS },
      "Checked boxes replace the whole set, so clearing the last one unassigns the skill. Roles come from the execution contract."
    )
  );
}

/**
 * The single control for one skill.
 *
 * Role names come from the contract rather than from `/control/agents`,
 * because the contract is what the write edits: a role absent from it is
 * refused, and offering one would be offering a submission that cannot succeed.
 */
function SkillAssignmentForm({
  skill,
  roles,
  assignmentRoles,
  executionContractRevision
}: {
  readonly skill: SkillDefinition;
  readonly roles: readonly string[];
  readonly assignmentRoles: readonly string[];
  readonly executionContractRevision: string;
}): React.JSX.Element {
  const assigned = new Set(roles);
  return React.createElement(
    "li",
    {
      className:
        "rounded border border-border bg-surface/60 p-3 flex flex-wrap items-center gap-x-4 gap-y-2",
      "data-skill-assignment": skill.name
    },
    React.createElement(
      "span",
      {
        // A fixed width on the name (`w-72`, below) is what makes this a matrix rather
        // than fourteen unrelated rows. The name was a flex item sized by its own
        // content, so
        // `ccc` left the form starting 250px further left than
        // `autodev-codex-request-capture` did, and every role column drifted by
        // that same 250px between rows -- measured across all fourteen rows at
        // both 1440px and 1920px. Reading a column therefore meant finding the
        // seventh checkbox in a row whose left edge moved with the name above
        // it. Fixing the name's width fixes every column at once, because each
        // row then renders the same eight labels at the same offsets from the
        // same left edge.
        //
        // `truncate` and the `title` below are the recovery for a name longer
        // than the column. The width is sized to the longest of the fourteen at
        // its rendered weight: `MONO_ID_CLASS` spells that weight
        // `font-semibold` (`text-semibold` emits no rule at all), and the wider
        // glyphs pushed five names past the old 224px -- `w-72` is 288px, which
        // fits all fourteen with margin. Column drift and document overflow
        // measured at 390/768/1440/1920 (0px and 0px); cut names measured at
        // 390 and 1440, 390 being the worst case for a truncation that only
        // lessens as the viewport grows.
        className: `${MONO_ID_CLASS} w-72 shrink-0 truncate`,
        title: skill.name
      },
      skill.name
    ),
    React.createElement(
      "form",
      {
        method: "POST",
        action: `/api/skills/${encodeURIComponent(skill.name)}`,
        className: "flex flex-wrap items-center gap-x-4 gap-y-2 min-w-0"
      },
      React.createElement("input", {
        type: "hidden",
        name: "expectedRevision",
        value: executionContractRevision
      }),
      // Each checkbox is one occurrence of `roles`, so the browser submits
      // exactly the checked set -- and the empty set submits none, which is the
      // unassign case the route has to accept rather than reject as malformed.
      assignmentRoles.map((role) =>
        React.createElement(
          "label",
          {
            key: role,
            // `py-1` is the target size, not decoration. The label is the
            // clickable target for this checkbox -- the input inside it is the
            // browser's default 13x13 -- and measured at 320px the label was
            // 102x16, 113x16, 58x16 across the role options. WCAG 2.5.8 asks for
            // 24x24 CSS px, and every one of these 124 role checkboxes missed
            // it by a third. Four pixels of padding brings the target to 24
            // without changing the type size or the gap between options, and
            // the form already carries `gap-y-2` so the rows stay apart.
            className:
              "flex items-center gap-1.5 py-1 text-xs text-fg-secondary",
            "data-skill-role-option": role
          },
          React.createElement("input", {
            type: "checkbox",
            name: "roles",
            value: role,
            defaultChecked: assigned.has(role),
            className: "accent-accent h-3.5 w-3.5 shrink-0"
          }),
          React.createElement("span", null, role)
        )
      ),
      React.createElement(
        Button,
        {
          type: "submit",
          variant: "secondary",
          testId: `skill-assign-${skill.name}`
        },
        "Save"
      )
    ),
    roles.length === 0
      ? React.createElement(
          "p",
          { className: `${MONO_META_CLASS} w-full` },
          "Unassigned — no agent role can invoke this skill."
        )
      : null
  );
}
