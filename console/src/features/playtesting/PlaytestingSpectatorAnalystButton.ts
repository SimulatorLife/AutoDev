"use client";

import type { ControlApiPlaytestingAnalysisDispatchResponse } from "@simulatorlife/autodev-core";
import React, { useState } from "react";

import { Button } from "../../components/forms/Button.ts";
import {
  playtestingAnalyzeEpisodeHref,
  type PlaytestingScope
} from "./playtesting-url.ts";
import { dispatchAnalystReview } from "./PlaytestingSelectionPanel.ts";

export function PlaytestingSpectatorAnalystButton({
  workspaceId,
  episodeId,
  scope
}: {
  readonly workspaceId: string | null;
  readonly episodeId: string;
  readonly scope: PlaytestingScope;
}): React.JSX.Element {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dispatchResult, setDispatchResult] =
    useState<ControlApiPlaytestingAnalysisDispatchResponse | null>(null);

  const handleDispatch = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!workspaceId || pending) return;
    setPending(true);
    setError(null);
    try {
      // The spectator dispatch is a hypothesis review of one session. A
      // findings review is requested from the sessions view, where the
      // operator states that the review must file defects.
      const outcome = await dispatchAnalystReview(
        workspaceId,
        [episodeId],
        false
      );
      if (outcome.ok) {
        setDispatchResult(outcome.data);
      } else {
        setError(outcome.message);
      }
    } catch (error_: unknown) {
      setError(
        error_ instanceof Error ? error_.message : "Failed to dispatch analysis"
      );
    } finally {
      setPending(false);
    }
  };

  const statusHref = playtestingAnalyzeEpisodeHref(scope, episodeId);
  const receiptSummary =
    dispatchResult && dispatchResult.packets.length > 0
      ? "Packet: " + dispatchResult.packets.map((p) => p.packetId).join(", ")
      : dispatchResult && dispatchResult.receipts.length > 0
        ? "Receipt: " + dispatchResult.receipts.map((r) => r.reason).join(", ")
        : "Dispatched";

  return React.createElement(
    "form",
    {
      onSubmit: (e: React.FormEvent<HTMLFormElement>) => void handleDispatch(e),
      className: "flex flex-wrap items-center gap-2",
      "data-testid": "spectator-analyst-dispatch-form"
    },
    React.createElement(
      Button,
      {
        type: "submit",
        variant: "primary",
        size: "compact",
        // No workspace is an unavailable control; a dispatch in flight is a
        // working one.
        disabled: !workspaceId,
        busy: pending,
        className: "inline-flex items-center gap-1.5 rounded-lg shadow-sm",
        dataAttributes: { "data-playtesting-spectator-analyze": episodeId }
      },
      React.createElement("span", { "aria-hidden": true }, "🔍"),
      pending
        ? "Dispatching Analysis…"
        : dispatchResult
          ? "Analysis Dispatched"
          : "Analyze with Playtest Analyst"
    ),
    dispatchResult
      ? React.createElement(
          "div",
          {
            className: "inline-flex items-center gap-2 text-xs",
            "data-testid": "analyst-dispatch-receipt"
          },
          React.createElement(
            "span",
            { className: "font-semibold text-accent" },
            "✓ " + receiptSummary
          ),
          React.createElement(
            "a",
            {
              href: statusHref,
              className:
                "font-semibold text-accent underline hover:brightness-110"
            },
            "View Analysis Status →"
          )
        )
      : null,
    error
      ? React.createElement(
          "span",
          { className: "text-xs font-medium text-error", role: "alert" },
          error
        )
      : null
  );
}
