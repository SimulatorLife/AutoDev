"use client";

import type { ControlApiProviderRecord } from "@simulatorlife/autodev-core";
import React from "react";

import { useUsageTelemetry } from "../usage/use-usage-telemetry.ts";
import { type ProviderUsageReading, summarizeProviderUsage } from "./provider-usage.ts";
import { providerUsageView } from "./provider-usage-view.ts";

/**
 * The provider's own attempt evidence, as the panel reads it.
 *
 * The read is the browser's rather than the page's. The page's own subject
 * is the provider, and the Control API answers that in milliseconds; the
 * seven-day attempt aggregation is the most expensive read the Console
 * makes, and it answers a question about one panel rather than about the
 * page. The panel therefore renders while its answer is on its way, and says
 * so, rather than the page waiting for a number nobody is waiting for.
 */
function readingFor(
  state: ReturnType<typeof useUsageTelemetry>,
  providerId: string
): ProviderUsageReading {
  if (state.status === "pending") return { status: "pending" };
  if (state.status === "unavailable") return { status: "unavailable" };
  if (state.payload.scope !== "provider-usage") {
    return { status: "unavailable" };
  }
  return summarizeProviderUsage(state.payload.source, providerId);
}

/**
 * The provider's usage panel.
 *
 * It renders the same summary the provider's own vocabulary produces, and
 * one state the summary does not have: the pending state, which says the
 * evidence is on its way. A pending panel is not a panel that measured
 * nothing, and it never renders a zero.
 */
export function ProviderUsagePanel({
  provider
}: {
  readonly provider: ControlApiProviderRecord;
}): React.JSX.Element {
  const state = useUsageTelemetry("provider-usage", {
    provider: provider.id
  });
  return providerUsageView({
    provider,
    reading: readingFor(state, provider.id)
  });
}
