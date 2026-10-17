"use client";

import {
  type PlaytestEpisode,
  PLAYTESTS_MAX_ANALYSIS_SESSIONS
} from "@simulatorlife/autodev-core";
import React, { useCallback, useEffect, useState } from "react";

import { LIST_PANEL_CLASS } from "../../components/layout/Panel.ts";
import { NavigationLink } from "../../components/navigation/NavigationLink.ts";
import { EmptyState } from "../../components/status/EmptyState.ts";
import { FIELD_CONTROL_CLASS } from "../../components/ui/field-classes.ts";
import { MUTED_META_CLASS } from "../../components/ui/text-classes.ts";
import {
  episodeScenarioLabel,
  executionModeLabel,
  executionSourceSummary,
  executionStatusBadge,
  gameOutcomeBadge
} from "./playtesting-episode-presentation.ts";
import {
  parsePlaytestingScope,
  playtestingEpisodeHref,
  type PlaytestingLayout,
  playtestingListHref,
  playtestingPageHref,
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

export function PlaytestingSessionsWorkspace({
  scope,
  rows,
  total,
  nextCursor
}: {
  readonly scope: PlaytestingScope;
  readonly rows: readonly PlaytestEpisode[];
  readonly total: number;
  readonly nextCursor: string | null;
}): React.JSX.Element {
  const [selectedEpisodeIds, setSelectedEpisodeIds] = useState(
    scope.selectedEpisodeIds
  );
  const [rejectedSelection, setRejectedSelection] = useState(
    scope.invalidSelection
  );
  const [layout, setLayout] = useState<PlaytestingLayout>(scope.layout);

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
                    executionStatusBadge(episode.status),
                    gameOutcomeBadge(episode.outcome)
                  ),
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
                    { className: "mt-2 text-sm font-medium" },
                    episode.outcome === "unknown"
                      ? "No game outcome observed"
                      : `Recorded game outcome: ${episode.outcome}`
                  ),
                  React.createElement(
                    "p",
                    { className: MUTED_META_CLASS },
                    `${executionModeLabel(episode.executionProvenance.mode)} · ${episode.identity.policyId} · ${episode.policyCohort ?? "No cohort assigned"} · ${String(episode.stepCount)} steps · ${executionSourceSummary(episode.executionProvenance)}`
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
