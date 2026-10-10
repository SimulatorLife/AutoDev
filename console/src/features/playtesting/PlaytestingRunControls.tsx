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
import {
  NOT_OBSERVED_STATUS,
  StatusBadge
} from "../../components/status/StatusBadge.ts";
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

interface RunSubmission {
  readonly workspaceId: string;
  readonly scenario: string;
  readonly policy: string;
  readonly seed: string;
  readonly maxSteps: string;
}

function objectRecord(
  value: PlaytestJsonValue | null
): Readonly<Record<string, PlaytestJsonValue>> | null {
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
  if (status === "completed") {
    return <StatusBadge status="valid" label="Completed" />;
  }
  if (status === "running") {
    return <StatusBadge status="pending" label="Running" />;
  }
  if (status === "persisting") {
    return <StatusBadge status="pending" label="Saving evidence" />;
  }
  return (
    <StatusBadge
      status="unavailable"
      label={status === "cancelled" ? "Cancelled" : "Failed"}
    />
  );
}

function RunRequestForm({
  capabilities,
  pending,
  onSubmit
}: {
  readonly capabilities: ControlApiPlaytestingCapabilitiesResponse;
  readonly pending: boolean;
  readonly onSubmit: (request: RunSubmission) => void;
}): React.JSX.Element {
  const assignments = capabilities.runnableAssignments;
  const firstAssignment = assignments[0]!;
  const [scenarioId, setScenarioId] = useState(firstAssignment.scenarioId);
  const assignmentsForScenario = assignments.filter(
    (assignment) => assignment.scenarioId === scenarioId
  );
  const [policyId, setPolicyId] = useState(assignmentsForScenario[0]!.policyId);
  const selectedAssignment = assignments.find(
    (assignment) =>
      assignment.scenarioId === scenarioId && assignment.policyId === policyId
  )!;
  const [seed, setSeed] = useState("seed-1");
  const [maxSteps, setMaxSteps] = useState(
    String(
      Math.min(
        selectedAssignment.maxStepsPerEpisode,
        capabilities.limits!.maxStepsPerEpisode
      )
    )
  );
  const scenarioIds = Array.from(
    new Set(assignments.map((assignment) => assignment.scenarioId)),
    (id) => (
      <option key={id} value={id}>
        {id}
      </option>
    )
  );

  function onScenarioChange(nextScenario: string): void {
    setScenarioId(nextScenario);
    const nextAssignment = assignments.find(
      (assignment) => assignment.scenarioId === nextScenario
    );
    if (!nextAssignment) return;
    setPolicyId(nextAssignment.policyId);
    setMaxSteps((current) => {
      const parsed = Number(current);
      const bounded =
        Number.isSafeInteger(parsed) && parsed > 0
          ? Math.min(parsed, nextAssignment.maxStepsPerEpisode)
          : nextAssignment.maxStepsPerEpisode;
      return String(bounded);
    });
  }

  function onPolicyChange(nextPolicy: string): void {
    setPolicyId(nextPolicy);
    const nextAssignment = assignments.find(
      (assignment) =>
        assignment.scenarioId === scenarioId &&
        assignment.policyId === nextPolicy
    );
    if (!nextAssignment) return;
    setMaxSteps((current) => {
      const parsed = Number(current);
      return String(
        Number.isSafeInteger(parsed) && parsed > 0
          ? Math.min(parsed, nextAssignment.maxStepsPerEpisode)
          : nextAssignment.maxStepsPerEpisode
      );
    });
  }

  function submit(event: React.FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    onSubmit({
      workspaceId: capabilities.workspaceId,
      scenario: scenarioId,
      policy: policyId,
      seed,
      maxSteps
    });
  }

  return (
    <form
      aria-label="Run one approved Playtesting episode"
      className="grid gap-3 md:grid-cols-2"
      onSubmit={submit}
    >
      <label className="flex flex-col gap-1 text-xs text-fg-muted">
        Scenario
        <select
          className={FIELD_CONTROL_CLASS}
          name="scenario"
          value={scenarioId}
          onChange={(event) => onScenarioChange(event.currentTarget.value)}
        >
          {scenarioIds}
        </select>
      </label>
      <label className="flex flex-col gap-1 text-xs text-fg-muted">
        Policy / cohort
        <select
          className={FIELD_CONTROL_CLASS}
          name="policy"
          value={policyId}
          onChange={(event) => onPolicyChange(event.currentTarget.value)}
        >
          {assignmentsForScenario.map((assignment) => (
            <option key={assignment.policyId} value={assignment.policyId}>
              {assignment.policyId +
                " · " +
                assignment.cohort +
                " · " +
                assignment.strategy}
            </option>
          ))}
        </select>
      </label>
      <label className="flex flex-col gap-1 text-xs text-fg-muted">
        Seed
        <input
          className={FIELD_CONTROL_CLASS}
          maxLength={256}
          name="seed"
          required
          value={seed}
          onChange={(event) => setSeed(event.currentTarget.value)}
        />
      </label>
      <label className="flex flex-col gap-1 text-xs text-fg-muted">
        Step budget
        <input
          className={FIELD_CONTROL_CLASS}
          max={selectedAssignment.maxStepsPerEpisode}
          min={1}
          name="maxSteps"
          type="number"
          value={maxSteps}
          onChange={(event) => setMaxSteps(event.currentTarget.value)}
        />
      </label>
      <div className="md:col-span-2">
        <p className={MUTED_META_CLASS}>
          Budget preview: 1 episode · {selectedAssignment.scenarioFamily} · at
          most {selectedAssignment.maxStepsPerEpisode} steps ·{" "}
          {capabilities.limits!.workerCount} concurrent worker(s) ·{" "}
          {capabilities.limits!.wallTimeMs} ms wall time · 0 critiques.
        </p>
        <p className={MUTED_META_CLASS}>
          Build {capabilities.buildSha} · {capabilities.gameBuild} · the Runtime
          rechecks exact approval before launch.
        </p>
      </div>
      <button
        className="min-h-11 rounded-md bg-accent px-4 py-2 text-sm font-semibold text-fg-inverse disabled:cursor-not-allowed disabled:opacity-60"
        data-playtesting-run-submit="true"
        disabled={pending || seed.trim().length === 0}
        type="submit"
      >
        {pending ? "Submitting…" : "Run one approved episode"}
      </button>
    </form>
  );
}

function setupMessage(
  setup: PlaytestingRunSetup,
  capabilities: ControlApiPlaytestingCapabilitiesResponse | null
): {
  readonly label: string;
  readonly message: string;
  readonly code?: string;
} | null {
  if (setup.kind === "unavailable") {
    return {
      label: "Run control unavailable",
      message: setup.message,
      code: setup.code
    };
  }
  if (!capabilities) {
    return {
      label: "Run setup unavailable",
      message: "Runtime capabilities were not observed."
    };
  }
  if (!capabilities.operatorActionsAvailable) {
    return {
      label: "Operator required",
      message:
        "An authorized operator can start or cancel runs. You can still inspect recorded results."
    };
  }
  if (!capabilities.approved) {
    return {
      label: "Approval required",
      message:
        "Workspaces must approve an exact build, adapter image, and command before any game process can run."
    };
  }
  if (!capabilities.workspaceEnabled) {
    return {
      label: "Workspace disabled",
      message: "The approved run cannot start while this workspace is disabled."
    };
  }
  if (capabilities.limits === null) {
    return {
      label: "Budget unavailable",
      message: "The active workspace approval has no readable resource budget."
    };
  }
  if (capabilities.configurationStatus !== "validated") {
    return {
      label: "Preflight required",
      message:
        "The checked-in target configuration must pass the Runtime's exact-build preflight before this run form is enabled."
    };
  }
  if (capabilities.runnableAssignments.length === 0) {
    return {
      label: "No runnable policy",
      message:
        "No approved policy is currently supported by the Runtime; unsupported approvals are not silently substituted."
    };
  }
  return null;
}

function RunStatusPanel({
  run,
  capabilities,
  scope,
  pending,
  onRefresh,
  onCancel
}: {
  readonly run: ControlApiPlaytestingRunRecord;
  readonly capabilities: ControlApiPlaytestingCapabilitiesResponse;
  readonly scope: PlaytestingScope;
  readonly pending: boolean;
  readonly onRefresh: () => void;
  readonly onCancel: () => void;
}): React.JSX.Element {
  const result = objectRecord(run.result);
  const episodeId = result?.episodeId;
  return (
    <section
      aria-label="Server-confirmed run status"
      className={NESTED_PANEL_CLASS}
    >
      <div className="flex flex-wrap items-center gap-2">
        <strong className="font-mono">{run.batchId}</strong>
        {batchStatusBadge(run.status)}
      </div>
      {run.error ? (
        <p className={MUTED_BODY_CLASS}>{run.error.message}</p>
      ) : typeof episodeId === "string" ? (
        <NavigationLink
          className="text-sm text-accent hover:underline"
          href={playtestingEpisodeHref(scope, episodeId, 0)}
        >
          Open episode {episodeId}
        </NavigationLink>
      ) : (
        <p className={MUTED_META_CLASS}>No episode result is recorded yet.</p>
      )}
      <div className="mt-3 flex flex-wrap gap-2">
        <button
          className="min-h-10 rounded-md border border-border px-3 py-2 text-sm disabled:opacity-60"
          disabled={pending}
          onClick={onRefresh}
          type="button"
        >
          Refresh server status
        </button>
        {capabilities.operatorActionsAvailable &&
        (run.status === "running" || run.status === "persisting") ? (
          <button
            className="min-h-10 rounded-md border border-warning/50 px-3 py-2 text-sm disabled:opacity-60"
            disabled={pending}
            onClick={onCancel}
            type="button"
          >
            Request cancellation
          </button>
        ) : null}
      </div>
    </section>
  );
}

function RunStatusMessage({
  notice,
  failure
}: {
  readonly notice: string | null;
  readonly failure: string | null;
}): React.JSX.Element | null {
  if (failure) {
    return (
      <p className="text-sm text-error" role="alert">
        {failure}
      </p>
    );
  }
  if (notice) {
    return (
      <p className={MUTED_META_CLASS} role="status">
        {notice}
      </p>
    );
  }
  return null;
}

export function PlaytestingRunControls({
  setup,
  scope
}: {
  readonly setup: PlaytestingRunSetup;
  readonly scope: PlaytestingScope;
}): React.JSX.Element {
  const capabilities = setup.kind === "available" ? setup.capabilities : null;
  const [pending, setPending] = useState(false);
  const [run, setRun] = useState<ControlApiPlaytestingRunRecord | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const noticeNode = RunStatusMessage({ notice, failure });
  const unavailable = setupMessage(setup, capabilities);

  async function startRun(request: RunSubmission): Promise<void> {
    if (!capabilities) return;
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
          workspaceId: request.workspaceId,
          scenario: request.scenario,
          policy: request.policy,
          seed: request.seed,
          maxSteps: request.maxSteps
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
        "/api/playtesting/runs/" +
          encodeURIComponent(run.batchId) +
          "?" +
          query,
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
    if (!globalThis.confirm("Request cancellation of " + run.batchId + "?"))
      return;
    setPending(true);
    setFailure(null);
    setNotice(null);
    try {
      const response = await fetch(
        "/api/playtesting/runs/" + encodeURIComponent(run.batchId) + "/cancel",
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

  return (
    <section
      aria-labelledby="playtesting-run-controls-heading"
      className={LIST_PANEL_CLASS}
      data-run-setup={setup.kind}
    >
      <h2
        className={SECTION_HEADING_CLASS}
        id="playtesting-run-controls-heading"
      >
        Run an approved episode
      </h2>
      <p className={MUTED_BODY_CLASS}>
        Run requests contain only typed scenario, policy, seed, and step-budget
        fields. Workspaces owns exact-build approval; the Runtime confirms
        status and cancellation.
      </p>
      {unavailable ? (
        <div className="flex flex-col gap-2">
          <StatusBadge
            status={
              unavailable.label === "Approval required" ||
              unavailable.label === "Operator required"
                ? NOT_OBSERVED_STATUS
                : "unavailable"
            }
            label={unavailable.label}
          />
          <p className={MUTED_BODY_CLASS}>{unavailable.message}</p>
          {unavailable.code ? (
            <p className={MUTED_META_CLASS}>{unavailable.code}</p>
          ) : null}
        </div>
      ) : capabilities ? (
        <RunRequestForm
          capabilities={capabilities}
          pending={pending}
          onSubmit={(request) => void startRun(request)}
        />
      ) : null}
      {run && capabilities ? (
        <RunStatusPanel
          run={run}
          capabilities={capabilities}
          scope={scope}
          pending={pending}
          onRefresh={() => void refreshStatus()}
          onCancel={() => void cancelRun()}
        />
      ) : null}
      {noticeNode}
    </section>
  );
}
