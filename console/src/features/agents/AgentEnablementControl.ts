import type { AgentEnablementState } from "@simulatorlife/autodev-core";
import React from "react";

import {
  NOT_OBSERVED_LABEL,
  NOT_OBSERVED_STATUS,
  StatusBadge
} from "../../components/status/StatusBadge.ts";
import { MUTED_META_CLASS } from "../../components/ui/text-classes.ts";

const UNAVAILABLE_LABEL = "Runtime did not report this agent's enablement.";

/**
 * Control chrome per state.
 *
 * The pill states the agent's current value and its activation applies the
 * opposite, so one control carries both. Showing a status badge next to a
 * separate "Enable"/"Disable" button would repeat the same fact twice and force
 * every Agents row to wrap.
 *
 * `warning/10` is deliberately not `WARNING_TONE_CLASS`'s `/15`: the hover
 * state here strengthens the border instead of tinting the fill, because a
 * heavier translucent background pulls the status text below the WCAG AA
 * contrast floor, and a pill that becomes unreadable on hover is not a hover
 * state. See the family note in `components/ui/tones.ts`.
 */
const PILL_CLASS = {
  // Hover strengthens the border instead of tinting the fill: a heavier
  // translucent background pulls the status text below the WCAG AA contrast
  // floor, and a pill that becomes unreadable on hover is not a hover state.
  on: "bg-success/15 text-success border-success/60 hover:border-success/70",
  off: "bg-warning/10 text-warning border-warning/60 hover:border-warning/70",
  unknown: "bg-neutral/15 text-fg-muted border-neutral/60"
} as const;

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
  return React.createElement(
    "div",
    { className: "inline-flex flex-col items-start gap-1" },
    React.createElement(
      "form",
      {
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
          "aria-label": `${presentation.buttonLabel} ${role}`,
          title: presentation.reason ?? `${presentation.buttonLabel} ${role}`,
          "data-enablement": "agent",
          "data-enablement-target": role,
          "data-status": presentation.status,
          ...(presentation.reason === null
            ? {}
            : { "data-enablement-unavailable": "true" }),
          className: `whitespace-nowrap rounded border px-2 py-0.5 text-xs font-medium transition-colors disabled:cursor-not-allowed ${PILL_CLASS[presentation.state]}`
        },
        presentation.stateLabel
      )
    ),
    convergenceNotice(enablement, convergence)
  );
}
