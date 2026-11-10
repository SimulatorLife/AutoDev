"use client";

import React from "react";

import { useUsageTelemetry } from "../usage/use-usage-telemetry.ts";
import { toolUsageEvidence, type ToolUsageState } from "./tool-usage.ts";
import { toolUsageView } from "./tool-usage-view.ts";

function stateFor(
  telemetry: ReturnType<typeof useUsageTelemetry>,
  identities: readonly string[]
): ToolUsageState {
  if (telemetry.status === "pending") return { kind: "pending" };
  if (telemetry.status === "unavailable") return { kind: "unavailable" };
  if (telemetry.payload.scope !== "tool-usage") return { kind: "unavailable" };
  const source = telemetry.payload.source;
  if (source.kind === "not-configured") return { kind: "not-configured" };
  if (source.kind === "unavailable") return { kind: "unavailable" };
  const evidence = toolUsageEvidence(source.callsByTool, identities);
  return evidence.observed
    ? { kind: "observed", calls: evidence.calls ?? 0 }
    : { kind: "not-observed" };
}

/**
 * The tool's historical use evidence.
 *
 * The read is the browser's rather than the page's: the page's own subject
 * is the catalogue entry, and the catalogue is answered in milliseconds while
 * the twenty-four hour telemetry aggregation is the most expensive read the
 * Console makes. The evidence arrives after the page does, and the panel says
 * that it is still waiting rather than showing a zero.
 */
export function ToolUsagePanel({
  identities,
  usageLink,
  startDate,
  endDate
}: {
  readonly identities: readonly string[];
  readonly usageLink: string;
  readonly startDate: string;
  readonly endDate: string;
}): React.JSX.Element {
  const telemetry = useUsageTelemetry("tool-usage", { startDate, endDate });
  return toolUsageView({
    state: stateFor(telemetry, identities),
    usageLink
  });
}
