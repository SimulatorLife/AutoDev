"use client";

/** Bounded Console selection and live dispatch to the read-only analyst role. */
import {
  type ControlApiPlaytestingAnalysesResponse,
  type ControlApiPlaytestingAnalysisDispatchResponse,
  PLAYTESTS_MAX_ANALYSIS_SESSIONS
} from "@simulatorlife/autodev-core";
import React, { useCallback, useEffect, useRef, useState } from "react";

import { SECTION_HEADING_CLASS } from "../../components/layout/Heading.ts";
import { LIST_PANEL_CLASS } from "../../components/layout/Panel.ts";
import { FIELD_CONTROL_CLASS } from "../../components/ui/field-classes.ts";
import { MUTED_BODY_CLASS } from "../../components/ui/text-classes.ts";
import { responseMessage } from "./playtesting-run-messages.ts";
import type { PlaytestingScope } from "./playtesting-url.ts";
import { PlaytestingAnalysisResults } from "./PlaytestingAnalysisResults.ts";

const ANALYSIS_STATUS_POLL_MS = 1500;
const ANALYSIS_STATUS_MAX_POLL_MS = 8000;
const ANALYSIS_RUN_COLLATOR = new Intl.Collator(undefined, { numeric: true });

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function dispatchAnalystReview(
  workspaceId: string,
  episodeIds: readonly string[]
): Promise<
  | {
      readonly ok: true;
      readonly data: ControlApiPlaytestingAnalysisDispatchResponse;
    }
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
  const envelope = isRecord(payload) ? payload : null;
  const data = isRecord(envelope?.data) ? envelope.data : null;
  if (
    envelope?.kind !== "ok" ||
    !data ||
    data.schema !== "autodev-control-playtesting-analysis-v1" ||
    data.operation !== "dispatch" ||
    data.workspaceId !== workspaceId ||
    data.requested !== episodeIds.length ||
    !Array.isArray(data.packets) ||
    !Array.isArray(data.receipts) ||
    (data.analysis !== null && !isRecord(data.analysis))
  ) {
    return { ok: false, message: responseMessage(payload) };
  }
  return {
    ok: true,
    data: data as unknown as ControlApiPlaytestingAnalysisDispatchResponse
  };
}

export interface PlaytestingSelectionPanelProps {
  readonly scope: PlaytestingScope;
  readonly selectedEpisodeIds: readonly string[];
  readonly rejectedSelection: boolean;
  readonly onSelectionChange: (episodeIds: readonly string[]) => void;
}

export function PlaytestingSelectionPanel({
  scope,
  selectedEpisodeIds,
  rejectedSelection,
  onSelectionChange
}: PlaytestingSelectionPanelProps): React.JSX.Element {
  const workspaceId = scope.workspaceId;
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [resultState, setResultState] = useState<{
    readonly workspaceId: string;
    readonly selectionKey: string;
    readonly data: ControlApiPlaytestingAnalysisDispatchResponse;
  } | null>(null);
  const [runsState, setRunsState] = useState<{
    readonly workspaceId: string;
    readonly runs: ControlApiPlaytestingAnalysesResponse["runs"];
    readonly syntheses: ControlApiPlaytestingAnalysesResponse["syntheses"];
  } | null>(null);
  const [statusState, setStatusState] = useState<{
    readonly workspaceId: string;
    readonly stale: boolean;
  } | null>(null);
  const [watchGeneration, setWatchGeneration] = useState(0);
  const knownRuns = useRef<{
    readonly workspaceId: string;
    readonly runs: ControlApiPlaytestingAnalysesResponse["runs"];
    readonly syntheses: ControlApiPlaytestingAnalysesResponse["syntheses"];
  } | null>(null);

  const selectionKey = selectedEpisodeIds.join("\0");
  const result =
    resultState?.workspaceId === workspaceId &&
    resultState.selectionKey === selectionKey
      ? resultState.data
      : null;
  const runs = runsState?.workspaceId === workspaceId ? runsState.runs : [];
  const syntheses =
    runsState?.workspaceId === workspaceId ? runsState.syntheses : [];
  const stale = statusState?.workspaceId === workspaceId && statusState.stale;

  useEffect(() => {
    setError(null);
  }, [workspaceId, selectionKey]);

  useEffect(() => {
    if (!workspaceId) return () => {};
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let delay = ANALYSIS_STATUS_POLL_MS;
    let hasSuccessfulRead = false;
    let lastKnownActive = false;
    let keepPolling = true;
    const controller = new AbortController();

    const poll = async (): Promise<void> => {
      try {
        const response = await fetch(
          `/api/playtesting/analyses?workspaceId=${encodeURIComponent(workspaceId)}`,
          { headers: { accept: "application/json" }, signal: controller.signal }
        );
        const payload: unknown = await response.json().catch(() => null);
        const envelope = isRecord(payload) ? payload : null;
        const data = isRecord(envelope?.data) ? envelope.data : null;
        if (
          !response.ok ||
          envelope?.kind !== "ok" ||
          !data ||
          data.schema !== "autodev-control-playtesting-analyses-v1" ||
          data.workspaceId !== workspaceId ||
          !Array.isArray(data.runs) ||
          !Array.isArray(data.syntheses)
        ) {
          throw new Error(responseMessage(payload));
        }
        if (cancelled) return;
        hasSuccessfulRead = true;
        const incomingRuns =
          data.runs as ControlApiPlaytestingAnalysesResponse["runs"];
        const incomingSyntheses =
          data.syntheses as ControlApiPlaytestingAnalysesResponse["syntheses"];
        const previousRuns =
          knownRuns.current?.workspaceId === workspaceId
            ? knownRuns.current.runs
            : [];
        const incomingIds = new Set(incomingRuns.map((run) => run.analysisId));
        const missingActiveRuns = previousRuns.filter(
          (run) => run.status === "running" && !incomingIds.has(run.analysisId)
        );
        const nextRuns = [...incomingRuns, ...missingActiveRuns].sort(
          (left, right) =>
            ANALYSIS_RUN_COLLATOR.compare(right.createdAt, left.createdAt)
        );
        knownRuns.current = {
          workspaceId,
          runs: nextRuns,
          syntheses: incomingSyntheses
        };
        setRunsState({
          workspaceId,
          runs: nextRuns,
          syntheses: incomingSyntheses
        });
        setStatusState({ workspaceId, stale: missingActiveRuns.length > 0 });
        lastKnownActive = nextRuns.some((run) => run.status === "running");
        keepPolling = lastKnownActive;
      } catch {
        if (cancelled) return;
        setStatusState({ workspaceId, stale: true });
        // Keep retrying after a failed read if the last known list was active;
        // an initial failure also gets bounded retries until one source read works.
        keepPolling = !hasSuccessfulRead || lastKnownActive;
      }
      if (!cancelled && keepPolling) {
        timer = setTimeout(() => void poll(), delay);
        delay = Math.min(ANALYSIS_STATUS_MAX_POLL_MS, delay * 2);
      }
    };

    void poll();
    return () => {
      cancelled = true;
      controller.abort();
      if (timer) clearTimeout(timer);
    };
  }, [workspaceId, watchGeneration]);

  const start = useCallback(async () => {
    if (!workspaceId || selectedEpisodeIds.length === 0) return;
    setPending(true);
    setError(null);
    try {
      const outcome = await dispatchAnalystReview(
        workspaceId,
        selectedEpisodeIds
      );
      if (outcome.ok) {
        setResultState({ workspaceId, selectionKey, data: outcome.data });
        const analysis = outcome.data.analysis;
        if (analysis !== null) {
          const currentRuns =
            knownRuns.current?.workspaceId === workspaceId
              ? knownRuns.current.runs
              : [];
          const nextRuns = [
            analysis,
            ...currentRuns.filter(
              (run) => run.analysisId !== analysis.analysisId
            )
          ];
          const currentSyntheses =
            knownRuns.current?.workspaceId === workspaceId
              ? knownRuns.current.syntheses
              : [];
          knownRuns.current = {
            workspaceId,
            runs: nextRuns,
            syntheses: currentSyntheses
          };
          setRunsState({
            workspaceId,
            runs: nextRuns,
            syntheses: currentSyntheses
          });
        }
        setStatusState({ workspaceId, stale: false });
        setWatchGeneration((generation) => generation + 1);
      } else {
        setError(outcome.message);
      }
    } finally {
      setPending(false);
    }
  }, [selectedEpisodeIds, selectionKey, workspaceId]);

  const resultRunId = result?.analysis?.analysisId;
  const focusedRun =
    (resultRunId ? runs.find((run) => run.analysisId === resultRunId) : null) ??
    result?.analysis ??
    runs[0] ??
    null;
  const displayedRuns = focusedRun
    ? [
        focusedRun,
        ...runs.filter((run) => run.analysisId !== focusedRun.analysisId)
      ]
    : runs;

  return React.createElement(
    "section",
    {
      "aria-label": "Multi-session analyst review",
      className: LIST_PANEL_CLASS,
      "data-testid": "playtesting-selection",
      "data-selected": String(selectedEpisodeIds.length)
    },
    React.createElement(
      "h2",
      { className: SECTION_HEADING_CLASS },
      "Analyze selected sessions"
    ),
    React.createElement(
      "p",
      { className: MUTED_BODY_CLASS },
      `Optional read-only review of up to ${String(PLAYTESTS_MAX_ANALYSIS_SESSIONS)} selected sessions. Runtime checks eligibility, uses frozen evidence packets, enforces the approved critique budget, and reports excluded sessions. This does not run gameplay or turn hypotheses into verified findings.`
    ),
    rejectedSelection
      ? React.createElement(
          "p",
          {
            className: `${MUTED_BODY_CLASS} border-l-2 border-l-amber-500 pl-3`,
            role: "alert",
            "data-testid": "playtesting-selection-invalid-query"
          },
          `The shared session selection was rejected. Choose between 1 and ${String(PLAYTESTS_MAX_ANALYSIS_SESSIONS)} distinct sessions; nothing was truncated or started.`
        )
      : null,
    selectedEpisodeIds.length > 0
      ? React.createElement(
          "div",
          { className: "flex flex-wrap items-center gap-2" },
          React.createElement(
            "ul",
            {
              className: "flex min-w-0 flex-1 flex-wrap gap-2",
              "aria-label": "Sessions selected for analyst review"
            },
            ...selectedEpisodeIds.map((episodeId) =>
              React.createElement(
                "li",
                {
                  key: episodeId,
                  className: "max-w-full truncate rounded border border-border px-2 py-1 font-mono text-xs",
                  title: episodeId
                },
                episodeId
              )
            )
          ),
          React.createElement(
            "button",
            {
              type: "button",
              className: FIELD_CONTROL_CLASS,
              disabled: pending,
              onClick: () => onSelectionChange([])
            },
            "Clear selection"
          )
        )
      : React.createElement(
          "p",
          { className: MUTED_BODY_CLASS },
          "Choose sessions above to prepare a review."
        ),
    React.createElement(
      "button",
      {
        type: "button",
        className: FIELD_CONTROL_CLASS,
        disabled: pending || !workspaceId || selectedEpisodeIds.length === 0,
        onClick: () => void start()
      },
      pending ? "Starting analyst review" : "Start analyst review"
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
    React.createElement(PlaytestingAnalysisResults, {
      result,
      runs: displayedRuns,
      syntheses,
      stale,
      scope
    })
  );
}
