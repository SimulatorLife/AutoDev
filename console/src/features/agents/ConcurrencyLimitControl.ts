import type { ControlApiConcurrencyStatus } from "@simulatorlife/autodev-core";
import React from "react";

import { Button } from "../../components/forms/Button.ts";
import { NOT_OBSERVED_LABEL } from "../../components/status/StatusBadge.ts";
import {
  MUTED_META_CLASS,
  MUTED_TEXT_CLASS
} from "../../components/ui/text-classes.ts";

export interface ConcurrencyLimitControlProps {
  readonly concurrency?: ControlApiConcurrencyStatus | undefined;
  readonly returnTo: string;
}

const MIN_LIMIT = 0;
const MAX_LIMIT = 999;
const DEFAULT_STEP_LIMIT = 8;

const STEP_BUTTON_CLASS =
  "inline-flex shrink-0 items-center justify-center leading-none";

function stepped(
  current: number | null | undefined,
  delta: number,
  fallbackLimit?: number | null
): number {
  if (current === null || current === undefined) {
    const base =
      fallbackLimit !== null && fallbackLimit !== undefined
        ? fallbackLimit
        : DEFAULT_STEP_LIMIT;
    return Math.min(
      MAX_LIMIT,
      Math.max(MIN_LIMIT, base + (delta < 0 ? -1 : 1))
    );
  }
  return Math.min(MAX_LIMIT, Math.max(MIN_LIMIT, current + delta));
}

function display(value: number | null | undefined): string {
  if (value === undefined) return NOT_OBSERVED_LABEL;
  return value === null ? "∞" : String(value);
}

/**
 * What the config file declares, in the operator's words.
 *
 * The limit is absent when the file was there and could not be read, and that
 * is not a file that declares no limit: it says the cap the operator
 * configured is not the cap in force. So the three states keep three words.
 */
function configFileLimitLabel(limit: number | null | undefined): string {
  if (limit === undefined) return "not read";
  if (limit === null) return "Unlimited";
  return String(limit);
}

/**
 * Interactive concurrency control for orchestrator subagent threads.
 *
 * Provides stepper (− / +), explicit Unlimited selection, and reset-to-config
 * when a runtime stored override is in effect. Monotonically tracks revision
 * to detect and refuse conflicting concurrent operator edits.
 */
export function ConcurrencyLimitControl({
  concurrency,
  returnTo
}: ConcurrencyLimitControlProps): React.JSX.Element {
  if (!concurrency || concurrency.effectivePerSessionLimit === undefined) {
    return React.createElement(
      "span",
      { className: MUTED_META_CLASS, "data-status": "not-observed" },
      NOT_OBSERVED_LABEL
    );
  }

  const effectiveLimit = concurrency.effectivePerSessionLimit;
  const isUnlimited = effectiveLimit === null;
  const isStoredOverride = concurrency.configSource === "stored_override";
  const configFileLimit = concurrency.maxConcurrentThreadsPerSession;

  return React.createElement(
    // A write surface inside a table cell is a group of controls rather
    // than a landmark: the operator finds it in the cell, and an
    // anonymous landmark for every row is a list of names that name nothing.
    "form",
    {
      role: "group",
      action: "/api/agents/concurrency",
      method: "POST",
      className: "flex flex-col items-start gap-1.5",
      "data-concurrency-form": "true"
    },
    React.createElement("input", {
      type: "hidden",
      name: "returnTo",
      value: returnTo
    }),
    concurrency.revision === undefined
      ? null
      : React.createElement("input", {
          type: "hidden",
          name: "revision",
          value: String(concurrency.revision)
        }),
    React.createElement(
      "div",
      { className: "flex flex-wrap items-center gap-2" },
      React.createElement(
        "div",
        {
          className: "inline-flex items-center gap-1",
          "data-concurrency-stepper": "true"
        },
        React.createElement(
          Button,
          {
            type: "submit",
            name: "setLimit",
            value: String(stepped(effectiveLimit, -1, configFileLimit)),
            size: "icon",
            className: STEP_BUTTON_CLASS,
            ariaLabel: "Decrease session concurrency limit",
            title: "Decrease session concurrency limit",
            dataAttributes: { "data-step": "concurrency-minus" }
          },
          "−"
        ),
        React.createElement(
          "span",
          {
            className:
              "inline-flex h-7 w-8 shrink-0 items-center justify-center text-center font-mono text-xs tabular-nums text-fg border border-border rounded bg-surface",
            "data-concurrency-value": String(effectiveLimit),
            ...(isUnlimited ? { title: "Unlimited (no ceiling)" } : {})
          },
          display(effectiveLimit)
        ),
        React.createElement(
          Button,
          {
            type: "submit",
            name: "setLimit",
            value: String(stepped(effectiveLimit, 1, configFileLimit)),
            size: "icon",
            className: STEP_BUTTON_CLASS,
            ariaLabel: "Increase session concurrency limit",
            title: "Increase session concurrency limit",
            dataAttributes: { "data-step": "concurrency-plus" }
          },
          "+"
        )
      ),
      React.createElement(
        Button,
        {
          type: "submit",
          name: "setUnlimited",
          value: "true",
          size: "compact",
          variant: "secondary",
          className: "inline-flex shrink-0 items-center gap-1.5",
          ariaLabel: "Set session concurrency limit to Unlimited",
          title:
            "Unlimited means no per-session subagent ceiling. Agents can spawn up to system capacity.",
          dataAttributes: {
            "data-concurrency-unlimited": "true",
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
      ),
      isStoredOverride
        ? React.createElement(
            Button,
            {
              type: "submit",
              name: "resetToConfigFile",
              value: "true",
              size: "compact",
              variant: "outline",
              className: "inline-flex shrink-0 items-center gap-1 text-xs",
              ariaLabel: "Reset session concurrency limit to config file",
              title: "Clear stored override and restore limit from config file",
              dataAttributes: { "data-concurrency-reset": "true" }
            },
            "Reset to config"
          )
        : null
    ),
    React.createElement(
      "div",
      { className: "flex flex-wrap items-center gap-1.5 text-xs" },
      isStoredOverride
        ? React.createElement(
            "span",
            {
              className: "text-warning font-medium",
              "data-concurrency-source": "stored_override"
            },
            "Stored override active",
            ` (config file: ${configFileLimitLabel(configFileLimit)})`
          )
        : React.createElement(
            "span",
            {
              className: MUTED_TEXT_CLASS,
              "data-concurrency-source": concurrency.configSource ?? "default"
            },
            // The config file's limit is absent when the file was there and
            // could not be read. "From config file" would then be a claim about
            // a file nobody read, and the limit in force is the router's
            // default rather than the one that was configured.
            configFileLimit === undefined
              ? "Config file not read"
              : concurrency.configSource === "config_file"
                ? "From config file"
                : "Default configuration"
          ),
      concurrency.revision === undefined
        ? null
        : React.createElement(
            "span",
            {
              className: `${MUTED_TEXT_CLASS} tabular-nums`,
              "data-concurrency-revision": String(concurrency.revision)
            },
            `• rev ${concurrency.revision}`
          )
    )
  );
}
