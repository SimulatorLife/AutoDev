import type { AgentEnablementState } from "@simulatorlife/autodev-core";
import React from "react";

import {
  NOT_OBSERVED_LABEL,
  NOT_OBSERVED_STATUS,
  StatusBadge
} from "../../components/status/StatusBadge.ts";
import { namedAfterVisible } from "../../components/ui/accessible-name.ts";
import {
  STATE_PILL_BUTTON_CLASS,
  STATE_PILL_TONE_CLASS
} from "../../components/ui/state-pill.ts";
import { MUTED_META_CLASS } from "../../components/ui/text-classes.ts";

const UNAVAILABLE_LABEL = "Runtime did not report this agent's enablement.";

/**
 * Control chrome per state.
 *
 * The pill states the agent's current value and its activation applies the
 * opposite, so one control carries both. Showing a status badge next to a
 * separate "Enable"/"Disable" button would repeat the same fact twice and force
 * every Agents row to wrap.
 */
type AgentEnablementVisualState = "on" | "off" | "unknown";

function presentationFor(enablement: AgentEnablementState): {
  readonly state: AgentEnablementVisualState;
  readonly status: "enabled" | "disabled" | typeof NOT_OBSERVED_STATUS;
  readonly stateLabel: string;
  readonly reason: string | null;
  readonly nextEnabled: boolean;
  readonly revision: string;
  readonly buttonLabel: string;
} {
  if (enablement.kind === "unavailable") {
    return {
      state: "unknown",
      status: NOT_OBSERVED_STATUS,
      stateLabel: NOT_OBSERVED_LABEL,
      reason: enablement.reason || UNAVAILABLE_LABEL,
      nextEnabled: true,
      revision: "",
      buttonLabel: "Enable"
    };
  }
  const state = enablement.enabled ? "on" : "off";
  const nextEnabled = !enablement.enabled;
  return {
    state,
    status: enablement.enabled ? "enabled" : "disabled",
    stateLabel: enablement.enabled ? "Enabled" : "Disabled",
    reason: null,
    nextEnabled,
    revision: enablement.revision,
    buttonLabel: nextEnabled ? "Enable" : "Disable"
  };
}

function convergenceNotice(
  enablement: AgentEnablementState,
  convergence: "converged" | "pending" | "error" | "not-observed"
): React.ReactNode {
  if (enablement.kind === "unavailable")
    return React.createElement(
      "span",
      { className: MUTED_META_CLASS, role: "note" },
      enablement.reason || UNAVAILABLE_LABEL
    );
  if (convergence === "pending")
    return React.createElement(
      "span",
      { role: "status", "data-enablement-pending": "true" },
      React.createElement(StatusBadge, { status: "pending" })
    );
  if (convergence === "error")
    return React.createElement(
      "span",
      { role: "status", "data-enablement-pending": "true" },
      React.createElement(StatusBadge, { status: "error", label: "Failed" })
    );
  return null;
}

/**
 * The one enable/disable control for an agent role. It renders wherever an
 * agent appears -- its own Agents row, its detail view -- so every placement
 * posts the same bounded same-origin form to the same typed Console route and
 * shows the same state vocabulary. The control never applies optimistic state:
 * the page that renders after the redirect shows the Runtime-confirmed value.
 *
 * `AgentEnablementState` carries the Runtime's own verdict: `observed` is a
 * mutable enablement with a revision the next write must echo, and `unavailable`
 * is a nonmutable reason. The control disables itself when `mutable` is false
 * so the form cannot submit a write the Runtime would refuse.
 */
export function AgentEnablementControl({
  role,
  enablement,
  returnTo,
  convergence
}: {
  readonly role: string;
  readonly enablement: AgentEnablementState;
  readonly returnTo: string;
  readonly convergence: "converged" | "pending" | "error" | "not-observed";
}): React.JSX.Element {
  const presentation = presentationFor(enablement);
  // One string for both the accessible name and the hover title.
  //
  // The name has to carry the state and the action, because the pill shows the
  // state and activates the opposite. Naming only the action left the state
  // reachable by sight alone: every row's pill announced "Disable <role>", so a
  // screen reader could not tell an enabled agent from a disabled one.
  //
  // The title says the same thing, because a title is read out as the
  // control's description: a title that carried only the action made the
  // control announce its action twice.
  const name =
    presentation.reason === null
      ? namedAfterVisible(
          presentation.stateLabel,
          `${presentation.buttonLabel} ${role}`
        )
      : namedAfterVisible(presentation.stateLabel, presentation.reason);
  return React.createElement(
    "div",
    { className: "inline-flex flex-col items-start gap-1" },
    React.createElement(
      // A write surface inside a table cell is a group of controls rather
      // than a landmark: the operator finds it in the cell, and an
      // anonymous landmark for every row is a list of names that name nothing.
      "form",
      {
        role: "group",
        method: "POST",
        action: `/api/agents/${encodeURIComponent(role)}`,
        className: "inline-flex",
        "data-enablement-form": "agent"
      },
      React.createElement("input", {
        type: "hidden",
        name: "role",
        value: role
      }),
      React.createElement("input", {
        type: "hidden",
        name: "enabled",
        value: String(presentation.nextEnabled)
      }),
      React.createElement("input", {
        type: "hidden",
        name: "expectedRevision",
        value: presentation.revision
      }),
      React.createElement("input", {
        type: "hidden",
        name: "returnTo",
        value: returnTo
      }),
      React.createElement(
        "button",
        {
          type: "submit",
          disabled: presentation.reason !== null,
          // The name carries the state and the action, because the pill shows
          // the state and activates the opposite. Naming only the action left
          // the state reachable by sight alone: every row's pill announced
          // "Disable <role>", so a screen reader could not tell an enabled
          // agent from a disabled one.
          "aria-label": name,
          title: name,
          "data-enablement": "agent",
          "data-enablement-target": role,
          "data-status": presentation.status,
          ...(presentation.reason === null
            ? {}
            : { "data-enablement-unavailable": "true" }),
          className: `${STATE_PILL_BUTTON_CLASS} ${STATE_PILL_TONE_CLASS[presentation.state]}`
        },
        presentation.stateLabel
      )
    ),
    convergenceNotice(enablement, convergence)
  );
}
