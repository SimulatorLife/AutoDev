/** One source-backed rendering of execution and game outcomes per assignment. */
import type { PlaytestRunAssignmentOutcome } from "@simulatorlife/autodev-core";
import React from "react";

import { NavigationLink } from "../../components/navigation/NavigationLink.ts";
import { NOT_OBSERVED_LABEL } from "../../components/status/StatusBadge.ts";
import {
  MUTED_BODY_CLASS,
  MUTED_META_CLASS
} from "../../components/ui/text-classes.ts";
import {
  playtestingEpisodeHref,
  type PlaytestingScope
} from "./playtesting-url.ts";

export interface PlaytestingAssignmentResultsProps {
  readonly outcomes: readonly PlaytestRunAssignmentOutcome[] | null;
  readonly scope: PlaytestingScope;
  readonly pending: boolean;
}

export function PlaytestingAssignmentResults({
  outcomes,
  scope,
  pending
}: PlaytestingAssignmentResultsProps): React.JSX.Element {
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
            ...outcomes.map((outcome) =>
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
                  `Game outcome: ${gameOutcomeLabel(outcome.gameOutcome)}`
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
                            0
                          ),
                          dataAttributes: {
                            "data-testid": "playtesting-assignment-session-link"
                          }
                        },
                        `Open session ${outcome.episodeId}`
                      )
              )
            )
          );
  return React.createElement(
    "section",
    { className: "space-y-2", "aria-label": "Assignment outcomes" },
    React.createElement(
      "h3",
      { className: "font-semibold" },
      "Assignment outcomes"
    ),
    content
  );
}

function gameOutcomeLabel(outcome: string | null): string {
  if (outcome === null) return NOT_OBSERVED_LABEL;
  if (outcome === "dnf") return "DNF";
  if (outcome === "unknown") return "Unclassified";
  return outcome[0]!.toUpperCase() + outcome.slice(1);
}
