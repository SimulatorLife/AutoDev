import type {
  ControlApiPlaytestingEpisodeDetailResponse,
  ControlApiPlaytestingWindowResponse,
  PlaytestJsonValue
} from "@simulatorlife/autodev-core";
import React from "react";

import { StatCard } from "../../components/cards/StatCard.ts";
import { SECTION_HEADING_CLASS } from "../../components/layout/Heading.ts";
import { PageBody } from "../../components/layout/PageBody.ts";
import {
  DETAIL_PANEL_CLASS,
  LIST_PANEL_CLASS
} from "../../components/layout/Panel.ts";
import { NavigationLink } from "../../components/navigation/NavigationLink.ts";
import { StatGrid } from "../../components/panels/DetailGrid.ts";
import { EmptyState } from "../../components/status/EmptyState.ts";
import {
  NOT_OBSERVED_LABEL,
  NOT_OBSERVED_STATUS,
  StatusBadge
} from "../../components/status/StatusBadge.ts";
import {
  MONO_ID_CLASS,
  MUTED_BODY_CLASS,
  MUTED_META_CLASS
} from "../../components/ui/text-classes.ts";
import {
  playtestingEpisodeHref,
  playtestingInspectorBackHref,
  type PlaytestingScope
} from "./playtesting-url.ts";
import { executionStatusBadge, gameOutcomeBadge } from "./PlaytestingView.ts";

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
              key: `${metric.metricId}:${metric.metricVersion}`,
              className: "border-b border-border align-top"
            },
            React.createElement(
              "th",
              { scope: "row", className: "py-2 pr-4 font-medium" },
              metric.metricId
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
    "ol",
    {
      className: "flex flex-col gap-3",
      "aria-label": `Episode steps ${window.startStep} through ${window.endStep}`
    },
    ...window.entries.map((entry, index) => {
      const step = stepFor(entry);
      const selected = step !== null && scope.step === step;
      return React.createElement(
        "li",
        {
          key: `${step ?? "unindexed"}:${index}`,
          className: `${DETAIL_PANEL_CLASS} p-4 ${selected ? "border-accent" : ""}`,
          ...(selected ? { "aria-current": "step" } : {}),
          "data-playtest-step": step === null ? "unindexed" : String(step)
        },
        React.createElement(
          "div",
          {
            className: "mb-2 flex flex-wrap items-center justify-between gap-2"
          },
          React.createElement(
            "h3",
            { className: "text-sm font-semibold" },
            step === null ? "Unindexed trace entry" : `Step ${step}`
          ),
          step === null
            ? React.createElement(StatusBadge, {
                status: NOT_OBSERVED_STATUS,
                label: "Step not observed"
              })
            : React.createElement(
                NavigationLink,
                {
                  href: playtestingEpisodeHref(scope, episode.episodeId, step),
                  className: "text-xs text-accent hover:underline"
                },
                selected ? "Selected step" : "Open this step"
              )
        ),
        React.createElement(
          "pre",
          {
            className:
              "max-h-80 overflow-auto rounded bg-surface-raised p-3 text-xs leading-5 text-fg",
            "aria-label":
              step === null
                ? "Unindexed trace data"
                : `Recorded data for step ${step}`
          },
          renderJson(entry)
        )
      );
    })
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
                              reference.step ?? 0
                            ),
                            className: "text-xs text-accent hover:underline",
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
    review.observations.length > 0
      ? React.createElement(
          "ul",
          { className: "list-disc space-y-1 pl-5 text-sm" },
          ...review.observations.map((item, index) =>
            React.createElement("li", { key: `observation:${index}` }, item)
          )
        )
      : null,
    review.interpretations.length > 0
      ? React.createElement(
          "ul",
          { className: "list-disc space-y-1 pl-5 text-sm text-fg-muted" },
          ...review.interpretations.map((item, index) =>
            React.createElement("li", { key: `interpretation:${index}` }, item)
          )
        )
      : null
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

export function PlaytestingSessionView({
  detail,
  scope,
  window,
  windowUnavailable
}: PlaytestingSessionViewProps): React.JSX.Element {
  const episode = detail.record;
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
      NavigationLink,
      {
        href: playtestingInspectorBackHref(scope),
        className: "text-sm text-accent hover:underline",
        dataAttributes: { "data-playtesting-back": "true" }
      },
      scope.returnFindingId ? "← Back to findings" : "← Back to sessions"
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
        `${episode.identity.repository} · build ${episode.identity.buildSha} · ${episode.identity.gameBuild}`
      ),
      React.createElement(
        "dl",
        {
          className: "grid gap-3 sm:grid-cols-3",
          "aria-label": "Independent session status dimensions"
        },
        React.createElement(
          "div",
          null,
          React.createElement(
            "dt",
            { className: MUTED_META_CLASS },
            "Execution status"
          ),
          React.createElement(
            "dd",
            { className: "mt-1" },
            executionStatusBadge(episode.status)
          )
        ),
        React.createElement(
          "div",
          null,
          React.createElement(
            "dt",
            { className: MUTED_META_CLASS },
            "Game outcome"
          ),
          React.createElement(
            "dd",
            { className: "mt-1" },
            gameOutcomeBadge(episode.outcome)
          )
        ),
        React.createElement(
          "div",
          null,
          React.createElement(
            "dt",
            { className: MUTED_META_CLASS },
            "Replay integrity"
          ),
          React.createElement(
            "dd",
            { className: "mt-1" },
            replayStatusBadge(episode.replayStatus)
          )
        )
      )
    ),
    React.createElement(
      StatGrid,
      { columns: 4 },
      React.createElement(StatCard, {
        title: "Steps",
        value: episode.stepCount
      }),
      React.createElement(StatCard, {
        title: "Simulation wall time",
        value:
          episode.simulationWallMs === null
            ? "Not observed"
            : `${episode.simulationWallMs} ms`
      }),
      React.createElement(StatCard, {
        title: "Policy inference",
        value:
          episode.policyInferenceMs === null
            ? "Not observed"
            : `${episode.policyInferenceMs} ms`
      }),
      React.createElement(StatCard, {
        title: "Native duration",
        value:
          episode.nativeDurationMs === null
            ? "Not observed"
            : `${episode.nativeDurationMs} ms`
      })
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
            `Artifact ${episode.trace.id} · requested step ${scope.step ?? 0}`
          )
        : null,
      window
        ? React.createElement(
            "p",
            { className: MUTED_META_CLASS },
            `Integrity verified · SHA-256 ${window.sha256} · ${window.sourceLineCount} source lines · ${window.omittedLineCount} not in this window`
          )
        : null,
      episodeSteps(detail, scope, window, windowUnavailable)
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
