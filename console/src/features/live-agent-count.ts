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

export type LiveAgentRoleDimension = "byProviderRole" | "byModelRole";

const ROLE_WORD_SEPARATOR = /[-_\s]+/u;
const ROLE_COLLATOR = new Intl.Collator("en");

function roleName(role: string): string {
  return role
    .split(ROLE_WORD_SEPARATOR)
    .filter((word) => word.length > 0)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

/**
 * What a live count is made of, one role per line ("1 Orchestrator",
 * "1 Worker"), largest first. `undefined` when there is nothing to break
 * down -- an unobserved source or no live agents -- so the count itself
 * stays the hover text.
 */
export function liveAgentRoleBreakdown(
  liveAgents: ControlApiLiveAgentCounts | null | undefined,
  dimension: LiveAgentRoleDimension,
  key: string
): string | undefined {
  const lines = Object.entries(liveAgents?.[dimension][key] ?? {})
    .filter(([, count]) => count > 0)
    .map(([role, count]) => ({ count, name: roleName(role) }))
    .sort((a, b) => b.count - a.count || ROLE_COLLATOR.compare(a.name, b.name))
    .map(({ count, name }) => `${count} ${name}`);
  return lines.length === 0 ? undefined : lines.join("\n");
}
