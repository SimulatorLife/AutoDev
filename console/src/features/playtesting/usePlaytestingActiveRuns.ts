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

/** Prefer the server's own message; never invent one for an unparsed body. */
export function responseMessage(value: unknown): string {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return "The Console could not validate the server response.";
  }
  const record = value as { message?: unknown; error?: unknown };
  if (typeof record.message === "string") return record.message;
  const { error } = record;
  if (typeof error === "object" && error !== null && !Array.isArray(error)) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string") return message;
  }
  return "The Console could not validate the server response.";
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
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const watching = isWatching(runs);
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

    void poll();
    if (paused || !watching) return;
    const delay = nextPollDelayMs(failures.current);
    timer.current = setTimeout(() => {
      void poll();
    }, delay);
    return () => {
      cancelled = true;
      if (timer.current) clearTimeout(timer.current);
    };
    // `watching` and `paused` drive the cadence; nonce forces an immediate
    // re-read after a manual refresh.
  }, [nonce, paused, watching, workspaceId]);

  return {
    state: { runs, freshness, lastFailure, lastUpdatedAt },
    refresh,
    watching
  };
}