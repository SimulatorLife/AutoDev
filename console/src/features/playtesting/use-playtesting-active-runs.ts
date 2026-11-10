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

import {
  createPollLoop,
  departedRuns,
  freshnessForFailure,
  freshnessForSuccess,
  isWatching,
  mergeRunsRead,
  nextPollDelayMs,
  readActiveRuns,
  readRunStatus,
  trackStartedRun
} from "./playtesting-active-runs.ts";
import { responseMessage } from "./playtesting-run-messages.ts";

export type {
  PlaytestingActiveRun,
  PlaytestingActiveRunsFreshness
} from "./playtesting-active-runs.ts";

type ActiveRuns = NonNullable<ReturnType<typeof readActiveRuns>>;
type ActiveRunsFreshness = ReturnType<typeof freshnessForSuccess>;

export interface PlaytestingActiveRunsState {
  readonly runs: ActiveRuns;
  readonly freshness: ActiveRunsFreshness;
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
  /** Tracks the exact start acknowledgement before the first active-list read. */
  readonly trackRun: (run: ActiveRuns[number]) => void;
  readonly watching: boolean;
} {
  const [runs, setRuns] = useState<ActiveRuns>([]);
  const [freshness, setFreshness] = useState<ActiveRunsFreshness>("idle");
  const [lastFailure, setLastFailure] = useState<string | null>(null);
  const [lastUpdatedAt, setLastUpdatedAt] = useState<number | null>(null);
  const [nonce, setNonce] = useState(0);
  const failures = useRef(0);
  const runsRef = useRef<ActiveRuns>(runs);
  runsRef.current = runs;

  const watching = isWatching(runs);
  // The poll loop outlives any single render, so it asks this through a ref
  // rather than closing over one render's value.
  const pausedRef = useRef(paused);
  pausedRef.current = paused;
  const refresh = useCallback(() => {
    setNonce((value) => value + 1);
  }, []);

  const trackRun = useCallback((run: ActiveRuns[number]) => {
    const next = trackStartedRun(runsRef.current, run);
    runsRef.current = next;
    setRuns(next);
    setLastUpdatedAt(Date.now());
    setLastFailure(null);
    setFreshness(freshnessForSuccess(next));
    // Re-arm the self-scheduling loop immediately, even if it was already
    // watching another batch and a render alone would not restart the effect.
    setNonce((value) => value + 1);
  }, []);

  useEffect(() => {
    failures.current = 0;
    runsRef.current = [];
    setRuns([]);
    setLastFailure(null);
    setLastUpdatedAt(null);
    setFreshness("idle");
  }, [workspaceId]);

  useEffect(() => {
    if (!workspaceId) return () => undefined;
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
          throw new Error(
            "The Runtime returned an incompatible runs response."
          );
        }
        // A watched batch absent from the active list has finished; read its
        // terminal status so the view shows how it ended.
        const resolved = await Promise.all(
          departedRuns(runsRef.current, next).map(async (run) => {
            const statusResponse = await fetch(
              `/api/playtesting/runs/${encodeURIComponent(run.batchId)}?${query}`,
              {
                headers: { accept: "application/json" },
                signal: controller.signal
              }
            );
            const statusPayload: unknown = await statusResponse.json();
            if (!statusResponse.ok) {
              throw new Error(responseMessage(statusPayload));
            }
            const record = readRunStatus(
              statusPayload,
              targetWorkspaceId,
              run.batchId
            );
            if (!record) {
              throw new Error(
                "The Runtime returned an incompatible run-status response."
              );
            }
            return { ...run, record };
          })
        );
        if (cancelled) return;
        const merged = mergeRunsRead(runsRef.current, next, resolved);
        failures.current = 0;
        runsRef.current = merged;
        setRuns(merged);
        setLastUpdatedAt(Date.now());
        setLastFailure(null);
        setFreshness(freshnessForSuccess(merged));
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
      //
      // The answer is read from the runs the poll just merged rather than
      // from the rendered watch state. The rendered state only changes when
      // React renders, and the loop asks the question in the same turn as
      // the poll that changed it, so the rendered state is still the
      // previous one at that moment. The merged runs are the answer the
      // poll itself produced, and they are current the moment they exist.
      shouldContinue: () =>
        !pausedRef.current && isWatching(runsRef.current),
      delayFor: () => nextPollDelayMs(failures.current)
    });
    loop.start();
    return () => {
      cancelled = true;
      loop.stop();
      controller.abort();
    };
    // `paused` and `nonce` drive the cadence; nonce forces an immediate
    // re-read after a manual refresh. `paused` stays a dependency because
    // resuming has to restart a loop that stopped while it was paused.
    //
    // `watching` is not one. The watch state flips whenever a poll changes
    // it, and re-running the effect on that flip tore the loop down and
    // built a new one -- aborting the request in flight and starting the
    // whole cadence over, on every poll that changed what was being
    // watched. The loop reads the watch state through the runs it merged
    // instead, so it continues on its own.
  }, [nonce, paused, workspaceId]);

  return {
    state: { runs, freshness, lastFailure, lastUpdatedAt },
    refresh,
    trackRun,
    watching
  };
}
