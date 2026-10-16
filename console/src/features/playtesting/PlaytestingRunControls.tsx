"use client";

import type {
  ControlApiPlaytestingCapabilitiesResponse,
  ControlApiPlaytestingRunStartedResponse
} from "@simulatorlife/autodev-core";
import React, { useRef, useState } from "react";

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
import { responseMessage } from "./playtesting-run-messages.ts";
import {
  initialPlaytestingSeed,
  isAdmissiblePlaytestingSeed,
  nextPlaytestingSeed
} from "./playtesting-run-seeds.ts";

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
  const defaultAssignment = assignments[0]!;
  const defaultPolicy = runnableAssignments.find(
    (candidate) =>
      candidate.scenarioId === defaultAssignment.scenarioId &&
      candidate.policyId === defaultAssignment.policyId
  )!;
  const defaultSeedPurpose = admissibleSeeds?.find(
    (entry) => entry.seed === defaultAssignment.seed
  )?.purpose;

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
      aria-label="Start a playtest"
      className="grid gap-4"
      onSubmit={submit}
    >
      <div
        className="grid gap-3 rounded-lg border border-border bg-surface-raised p-4 sm:grid-cols-2"
        aria-label="Suggested playtest configuration"
      >
        <div>
          <p className={MUTED_META_CLASS}>Suggested scenario</p>
          <p className="mt-1 font-medium">{defaultAssignment.scenarioId}</p>
        </div>
        <div>
          <p className={MUTED_META_CLASS}>Policy / cohort</p>
          <p className="mt-1 font-medium">
            {defaultPolicy.policyId} · {defaultPolicy.cohort}
          </p>
        </div>
        <div>
          <p className={MUTED_META_CLASS}>Seed</p>
          <p className="mt-1 font-medium">
            {defaultAssignment.seed}
            {defaultSeedPurpose ? ` · ${defaultSeedPurpose}` : ""}
          </p>
        </div>
        <div>
          <p className={MUTED_META_CLASS}>Step cap</p>
          <p className="mt-1 font-medium">
            {defaultAssignment.maxSteps} of {defaultPolicy.maxStepsPerEpisode}
          </p>
        </div>
      </div>
      <p className={MUTED_META_CLASS}>
        This starts one session. The build shown above was observed when this
        page loaded; Runtime re-resolves the latest committed HEAD at start and
        records the exact commit in the result.
      </p>
      <button
        className="min-h-12 w-full rounded-md bg-accent px-4 py-3 text-base font-semibold text-fg-inverse disabled:cursor-not-allowed disabled:opacity-60 sm:w-auto"
        data-playtesting-run-submit="true"
        disabled={pending || !valid}
        type="submit"
      >
        {pending
          ? "Starting playtest…"
          : assignments.length === 1
            ? "Start playtest"
            : `Start ${String(assignments.length)} playtests`}
      </button>
      <details className="rounded-lg border border-border bg-surface p-4">
        <summary className="cursor-pointer text-sm font-medium">
          Customize run
          <span className={`ml-2 ${MUTED_META_CLASS}`}>
            Scenario, policy, seed, step cap, and batch size
          </span>
        </summary>
        <div className="mt-4 grid gap-4">
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
                Generated rows copy the first assignment&apos;s scenario, policy
                and step cap, using distinct prefix-number seeds.
              </p>
            </fieldset>
          ) : (
            <p className={MUTED_META_CLASS}>
              Available seeds: {admissibleSeeds
                .map((entry) => `${entry.seed} (${entry.purpose})`)
                .join(", ")}
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
                      Session {row}
                    </legend>
                    <label className="flex flex-col gap-1 text-xs text-fg-muted">
                      Scenario
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
                      Policy and cohort
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
                            {option.policyId} · {option.cohort} · {option.strategy}
                          </option>
                        ))}
                      </select>
                    </label>
                    <p className={`${MUTED_META_CLASS} md:col-span-2`}>
                      Family {selected.scenarioFamily} · policy version{" "}
                      {selected.policyVersion} · maximum{" "}
                      {selected.maxStepsPerEpisode} steps for this workspace.
                    </p>
                    <label className="flex flex-col gap-1 text-xs text-fg-muted">
                      Seed
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
                              {entry.seed} · {entry.purpose}
                            </option>
                          ))}
                        </select>
                      )}
                    </label>
                    <label className="flex flex-col gap-1 text-xs text-fg-muted">
                      Step cap
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
                        session in this batch.
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
                      Remove session {row}
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
              {`Show ${String(assignments.length - displayedAssignments.length)} more sessions`}
            </button>
          ) : null}
          {showAllAssignments && assignments.length > 10 ? (
            <button
              className="min-h-10 justify-self-start rounded-md border border-border px-3 py-2 text-sm"
              onClick={() => setShowAllAssignments(false)}
              type="button"
            >
              Show the first 10 sessions
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
            Add session
          </button>
          <details className="rounded-md border border-border p-3">
            <summary className="cursor-pointer text-sm font-medium">
              Batch, time, and analysis limits
            </summary>
            <div className="mt-3 grid gap-2">
              <p className={MUTED_META_CLASS}>
                {assignments.length} of {maxAssignments} sessions ·{" "}
                {capabilities.limits!.workerCount} concurrent worker(s) ·{" "}
                {String(capabilities.limits!.wallTimeMs / 1000)} seconds maximum ·{" "}
                {capabilities.limits!.critiqueCount} later critiques maximum.
              </p>
              <p className={MUTED_META_CLASS}>
                Runtime checks the remaining approved workspace budget before
                launching a sandbox. Starting a playtest does not run an
                analyst review.
              </p>
              <p className={MUTED_META_CLASS}>
                The exact commit for each run is recorded in its results. New
                commits in this approved checkout do not require another
                approval; uncommitted edits are not run.
              </p>
            </div>
          </details>
        </div>
      </details>
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

function RunStatusMessage({
  notice,
  failure
}: {
  readonly notice: string | null;
  readonly failure: string | null;
}): React.JSX.Element | null {
  if (failure) {
    return React.createElement(
      "p",
      { className: "text-sm text-error", role: "alert" },
      failure
    );
  }
  if (notice) {
    return React.createElement(
      "p",
      { className: MUTED_META_CLASS, role: "status" },
      notice
    );
  }
  return null;
}

export function PlaytestingRunControls({
  setup,
  onRunStarted
}: {
  readonly setup: PlaytestingRunSetup;
  readonly onRunStarted: (
    started: ControlApiPlaytestingRunStartedResponse
  ) => void;
}): React.JSX.Element {
  const capabilities = setup.kind === "available" ? setup.capabilities : null;
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const noticeNode = RunStatusMessage({ notice, failure });
  const unavailable = setupMessage(setup, capabilities);
  const buildSha = capabilities?.buildSha ?? null;

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
      onRunStarted(envelope.data);
      setNotice(
        "Run accepted. Live status below is read from Runtime; the exact build SHA is recorded in the result."
      );
    } catch {
      setFailure(
        "The same-origin run request could not reach the Console server."
      );
    } finally {
      setPending(false);
    }
  }

  return React.createElement(
    "section",
    {
      "aria-labelledby": "playtesting-run-controls-heading",
      className: LIST_PANEL_CLASS,
      "data-run-setup": setup.kind
    },
    React.createElement(
      "div",
      { className: "flex flex-wrap items-start justify-between gap-3" },
      React.createElement(
        "div",
        null,
        React.createElement(
          "h2",
          {
            className: "text-base font-semibold tracking-tight",
            id: "playtesting-run-controls-heading"
          },
          "Start a playtest"
        ),
        React.createElement(
          "p",
          { className: MUTED_BODY_CLASS },
          "Start with the suggested single-session settings, or customize the run if you need a different test."
        )
      ),
      capabilities?.approved
        ? React.createElement(StatusBadge, {
            status: "ready",
            label: "Workspace approved"
          })
        : null
    ),
    capabilities
      ? React.createElement(
          "div",
          {
            className: "mt-4 flex flex-wrap items-center gap-3 rounded-md border border-border bg-surface-raised px-3 py-2",
            "data-testid": "playtesting-build-context"
          },
          React.createElement(
            "span",
            { className: MUTED_META_CLASS },
            "Build observed at page load"
          ),
          buildSha
            ? React.createElement(
                "code",
                {
                  className: "font-mono text-sm",
                  title: buildSha,
                  "data-build-sha": buildSha
                },
                buildSha.slice(0, 12)
              )
            : React.createElement(
                StatusBadge,
                { status: "unavailable", label: "Not observed" }
              ),
          React.createElement(
            "p",
            { className: `min-w-0 flex-1 ${MUTED_META_CLASS}` },
            "Approval is for this checkout. Runtime automatically uses its latest committed HEAD when the run starts; new commits do not need separate approval. Uncommitted edits are excluded."
          )
        )
      : null,
    unavailable
      ? React.createElement(
          "div",
          { className: "mt-4 flex flex-col gap-2 rounded-md border border-warning/40 bg-surface-raised p-4", "data-testid": "playtesting-run-blocked" },
          React.createElement(StatusBadge, {
            status:
              unavailable.label === "Approval required" ||
              unavailable.label === "Operator required"
                ? NOT_OBSERVED_STATUS
                : "unavailable",
            label: unavailable.label
          }),
          React.createElement("p", { className: MUTED_BODY_CLASS }, unavailable.message),
          unavailable.code
            ? React.createElement("code", { className: MUTED_META_CLASS }, unavailable.code)
            : null
        )
      : capabilities
        ? React.createElement(RunRequestForm, {
            capabilities,
            pending,
            onSubmit: (request) => void startRun(request)
          })
        : null,
    noticeNode
  );
}
