"use client";

import type { SkillDefinition } from "@simulatorlife/autodev-core";
import React from "react";

import { NOT_OBSERVED_LABEL } from "../../components/status/StatusBadge.ts";
import { MONO_META_CLASS } from "../../components/ui/text-classes.ts";

export interface SkillRoleAssignmentControlProps {
  readonly skill: SkillDefinition;
  readonly roles: readonly string[];
  readonly assignmentRoles: readonly string[];
  readonly executionContractRevision: string;
  readonly isObserved?: boolean | undefined;
}

/**
 * One skill's immediate-save role control.
 *
 * Each checkbox submits the full selected role set through the existing
 * same-origin POST route. Clearing every role submits the empty set and
 * unassigns the skill.
 */
export function SkillRoleAssignmentControl({
  skill,
  roles,
  assignmentRoles,
  executionContractRevision,
  isObserved = true
}: SkillRoleAssignmentControlProps): React.JSX.Element {
  const assigned = new Set(roles);

  return React.createElement(
    "div",
    {
      className: "flex flex-col gap-1 min-w-0",
      "data-skill-assignment": skill.name
    },
    React.createElement(
      "form",
      {
        method: "POST",
        action: `/api/skills/${encodeURIComponent(skill.name)}`,
        className: "flex flex-wrap items-center gap-x-3 gap-y-1 min-w-0",
        "data-submit-on-change": "true"
      },
      React.createElement("input", {
        type: "hidden",
        name: "expectedRevision",
        value: executionContractRevision
      }),
      assignmentRoles.map((role) =>
        React.createElement(
          "label",
          {
            key: role,
            className:
              "flex items-center gap-1.5 py-1 text-xs text-fg-secondary cursor-pointer select-none",
            "data-skill-role-option": role
          },
          React.createElement("input", {
            type: "checkbox",
            name: "roles",
            value: role,
            defaultChecked: assigned.has(role),
            onChange: (event) => event.currentTarget.form?.requestSubmit(),
            "data-submit-on-change": "true",
            className: "accent-accent h-3.5 w-3.5 shrink-0"
          }),
          React.createElement("span", null, role)
        )
      )
    ),
    !isObserved
      ? React.createElement(
          "p",
          { className: MONO_META_CLASS },
          NOT_OBSERVED_LABEL
        )
      : roles.length === 0
        ? React.createElement(
            "p",
            { className: MONO_META_CLASS },
            "Unassigned — no agent role can invoke this skill."
          )
        : null
  );
}
