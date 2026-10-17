import type {
  PlaytestEpisode,
  PlaytestExecutionProvenance,
  PlaytestGameOutcomeKind
} from "@simulatorlife/autodev-core";
import React from "react";

import {
  NOT_OBSERVED_STATUS,
  StatusBadge
} from "../../components/status/StatusBadge.ts";

const LOOP_GUARD_STOP_REASON = "loop-guard" as const;

export function executionModeLabel(
  mode: PlaytestExecutionProvenance["mode"]
): string {
  switch (mode) {
    case "autonomous-visual":
      return "Autonomous visual";
    case "adapter-accelerated":
      return "Adapter-accelerated";
    case "scripted-regression":
      return "Scripted regression";
    case "legacy-unknown":
      return "Legacy mode unknown";
  }
}

export function executionSourceSummary(
  provenance: PlaytestExecutionProvenance
): string {
  const { source } = provenance;
  const revision =
    source.revisionConfidence === "verified" && source.revision !== null
      ? `Verified ${source.revision.slice(0, 12)}`
      : source.kind === "URL-only"
        ? "Commit not applicable"
        : "Build unknown";
  const repository = source.repository ? ` · ${source.repository}` : "";
  const target = source.targetOrigin ? ` · ${source.targetOrigin}` : "";
  return `${source.kind}${repository}${target} · ${revision}`;
}

/** Render an absent engine scenario honestly for URL-driven visual episodes. */
export function episodeScenarioLabel(
  episode: Pick<PlaytestEpisode, "identity" | "executionProvenance">
): string {
  if (episode.identity.scenarioId) return episode.identity.scenarioId;
  return episode.executionProvenance.mode === "autonomous-visual"
    ? "Visual exploration"
    : "Scenario not recorded";
}

/** A URL's source checkout is not a build attestation for its rendered bytes. */
export function episodeBuildLabel(
  episode: Pick<PlaytestEpisode, "identity" | "executionProvenance">
): string {
  const { source } = episode.executionProvenance;
  if (source.revisionConfidence === "verified" && source.revision !== null) {
    return `Verified ${source.revision.slice(0, 12)}`;
  }
  return source.kind === "URL-only" ? "Commit not applicable" : "Build unknown";
}

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

/** Prefer the decision that stopped an incomplete episode over its first step. */
export function defaultEpisodeInspectionStep(
  episode: Pick<PlaytestEpisode, "status" | "stepCount" | "termination">
): number | null {
  if (
    episode.termination.reason === LOOP_GUARD_STOP_REASON &&
    episode.termination.step !== null
  ) {
    return episode.termination.step;
  }
  return episode.status !== "completed" && episode.stepCount > 0
    ? episode.stepCount - 1
    : null;
}

/** The loop guard's unexecuted decision is recorded just beyond stepCount. */
export function episodeTraceContainsStep(
  episode: Pick<PlaytestEpisode, "stepCount" | "termination">,
  step: number
): boolean {
  return (
    Number.isSafeInteger(step) &&
    step >= 0 &&
    (step < episode.stepCount ||
      (episode.termination.reason === LOOP_GUARD_STOP_REASON &&
        episode.termination.step === step))
  );
}

export type PlaytestingEpisodeTraceWindowPlan =
  | { readonly kind: "none" }
  | { readonly kind: "outside-range" }
  | {
      readonly kind: "window";
      readonly artifactId: string;
      readonly startStep: number;
      readonly endStep: number;
    };

/** Include the loop-guard's unexecuted decision just beyond executed stepCount. */
export function planEpisodeTraceWindow(
  episode: Pick<PlaytestEpisode, "trace" | "stepCount" | "termination">,
  requestedStep: number
): PlaytestingEpisodeTraceWindowPlan {
  if (episode.trace === null) return { kind: "none" };
  if (
    episode.stepCount === 0 &&
    episode.termination.reason !== LOOP_GUARD_STOP_REASON
  ) {
    return { kind: "none" };
  }
  if (!episodeTraceContainsStep(episode, requestedStep)) {
    return { kind: "outside-range" };
  }
  const startStep = Math.max(0, requestedStep - 5);
  const lastStep =
    episode.termination.reason === LOOP_GUARD_STOP_REASON &&
    episode.termination.step !== null
      ? episode.termination.step
      : episode.stepCount - 1;
  return {
    kind: "window",
    artifactId: episode.trace.id,
    startStep,
    endStep: Math.max(startStep, Math.min(lastStep, requestedStep + 5))
  };
}
