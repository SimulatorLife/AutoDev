import type {
  ControlApiEnablement,
  ProviderRole
} from "@simulatorlife/autodev-core";
import React from "react";

import { StatusBadge } from "../../components/status/StatusBadge.ts";

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

function EnablementToggle({
  kind,
  target,
  label,
  enablement,
  action,
  fields,
  returnTo
}: EnablementToggleProps): React.JSX.Element {
  const badge = React.createElement(StatusBadge, {
    status:
      enablement === undefined
        ? "not-observed"
        : enablement.enabled
          ? "valid"
          : "unavailable",
    label:
      enablement === undefined
        ? "Not observed"
        : enablement.enabled
          ? "Enabled"
          : "Disabled"
  });
  const unavailableReason =
    enablement === undefined
      ? NOT_OBSERVED_REASON
      : enablement.mutable
        ? null
        : IMMUTABLE_REASON;
  const nextEnabled = enablement === undefined ? true : !enablement.enabled;
  const buttonLabel = nextEnabled ? "Enable" : "Disable";

  return React.createElement(
    "div",
    {
      className: "flex flex-wrap items-center gap-2",
      "data-enablement": kind,
      "data-enablement-target": target
    },
    badge,
    React.createElement(
      "form",
      {
        method: "POST",
        action,
        className: "inline-flex items-center gap-2",
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
          title: unavailableReason ?? undefined,
          className:
            "rounded border border-border-strong bg-surface-raised px-2 py-0.5 text-xs font-medium text-fg hover:bg-hover disabled:cursor-not-allowed disabled:opacity-50"
        },
        buttonLabel
      )
    ),
    unavailableReason === null
      ? null
      : React.createElement(
          "span",
          {
            className: "text-xs text-fg-muted",
            "data-enablement-unavailable": "true"
          },
          unavailableReason
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

/** Shown after a toggle's change could not be confirmed by Runtime. */
export function ControlFailureNotice(): React.JSX.Element {
  return React.createElement(
    "div",
    {
      role: "status",
      "data-control-outcome": "failed",
      className:
        "rounded border border-warning/40 bg-warning/15 px-3 py-2 text-xs font-medium text-warning"
    },
    "The change could not be confirmed. Check the current state before retrying."
  );
}
