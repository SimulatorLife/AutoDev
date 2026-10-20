import type { UsageMetricsData } from "@simulatorlife/autodev-core";

import { NOT_OBSERVED_STATUS } from "../../components/status/StatusBadge.ts";

export type ProviderUsageSource =
  | { readonly kind: "not-configured" }
  | { readonly kind: "unavailable" }
  | {
      readonly kind: "available";
      readonly attemptsByProvider: UsageMetricsData["attemptsByProvider"];
      readonly attemptErrorsByProvider: UsageMetricsData["attemptErrorsByProvider"];
    };

export type ProviderUsageSummary =
  | { readonly status: "not-configured" }
  | { readonly status: "unavailable" }
  | { readonly status: typeof NOT_OBSERVED_STATUS }
  | {
      readonly status: "observed";
      readonly attempts: number;
      readonly failures: number | null;
    };

function countForProvider(
  rows: readonly { readonly provider: string; readonly count: number }[] | null,
  provider: string
): number | null {
  if (rows === null) return null;
  let count = 0;
  for (const row of rows) {
    if (!Number.isSafeInteger(row.count) || row.count < 0) return null;
    if (row.provider !== provider) continue;
    count += row.count;
    if (!Number.isSafeInteger(count)) return null;
  }
  return count;
}

/**
 * Provider detail may show only provider-attempt telemetry. Logical requests
 * can span multiple providers, so their totals must remain in the shared Usage
 * view instead of being attributed to this provider.
 */
export function summarizeProviderUsage(
  source: ProviderUsageSource,
  provider: string
): ProviderUsageSummary {
  if (source.kind === "not-configured") return { status: "not-configured" };
  if (source.kind === "unavailable") return { status: "unavailable" };
  const attempts = countForProvider(source.attemptsByProvider, provider);
  if (attempts === null) return { status: NOT_OBSERVED_STATUS };
  return {
    status: "observed",
    attempts,
    failures: countForProvider(source.attemptErrorsByProvider, provider)
  };
}

export function providerUsagePath(provider: string): string {
  const params = new URLSearchParams({ range: "7D", provider });
  return `/usage?${params.toString()}`;
}
