import type {
  ControlApiEnablement,
  ProviderRole
} from "@simulatorlife/autodev-core";
import React from "react";

import { NOT_OBSERVED_LABEL } from "../../components/status/StatusBadge.ts";

/**
 * The one enable/disable control for Providers items. Provider-role and model
 * toggles render through it wherever their item appears (list row, detail
 * view, or a parent detail's child row), so every placement posts the same
 * bounded same-origin form to the same typed Console route and shows the same
 * state vocabulary. The control never applies optimistic state: the page that
 * renders after the redirect shows the Runtime-confirmed value.
 */
interface EnablementToggleProps {
  readonly kind: "provider-role" | "model";
  /** Stable identity of the controlled item, e.g. `claude/orchestrator`. */
  readonly target: string;
  /** Accessible name of the controlled item, e.g. `claude orchestrator role`. */
  readonly label: string;
  readonly enablement: ControlApiEnablement | undefined;
  readonly action: string;
  readonly fields: Readonly<Record<string, string>>;
  readonly returnTo: string;
}

const NOT_OBSERVED_REASON =
  "Current state is not observed, so it cannot be changed here.";
const IMMUTABLE_REASON = "Runtime reports this setting as read-only.";

/**
 * Control chrome per state. The pill states the item's current value and its
 * activation applies the opposite, so one control carries both. Showing a
 * status badge next to a separate "Enable"/"Disable" button repeated the same
 * fact twice and forced every Providers row to wrap.
 */
const PILL_CLASS = {
  // Hover strengthens the border instead of tinting the fill: a heavier
  // translucent background pulls the status text below the WCAG AA contrast
  // floor, and a pill that becomes unreadable on hover is not a hover state.
  on: "bg-success/15 text-success border-success/40 hover:border-success/70",
  off: "bg-warning/10 text-warning border-warning/40 hover:border-warning/70",
  unknown: "bg-neutral/15 text-fg-muted border-neutral/40"
} as const;

function EnablementToggle({
  kind,
  target,
  label,
  enablement,
  action,
  fields,
  returnTo
}: EnablementToggleProps): React.JSX.Element {
  const state =
    enablement === undefined ? "unknown" : enablement.enabled ? "on" : "off";
  const stateLabel =
    state === "unknown"
      ? NOT_OBSERVED_LABEL
      : state === "on"
        ? "Enabled"
        : "Disabled";
  const unavailableReason =
    enablement === undefined
      ? NOT_OBSERVED_REASON
      : enablement.mutable
        ? null
        : IMMUTABLE_REASON;
  const nextEnabled = enablement === undefined ? true : !enablement.enabled;
  const buttonLabel = nextEnabled ? "Enable" : "Disable";

  return React.createElement(
    "form",
    {
      method: "POST",
      action,
      className: "inline-flex",
      "data-enablement-form": kind
    },
    ...Object.entries(fields).map(([name, value]) =>
      React.createElement("input", {
        key: name,
        type: "hidden",
        name,
        value
      })
    ),
    React.createElement("input", {
      type: "hidden",
      name: "enabled",
      value: String(nextEnabled)
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
        disabled: unavailableReason !== null,
        "aria-label": `${buttonLabel} ${label}`,
        title: unavailableReason ?? `${buttonLabel} ${label}`,
        "data-enablement": kind,
        "data-enablement-target": target,
        "data-status":
          state === "on"
            ? "valid"
            : state === "off"
              ? "unavailable"
              : "not-observed",
        ...(unavailableReason === null
          ? {}
          : { "data-enablement-unavailable": "true" }),
        className: `whitespace-nowrap rounded border px-2 py-0.5 text-xs font-medium transition-colors disabled:cursor-not-allowed ${PILL_CLASS[state]}`
      },
      stateLabel
    )
  );
}

export function ProviderRoleToggle({
  provider,
  role,
  enablement,
  returnTo
}: {
  readonly provider: string;
  readonly role: ProviderRole;
  readonly enablement: ControlApiEnablement | undefined;
  readonly returnTo: string;
}): React.JSX.Element {
  return React.createElement(EnablementToggle, {
    kind: "provider-role",
    target: `${provider}/${role}`,
    label: `${provider} ${role} role`,
    enablement,
    action: `/api/providers/${encodeURIComponent(provider)}/roles/${role}`,
    fields: { provider, role },
    returnTo
  });
}

export function ModelToggle({
  model,
  enablement,
  returnTo
}: {
  readonly model: string;
  readonly enablement: ControlApiEnablement | undefined;
  readonly returnTo: string;
}): React.JSX.Element {
  return React.createElement(EnablementToggle, {
    kind: "model",
    target: model,
    label: `model ${model}`,
    enablement,
    action: `/api/models/${encodeURIComponent(model)}`,
    fields: { model },
    returnTo
  });
}
