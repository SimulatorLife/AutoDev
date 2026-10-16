"use client";

import { CONTROL_API_PLAYTESTING_READINESS_SCHEMA } from "@simulatorlife/autodev-core";
import React, { useEffect, useState } from "react";

const READINESS_POLL_DELAYS_MS = [
  1000, 2000, 4000, 5000, 5000, 5000, 5000, 5000, 5000, 5000, 5000, 5000
] as const;

type ReadinessStatus = "initializing" | "unavailable";

interface PlaytestingReadinessProps {
  readonly workspaceId: string;
  readonly initialStatus: ReadinessStatus;
  readonly initialCode?: string;
  readonly initialMessage?: string;
}

interface ReadinessEnvelope {
  readonly kind?: unknown;
  readonly data?: {
    readonly schema?: unknown;
    readonly workspaceId?: unknown;
    readonly status?: unknown;
  };
  readonly code?: unknown;
  readonly message?: unknown;
}

function endpoint(workspaceId: string): string {
  const params = new URLSearchParams({ workspaceId });
  return `/api/playtesting/readiness?${params.toString()}`;
}

function failureDetails(
  response: Response,
  payload: ReadinessEnvelope
): { readonly code: string; readonly message: string } {
  return {
    code:
      typeof payload.code === "string"
        ? payload.code
        : `autodev_console_playtesting_readiness_${response.status}`,
    message:
      typeof payload.message === "string"
        ? payload.message
        : "Playtesting Data readiness could not be checked."
  };
}

function pollReadiness(
  workspaceId: string,
  setUnavailable: (code: string, message: string) => void
): () => void {
  let cancelled = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let attempt = 0;

  const poll = async () => {
    try {
      const response = await fetch(endpoint(workspaceId), {
        cache: "no-store",
        headers: { accept: "application/json" }
      });
      const payload = (await response.json()) as ReadinessEnvelope;
      if (!response.ok || payload.kind !== "ok" || !payload.data) {
        if (!cancelled) {
          const failure = failureDetails(response, payload);
          setUnavailable(failure.code, failure.message);
        }
        return;
      }
      if (
        payload.data.schema !== CONTROL_API_PLAYTESTING_READINESS_SCHEMA ||
        payload.data.workspaceId !== workspaceId ||
        (payload.data.status !== "initializing" &&
          payload.data.status !== "ready")
      ) {
        if (!cancelled) {
          setUnavailable(
            "autodev_console_playtesting_readiness_invalid_response",
            "The Playtesting readiness response was invalid."
          );
        }
        return;
      }
      if (payload.data.status === "ready") {
        // The current tree is the server-rendered initialization fallback.
        // Replace it with a fresh server read once Data confirms readiness.
        if (!cancelled) globalThis.location.reload();
        return;
      }
    } catch {
      if (!cancelled) {
        setUnavailable(
          "autodev_console_playtesting_readiness_unreachable",
          "The Playtesting readiness endpoint could not be reached."
        );
      }
      return;
    }

    if (cancelled) return;
    const delay = READINESS_POLL_DELAYS_MS[attempt];
    if (delay === undefined) {
      setUnavailable(
        "autodev_console_playtesting_readiness_pending",
        "Playtesting Data is still initializing. Check again when Runtime startup has completed."
      );
      return;
    }
    attempt += 1;
    timer = setTimeout(() => void poll(), delay);
  };

  timer = setTimeout(() => void poll(), READINESS_POLL_DELAYS_MS[0]);
  return () => {
    cancelled = true;
    if (timer !== undefined) clearTimeout(timer);
  };
}

export function PlaytestingReadiness({
  workspaceId,
  initialStatus,
  initialCode = "autodev_control_playtesting_source_initializing",
  initialMessage = "Playtesting Data is initializing. This page will load automatically when the Data schema is ready."
}: PlaytestingReadinessProps): React.JSX.Element {
  const [status, setStatus] = useState<ReadinessStatus>(initialStatus);
  const [code, setCode] = useState(initialCode);
  const [message, setMessage] = useState(initialMessage);
  const [retrying, setRetrying] = useState(false);

  useEffect(
    () =>
      status === "initializing"
        ? pollReadiness(workspaceId, (nextCode, nextMessage) => {
            setCode(nextCode);
            setMessage(nextMessage);
            setStatus("unavailable");
          })
        : undefined,
    [status, workspaceId]
  );

  const retry = async () => {
    if (retrying) return;
    setRetrying(true);
    try {
      const response = await fetch(endpoint(workspaceId), {
        method: "POST",
        cache: "no-store",
        headers: { accept: "application/json" }
      });
      const payload = (await response.json()) as ReadinessEnvelope;
      if (!response.ok || payload.kind !== "ok" || !payload.data) {
        const failure = failureDetails(response, payload);
        setCode(failure.code);
        setMessage(failure.message);
        setStatus("unavailable");
        return;
      }
      if (
        payload.data.schema !== CONTROL_API_PLAYTESTING_READINESS_SCHEMA ||
        payload.data.workspaceId !== workspaceId ||
        (payload.data.status !== "initializing" &&
          payload.data.status !== "ready")
      ) {
        setCode("autodev_console_playtesting_readiness_invalid_response");
        setMessage("The Playtesting readiness response was invalid.");
        setStatus("unavailable");
        return;
      }
      if (payload.data.status === "ready") {
        setMessage("Playtesting Data is ready. Loading the workspace view.");
        // A full same-URL reload replaces the initialization fallback with a
        // new server-rendered read; router.refresh can retain that stale tree.
        globalThis.location.reload();
        return;
      }
      setMessage(
        "Playtesting Data initialization was retried. This page will load when the schema is ready."
      );
      setStatus("initializing");
    } catch {
      setCode("autodev_console_playtesting_readiness_unreachable");
      setMessage("The Playtesting readiness endpoint could not be reached.");
      setStatus("unavailable");
    } finally {
      setRetrying(false);
    }
  };

  return (
    <section
      className="rounded-xl border border-border bg-surface p-5"
      role={status === "initializing" ? "status" : "alert"}
      aria-live={status === "initializing" ? "polite" : "assertive"}
      data-status={status}
      data-error-code={status === "unavailable" ? code : undefined}
    >
      <h2 className="text-base font-semibold tracking-tight">
        {status === "initializing"
          ? "Playtesting data is starting up"
          : "Playtesting data is unavailable"}
      </h2>
      <p className="mt-2 text-sm text-fg-muted">{message}</p>
      {status === "unavailable" ? (
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <code className="break-all text-xs text-fg-muted">{code}</code>
          <button
            className="rounded-md border border-border px-3 py-2 text-sm font-medium hover:bg-surface-muted focus-visible:outline-2 focus-visible:outline-offset-2"
            type="button"
            disabled={retrying}
            onClick={() => void retry()}
          >
            {retrying ? "Retrying…" : "Retry initialization"}
          </button>
        </div>
      ) : null}
    </section>
  );
}
