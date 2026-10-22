"use client";

/**
 * Coordinates the run start acknowledgement with the one live status owner.
 *
 * The dashboard owns one workspace-scoped status reader. The start form only
 * submits a typed request; the run-status panel is the sole status surface.
 * A terminal transition refreshes the server-rendered evidence and recent result.
 */
import {
  type ControlApiPlaytestingPolicyReadiness,
  type ControlApiPlaytestingRunRecord,
  type ControlApiPlaytestingRunStartedResponse,
  PLAYTEST_LAUNCH_REQUEST_SCHEMA,
  type PlaytestVisualPolicyId,
  type WorkspaceVisualPlaytestTargetApproval
} from "@simulatorlife/autodev-core";
import { useRouter } from "next/navigation";
import React, { useCallback, useEffect, useRef, useState } from "react";

import { Button } from "../../components/forms/Button.ts";
import { NavigationLink } from "../../components/navigation/NavigationLink.ts";
import {
  MUTED_META_CLASS,
  MUTED_TEXT_CLASS
} from "../../components/ui/text-classes.ts";
import { workspacePath } from "../workspaces/paths.ts";
import {
  cancellationAvailability,
  isTerminal
} from "./playtesting-active-runs.ts";
import { policyLabel } from "./playtesting-labels.ts";
import type { PlaytestingScope } from "./playtesting-url.ts";
import { PlaytestingLiveRuns } from "./PlaytestingLiveRuns.ts";
import {
  PlaytestingRunControls,
  type PlaytestingRunSetup,
  playtestingRunSetupBlocker,
  type PlaytestLaunchRequestDraft,
  usePlaytestingLaunchRecovery
} from "./PlaytestingRunControls.tsx";
import { usePlaytestingActiveRuns } from "./use-playtesting-active-runs.ts";

function adapterReadinessStatus(
  setup: PlaytestingRunSetup
): "ready" | "check-required" | "unavailable" {
  return setup.kind === "available"
    ? setup.capabilities.modeReadiness[ADAPTER_ACCELERATED_MODE].status
    : "unavailable";
}

function visualModeReadinessCard(
  setup: PlaytestingRunSetup,
  workspaceId: string | null
): React.JSX.Element {
  const readiness =
    setup.kind === "available"
      ? setup.capabilities.modeReadiness[AUTONOMOUS_VISUAL_MODE]
      : null;
  return React.createElement(
    "section",
    {
      className:
        "rounded-lg border border-border bg-background/50 p-4" +
        (readiness?.status === "ready" ? "" : " opacity-75"),
      "aria-label": "Autonomous visual mode readiness",
      "data-playtesting-mode": AUTONOMOUS_VISUAL_MODE,
      "data-mode-status": readiness?.status ?? "unavailable"
    },
    React.createElement(
      "p",
      { className: "font-semibold" },
      "Autonomous visual"
    ),
    React.createElement(
      "p",
      { className: "mt-1 text-xs font-medium text-fg-muted" },
      readiness?.reasons[0]?.label ??
        (readiness?.status === "ready"
          ? "Ready to run"
          : "Visual readiness unavailable")
    ),
    React.createElement(
      "details",
      { className: "mt-2", "data-testid": "visual-readiness-details" },
      React.createElement(
        "summary",
        { className: `cursor-pointer ${MUTED_META_CLASS}` },
        "Readiness and target details"
      ),
      React.createElement(
        "ul",
        {
          className: "mt-2 grid gap-2 text-xs text-fg-secondary",
          "aria-label": "Autonomous visual readiness reasons"
        },
        ...(readiness?.reasons ?? []).map((reason) =>
          React.createElement(
            "li",
            { key: reason.code },
            React.createElement(
              "span",
              { className: "font-medium" },
              reason.label
            ),
            ": ",
            reason.message
          )
        ),
        readiness === null
          ? React.createElement(
              "li",
              null,
              "Runtime could not read visual mode readiness. This mode will not silently fall back to a headless policy."
            )
          : null
      ),
      readiness && readiness.targets.length > 0
        ? React.createElement(
            "ul",
            {
              className: "mt-3 grid gap-1 text-xs text-fg-muted",
              "aria-label": "Approved visual targets"
            },
            ...readiness.targets.map((targetReadiness) =>
              React.createElement(
                "li",
                { key: targetReadiness.target.targetId },
                targetReadiness.target.name +
                  " · " +
                  targetReadiness.target.targetId +
                  " · revision " +
                  String(targetReadiness.target.revision) +
                  " · approval " +
                  targetReadiness.target.approvalId +
                  " · " +
                  targetReadiness.target.controlTimingClass +
                  " · " +
                  targetReadiness.target.entryRequirements +
                  " entry · " +
                  (targetReadiness.eligibility === "supported"
                    ? "eligible target"
                    : "unsupported target") +
                  (targetReadiness.reasons.length > 0
                    ? ": " +
                      targetReadiness.reasons
                        .map((reason) => reason.label)
                        .join(", ")
                    : "")
              )
            )
          )
        : null
    ),
    workspaceId
      ? React.createElement(
          NavigationLink,
          {
            href: workspacePath(workspaceId),
            className:
              "mt-3 inline-flex text-sm font-medium text-accent hover:underline",
            dataAttributes: {
              "data-playtesting-manage-visual-targets": "true"
            }
          },
          "Manage visual target permissions"
        )
      : null
  );
}

function adapterModeReadinessCard(
  setup: PlaytestingRunSetup
): React.JSX.Element {
  const blocker = playtestingRunSetupBlocker(setup);
  return React.createElement(
    "section",
    {
      className: blocker
        ? "rounded-lg border border-border bg-background/50 p-4"
        : "rounded-lg border border-accent/60 bg-accent/5 p-4",
      "aria-label": "Adapter-accelerated mode",
      "data-playtesting-mode": ADAPTER_ACCELERATED_MODE,
      "data-mode-status": adapterReadinessStatus(setup)
    },
    React.createElement(
      "p",
      { className: "font-semibold" },
      "Adapter-accelerated"
    ),
    React.createElement(
      "p",
      { className: "mt-1 text-xs font-medium text-fg-muted" },
      blocker?.label ?? "Ready to run"
    ),
    React.createElement(
      "p",
      { className: "mt-3 text-sm text-fg-secondary" },
      "Runs the approved game adapter against the latest committed checkout. Results are structured and fast, but do not represent what a player sees."
    )
  );
}

/**
 * The playtest modes the dashboard offers.
 *
 * They are named once because the dashboard reads the same mode in more than
 * one place -- the readiness it asks for, the mode it records, the tab it
 * marks as selected -- and a mode spelled two ways in two places is a mode
 * whose readiness is read from one vocabulary and written to another.
 */
const TARGET_GRID_CLASS = "grid gap-1.5";
const FORM_LABEL_CLASS =
  "text-xs font-semibold uppercase tracking-wider text-fg-muted";

const AUTONOMOUS_VISUAL_MODE = "autonomous-visual";
const ADAPTER_ACCELERATED_MODE = "adapter-accelerated";
type PlaytestingDashboardMode =
  typeof AUTONOMOUS_VISUAL_MODE | typeof ADAPTER_ACCELERATED_MODE;

const VISUAL_FOCUS_PRESETS = [
  {
    id: "explore",
    icon: "🔎",
    title: "Explore the Game",
    description:
      "Identify visible actions and how the current screen responds.",
    prompt:
      "Explore the game's visible controls and identify how a player can progress. Report only state changes observed on screen; do not assume hidden goals."
  },
  {
    id: "loop",
    icon: "🔁",
    title: "Follow One Play Loop",
    description:
      "Use visible actions to progress through one bounded, normal interaction loop.",
    prompt:
      "Follow the visible player interaction loop for one bounded cycle. Use only on-screen affordances and stop when the game shows a terminal result or a clear next-step boundary."
  },
  {
    id: "recovery",
    icon: "🧭",
    title: "Check a Recovery Path",
    description:
      "Observe how one unclear or blocked action is communicated and whether a safe path forward exists.",
    prompt:
      "Explore one safe recovery path from an unclear or blocked screen. Record the visible reason and outcome without claiming a game result that was not shown."
  }
] as const;

/**
 * Every reason the launch may not start, in one place.
 *
 * The button's enabled state and the launch itself have to agree about this,
 * so the conditions are one function rather than two readings of the same
 * state.
 */
function visualLaunchMayStart({
  pending,
  recoveryReady,
  pendingLaunch,
  focus,
  workspaceId,
  hasTarget,
  modeReady,
  policyAvailable
}: {
  readonly pending: boolean;
  readonly recoveryReady: boolean;
  readonly pendingLaunch: unknown;
  readonly focus: string;
  readonly workspaceId: string | null;
  readonly hasTarget: boolean;
  readonly modeReady: boolean;
  readonly policyAvailable: boolean;
}): boolean {
  return (
    !pending &&
    recoveryReady &&
    pendingLaunch === null &&
    focus.trim().length <= 2000 &&
    Boolean(workspaceId) &&
    hasTarget &&
    modeReady &&
    policyAvailable
  );
}

/**
 * The launch request the cockpit sends, or null when there is nothing to
 * launch.
 *
 * The budget in the request is the smaller of what the operator asked for and
 * what the approved target allows, so the request can never ask for more
 * than the target was approved for.
 */
function visualLaunchPayload({
  workspaceId,
  capabilityRevision,
  target,
  policyId,
  focus,
  episodes,
  steps
}: {
  readonly workspaceId: string | null;
  readonly capabilityRevision: string | null;
  readonly target: WorkspaceVisualPlaytestTargetApproval | null;
  readonly policyId: PlaytestVisualPolicyId;
  readonly focus: string;
  readonly episodes: number;
  readonly steps: number;
}): PlaytestLaunchRequestDraft | null {
  if (!workspaceId || !capabilityRevision || !target) {
    return null;
  }
  return {
    schema: PLAYTEST_LAUNCH_REQUEST_SCHEMA,
    mode: AUTONOMOUS_VISUAL_MODE,
    workspaceId,
    capabilityRevision,
    targetId: target.targetId,
    policyId,
    areasOfFocus: focus.trim() || null,
    limits: {
      episodeCount: Math.min(episodes, target.limits.episodeCount),
      maxStepsPerEpisode: Math.min(steps, target.limits.maxStepsPerEpisode),
      wallTimeMs: target.limits.wallTimeMs,
      smartRequestsPerEpisode: target.limits.smartRequestsPerEpisode,
      smartTokensPerEpisode: target.limits.smartTokensPerEpisode,
      screenshotCountPerEpisode: target.limits.screenshotCountPerEpisode,
      artifactBytesPerEpisode: target.limits.artifactBytesPerEpisode
    }
  };
}

/**
 * The name the operator gave the area of focus, or what it is when they have
 * not named one.
 */
function visualFocusLabel(focus: string): string {
  const preset = VISUAL_FOCUS_PRESETS.find(
    (candidate) => candidate.prompt === focus
  );
  if (preset !== undefined) return preset.title;
  return focus.trim().length > 0 ? "Custom focus" : "No focus";
}

/**
 * The decision backend the operator chose, if this mode offers it.
 */
function visualSelectedPolicy(
  policies: readonly ControlApiPlaytestingPolicyReadiness[],
  policyId: string
): ControlApiPlaytestingPolicyReadiness | undefined {
  return policies.find((policy) => policy.policyId === policyId);
}

function VisualPlaytestLaunchCockpit({
  setup,
  workspaceId,
  onRunStarted
}: {
  readonly setup: PlaytestingRunSetup;
  readonly workspaceId: string | null;
  readonly onRunStarted: (
    started: ControlApiPlaytestingRunStartedResponse
  ) => void;
}): React.JSX.Element {
  const launchRecovery = usePlaytestingLaunchRecovery({
    setup,
    workspaceId,
    onRunStarted
  });
  const readiness =
    setup.kind === "available"
      ? setup.capabilities.modeReadiness[AUTONOMOUS_VISUAL_MODE]
      : null;
  const isReady = readiness?.status === "ready";
  const supportedTargets =
    readiness?.targets.filter((t) => t.eligibility === "supported") ?? [];

  const [selectedTargetId, setSelectedTargetId] = useState<string>(
    supportedTargets[0]?.target.targetId ?? ""
  );
  const primaryTarget =
    supportedTargets.find((t) => t.target.targetId === selectedTargetId)
      ?.target ??
    supportedTargets[0]?.target ??
    null;

  const approvedMaxEpisodes = primaryTarget?.limits.episodeCount ?? 1;
  const approvedMaxSteps = primaryTarget?.limits.maxStepsPerEpisode ?? 50;

  const episodeOptions = Array.from(
    new Set(
      [1, 2, 5, 10]
        .filter((e) => e <= approvedMaxEpisodes)
        .concat(approvedMaxEpisodes)
    )
  ).sort((a, b) => a - b);

  const stepOptions = Array.from(
    new Set(
      [10, 25, 50, 80, 100, 150]
        .filter((s) => s <= approvedMaxSteps)
        .concat(approvedMaxSteps)
    )
  ).sort((a, b) => a - b);

  const [areasOfFocus, setAreasOfFocus] = useState<string>(
    VISUAL_FOCUS_PRESETS[0].prompt
  );
  const [selectedPolicyId, setSelectedPolicyId] =
    useState<PlaytestVisualPolicyId>("smart-direct");
  const [selectedEpisodes, setSelectedEpisodes] = useState<number>(1);
  const [selectedSteps, setSelectedSteps] = useState<number>(approvedMaxSteps);

  const effectiveEpisodes = Math.min(selectedEpisodes, approvedMaxEpisodes);
  const effectiveSteps = Math.min(selectedSteps, approvedMaxSteps);
  const focusLabel = visualFocusLabel(areasOfFocus);

  // The decision backends this mode offers, with each one's own readiness.
  // A backend that cannot be reached is offered but cannot be chosen.
  const policyOptions = readiness?.policies ?? [];
  const selectedPolicyAvailable =
    visualSelectedPolicy(policyOptions, selectedPolicyId)?.status === "ready";

  const launching = Boolean(
    launchRecovery.pending || launchRecovery.pendingLaunch
  );
  const canSubmit = visualLaunchMayStart({
    pending: launchRecovery.pending,
    recoveryReady: launchRecovery.recoveryReady,
    pendingLaunch: launchRecovery.pendingLaunch,
    focus: areasOfFocus,
    workspaceId,
    hasTarget: primaryTarget !== null,
    modeReady: isReady,
    policyAvailable: selectedPolicyAvailable
  });

  const handleLaunch = (): void => {
    if (!canSubmit) return;
    const launchPayload = visualLaunchPayload({
      workspaceId,
      capabilityRevision:
        setup.kind === "available"
          ? setup.capabilities.capabilityRevision
          : null,
      target: primaryTarget,
      policyId: selectedPolicyId,
      focus: areasOfFocus,
      episodes: effectiveEpisodes,
      steps: effectiveSteps
    });
    if (launchPayload === null) return;
    void launchRecovery.startLaunch(launchPayload);
  };

  return React.createElement(
    "section",
    {
      className:
        "grid gap-4 rounded-lg border border-border bg-surface-raised p-4 sm:p-5",
      "aria-labelledby": "visual-cockpit-heading",
      "data-testid": "playtesting-visual-launch"
    },
    React.createElement(
      "div",
      null,
      React.createElement(
        "h3",
        {
          id: "visual-cockpit-heading",
          className: "text-base font-semibold text-fg"
        },
        "Autonomous Visual AI Player"
      ),
      React.createElement(
        "p",
        { className: "mt-1 text-sm text-fg-muted" },
        // The decision backend is the operator's choice, so the sentence does
        // not name one. It also has to fit a phone: the launch action below it
        // must stay above the fold.
        "Explores your approved browser game with vision and keyboard/pointer input."
      )
    ),
    React.createElement(
      "p",
      {
        className: "text-xs font-medium text-fg-muted",
        "data-testid": "visual-launch-summary"
      },
      primaryTarget
        ? primaryTarget.name +
            " · " +
            String(effectiveEpisodes) +
            (effectiveEpisodes === 1 ? " episode" : " episodes") +
            " · " +
            String(effectiveSteps) +
            " steps · " +
            "approved budget: " +
            String(primaryTarget.limits.smartTokensPerEpisode) +
            " tokens, " +
            String(primaryTarget.limits.smartRequestsPerEpisode) +
            " decisions, " +
            String(Math.round(primaryTarget.limits.wallTimeMs / 1000)) +
            "s · Focus: " +
            focusLabel
        : "No approved visual target is available; configure one in Workspaces before starting."
    ),
    React.createElement(
      Button,
      {
        type: "button",
        variant: "primary",
        // A launch in flight is a working control, not an unavailable one: the
        // operator keeps their focus on the action they started. Everything
        // that makes a launch impossible stays a disabled control.
        disabled: !canSubmit && !launching,
        busy: launching,
        onClick: handleLaunch,
        className:
          "inline-flex min-h-12 w-full items-center justify-center gap-2 rounded-xl px-6 py-3.5 text-base font-semibold shadow-md focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent",
        dataAttributes: { "data-playtesting-visual-submit": "true" }
      },
      React.createElement(
        "span",
        { "aria-hidden": true, className: "text-lg leading-none" },
        "🚀"
      ),
      launchRecovery.pending
        ? "Starting visual playtest…"
        : primaryTarget === null
          ? "No Target Selected"
          : isReady
            ? "Launch Visual Playtest"
            : "Visual Readiness Not Ready"
    ),
    supportedTargets.length > 1
      ? React.createElement(
          "div",
          { className: TARGET_GRID_CLASS },
          React.createElement(
            "label",
            {
              htmlFor: "visual-target-select",
              className: FORM_LABEL_CLASS
            },
            "Target Selector"
          ),
          React.createElement(
            "select",
            {
              id: "visual-target-select",
              value: primaryTarget?.targetId ?? "",
              disabled: launchRecovery.pendingLaunch !== null,
              onChange: (e: React.ChangeEvent<HTMLSelectElement>) =>
                setSelectedTargetId(e.target.value),
              className:
                "w-full rounded-lg border border-border bg-surface px-3.5 py-2 text-sm text-fg focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent",
              "data-testid": "visual-target-select"
            },
            ...supportedTargets.map((entry) =>
              React.createElement(
                "option",
                {
                  key: entry.target.targetId,
                  value: entry.target.targetId
                },
                entry.target.name +
                  " (" +
                  entry.target.entryUrl +
                  ") · " +
                  entry.target.targetId +
                  " rev " +
                  String(entry.target.revision)
              )
            )
          )
        )
      : null,
    policyOptions.length > 0
      ? React.createElement(
          "div",
          { className: TARGET_GRID_CLASS },
          React.createElement(
            "label",
            {
              htmlFor: "visual-policy-select",
              className: FORM_LABEL_CLASS
            },
            "Decision backend"
          ),
          React.createElement(
            "select",
            {
              id: "visual-policy-select",
              value: selectedPolicyId,
              disabled: launchRecovery.pendingLaunch !== null,
              onChange: (e: React.ChangeEvent<HTMLSelectElement>) =>
                setSelectedPolicyId(e.target.value as PlaytestVisualPolicyId),
              className:
                "w-full rounded-lg border border-border bg-surface px-3.5 py-2 text-sm text-fg focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent",
              "data-testid": "visual-policy-select"
            },
            ...policyOptions.map((policy) =>
              React.createElement(
                "option",
                {
                  key: policy.policyId,
                  value: policy.policyId,
                  disabled: policy.status !== "ready"
                },
                policyLabel(policy.policyId) +
                  (policy.status === "ready"
                    ? ""
                    : " · unavailable: " +
                      (policy.reasons[0]?.message ?? "not reachable"))
              )
            )
          ),
          React.createElement(
            "p",
            { className: `text-xs ${MUTED_TEXT_CLASS}` },
            selectedPolicyAvailable
              ? "The backend that chooses each action. Its own readiness is reported above."
              : "The selected decision backend is not reachable, so no run can start with it."
          )
        )
      : null,
    primaryTarget
      ? React.createElement(
          "div",
          {
            className:
              "rounded-xl border border-accent bg-surface p-4 shadow-sm",
            "data-testid": "visual-target-card"
          },
          React.createElement(
            "div",
            {
              className: "flex flex-wrap items-center justify-between gap-2"
            },
            React.createElement(
              "div",
              { className: "flex items-center gap-2" },
              React.createElement("span", {
                className:
                  "flex h-2.5 w-2.5 rounded-full bg-accent ring-2 ring-accent/20"
              }),
              React.createElement(
                "div",
                null,
                React.createElement(
                  "h4",
                  { className: "font-semibold text-fg" },
                  primaryTarget.name
                ),
                React.createElement(
                  "p",
                  {
                    className: `text-xs ${MUTED_TEXT_CLASS}`,
                    "data-testid": "visual-target-identity"
                  },
                  `${primaryTarget.targetId} · revision ${String(primaryTarget.revision)} · approval ${primaryTarget.approvalId}`
                )
              )
            ),
            React.createElement(
              "span",
              {
                className:
                  "rounded-md bg-accent/10 px-2.5 py-1 text-xs font-semibold text-accent"
              },
              "Ready · Ungated"
            )
          ),
          React.createElement(
            "div",
            {
              className:
                "mt-2.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-fg-muted"
            },
            React.createElement(
              "span",
              null,
              "🌐 ",
              React.createElement(
                "code",
                { className: "font-mono text-fg font-medium" },
                primaryTarget.entryUrl
              )
            ),
            React.createElement(
              "span",
              null,
              "🎮 Controls: ",
              React.createElement(
                "span",
                { className: "font-medium text-fg" },
                (
                  primaryTarget.inputCapabilities ?? ["keyboard", "pointer"]
                ).join(" + ")
              )
            ),
            React.createElement(
              "span",
              null,
              "⏱️ Timing: ",
              React.createElement(
                "span",
                { className: "font-medium text-fg" },
                primaryTarget.controlTimingClass
              )
            ),
            React.createElement(
              "span",
              { "data-testid": "visual-target-build-identity" },
              "Build identity: Unknown (URL-only target)"
            )
          ),
          React.createElement(
            "details",
            {
              className: "mt-3",
              "data-testid": "visual-approved-budget-details"
            },
            React.createElement(
              "summary",
              { className: "cursor-pointer text-xs font-medium text-fg-muted" },
              "Other approved per-episode limits"
            ),
            React.createElement(
              "dl",
              { className: "mt-2 grid gap-x-4 gap-y-1 text-xs sm:grid-cols-2" },
              ...(
                [
                  [
                    "Wall time",
                    `${primaryTarget.limits.wallTimeMs.toLocaleString("en-US")} ms`
                  ],
                  [
                    "Smart requests",
                    primaryTarget.limits.smartRequestsPerEpisode.toLocaleString(
                      "en-US"
                    )
                  ],
                  [
                    "Smart tokens",
                    primaryTarget.limits.smartTokensPerEpisode.toLocaleString(
                      "en-US"
                    )
                  ],
                  [
                    "Screenshots",
                    primaryTarget.limits.screenshotCountPerEpisode.toLocaleString(
                      "en-US"
                    )
                  ],
                  [
                    "Artifact storage",
                    Number.isInteger(
                      primaryTarget.limits.artifactBytesPerEpisode / 1_048_576
                    )
                      ? `${(primaryTarget.limits.artifactBytesPerEpisode / 1_048_576).toLocaleString("en-US")} MiB`
                      : `${primaryTarget.limits.artifactBytesPerEpisode.toLocaleString("en-US")} bytes`
                  ]
                ] as const
              ).map(([label, value]) =>
                React.createElement(
                  "div",
                  {
                    key: label,
                    className: "flex items-baseline justify-between gap-3"
                  },
                  React.createElement(
                    "dt",
                    { className: MUTED_TEXT_CLASS },
                    label
                  ),
                  React.createElement(
                    "dd",
                    { className: "font-medium text-fg" },
                    value
                  )
                )
              )
            )
          )
        )
      : React.createElement(
          "div",
          {
            className: "rounded-xl border border-warning/40 bg-surface p-4"
          },
          React.createElement(
            "p",
            { className: "text-sm font-medium text-fg" },
            "No approved visual playtest target available"
          ),
          React.createElement(
            "p",
            { className: "mt-1 text-xs text-fg-muted" },
            "An approved local browser target (e.g. http://localhost:5173/) is required to run the Autonomous Visual AI Player."
          ),
          workspaceId
            ? React.createElement(
                NavigationLink,
                {
                  href: workspacePath(workspaceId),
                  className:
                    "mt-3 inline-flex text-xs font-semibold text-accent hover:underline"
                },
                "Configure visual target in Workspaces →"
              )
            : null
        ),
    React.createElement(
      "div",
      { className: "grid gap-2" },
      React.createElement(
        "label",
        {
          className: FORM_LABEL_CLASS
        },
        "1. Focus Presets"
      ),
      React.createElement(
        "div",
        { className: "grid gap-2 sm:grid-cols-3" },
        ...VISUAL_FOCUS_PRESETS.map((preset) => {
          const isSelected = areasOfFocus === preset.prompt;
          return React.createElement(
            "button",
            {
              key: preset.id,
              type: "button",
              onClick: () => setAreasOfFocus(preset.prompt),
              disabled: launchRecovery.pendingLaunch !== null,
              className:
                "flex flex-col items-start gap-1 rounded-xl border p-3.5 text-left transition " +
                (isSelected
                  ? "border-accent bg-accent/10 shadow-sm ring-1 ring-accent"
                  : "border-border bg-surface hover:border-fg-muted/40 hover:bg-surface-raised")
            },
            React.createElement(
              "span",
              { className: "text-sm font-semibold text-fg" },
              preset.icon + " " + preset.title
            ),
            React.createElement(
              "span",
              { className: "text-xs text-fg-secondary leading-relaxed" },
              preset.description
            )
          );
        })
      )
    ),
    React.createElement(
      "div",
      { className: TARGET_GRID_CLASS },
      React.createElement(
        "label",
        {
          htmlFor: "visual-focus-textarea",
          className: FORM_LABEL_CLASS
        },
        "2. Areas of Focus & Objectives"
      ),
      React.createElement("textarea", {
        id: "visual-focus-textarea",
        rows: 2,
        value: areasOfFocus,
        onChange: (e: React.ChangeEvent<HTMLTextAreaElement>) =>
          setAreasOfFocus(e.target.value),
        maxLength: 2000,
        disabled: launchRecovery.pendingLaunch !== null,
        placeholder:
          "e.g., Focus on vehicle cornering, recovery from wall hits, and finish line detection",
        className:
          "w-full rounded-lg border border-border bg-surface px-3.5 py-2 text-sm text-fg placeholder:text-fg-muted/60 focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent"
      })
    ),
    React.createElement(
      "div",
      { className: TARGET_GRID_CLASS },
      React.createElement(
        "label",
        {
          className: FORM_LABEL_CLASS
        },
        "3. Episode Count (max " + String(approvedMaxEpisodes) + ")"
      ),
      React.createElement(
        "div",
        {
          className: "flex flex-wrap gap-2",
          "data-testid": "visual-episode-options"
        },
        ...episodeOptions.map((count) =>
          React.createElement(
            "button",
            {
              key: count,
              type: "button",
              onClick: () => setSelectedEpisodes(count),
              disabled: launchRecovery.pendingLaunch !== null,
              className:
                "rounded-lg border px-4 py-2 text-xs font-medium transition " +
                (effectiveEpisodes === count
                  ? "border-accent bg-accent text-fg-inverse shadow-sm"
                  : "border-border bg-surface text-fg hover:bg-surface-raised")
            },
            String(count) + (count === 1 ? " episode" : " episodes")
          )
        )
      )
    ),
    React.createElement(
      "div",
      { className: TARGET_GRID_CLASS },
      React.createElement(
        "label",
        {
          className: FORM_LABEL_CLASS
        },
        "4. Step Cap (max " + String(approvedMaxSteps) + ")"
      ),
      React.createElement(
        "div",
        {
          className: "flex flex-wrap gap-2",
          "data-testid": "visual-step-options"
        },
        ...stepOptions.map((step) =>
          React.createElement(
            "button",
            {
              key: step,
              type: "button",
              onClick: () => setSelectedSteps(step),
              disabled: launchRecovery.pendingLaunch !== null,
              className:
                "rounded-lg border px-4 py-2 text-xs font-medium transition " +
                (effectiveSteps === step
                  ? "border-accent bg-accent text-fg-inverse shadow-sm"
                  : "border-border bg-surface text-fg hover:bg-surface-raised")
            },
            String(step) + " steps"
          )
        )
      )
    ),
    launchRecovery.recoveryPanel,
    launchRecovery.statusMessage
  );
}

function PlaytestingModeReadinessCards({
  setup,
  workspaceId
}: {
  readonly setup: PlaytestingRunSetup;
  readonly workspaceId: string | null;
}): React.JSX.Element {
  return React.createElement(
    "div",
    {
      className:
        "grid gap-3 border-b border-border px-5 py-4 sm:grid-cols-2 sm:px-6"
    },
    visualModeReadinessCard(setup, workspaceId),
    adapterModeReadinessCard(setup)
  );
}

/**
 * Keeps the browser's own dialog open or closed with the page's state.
 *
 * The dialog is the browser's: it traps focus and closes on Escape. The
 * page's state says whether it should be open and the browser's own state
 * says whether it is, and the two have to agree.
 */
function syncPlaytestDialog(
  dialog: HTMLDialogElement | null,
  open: boolean
): void {
  if (!dialog) return;
  if (open && !dialog.open) {
    dialog.showModal();
    return;
  }
  if (!open && dialog.open) dialog.close();
}

/**
 * What the live-run disclosure says while it is closed.
 *
 * A disclosure that says "Live run status" when a run is active hides the
 * one thing the operator opened it for.
 */
function liveRunStatusLabel(activeCount: number, totalCount: number): string {
  if (activeCount > 0) {
    return `${String(activeCount)} active ${activeCount === 1 ? "run" : "runs"} · view live status`;
  }
  return totalCount > 0 ? "Most recent run status" : "Live run status";
}

/** The tab's own styling: the selected tab is the accent one. */
function modeTabClass(selected: boolean): string {
  return selected
    ? "border-accent text-accent"
    : "border-transparent text-fg-muted hover:text-fg";
}

export function PlaytestingRunDashboard({
  setup,
  scope,
  showRunControls = true
}: {
  readonly setup: PlaytestingRunSetup;
  readonly scope: PlaytestingScope;
  readonly showRunControls?: boolean;
}): React.JSX.Element {
  const router = useRouter();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [playDialogOpen, setPlayDialogOpen] = useState(false);
  const live = usePlaytestingActiveRuns({
    workspaceId: scope.workspaceId ?? null
  });
  const [focusedBatchId, setFocusedBatchId] = useState(scope.liveBatchId);
  const visualReadiness =
    setup.kind === "available"
      ? setup.capabilities.modeReadiness[AUTONOMOUS_VISUAL_MODE]
      : null;
  const visualReady = visualReadiness?.status === "ready";
  const [selectedMode, setSelectedMode] = useState<PlaytestingDashboardMode>(
    visualReady ? AUTONOMOUS_VISUAL_MODE : ADAPTER_ACCELERATED_MODE
  );

  const onRunStarted = useCallback(
    (started: ControlApiPlaytestingRunStartedResponse) => {
      const record: ControlApiPlaytestingRunRecord = {
        batchId: started.batchId,
        status: started.status,
        cancellationReason: null,
        result: null,
        error: null
      };
      setFocusedBatchId(started.batchId);
      setPlayDialogOpen(false);
      live.trackRun({
        batchId: started.batchId,
        assignmentCount: started.assignmentCount,
        createdAt: started.createdAt,
        sessions: started.sessions,
        record
      });
      const url = new URL(globalThis.location.href);
      url.searchParams.set("liveBatch", started.batchId);
      globalThis.history.pushState(null, "", url);
    },
    [live.trackRun]
  );
  const operatorActionsAvailable =
    setup.kind === "available"
      ? setup.capabilities.operatorActionsAvailable
      : null;
  const { allowed: canCancel, reason: cancelUnavailableReason } =
    cancellationAvailability(operatorActionsAvailable);
  const terminalBatches = live.state.runs
    .filter((run) => isTerminal(run.record))
    .map((run) => run.batchId)
    .join(",");
  useEffect(() => {
    if (terminalBatches) router.refresh();
  }, [router, terminalBatches]);
  useEffect(() => {
    syncPlaytestDialog(dialogRef.current, playDialogOpen);
  }, [playDialogOpen]);

  const activeCount = live.state.runs.filter(
    (run) => !isTerminal(run.record)
  ).length;
  return React.createElement(
    React.Fragment,
    null,
    showRunControls
      ? React.createElement(
          "div",
          { className: "flex flex-wrap items-center justify-end gap-3" },
          React.createElement(
            "button",
            {
              type: "button",
              className:
                "inline-flex min-h-11 items-center gap-2 rounded-lg bg-accent px-5 py-2.5 text-sm font-semibold text-fg-inverse shadow-sm transition hover:brightness-110 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:cursor-not-allowed disabled:opacity-60",
              onClick: () => setPlayDialogOpen(true),
              disabled: scope.workspaceId === null,
              "aria-label": "Start playtest",
              title:
                scope.workspaceId === null
                  ? "Choose a workspace before starting a playtest"
                  : undefined,
              "data-playtesting-open-dialog": "true"
            },
            React.createElement(
              "span",
              { "aria-hidden": true, className: "text-lg leading-none" },
              "▶"
            ),
            "Play"
          ),
          React.createElement(
            "dialog",
            {
              ref: dialogRef,
              className:
                "m-auto max-h-[calc(100dvh-2rem)] w-[min(52rem,calc(100%-2rem))] overflow-y-auto rounded-xl border border-border bg-surface p-0 text-fg shadow-2xl backdrop:bg-black/70",
              "aria-labelledby": "playtesting-new-dialog-title",
              "data-testid": "playtesting-new-dialog",
              onClose: () => setPlayDialogOpen(false)
            },
            React.createElement(
              "div",
              {
                className:
                  "flex items-start justify-between gap-4 border-b border-border px-5 py-4 sm:px-6"
              },
              React.createElement(
                "div",
                null,
                React.createElement(
                  "h2",
                  {
                    id: "playtesting-new-dialog-title",
                    className: "text-lg font-semibold tracking-tight"
                  },
                  "New playtest"
                ),
                React.createElement(
                  "p",
                  { className: "mt-1 text-sm text-fg-muted" },
                  "Review visual readiness first. Adapter runs are a separate, structured-data option—not a visual-mode fallback."
                )
              ),
              React.createElement(
                "button",
                {
                  type: "button",
                  className:
                    "rounded-md border border-border px-3 py-2 text-sm hover:bg-surface-raised",
                  onClick: () => setPlayDialogOpen(false),
                  "aria-label": "Close new playtest dialog"
                },
                "Close"
              )
            ),
            React.createElement(PlaytestingModeReadinessCards, {
              setup,
              workspaceId: scope.workspaceId
            }),
            React.createElement(
              "div",
              {
                className:
                  "flex border-b border-border bg-surface-raised px-5 sm:px-6"
              },
              React.createElement(
                "button",
                {
                  type: "button",
                  className:
                    "flex items-center gap-2 border-b-2 px-4 py-3 text-sm font-semibold transition " +
                    modeTabClass(selectedMode === AUTONOMOUS_VISUAL_MODE),
                  onClick: () => setSelectedMode(AUTONOMOUS_VISUAL_MODE),
                  "data-playtesting-tab": AUTONOMOUS_VISUAL_MODE
                },
                React.createElement("span", null, "🌐"),
                React.createElement(
                  "span",
                  null,
                  "Autonomous Visual AI Player"
                ),
                visualReady
                  ? React.createElement(
                      "span",
                      {
                        className:
                          "rounded-full bg-accent/15 px-2 py-0.5 text-xs text-accent"
                      },
                      "Ready"
                    )
                  : null
              ),
              React.createElement(
                "button",
                {
                  type: "button",
                  className:
                    "flex items-center gap-2 border-b-2 px-4 py-3 text-sm font-semibold transition " +
                    modeTabClass(selectedMode === ADAPTER_ACCELERATED_MODE),
                  onClick: () => setSelectedMode(ADAPTER_ACCELERATED_MODE),
                  "data-playtesting-tab": ADAPTER_ACCELERATED_MODE
                },
                React.createElement("span", null, "⚡"),
                React.createElement("span", null, "Adapter Simulation")
              )
            ),
            React.createElement(
              "div",
              { className: "p-5 sm:p-6" },
              selectedMode === AUTONOMOUS_VISUAL_MODE
                ? React.createElement(VisualPlaytestLaunchCockpit, {
                    setup,
                    workspaceId: scope.workspaceId,
                    onRunStarted
                  })
                : React.createElement(
                    "section",
                    {
                      className:
                        "grid gap-3 rounded-lg border border-border bg-surface-raised p-4 sm:p-5",
                      "aria-labelledby": "playtesting-adapter-launch-title",
                      "data-testid": "playtesting-adapter-launch"
                    },
                    React.createElement(
                      "div",
                      null,
                      React.createElement(
                        "h3",
                        {
                          id: "playtesting-adapter-launch-title",
                          className: "font-semibold"
                        },
                        "Adapter-accelerated run"
                      ),
                      React.createElement(
                        "p",
                        { className: "mt-1 text-sm text-fg-muted" },
                        "Runs the game adapter and reports structured game state. It does not observe the rendered UI or stand in for autonomous visual play."
                      )
                    ),
                    React.createElement(PlaytestingRunControls, {
                      setup,
                      workspaceId: scope.workspaceId,
                      onRunStarted
                    })
                  )
            )
          )
        )
      : null,
    scope.workspaceId && scope.view === "overview"
      ? React.createElement(
          "details",
          {
            className: "rounded-lg border border-border bg-surface/70",
            open: live.state.runs.length > 0,
            "data-testid": "playtesting-run-status-disclosure"
          },
          React.createElement(
            "summary",
            {
              className:
                "cursor-pointer list-none px-4 py-3 text-sm font-medium"
            },
            liveRunStatusLabel(activeCount, live.state.runs.length)
          ),
          React.createElement(
            "div",
            { className: "border-t border-border p-3" },
            React.createElement(PlaytestingLiveRuns, {
              workspaceId: scope.workspaceId,
              scope,
              initialFocusedBatchId: focusedBatchId,
              wallTimeMs:
                setup.kind === "available"
                  ? (setup.capabilities.limits?.wallTimeMs ?? null)
                  : null,
              showEmptyState: true,
              allowCancel: canCancel,
              cancelUnavailableReason,
              live
            })
          )
        )
      : null
  );
}
