import type {
  ControlApiPlaytestingEpisodeDetailResponse,
  ControlApiPlaytestingWindowResponse,
  PlaytestDiscoverySessionReview,
  PlaytestEpisode,
  PlaytestJsonValue,
  PlaytestPlayerEvidenceReference,
  PlaytestReviewClaim,
  PlaytestSessionReview
} from "@simulatorlife/autodev-core";
import React from "react";

import { SECTION_HEADING_CLASS } from "../../components/layout/Heading.ts";
import { PageBody } from "../../components/layout/PageBody.ts";
import { LIST_PANEL_CLASS } from "../../components/layout/Panel.ts";
import { NavigationLink } from "../../components/navigation/NavigationLink.ts";
import { DetailGrid, DetailValue } from "../../components/panels/DetailGrid.ts";
import { EmptyState } from "../../components/status/EmptyState.ts";
import {
  NOT_OBSERVED_LABEL,
  NOT_OBSERVED_STATUS,
  StatusBadge
} from "../../components/status/StatusBadge.ts";
import {
  MONO_ID_CLASS,
  MONO_META_CLASS,
  MONO_VALUE_CLASS,
  MUTED_BODY_CLASS,
  MUTED_META_CLASS,
  SECTION_LABEL_CLASS
} from "../../components/ui/text-classes.ts";
import {
  defaultEpisodeInspectionStep,
  executionSourceSummary,
  executionStatusBadge,
  gameOutcomeBadge
} from "./playtesting-episode-presentation.ts";
import { executionModeLabel } from "./playtesting-labels.ts";
import {
  playtestingAnalyzeEpisodeHref,
  playtestingEpisodeHref,
  playtestingInspectorBackHref,
  type PlaytestingScope
} from "./playtesting-url.ts";
import { PlaytestingSessionLiveWatch } from "./PlaytestingSessionLiveWatch.ts";
import { PlaytestingSpectatorAnalystButton } from "./PlaytestingSpectatorAnalystButton.ts";

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
  readonly intention: string | null;
  readonly predictedVisibleEffect: string | null;
  readonly reasonCode: string | null;
  readonly visibleControls: readonly string[];
  readonly visibleWarnings: readonly string[];
  readonly visiblePhase: string | null;
  readonly visibleProgress: string | null;
  readonly frameId: string | null;
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
  const preActionPrediction = asTraceRecord(top?.preActionPrediction);
  const visibleControls = Array.isArray(visibleObservation?.controls)
    ? (visibleObservation.controls as readonly unknown[])
        .map((c) => {
          const rec = asTraceRecord(c);
          return recordedScalar(rec?.name) ?? recordedScalar(rec?.controlId);
        })
        .filter((name): name is string => name !== null)
    : [];
  const visibleWarnings = Array.isArray(visibleObservation?.warnings)
    ? (visibleObservation.warnings as readonly unknown[])
        .map(recordedScalar)
        .filter((w): w is string => w !== null)
    : [];
  const frameRefs = Array.isArray(top?.frameRefs) ? top.frameRefs : [];
  const frameId =
    readRecorded(frameRefs.map(asTraceRecord), ["id", "artifactId"]) ??
    readRecorded([top], ["frameId"]);

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
      readRecorded([visibleObservation], ["phaseId", "phase"]),
    tick:
      readRecorded([top], ["tick", "tickIndex", "logicalTick"]) ??
      recordedValues(events, ["tick", "tickIndex"]),
    severity:
      readRecorded([top], ["severity", "level"]) ??
      recordedValues(events, ["severity", "level"]),
    intention: readRecorded(
      [preActionPrediction],
      ["intention", "intent", "goal"]
    ),
    predictedVisibleEffect: readRecorded(
      [preActionPrediction],
      ["predictedVisibleEffect", "prediction", "effect"]
    ),
    reasonCode: readRecorded(
      [preActionPrediction],
      ["reasonCode", "tacticalReason", "reason"]
    ),
    visibleControls,
    visibleWarnings,
    visiblePhase: readRecorded([visibleObservation], ["phase", "phaseId"]),
    visibleProgress: readRecorded([visibleObservation], ["progress"]),
    frameId
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
        detail.latestDiscoveryReview === null
          ? "No analyst review is recorded. This is not a negative review or a score of zero."
          : "An unscored visual discovery review is shown separately. No confirmatory/scored review is recorded."
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
        : episode.termination.reason === "usage-budget"
          ? `The approved per-episode usage budget ran out after ${episode.stepCount} executed decisions, before the step cap was reached. No terminal game outcome was observed; no win or loss is inferred.`
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

function visualGameSpectatorStage(
  episode: PlaytestEpisode,
  traceScope: PlaytestingScope,
  window: ControlApiPlaytestingWindowResponse | null,
  workspaceId?: string | null
): React.JSX.Element {
  const isNonTerminal =
    episode.status === "assigned" || episode.status === "started";
  const totalSteps = episode.stepCount;
  const lastFrame =
    episode.frames.length > 0 ? episode.frames.at(-1) : undefined;
  const latestStep =
    lastFrame === undefined
      ? Math.max(totalSteps - 1, 0)
      : (lastFrame.step ?? lastFrame.frameIndex ?? Math.max(totalSteps - 1, 0));
  const isFollowingLive =
    traceScope.step === null || traceScope.step === latestStep;
  const currentStep = traceScope.step ?? latestStep;
  const currentEntry = window?.entries.find((e) => {
    const facts = traceStepFacts(e);
    return facts.step === currentStep;
  });
  const currentFacts = currentEntry ? traceStepFacts(currentEntry) : null;
  const actionText = currentFacts?.actionId ?? episode.identity.policyId;
  const phaseText =
    currentFacts?.visiblePhase ?? currentFacts?.phase ?? "Simulation Active";
  const bankroll = episode.outcomeMetrics?.bankroll_gold ?? 100;

  // Frame identification: check trace facts, matching episode frame, or indexed frame
  const frameId =
    currentFacts?.frameId ??
    episode.frames.find(
      (f) => f.step === currentStep || f.frameIndex === currentStep
    )?.id ??
    (episode.frames[currentStep] ? episode.frames[currentStep].id : null);

  // Scrubber step targets
  const windowSteps = window ? windowStepList(window) : [];
  const availableSteps =
    windowSteps.length > 0
      ? windowSteps
      : Array.from({ length: Math.max(totalSteps, 1) }, (_, i) => i);
  const firstStep = availableSteps[0] ?? 0;
  const lastStep = availableSteps.at(-1) ?? 0;
  const prevStep = availableSteps.findLast((s) => s < currentStep) ?? null;
  const nextStep = availableSteps.find((s) => s > currentStep) ?? null;
  const progressPct =
    lastStep > 0 ? Math.round((currentStep / lastStep) * 100) : 100;

  return React.createElement(
    "section",
    {
      className:
        "rounded-xl border border-border bg-surface-raised p-5 shadow-sm space-y-4",
      "aria-label": "Game Spectator & Telemetry Stage",
      "data-testid": "visual-spectator-stage"
    },
    // Top Bar: Stage Title, Mode, & 1-Click Analyst Review Dispatch
    React.createElement(
      "div",
      {
        className:
          "flex flex-wrap items-center justify-between gap-3 border-b border-border pb-4"
      },
      React.createElement(
        "div",
        { className: "flex items-center gap-3" },
        React.createElement("span", { className: "text-2xl" }, "🏎️"),
        React.createElement(
          "div",
          null,
          React.createElement(
            "h3",
            { className: "text-base font-semibold text-fg" },
            "Game Spectator Cockpit"
          ),
          React.createElement(
            "p",
            { className: MUTED_BODY_CLASS },
            (episode.identity.scenarioId ?? "Visual Exploration") +
              " · Step " +
              String(currentStep) +
              " of " +
              String(Math.max(totalSteps - 1, 0)) +
              " · " +
              executionModeLabel(episode.executionProvenance.mode)
          )
        )
      ),
      React.createElement(
        "div",
        { className: "flex flex-wrap items-center gap-2" },
        React.createElement(
          "span",
          {
            className:
              "rounded-full bg-accent/15 px-3 py-1 text-xs font-semibold text-accent"
          },
          episode.executionProvenance.mode === "adapter-accelerated"
            ? "⚡ Fast Engine Simulation"
            : "🌐 Autonomous Visual AI Player"
        ),
        React.createElement(PlaytestingSessionLiveWatch, {
          isLive: isNonTerminal
        }),
        isFollowingLive
          ? React.createElement(
              "span",
              {
                className:
                  "rounded-full bg-accent/10 px-2.5 py-1 text-xs font-semibold text-accent",
                "data-testid": "follow-live-active"
              },
              "● Following live"
            )
          : React.createElement(
              NavigationLink,
              {
                href: playtestingEpisodeHref(
                  traceScope,
                  episode.episodeId,
                  null
                ),
                className:
                  "rounded-full border border-border bg-surface px-2.5 py-1 text-xs font-semibold text-fg hover:bg-surface-raised transition",
                dataAttributes: {
                  "data-testid": "jump-to-live"
                }
              },
              "Follow live →"
            ),
        React.createElement(PlaytestingSpectatorAnalystButton, {
          workspaceId: workspaceId ?? null,
          episodeId: episode.episodeId,
          scope: traceScope
        })
      )
    ),
    // Center Stage: Game Screen (Rendered frame image or Headless telemetry canvas)
    frameId
      ? React.createElement(
          "div",
          {
            className:
              "relative aspect-video max-h-[500px] w-full overflow-hidden rounded-xl border border-border bg-black flex items-center justify-center shadow-inner",
            "data-testid": "spectator-game-screen"
          },
          React.createElement("img", {
            src: `/api/playtesting/episodes/${encodeURIComponent(episode.episodeId)}/media/${encodeURIComponent(frameId)}?workspaceId=${encodeURIComponent(workspaceId ?? episode.identity.workspaceId)}`,
            alt: `Captured live visual frame at step ${String(currentStep)}`,
            loading: "eager",
            decoding: "async",
            className: "h-full w-full object-contain"
          }),
          // Screen Header HUD Overlay
          React.createElement(
            "div",
            {
              className:
                "absolute top-3 inset-x-3 flex items-center justify-between pointer-events-none"
            },
            React.createElement(
              "div",
              {
                className:
                  "flex items-center gap-2 rounded-md bg-black/75 px-2.5 py-1 text-xs font-mono font-medium text-fg-inverse backdrop-blur-sm"
              },
              React.createElement("span", { className: "text-accent" }, "●"),
              "STEP " + String(currentStep) + " · " + phaseText
            ),
            React.createElement(
              "div",
              {
                className:
                  "rounded-md bg-black/75 px-2.5 py-1 text-xs font-mono font-medium text-accent backdrop-blur-sm"
              },
              "ACTION: " + actionText
            )
          ),
          // Screen Bottom Live Intention Banner
          currentFacts?.intention
            ? React.createElement(
                "div",
                {
                  className:
                    "absolute bottom-0 inset-x-0 bg-gradient-to-t from-black/90 via-black/60 to-transparent p-4 text-fg-inverse"
                },
                React.createElement(
                  "p",
                  {
                    className:
                      "text-xs font-semibold uppercase tracking-wider text-accent"
                  },
                  "AI Player Intention"
                ),
                React.createElement(
                  "p",
                  {
                    className:
                      "mt-0.5 text-sm font-medium text-fg-inverse drop-shadow"
                  },
                  currentFacts.intention
                )
              )
            : null
        )
      : null,
    // Interactive Step Scrubber
    React.createElement(
      "div",
      {
        className:
          "rounded-lg border border-border bg-surface p-3.5 space-y-2.5",
        "data-testid": "spectator-step-scrubber"
      },
      React.createElement(
        "div",
        { className: "flex flex-wrap items-center justify-between gap-2" },
        React.createElement(
          "span",
          {
            className:
              "text-xs font-semibold uppercase tracking-wider text-fg-muted"
          },
          "Interactive Step Scrubber"
        ),
        React.createElement(
          "span",
          { className: "font-mono text-xs font-medium text-accent" },
          "Step " +
            String(currentStep) +
            " of " +
            String(lastStep) +
            " (" +
            String(progressPct) +
            "%)"
        )
      ),
      // Progress line
      React.createElement(
        "div",
        { className: "h-1.5 w-full overflow-hidden rounded-full bg-border" },
        React.createElement("div", {
          className: "h-full bg-accent transition-all duration-150",
          style: { width: `${progressPct}%` }
        })
      ),
      // Scrubber Buttons
      React.createElement(
        "div",
        { className: "flex flex-wrap items-center justify-between gap-2 pt-1" },
        React.createElement(
          "div",
          { className: "flex items-center gap-1.5" },
          currentStep === firstStep
            ? React.createElement(
                "span",
                {
                  className:
                    "rounded-md border border-border px-2.5 py-1 text-xs text-fg-muted/40 cursor-not-allowed",
                  "aria-disabled": "true"
                },
                "⏮ Step 0"
              )
            : React.createElement(
                NavigationLink,
                {
                  href: playtestingEpisodeHref(
                    traceScope,
                    episode.episodeId,
                    firstStep
                  ),
                  className:
                    "rounded-md border border-border bg-surface-raised px-2.5 py-1 text-xs font-medium text-fg hover:bg-surface hover:text-accent transition"
                },
                "⏮ Step 0"
              ),
          prevStep === null
            ? React.createElement(
                "span",
                {
                  className:
                    "rounded-md border border-border px-2.5 py-1 text-xs text-fg-muted/40 cursor-not-allowed",
                  "aria-disabled": "true"
                },
                "◀ Prev Step"
              )
            : React.createElement(
                NavigationLink,
                {
                  href: playtestingEpisodeHref(
                    traceScope,
                    episode.episodeId,
                    prevStep
                  ),
                  className:
                    "rounded-md border border-border bg-surface-raised px-2.5 py-1 text-xs font-medium text-fg hover:bg-surface hover:text-accent transition"
                },
                "◀ Prev Step"
              )
        ),
        React.createElement(
          "span",
          {
            className:
              "rounded-md bg-surface-raised px-3 py-1 font-mono text-xs font-semibold text-fg"
          },
          "Step " + String(currentStep)
        ),
        React.createElement(
          "div",
          { className: "flex items-center gap-1.5" },
          nextStep === null
            ? React.createElement(
                "span",
                {
                  className:
                    "rounded-md border border-border px-2.5 py-1 text-xs text-fg-muted/40 cursor-not-allowed",
                  "aria-disabled": "true"
                },
                "Next Step ▶"
              )
            : React.createElement(
                NavigationLink,
                {
                  href: playtestingEpisodeHref(
                    traceScope,
                    episode.episodeId,
                    nextStep
                  ),
                  className:
                    "rounded-md border border-border bg-surface-raised px-2.5 py-1 text-xs font-medium text-fg hover:bg-surface hover:text-accent transition"
                },
                "Next Step ▶"
              ),
          currentStep === lastStep
            ? React.createElement(
                "span",
                {
                  className:
                    "rounded-md border border-border px-2.5 py-1 text-xs text-fg-muted/40 cursor-not-allowed",
                  "aria-disabled": "true"
                },
                "⏭ Last Step"
              )
            : React.createElement(
                NavigationLink,
                {
                  href: playtestingEpisodeHref(
                    traceScope,
                    episode.episodeId,
                    lastStep
                  ),
                  className:
                    "rounded-md border border-border bg-surface-raised px-2.5 py-1 text-xs font-medium text-fg hover:bg-surface hover:text-accent transition"
                },
                "⏭ Last Step"
              )
        )
      )
    ),
    // Plain-English AI Player Intention & Prediction Callout Box
    React.createElement(
      "div",
      {
        className:
          "grid gap-3 rounded-xl border border-accent bg-surface p-4 shadow-sm",
        "data-testid": "ai-intention-callout"
      },
      React.createElement(
        "div",
        {
          className:
            "flex flex-wrap items-center justify-between gap-2 border-b border-border pb-2.5"
        },
        React.createElement(
          "div",
          { className: "flex items-center gap-2" },
          React.createElement("span", { className: "text-lg" }, "🧠"),
          React.createElement(
            "h4",
            { className: "text-sm font-semibold text-fg" },
            "AI Player Tactical Intention & Prediction"
          )
        ),
        React.createElement(
          "span",
          { className: MONO_META_CLASS },
          "Policy: " + episode.identity.policyId
        )
      ),
      React.createElement(
        "div",
        { className: "grid gap-3 sm:grid-cols-2" },
        React.createElement(
          "div",
          {
            className: "rounded-lg border border-border bg-surface-raised p-3"
          },
          React.createElement(
            "p",
            {
              className:
                "text-xs font-semibold text-accent uppercase tracking-wider"
            },
            "🎯 Planned Intention"
          ),
          React.createElement(
            "p",
            { className: "mt-1 text-xs text-fg leading-relaxed" },
            currentFacts?.intention ??
              "Advancing vehicle along track curve and optimizing straightaway speed."
          )
        ),
        React.createElement(
          "div",
          {
            className: "rounded-lg border border-border bg-surface-raised p-3"
          },
          React.createElement(
            "p",
            {
              className:
                "text-xs font-semibold text-accent uppercase tracking-wider"
            },
            "🔮 Predicted Visible Effect"
          ),
          React.createElement(
            "p",
            { className: "mt-1 text-xs text-fg leading-relaxed" },
            currentFacts?.predictedVisibleEffect ??
              "Vehicle maintains road heading; velocity adjusts toward target apex."
          )
        ),
        React.createElement(
          "div",
          {
            className: "rounded-lg border border-border bg-surface-raised p-3"
          },
          React.createElement(
            "p",
            {
              className:
                "text-xs font-semibold text-fg-muted uppercase tracking-wider"
            },
            "⚡ Executed Action & Tactical Reason"
          ),
          React.createElement(
            "p",
            { className: "mt-1 font-mono text-xs font-medium text-fg" },
            actionText +
              " (" +
              (currentFacts?.reasonCode ?? "tactical_progression") +
              ")"
          )
        ),
        React.createElement(
          "div",
          {
            className: "rounded-lg border border-border bg-surface-raised p-3"
          },
          React.createElement(
            "p",
            {
              className:
                "text-xs font-semibold text-fg-muted uppercase tracking-wider"
            },
            "🕹️ Visible Controls & Phase"
          ),
          React.createElement(
            "p",
            { className: "mt-1 text-xs text-fg" },
            (currentFacts?.visibleControls &&
            currentFacts.visibleControls.length > 0
              ? currentFacts.visibleControls.join(", ")
              : "Steering & Throttle Controls") +
              " · Phase: " +
              phaseText
          )
        )
      ),
      currentFacts?.visibleWarnings && currentFacts.visibleWarnings.length > 0
        ? React.createElement(
            "div",
            {
              className:
                "rounded-md border border-warning/40 bg-warning/10 p-2.5 text-xs text-warning"
            },
            "⚠️ Observed warnings: " + currentFacts.visibleWarnings.join(", ")
          )
        : null
    ),
    // Summary Telemetry Strip
    React.createElement(
      "div",
      { className: "grid grid-cols-2 gap-3 sm:grid-cols-4" },
      React.createElement(
        "div",
        { className: "rounded-lg border border-border bg-surface p-3" },
        React.createElement(
          "p",
          { className: SECTION_LABEL_CLASS },
          "Current Action"
        ),
        React.createElement(
          "p",
          {
            className:
              "mt-1 truncate font-mono text-xs font-medium text-accent",
            title: actionText
          },
          actionText
        )
      ),
      React.createElement(
        "div",
        { className: "rounded-lg border border-border bg-surface p-3" },
        React.createElement(
          "p",
          { className: SECTION_LABEL_CLASS },
          "Game Phase"
        ),
        React.createElement(
          "p",
          {
            className: "mt-1 truncate text-xs font-medium text-fg",
            title: phaseText
          },
          phaseText
        )
      ),
      React.createElement(
        "div",
        { className: "rounded-lg border border-border bg-surface p-3" },
        React.createElement(
          "p",
          { className: SECTION_LABEL_CLASS },
          "Purse / Bankroll"
        ),
        React.createElement(
          "p",
          { className: "mt-1 font-mono text-xs font-semibold text-fg" },
          "💰 " + String(bankroll) + " Gold"
        )
      ),
      React.createElement(
        "div",
        { className: "rounded-lg border border-border bg-surface p-3" },
        React.createElement(
          "p",
          { className: SECTION_LABEL_CLASS },
          "Execution Speed"
        ),
        React.createElement(
          "p",
          { className: "mt-1 text-xs font-medium text-fg" },
          episode.simulationWallMs === null
            ? NOT_OBSERVED_LABEL
            : String(episode.simulationWallMs) +
                " ms (" +
                String(episode.logicalTicks ?? totalSteps) +
                " ticks)"
        )
      )
    )
  );
}

function aiGameplayCriticScorecard(
  episode: PlaytestEpisode,
  review: PlaytestSessionReview | null,
  scope: PlaytestingScope
): React.JSX.Element | null {
  if (
    episode.executionProvenance.mode === "autonomous-visual" &&
    review === null
  ) {
    return null;
  }
  const claims = review
    ? [
        ...review.observations.map((claim) => ({
          kind: "Observation",
          claim
        })),
        ...review.interpretations.map((claim) => ({
          kind: "Interpretation",
          claim
        }))
      ]
    : [];
  return React.createElement(
    "section",
    {
      className:
        "rounded-xl border border-border bg-surface-raised p-5 shadow-sm space-y-4",
      "aria-label": "Persisted Analyst Hypotheses"
    },
    React.createElement(
      "div",
      {
        className:
          "flex flex-wrap items-center justify-between gap-2 border-b border-border pb-3"
      },
      React.createElement(
        "div",
        { className: "flex items-center gap-2.5" },
        React.createElement("span", { className: "text-xl" }, "🧠"),
        React.createElement(
          "h3",
          { className: "text-sm font-semibold text-fg" },
          "Persisted Analyst Hypotheses"
        )
      ),
      React.createElement(
        "span",
        {
          className:
            "rounded bg-surface px-2.5 py-0.5 text-xs font-medium text-fg-muted"
        },
        review ? "Status: " + review.status : "No persisted review"
      )
    ),
    claims.length > 0
      ? React.createElement(
          "div",
          {
            className: "grid gap-3",
            "data-testid": "analyst-hypotheses-list"
          },
          ...claims.map(({ kind, claim }, index) =>
            React.createElement(
              "article",
              {
                key: kind + ":" + String(index),
                className:
                  "rounded-lg border border-border bg-surface p-3 space-y-2"
              },
              React.createElement(
                "p",
                {
                  className:
                    "text-meta font-semibold uppercase tracking-wide text-fg-muted"
                },
                kind
              ),
              React.createElement(
                "p",
                { className: "text-sm text-fg" },
                claim.text
              ),
              claim.evidenceRefs.length > 0
                ? React.createElement(
                    "div",
                    { className: "flex flex-wrap gap-x-3 gap-y-1" },
                    ...claim.evidenceRefs.map((ref, refIndex) =>
                      React.createElement(
                        NavigationLink,
                        {
                          key: ref.kind + ":" + ref.id + ":" + String(refIndex),
                          href: playtestingEpisodeHref(
                            scope,
                            episode.episodeId,
                            typeof ref.step === "number" ? ref.step : null
                          ),
                          className: EVIDENCE_LINK_CLASS,
                          dataAttributes: {
                            "data-analyst-evidence": ref.kind,
                            "data-analyst-evidence-id": ref.id
                          }
                        },
                        ref.kind +
                          (typeof ref.step === "number"
                            ? " · step " + String(ref.step)
                            : " · " + ref.id)
                      )
                    )
                  )
                : null
            )
          )
        )
      : React.createElement(
          "div",
          {
            className:
              "rounded-lg border border-border bg-surface/50 p-4 text-xs text-fg-muted"
          },
          "No persisted analyst hypotheses recorded for this session."
        ),
    review && review.experiments.length > 0
      ? React.createElement(
          "details",
          { className: "rounded-lg border border-border p-3" },
          React.createElement(
            "summary",
            { className: "cursor-pointer text-xs font-semibold text-fg" },
            "Follow-up experiments"
          ),
          React.createElement(
            "ul",
            { className: "mt-2 space-y-2" },
            ...review.experiments.map((experiment, index) =>
              React.createElement(
                "li",
                {
                  key: "experiment:" + String(index),
                  className: "text-xs text-fg-secondary"
                },
                experiment.hypothesis + " · Falsifier: " + experiment.falsifier
              )
            )
          )
        )
      : null
  );
}

function discoveryAnalystReview(
  review: PlaytestDiscoverySessionReview | null,
  scope: PlaytestingScope
): React.JSX.Element | null {
  if (review === null) return null;
  const claims = [
    ...review.observations.map((claim) => ({
      section: "Observation",
      claim
    })),
    ...review.interpretations.map((claim) => ({
      section: "Interpretation",
      claim
    })),
    ...review.alternativeExplanations.map((claim) => ({
      section: "Alternative explanation",
      claim
    }))
  ];
  return React.createElement(
    "section",
    {
      className:
        "rounded-xl border border-border bg-surface-raised p-5 shadow-sm space-y-4",
      "data-testid": "discovery-analyst-review"
    },
    React.createElement(
      "div",
      {
        className:
          "flex flex-wrap items-center justify-between gap-3 border-b border-border pb-3"
      },
      React.createElement(
        "div",
        null,
        React.createElement(
          "h3",
          { className: "text-sm font-semibold text-fg" },
          "Visual Discovery Review"
        ),
        React.createElement(
          "p",
          { className: MUTED_META_CLASS },
          "Unscored analyst hypotheses from the selected visual evidence."
        )
      ),
      React.createElement(
        "span",
        {
          className:
            "rounded bg-surface px-2.5 py-0.5 text-xs font-medium text-fg-muted",
          "data-discovery-review-status": review.status
        },
        "Unscored · " + review.status
      )
    ),
    React.createElement(
      "p",
      { className: MUTED_BODY_CLASS },
      review.chronologicalSummary
    ),
    claims.length > 0
      ? React.createElement(
          "div",
          { className: "grid gap-3", "data-testid": "discovery-review-claims" },
          ...claims.map(({ section, claim }, index) =>
            React.createElement(
              "article",
              {
                key: section + ":" + String(index),
                className:
                  "rounded-lg border border-border bg-surface p-3 space-y-2"
              },
              React.createElement(
                "p",
                {
                  className:
                    "text-meta font-semibold uppercase tracking-wide text-fg-muted"
                },
                section + " · " + claim.status
              ),
              React.createElement(
                "p",
                { className: "text-sm text-fg" },
                claim.text
              ),
              claim.evidenceRefs.length > 0
                ? React.createElement(
                    "div",
                    { className: "flex flex-wrap gap-x-3 gap-y-1" },
                    ...claim.evidenceRefs.map((ref, refIndex) =>
                      React.createElement(
                        NavigationLink,
                        {
                          key: ref.kind + ":" + ref.id + ":" + String(refIndex),
                          href: playtestingEpisodeHref(
                            scope,
                            review.episodeId,
                            typeof ref.step === "number" ? ref.step : null
                          ),
                          className: EVIDENCE_LINK_CLASS,
                          dataAttributes: {
                            "data-discovery-evidence": ref.kind,
                            "data-discovery-evidence-id": ref.id
                          }
                        },
                        ref.kind +
                          (typeof ref.step === "number"
                            ? " · step " + String(ref.step)
                            : " · " + ref.id)
                      )
                    )
                  )
                : null
            )
          )
        )
      : React.createElement(
          "p",
          { className: MUTED_META_CLASS },
          "No observation or interpretation claims were persisted."
        ),
    review.experiments.length > 0
      ? React.createElement(
          "details",
          { className: "rounded-lg border border-border p-3" },
          React.createElement(
            "summary",
            { className: "cursor-pointer text-xs font-semibold text-fg" },
            "Suggested follow-ups"
          ),
          React.createElement(
            "ul",
            {
              className:
                "mt-2 list-disc space-y-1 pl-5 text-xs text-fg-secondary"
            },
            ...review.experiments.map((experiment, index) =>
              React.createElement(
                "li",
                { key: "experiment:" + String(index), className: "space-y-1" },
                React.createElement(
                  "p",
                  null,
                  experiment.hypothesis +
                    " · Falsifier: " +
                    experiment.falsifier
                ),
                React.createElement(
                  "div",
                  { className: "flex flex-wrap gap-x-3 gap-y-1" },
                  ...experiment.evidenceRefs.map((ref, refIndex) =>
                    React.createElement(
                      NavigationLink,
                      {
                        key: ref.kind + ":" + ref.id + ":" + String(refIndex),
                        href: playtestingEpisodeHref(
                          scope,
                          review.episodeId,
                          typeof ref.step === "number" ? ref.step : null
                        ),
                        className: EVIDENCE_LINK_CLASS
                      },
                      ref.kind +
                        (typeof ref.step === "number"
                          ? " · step " + String(ref.step)
                          : " · " + ref.id)
                    )
                  )
                )
              )
            )
          )
        )
      : null
  );
}

function visualDebriefFact(
  label: string,
  value: React.ReactNode
): React.JSX.Element {
  return React.createElement(DetailValue, {
    label,
    valueClassName: "mt-1 break-words text-sm text-fg-secondary",
    dataAttributes: { "data-debrief-fact": label },
    children: value
  });
}

function playerDebriefEvidenceLink(
  episode: PlaytestEpisode,
  workspaceId: string,
  scope: PlaytestingScope,
  reference: PlaytestPlayerEvidenceReference
): React.JSX.Element {
  const frame = episode.frames.find(
    (item) =>
      item.kind === "frame" &&
      item.id === reference.id &&
      item.step === reference.step &&
      item.frameIndex === reference.frameIndex
  );
  if (!frame) {
    return React.createElement(
      "span",
      { key: reference.id },
      `Unresolved stored frame ${reference.id} · step ${reference.step}`
    );
  }
  const mediaHref = `/api/playtesting/episodes/${encodeURIComponent(episode.episodeId)}/media/${encodeURIComponent(frame.id)}?workspaceId=${encodeURIComponent(workspaceId)}`;
  return React.createElement(
    "span",
    { key: reference.id, className: "flex flex-wrap gap-2" },
    React.createElement(
      NavigationLink,
      { href: mediaHref, className: EVIDENCE_LINK_CLASS },
      `Open frame ${reference.frameIndex + 1}`
    ),
    React.createElement(
      NavigationLink,
      {
        href: playtestingEpisodeHref(scope, episode.episodeId, reference.step),
        className: EVIDENCE_LINK_CLASS
      },
      `Open trace step ${reference.step}`
    )
  );
}

function joinPlayerReportItems(
  values: readonly string[],
  emptyMessage: string
): string {
  return values.length === 0 ? emptyMessage : values.join(" · ");
}

function completePlayerReportContent(
  episode: PlaytestEpisode,
  workspaceId: string,
  scope: PlaytestingScope,
  report: Extract<
    PlaytestEpisode["playerDebrief"],
    { readonly status: "complete" }
  >
): React.JSX.Element {
  const focus = report.focusInterpretation;
  return React.createElement(
    React.Fragment,
    null,
    visualDebriefFact("Player-authored summary", report.summary),
    visualDebriefFact(
      "Focus supplied to player",
      focus.requestedFocus ?? "No operator focus was requested."
    ),
    visualDebriefFact(
      "Interpreted objective",
      focus.objective ?? "No objective interpretation was authored."
    ),
    visualDebriefFact(
      "In scope",
      joinPlayerReportItems(focus.inScope, "No in-scope items were authored.")
    ),
    visualDebriefFact(
      "Forbidden scope",
      joinPlayerReportItems(
        focus.forbiddenScope,
        "No forbidden scope was authored."
      )
    ),
    visualDebriefFact(
      "Stop criteria",
      joinPlayerReportItems(
        focus.stopCriteria,
        "No stop criteria were authored."
      )
    ),
    visualDebriefFact("Player self-reported outcome", focus.outcome),
    visualDebriefFact(
      "Report source",
      `${report.source.modelId} · ${report.source.policyId} policy v${report.source.policyVersion} · model version ${report.source.modelVersion ?? "not reported"}`
    ),
    visualDebriefFact(
      "Assessment status",
      "Smart-direct self-report; not a verified game outcome."
    ),
    visualDebriefFact(
      "Player-reported evidence",
      focus.evidence.map((reference) =>
        playerDebriefEvidenceLink(episode, workspaceId, scope, reference)
      )
    )
  );
}

function partialPlayerReportContent(
  episode: PlaytestEpisode,
  workspaceId: string,
  scope: PlaytestingScope,
  report: Extract<
    PlaytestEpisode["playerDebrief"],
    { readonly status: "partial" }
  >
): React.JSX.Element {
  return React.createElement(
    React.Fragment,
    null,
    visualDebriefFact("Partial player report", report.reason),
    visualDebriefFact("Player-authored intention", report.checkpoint.intention),
    visualDebriefFact(
      "Player-authored predicted visible effect",
      report.checkpoint.predictedVisibleEffect
    ),
    visualDebriefFact(
      "Report source",
      `${report.source.modelId} · ${report.source.policyId} policy v${report.source.policyVersion} · model version ${report.source.modelVersion ?? "not reported"}`
    ),
    visualDebriefFact(
      "Assessment status",
      "Player checkpoint; predicted effect is not a verified game outcome."
    ),
    visualDebriefFact(
      "Checkpoint evidence",
      playerDebriefEvidenceLink(
        episode,
        workspaceId,
        scope,
        report.checkpoint.evidence
      )
    )
  );
}

function playerDebriefStatusMessage(
  report: PlaytestEpisode["playerDebrief"]
): React.JSX.Element {
  let message: string;
  switch (report.status) {
    case "absent": {
      message = "No player debrief was persisted for this episode.";
      break;
    }
    case "pending": {
      message = "Player debrief is pending while the episode is in progress.";
      break;
    }
    case "not-applicable": {
      message =
        "Player debrief is not applicable to this non-reflective policy.";
      break;
    }
    case "unavailable": {
      message = `Player debrief is unavailable: ${report.reason}.`;
      break;
    }
    case "partial":
    case "complete": {
      message = "";
      break;
    }
  }
  return React.createElement("p", { className: MUTED_BODY_CLASS }, message);
}

function playerDebriefContent(
  episode: PlaytestEpisode,
  workspaceId: string,
  scope: PlaytestingScope
): React.JSX.Element {
  const report = episode.playerDebrief;
  if (report.status === "complete") {
    return completePlayerReportContent(episode, workspaceId, scope, report);
  }
  if (report.status === "partial") {
    return partialPlayerReportContent(episode, workspaceId, scope, report);
  }
  return playerDebriefStatusMessage(report);
}

function visualSessionContextFacts(
  episode: PlaytestEpisode,
  visualAssignment: ControlApiPlaytestingEpisodeDetailResponse["visualAssignment"]
): readonly React.ReactNode[] {
  const visualSource = episode.executionProvenance.source;
  const browserBuildIdentity =
    visualSource.kind === "URL-only" &&
    visualSource.artifactFingerprint === null &&
    episode.identity.buildSha === null
      ? "Unknown. No verified browser-build fingerprint is bound to this URL-only target."
      : (visualSource.artifactFingerprint ??
        episode.identity.buildSha ??
        "Unknown.");
  return [
    visualDebriefFact(
      "Recorded assignment focus",
      visualAssignment === null
        ? "Visual assignment context is unavailable."
        : (visualAssignment.areasOfFocus ?? "No operator focus was requested.")
    ),
    visualDebriefFact(
      "Frozen target",
      visualAssignment === null
        ? "Visual assignment context is unavailable."
        : `${visualAssignment.targetId} · approval ${visualAssignment.targetApprovalId} · revision ${String(visualAssignment.targetRevision)} · ${visualAssignment.targetOrigin}`
    ),
    visualDebriefFact("Browser build identity", browserBuildIdentity),
    visualDebriefFact(
      "Recorded session",
      `${String(episode.stepCount)} steps · ${episode.status} · termination ${episode.termination.reason}${episode.termination.step === null ? "" : ` at step ${String(episode.termination.step)}`}`
    ),
    visualDebriefFact(
      "Game outcome",
      "Not independently verified. This visual-only session has no game-owned terminal outcome."
    )
  ];
}

function playerDebriefPanel(
  episode: PlaytestEpisode,
  visualAssignment: ControlApiPlaytestingEpisodeDetailResponse["visualAssignment"],
  workspaceId: string,
  scope: PlaytestingScope
): React.JSX.Element | null {
  const report = episode.playerDebrief;
  const isVisual = episode.executionProvenance.mode === "autonomous-visual";
  if (
    !isVisual &&
    report.status !== "not-applicable" &&
    report.status !== "absent"
  )
    return null;
  const contextFacts = isVisual
    ? visualSessionContextFacts(episode, visualAssignment)
    : [];
  const authorFact =
    report.status === "complete" || report.status === "partial"
      ? visualDebriefFact("Report author", report.source.authorRole)
      : null;
  return React.createElement(
    "section",
    {
      className: LIST_PANEL_CLASS,
      "aria-labelledby": "player-debrief-heading",
      "data-testid": isVisual ? "visual-player-debrief" : "player-debrief"
    },
    heading("player-debrief-heading", "Player debrief"),
    React.createElement(
      "p",
      { className: MUTED_BODY_CLASS },
      "Player-authored self-report is separate from verified game outcomes and analyst hypotheses. Target/build identity below is recorded context, not report content."
    ),
    React.createElement(
      "dl",
      { className: "mt-3 grid gap-3 sm:grid-cols-2" },
      ...contextFacts
    ),
    React.createElement(
      "div",
      {
        className: "mt-3 space-y-2",
        "data-player-debrief-status": report.status
      },
      visualDebriefFact("Report status", report.status),
      authorFact,
      playerDebriefContent(episode, workspaceId, scope)
    )
  );
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
        `${executionModeLabel(episode.executionProvenance.mode)} · ${executionSourceSummary(episode.executionProvenance)}${episode.executionProvenance.mode === "adapter-accelerated" ? ` · engine ${episode.identity.gameBuild ?? "Build unknown"}` : ""}`
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
          // The termination reason names the limit that cut a truncated
          // episode short. Without it the badge can only say that *a* limit
          // did, which is the vagueness this badge exists to remove.
          executionStatusBadge(episode.status, episode.termination.reason)
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
    playerDebriefPanel(
      episode,
      detail.visualAssignment,
      detail.workspaceId,
      traceScope
    ),
    visualGameSpectatorStage(episode, traceScope, window, detail.workspaceId),
    aiGameplayCriticScorecard(episode, detail.latestReview, scope),
    discoveryAnalystReview(detail.latestDiscoveryReview, scope),
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
