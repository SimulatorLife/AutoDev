import type { ControlApiEnablement } from "@simulatorlife/autodev-core";
import React from "react";

import { NOT_OBSERVED_LABEL } from "../../components/status/StatusBadge.ts";

const NOT_OBSERVED_REASON =
  "Current state is not observed, so it cannot be changed here.";
const IMMUTABLE_REASON = "Runtime reports this setting as read-only.";

/**
 * Control chrome per state. The pill states the item's current value and its
 * activation applies the opposite, so one control carries both. Showing a
 * status badge next to a separate "Enable"/"Disable" button repeated the same
 * fact twice and forced every Providers row to wrap.
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
  on: "bg-success/15 text-success border-success/40 hover:border-success/70",
  off: "bg-warning/10 text-warning border-warning/40 hover:border-warning/70",
  unknown: "bg-neutral/15 text-fg-muted border-neutral/40"
} as const;

/**
 * The one enable/disable control for a model. It renders wherever a model
 * appears -- its own Models row, its detail view, or the model list inside a
 * provider's detail view -- so every placement posts the same bounded
 * same-origin form to the same typed Console route and shows the same state
 * vocabulary. The control never applies optimistic state: the page that renders
 * after the redirect shows the Runtime-confirmed value.
 *
 * Provider roles deliberately do not use this control. A role is not on or off
 * -- it carries a priority in `P1|P2|P3|Disabled` and a model -- so it is edited
 * through `ProviderRoleControls`, which submits both. This file used to also
 * export a role toggle that posted a boolean `enabled`; nothing rendered it
 * after the four-column table shipped, and the role route no longer accepts
 * that body at all, so keeping it would have left a control that silently
 * failed every submission.
 */
export function ModelToggle({
  model,
  enablement,
  returnTo
}: {
  readonly model: string;
  readonly enablement: ControlApiEnablement | undefined;
  readonly returnTo: string;
}): React.JSX.Element {
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
      action: `/api/models/${encodeURIComponent(model)}`,
      className: "inline-flex",
      "data-enablement-form": "model"
    },
    React.createElement("input", {
      type: "hidden",
      name: "model",
      value: model
    }),
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
        "aria-label": `${buttonLabel} ${model}`,
        title: unavailableReason ?? `${buttonLabel} ${model}`,
        "data-enablement": "model",
        "data-enablement-target": model,
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