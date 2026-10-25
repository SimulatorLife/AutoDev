import type { ControlApiEnablement } from "@simulatorlife/autodev-core";
import React from "react";

import { NOT_OBSERVED_LABEL } from "../../components/status/StatusBadge.ts";
import {
  STATE_PILL_BUTTON_CLASS,
  STATE_PILL_TONE_CLASS,
  statePillName
} from "../../components/ui/state-pill.ts";

const NOT_OBSERVED_REASON =
  "Current state is not observed, so it cannot be changed here.";
const IMMUTABLE_REASON =
  "A current provider listing and a routeable Runtime model are required to change enablement.";

/**
 * Control chrome per state. The pill states the item's current value and its
 * activation applies the opposite, so one control carries both. Showing a
 * status badge next to a separate "Enable"/"Disable" button repeated the same
 * fact twice and forced every Providers row to wrap.
 */
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
  // One string for both the accessible name and the hover title.
  //
  // The name has to carry the state and the action, because the pill shows the
  // state and activates the opposite, and the title says the same thing
  // because a title is read out as the control's description.
  const name =
    unavailableReason === null
      ? statePillName(stateLabel, `${buttonLabel} ${model}`)
      : statePillName(stateLabel, unavailableReason);

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
        "aria-label": name,
        title: name,
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
        className: `${STATE_PILL_BUTTON_CLASS} ${STATE_PILL_TONE_CLASS[state]}`
      },
      stateLabel
    )
  );
}
