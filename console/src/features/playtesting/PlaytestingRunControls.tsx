"use client";

import type {
  ControlApiPlaytestingCapabilitiesResponse,
  ControlApiPlaytestingRunRecord,
  ControlApiPlaytestingRunStartedResponse,
  ControlApiPlaytestingRunStatusResponse,
  PlaytestJsonValue
} from "@simulatorlife/autodev-core";
import React, { useState } from "react";

import { SECTION_HEADING_CLASS } from "../../components/layout/Heading.ts";
import {
  LIST_PANEL_CLASS,
  NESTED_PANEL_CLASS
} from "../../components/layout/Panel.ts";
import { NavigationLink } from "../../components/navigation/NavigationLink.ts";
import { StatusBadge } from "../../components/status/StatusBadge.ts";
import { FIELD_CONTROL_CLASS } from "../../components/ui/field-classes.ts";
import {
  MUTED_BODY_CLASS,
  MUTED_META_CLASS
} from "../../components/ui/text-classes.ts";
import {
  playtestingEpisodeHref,
  type PlaytestingScope
} from "./playtesting-url.ts";

export type PlaytestingRunSetup =
  | {
      readonly kind: "available";
      readonly capabilities: ControlApiPlaytestingCapabilitiesResponse;
    }
  | {
      readonly kind: "unavailable";
      readonly code: string;
      readonly message: string;
    };

function objectRecord(
  value: PlaytestJsonValue | null
): Record<string, PlaytestJsonValue> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  return value as Readonly<Record<string, PlaytestJsonValue>>;
}

function responseMessage(value: unknown): string {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return "The Console could not validate the server response.";
  }
  const error = (value as { error?: unknown }).error;
  if (typeof error === "object" && error !== null && !Array.isArray(error)) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string") return message;
  }
  return "The Console could not validate the server response.";
}

function batchStatusBadge(status: string): React.JSX.Element {
  const appearance =
    status === "completed"
      ? { variant: "valid" as const, label: "Completed" }
      : status === "running" || status === "persisting"
        ? {
            variant: "pending" as const,
            label: status === "running" ? "Running" : "Saving evidence"
          }
        : {
            variant: "unavailable" as const,
            label: status === "cancelled" ? "Cancelled" : "Failed"
          };
  return React.createElement(StatusBadge, {
    status: appearance.variant,
    label: appearance.label
  });
}

export function PlaytestingRunControls({
  setup,
  scope
}: {
  readonly setup: PlaytestingRunSetup;
  readonly scope: PlaytestingScope;
}): React.JSX.Element {
  const capabilities = setup.kind === "available" ? setup.capabilities : null;
  const assignments = capabilities?.runnableAssignments ?? [];
  const [scenarioId, setScenarioId] = useState(
    assignments[0]?.scenarioId ?? ""
  );
  const policiesForScenario = assignments.filter(
    (assignment) => assignment.scenarioId === scenarioId
  );
  const [policyId, setPolicyId] = useState(
    policiesForScenario[0]?.policyId ?? ""
  );
  const selectedAssignment = assignments.find(
    (assignment) =>
      assignment.scenarioId === scenarioId && assignment.policyId === policyId
  );
  const [seed, setSeed] = useState("seed-1");
  const [maxSteps, setMaxSteps] = useState(
    String(selectedAssignment?.maxStepsPerEpisode ?? 1)
  );
  const [pending, setPending] = useState(false);
  const [run, setRun] = useState<ControlApiPlaytestingRunRecord | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  const canStart =
    capabilities !== null &&
    capabilities.operatorActionsAvailable &&
    capabilities.approved &&
    capabilities.workspaceEnabled &&
    capabilities.configurationStatus === "validated" &&
    selectedAssignment !== undefined;

  async function startRun(
    event: React.FormEvent<HTMLFormElement>
  ): Promise<void> {
    event.preventDefault();
    if (!canStart || !capabilities) return;
    setPending(true);
    setFailure(null);
    setNotice(null);
    try {
      const response = await fetch("/api/playtesting/runs", {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/x-www-form-urlencoded"
        },
        body: new URLSearchParams({
          workspaceId: capabilities.workspaceId,
          scenario: scenarioId,
          policy: policyId,
          seed,
          maxSteps
        })
      });
      const payload: unknown = await response.json();
      if (!response.ok) {
        setFailure(responseMessage(payload));
        return;
      }
      const envelope = payload as {
        kind?: unknown;
        data?: ControlApiPlaytestingRunStartedResponse;
      };
      if (
        envelope.kind !== "ok" ||
        envelope.data?.schema !==
          "autodev-control-playtesting-run-started-v1" ||
        envelope.data.workspaceId !== capabilities.workspaceId
      ) {
        setFailure("The Runtime did not confirm the run assignment.");
        return;
      }
      setRun({
        batchId: envelope.data.batchId,
        status: envelope.data.status,
        cancellationReason: null,
        result: null,
        error: null
      });
      setNotice("The Runtime confirmed this approved episode assignment.");
    } catch {
      setFailure(
        "The same-origin run request could not reach the Console server."
      );
    } finally {
      setPending(false);
    }
  }

  async function refreshStatus(): Promise<void> {
    if (!run || !capabilities) return;
    setPending(true);
    setFailure(null);
    try {
      const query = new URLSearchParams({
        workspaceId: capabilities.workspaceId
      });
      const response = await fetch(
        `/api/playtesting/runs/${encodeURIComponent(run.batchId)}?${query}`,
        { headers: { accept: "application/json" }, cache: "no-store" }
      );
      const payload: unknown = await response.json();
      if (!response.ok) {
        setFailure(responseMessage(payload));
        return;
      }
      const envelope = payload as {
        kind?: unknown;
        data?: ControlApiPlaytestingRunStatusResponse;
      };
      if (
        envelope.kind !== "ok" ||
        envelope.data?.schema !== "autodev-control-playtesting-run-status-v1" ||
        envelope.data.workspaceId !== capabilities.workspaceId ||
        envelope.data.run.batchId !== run.batchId
      ) {
        setFailure("The Runtime returned an incompatible run-status response.");
        return;
      }
      setRun(envelope.data.run);
      setNotice("Run status refreshed from the Runtime.");
    } catch {
      setFailure("The run status could not be refreshed.");
    } finally {
      setPending(false);
    }
  }

  async function cancelRun(): Promise<void> {
    if (!run || !capabilities) return;
    if (!window.confirm(`Request cancellation of ${run.batchId}?`)) return;
    setPending(true);
    setFailure(null);
    setNotice(null);
    try {
      const response = await fetch(
        `/api/playtesting/runs/${encodeURIComponent(run.batchId)}/cancel`,
        {
          method: "POST",
          headers: {
            accept: "application/json",
            "content-type": "application/x-www-form-urlencoded"
          },
          body: new URLSearchParams({ workspaceId: capabilities.workspaceId })
        }
      );
      const payload: unknown = await response.json();
      if (!response.ok) {
        setFailure(responseMessage(payload));
        return;
      }
      setNotice(
        "Cancellation was requested; refresh status to confirm its terminal disposition."
      );
    } catch {
      setFailure(
        "The cancellation request could not reach the Console server."
      );
    } finally {
      setPending(false);
    }
  }

  const body: React.ReactNode[] = [];
  if (setup.kind === "unavailable") {
    body.push(
      React.createElement(StatusBadge, {
        key: "status",
        status: "unavailable",
        label: "Run control unavailable"
      }),
      React.createElement(
        "p",
        { className: MUTED_BODY_CLASS, key: "message" },
        setup.message
      ),
      React.createElement(
        "p",
        { className: MUTED_META_CLASS, key: "code" },
        setup.code
      )
    );
  } else if (capabilities === null) {
    body.push(
      React.createElement(StatusBadge, {
        key: "status",
        status: "unavailable",
        label: "Run setup unavailable"
      })
    );
  } else if (!capabilities.operatorActionsAvailable) {
    body.push(
      React.createElement(StatusBadge, {
        key: "status",
        status: "not-observed",
        label: "Operator required"
      }),
      React.createElement(
        "p",
        { className: MUTED_BODY_CLASS, key: "message" },
        "An authorized operator can start or cancel runs. You can still inspect recorded results."
      )
    );
  } else if (!capabilities.approved) {
    body.push(
      React.createElement(StatusBadge, {
        key: "status",
        status: "not-observed",
        label: "Approval required"
      }),
      React.createElement(
        "p",
        { className: MUTED_BODY_CLASS, key: "message" },
        "Workspaces must approve an exact build, adapter image, and command before any game process can run."
      )
    );
  } else if (!capabilities.workspaceEnabled) {
    body.push(
      React.createElement(StatusBadge, {
        key: "status",
        status: "unavailable",
        label: "Workspace disabled"
      }),
      React.createElement(
        "p",
        { className: MUTED_BODY_CLASS, key: "message" },
        "The approved run cannot start while this workspace is disabled."
      )
    );
  } else if (capabilities.configurationStatus !== "validated") {
    body.push(
      React.createElement(StatusBadge, {
        key: "status",
        status: "unavailable",
        label: "Preflight required"
      }),
      React.createElement(
        "p",
        { className: MUTED_BODY_CLASS, key: "message" },
        "The checked-in target configuration must pass the Runtime's exact-build preflight before this run form is enabled."
      )
    );
  } else if (assignments.length === 0) {
    body.push(
      React.createElement(StatusBadge, {
        key: "status",
        status: "unavailable",
        label: "No runnable policy"
      }),
      React.createElement(
        "p",
        { className: MUTED_BODY_CLASS, key: "message" },
        "No approved policy is currently supported by the Runtime; unsupported approvals are not silently substituted."
      )
    );
  } else {
    body.push(
      React.createElement(
        "form",
        {
          className: "grid gap-3 md:grid-cols-2",
          key: "form",
          "aria-label": "Run one approved Playtesting episode",
          onSubmit: (event: React.FormEvent<HTMLFormElement>) =>
            void startRun(event)
        },
        React.createElement(
          "label",
          { className: "flex flex-col gap-1 text-xs text-fg-muted" },
          "Scenario",
          React.createElement(
            "select",
            {
              name: "scenario",
              value: scenarioId,
              className: FIELD_CONTROL_CLASS,
              onChange: (event: React.ChangeEvent<HTMLSelectElement>) => {
                const nextScenario = event.currentTarget.value;
                setScenarioId(nextScenario);
                const nextPolicy = assignments.find(
                  (assignment) => assignment.scenarioId === nextScenario
                )?.policyId;
                if (nextPolicy) {
                  setPolicyId(nextPolicy);
                  const nextLimit = assignments.find(
                    (assignment) =>
                      assignment.scenarioId === nextScenario &&
                      assignment.policyId === nextPolicy
                  )?.maxStepsPerEpisode;
                  if (nextLimit) {
                    const current = Number(maxSteps);
                    setMaxSteps(
                      String(
                        Number.isSafeInteger(current) && current > 0
                          ? Math.min(current, nextLimit)
                          : nextLimit
                      )
                    );
                  }
                }
              }
            },
            ...[
              ...new Set(assignments.map((assignment) => assignment.scenarioId))
            ].map((id) =>
              React.createElement("option", { key: id, value: id }, id)
            )
          )
        ),
        React.createElement(
          "label",
          { className: "flex flex-col gap-1 text-xs text-fg-muted" },
          "Policy / cohort",
          React.createElement(
            "select",
            {
              name: "policy",
              value: policyId,
              className: FIELD_CONTROL_CLASS,
              onChange: (event: React.ChangeEvent<HTMLSelectElement>) =>
                setPolicyId(event.currentTarget.value)
            },
            ...policiesForScenario.map((assignment) =>
              React.createElement(
                "option",
                { key: assignment.policyId, value: assignment.policyId },
                `${assignment.policyId} · ${assignment.cohort} · ${assignment.strategy}`
              )
            )
          )
        ),
        React.createElement(
          "label",
          { className: "flex flex-col gap-1 text-xs text-fg-muted" },
          "Seed",
          React.createElement("input", {
            name: "seed",
            value: seed,
            className: FIELD_CONTROL_CLASS,
            maxLength: 256,
            required: true,
            onChange: (event: React.ChangeEvent<HTMLInputElement>) =>
              setSeed(event.currentTarget.value)
          })
        ),
        React.createElement(
          "label",
          { className: "flex flex-col gap-1 text-xs text-fg-muted" },
          "Step budget",
          React.createElement("input", {
            name: "maxSteps",
            type: "number",
            min: 1,
            max: selectedAssignment?.maxStepsPerEpisode ?? 1,
            value: maxSteps,
            className: FIELD_CONTROL_CLASS,
            onChange: (event: React.ChangeEvent<HTMLInputElement>) =>
              setMaxSteps(event.currentTarget.value)
          })
        ),
        React.createElement(
          "div",
          { className: "md:col-span-2", key: "budget" },
          React.createElement(
            "p",
            { className: MUTED_META_CLASS },
            `Budget preview: 1 episode · at most ${String(selectedAssignment?.maxStepsPerEpisode ?? 0)} steps · ${String(capabilities.limits?.workerCount ?? 0)} concurrent worker(s) · ${String(capabilities.limits?.wallTimeMs ?? 0)} ms wall time · 0 critiques`
          ),
          React.createElement(
            "p",
            { className: MUTED_META_CLASS },
            `Build ${capabilities.buildSha ?? "Not observed"} · ${capabilities.gameBuild ?? "Game build not observed"} · configuration ${capabilities.configurationStatus}; Runtime rechecks exact approval before launch.`
          )
        ),
        React.createElement(
          "button",
          {
            type: "submit",
            disabled: pending || !canStart || seed.trim().length === 0,
            className:
              "min-h-11 rounded-md bg-accent px-4 py-2 text-sm font-semibold text-fg-inverse disabled:cursor-not-allowed disabled:opacity-60",
            "data-playtesting-run-submit": "true"
          },
          pending ? "Submitting…" : "Run one approved episode"
        )
      )
    );
  }

  if (run && capabilities) {
    const result = objectRecord(run.result);
    body.push(
      React.createElement(
        "section",
        {
          className: NESTED_PANEL_CLASS,
          key: "run-status",
          "aria-label": "Server-confirmed run status"
        },
        React.createElement(
          "div",
          { className: "flex flex-wrap items-center gap-2" },
          React.createElement(
            "strong",
            { className: "font-mono" },
            run.batchId
          ),
          batchStatusBadge(run.status)
        ),
        run.error
          ? React.createElement(
              "p",
              { className: MUTED_BODY_CLASS },
              run.error.message
            )
          : result && typeof result.episodeId === "string"
            ? React.createElement(
                NavigationLink,
                {
                  href: playtestingEpisodeHref(scope, result.episodeId, 0),
                  className: "text-sm text-accent hover:underline"
                },
                `Open episode ${result.episodeId}`
              )
            : React.createElement(
                "p",
                { className: MUTED_META_CLASS },
                "No episode result is recorded yet."
              ),
        React.createElement(
          "div",
          { className: "mt-3 flex flex-wrap gap-2" },
          React.createElement(
            "button",
            {
              type: "button",
              disabled: pending,
              className:
                "min-h-10 rounded-md border border-border px-3 py-2 text-sm disabled:opacity-60",
              onClick: () => void refreshStatus()
            },
            "Refresh server status"
          ),
          capabilities.operatorActionsAvailable &&
            (run.status === "running" || run.status === "persisting")
            ? React.createElement(
                "button",
                {
                  type: "button",
                  disabled: pending,
                  className:
                    "min-h-10 rounded-md border border-warning/50 px-3 py-2 text-sm disabled:opacity-60",
                  onClick: () => void cancelRun()
                },
                "Request cancellation"
              )
            : null
        )
      )
    );
  }
  if (notice)
    body.push(
      React.createElement(
        "p",
        { className: MUTED_META_CLASS, role: "status", key: "notice" },
        notice
      )
    );
  if (failure)
    body.push(
      React.createElement(
        "p",
        { className: "text-sm text-error", role: "alert", key: "failure" },
        failure
      )
    );

  return React.createElement(
    "section",
    {
      className: LIST_PANEL_CLASS,
      "aria-labelledby": "playtesting-run-controls-heading",
      "data-run-setup": setup.kind
    },
    React.createElement(
      "h2",
      {
        id: "playtesting-run-controls-heading",
        className: SECTION_HEADING_CLASS
      },
      "Run an approved episode"
    ),
    React.createElement(
      "p",
      { className: MUTED_BODY_CLASS },
      "Run requests contain only typed scenario, policy, seed, and step-budget fields. Workspaces owns the exact build approval; the Runtime confirms status and cancellation."
    ),
    ...body
  );
}
