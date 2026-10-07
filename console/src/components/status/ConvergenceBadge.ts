import type {
  ConvergenceStatus,
  OperationHistoryEntry,
  ReconciliationDiff,
  ReconciliationStatus
} from "@simulatorlife/autodev-core";
import React from "react";

import { MUTED_META_CLASS, MUTED_TEXT_CLASS } from "../ui/text-classes.ts";
import {
  NOT_OBSERVED_LABEL,
  StatusBadge,
  type StatusBadgeVariant
} from "./StatusBadge.ts";

/**
 * Convergence verdict as the shared status vocabulary.
 *
 * `pending` and `converged` map onto the badge variants that already mean
 * "awaiting observation" and "observed correct", so one component speaks one
 * language for health and for desired-vs-actual state.
 */
export function convergenceBadgeVariant(
  convergence: ConvergenceStatus
): StatusBadgeVariant {
  if (convergence === "converged") return "converged";
  if (convergence === "pending") return "pending";
  if (convergence === "error") return "error";
  return "not-observed";
}

/**
 * Desired-vs-actual state for one mutable item.
 *
 * The verdict is a badge; the Runtime-derived explanation and the desired /
 * observed generations are the hover title, so an operator can see why an item
 * is still converging without opening a second page. Nothing here is inferred
 * from configuration: an unobserved item stays `Not observed`.
 */
export function ConvergenceBadge({
  convergence,
  explanation,
  desiredGeneration,
  observedGeneration,
  lastError
}: {
  readonly convergence: ConvergenceStatus;
  readonly explanation: string;
  readonly desiredGeneration: string | null;
  readonly observedGeneration: string | null;
  readonly lastError: string | null;
}): React.JSX.Element {
  const lines = [explanation];
  if (desiredGeneration !== null) lines.push(`Desired: ${desiredGeneration}`);
  if (observedGeneration !== null)
    lines.push(`Observed: ${observedGeneration}`);
  if (lastError !== null) lines.push(`Last error: ${lastError}`);
  return React.createElement(StatusBadge, {
    status: convergenceBadgeVariant(convergence),
    // No `label`: the badge already names the state in the shared vocabulary.
    // Passing `convergence` through as the label rendered the raw wire key, so a
    // verdict read "converged" in lowercase here while every other badge read
    // "Converged" — and the one value that genuinely needed mapping,
    // `not-observed`, needed a hand-written special case that existed only
    // because this label was handed a string it should never have been given.
    ...(lines.length === 1 ? {} : { title: lines.join("\n") })
  });
}

const HISTORY_PANEL_CLASS = "mt-3 flex flex-col gap-2";
const HISTORY_ROW_CLASS =
  "flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-xs text-fg-muted";

/**
 * Render one reconciliation field. `null` means the Runtime has not observed it,
 * which must never render as an empty value that could read as "none".
 */
function fieldValue(value: string | null): string {
  return value ?? NOT_OBSERVED_LABEL;
}

function historyRow(entry: OperationHistoryEntry): React.JSX.Element {
  const detail = [entry.reason, entry.actor].filter(
    (part): part is string => typeof part === "string" && part.length > 0
  );
  return React.createElement(
    "li",
    {
      key: `${entry.timestamp}:${entry.action}`,
      className: HISTORY_ROW_CLASS,
      "data-history-outcome": entry.outcome
    },
    React.createElement(
      "span",
      { className: "font-mono text-fg-secondary" },
      entry.action
    ),
    React.createElement("span", null, entry.timestamp),
    React.createElement(
      "span",
      {
        className:
          entry.outcome === "ok"
            ? "text-success"
            : entry.outcome === "denied"
              ? "text-warning"
              : "text-error"
      },
      entry.outcome
    ),
    ...(detail.length === 0
      ? []
      : [React.createElement("span", { key: "detail" }, detail.join(" · "))])
  );
}

/**
 * Full desired-vs-actual panel for a mutable resource: the verdict, the
 * generations behind it, when the apply and observation happened, and the
 * bounded operation history for that resource.
 *
 * Everything here is Runtime-derived evidence. Absent evidence renders as
 * `Not observed`, never as an empty string or a zero.
 */
export function ReconciliationPanel({
  status,
  history,
  diff
}: {
  readonly status: ReconciliationStatus;
  readonly history: readonly OperationHistoryEntry[];
  readonly diff?: ReconciliationDiff | undefined;
}): React.JSX.Element {
  return React.createElement(
    "div",
    { className: HISTORY_PANEL_CLASS, "data-feature": "reconciliation" },
    React.createElement(
      "div",
      { className: "flex flex-wrap items-center gap-2" },
      React.createElement(ConvergenceBadge, {
        convergence: status.convergence,
        explanation: status.explanation,
        desiredGeneration: status.desiredGeneration,
        observedGeneration: status.observedGeneration,
        lastError: status.lastError
      })
    ),
    React.createElement(
      "p",
      { className: MUTED_META_CLASS },
      status.explanation
    ),
    React.createElement(
      "dl",
      {
        className:
          // `max-content_1fr`, not `1fr 1fr`: the labels are short and the
          // values are identifiers. A 50/50 split gave "Desired generation"
          // half the row to render in about a third of it, and starved the
          // 64-character generation hash of the width it needs -- so the
          // longest, most-worth-comparing value on the panel was the one that
          // wrapped, while the space beside every label went unused.
          "grid grid-cols-1 gap-1 text-xs text-fg-muted sm:grid-cols-[max-content_1fr]"
      },
      ...(
        [
          ["Desired generation", status.desiredGeneration],
          ["Observed generation", status.observedGeneration],
          ["Last apply", status.lastApplyAt],
          ["Last observation", status.lastObservationAt],
          ["Last error", status.lastError]
        ] as const
      ).flatMap(([label, value]) => [
        React.createElement(
          "dt",
          { key: `${label}-label`, className: MUTED_TEXT_CLASS },
          label
        ),
        React.createElement(
          "dd",
          {
            key: `${label}-value`,
            className: "font-mono text-fg-secondary break-all",
            "data-field": label.toLowerCase().replaceAll(/\s+/gu, "-")
          },
          fieldValue(value)
        )
      ])
    ),
    ...(diff === undefined
      ? []
      : [
          React.createElement(
            "p",
            {
              key: "diff",
              className: MUTED_META_CLASS,
              "data-field": "diff"
            },
            diff.summary
          )
        ]),
    history.length === 0
      ? React.createElement(
          "p",
          { className: MUTED_META_CLASS },
          "No recorded operations for this resource."
        )
      : React.createElement(
          "ul",
          { className: "m-0 flex list-none flex-col gap-1 p-0" },
          ...history.slice(0, 10).map((entry) => historyRow(entry))
        )
  );
}
