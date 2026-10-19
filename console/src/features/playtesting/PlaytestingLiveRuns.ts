"use client";

/**
 * Client host for live batch monitoring.
 *
 * Mounted next to the run controls so starting a batch and watching it are one
 * surface. The focused batch lives in the URL, so a refresh or Back keeps the
 * operator on the same batch rather than resetting them to a list.
 */
import type { ControlApiPlaytestingRunRecord } from "@simulatorlife/autodev-core";
import React, { useCallback, useEffect, useRef, useState } from "react";

import { isTerminal } from "./playtesting-active-runs.ts";
import { responseMessage } from "./playtesting-run-messages.ts";
import type { PlaytestingScope } from "./playtesting-url.ts";
import { PlaytestingActiveRunsPanel } from "./PlaytestingActiveRunsPanel.ts";
import type { usePlaytestingActiveRuns } from "./use-playtesting-active-runs.ts";

async function postCancel(
  workspaceId: string,
  batchId: string
): Promise<{ ok: true } | { ok: false; message: string }> {
  // The route ID already identifies the batch; its form contract accepts only
  // workspaceId, so do not send a redundant, rejected body field.
  const body = new URLSearchParams({ workspaceId });
  const response = await fetch(
    `/api/playtesting/runs/${encodeURIComponent(batchId)}/cancel`,
    {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/x-www-form-urlencoded"
      },
      body
    }
  );
  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) return { ok: false, message: responseMessage(payload) };
  return { ok: true };
}

/**
 * Cancellation is confirmed against a server-read status, never against the
 * browser's own idea of what the batch was doing a moment ago.
 */
async function confirmBatchStillRunning(
  workspaceId: string,
  batchId: string,
  expected: ControlApiPlaytestingRunRecord
): Promise<boolean> {
  if (isTerminal(expected)) {
    return false;
  }
  // The browser endpoint accepts workspaceId only; the server-side proxy
  // supplies Runtime's waitMs=0 parameter itself.
  const query = new URLSearchParams({ workspaceId });
  const response = await fetch(
    `/api/playtesting/runs/${encodeURIComponent(batchId)}?${query}`,
    { headers: { accept: "application/json" } }
  );
  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) return false;
  const envelope = payload as {
    kind?: unknown;
    data?: { run?: { status?: unknown } };
  };
  const status =
    envelope.kind === "ok" ? envelope.data?.run?.status : undefined;
  return status === "running" || status === "persisting";
}

export interface PlaytestingLiveRunsProps {
  readonly workspaceId: string;
  readonly scope: PlaytestingScope;
  /** Focused batch, read from the URL so refresh and Back restore it. */
  readonly initialFocusedBatchId: string | null;
  readonly wallTimeMs: number | null;
  readonly showEmptyState: boolean;
  readonly allowCancel: boolean;
  readonly cancelUnavailableReason: string | null;
  /** The dashboard's single status owner, shared with the run start card. */
  readonly live: ReturnType<typeof usePlaytestingActiveRuns>;
}

export function PlaytestingLiveRuns({
  workspaceId,
  scope,
  initialFocusedBatchId,
  wallTimeMs,
  showEmptyState,
  allowCancel,
  cancelUnavailableReason,
  live
}: PlaytestingLiveRunsProps): React.JSX.Element {
  const { state, refresh, watching } = live;
  const [busyBatchId, setBusyBatchId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [focusedBatchId, setFocusedBatchId] = useState<string | null>(
    initialFocusedBatchId
  );
  const [autoFocusApplied, setAutoFocusApplied] = useState(
    initialFocusedBatchId !== null
  );
  const previousInitialFocus = useRef(initialFocusedBatchId);

  useEffect(() => {
    if (
      initialFocusedBatchId !== null &&
      initialFocusedBatchId !== previousInitialFocus.current
    ) {
      setFocusedBatchId(initialFocusedBatchId);
      setAutoFocusApplied(true);
    }
    previousInitialFocus.current = initialFocusedBatchId;
  }, [initialFocusedBatchId]);

  useEffect(() => {
    if (focusedBatchId !== null || autoFocusApplied) return;
    const active = state.runs.find((run) => !isTerminal(run.record));
    if (active) {
      setFocusedBatchId(active.batchId);
      setAutoFocusApplied(true);
    }
  }, [autoFocusApplied, focusedBatchId, state.runs]);

  // The focused batch is address state. Writing it through the History API
  // (and reading it back on popstate) is what makes a refresh or Back return
  // the operator to the batch they were watching instead of a bare list.
  const focusBatch = useCallback((batchId: string | null) => {
    setFocusedBatchId(batchId);
    setAutoFocusApplied(true);
    const url = new URL(globalThis.location.href);
    if (batchId === null) url.searchParams.delete("liveBatch");
    else url.searchParams.set("liveBatch", batchId);
    globalThis.history.pushState(null, "", url);
  }, []);

  useEffect(() => {
    const onPopState = (): void => {
      setFocusedBatchId(
        new URLSearchParams(globalThis.location.search).get("liveBatch")
      );
      setAutoFocusApplied(true);
    };
    globalThis.addEventListener("popstate", onPopState);
    return () => globalThis.removeEventListener("popstate", onPopState);
  }, []);

  const cancel = useCallback(
    async (batchId: string) => {
      const known = state.runs.find((run) => run.batchId === batchId);
      if (!known) return;
      setBusyBatchId(batchId);
      setActionError(null);
      if (
        !globalThis.confirm(
          `Cancel playtest batch ${batchId}? The run cannot be resumed.`
        )
      ) {
        setBusyBatchId(null);
        return;
      }
      try {
        // Confirm against a fresh server read before mutating, so a batch that
        // finished between polls is not cancelled as if it were live.
        const stillRunning = await confirmBatchStillRunning(
          workspaceId,
          batchId,
          known.record
        );
        if (!stillRunning) {
          setActionError(
            "The batch is no longer running, so it was not cancelled. Refresh to see its final status."
          );
          refresh();
          return;
        }
        const result = await postCancel(workspaceId, batchId);
        if (!result.ok) {
          setActionError(result.message);
          return;
        }
        refresh();
      } finally {
        setBusyBatchId(null);
      }
    },
    [refresh, state.runs, workspaceId]
  );

  return React.createElement(
    "div",
    { className: "flex flex-col gap-4" },
    React.createElement(PlaytestingActiveRunsPanel, {
      scope,
      runs: state.runs,
      freshness: state.freshness,
      lastFailure: state.lastFailure,
      watching,
      onRefresh: refresh,
      focusedBatchId,
      wallTimeMs,
      showEmptyState,
      onFocusBatch: focusBatch,
      onCancel: allowCancel ? cancel : null,
      cancelUnavailableReason,
      busyBatchId
    }),
    actionError
      ? React.createElement(
          "p",
          {
            className:
              "text-sm text-fg-muted border-l-2 border-l-amber-500 pl-3",
            "data-testid": "playtesting-live-runs-action-error"
          },
          actionError
        )
      : null
  );
}
