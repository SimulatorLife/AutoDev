"use client";

import {
  type ControlApiPlaytestingReview,
  type PlaytestEpisode,
  PLAYTESTS_MAX_ANALYSIS_SESSIONS
} from "@simulatorlife/autodev-core";
import React, { useCallback, useEffect, useMemo, useState } from "react";

import {
  FilterBar,
  FilterSearchField
} from "../../components/filters/FilterBar.ts";
import { LIST_PANEL_CLASS } from "../../components/layout/Panel.ts";
import { NavigationLink } from "../../components/navigation/NavigationLink.ts";
import { EmptyState } from "../../components/status/EmptyState.ts";
import { FIELD_CONTROL_CLASS } from "../../components/ui/field-classes.ts";
import { MUTED_META_CLASS } from "../../components/ui/text-classes.ts";
import {
  episodeScenarioLabel,
  executionStatusBadge,
  gameOutcomeBadge,
  NO_ANALYSIS_LABEL,
  type SessionAnalysis,
  sessionAnalysisLine,
  sessionMetaLine
} from "./playtesting-episode-presentation.ts";
import {
  parsePlaytestingScope,
  playtestingEpisodeHref,
  type PlaytestingLayout,
  playtestingListHref,
  playtestingPageHref,
  playtestingPreservedFields,
  type PlaytestingScope
} from "./playtesting-url.ts";
import { PlaytestingSelectionPanel } from "./PlaytestingSelectionPanel.ts";

function selectionFromLocation(): {
  readonly ids: readonly string[];
  readonly rejected: boolean;
  readonly layout: PlaytestingLayout;
} {
  const params = new URLSearchParams(globalThis.location.search);
  const scope = parsePlaytestingScope({
    ...(params.has("view") ? { view: params.get("view") ?? "" } : {}),
    ...(params.has("layout") ? { layout: params.get("layout") ?? "" } : {}),
    ...(params.has("workspaceId")
      ? { workspaceId: params.get("workspaceId") ?? "" }
      : {}),
    ...(params.has("sessions") ? { sessions: params.getAll("sessions") } : {})
  });
  return {
    ids: scope.selectedEpisodeIds,
    rejected: scope.invalidSelection,
    layout: scope.layout
  };
}

/**
 * The session search, above the list it narrows.
 *
 * The search is a server-side filter -- the whole archive, not the page on
 * screen -- so it is a GET form that carries the rest of the scope, not a
 * control that filters what has already been loaded.
 *
 * It sits above the list rather than inside the Filters panel because that is
 * where a reader looks for it: a search hidden behind a disclosure is a
 * search most readers never find.
 */
function sessionSearchBar(scope: PlaytestingScope): React.JSX.Element {
  return React.createElement(FilterBar, {
    label: "Session search",
    action: "/playtesting",
    preserved: playtestingPreservedFields(scope, ["q"]),
    submitLabel: "Search",
    submitTestId: "playtesting-session-search",
    dataAttributes: { "data-session-search": "true" },
    children: React.createElement(FilterSearchField, {
      name: "q",
      defaultValue: scope.filters.q ?? "",
      label: "Search sessions",
      placeholder: "Session id, batch, scenario",
      testId: "playtesting-session-query"
    })
  });
}

export function PlaytestingSessionsWorkspace({
  scope,
  rows,
  total,
  nextCursor,
  reviews = null,
  reviewTotal = null
}: {
  readonly scope: PlaytestingScope;
  readonly rows: readonly PlaytestEpisode[];
  readonly total: number;
  readonly nextCursor: string | null;
  /**
   * The workspace's analyst reviews, when they could be read.
   *
   * Null means they could not: the rows then carry no analysis line, because
   * a row that said "no analyst review" when the review read failed would be
   * claiming something nobody observed.
   */
  readonly reviews?: readonly ControlApiPlaytestingReview[] | null | undefined;
  /** How many reviews the workspace holds in all. */
  readonly reviewTotal?: number | null | undefined;
}): React.JSX.Element {
  const [selectedEpisodeIds, setSelectedEpisodeIds] = useState(
    scope.selectedEpisodeIds
  );
  const [rejectedSelection, setRejectedSelection] = useState(
    scope.invalidSelection
  );
  const [layout, setLayout] = useState<PlaytestingLayout>(scope.layout);

  /**
   * What the analyst recorded about each session.
   *
   * A session can carry more than one review -- a discovery review and a
   * confirmatory one -- so the counts add up.
   */
  const analysisByEpisode = useMemo(() => {
    const byEpisode = new Map<string, SessionAnalysis>();
    if (reviews === null) return byEpisode;
    for (const review of reviews) {
      const current = byEpisode.get(review.episodeId);
      byEpisode.set(
        review.episodeId,
        current === undefined
          ? {
              hypotheses: review.interpretationCount,
              observations: review.observationCount,
              findings: review.findingCount
            }
          : {
              hypotheses: current.hypotheses + review.interpretationCount,
              observations: current.observations + review.observationCount,
              findings: current.findings + review.findingCount
            }
      );
    }
    return byEpisode;
  }, [reviews]);

  /**
   * Whether every review in the workspace was read.
   *
   * Only then can a session with no review say so. A workspace with more
   * reviews than the read returned has reviews this page never saw, and
   * "no analyst review recorded" would be a claim about a gap in the read.
   */
  const everyReviewRead =
    reviews !== null && (reviewTotal === null || reviewTotal <= reviews.length);

  const changeSelection = useCallback((nextIds: readonly string[]) => {
    setSelectedEpisodeIds(nextIds);
    setRejectedSelection(false);
    const url = new URL(globalThis.location.href);
    if (nextIds.length === 0) url.searchParams.delete("sessions");
    else url.searchParams.set("sessions", nextIds.join(","));
    globalThis.history.pushState(null, "", url);
  }, []);

  useEffect(() => {
    const syncFromUrl = (): void => {
      const next = selectionFromLocation();
      setSelectedEpisodeIds(next.ids);
      setRejectedSelection(next.rejected);
      setLayout(next.layout);
    };
    globalThis.addEventListener("popstate", syncFromUrl);
    return () => globalThis.removeEventListener("popstate", syncFromUrl);
  }, []);

  const changeLayout = useCallback(
    (next: PlaytestingLayout) => {
      setLayout(next);
      globalThis.history.pushState(
        null,
        "",
        playtestingListHref({
          ...scope,
          layout: next,
          selectedEpisodeIds
        })
      );
    },
    [scope, selectedEpisodeIds]
  );

  const toggle = useCallback(
    (episodeId: string) => {
      const next = selectedEpisodeIds.includes(episodeId)
        ? selectedEpisodeIds.filter((id) => id !== episodeId)
        : [...selectedEpisodeIds, episodeId];
      if (next.length > PLAYTESTS_MAX_ANALYSIS_SESSIONS) return;
      changeSelection(next);
    },
    [changeSelection, selectedEpisodeIds]
  );

  return React.createElement(
    React.Fragment,
    null,
    sessionSearchBar(scope),
    React.createElement(
      "section",
      {
        className: LIST_PANEL_CLASS,
        "aria-labelledby": "playtesting-episodes-heading"
      },
      React.createElement(
        "div",
        { className: "flex flex-wrap items-end justify-between gap-3" },
        React.createElement(
          "div",
          null,
          React.createElement(
            "h2",
            {
              id: "playtesting-episodes-heading",
              className: "text-sm font-semibold"
            },
            "Sessions"
          ),
          React.createElement(
            "p",
            { className: MUTED_META_CLASS },
            "Execution status and game outcome are reported separately. Select rows only if you want a bounded analyst review."
          )
        ),
        React.createElement(
          "div",
          { className: "flex flex-wrap items-center justify-end gap-3" },
          React.createElement(
            "div",
            {
              className: "inline-flex rounded-lg border border-border p-1",
              role: "group",
              "aria-label": "Session layout"
            },
            ...(["list", "grid"] as const).map((option) =>
              React.createElement(
                "button",
                {
                  key: option,
                  type: "button",
                  className: `min-h-9 rounded-md px-3 text-sm ${layout === option ? "bg-surface-raised text-fg" : "text-fg-muted hover:text-fg"}`,
                  "aria-label": `${option === "list" ? "List" : "Grid"} view`,
                  "aria-pressed": layout === option,
                  "data-playtesting-layout": option,
                  onClick: () => changeLayout(option)
                },
                option === "list" ? "☷ List" : "▦ Grid"
              )
            )
          ),
          React.createElement(
            "p",
            {
              className: "text-sm font-medium",
              "aria-live": "polite",
              "data-testid": "playtesting-selection-count"
            },
            `${selectedEpisodeIds.length} of ${String(PLAYTESTS_MAX_ANALYSIS_SESSIONS)} selected`
          )
        )
      ),
      // The read is a window. A workspace with more reviews than the read
      // returned has reviews this page never saw, so the list says which
      // window it is showing rather than implying it is showing all of them.
      reviews !== null && !everyReviewRead
        ? React.createElement(
            "p",
            {
              className: `mt-3 text-sm ${MUTED_META_CLASS}`,
              "data-session-analysis-note": "true"
            },
            `Analysis counts are shown for the ${String(reviews.length)} most recent of ${String(reviewTotal ?? reviews.length)} analyst reviews.`
          )
        : null,
      rows.length === 0
        ? React.createElement(EmptyState, {
            variant: "inline",
            message:
              total === 0
                ? "No sessions match these filters. Clear or adjust filters, or start a playtest from Run."
                : "No sessions are on this page. Return to the previous page or review the active filters."
          })
        : React.createElement(
            "ul",
            {
              className: `mt-4 grid gap-3 ${layout === "grid" ? "sm:grid-cols-2 xl:grid-cols-3" : "grid-cols-1"}`,
              "aria-label": "Playtest sessions"
            },
            ...rows.map((episode) => {
              const checked = selectedEpisodeIds.includes(episode.episodeId);
              const atLimit =
                !checked &&
                selectedEpisodeIds.length >= PLAYTESTS_MAX_ANALYSIS_SESSIONS;
              return React.createElement(
                "li",
                {
                  key: episode.episodeId,
                  className:
                    layout === "grid"
                      ? "flex min-w-0 flex-col items-start gap-4 rounded-xl border border-border bg-surface p-4"
                      : "flex min-w-0 flex-wrap items-center gap-3 rounded-lg border border-border bg-surface p-3 sm:flex-nowrap",
                  "data-session-row": episode.episodeId
                },
                React.createElement("input", {
                  type: "checkbox",
                  checked,
                  disabled: atLimit,
                  onChange: () => toggle(episode.episodeId),
                  "aria-label": `Include session ${episode.episodeId} in analyst review`,
                  "data-playtesting-session-select": episode.episodeId
                }),
                React.createElement(
                  "div",
                  { className: "min-w-0 flex-1" },
                  React.createElement(
                    "div",
                    { className: "flex flex-wrap items-center gap-2" },
                    React.createElement(
                      "span",
                      { className: "font-medium" },
                      episodeScenarioLabel(episode)
                    ),
                    executionStatusBadge(
                      episode.status,
                      episode.termination.reason
                    ),
                    gameOutcomeBadge(episode.outcome)
                  ),
                  // The game's outcome is the badge above. It used to be stated
                  // a second time in a line of its own, so every row said the
                  // same thing twice: "Not observed" beside "No game outcome
                  // observed". One statement per row, and the badge says
                  // which observation it is about.
                  React.createElement(
                    "p",
                    {
                      className:
                        "mt-2 break-all font-mono text-xs text-fg-muted",
                      title: episode.episodeId
                    },
                    episode.episodeId
                  ),
                  React.createElement(
                    "p",
                    { className: MUTED_META_CLASS },
                    sessionMetaLine(episode)
                  ),
                  React.createElement(
                    "p",
                    {
                      className: MUTED_META_CLASS,
                      "data-session-analysis": episode.episodeId
                    },
                    sessionAnalysisLine(
                      analysisByEpisode.get(episode.episodeId) ?? null
                    ) ?? (everyReviewRead ? NO_ANALYSIS_LABEL : "")
                  )
                ),
                React.createElement(
                  NavigationLink,
                  {
                    href: playtestingEpisodeHref(
                      scope,
                      episode.episodeId,
                      null
                    ),
                    className: `${FIELD_CONTROL_CLASS} shrink-0`,
                    dataAttributes: {
                      "data-playtest-episode-link": episode.episodeId
                    }
                  },
                  episode.status === "assigned" || episode.status === "started"
                    ? "Watch"
                    : "Open session"
                )
              );
            })
          ),
      React.createElement(
        "div",
        { className: "mt-4 flex flex-wrap items-center justify-between gap-3" },
        React.createElement(
          "p",
          { className: MUTED_META_CLASS, "aria-live": "polite" },
          `${rows.length} shown · ${total} matching sessions`
        ),
        nextCursor
          ? React.createElement(
              NavigationLink,
              {
                href: playtestingPageHref(scope, nextCursor),
                className: "text-sm font-medium text-accent hover:underline",
                dataAttributes: { "data-playtesting-next-page": "true" }
              },
              "Next page"
            )
          : null
      )
    ),
    React.createElement(PlaytestingSelectionPanel, {
      scope,
      selectedEpisodeIds,
      rejectedSelection,
      onSelectionChange: changeSelection
    })
  );
}
