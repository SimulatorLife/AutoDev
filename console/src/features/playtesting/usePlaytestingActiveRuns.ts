"use client";

/**
 * Workspace-scoped live batch monitoring over the single typed run owner.
 *
 * The read is authoritative. A failed or unreachable read is reported as
 * `unavailable` and never as the last successful frame; polling backs off,
 * stops once every batch is terminal, and never advances batch state itself —
 * every rendered status came from a server response.
 */
import { useCallback, useEffect, useRef, useState } from "react";

import { responseMessage } from "./playtesting-run-messages.ts";
import {
  createPollLoop,
  freshnessForFailure,
  freshnessForSuccess,
  isWatching,
  nextPollDelayMs,
  type PlaytestingActiveRun,
  type PlaytestingActiveRunsFreshness,
  readActiveRuns
} from "./playtesting-active-runs.ts";

export type { PlaytestingActiveRun, PlaytestingActiveRunsFreshness };

export interface PlaytestingActiveRunsState {
  readonly runs: readonly PlaytestingActiveRun[];
  readonly freshness: PlaytestingActiveRunsFreshness;
  readonly lastFailure: string | null;
  readonly lastUpdatedAt: number | null;
}

export interface UsePlaytestingActiveRunsOptions {
  readonly workspaceId: string | null;
  /** Pause polling while the operator is elsewhere; resume on return. */
  readonly paused?: boolean;
}

export function usePlaytestingActiveRuns({
  workspaceId,
  paused = false
}: UsePlaytestingActiveRunsOptions): {
  readonly state: PlaytestingActiveRunsState;
  readonly refresh: () => void;
  readonly watching: boolean;
} {
  const [runs, setRuns] = useState<readonly PlaytestingActiveRun[]>([]);
  const [freshness, setFreshness] =
    useState<PlaytestingActiveRunsFreshness>("idle");
  const [lastFailure, setLastFailure] = useState<string | null>(null);
  const [lastUpdatedAt, setLastUpdatedAt] = useState<number | null>(null);
  const [nonce, setNonce] = useState(0);
  const failures = useRef(0);

  const watching = isWatching(runs);
  // The poll loop outlives any single render, so it asks these through refs
  // rather than closing over one render's values.
  const watchingRef = useRef(watching);
  watchingRef.current = watching;
  const pausedRef = useRef(paused);
  pausedRef.current = paused;
  const refresh = useCallback(() => {
    setNonce((value) => value + 1);
  }, []);

  useEffect(() => {
    failures.current = 0;
    setRuns([]);
    setLastFailure(null);
    setLastUpdatedAt(null);
    setFreshness("idle");
  }, [workspaceId]);

  useEffect(() => {
    if (!workspaceId) return;
    const targetWorkspaceId = workspaceId;
    let cancelled = false;
    const controller = new AbortController();

    async function poll(): Promise<void> {
      if (cancelled) return;
      try {
        const query = new URLSearchParams({ workspaceId: targetWorkspaceId });
        const response = await fetch(`/api/playtesting/runs?${query}`, {
          headers: { accept: "application/json" },
          signal: controller.signal
        });
        const payload: unknown = await response.json();
        if (cancelled) return;
        if (!response.ok) throw new Error(responseMessage(payload));
        const next = readActiveRuns(payload, targetWorkspaceId);
        if (!next) {
          throw new Error("The Runtime returned an incompatible runs response.");
        }
        failures.current = 0;
        setRuns(next);
        setLastUpdatedAt(Date.now());
        setLastFailure(null);
        setFreshness(freshnessForSuccess(next));
      } catch (error) {
        if (cancelled || controller.signal.aborted) return;
        failures.current += 1;
        // Previously read frames stay on screen but are never claimed current.
        setLastFailure(
          error instanceof Error
            ? error.message
            : "The active runs could not be read."
        );
        setFreshness(freshnessForFailure());
      }
    }

    const loop = createPollLoop({
      poll,
      // Read live rather than captured: the loop asks after each poll, so a
      // terminal batch or a paused view ends the chain on the next turn.
      shouldContinue: () => !pausedRef.current && watchingRef.current,
      delayFor: () => nextPollDelayMs(failures.current)
    });
    loop.start();
    return () => {
      cancelled = true;
      loop.stop();
      controller.abort();
    };
    // `watching` and `paused` drive the cadence; nonce forces an immediate
    // re-read after a manual refresh. Re-running the effect on a `watching`
    // change is what stops the loop, so the loop reads those two through refs
    // instead of capturing this render's values.
  }, [nonce, paused, watching, workspaceId]);

  return {
    state: { runs, freshness, lastFailure, lastUpdatedAt },
    refresh,
    watching
  };
}