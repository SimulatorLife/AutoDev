"use client";

import type { ScopedSkillDefinition } from "@simulatorlife/autodev-core";
import React from "react";

import { CheckboxField } from "../../components/forms/CheckboxField.ts";
import { NOT_OBSERVED_LABEL } from "../../components/status/StatusBadge.ts";
import { MONO_META_CLASS } from "../../components/ui/text-classes.ts";
import { skillsListQueryString } from "./skills-list-url.ts";

export interface SkillRoleAssignmentControlProps {
  readonly skill: ScopedSkillDefinition;
  readonly roles: readonly string[];
  readonly assignmentRoles: readonly string[];
  readonly executionContractRevision: string;
  readonly isObserved?: boolean | undefined;
  /**
   * The narrowing the list is at, so the POST can come back to it.
   *
   * The assignment's POST redirects, so without this the redirect would land
   * on the whole catalogue and throw away the narrowing the operator had
   * just applied. It travels on the action rather than in the body because
   * the body carries the desired role set and nothing else.
   */
  readonly listRole?: string | undefined;
}

/**
 * One skill's immediate-save role control.
 *
 * Each checkbox submits the full selected role set through the existing
 * same-origin POST route. Clearing every role submits the empty set and
 * unassigns the skill.
 *
 * A repo-scoped skill belongs to one workspace, so its assignment is made
 * inside that workspace and nowhere else. The workspace travels with the
 * assignment, and the control says which one it is making the assignment in:
 * an operator who cannot see that is editing a role list they cannot tell
 * where it lands.
 */
export function SkillRoleAssignmentControl({
  skill,
  roles,
  assignmentRoles,
  executionContractRevision,
  isObserved = true,
  listRole = ""
}: SkillRoleAssignmentControlProps): React.JSX.Element {
  const assigned = new Set(roles);
  const query = skillsListQueryString({ role: listRole });
  const action = `/api/skills/${encodeURIComponent(skill.name)}${
    query === "" ? "" : `?${query}`
  }`;
  const workspace = skill.scope === "repo" ? skill.workspace : null;

  return React.createElement(
    "div",
    {
      className: "flex flex-col gap-1 min-w-0",
      "data-skill-assignment": skill.name,
      ...(workspace === null
        ? {}
        : { "data-skill-assignment-workspace": workspace })
    },
    React.createElement(
      "form",
      {
        method: "POST",
        action,
        className: "flex flex-wrap items-center gap-x-3 gap-y-1 min-w-0",
        "data-submit-on-change": "true"
      },
      React.createElement("input", {
        type: "hidden",
        name: "expectedRevision",
        value: executionContractRevision
      }),
      workspace === null
        ? null
        : React.createElement("input", {
            type: "hidden",
            name: "workspace",
            value: workspace
          }),
      assignmentRoles.map((role) =>
        React.createElement(CheckboxField, {
          key: role,
          name: "roles",
          value: role,
          label: role,
          defaultChecked: assigned.has(role),
          onChange: (event) => event.currentTarget.form?.requestSubmit(),
          // The gap belongs to the shared checkbox: the label row and the box
          // are one control, and a caller that restates the gap would be
          // writing a second spelling of the same relationship.
          labelClassName: "py-1 text-xs select-none",
          labelAttributes: { "data-skill-role-option": role },
          dataAttributes: { "data-submit-on-change": "true" }
        })
      )
    ),
    workspace === null
      ? null
      : React.createElement(
          "p",
          { className: MONO_META_CLASS },
          `Roles apply inside ${workspace}.`
        ),
    isObserved
      ? roles.length === 0
        ? React.createElement(
            "p",
            { className: MONO_META_CLASS },
            "Unassigned — no agent role can invoke this skill."
          )
        : null
      : React.createElement(
          "p",
          { className: MONO_META_CLASS },
          NOT_OBSERVED_LABEL
        )
  );
}
