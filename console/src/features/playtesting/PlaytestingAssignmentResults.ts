"use client";

/** One source-backed rendering of execution and game outcomes per assignment. */
import type {
  PlaytestRunAssignmentOutcome,
  PlaytestSessionReference
} from "@simulatorlife/autodev-core";
import React, { useState } from "react";

import { NavigationLink } from "../../components/navigation/NavigationLink.ts";
import { NOT_OBSERVED_LABEL } from "../../components/status/StatusBadge.ts";
import {
  MUTED_BODY_CLASS,
  MUTED_META_CLASS
} from "../../components/ui/text-classes.ts";
import { gameOutcomeLabel } from "./playtesting-labels.ts";
import {
  playtestingEpisodeHref,
  type PlaytestingScope
} from "./playtesting-url.ts";

export interface PlaytestingAssignmentResultsProps {
  readonly outcomes: readonly PlaytestRunAssignmentOutcome[] | null;
  readonly sessions: readonly PlaytestSessionReference[];
  readonly scope: PlaytestingScope;
  readonly pending: boolean;
  readonly live: boolean;
}

export function PlaytestingAssignmentResults({
  outcomes,
  sessions,
  scope,
  pending,
  live
}: PlaytestingAssignmentResultsProps): React.JSX.Element {
  const [showAll, setShowAll] = useState(false);
  const content =
    outcomes === null
      ? React.createElement(
          "p",
          { className: MUTED_BODY_CLASS },
          pending
            ? "Assignment outcomes are not recorded yet."
            : "Assignment outcomes are unavailable for this run status."
        )
      : outcomes.length === 0
        ? React.createElement(
            "p",
            { className: MUTED_BODY_CLASS },
            "No assignment outcomes have been recorded yet."
          )
        : React.createElement(
            "ol",
            {
              className: "max-h-80 list-none space-y-2 overflow-y-auto p-0",
              "aria-label": "Per-assignment results"
            },
            ...(showAll ? outcomes : outcomes.slice(0, 10)).map((outcome) =>
              React.createElement(
                "li",
                {
                  key: outcome.assignmentId,
                  className: "rounded-md border border-border p-3",
                  "data-testid": "playtesting-assignment-outcome",
                  "data-assignment-id": outcome.assignmentId,
                  "data-execution-state": outcome.state,
                  "data-game-outcome": outcome.gameOutcome ?? "not-observed"
                },
                React.createElement(
                  "p",
                  { className: MUTED_META_CLASS },
                  `Assignment ${outcome.assignmentId}`
                ),
                React.createElement(
                  "p",
                  { className: MUTED_BODY_CLASS },
                  `Execution state: ${outcome.state}`
                ),
                React.createElement(
                  "p",
                  { className: MUTED_BODY_CLASS },
                  `Game outcome: ${outcome.gameOutcome === null ? NOT_OBSERVED_LABEL : gameOutcomeLabel(outcome.gameOutcome)}`
                ),
                React.createElement(
                  "p",
                  { className: MUTED_META_CLASS },
                  `Started: ${outcome.started ? "yes" : "no"}; measurement eligible: ${outcome.eligible ? "yes" : "no"}`
                ),
                outcome.episodeId === null
                  ? React.createElement(
                      "p",
                      { className: MUTED_META_CLASS },
                      "No persisted session."
                    )
                  : scope.workspaceId === null
                    ? React.createElement(
                        "p",
                        { className: MUTED_META_CLASS },
                        `Session ${outcome.episodeId}`
                      )
                    : React.createElement(
                        NavigationLink,
                        {
                          className: "text-sm text-accent hover:underline",
                          href: playtestingEpisodeHref(
                            scope,
                            outcome.episodeId,
                            null
                          ),
                          dataAttributes: {
                            "data-testid": "playtesting-assignment-session-link"
                          }
                        },
                        `Open session ${outcome.episodeId}`
                      )
              )
            ),
            outcomes.length > 10
              ? React.createElement(
                  "button",
                  {
                    type: "button",
                    className:
                      "text-sm font-medium text-accent hover:underline",
                    onClick: () => setShowAll((current) => !current),
                    "data-testid": "playtesting-assignment-outcomes-toggle"
                  },
                  showAll
                    ? "Show first 10 results"
                    : `Show all ${String(outcomes.length - 10)} more results`
                )
              : null
          );
  const outcomeAssignments = new Set(
    outcomes?.map((outcome) => outcome.assignmentId)
  );
  const pendingSessions = sessions.filter(
    (session) => !outcomeAssignments.has(session.assignmentId)
  );
  const liveSessions =
    live && pendingSessions.length > 0
      ? React.createElement(
          "section",
          {
            className: "space-y-2",
            "aria-label": "Live playtest sessions",
            "data-testid": "playtesting-live-session-links"
          },
          React.createElement(
            "h3",
            { className: "font-semibold" },
            "Watch sessions"
          ),
          React.createElement(
            "ul",
            { className: "space-y-2" },
            ...pendingSessions.map((session) =>
              React.createElement(
                "li",
                {
                  key: session.assignmentId,
                  className:
                    "flex flex-wrap items-center justify-between gap-2",
                  "data-assignment-id": session.assignmentId
                },
                React.createElement(
                  "span",
                  { className: MUTED_META_CLASS },
                  `Assignment ${session.assignmentId}`
                ),
                scope.workspaceId === null
                  ? React.createElement(
                      "span",
                      { className: MUTED_META_CLASS },
                      `Session ${session.episodeId}`
                    )
                  : React.createElement(
                      NavigationLink,
                      {
                        className: "text-sm text-accent hover:underline",
                        href: playtestingEpisodeHref(
                          scope,
                          session.episodeId,
                          null
                        ),
                        dataAttributes: {
                          "data-testid": "playtesting-live-session-link"
                        }
                      },
                      "Watch session"
                    )
              )
            )
          )
        )
      : null;
  return React.createElement(
    React.Fragment,
    null,
    liveSessions,
    React.createElement(
      "section",
      { className: "space-y-2", "aria-label": "Assignment outcomes" },
      React.createElement(
        "h3",
        { className: "font-semibold" },
        "Assignment outcomes"
      ),
      content
    )
  );
}
