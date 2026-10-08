import {
  type ControlApiProviderRecord,
  type ControlApiProviderRoleAssignment,
  PROVIDER_ROLES,
  type ProviderRole
} from "@simulatorlife/autodev-core";
import React from "react";

import { AutoSubmitSelectField } from "../../components/forms/AutoSubmitSelectField.ts";
import { Icon, type IconName } from "../../components/icons/Icon.ts";
import { MUTED_META_CLASS } from "../../components/ui/text-classes.ts";

/**
 * The Roles column: the four fixed roles, each with its priority and its model.
 *
 * Every role is one form that posts to the role route. Priority and model live
 * in the same submission because they are one assignment -- a role's
 * participation *is* its priority, and its model is part of that same decision --
 * so splitting them across two forms would let one save while the other
 * silently failed, leaving a row that claims a combination nobody chose.
 *
 * Both selections submit this complete native form immediately. The Runtime
 * remains authoritative: the redirect renders the confirmed assignment, and
 * the shared failure notice explains an unconfirmed write.
 */

const ROLE_LABELS: Readonly<Record<ProviderRole, string>> = {
  default: "Default",
  smart: "Smart",
  orchestrator: "Orchestrator",
  subagent: "Subagent"
};

/**
 * The four role icons, declared as icon props rather than bare name strings so
 * the icon set stays a closed, checked set: an entry here that nothing renders
 * fails the icon guard, and the type keeps a typo from reaching the `Icon`
 * component at runtime.
 */
const ROLE_ICONS = {
  default: { name: "roleDefault" },
  smart: { name: "roleSmart" },
  orchestrator: { name: "roleOrchestrator" },
  subagent: { name: "roleSubagent" }
} as const satisfies Readonly<
  Record<ProviderRole, { readonly name: IconName }>
>;

/**
 * Priority is a member of the enum rather than a separate enablement flag, so
 * `Disabled` is one option among four rather than a fifth control beside them.
 * It is the only option that is highlighted: "this role will not be used"
 * should be visible at a glance, while P1, P2 and P3 share one neutral style so
 * they are not read as different kinds of thing.
 */
const DISABLED_STYLE_CLASS = "border-warning/50 bg-warning/15 text-warning";

/**
 * The models a role may be set to, deduplicated and ordered.
 *
 * A provider maps several tiers to the same model, so the raw list repeats; the
 * dropdown offering the same model twice would read as two choices when it is
 * one. Sorted rather than left in tier order because the list is a set of
 * choices, not a ranking -- the priority dropdown is where ranking lives.
 */
const MODEL_COLLATOR = new Intl.Collator();

/** The priority dropdown's selected value for an assignment. */
function priorityOptionSelected(
  assignment: ControlApiProviderRoleAssignment
): string {
  return assignment.priority === "disabled"
    ? "disabled"
    : String(assignment.priority);
}

/**
 * The models a role may be set to, deduplicated and ordered.
 *
 * A provider maps several tiers to the same model, so the raw list repeats; the
 * dropdown offering the same model twice would read as two choices when it is
 * one. Sorted rather than left in tier order because the list is a set of
 * choices, not a ranking -- the priority dropdown is where ranking lives.
 */
function availableModels(
  provider: ControlApiProviderRecord
): readonly string[] {
  return [...new Set(provider.models.map(({ model }) => model.trim()))].sort(
    (left, right) => MODEL_COLLATOR.compare(left, right)
  );
}

/**
 * The model dropdown for one role.
 *
 * When the role is disabled the control stays present and keeps its value, but
 * it is disabled and dimmed: the previously chosen model has to stay visible
 * and recoverable, because re-enabling the role should restore it rather than
 * force the operator to pick it again from memory.
 */
function RoleModelSelect({
  provider,
  role,
  assignment,
  models,
  disabledReason
}: {
  readonly provider: string;
  readonly role: ProviderRole;
  readonly assignment: ControlApiProviderRoleAssignment;
  readonly models: readonly string[];
  readonly disabledReason: string | undefined;
}): React.JSX.Element {
  const roleDisabled = assignment.priority === "disabled";
  return React.createElement(AutoSubmitSelectField, {
    // Scoped per role: four role forms submit `model` from the same page, so
    // sharing the default id would leave every label pointing at whichever
    // control the DOM resolved first.
    id: `select-model-${provider}-${role}`,
    name: "model",
    label: `${ROLE_LABELS[role]} model`,
    hideLabel: true,
    // The width matches the model track in RoleRow's aligned grid. The shared
    // table preserves this budget at narrow viewports and scrolls rather than
    // letting the select push its row out of alignment.
    className: "min-w-0 w-52",
    testId: `role-model-${provider}-${role}`,
    dataAttributes: {
      "data-role-model": role,
      "data-dimmed": roleDisabled ? "true" : "false"
    },
    defaultValue: assignment.model ?? "",
    ...(disabledReason === undefined ? {} : { disabled: true, disabledReason }),
    options: [
      { value: "", label: "Not set" },
      ...models.map((model) => ({ value: model, label: model }))
    ]
  });
}

function RoleRow({
  provider,
  role,
  assignment,
  models,
  returnTo
}: {
  readonly provider: string;
  readonly role: ProviderRole;
  readonly assignment: ControlApiProviderRoleAssignment;
  readonly models: readonly string[];
  readonly returnTo: string;
}): React.JSX.Element {
  const roleDisabled = assignment.priority === "disabled";
  // A globally disabled provider's roles cannot be edited until it is enabled
  // again. Both controls stay in place with that reason rather than vanishing,
  // so the preserved configuration is visible instead of merely implied.
  const blockedReason = assignment.mutable
    ? undefined
    : "This provider is disabled. Enable it to change its roles.";
  const modelReason =
    blockedReason ??
    (roleDisabled
      ? "This role is set to Disabled. Choose a priority to change its model."
      : undefined);

  return React.createElement(
    "form",
    {
      action: `/api/providers/${encodeURIComponent(provider)}/roles/${encodeURIComponent(role)}`,
      method: "POST",
      className: "grid min-w-0 grid-cols-[6rem_6rem_13rem] items-center gap-2",
      "data-role-form": `${provider}-${role}`
    },
    React.createElement("input", {
      type: "hidden",
      name: "provider",
      value: provider
    }),
    React.createElement("input", {
      type: "hidden",
      name: "role",
      value: role
    }),
    React.createElement("input", {
      type: "hidden",
      name: "returnTo",
      value: returnTo
    }),
    React.createElement(
      "span",
      {
        className: "flex min-w-0 items-center gap-1.5 " + MUTED_META_CLASS,
        "data-role-label": role
      },
      React.createElement(Icon, {
        ...ROLE_ICONS[role],
        size: 14,
        className: "shrink-0"
      }),
      ROLE_LABELS[role]
    ),
    React.createElement(AutoSubmitSelectField, {
      id: `select-priority-${provider}-${role}`,
      name: "priority",
      label: `${ROLE_LABELS[role]} priority`,
      hideLabel: true,
      className: "min-w-0 w-24",
      testId: `role-priority-${provider}-${role}`,
      dataAttributes: {
        "data-role-priority": role,
        // `className`, not `class`: React drops an unknown `class` prop with a
        // warning rather than applying it, so the highlight would silently not
        // render. `SelectField` puts these onto the `<select>` itself.
        ...(roleDisabled ? { className: DISABLED_STYLE_CLASS } : {})
      },
      defaultValue: priorityOptionSelected(assignment),
      ...(blockedReason === undefined
        ? {}
        : { disabled: true, disabledReason: blockedReason }),
      options: [
        { value: "1", label: "P1" },
        { value: "2", label: "P2" },
        { value: "3", label: "P3" },
        { value: "disabled", label: "Disabled" }
      ]
    }),
    React.createElement(RoleModelSelect, {
      provider,
      role,
      assignment,
      models,
      disabledReason: modelReason
    }),
    // A natively `disabled` control is not submitted by the browser, and the
    // role route requires exactly the five fields `provider`, `role`,
    // `priority`, `model` and `returnTo`. Without this, re-enabling a Disabled
    // role posted four fields, the route refused it, and the operator could
    // never turn the role back on: the one action the control existed to allow.
    // The hidden field carries the preserved model across that submission, and
    // there is no duplicate name to disambiguate because the disabled `<select>`
    // contributes nothing. This is the same shape the Agent Limits steppers use
    // for their current state.
    //
    // The carry holds the preserved model only while this provider still offers
    // it. A model that has since been removed from the configuration has no
    // `<option>` to render into, so the operator can neither see nor change it,
    // and the Runtime rejects the whole body when a role names a model it is not
    // configured for -- which would leave the role permanently un-re-enableable,
    // trading one unreachable control for another. Carrying nothing instead
    // clears the model, which the operator can then choose again.
    ...(modelReason === undefined
      ? []
      : [
          React.createElement("input", {
            key: "preserved-model",
            type: "hidden",
            name: "model",
            value:
              assignment.model && models.includes(assignment.model)
                ? assignment.model
                : ""
          })
        ])
  );
}

/**
 * The four roles for one provider, in the fixed order the target state names:
 * Default, Smart, Orchestrator, Subagent. The order is read from
 * `PROVIDER_ROLES` rather than restated here so a role added to Core cannot go
 * missing from this column.
 */
export function ProviderRoleControls({
  provider,
  returnTo
}: {
  readonly provider: ControlApiProviderRecord;
  readonly returnTo: string;
}): React.JSX.Element {
  const models = availableModels(provider);
  return React.createElement(
    "ul",
    {
      className: "flex list-none flex-col gap-1.5 p-0 m-0",
      "data-provider-roles": provider.id
    },
    ...PROVIDER_ROLES.map((role) =>
      React.createElement(
        "li",
        { key: role, className: "flex min-w-0" },
        React.createElement(RoleRow, {
          provider: provider.id,
          role,
          assignment: provider.roles[role],
          models,
          returnTo
        })
      )
    )
  );
}
