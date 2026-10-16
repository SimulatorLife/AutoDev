"use client";

import type {
  ControlApiPlaytestingCapabilitiesResponse,
  ControlApiPlaytestingRunRecord,
  ControlApiPlaytestingRunStartedResponse,
  PlaytestJsonValue
} from "@simulatorlife/autodev-core";
import React, { useRef, useState } from "react";

import { SECTION_HEADING_CLASS } from "../../components/layout/Heading.ts";
import {
  LIST_PANEL_CLASS,
  NESTED_PANEL_CLASS
} from "../../components/layout/Panel.ts";
import {
  NOT_OBSERVED_STATUS,
  StatusBadge
} from "../../components/status/StatusBadge.ts";
import { FIELD_CONTROL_CLASS } from "../../components/ui/field-classes.ts";
import {
  MUTED_BODY_CLASS,
  MUTED_META_CLASS
} from "../../components/ui/text-classes.ts";
import { assignmentOutcomes } from "./playtesting-active-runs.ts";
import {
  CANCELLATION_REASON_LABELS,
  responseMessage
} from "./playtesting-run-messages.ts";
import { batchStatusBadge } from "./playtesting-run-presentation.ts";
import {
  initialPlaytestingSeed,
  isAdmissiblePlaytestingSeed,
  nextPlaytestingSeed
} from "./playtesting-run-seeds.ts";
import type { PlaytestingScope } from "./playtesting-url.ts";
import { PlaytestingAssignmentResults } from "./PlaytestingAssignmentResults.ts";

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

/** One editable, ordered set submitted through the canonical batch API. */
interface RunSubmission {
  readonly workspaceId: string;
  readonly assignments: readonly {
    readonly scenario: string;
    readonly policy: string;
    readonly seed: string;
    readonly maxSteps: number;
  }[];
}

function objectRecord(
  value: PlaytestJsonValue | null
): Readonly<Record<string, PlaytestJsonValue>> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  return value as Readonly<Record<string, PlaytestJsonValue>>;
}

interface RunAssignmentDraft {
  readonly id: number;
  readonly scenarioId: string;
  readonly policyId: string;
  readonly seed: string;
  readonly maxSteps: string;
}

function stepsFor(
  capabilities: ControlApiPlaytestingCapabilitiesResponse,
  scenarioId: string,
  policyId: string
): number {
  return (
    capabilities.runnableAssignments.find(
      (assignment) =>
        assignment.scenarioId === scenarioId && assignment.policyId === policyId
    )?.maxStepsPerEpisode ?? 1
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
  const runnableAssignments = capabilities.runnableAssignments;
  const admissibleSeeds = capabilities.admissibleSeeds;
  const first = runnableAssignments[0]!;
  const maxAssignments = capabilities.maxBatchAssignments;
  const nextId = useRef(2);
  const [assignments, setAssignments] = useState<readonly RunAssignmentDraft[]>(
    [
      {
        id: 1,
        scenarioId: first.scenarioId,
        policyId: first.policyId,
        seed: initialPlaytestingSeed(admissibleSeeds),
        maxSteps: String(first.maxStepsPerEpisode)
      }
    ]
  );
  const [seedPrefix, setSeedPrefix] = useState("seed");
  const [additionalAssignments, setAdditionalAssignments] = useState("1");
  const [showAllAssignments, setShowAllAssignments] = useState(false);
  const duplicateCells = new Set<string>();
  const seenCells = new Set<string>();
  for (const assignment of assignments) {
    const key = JSON.stringify([
      assignment.scenarioId,
      assignment.policyId,
      assignment.seed.trim()
    ]);
    if (seenCells.has(key)) duplicateCells.add(key);
    seenCells.add(key);
  }
  const valid =
    assignments.length > 0 &&
    assignments.length <= maxAssignments &&
    assignments.every((assignment) => {
      const maximumSteps = stepsFor(
        capabilities,
        assignment.scenarioId,
        assignment.policyId
      );
      const steps = Number(assignment.maxSteps);
      return (
        isAdmissiblePlaytestingSeed(admissibleSeeds, assignment.seed) &&
        !duplicateCells.has(
          JSON.stringify([
            assignment.scenarioId,
            assignment.policyId,
            assignment.seed.trim()
          ])
        ) &&
        Number.isSafeInteger(steps) &&
        steps >= 1 &&
        steps <= maximumSteps
      );
    });
  const additionalCount = Number(additionalAssignments);
  const remainingBatchCapacity = maxAssignments - assignments.length;
  const canGenerateAssignments =
    Number.isSafeInteger(additionalCount) &&
    additionalCount > 0 &&
    additionalCount <= remainingBatchCapacity &&
    seedPrefix.trim().length > 0;
  const displayedAssignments =
    assignments.length <= 10 || showAllAssignments
      ? assignments
      : assignments.slice(0, 10);

  function updateAssignment(
    id: number,
    update: (assignment: RunAssignmentDraft) => RunAssignmentDraft
  ): void {
    setAssignments((current) =>
      current.map((assignment) =>
        assignment.id === id ? update(assignment) : assignment
      )
    );
  }

  function changeScenario(id: number, scenarioId: string): void {
    const policy = runnableAssignments.find(
      (assignment) => assignment.scenarioId === scenarioId
    );
    if (!policy) return;
    updateAssignment(id, (assignment) => ({
      ...assignment,
      scenarioId,
      policyId: policy.policyId,
      maxSteps: String(
        Math.min(
          Number(assignment.maxSteps) || policy.maxStepsPerEpisode,
          policy.maxStepsPerEpisode
        )
      )
    }));
  }

  function changePolicy(id: number, policyId: string): void {
    updateAssignment(id, (assignment) => {
      const maxSteps = stepsFor(capabilities, assignment.scenarioId, policyId);
      return {
        ...assignment,
        policyId,
        maxSteps: String(
          Math.min(Number(assignment.maxSteps) || maxSteps, maxSteps)
        )
      };
    });
  }

  const addableSeed = nextPlaytestingSeed(
    admissibleSeeds,
    assignments,
    assignments[0]!.scenarioId,
    assignments[0]!.policyId
  );

  function addAssignment(): void {
    if (assignments.length >= maxAssignments || addableSeed === null) return;
    const template = assignments[0]!;
    const id = nextId.current++;
    setAssignments((current) => [
      ...current,
      {
        id,
        scenarioId: template.scenarioId,
        policyId: template.policyId,
        seed: addableSeed,
        maxSteps: template.maxSteps
      }
    ]);
  }

  function generateAssignments(): void {
    if (!canGenerateAssignments) return;
    const template = assignments[0]!;
    const seeds = new Set(
      assignments
        .filter(
          (assignment) =>
            assignment.scenarioId === template.scenarioId &&
            assignment.policyId === template.policyId
        )
        .map((assignment) => assignment.seed.trim())
    );
    const prefix = seedPrefix.trim();
    let sequence = assignments.length + 1;
    const generated: RunAssignmentDraft[] = [];
    while (generated.length < additionalCount) {
      const seed = prefix + "-" + String(sequence++);
      if (seeds.has(seed)) continue;
      seeds.add(seed);
      generated.push({
        id: nextId.current++,
        scenarioId: template.scenarioId,
        policyId: template.policyId,
        seed,
        maxSteps: template.maxSteps
      });
    }
    setAssignments((current) => [...current, ...generated]);
  }

  function submit(event: React.FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    if (!valid) return;
    onSubmit({
      workspaceId: capabilities.workspaceId,
      assignments: assignments.map((assignment) => ({
        scenario: assignment.scenarioId,
        policy: assignment.policyId,
        seed: assignment.seed.trim(),
        maxSteps: Number(assignment.maxSteps)
      }))
    });
  }

  return (
    <form
      aria-label="Run an approved Playtesting batch"
      className="grid gap-3"
      onSubmit={submit}
    >
      {admissibleSeeds === null ? (
        <fieldset className={`${NESTED_PANEL_CLASS} grid gap-3 md:grid-cols-3`}>
          <legend className="px-1 text-sm font-semibold">
            Generate seed variations
          </legend>
          <label className="flex flex-col gap-1 text-xs text-fg-muted">
            Seed prefix
            <input
              className={FIELD_CONTROL_CLASS}
              disabled={pending}
              maxLength={256}
              value={seedPrefix}
              onChange={(event) => setSeedPrefix(event.currentTarget.value)}
            />
          </label>
          <label className="flex flex-col gap-1 text-xs text-fg-muted">
            Additional assignments
            <input
              className={FIELD_CONTROL_CLASS}
              disabled={pending || remainingBatchCapacity < 1}
              max={remainingBatchCapacity}
              min={1}
              type="number"
              value={additionalAssignments}
              onChange={(event) =>
                setAdditionalAssignments(event.currentTarget.value)
              }
            />
          </label>
          <button
            className="min-h-10 justify-self-start rounded-md border border-border px-3 py-2 text-sm disabled:opacity-60"
            disabled={pending || !canGenerateAssignments}
            onClick={generateAssignments}
            type="button"
          >
            Generate assignments
          </button>
          <p className={`${MUTED_META_CLASS} md:col-span-3`}>
            Generated rows copy the first assignment&apos;s scenario, policy and
            step budget, using distinct prefix-number seeds.
          </p>
        </fieldset>
      ) : (
        <p className={MUTED_META_CLASS}>
          Seeds come from the latest build&apos;s frozen benchmark inventory:{" "}
          {admissibleSeeds
            .map((entry) => entry.seed + " (" + entry.purpose + ")")
            .join(", ")}
          . Each scenario/policy cell can use each seed once per batch.
        </p>
      )}
      <ol aria-label="Batch assignments" className="grid gap-3">
        {displayedAssignments.map((assignment, index) => {
          const row = index + 1;
          const optionsForScenario = runnableAssignments.filter(
            (candidate) => candidate.scenarioId === assignment.scenarioId
          );
          const selected = runnableAssignments.find(
            (candidate) =>
              candidate.scenarioId === assignment.scenarioId &&
              candidate.policyId === assignment.policyId
          )!;
          const duplicate = duplicateCells.has(
            JSON.stringify([
              assignment.scenarioId,
              assignment.policyId,
              assignment.seed.trim()
            ])
          );
          return (
            <li key={assignment.id}>
              <fieldset
                className={`${NESTED_PANEL_CLASS} grid gap-3 md:grid-cols-2`}
              >
                <legend className="px-1 text-sm font-semibold">
                  Assignment {row}
                </legend>
                <label className="flex flex-col gap-1 text-xs text-fg-muted">
                  Scenario {row}
                  <select
                    className={FIELD_CONTROL_CLASS}
                    disabled={pending}
                    name={`scenario-${row}`}
                    value={assignment.scenarioId}
                    onChange={(event) =>
                      changeScenario(assignment.id, event.currentTarget.value)
                    }
                  >
                    {Array.from(
                      new Set(
                        runnableAssignments.map((item) => item.scenarioId)
                      ),
                      (scenarioId) => (
                        <option key={scenarioId} value={scenarioId}>
                          {scenarioId}
                        </option>
                      )
                    )}
                  </select>
                </label>
                <label className="flex flex-col gap-1 text-xs text-fg-muted">
                  Policy / cohort {row}
                  <select
                    className={FIELD_CONTROL_CLASS}
                    disabled={pending}
                    name={`policy-${row}`}
                    value={assignment.policyId}
                    onChange={(event) =>
                      changePolicy(assignment.id, event.currentTarget.value)
                    }
                  >
                    {optionsForScenario.map((option) => (
                      <option key={option.policyId} value={option.policyId}>
                        {option.policyId +
                          " · " +
                          option.cohort +
                          " · " +
                          option.strategy}
                      </option>
                    ))}
                  </select>
                </label>
                <p className={`${MUTED_META_CLASS} md:col-span-2`}>
                  Family {selected.scenarioFamily} · policy version{" "}
                  {selected.policyVersion} · maximum{" "}
                  {selected.maxStepsPerEpisode} steps for this approved cell.
                </p>
                <label className="flex flex-col gap-1 text-xs text-fg-muted">
                  Seed {row}
                  {admissibleSeeds === null ? (
                    <input
                      className={FIELD_CONTROL_CLASS}
                      disabled={pending}
                      maxLength={256}
                      name={`seed-${row}`}
                      required
                      value={assignment.seed}
                      onChange={(event) => {
                        const seed = event.currentTarget.value;
                        updateAssignment(assignment.id, (current) => ({
                          ...current,
                          seed
                        }));
                      }}
                    />
                  ) : (
                    <select
                      className={FIELD_CONTROL_CLASS}
                      disabled={pending}
                      name={`seed-${row}`}
                      required
                      value={assignment.seed}
                      onChange={(event) => {
                        const seed = event.currentTarget.value;
                        updateAssignment(assignment.id, (current) => ({
                          ...current,
                          seed
                        }));
                      }}
                    >
                      {admissibleSeeds.map((entry) => (
                        <option key={entry.seed} value={entry.seed}>
                          {entry.seed + " · " + entry.purpose}
                        </option>
                      ))}
                    </select>
                  )}
                </label>
                <label className="flex flex-col gap-1 text-xs text-fg-muted">
                  Step budget {row}
                  <input
                    className={FIELD_CONTROL_CLASS}
                    disabled={pending}
                    max={selected.maxStepsPerEpisode}
                    min={1}
                    name={`maxSteps-${row}`}
                    type="number"
                    value={assignment.maxSteps}
                    onChange={(event) => {
                      const maxSteps = event.currentTarget.value;
                      updateAssignment(assignment.id, (current) => ({
                        ...current,
                        maxSteps
                      }));
                    }}
                  />
                </label>
                {duplicate ? (
                  <p className="text-sm text-error" role="alert">
                    Scenario, policy, and seed must identify a unique
                    assignment.
                  </p>
                ) : null}
                <button
                  className="min-h-10 justify-self-start rounded-md border border-border px-3 py-2 text-sm disabled:opacity-60"
                  disabled={pending || assignments.length === 1}
                  onClick={() =>
                    setAssignments((current) =>
                      current.filter((entry) => entry.id !== assignment.id)
                    )
                  }
                  type="button"
                >
                  Remove assignment {row}
                </button>
              </fieldset>
            </li>
          );
        })}
      </ol>
      {assignments.length > displayedAssignments.length ? (
        <button
          className="min-h-10 justify-self-start rounded-md border border-border px-3 py-2 text-sm"
          onClick={() => setShowAllAssignments(true)}
          type="button"
        >
          Show {assignments.length - displayedAssignments.length} more
          assignments
        </button>
      ) : null}
      {showAllAssignments && assignments.length > 10 ? (
        <button
          className="min-h-10 justify-self-start rounded-md border border-border px-3 py-2 text-sm"
          onClick={() => setShowAllAssignments(false)}
          type="button"
        >
          Collapse to first 10 assignments
        </button>
      ) : null}
      <button
        className="min-h-10 justify-self-start rounded-md border border-border px-3 py-2 text-sm disabled:opacity-60"
        disabled={
          pending ||
          assignments.length >= maxAssignments ||
          addableSeed === null
        }
        onClick={addAssignment}
        type="button"
      >
        Add assignment
      </button>
      <div>
        <p className={MUTED_META_CLASS}>
          Batch budget preview: {assignments.length} of {maxAssignments}{" "}
          per-batch episode assignments · {capabilities.limits!.workerCount}{" "}
          concurrent worker(s) · {capabilities.limits!.wallTimeMs} ms wall time
          · at most {capabilities.limits!.critiqueCount} critiques.
        </p>
        <p className={MUTED_META_CLASS}>
          Runtime also checks the remaining approved build budget before any
          sandbox launches.
        </p>
        <p className={MUTED_META_CLASS}>
          Critiques are not invoked by starting a batch; any later reviews
          remain bounded by the frozen selection and approved critique cap.
        </p>
        <p className={MUTED_META_CLASS}>
          Latest committed build {capabilities.buildSha} · the Runtime resolves
          the checkout&apos;s latest commit again when the batch starts and runs
          that exact snapshot; uncommitted edits are never run.
        </p>
      </div>
      <button
        className="min-h-11 rounded-md bg-accent px-4 py-2 text-sm font-semibold text-fg-inverse disabled:cursor-not-allowed disabled:opacity-60"
        data-playtesting-run-submit="true"
        disabled={pending || !valid}
        type="submit"
      >
        {pending
          ? "Submitting…"
          : `Run ${assignments.length} approved assignment${assignments.length === 1 ? "" : "s"}`}
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
        "Workspaces must approve the checkout, adapter image, and command before any game process can run."
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
  if (capabilities.maxBatchAssignments < 1) {
    return {
      label: "Batch budget unavailable",
      message:
        "The checked-in target budget does not permit an approved batch assignment."
    };
  }
  if (capabilities.configurationStatus !== "validated") {
    return {
      label: "Preflight required",
      message:
        "The latest commit's target configuration must pass the Runtime's preflight before this run form is enabled."
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
  const counts = objectRecord(result?.counts ?? null);
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
      ) : null}
      {run.cancellationReason ? (
        <p className={MUTED_META_CLASS}>
          Cancellation: {CANCELLATION_REASON_LABELS[run.cancellationReason]}.
        </p>
      ) : null}
      {counts && Number.isSafeInteger(counts.assigned) ? (
        <p className={MUTED_META_CLASS}>
          Progress: {String(counts.completed ?? 0)} completed ·{" "}
          {String(counts.crashed ?? 0)} crashed ·{" "}
          {String(counts.budgetTruncated ?? 0)} budget-truncated ·{" "}
          {String(counts.infrastructureFailed ?? 0)} infrastructure failures ·{" "}
          {String(counts.cancelled ?? 0)} cancelled of {String(counts.assigned)}{" "}
          assigned.
        </p>
      ) : null}
      <PlaytestingAssignmentResults
        outcomes={assignmentOutcomes(run)}
        scope={scope}
        pending={run.result === null}
      />
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
  scope,
  onRunStarted,
  liveRecords,
  onRefreshStatus
}: {
  readonly setup: PlaytestingRunSetup;
  readonly scope: PlaytestingScope;
  readonly onRunStarted: (
    started: ControlApiPlaytestingRunStartedResponse
  ) => void;
  /** Server-read records from the dashboard's single live status owner. */
  readonly liveRecords: ReadonlyMap<string, ControlApiPlaytestingRunRecord>;
  /** Asks that owner for an immediate server read. */
  readonly onRefreshStatus: () => void;
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
      const form = new URLSearchParams({
        workspaceId: request.workspaceId,
        assignments: JSON.stringify(request.assignments)
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
        envelope.data.workspaceId !== capabilities.workspaceId ||
        typeof envelope.data.batchId !== "string" ||
        !Number.isSafeInteger(envelope.data.assignmentCount) ||
        envelope.data.assignmentCount < 1 ||
        typeof envelope.data.createdAt !== "string" ||
        !Number.isFinite(Date.parse(envelope.data.createdAt)) ||
        envelope.data.status !== "running"
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
      onRunStarted(envelope.data);
      setNotice(
        "The Runtime confirmed an approved batch of " +
          String(envelope.data.assignmentCount) +
          (envelope.data.assignmentCount === 1
            ? " assignment."
            : " assignments.")
      );
    } catch {
      setFailure(
        "The same-origin run request could not reach the Console server."
      );
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
      onRefreshStatus();
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
        Run an approved batch
      </h2>
      <p className={MUTED_BODY_CLASS}>
        Batch requests contain an ordered list of typed scenario, policy, seed,
        and step-budget assignments. Workspaces owns checkout approval; the
        Runtime confirms assignment outcomes, status, and cancellation.
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
          run={liveRecords.get(run.batchId) ?? run}
          capabilities={capabilities}
          scope={scope}
          pending={pending}
          onRefresh={onRefreshStatus}
          onCancel={() => void cancelRun()}
        />
      ) : null}
      {noticeNode}
    </section>
  );
}
