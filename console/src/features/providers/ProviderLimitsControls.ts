import type { ControlApiProviderRecord } from "@simulatorlife/autodev-core";
import React from "react";

import { Button } from "../../components/forms/Button.ts";
import { MUTED_META_CLASS } from "../../components/ui/text-classes.ts";

/**
 * The Agent Limits column: provider-wide concurrent-agent limits.
 *
 * The limits are provider-wide, not per-role, so the cell is one form holding
 * both steppers and the Unlimited control. One form is what makes the
 * server-rendered constraint workable: each control is a submit button carrying
 * the value it would set, and the form's hidden fields carry the state it would
 * change, so one submission always describes a complete pair of limits.
 *
 * The submit buttons deliberately use *different* field names (`setPerSession`,
 * `setAcrossSessions`, `setUnlimited`) from the hidden state fields
 * (`perSession`, `acrossSessions`). A button sharing a name with a hidden field
 * would produce two values under one name, and `URLSearchParams.get` returns the
 * first -- so the hidden state would win and the operator's new value would be
 * silently discarded.
 */

const MIN_LIMIT = 1;
const MAX_LIMIT = 999;

/** The submitted wire value for one axis: an integer, or `unlimited`. */
type AxisValue = number | null;

interface LimitAxis {
  /** Hidden state field, and the submit-button override name for that axis. */
  readonly name: "perSession" | "acrossSessions";
  readonly label: string;
}

const AXES: readonly LimitAxis[] = [
  { name: "perSession", label: "Per session" },
  { name: "acrossSessions", label: "Across sessions" }
];

/** The value the stepper submits, clamped to the range the steppers can produce. */
function stepped(current: AxisValue, delta: number): number {
  // An Unlimited axis starts from the minimum rather than from zero: zero is
  // not a limit, it would read as "no agents allowed", which is a different
  // decision from "no limit set" and would silently stop the provider spawning.
  const base = current ?? MIN_LIMIT;
  return Math.min(MAX_LIMIT, Math.max(MIN_LIMIT, base + delta));
}

function wire(value: AxisValue): string {
  return value === null ? "unlimited" : String(value);
}

/** What the stepper shows: the configured number, or ∞ for Unlimited. */
function display(value: AxisValue): string {
  return value === null ? "∞" : String(value);
}

function axisValue(
  provider: ControlApiProviderRecord,
  axis: LimitAxis
): AxisValue {
  // A null limits record represents the explicit Unlimited choice per the
  // core contract. Both axes render as Unlimited (∞) in that state.
  return provider.agentLimits === null ? null : provider.agentLimits[axis.name];
}

const STEP_BUTTON_CLASS =
  "inline-flex shrink-0 items-center justify-center leading-none";

/** One `− n +` stepper row. */
function LimitStepper({
  axis,
  value,
  provider
}: {
  readonly axis: LimitAxis;
  readonly value: AxisValue;
  readonly provider: string;
}): React.JSX.Element {
  return React.createElement(
    "div",
    {
      className: "flex min-w-0 flex-col items-start gap-1",
      "data-limit-stepper": `${provider}-${axis.name}`
    },
    React.createElement(
      "span",
      {
        className: `${MUTED_META_CLASS} shrink-0`
      },
      axis.label
    ),
    React.createElement(
      "span",
      { className: "flex shrink-0 items-center gap-1" },
      React.createElement(
        Button,
        {
          type: "submit",
          name: `set${axis.name.charAt(0).toUpperCase()}${axis.name.slice(1)}`,
          value: String(stepped(value, -1)),
          size: "icon",
          className: STEP_BUTTON_CLASS,
          ariaLabel: `Decrease ${axis.label.toLowerCase()} for ${provider}`,
          title: `Decrease ${axis.label.toLowerCase()}`,
          dataAttributes: { "data-step": `${provider}-${axis.name}-minus` }
        },
        "−"
      ),
      React.createElement(
        "span",
        {
          className:
            "inline-flex h-7 w-8 shrink-0 items-center justify-center text-center font-mono text-xs tabular-nums text-fg",
          "data-limit-value": `${provider}-${axis.name}`,
          ...(value === null ? { title: "Unlimited" } : {})
        },
        display(value)
      ),
      React.createElement(
        Button,
        {
          type: "submit",
          name: `set${axis.name.charAt(0).toUpperCase()}${axis.name.slice(1)}`,
          value: String(stepped(value, 1)),
          size: "icon",
          className: STEP_BUTTON_CLASS,
          ariaLabel: `Increase ${axis.label.toLowerCase()} for ${provider}`,
          title: `Increase ${axis.label.toLowerCase()}`,
          dataAttributes: { "data-step": `${provider}-${axis.name}-plus` }
        },
        "+"
      )
    )
  );
}

/**
 * The provider-level Disabled toggle.
 *
 * It posts to the enablement route rather than the limits route, because it is a
 * different fact about the provider, not a limit. Disabling preserves every
 * priority, model and limit, so re-enabling restores the configuration instead
 * of requiring it to be re-entered.
 */
function ProviderDisabledToggle({
  provider,
  returnTo
}: {
  readonly provider: ControlApiProviderRecord;
  readonly returnTo: string;
}): React.JSX.Element {
  return React.createElement(
    "form",
    {
      action: `/api/providers/${encodeURIComponent(provider.id)}`,
      method: "POST",
      className: "flex min-w-0 flex-col items-start gap-1",
      "data-provider-toggle-form": provider.id
    },
    React.createElement("input", {
      type: "hidden",
      name: "provider",
      value: provider.id
    }),
    React.createElement("input", {
      type: "hidden",
      name: "returnTo",
      value: returnTo
    }),
    React.createElement(
      Button,
      {
        type: "submit",
        name: "disabled",
        value: provider.disabled ? "false" : "true",
        variant: provider.disabled ? "outline" : "secondary",
        size: "compact",
        className: "inline-flex shrink-0 items-center gap-1.5",
        ariaLabel: provider.disabled
          ? "Enable provider " + provider.id
          : "Disable provider " + provider.id,
        title: provider.disabled
          ? "Enable this provider again, restoring its roles, models and limits."
          : "Disable this provider entirely, preserving its roles, models and limits.",
        dataAttributes: {
          "data-provider-disabled": provider.id,
          "data-checked": provider.disabled ? "true" : "false"
        }
      },
      React.createElement(
        "span",
        {
          className: `inline-flex h-3.5 w-6 shrink-0 items-center rounded-full border transition-colors p-0.5 ${
            provider.disabled
              ? "border-accent/60 bg-accent/15 justify-end"
              : "border-border-strong bg-surface justify-start"
          }`,
          "aria-hidden": "true"
        },
        React.createElement("span", {
          className: `h-2 w-2 rounded-full transition-transform ${
            provider.disabled ? "bg-accent" : "bg-fg-muted"
          }`
        })
      ),
      provider.disabled ? "Enable" : "Disable"
    ),
    provider.disabled
      ? React.createElement(
          "span",
          {
            className: `min-w-0 max-w-full break-words ${MUTED_META_CLASS} text-warning font-medium`
          },
          "Provider disabled"
        )
      : null
  );
}

/**
 * The Agent Limits cell for one provider.
 *
 * Sized and structured to fit the narrow Agent Limits column: each stepper
 * keeps its full label above its controls, and the two independent actions
 * stack instead of competing for half-width cells.
 */
export function ProviderLimitsControls({
  provider,
  returnTo
}: {
  readonly provider: ControlApiProviderRecord;
  readonly returnTo: string;
}): React.JSX.Element {
  const isUnlimited =
    provider.agentLimits === null ||
    (provider.agentLimits.perSession === null &&
      provider.agentLimits.acrossSessions === null);

  return React.createElement(
    "div",
    {
      className: "flex min-w-0 flex-col gap-2",
      "data-provider-limits": provider.id
    },
    React.createElement(
      "form",
      {
        action: `/api/providers/${encodeURIComponent(provider.id)}/limits`,
        method: "POST",
        className: "flex min-w-0 flex-col gap-2",
        "data-limit-form": provider.id
      },
      React.createElement("input", {
        type: "hidden",
        name: "provider",
        value: provider.id
      }),
      React.createElement("input", {
        type: "hidden",
        name: "returnTo",
        value: returnTo
      }),
      // The state the steppers change. Every submission carries both axes, so an
      // untouched axis is never inferred from somewhere else.
      ...AXES.map((axis) =>
        React.createElement("input", {
          key: `state-${axis.name}`,
          type: "hidden",
          name: axis.name,
          value: wire(axisValue(provider, axis))
        })
      ),
      ...AXES.map((axis) =>
        React.createElement(LimitStepper, {
          key: axis.name,
          axis,
          value: axisValue(provider, axis),
          provider: provider.id
        })
      ),
      React.createElement(
        "div",
        { className: "flex min-w-0 items-center" },
        React.createElement(
          Button,
          {
            type: "submit",
            name: "setUnlimited",
            value: "true",
            size: "compact",
            variant: "secondary",
            className: "inline-flex shrink-0 items-center gap-1.5",
            ariaLabel: `Set agent limits to Unlimited for ${provider.id}`,
            title:
              "Unlimited means no operator-set ceiling. This is not the same as a provider that was never configured.",
            dataAttributes: {
              "data-limit-unlimited": provider.id,
              "data-checked": isUnlimited ? "true" : "false"
            }
          },
          React.createElement(
            "span",
            {
              className: `inline-flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded border transition-colors ${
                isUnlimited
                  ? "border-accent bg-accent text-fg-inverse"
                  : "border-border-strong bg-surface"
              }`,
              "aria-hidden": "true"
            },
            isUnlimited
              ? React.createElement(
                  "span",
                  { className: "text-micro font-bold leading-none" },
                  "✓"
                )
              : null
          ),
          "Unlimited"
        )
      )
    ),
    React.createElement(ProviderDisabledToggle, { provider, returnTo })
  );
}
