import type {
  EvaluationMetric,
  EvaluationOutcome,
  EvaluationReferenceStatus,
  EvaluationResult,
  EvaluationResultSubject,
  EvaluationRunStatus,
  EvaluationVerdict
} from "@simulatorlife/autodev-core";
import React from "react";

import {
  StatusBadge,
  type StatusBadgeVariant
} from "../../components/status/StatusBadge.ts";

const OUTCOME_BADGES: Readonly<
  Record<EvaluationOutcome, { status: StatusBadgeVariant; label: string }>
> = {
  passed: { status: "valid", label: "Passed" },
  failed: { status: "invalid", label: "Failed" },
  error: { status: "error", label: "Error" },
  unknown: { status: "not-observed", label: "Unknown" }
};

const RUN_BADGES: Readonly<
  Record<EvaluationRunStatus, { status: StatusBadgeVariant; label: string }>
> = {
  running: { status: "pending", label: "Running" },
  completed: { status: "converged", label: "Completed" },
  incomplete: { status: "unavailable", label: "Incomplete" },
  failed: { status: "error", label: "Failed" }
};

const REFERENCE_LABELS: Readonly<Record<EvaluationReferenceStatus, string>> = {
  resolved: "Resolved",
  unknown_agent: "Unknown agent",
  unknown_model: "Unknown model",
  unknown_prompt: "Unknown prompt"
};

const VERDICT_STYLES: Readonly<Record<EvaluationVerdict, string>> = {
  pass: "bg-emerald-950/60 text-emerald-300 border-emerald-800",
  fail: "bg-rose-950/60 text-rose-300 border-rose-800",
  unknown: "bg-slate-800 text-slate-300 border-slate-700"
};

export const NOT_OBSERVED = "Not observed";

export function OutcomeBadge({
  outcome
}: {
  readonly outcome: EvaluationOutcome;
}): React.JSX.Element {
  return React.createElement(StatusBadge, OUTCOME_BADGES[outcome]);
}

export function RunStatusBadge({
  status
}: {
  readonly status: EvaluationRunStatus;
}): React.JSX.Element {
  return React.createElement(StatusBadge, RUN_BADGES[status]);
}

export function ReferenceBadge({
  status
}: {
  readonly status: EvaluationReferenceStatus;
}): React.JSX.Element {
  return React.createElement(StatusBadge, {
    status: status === "resolved" ? "valid" : "invalid",
    label: REFERENCE_LABELS[status]
  });
}

/** A rate renders as a percentage only when it was observed. */
export function formatRate(rate: number | null): string {
  return rate === null ? NOT_OBSERVED : `${Math.round(rate * 100)}%`;
}

export function formatDelta(delta: number | null): string {
  if (delta === null) return NOT_OBSERVED;
  const points = Math.round(delta * 100);
  return `${points > 0 ? "+" : ""}${points} pts`;
}

export function formatScore(score: number | null): string {
  return score === null ? "—" : score.toFixed(2);
}

export function subjectLabel(subject: EvaluationResultSubject): string {
  if (subject.targetKey) return subject.targetKey;
  const parts = [
    subject.agent ? `agent:${subject.agent}` : null,
    subject.model ? `model:${subject.model}` : null,
    subject.prompt ? `prompt:${subject.prompt}` : null
  ].filter((part): part is string => part !== null);
  return parts.length > 0 ? parts.join(" ") : NOT_OBSERVED;
}

export function MetricChips({
  metrics
}: {
  readonly metrics: readonly EvaluationMetric[];
}): React.JSX.Element {
  if (metrics.length === 0) {
    return React.createElement(
      "span",
      { className: "text-xs text-slate-500" },
      "No metrics recorded"
    );
  }
  return React.createElement(
    "div",
    { className: "flex flex-wrap gap-1.5" },
    metrics.map((metric) =>
      React.createElement(
        "span",
        {
          key: metric.name,
          "data-verdict": metric.verdict,
          title:
            metric.threshold === null
              ? `${metric.name}: verdict recorded by the producer`
              : `${metric.name}: fails above ${metric.threshold}`,
          className: `text-xs px-2 py-0.5 rounded font-mono border ${VERDICT_STYLES[metric.verdict]}`
        },
        `${metric.name} ${formatScore(metric.score)}`
      )
    )
  );
}

/** URL of the result panel, preserving the page's other query state. */
export function resultHref(
  basePath: string,
  params: Readonly<Record<string, string | null | undefined>>,
  result: Pick<EvaluationResult, "id">
): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value) search.set(key, value);
  }
  search.set("result", result.id);
  return `${basePath}?${search.toString()}`;
}

export function SectionHeading({
  children
}: {
  readonly children?: React.ReactNode;
}): React.JSX.Element {
  return React.createElement(
    "h2",
    {
      className:
        "text-sm font-semibold uppercase tracking-wider text-slate-400 mb-3"
    },
    children
  );
}

export function InlineAlert({
  tone,
  title,
  children
}: {
  readonly tone: "error" | "warning" | "info";
  readonly title: string;
  readonly children?: React.ReactNode;
}): React.JSX.Element {
  const styles = {
    error: "border-rose-800 bg-rose-950/40 text-rose-100",
    warning: "border-amber-800 bg-amber-950/30 text-amber-100",
    info: "border-sky-800 bg-sky-950/30 text-sky-100"
  } as const;
  return React.createElement(
    "div",
    {
      role: tone === "info" ? "status" : "alert",
      "data-tone": tone,
      className: `rounded-lg border p-4 text-sm flex flex-col gap-1 ${styles[tone]}`
    },
    React.createElement("p", { className: "font-semibold" }, title),
    children
  );
}
