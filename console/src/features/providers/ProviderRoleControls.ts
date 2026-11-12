import {
  type ControlApiProviderAgentModel,
  type ControlApiProviderRecord,
  type ControlApiProviderRoleAssignment,
  isAntigravityProvider,
  PROVIDER_ROLES,
  type ProviderRole
} from "@simulatorlife/autodev-core";
import React from "react";

import { AutoSubmitSelectField } from "../../components/forms/AutoSubmitSelectField.ts";
import {
  HierarchicalSelect,
  HierarchicalSelectForms,
  type HierarchicalSelectProps
} from "../../components/forms/HierarchicalSelect.ts";
import { Icon, type IconName } from "../../components/icons/Icon.ts";
import { NOT_OBSERVED_LABEL } from "../../components/status/StatusBadge.ts";
import { MUTED_META_CLASS } from "../../components/ui/text-classes.ts";
import {
  providerModelAvailability,
  providerModelChoices,
  type ProviderModelDiscoveryState,
  providerModelDiscoveryView
} from "./provider-model-discovery.ts";

/**
 * The Roles column: the fixed roles, each with its priority and its model.
 *
 * The Subagent role's per-agent model overrides take one of two layouts. The
 * Providers table, where the strip shares a row with every other column, folds
 * them into one hierarchical select on the Subagent row. The provider detail
 * page, where the strip has the panel to itself, gives each agent role
 * (`explorer`, `worker`, ...) a row of its own under Subagent, so a model per
 * agent role is one select away rather than two levels into a menu.
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
  orchestrator: { name: "roleOrchestrator" },
  subagent: { name: "roleSubagent" }
} as const satisfies Readonly<
  Record<ProviderRole, { readonly name: IconName }>
>;

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
 * How the Subagent role's per-agent model overrides are laid out: folded into
 * the Subagent row's hierarchical select, or one row per agent role.
 */
export type SubagentModelLayout = "hierarchical" | "rows";

type ModelChoice = { readonly id: string; readonly label: string };

function availableModels(
  discovery: ProviderModelDiscoveryState,
  provider: string
): readonly ModelChoice[] {
  return providerModelChoices(discovery, provider)
    .map(({ id }) => ({ id, label: id }))
    .sort((left, right) => MODEL_COLLATOR.compare(left.id, right.id));
}

function preservedModelLabel(
  discovery: ProviderModelDiscoveryState,
  provider: string,
  model: string
): string {
  const availability = providerModelAvailability(discovery, provider, model);
  switch (availability.status) {
    case "unsupported": {
      return `${model} — unsupported by Runtime`;
    }
    case "stale": {
      return `${model} — last known, stale`;
    }
    case "not-listed": {
      return `${model} — not in current provider listing`;
    }
    case "unavailable": {
      return `${model} — provider availability unavailable`;
    }
    case "not-observed": {
      return `${model} — provider availability not observed`;
    }
    case "observed": {
      return model;
    }
  }
  return model;
}

function modelDiscoveryDisabledReason(
  discovery: ProviderModelDiscoveryState,
  provider: string
): string | null {
  const state = providerModelDiscoveryView(discovery, provider);
  switch (state.status) {
    case "observed": {
      return null;
    }
    case "stale": {
      return `Provider model availability is stale. Existing assignments are preserved; new model choices require a current provider listing. ${state.reason}`;
    }
    case "unavailable": {
      return `Provider model availability is unavailable. Existing assignments are preserved. ${state.reason}`;
    }
    case "not-observed": {
      return `Provider model availability is not observed. Existing assignments are preserved. ${state.reason}`;
    }
  }
  return null;
}

/**
 * A model select's options: the Auto choice, every listed model, and the
 * current model when the listing no longer carries it -- labelled with why --
 * so a saved choice stays visible instead of silently reading as Auto.
 */
function modelSelectOptions(
  discovery: ProviderModelDiscoveryState,
  provider: string,
  models: readonly ModelChoice[],
  current: string | null,
  autoLabel: string
): { readonly value: string; readonly label: string }[] {
  return [
    { value: "", label: autoLabel },
    ...models.map(({ id, label }) => ({ value: id, label })),
    ...(current !== null && !models.some(({ id }) => id === current)
      ? [
          {
            value: current,
            label: preservedModelLabel(discovery, provider, current)
          }
        ]
      : [])
  ];
}

const MODEL_EFFORT_SUFFIX = /-(low|medium|high)$/;

/**
 * Why a role's model cannot be changed now, or undefined when it can: the
 * provider is disabled, cannot serve the role, the role is Disabled, or the
 * provider's models are not currently observed.
 */
function roleModelDisabledReason(
  provider: string,
  assignment: ControlApiProviderRoleAssignment,
  discovery: ProviderModelDiscoveryState
): string | undefined {
  if (!assignment.mutable)
    return "This provider is disabled. Enable it to change its roles.";
  if (assignment.canServe === false)
    return (
      assignment.cannotServeReason ?? "This provider cannot serve this role."
    );
  if (assignment.priority === "disabled")
    return "This role is set to Disabled. Choose a priority to change its model.";
  return modelDiscoveryDisabledReason(discovery, provider) ?? undefined;
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
  discovery,
  disabledReason
}: {
  readonly provider: string;
  readonly role: ProviderRole;
  readonly assignment: ControlApiProviderRoleAssignment;
  readonly models: readonly ModelChoice[];
  readonly discovery: ProviderModelDiscoveryState;
  readonly disabledReason: string | undefined;
}): React.JSX.Element {
  const roleDisabled = assignment.priority === "disabled";
  return React.createElement(AutoSubmitSelectField, {
    // Scoped per role: several role forms submit `model` from the same page, so
    // sharing the default id would leave every label pointing at whichever
    // control the DOM resolved first.
    id: `select-model-${provider}-${role}`,
    name: "model",
    label: `${ROLE_LABELS[role]} model`,
    hideLabel: true,
    // The width matches the model track in RoleRow's aligned grid. The shared
    // table preserves this budget at narrow viewports and scrolls rather than
    // letting the select push its row out of alignment.
    className: "min-w-0 w-48",
    testId: `role-model-${provider}-${role}`,
    dataAttributes: {
      "data-role-model": role,
      "data-dimmed": roleDisabled ? "true" : "false"
    },
    defaultValue: assignment.model ?? "",
    ...(disabledReason === undefined ? {} : { disabled: true, disabledReason }),
    options: modelSelectOptions(
      discovery,
      provider,
      models,
      assignment.model,
      "Auto"
    )
  });
}

function RoleEffortSelect({
  provider,
  role,
  assignment,
  disabledReason
}: {
  readonly provider: string;
  readonly role: ProviderRole;
  readonly assignment: ControlApiProviderRoleAssignment;
  readonly disabledReason: string | undefined;
}): React.JSX.Element {
  const supportedLevels = assignment.supportedReasoningLevels ?? [];
  const hasLevels = supportedLevels.length > 0;
  const isAgyFixed =
    isAntigravityProvider(provider) &&
    assignment.model !== null &&
    MODEL_EFFORT_SUFFIX.test(assignment.model);

  if (!hasLevels && !isAgyFixed) {
    // The effort in force is known even when the model's supported levels are
    // not: the role's effort is the operator's choice, and the levels a model
    // declares are a separate fact. Showing "Not observed" for the effort would
    // hide a value the role is running with, so the value is shown and the
    // unobserved levels are said out loud.
    const effortInForce =
      assignment.effectiveReasoningEffort ?? assignment.reasoningEffort;
    if (effortInForce) {
      return React.createElement(
        "span",
        {
          className:
            "min-w-0 w-28 truncate rounded border border-border bg-surface-muted/30 px-2 py-1 text-center font-mono text-xs text-fg-secondary",
          title: `Reasoning effort in force. The supported levels of ${assignment.model ?? "the configured model"} have not been observed.`,
          "data-role-effort-unobserved": `${provider}-${role}`
        },
        effortInForce
      );
    }
    return React.createElement(
      "span",
      {
        className: "min-w-0 w-28 text-center text-xs " + MUTED_META_CLASS,
        "data-role-effort-placeholder": `${provider}-${role}`
      },
      NOT_OBSERVED_LABEL
    );
  }

  if (isAgyFixed) {
    return React.createElement(
      "span",
      {
        className:
          "min-w-0 w-28 truncate rounded border border-border bg-surface-muted/30 px-2 py-1 text-center font-mono text-xs text-fg-secondary",
        title: `Fixed by model slug (${assignment.effectiveReasoningEffort ?? "model"})`,
        "data-role-effort-fixed": `${provider}-${role}`
      },
      assignment.effectiveReasoningEffort ?? "Fixed"
    );
  }

  const roleDisabled = assignment.priority === "disabled";
  const options = [
    { value: "", label: "Default" },
    ...supportedLevels.map((lvl) => ({
      value: lvl,
      label: lvl.charAt(0).toUpperCase() + lvl.slice(1)
    }))
  ];

  return React.createElement(AutoSubmitSelectField, {
    id: `select-effort-${provider}-${role}`,
    name: "reasoningEffort",
    label: `${ROLE_LABELS[role]} reasoning effort`,
    hideLabel: true,
    className: "min-w-0 w-28",
    testId: `role-effort-${provider}-${role}`,
    dataAttributes: {
      "data-role-effort": role,
      "data-dimmed": roleDisabled ? "true" : "false"
    },
    defaultValue: assignment.reasoningEffort ?? "",
    ...(disabledReason === undefined ? {} : { disabled: true, disabledReason }),
    options
  });
}

/**
 * The role strip's aligned grid: label, priority, model, effort. Every row --
 * a role's or an agent role's -- uses it, so the columns line up down the
 * whole strip.
 *
 * The label column is a fixed width, and it is the width the longest role
 * label needs: `Orchestrator`, with its icon, is 92px.
 *
 * It was `max-content` for a while, to stop a label being cut. That traded
 * one defect for another: every row's grid sized its own label track to its
 * own label, so the rows' controls started at different x positions.
 * Measured in Chromium against the production build, the priority column
 * drifted 38px between `Smart` and `Orchestrator`, and the model column
 * drifted with it -- a strip that claims to be an aligned configuration, in
 * which the eye cannot scan down a column at all.
 *
 * The gaps are `1.5` because the four tracks sum to 494px against a 496px
 * cell: the columns were sized to fill that cell exactly, so the four pixels
 * the label needed came from the gaps rather than from a column that was
 * already measured.
 */
const ROLE_GRID_CLASS =
  "grid min-w-0 grid-cols-[5.75rem_5rem_12rem_7rem] items-center gap-1.5";

function RoleRow({
  provider,
  role,
  assignment,
  agentModels,
  models,
  discovery,
  subagentLayout,
  returnTo
}: {
  readonly provider: string;
  readonly role: ProviderRole;
  readonly assignment: ControlApiProviderRoleAssignment;
  readonly agentModels: readonly ControlApiProviderAgentModel[];
  readonly models: readonly ModelChoice[];
  readonly discovery: ProviderModelDiscoveryState;
  readonly subagentLayout: SubagentModelLayout;
  readonly returnTo: string;
}): React.JSX.Element {
  // Only the hierarchical layout moves the Subagent model into its own menu
  // forms; in the rows layout it is an ordinary select in this role's form.
  const hierarchicalModel =
    role === "subagent" && subagentLayout === "hierarchical";
  const roleDisabled = assignment.priority === "disabled";
  // A globally disabled provider's roles cannot be edited until it is enabled
  // again. Both controls stay in place with that reason rather than vanishing,
  // so the preserved configuration is visible instead of merely implied.
  const blockedReason = assignment.mutable
    ? undefined
    : "This provider is disabled. Enable it to change its roles.";
  // A provider with no delegation path cannot serve the orchestrator at all:
  // the orchestrator creates child agents, and the router refuses that traffic
  // to a provider that cannot. Enabling the role here would change nothing,
  // so the control says why instead of offering a priority the router never
  // routes to -- which is how a provider came to be reported as the
  // orchestrator's provider while every orchestrator request failed.
  const cannotServeReason =
    assignment.canServe === false
      ? (assignment.cannotServeReason ??
        "This provider cannot serve this role.")
      : undefined;
  const modelReason = roleModelDisabledReason(provider, assignment, discovery);
  const effortReason =
    blockedReason ??
    cannotServeReason ??
    (roleDisabled
      ? "This role is set to Disabled. Choose a priority to change its reasoning effort."
      : undefined);

  const supportedLevels = assignment.supportedReasoningLevels ?? [];
  const hasLevels = supportedLevels.length > 0;
  const isAgyFixed =
    isAntigravityProvider(provider) &&
    assignment.model !== null &&
    MODEL_EFFORT_SUFFIX.test(assignment.model);
  const effortSubmitsViaSelect =
    hasLevels && !isAgyFixed && effortReason === undefined;

  return React.createElement(
    // A write surface inside a table cell is a group of controls rather
    // than a landmark: the operator finds it in the cell, and an
    // anonymous landmark for every row is a list of names that name nothing.
    "form",
    {
      role: "group",
      action: `/api/providers/${encodeURIComponent(provider)}/roles/${encodeURIComponent(role)}`,
      method: "POST",
      className: ROLE_GRID_CLASS,
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
      className: "min-w-0 w-20",
      testId: `role-priority-${provider}-${role}`,
      tone:
        roleDisabled || cannotServeReason !== undefined ? "warning" : undefined,
      dataAttributes: { "data-role-priority": role },
      defaultValue: priorityOptionSelected(assignment),
      ...(blockedReason === undefined
        ? cannotServeReason === undefined
          ? {}
          : { disabled: true, disabledReason: cannotServeReason }
        : { disabled: true, disabledReason: blockedReason }),
      options: [
        { value: "1", label: "P1" },
        { value: "2", label: "P2" },
        { value: "3", label: "P3" },
        { value: "disabled", label: "Disabled" }
      ]
    }),
    hierarchicalModel
      ? React.createElement(HierarchicalSelect, {
          ...subagentModelSelect({
            provider,
            assignment,
            agentModels,
            models,
            discovery,
            returnTo
          }),
          className: "max-w-48 justify-self-start",
          // The opened menu takes a row of its own under the role's controls,
          // so the scrolling strip never clips it.
          menuClassName: "col-span-full row-start-2"
        })
      : React.createElement(RoleModelSelect, {
          provider,
          role,
          assignment,
          models,
          discovery,
          disabledReason: modelReason
        }),
    React.createElement(RoleEffortSelect, {
      provider,
      role,
      assignment,
      disabledReason: effortReason
    }),
    // A natively `disabled` control is not submitted by the browser, and the
    // hierarchical Subagent model is chosen in its own menu forms, so the
    // role's form carries the current model for its priority and effort
    // changes.
    ...(modelReason === undefined && !hierarchicalModel
      ? []
      : [
          React.createElement("input", {
            key: "preserved-model",
            type: "hidden",
            name: "model",
            value: assignment.model ?? ""
          })
        ]),
    ...(effortSubmitsViaSelect
      ? []
      : [
          React.createElement("input", {
            key: "preserved-effort",
            type: "hidden",
            name: "reasoningEffort",
            // An effort names the model it applies to: the Runtime refuses an
            // effort that has no model to check it against, so a role with no
            // model carries no effort. The role then keeps the effort its
            // configured model resolves, which is the effort this cell shows.
            value:
              assignment.model === null
                ? ""
                : (assignment.reasoningEffort ?? "")
          })
        ])
  );
}

/**
 * One agent role's model override, as a row of its own under Subagent.
 *
 * An agent role has no priority or reasoning effort of its own -- it runs at
 * the Subagent role's priority and effort -- so its row is a label spanning the
 * label and priority tracks, and a model select in the model track, aligned
 * with every role's model above it. Auto names the model the role then runs:
 * its tier's configured model. The select is blocked for the same reasons the
 * Subagent model is, since the override only applies while that role serves.
 */
function AgentModelRow({
  provider,
  entry,
  subagent,
  models,
  discovery,
  returnTo
}: {
  readonly provider: string;
  readonly entry: ControlApiProviderAgentModel;
  readonly subagent: ControlApiProviderRoleAssignment;
  readonly models: readonly ModelChoice[];
  readonly discovery: ProviderModelDiscoveryState;
  readonly returnTo: string;
}): React.JSX.Element {
  const disabledReason = roleModelDisabledReason(provider, subagent, discovery);
  return React.createElement(
    "form",
    {
      role: "group",
      action: `/api/providers/${encodeURIComponent(provider)}/agents/${encodeURIComponent(entry.role)}`,
      method: "POST",
      className: ROLE_GRID_CLASS,
      "data-agent-model-form": `${provider}-${entry.role}`
    },
    React.createElement("input", {
      type: "hidden",
      name: "provider",
      value: provider
    }),
    React.createElement("input", {
      type: "hidden",
      name: "role",
      value: entry.role
    }),
    React.createElement("input", {
      type: "hidden",
      name: "returnTo",
      value: returnTo
    }),
    React.createElement(
      "span",
      {
        className:
          "col-span-2 flex min-w-0 items-center gap-1.5 pl-5 " +
          MUTED_META_CLASS,
        title: `The ${entry.role} agent's model. Auto runs its tier's model; priority and reasoning effort follow the Subagent role.`,
        "data-agent-model-label": entry.role
      },
      React.createElement("span", { className: "truncate" }, entry.role)
    ),
    React.createElement(AutoSubmitSelectField, {
      id: `select-agent-model-${provider}-${entry.role}`,
      name: "model",
      label: `${entry.role} agent model`,
      hideLabel: true,
      className: "min-w-0 w-48",
      testId: `agent-model-${provider}-${entry.role}`,
      dataAttributes: {
        "data-agent-model": entry.role,
        "data-dimmed": subagent.priority === "disabled" ? "true" : "false"
      },
      defaultValue: entry.model ?? "",
      ...(disabledReason === undefined
        ? {}
        : { disabled: true, disabledReason }),
      options: modelSelectOptions(
        discovery,
        provider,
        models,
        entry.model,
        `Auto (${entry.tierModel ?? NOT_OBSERVED_LABEL})`
      )
    }),
    // A natively `disabled` select is not submitted, and the route requires
    // `model`, so a blocked row still carries its current choice.
    ...(disabledReason === undefined
      ? []
      : [
          React.createElement("input", {
            key: "preserved-model",
            type: "hidden",
            name: "model",
            value: entry.model ?? ""
          })
        ])
  );
}

/**
 * The roles for one provider, in the fixed order the target state names:
 * Orchestrator, Subagent. The order is read from `PROVIDER_ROLES` rather than
 * restated here so a role added to Core cannot go missing from this column.
 * In the `rows` layout each agent role follows Subagent in a row of its own.
 */
export function ProviderRoleControls({
  provider,
  modelDiscovery,
  subagentLayout,
  returnTo
}: {
  readonly provider: ControlApiProviderRecord;
  readonly modelDiscovery: ProviderModelDiscoveryState;
  readonly subagentLayout: SubagentModelLayout;
  readonly returnTo: string;
}): React.JSX.Element {
  const models = availableModels(modelDiscovery, provider.id);
  return React.createElement(
    "ul",
    {
      // The role strip is a wide, aligned configuration: a label and three
      // controls per role, in columns that line up across the four roles. On
      // the Providers row that strip lives in a table cell and the table
      // scrolls; here it is the only thing in the panel, so the strip has to
      // scroll itself. Without that, a phone-width detail page cut the model
      // and effort controls off the edge of the panel with no way to reach
      // them -- the same budget the shared table preserves by scrolling.
      //
      // `items-start` keeps each row at the width of its own content, so the
      // row is not squeezed into the panel and left overflowing: the strip
      // scrolls as one thing, which is one scrollbar for four roles rather
      // than one per role.
      // `py-1` leaves room for the focus ring. The Console draws it four
      // pixels outside the control it belongs to, and this strip scrolls, so
      // a control flush against the strip's edge would lose the top and the
      // bottom of its ring to the clip -- a ring with its own edges cut off.
      className:
        "flex list-none flex-col items-start gap-1.5 overflow-x-auto p-0 py-1.5 m-0",
      "data-provider-roles": provider.id
    },
    ...PROVIDER_ROLES.flatMap((role) => [
      React.createElement(
        "li",
        { key: role, className: "flex min-w-0" },
        role === "subagent" && subagentLayout === "hierarchical"
          ? React.createElement(
              HierarchicalSelectForms,
              subagentModelSelect({
                provider: provider.id,
                assignment: provider.roles.subagent,
                agentModels: provider.agentModels,
                models,
                discovery: modelDiscovery,
                returnTo
              })
            )
          : null,
        React.createElement(RoleRow, {
          provider: provider.id,
          role,
          assignment: provider.roles[role],
          agentModels: provider.agentModels,
          models,
          discovery: modelDiscovery,
          subagentLayout,
          returnTo
        })
      ),
      ...(role === "subagent" && subagentLayout === "rows"
        ? provider.agentModels.map((entry) =>
            React.createElement(
              "li",
              { key: `agent-${entry.role}`, className: "flex min-w-0" },
              React.createElement(AgentModelRow, {
                provider: provider.id,
                entry,
                subagent: provider.roles.subagent,
                models,
                discovery: modelDiscovery,
                returnTo
              })
            )
          )
        : [])
    ])
  );
}

/**
 * The Subagent model, as one select with a level per target: "All subagents"
 * sets the Subagent role's model, and each agent role (`explorer`, `smart`,
 * ...) can be given a model of its own that wins over it. A role left on Auto
 * runs the Subagent model, or the tier's configured model when that is Auto
 * too; each level says which model that is.
 */
function subagentModelSelect({
  provider,
  assignment,
  agentModels,
  models,
  discovery,
  returnTo
}: {
  readonly provider: string;
  readonly assignment: ControlApiProviderRoleAssignment;
  readonly agentModels: readonly ControlApiProviderAgentModel[];
  readonly models: readonly ModelChoice[];
  readonly discovery: ProviderModelDiscoveryState;
  readonly returnTo: string;
}): HierarchicalSelectProps {
  const options = (current: string | null, auto: string) =>
    modelSelectOptions(discovery, provider, models, current, auto);
  const overrides = agentModels.filter(({ model }) => model !== null).length;
  const subagentModel = assignment.model ?? "Auto";
  return {
    id: `select-model-${provider}-subagent`,
    label: "Subagent model",
    summary: overrides === 0 ? subagentModel : `${subagentModel} +${overrides}`,
    disabledReason: roleModelDisabledReason(provider, assignment, discovery),
    levels: [
      {
        key: "subagent",
        label: "All subagents",
        current: subagentModel,
        selected: assignment.model ?? "",
        action: `/api/providers/${encodeURIComponent(provider)}/roles/subagent`,
        name: "model",
        hiddenFields: {
          provider,
          role: "subagent",
          returnTo,
          priority: priorityOptionSelected(assignment),
          reasoningEffort: assignment.reasoningEffort ?? ""
        },
        options: options(assignment.model, "Auto")
      },
      ...agentModels.map((entry) => {
        const auto = `Auto (${entry.tierModel ?? NOT_OBSERVED_LABEL})`;
        return {
          key: entry.role,
          label: entry.role,
          current: entry.model ?? auto,
          selected: entry.model ?? "",
          action: `/api/providers/${encodeURIComponent(provider)}/agents/${encodeURIComponent(entry.role)}`,
          name: "model",
          hiddenFields: { provider, role: entry.role, returnTo },
          options: options(entry.model, auto)
        };
      })
    ]
  };
}
