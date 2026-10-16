import type {
  PlaytestEpisode,
  PlaytestGameOutcomeKind
} from "@simulatorlife/autodev-core";
import React from "react";

import {
  NOT_OBSERVED_STATUS,
  StatusBadge
} from "../../components/status/StatusBadge.ts";

/** Execution disposition and the game's outcome remain separate dimensions. */
export function executionStatusBadge(
  status: PlaytestEpisode["status"]
): React.JSX.Element {
  const mapping = {
    assigned: ["pending", "Assigned"],
    started: ["pending", "Started"],
    completed: ["valid", "Completed"],
    crashed: ["invalid", "Crashed"],
    "infrastructure-failed": ["unavailable", "Infrastructure failed"],
    cancelled: ["unavailable", "Cancelled"],
    "budget-truncated": ["unavailable", "Budget truncated"]
  } as const;
  const [variant, label] = mapping[status];
  return React.createElement(StatusBadge, { status: variant, label });
}

export function gameOutcomeBadge(
  value: PlaytestGameOutcomeKind
): React.JSX.Element {
  const variant =
    value === "win"
      ? "valid"
      : value === "unknown"
        ? NOT_OBSERVED_STATUS
        : "unavailable";
  return React.createElement(StatusBadge, {
    status: variant,
    label: value === "unknown" ? "Not observed" : value.toUpperCase(),
    title: "Game outcome is separate from playtest execution status."
  });
}
