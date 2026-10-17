import type {
  ControlApiPlaytestingEpisodeDetailResponse,
  ControlApiPlaytestingWindowResponse,
  PlaytestJsonValue,
  PlaytestReviewClaim
} from "@simulatorlife/autodev-core";
import React from "react";

import { SECTION_HEADING_CLASS } from "../../components/layout/Heading.ts";
import { PageBody } from "../../components/layout/PageBody.ts";
import { LIST_PANEL_CLASS } from "../../components/layout/Panel.ts";
import { NavigationLink } from "../../components/navigation/NavigationLink.ts";
import { DetailGrid } from "../../components/panels/DetailGrid.ts";
import { EmptyState } from "../../components/status/EmptyState.ts";
import {
  NOT_OBSERVED_LABEL,
  NOT_OBSERVED_STATUS,
  StatusBadge
} from "../../components/status/StatusBadge.ts";
import {
  MONO_ID_CLASS,
  MONO_VALUE_CLASS,
  MUTED_BODY_CLASS,
  MUTED_META_CLASS,
  SECTION_LABEL_CLASS
} from "../../components/ui/text-classes.ts";
import {
  defaultEpisodeInspectionStep,
  executionModeLabel,
  executionSourceSummary,
  executionStatusBadge,
  gameOutcomeBadge
} from "./playtesting-episode-presentation.ts";
import {
  playtestingAnalyzeEpisodeHref,
  playtestingEpisodeHref,
  playtestingInspectorBackHref,
  type PlaytestingScope
} from "./playtesting-url.ts";

const EVIDENCE_LINK_CLASS = "text-xs text-accent hover:underline";

/** A JSON object read off a recorded trace line. */
type TraceRecord = Readonly<Record<string, unknown>>;

export interface PlaytestingSessionViewProps {
  readonly detail: ControlApiPlaytestingEpisodeDetailResponse;
  readonly scope: PlaytestingScope;
  readonly window: ControlApiPlaytestingWindowResponse | null;
  readonly windowUnavailable?: string | undefined;
}

function heading(id: string, title: string): React.JSX.Element {
  return React.createElement(
    "h2",
    { id, className: SECTION_HEADING_CLASS },
    title
  );
}

function renderJson(value: PlaytestJsonValue): string {
  return JSON.stringify(value, null, 2);
}

/** Keys that name a nested object, used to read an identifier out of one. */
const NAMED_SCALAR_KEYS = [
  "actionId",
  "eventId",
  "phaseId",
  "id",
  "name",
  "type"
] as const;

function asTraceRecord(value: unknown): TraceRecord | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  return value as TraceRecord;
}

/**
 * The recorded scalar behind one field, or null when the line does not record
 * it. A nested object is read through its own identifier field, so an action
 * object still yields its actionId. Anything richer than a scalar or a named
 * object is left to the full JSON disclosure rather than summarized: a summary
 * that guesses at structure would be an explanation the trace never made.
 */
function recordedScalar(value: unknown): string | null {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? String(value) : null;
  }
  if (typeof value === "boolean") return String(value);
  const record = asTraceRecord(value);
  if (record === null) return null;
  for (const key of NAMED_SCALAR_KEYS) {
    const text = recordedScalar(record[key]);
    if (text !== null) return text;
  }
  return null;
}

/** First recorded value for these keys, scanning the given records in order. */
function readRecorded(
  records: readonly (TraceRecord | null)[],
  keys: readonly string[]
): string | null {
  for (const record of records) {
    if (record === null) continue;
    for (const key of keys) {
      if (!(key in record)) continue;
      const text = recordedScalar(record[key]);
      if (text !== null) return text;
    }
  }
  return null;
}

/**
 * The scan dimensions of one trace line, each read only from fields the line
 * actually records. Every dimension can legitimately be absent -- a line that
 * records only an event id has no action -- so absence stays null all the way
 * to the view, which reports it as unrecorded rather than filling it in.
 */
interface TraceStepFacts {
  readonly step: number | null;
  readonly lineKind: string | null;
  readonly eventType: string | null;
  readonly eventId: string | null;
  readonly actionId: string | null;
  readonly phase: string | null;
  readonly tick: string | null;
  readonly severity: string | null;
}

function recordedValues(
  records: readonly (TraceRecord | null)[],
  keys: readonly string[]
): string | null {
  const values = records
    .map((record) => readRecorded([record], keys))
    .filter((value): value is string => value !== null);
  const unique = [...new Set(values)];
  return unique.length > 0 ? unique.join(", ") : null;
}

function traceStepFacts(entry: PlaytestJsonValue): TraceStepFacts {
  const top = asTraceRecord(entry);
  const nestedEvent = asTraceRecord(top?.event);
  const events = Array.isArray(top?.events)
    ? top.events.map(asTraceRecord)
    : nestedEvent === null
      ? []
      : [nestedEvent];
  const action = asTraceRecord(top?.action);
  const phase = asTraceRecord(top?.phase);
  const visibleObservation = asTraceRecord(top?.visibleObservation);
  return {
    step: stepFor(entry),
    lineKind: readRecorded([top], ["type", "kind", "recordType"]),
    // Game traces commonly record an ordered `events` array rather than one
    // nested event. Summarize only names and IDs that are actually present.
    eventType:
      recordedValues(events, ["type", "name", "eventType"]) ??
      readRecorded([top], ["eventType", "eventName", "eventKind"]),
    eventId:
      recordedValues(events, ["eventId", "id"]) ??
      readRecorded([top], ["eventId"]),
    actionId:
      readRecorded([action], ["actionId", "name", "id"]) ??
      readRecorded([top], ["selectedActionId", "actionId", "action"]),
    phase:
      readRecorded([phase], ["phaseId", "name", "id"]) ??
      readRecorded([top], ["phaseId", "phase", "stage"]) ??
      readRecorded([visibleObservation], ["phaseId"]),
    tick:
      readRecorded([top], ["tick", "tickIndex", "logicalTick"]) ??
      recordedValues(events, ["tick", "tickIndex"]),
    severity:
      readRecorded([top], ["severity", "level"]) ??
      recordedValues(events, ["severity", "level"])
  };
}

function stepFor(entry: PlaytestJsonValue): number | null {
  if (typeof entry !== "object" || entry === null || Array.isArray(entry))
    return null;
  const record = entry as Readonly<Record<string, unknown>>;
  if (Number.isSafeInteger(record.step) && (record.step as number) >= 0) {
    return record.step as number;
  }
  const event = record.event;
  if (
    typeof event === "object" &&
    event !== null &&
    !Array.isArray(event) &&
    Number.isSafeInteger((event as Readonly<Record<string, unknown>>).step)
  ) {
    return (event as Readonly<Record<string, unknown>>).step as number;
  }
  return null;
}

function metricTable(
  episode: ControlApiPlaytestingEpisodeDetailResponse["record"]
): React.JSX.Element {
  if (episode.metrics.length === 0) {
    return React.createElement(EmptyState, {
      variant: "inline",
      message: "No deterministic metric results were recorded for this episode."
    });
  }
  return React.createElement(
    "div",
    { className: "overflow-x-auto" },
    React.createElement(
      "table",
      {
        className: "w-full text-left text-sm",
        "aria-label": "Deterministic episode metrics"
      },
      React.createElement(
        "thead",
        null,
        React.createElement(
          "tr",
          { className: "border-b border-border text-xs text-fg-muted" },
          React.createElement(
            "th",
            { scope: "col", className: "py-2 pr-4" },
            "Metric"
          ),
          React.createElement(
            "th",
            { scope: "col", className: "py-2 pr-4" },
            "Estimate"
          ),
          React.createElement(
            "th",
            { scope: "col", className: "py-2 pr-4" },
            "Numerator / denominator"
          ),
          React.createElement(
            "th",
            { scope: "col", className: "py-2 pr-4" },
            "Coverage"
          )
        )
      ),
      React.createElement(
        "tbody",
        null,
        ...episode.metrics.map((metric) =>
          React.createElement(
            "tr",
            {
              key: `${metric.metricId}:${metric.metricVersion}:${metric.phaseId ?? "episode"}`,
              className: "border-b border-border align-top"
            },
            React.createElement(
              "th",
              { scope: "row", className: "py-2 pr-4 font-medium" },
              metric.phaseId === null
                ? metric.metricId
                : `${metric.metricId} · ${metric.phaseId}`
            ),
            React.createElement(
              "td",
              { className: "py-2 pr-4 font-mono" },
              metric.estimate === null
                ? React.createElement(StatusBadge, {
                    status: NOT_OBSERVED_STATUS,
                    label: NOT_OBSERVED_LABEL
                  })
                : `${metric.estimate} ${metric.unit}`
            ),
            React.createElement(
              "td",
              { className: "py-2 pr-4 font-mono" },
              `${metric.numerator} / ${metric.denominator}`
            ),
            React.createElement(
              "td",
              { className: "py-2 pr-4" },
              `${metric.coverage} · ${metric.independentUnits} independent units`
            )
          )
        )
      )
    )
  );
}

/** The distinct step indexes the fetched window actually indexes. */
function windowStepList(
  window: ControlApiPlaytestingWindowResponse
): readonly number[] {
  const steps = new Set<number>();
  for (const entry of window.entries) {
    const step = stepFor(entry);
    if (step !== null) steps.add(step);
  }
  return [...steps].sort((left, right) => left - right);
}

/**
 * Previous/next navigation across the steps this window already fetched. It
 * moves by link rather than by client state so the step stays address state --
 * workspace, filters and the originating list cursor all survive the move, and
 * a shared URL still reproduces the step an analyst was reading. Navigation
 * never leaves the fetched window: a step outside it is not a step this page
 * has evidence for.
 */
function stepNavigation(
  scope: PlaytestingScope,
  episodeId: string,
  window: ControlApiPlaytestingWindowResponse
): React.JSX.Element {
  const steps = windowStepList(window);
  const current = scope.step;
  const previous =
    current === null
      ? null
      : (steps.findLast((step) => step < current) ?? null);
  const next =
    current === null
      ? (steps[0] ?? null)
      : (steps.find((step) => step > current) ?? null);
  const control = (
    direction: "prev" | "next",
    target: number | null,
    label: string
  ): React.JSX.Element =>
    target === null
      ? React.createElement(
          "span",
          {
            className: "text-xs text-fg-muted opacity-60",
            "aria-disabled": "true",
            [`data-playtest-step-${direction}`]: "disabled"
          },
          label
        )
      : React.createElement(
          NavigationLink,
          {
            href: playtestingEpisodeHref(scope, episodeId, target),
            className: "text-xs text-accent hover:underline",
            dataAttributes: {
              [`data-playtest-step-${direction}`]: String(target)
            }
          },
          `${label} · step ${target}`
        );
  return React.createElement(
    "nav",
    {
      className:
        "mb-3 flex flex-wrap items-center justify-between gap-2 rounded border border-border bg-surface-raised px-3 py-2",
      "aria-label": "Trace step navigation"
    },
    control("prev", previous, "← Previous step"),
    React.createElement(
      "p",
      { className: MUTED_META_CLASS },
      `${current === null ? "No step selected" : `Step ${current}`} · this window covers recorded steps ${window.startStep}–${window.endStep} · ${steps.length} indexed step${steps.length === 1 ? "" : "s"}`
    ),
    control("next", next, "Next step →")
  );
}

/** One scan dimension of a trace line, or an explicit unrecorded state. */
function traceFact(
  label: string,
  fact: string,
  value: string | null
): React.JSX.Element {
  return React.createElement(
    "div",
    {
      className: "rounded border border-border px-3 py-2",
      "data-trace-fact": fact
    },
    React.createElement("dt", { className: SECTION_LABEL_CLASS }, label),
    value === null
      ? React.createElement(
          "dd",
          {
            className: `mt-1 ${MUTED_META_CLASS}`,
            "data-trace-fact-state": "unrecorded"
          },
          "Not recorded"
        )
      : React.createElement(
          "dd",
          { className: `mt-1 break-words ${MONO_VALUE_CLASS}` },
          value
        )
  );
}

/** One-line human reading of a trace line, assembled from recorded fields. */
function stepSummaryLine(facts: TraceStepFacts): string {
  const parts: string[] = [];
  if (facts.eventType !== null)
    parts.push(
      `${facts.eventType.includes(", ") ? "Events" : "Event"} ${facts.eventType}`
    );
  if (facts.eventId !== null)
    parts.push(
      `${facts.eventId.includes(", ") ? "event IDs" : "event"} ${facts.eventId}`
    );
  if (facts.actionId !== null) parts.push(`Selected action ${facts.actionId}`);
  if (facts.phase !== null) parts.push(`Phase ${facts.phase}`);
  if (facts.tick !== null) parts.push(`Tick ${facts.tick}`);
  if (facts.severity !== null) parts.push(`Severity ${facts.severity}`);
  return parts.length > 0
    ? parts.join(" · ")
    : "No event, selected action or phase is recorded on this line. Open the recorded JSON to see every field it carries.";
}

/** The raw line is always secondary to the readable step summary. */
function recordedJsonDisclosure(
  step: number | null,
  entry: PlaytestJsonValue
): React.JSX.Element {
  return React.createElement(
    "details",
    {
      className: "mt-2 rounded border border-border bg-surface-raised p-3",
      "data-playtest-json": "true"
    },
    React.createElement(
      "summary",
      { className: "cursor-pointer text-xs font-medium text-fg-muted" },
      "Recorded JSON"
    ),
    React.createElement(
      "pre",
      {
        className:
          "mt-2 max-h-80 overflow-auto rounded bg-surface p-3 text-xs leading-5 text-fg",
        "aria-label":
          step === null
            ? "Unindexed trace data"
            : `Recorded data for step ${step}`
      },
      renderJson(entry)
    )
  );
}

function episodeSteps(
  detail: ControlApiPlaytestingEpisodeDetailResponse,
  scope: PlaytestingScope,
  window: ControlApiPlaytestingWindowResponse | null,
  unavailable: string | undefined
): React.JSX.Element {
  const episode = detail.record;
  if (episode.trace === null) {
    return React.createElement(EmptyState, {
      message:
        "No trace artifact is linked to this episode. A replay cannot be reconstructed from the summary alone."
    });
  }
  if (unavailable) {
    return React.createElement(EmptyState, {
      message: `Trace window unavailable: ${unavailable}`
    });
  }
  if (window === null) {
    return React.createElement(EmptyState, {
      message:
        "The selected trace window has not been loaded. No event or frame content is inferred."
    });
  }
  if (window.entries.length === 0) {
    return React.createElement(EmptyState, {
      message: `No indexed trace entries were recorded for steps ${window.startStep}–${window.endStep}. ${window.omittedLineCount} stored lines were outside the selected range or had no step index.`
    });
  }
  return React.createElement(
    React.Fragment,
    null,
    stepNavigation(scope, episode.episodeId, window),
    React.createElement(
      "ol",
      {
        className: "flex flex-col gap-3",
        "aria-label": `Episode steps ${window.startStep} through ${window.endStep}`
      },
      ...window.entries.map((entry, index) => {
        const facts = traceStepFacts(entry);
        const step = facts.step;
        const selected = step !== null && scope.step === step;
        return React.createElement(
          "li",
          {
            key: `${step ?? "unindexed"}:${index}`,
            className: `border-b border-border py-3 last:border-b-0 ${selected ? "rounded-md border border-accent bg-surface-raised px-3" : ""}`,
            ...(selected ? { "aria-current": "step" } : {}),
            "data-playtest-step": step === null ? "unindexed" : String(step)
          },
          React.createElement(
            "div",
            {
              className:
                "mb-2 flex flex-wrap items-center justify-between gap-2"
            },
            React.createElement(
              "div",
              null,
              React.createElement(
                "h3",
                { className: "text-sm font-semibold" },
                step === null ? "Unindexed trace entry" : `Step ${step}`
              ),
              React.createElement(
                "p",
                { className: "mt-1 text-sm text-fg" },
                stepSummaryLine(facts)
              )
            ),
            step === null
              ? React.createElement(StatusBadge, {
                  status: NOT_OBSERVED_STATUS,
                  label: "Step not observed"
                })
              : React.createElement(
                  NavigationLink,
                  {
                    href: playtestingEpisodeHref(
                      scope,
                      episode.episodeId,
                      step
                    ),
                    className: EVIDENCE_LINK_CLASS
                  },
                  selected ? "Selected step" : "Open this step"
                )
          ),
          React.createElement(
            "details",
            {
              className: "mt-2 rounded-md border border-border px-3 py-2",
              open: selected,
              "data-playtest-step-details":
                step === null ? "unindexed" : String(step)
            },
            React.createElement(
              "summary",
              { className: "cursor-pointer text-xs font-medium text-fg-muted" },
              "Step details"
            ),
            React.createElement(
              DetailGrid,
              { columns: 4, className: "mt-2" },
              traceFact("Event", "event", facts.eventType),
              traceFact("Event id", "event-id", facts.eventId),
              traceFact("Selected action", "action", facts.actionId),
              traceFact("Phase", "phase", facts.phase),
              facts.tick === null
                ? null
                : traceFact("Tick", "tick", facts.tick),
              facts.severity === null
                ? null
                : traceFact("Severity", "severity", facts.severity),
              facts.lineKind === null
                ? null
                : traceFact("Line type", "line-type", facts.lineKind)
            ),
            recordedJsonDisclosure(step, entry)
          )
        );
      })
    )
  );
}

function reviewPanel(
  detail: ControlApiPlaytestingEpisodeDetailResponse,
  scope: PlaytestingScope
): React.JSX.Element {
  const review = detail.latestReview;
  if (review === null) {
    return React.createElement(EmptyState, {
      message:
        "No analyst review is recorded. This is not a negative review or a score of zero."
    });
  }
  const completenessSection = (
    title: string,
    status: string,
    explanation: string,
    children: readonly React.ReactNode[] = []
  ): React.JSX.Element =>
    React.createElement(
      "li",
      {
        className: "space-y-1",
        "data-review-completeness-section": title
          .toLowerCase()
          .replaceAll(" ", "-")
      },
      React.createElement("h4", { className: "font-medium" }, title),
      React.createElement(StatusBadge, {
        status:
          status === "not-recorded"
            ? NOT_OBSERVED_STATUS
            : status === "unavailable"
              ? "unavailable"
              : "configured",
        label: status
      }),
      explanation.length > 0
        ? React.createElement("p", { className: MUTED_BODY_CLASS }, explanation)
        : null,
      ...children
    );
  const completeness = review.reportCompleteness;
  const crossSessionContext = completeness.crossSessionContext;
  const crossSessionExplanation =
    crossSessionContext.status === "available"
      ? `Cites ${crossSessionContext.evidenceRefs.length} packet-supplied sibling episode${crossSessionContext.evidenceRefs.length === 1 ? "" : "s"}.`
      : crossSessionContext.reason;
  const crossSessionEvidence =
    crossSessionContext.status === "available"
      ? crossSessionContext.evidenceRefs.map((reference, index) =>
          React.createElement(
            "li",
            { key: `${reference.id}:${index}` },
            React.createElement(
              NavigationLink,
              {
                href: playtestingEpisodeHref(scope, reference.id, null),
                className: EVIDENCE_LINK_CLASS,
                dataAttributes: {
                  "data-cross-session-episode": reference.id
                }
              },
              `episode ${reference.id}`
            )
          )
        )
      : [];
  const alternativeSection = completenessSection(
    "Alternative explanations",
    completeness.alternatives.status,
    completeness.alternatives.status === "provided"
      ? "Competing explanations are listed below."
      : completeness.alternatives.reason,
    review.alternativeExplanations.map((alternative, index) =>
      React.createElement(
        "p",
        { key: `alternative:${index}`, className: "text-sm" },
        alternative
      )
    )
  );
  const experimentSection = completenessSection(
    "Experiments",
    completeness.experiments.status,
    completeness.experiments.status === "proposed"
      ? "Proposed tests and their falsifiers are listed below."
      : completeness.experiments.reason,
    review.experiments.map((experiment, index) =>
      React.createElement(
        "div",
        {
          key: `experiment:${index}`,
          className: "rounded border border-border p-2 text-sm"
        },
        React.createElement("p", {}, experiment.hypothesis),
        React.createElement(
          "p",
          { className: MUTED_META_CLASS },
          `Falsifier: ${experiment.falsifier}`
        ),
        React.createElement(
          "p",
          { className: MUTED_META_CLASS },
          `Controls: ${experiment.controls.join(", ")}`
        ),
        React.createElement(
          "p",
          { className: MUTED_META_CLASS },
          `Metric: ${experiment.metricId} · Budget: ${experiment.budget}`
        )
      )
    )
  );
  const followUpDetail =
    completeness.followUp.status === "proposed"
      ? completeness.followUp.text
      : completeness.followUp.reason;
  const completenessPanel = React.createElement(
    "section",
    { className: "space-y-2", "aria-label": "Review completeness" },
    React.createElement(
      "h3",
      { className: "font-semibold" },
      "Review completeness and follow-up"
    ),
    React.createElement(
      "ul",
      { className: "grid gap-3 sm:grid-cols-2" },
      completenessSection(
        "Cross-session context",
        crossSessionContext.status,
        crossSessionExplanation,
        crossSessionEvidence
      ),
      alternativeSection,
      experimentSection,
      completenessSection(
        "Follow-up",
        completeness.followUp.status,
        followUpDetail
      )
    )
  );
  const renderClaims = (
    kind: "observation" | "interpretation",
    claims: readonly PlaytestReviewClaim[],
    className: string
  ): React.JSX.Element | null =>
    claims.length === 0
      ? null
      : React.createElement(
          "ul",
          { className, "data-review-claim-kind": kind },
          ...claims.map((claim, index) =>
            React.createElement(
              "li",
              { key: `${kind}:${index}`, className: "space-y-1" },
              React.createElement("p", {}, claim.text),
              claim.evidenceRefs.length > 0
                ? React.createElement(
                    "ul",
                    { className: "flex flex-wrap gap-2 pl-3" },
                    ...claim.evidenceRefs.map((reference, referenceIndex) =>
                      React.createElement(
                        "li",
                        { key: `${reference.id}:${referenceIndex}` },
                        React.createElement(
                          NavigationLink,
                          {
                            href: playtestingEpisodeHref(
                              scope,
                              reference.kind === "episode"
                                ? reference.id
                                : detail.record.episodeId,
                              reference.step ?? null
                            ),
                            className: EVIDENCE_LINK_CLASS,
                            dataAttributes: {
                              "data-review-claim-evidence": reference.id
                            }
                          },
                          `${reference.kind} ${reference.id}`
                        )
                      )
                    )
                  )
                : React.createElement(StatusBadge, {
                    status: NOT_OBSERVED_STATUS,
                    label: "No citations recorded"
                  })
            )
          )
        );
  return React.createElement(
    "div",
    { className: "flex flex-col gap-4", "data-review-status": review.status },
    React.createElement(
      "p",
      { className: "text-sm leading-6" },
      review.chronologicalSummary
    ),
    React.createElement(
      "p",
      { className: MUTED_META_CLASS },
      `Review ${review.reviewId} · rubric ${review.rubricHash} · ${review.measurementVersion}`
    ),
    completenessPanel,
    review.anchors.length === 0
      ? React.createElement(EmptyState, {
          variant: "inline",
          message: "No dimension anchors were recorded."
        })
      : React.createElement(
          "ul",
          { className: "grid gap-3 sm:grid-cols-2" },
          ...review.anchors.map((anchor) =>
            React.createElement(
              "li",
              {
                key: `${anchor.dimensionId}:${anchor.version}`,
                className: "rounded border border-border bg-surface-raised p-3"
              },
              React.createElement(
                "div",
                {
                  className: "flex flex-wrap items-center justify-between gap-2"
                },
                React.createElement(
                  "h3",
                  { className: "font-medium" },
                  anchor.dimensionId
                ),
                anchor.score === null
                  ? React.createElement(StatusBadge, {
                      status: NOT_OBSERVED_STATUS,
                      label: NOT_OBSERVED_LABEL
                    })
                  : React.createElement(
                      "span",
                      { className: "font-mono" },
                      `${anchor.score} / 4`
                    )
              ),
              React.createElement(
                "p",
                { className: "mt-2 text-sm text-fg-muted" },
                anchor.rationale
              ),
              anchor.evidenceRefs.length > 0
                ? React.createElement(
                    "ul",
                    { className: "mt-2 flex flex-wrap gap-2" },
                    ...anchor.evidenceRefs.map((reference, index) =>
                      React.createElement(
                        "li",
                        { key: `${reference.id}:${index}` },
                        React.createElement(
                          NavigationLink,
                          {
                            href: playtestingEpisodeHref(
                              scope,
                              detail.record.episodeId,
                              reference.step ?? null
                            ),
                            className: EVIDENCE_LINK_CLASS,
                            dataAttributes: {
                              "data-review-evidence": reference.id
                            }
                          },
                          `${reference.kind} ${reference.id}`
                        )
                      )
                    )
                  )
                : React.createElement(StatusBadge, {
                    status: NOT_OBSERVED_STATUS,
                    label: "No citations"
                  })
            )
          )
        ),
    renderClaims(
      "observation",
      review.observations,
      "list-disc space-y-2 pl-5 text-sm"
    ),
    renderClaims(
      "interpretation",
      review.interpretations,
      "list-disc space-y-2 pl-5 text-sm text-fg-muted"
    )
  );
}

function truncationExplanation(
  episode: ControlApiPlaytestingEpisodeDetailResponse["record"],
  scope: PlaytestingScope
): React.ReactNode {
  if (episode.status !== "budget-truncated") return null;
  const loopStep =
    episode.termination.reason === "loop-guard"
      ? episode.termination.step
      : null;
  const explanation =
    loopStep === null
      ? episode.termination.reason === "step-limit"
        ? `Runtime reached the episode step limit after ${episode.stepCount} executed decisions. No terminal game outcome was observed; no win or loss is inferred.`
        : "No terminal game outcome was observed. Runtime marked this episode budget-truncated; no win or loss is inferred. Inspect the last recorded steps to diagnose the stop."
      : `Runtime's loop guard stopped at step ${loopStep} after the same player-visible state and action repeated. That action was not executed. No terminal game outcome was observed; no win or loss is inferred.`;
  return React.createElement(
    "p",
    {
      className:
        "rounded-md border border-warning/40 bg-surface-raised px-3 py-2 text-sm text-fg-muted",
      role: "status",
      "data-testid": "playtesting-truncation-explanation"
    },
    explanation,
    loopStep === null ? null : " ",
    loopStep === null
      ? null
      : React.createElement(
          NavigationLink,
          {
            href: playtestingEpisodeHref(scope, episode.episodeId, loopStep),
            className: "font-medium text-accent hover:underline",
            dataAttributes: {
              "data-playtesting-stop-step": String(loopStep)
            }
          },
          `Inspect stop at step ${loopStep}`
        )
  );
}

function replayStatusBadge(
  status: ControlApiPlaytestingEpisodeDetailResponse["record"]["replayStatus"]
): React.JSX.Element {
  if (status === "verified") {
    return React.createElement(StatusBadge, {
      status: "valid",
      label: "Replay verified"
    });
  }
  if (status === "trace-replayable") {
    return React.createElement(StatusBadge, {
      status: "configured",
      label: "Trace replayable"
    });
  }
  if (status === "invalid") {
    return React.createElement(StatusBadge, {
      status: "invalid",
      label: "Replay invalid"
    });
  }
  return React.createElement(StatusBadge, {
    status: NOT_OBSERVED_STATUS,
    label: status === "non-reproducible" ? "Non-reproducible" : "Unavailable"
  });
}

/** One recorded status dimension in the compact summary strip. */
function statusTile(
  label: string,
  dimension: string,
  badge: React.JSX.Element
): React.JSX.Element {
  return React.createElement(
    "div",
    {
      className: "flex min-w-0 flex-col items-start gap-1",
      "data-status-dimension": dimension
    },
    React.createElement("dt", { className: SECTION_LABEL_CLASS }, label),
    React.createElement("dd", null, badge)
  );
}

function recordedStatusValues(
  episode: ControlApiPlaytestingEpisodeDetailResponse["record"]
): React.JSX.Element {
  const values = [
    ["Game outcome token", episode.outcome],
    ["Execution status token", episode.status],
    ["Replay integrity token", episode.replayStatus],
    ["Evidence completeness token", episode.completeness]
  ] as const;
  return React.createElement(
    "details",
    { className: "mt-2 text-xs", "data-recorded-session-status": "true" },
    React.createElement(
      "summary",
      { className: "cursor-pointer text-fg-muted" },
      "Recorded status values"
    ),
    React.createElement(
      "dl",
      { className: "mt-2 flex flex-wrap gap-x-5 gap-y-2" },
      ...values.map(([label, value]) =>
        React.createElement(
          "div",
          { key: label, className: "flex gap-2" },
          React.createElement("dt", { className: MUTED_META_CLASS }, label),
          React.createElement("dd", { className: MONO_VALUE_CLASS }, value)
        )
      )
    )
  );
}

function compactStat(label: string, value: string | number): React.JSX.Element {
  return React.createElement(
    "div",
    { className: "min-w-0 px-3" },
    React.createElement("dt", { className: SECTION_LABEL_CLASS }, label),
    React.createElement(
      "dd",
      { className: "mt-1 break-words text-base font-semibold" },
      value
    )
  );
}

/**
 * The badge for the episode's own completeness token. The token is mapped, not
 * interpreted: `partial` is a recorded gap and `unknown` is an unrecorded
 * dimension, so neither borrows the other's tone.
 */
function completenessBadge(
  completeness: ControlApiPlaytestingEpisodeDetailResponse["record"]["completeness"]
): React.JSX.Element {
  if (completeness === "complete") {
    return React.createElement(StatusBadge, {
      status: "valid",
      label: "Complete"
    });
  }
  if (completeness === "partial") {
    return React.createElement(StatusBadge, {
      status: "unavailable",
      label: "Partial"
    });
  }
  return React.createElement(StatusBadge, {
    status: NOT_OBSERVED_STATUS,
    label: NOT_OBSERVED_LABEL
  });
}

export function PlaytestingSessionView({
  detail,
  scope,
  window,
  windowUnavailable
}: PlaytestingSessionViewProps): React.JSX.Element {
  const episode = detail.record;
  const defaultStep = defaultEpisodeInspectionStep(episode);
  const traceScope =
    scope.step === null && defaultStep !== null
      ? { ...scope, step: defaultStep }
      : scope;
  return React.createElement(
    PageBody,
    {
      feature: "playtesting-session",
      as: "article",
      attributes: {
        "data-episode-id": episode.episodeId,
        "data-workspace": detail.workspaceId
      }
    },
    React.createElement(
      "div",
      { className: "flex flex-wrap items-center justify-between gap-3" },
      React.createElement(
        NavigationLink,
        {
          href: playtestingInspectorBackHref(scope),
          className: "text-sm text-accent hover:underline",
          dataAttributes: { "data-playtesting-back": "true" }
        },
        scope.returnFindingId ? "← Back to findings" : "← Back to sessions"
      ),
      React.createElement(
        NavigationLink,
        {
          href: playtestingAnalyzeEpisodeHref(scope, episode.episodeId),
          className: "text-sm font-medium text-accent hover:underline",
          dataAttributes: {
            "data-playtesting-analyze-session": episode.episodeId
          }
        },
        "Analyze this session"
      )
    ),
    React.createElement(
      "header",
      { className: "flex flex-col gap-2" },
      React.createElement(
        "h2",
        {
          className: `${MONO_ID_CLASS} break-all`,
          "data-episode-title": episode.episodeId
        },
        episode.episodeId
      ),
      React.createElement(
        "p",
        { className: MUTED_BODY_CLASS },
        `${executionModeLabel(episode.executionProvenance.mode)} · ${executionSourceSummary(episode.executionProvenance)}${episode.executionProvenance.mode === "adapter-accelerated" ? ` · engine ${episode.identity.gameBuild}` : ""}`
      ),
      React.createElement(
        DetailGrid,
        {
          columns: 4,
          className: "mt-3 border-y border-border py-3",
          label: "Independent session status dimensions"
        },
        statusTile(
          "Game outcome",
          "game-outcome",
          gameOutcomeBadge(episode.outcome)
        ),
        statusTile(
          "Execution status",
          "execution-status",
          executionStatusBadge(episode.status)
        ),
        statusTile(
          "Replay integrity",
          "replay-integrity",
          replayStatusBadge(episode.replayStatus)
        ),
        statusTile(
          "Evidence completeness",
          "evidence-completeness",
          completenessBadge(episode.completeness)
        )
      ),
      React.createElement(
        "p",
        { className: MUTED_BODY_CLASS },
        "These four dimensions are recorded independently. A game outcome is not an execution status, and neither one implies evidence completeness."
      ),
      recordedStatusValues(episode),
      truncationExplanation(episode, scope),
      episode.missingReasons.length === 0
        ? null
        : React.createElement(
            "p",
            { className: MUTED_META_CLASS },
            `Recorded missing reasons: ${episode.missingReasons.join(", ")}`
          )
    ),
    React.createElement(
      DetailGrid,
      {
        columns: 4,
        className: "rounded-lg border border-border py-3",
        label: "Recorded execution measurements"
      },
      compactStat("Steps", episode.stepCount),
      compactStat(
        "Simulation",
        episode.simulationWallMs === null
          ? "Not observed"
          : `${episode.simulationWallMs} ms`
      ),
      compactStat(
        "Policy inference",
        episode.policyInferenceMs === null
          ? "Not observed"
          : `${episode.policyInferenceMs} ms`
      ),
      compactStat(
        "Native duration",
        episode.nativeDurationMs === null
          ? "Not observed"
          : `${episode.nativeDurationMs} ms`
      )
    ),
    React.createElement(
      "section",
      { className: LIST_PANEL_CLASS },
      heading("episode-metrics-heading", "Deterministic metrics"),
      metricTable(episode)
    ),
    React.createElement(
      "section",
      { className: LIST_PANEL_CLASS },
      heading("episode-trace-heading", "Recorded trace window"),
      episode.trace
        ? React.createElement(
            "p",
            { className: MUTED_META_CLASS },
            `Artifact ${episode.trace.id} · requested step ${traceScope.step ?? 0}`
          )
        : null,
      window
        ? React.createElement(
            "p",
            { className: MUTED_META_CLASS },
            `Integrity verified · SHA-256 ${window.sha256} · ${window.sourceLineCount} source lines · ${window.omittedLineCount} not in this window`
          )
        : null,
      episodeSteps(detail, traceScope, window, windowUnavailable)
    ),
    React.createElement(
      "section",
      { className: LIST_PANEL_CLASS },
      heading("episode-review-heading", "Analyst review"),
      reviewPanel(detail, scope)
    ),
    React.createElement(
      "section",
      {
        className: LIST_PANEL_CLASS,
        "aria-labelledby": "episode-media-heading"
      },
      heading("episode-media-heading", "Recorded frames"),
      episode.frames.length === 0
        ? React.createElement(EmptyState, {
            variant: "inline",
            message:
              "No frame was recorded. This headless trace is structured data, not video."
          })
        : React.createElement(
            "ul",
            {
              className: "grid gap-4 sm:grid-cols-2",
              "aria-label": "Recorded game frames"
            },
            ...episode.frames.map((frame, index) => {
              const frameIndex = frame.frameIndex ?? index;
              const src = `/api/playtesting/episodes/${encodeURIComponent(episode.episodeId)}/media/${encodeURIComponent(frame.id)}?workspaceId=${encodeURIComponent(detail.workspaceId)}`;
              return React.createElement(
                "li",
                {
                  key: `${frame.id}:${frameIndex}`,
                  className:
                    "rounded border border-border bg-surface-raised p-3"
                },
                React.createElement(
                  "figure",
                  { className: "flex flex-col gap-2" },
                  React.createElement("img", {
                    src,
                    alt: `Recorded game frame ${frameIndex + 1}${frame.step === undefined ? "" : ` at step ${frame.step}`}`,
                    loading: "lazy",
                    decoding: "async",
                    className: "max-h-[32rem] w-full rounded object-contain",
                    "data-playtest-frame": frame.id
                  }),
                  React.createElement(
                    "figcaption",
                    { className: MUTED_META_CLASS },
                    `Recorded frame ${frameIndex + 1}${frame.step === undefined ? "" : ` · step ${frame.step}`}. Image retrieval is workspace-authorized.`
                  )
                )
              );
            })
          )
    )
  );
}
