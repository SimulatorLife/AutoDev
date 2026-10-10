import type { ControlApiLiveAgentCounts } from "@simulatorlife/autodev-core";

import { NOT_OBSERVED_LABEL } from "../components/status/StatusBadge.ts";

export type LiveAgentCountDimension = "byRole" | "byProvider" | "byModel";

/** An absent live source is unknown; a missing key in an observed map is zero. */
export function liveAgentCount(
  liveAgents: ControlApiLiveAgentCounts | null | undefined,
  dimension: LiveAgentCountDimension,
  key: string
): string {
  if (liveAgents === undefined || liveAgents === null)
    return NOT_OBSERVED_LABEL;
  return String(liveAgents[dimension][key] ?? 0);
}
