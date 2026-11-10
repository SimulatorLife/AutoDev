"use client";

import { useEffect, useState } from "react";

import {
  parseUsageApiPayload,
  type UsageApiPayload,
  type UsageApiScope,
  usageApiUrl
} from "./usage-api.ts";

/**
 * What the browser knows about a scoped telemetry read.
 *
 * The three states are the three the read can be in, and they are the same
 * three the surfaces have always rendered: the read has not answered yet, it
 * answered with something the Console can read, or it could not be read at
 * all. The pending state is its own state rather than an empty answer,
 * because a telemetry panel that has not been told anything yet is not a
 * panel that has been told there was nothing.
 */
export type UsageTelemetryState =
  | { readonly status: "pending" }
  | { readonly status: "ready"; readonly payload: UsageApiPayload }
  | { readonly status: "unavailable" };

/**
 * Read one scoped Usage telemetry answer.
 *
 * The read happens in the browser, after the page's own content is on the
 * screen, because the telemetry read is expensive and the page is not about
 * the telemetry. The page answers in one piece and the panel fills in when
 * the answer arrives, so a slow telemetry store costs the panel its number
 * and nothing else.
 *
 * A read that fails -- a refused request, a body the Console cannot read, a
 * connection that died -- is reported as unavailable. It is never reported
 * as an empty answer, because an empty answer is a measurement.
 */
export function useUsageTelemetry(
  scope: UsageApiScope,
  params: Readonly<Record<string, string>> = {}
): UsageTelemetryState {
  const url = usageApiUrl(scope, params);
  const [state, setState] = useState<UsageTelemetryState>({ status: "pending" });
  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();
    const read = async (): Promise<void> => {
      try {
        const response = await fetch(url, {
          signal: controller.signal,
          headers: { accept: "application/json" }
        });
        if (!response.ok) {
          if (!cancelled) setState({ status: "unavailable" });
          return;
        }
        const payload = parseUsageApiPayload(await response.json());
        if (cancelled) return;
        setState(
          payload === null ? { status: "unavailable" } : { status: "ready", payload }
        );
      } catch {
        // The read failed in transport, or the panel was unmounted before it
        // answered. Either way there is no answer to render, and an answer
        // that does not exist is not a zero.
        if (!cancelled) setState({ status: "unavailable" });
      }
    };
    void read();
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [url]);
  return state;
}
