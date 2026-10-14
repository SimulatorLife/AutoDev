/**
 * Run-owner wording shared by every Playtesting surface. Plain data only, so
 * both the JSX badges and the Node tests can import one owner.
 */
import type {
  ControlApiPlaytestingCancellationReason,
  ControlApiPlaytestingRunState
} from "@simulatorlife/autodev-core";

import { NOT_OBSERVED_LABEL } from "../../components/status/StatusBadge.ts";

const UNREADABLE_RESPONSE_MESSAGE =
  "The Console could not validate the server response.";

/**
 * A state the Console cannot interpret is absent evidence, not a value the
 * product invented. It uses the one spelling for that.
 */
const NOT_A_RUN_STATE_LABEL = NOT_OBSERVED_LABEL;

/**
 * Prefer the server's own message; never invent one for a body the Console
 * could not read.
 */
export function responseMessage(value: unknown): string {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return UNREADABLE_RESPONSE_MESSAGE;
  }
  const record = value as { message?: unknown; error?: unknown };
  if (typeof record.message === "string") return record.message;
  const { error } = record;
  if (typeof error === "object" && error !== null && !Array.isArray(error)) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string") return message;
  }
  return UNREADABLE_RESPONSE_MESSAGE;
}

export const CANCELLATION_REASON_LABELS: Readonly<
  Record<ControlApiPlaytestingCancellationReason, string>
> = {
  cancelled: "Operator requested cancellation",
  "approval-revoked": "Playtesting approval was revoked",
  "workspace-disabled": "Workspace was disabled"
};

/**
 * Each run state keeps its own label. A truncated batch is not a failed one,
 * and a recovered nonterminal closure is not a result.
 */
const RUN_STATE_LABELS: Readonly<
  Record<ControlApiPlaytestingRunState, string>
> = {
  running: "Running",
  persisting: "Saving evidence",
  completed: "Completed",
  failed: "Failed",
  cancelled: "Cancelled",
  truncated: "Truncated"
};

export function runStateLabel(status: string): string {
  return (
    RUN_STATE_LABELS[status as ControlApiPlaytestingRunState] ??
    NOT_A_RUN_STATE_LABEL
  );
}

/** Badge tone per run state; only a completed batch is a clean result. */
export function runStateBadgeTone(
  status: string
): "valid" | "pending" | "unavailable" {
  switch (status) {
    case "completed": {
      return "valid";
    }
    case "running":
    case "persisting": {
      return "pending";
    }
    default: {
      return "unavailable";
    }
  }
}
