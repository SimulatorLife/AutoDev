"use client";

/**
 * Coordinates the run start acknowledgement with the one live status owner.
 *
 * The dashboard owns one workspace-scoped status reader. The start form only
 * submits a typed request; the run-status panel is the sole status surface.
 * A terminal transition refreshes the server-rendered evidence and recent result.
 */
import {
  type ControlApiPlaytestingRunRecord,
  type ControlApiPlaytestingRunStartedResponse,
  PLAYTEST_LAUNCH_REQUEST_SCHEMA
} from "@simulatorlife/autodev-core";
import { useRouter } from "next/navigation";
import React, { useCallback, useEffect, useRef, useState } from "react";

import { NavigationLink } from "../../components/navigation/NavigationLink.ts";
import { workspacePath } from "../workspaces/paths.ts";
import {
  cancellationAvailability,
  isTerminal
} from "./playtesting-active-runs.ts";
import type { PlaytestingScope } from "./playtesting-url.ts";
import { PlaytestingLiveRuns } from "./PlaytestingLiveRuns.ts";
import {
  PlaytestingRunControls,
  type PlaytestingRunSetup,
  playtestingRunSetupBlocker
} from "./PlaytestingRunControls.tsx";
import { usePlaytestingActiveRuns } from "./use-playtesting-active-runs.ts";

function adapterReadinessStatus(
  setup: PlaytestingRunSetup
): "ready" | "check-required" | "unavailable" {
  return setup.kind === "available"
    ? setup.capabilities.modeReadiness["adapter-accelerated"].status
    : "unavailable";
}

function visualModeReadinessCard(
  setup: PlaytestingRunSetup,
  workspaceId: string | null
): React.JSX.Element {
  const readiness =
    setup.kind === "available"
      ? setup.capabilities.modeReadiness["autonomous-visual"]
      : null;
  return React.createElement(
    "section",
    {
      className:
        "rounded-lg border border-border bg-background/50 p-4 opacity-75",
      "aria-label": "Autonomous visual mode readiness",
      "data-playtesting-mode": "autonomous-visual",
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
      readiness?.reasons[0]?.label ?? "Visual readiness unavailable"
    ),
    React.createElement(
      "details",
      { className: "mt-2", "data-testid": "visual-readiness-details" },
      React.createElement(
        "summary",
        { className: "cursor-pointer text-xs text-fg-muted" },
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
      "data-playtesting-mode": "adapter-accelerated",
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

const VISUAL_FOCUS_PRESETS = [
  {
    id: "race",
    icon: "🏁",
    title: "Complete Race",
    description:
      "Focus on lap completion, speed control, collision avoidance, and reaching the finish line.",
    prompt:
      "Focus on lap completion, optimal speed control, staying on the track, and crossing the finish line."
  },
  {
    id: "garage",
    icon: "🏎️",
    title: "Explore Menus & Garage",
    description: "Interact with options, vehicle selection, and audio toggles.",
    prompt:
      "Explore the game menus, vehicle selection, garage upgrades, and test UI button interactions."
  },
  {
    id: "handling",
    icon: "⏱️",
    title: "Vehicle Handling Stress",
    description: "Test wall collision, bounce-back behavior, and recovery.",
    prompt:
      "Stress test high-speed cornering, collision recovery against walls and barriers, and steering responsiveness."
  }
] as const;

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
  const readiness =
    setup.kind === "available"
      ? setup.capabilities.modeReadiness["autonomous-visual"]
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
  const [selectedEpisodes, setSelectedEpisodes] = useState<number>(1);
  const [selectedSteps, setSelectedSteps] = useState<number>(approvedMaxSteps);
  const [pending, setPending] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  const effectiveEpisodes = Math.min(selectedEpisodes, approvedMaxEpisodes);
  const effectiveSteps = Math.min(selectedSteps, approvedMaxSteps);

  const canSubmit = Boolean(
    !pending && workspaceId && primaryTarget && isReady
  );

  const handleLaunch = async () => {
    if (
      !canSubmit ||
      !workspaceId ||
      !primaryTarget ||
      setup.kind !== "available"
    )
      return;
    setPending(true);
    setError(null);
    try {
      const launchPayload = {
        schema: PLAYTEST_LAUNCH_REQUEST_SCHEMA,
        mode: "autonomous-visual" as const,
        workspaceId,
        requestId: globalThis.crypto.randomUUID(),
        capabilityRevision: setup.capabilities.capabilityRevision,
        targetId: primaryTarget.targetId,
        policyId: "smart-direct" as const,
        areasOfFocus: areasOfFocus.trim() || null,
        limits: {
          episodeCount: Math.min(
            effectiveEpisodes,
            primaryTarget.limits.episodeCount
          ),
          maxStepsPerEpisode: Math.min(
            effectiveSteps,
            primaryTarget.limits.maxStepsPerEpisode
          ),
          wallTimeMs: primaryTarget.limits.wallTimeMs,
          smartRequestsPerEpisode: primaryTarget.limits.smartRequestsPerEpisode,
          smartTokensPerEpisode: primaryTarget.limits.smartTokensPerEpisode,
          screenshotCountPerEpisode:
            primaryTarget.limits.screenshotCountPerEpisode,
          artifactBytesPerEpisode: primaryTarget.limits.artifactBytesPerEpisode
        }
      };
      const form = new URLSearchParams({
        launchRequest: JSON.stringify(launchPayload)
      });
      const response = await fetch("/api/playtesting/runs", {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/x-www-form-urlencoded"
        },
        body: form
      });
      const payload: unknown = await response.json();
      if (
        !response.ok ||
        typeof payload !== "object" ||
        payload === null ||
        (payload as any).kind !== "ok"
      ) {
        const msg =
          typeof (payload as any)?.message === "string"
            ? (payload as any).message
            : "Failed to launch visual playtest";
        setError(msg);
        setPending(false);
        return;
      }
      onRunStarted((payload as any).data);
    } catch (err: unknown) {
      setError(
        err instanceof Error
          ? err.message
          : "Connection failed to launch visual playtest"
      );
      setPending(false);
    }
  };

  return React.createElement(
    "section",
    {
      className:
        "grid gap-5 rounded-lg border border-border bg-surface-raised p-4 sm:p-5",
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
        "Launches an intelligent AI player using vision and discrete keyboard/pointer controls to explore and play your live game."
      )
    ),
    supportedTargets.length > 1
      ? React.createElement(
          "div",
          { className: "grid gap-1.5" },
          React.createElement(
            "label",
            {
              htmlFor: "visual-target-select",
              className:
                "text-xs font-semibold uppercase tracking-wider text-fg-muted"
            },
            "Target Selector"
          ),
          React.createElement(
            "select",
            {
              id: "visual-target-select",
              value: primaryTarget?.targetId ?? "",
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
                entry.target.name + " (" + entry.target.entryUrl + ")"
              )
            )
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
                "h4",
                { className: "font-semibold text-fg" },
                primaryTarget.name
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
          className:
            "text-xs font-semibold uppercase tracking-wider text-fg-muted"
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
      { className: "grid gap-1.5" },
      React.createElement(
        "label",
        {
          htmlFor: "visual-focus-textarea",
          className:
            "text-xs font-semibold uppercase tracking-wider text-fg-muted"
        },
        "2. Areas of Focus & Objectives"
      ),
      React.createElement("textarea", {
        id: "visual-focus-textarea",
        rows: 2,
        value: areasOfFocus,
        onChange: (e: React.ChangeEvent<HTMLTextAreaElement>) =>
          setAreasOfFocus(e.target.value),
        placeholder:
          "e.g., Focus on vehicle cornering, recovery from wall hits, and finish line detection",
        className:
          "w-full rounded-lg border border-border bg-surface px-3.5 py-2 text-sm text-fg placeholder:text-fg-muted/60 focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent"
      })
    ),
    React.createElement(
      "div",
      { className: "grid gap-1.5" },
      React.createElement(
        "label",
        {
          className:
            "text-xs font-semibold uppercase tracking-wider text-fg-muted"
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
      { className: "grid gap-1.5" },
      React.createElement(
        "label",
        {
          className:
            "text-xs font-semibold uppercase tracking-wider text-fg-muted"
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
    error
      ? React.createElement(
          "p",
          { className: "text-xs font-medium text-error", role: "alert" },
          error
        )
      : null,
    React.createElement(
      "button",
      {
        type: "button",
        disabled: !canSubmit,
        onClick: () => void handleLaunch(),
        className:
          "inline-flex min-h-12 w-full items-center justify-center gap-2 rounded-xl bg-accent px-6 py-3.5 text-base font-semibold text-fg-inverse shadow-md transition hover:brightness-110 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:cursor-not-allowed disabled:opacity-60",
        "data-playtesting-visual-submit": "true"
      },
      React.createElement(
        "span",
        { "aria-hidden": true, className: "text-lg leading-none" },
        "🚀"
      ),
      pending
        ? "Starting visual playtest…"
        : !primaryTarget
          ? "No Target Selected"
          : !isReady
            ? "Visual Readiness Not Ready"
            : "Launch Visual Playtest"
    )
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
      ? setup.capabilities.modeReadiness["autonomous-visual"]
      : null;
  const visualReady = visualReadiness?.status === "ready";
  const [selectedMode, setSelectedMode] = useState<
    "autonomous-visual" | "adapter-accelerated"
  >(visualReady ? "autonomous-visual" : "adapter-accelerated");

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
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (playDialogOpen && !dialog.open) dialog.showModal();
    else if (!playDialogOpen && dialog.open) dialog.close();
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
                    (selectedMode === "autonomous-visual"
                      ? "border-accent text-accent"
                      : "border-transparent text-fg-muted hover:text-fg"),
                  onClick: () => setSelectedMode("autonomous-visual"),
                  "data-playtesting-tab": "autonomous-visual"
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
                    (selectedMode === "adapter-accelerated"
                      ? "border-accent text-accent"
                      : "border-transparent text-fg-muted hover:text-fg"),
                  onClick: () => setSelectedMode("adapter-accelerated"),
                  "data-playtesting-tab": "adapter-accelerated"
                },
                React.createElement("span", null, "⚡"),
                React.createElement("span", null, "Adapter Simulation")
              )
            ),
            React.createElement(
              "div",
              { className: "p-5 sm:p-6" },
              selectedMode === "autonomous-visual"
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
            activeCount > 0
              ? `${String(activeCount)} active ${activeCount === 1 ? "run" : "runs"} · view live status`
              : live.state.runs.length > 0
                ? "Most recent run status"
                : "Live run status"
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
