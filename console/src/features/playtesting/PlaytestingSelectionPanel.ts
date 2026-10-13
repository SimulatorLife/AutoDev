"use client";

/**
 * Multi-session analysis over an explicit selection.
 *
 * The selection lives in the URL, so a shared link, a refresh and Back all
 * reproduce the same set of sessions. Runtime decides which of them can
 * contribute evidence; this surface renders its answer and shows every receipt
 * by name, because a session that silently contributed nothing would make a
 * cross-session claim look better grounded than it is.
 */
import { PLAYTESTS_MAX_ANALYSIS_SESSIONS } from "@simulatorlife/autodev-core";
import React, { useCallback, useEffect, useState } from "react";

import { SECTION_HEADING_CLASS } from "../../components/layout/Heading.ts";
import { LIST_PANEL_CLASS } from "../../components/layout/Panel.ts";
import { FIELD_CONTROL_CLASS } from "../../components/ui/field-classes.ts";
import {
  MUTED_BODY_CLASS,
  MUTED_META_CLASS
} from "../../components/ui/text-classes.ts";
import { responseMessage } from "./playtesting-run-messages.ts";

export interface PlaytestingAnalysisResult {
  readonly requested: number;
  readonly packets: readonly {
    readonly episodeId: string;
    readonly batchId: string;
  }[];
  readonly receipts: readonly {
    readonly episodeId: string;
    readonly batchId: string | null;
    readonly reason: string;
    readonly detail: string;
  }[];
  readonly budget: readonly {
    readonly batchId: string;
    readonly reviewCap: number;
    readonly actualCritiques: number;
    readonly reserved: number;
    readonly requested: number;
    readonly remaining: number;
  }[];
}

async function postAnalysis(
  workspaceId: string,
  episodeIds: readonly string[]
): Promise<
  | { readonly ok: true; readonly data: PlaytestingAnalysisResult }
  | { readonly ok: false; readonly message: string }
> {
  const body = new URLSearchParams({
    workspaceId,
    episodeIds: JSON.stringify(episodeIds)
  });
  const response = await fetch("/api/playtesting/analyses", {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/x-www-form-urlencoded"
    },
    body
  });
  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    return { ok: false, message: responseMessage(payload) };
  }
  const data = (payload as { kind?: unknown; data?: unknown });
  if (data.kind !== "ok" || typeof data.data !== "object") {
    return { ok: false, message: responseMessage(payload) };
  }
  return { ok: true, data: data.data as PlaytestingAnalysisResult };
}

export interface PlaytestingSelectionPanelProps {
  readonly workspaceId: string | null;
  readonly selectableEpisodeIds: readonly string[];
  readonly selectedEpisodeIds: readonly string[];
  readonly onSelectionChange: (episodeIds: readonly string[]) => void;
}

export function PlaytestingSelectionPanel({
  workspaceId,
  selectableEpisodeIds,
  selectedEpisodeIds,
  onSelectionChange
}: PlaytestingSelectionPanelProps): React.JSX.Element {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<PlaytestingAnalysisResult | null>(null);

  useEffect(() => {
    setResult(null);
    setError(null);
  }, [selectedEpisodeIds.join(",")]);

  const toggle = useCallback(
    (episodeId: string) => {
      const next = selectedEpisodeIds.includes(episodeId)
        ? selectedEpisodeIds.filter((id) => id !== episodeId)
        : [...selectedEpisodeIds, episodeId];
      onSelectionChange(next.slice(0, PLAYTESTS_MAX_ANALYSIS_SESSIONS));
    },
    [onSelectionChange, selectedEpisodeIds]
  );

  const analyze = useCallback(async () => {
    if (!workspaceId || selectedEpisodeIds.length === 0) return;
    setPending(true);
    setError(null);
    try {
      const outcome = await postAnalysis(workspaceId, selectedEpisodeIds);
      if (outcome.ok) setResult(outcome.data);
      else setError(outcome.message);
    } finally {
      setPending(false);
    }
  }, [selectedEpisodeIds, workspaceId]);

  return React.createElement(
    "section",
    {
      "aria-label": "Multi-session analysis",
      className: LIST_PANEL_CLASS,
      "data-testid": "playtesting-selection",
      "data-selected": String(selectedEpisodeIds.length)
    },
    React.createElement(
      "h2",
      { className: SECTION_HEADING_CLASS },
      "Multi-session analysis"
    ),
    React.createElement(
      "p",
      { className: MUTED_BODY_CLASS },
      `Select up to ${String(PLAYTESTS_MAX_ANALYSIS_SESSIONS)} persisted sessions. The selection is shareable through this page's URL.`
    ),
    React.createElement(
      "ul",
      { className: "flex flex-col gap-1" },
      ...selectableEpisodeIds.map((episodeId) =>
        React.createElement(
          "li",
          { key: episodeId },
          React.createElement(
            "label",
            {
              className: "flex items-center gap-2 text-sm",
              "data-testid": "playtesting-selection-option",
              "data-episode-id": episodeId
            },
            React.createElement("input", {
              type: "checkbox",
              checked: selectedEpisodeIds.includes(episodeId),
              disabled:
                !selectedEpisodeIds.includes(episodeId) &&
                selectedEpisodeIds.length >= PLAYTESTS_MAX_ANALYSIS_SESSIONS,
              onChange: () => toggle(episodeId)
            }),
            React.createElement("span", null, episodeId)
          )
        )
      )
    ),
    React.createElement(
      "button",
      {
        type: "button",
        className: FIELD_CONTROL_CLASS,
        disabled:
          pending || !workspaceId || selectedEpisodeIds.length === 0,
        onClick: () => void analyze()
      },
      pending ? "Requesting analysis" : "Request analysis"
    ),
    error
      ? React.createElement(
          "p",
          {
            className: `${MUTED_BODY_CLASS} border-l-2 border-l-amber-500 pl-3`,
            "data-testid": "playtesting-selection-error"
          },
          error
        )
      : null,
    result
      ? React.createElement(AnalysisResultView, { result })
      : null
  );
}

function AnalysisResultView({
  result
}: {
  readonly result: PlaytestingAnalysisResult;
}): React.JSX.Element {
  return React.createElement(
    "div",
    {
      "data-testid": "playtesting-selection-result",
      className: "flex flex-col gap-2"
    },
    React.createElement(
      "p",
      { className: MUTED_BODY_CLASS },
      `Analysed ${String(result.packets.length)} of ${String(
        result.requested
      )} selected ${result.requested === 1 ? "session" : "sessions"}.`
    ),
    result.packets.length > 0
      ? React.createElement(
          "ul",
          { className: "list-none p-0 m-0 flex flex-col gap-1" },
          ...result.packets.map((packet) =>
            React.createElement(
              "li",
              {
                key: packet.episodeId,
                className: MUTED_META_CLASS,
                "data-testid": "playtesting-selection-packet"
              },
              `${packet.episodeId} — ${packet.batchId}`
            )
          )
        )
      : null,
    // Every excluded or unreadable session is named. A dropped session would
    // let the count above read as better-grounded than the selection is.
    result.receipts.length > 0
      ? React.createElement(
          "ul",
          { className: "list-none p-0 m-0 flex flex-col gap-1" },
          ...result.receipts.map((receipt) =>
            React.createElement(
              "li",
              {
                key: receipt.episodeId,
                className: MUTED_BODY_CLASS,
                "data-testid": "playtesting-selection-receipt",
                "data-reason": receipt.reason
              },
              `${receipt.episodeId}: ${receipt.reason} — ${receipt.detail}`
            )
          )
        )
      : null,
    ...result.budget.map((entry) =>
      React.createElement(
        "p",
        {
          key: entry.batchId,
          className: MUTED_META_CLASS,
          "data-testid": "playtesting-selection-budget"
        },
        `${entry.batchId}: ${String(entry.remaining)} of ${String(
          entry.reviewCap
        )} critiques remain; ${String(entry.requested)} requested.`
      )
    )
  );
}