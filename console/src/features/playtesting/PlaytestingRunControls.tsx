"use client";

import {
  type ControlApiPlaytestingCapabilitiesResponse,
  type ControlApiPlaytestingRunRequestLookupResponse,
  type ControlApiPlaytestingRunStartedResponse,
  isControlApiPlaytestingRunState,
  PLAYTEST_LAUNCH_REQUEST_SCHEMA,
  type PlaytestLaunchRequest
} from "@simulatorlife/autodev-core";
import { useRouter } from "next/navigation";
import React, { useEffect, useRef, useState } from "react";

import { Button } from "../../components/forms/Button.ts";
import { NESTED_PANEL_CLASS } from "../../components/layout/Panel.ts";
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
  const buildSha = capabilities.buildSha;
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
      aria-label="Start an adapter-accelerated playtest"
      className="grid gap-4"
      onSubmit={submit}
    >
      <div
        className="grid gap-1 rounded-lg border border-border bg-surface-raised px-4 py-3"
        aria-label="Suggested playtest configuration"
      >
        <p className={MUTED_META_CLASS}>Suggested run · 1 session</p>
        <p className="break-words text-sm font-medium">
          {defaultAssignment.scenarioId} · {defaultPolicy.policyId} (
          {defaultPolicy.cohort}) · seed {defaultAssignment.seed}
          {defaultSeedPurpose && defaultSeedPurpose !== defaultAssignment.seed
            ? " (" + defaultSeedPurpose + ")"
            : ""}{" "}
          · up to {defaultAssignment.maxSteps} steps
        </p>
      </div>
      <p className={MUTED_META_CLASS} data-testid="playtesting-build-context">
        {buildSha
          ? "Build observed at preflight: " + buildSha.slice(0, 12) + ". "
          : "Build not observed. "}
        Runtime resolves the latest committed HEAD at start; new commits do not
        need separate approval; uncommitted edits are excluded.
      </p>
      <div className="grid gap-2">
        <label className="text-xs font-semibold uppercase tracking-wider text-fg-muted">
          1. Choose Playtest Objective
        </label>
        <div className="grid gap-2 sm:grid-cols-3">
          {[
            {
              id: "championship",
              title: "Championship Tournament",
              icon: "🏆",
              description: "Full multi-race championship run with wagering, dynamic track conditions, and race standings.",
              steps: Math.min(2500, first.maxStepsPerEpisode)
            },
            {
              id: "smoke",
              title: "Quick Smoke Check",
              icon: "⚡",
              description: "Fast 100-step smoke check verifying vehicle physics, rule engine, and simulation stability.",
              steps: Math.min(100, first.maxStepsPerEpisode)
            },
            {
              id: "handling",
              title: "Speed & Wall Recovery",
              icon: "⏱️",
              description: "1,000-step stress test evaluating cornering precision, wall collision, and bounce-back behavior.",
              steps: Math.min(1000, first.maxStepsPerEpisode)
            }
          ].map((preset) => {
            const isSelected = Number(defaultAssignment.maxSteps) === preset.steps;
            return (
              <button
                key={preset.id}
                type="button"
                onClick={() => {
                  updateAssignment(defaultAssignment.id, (a) => ({
                    ...a,
                    maxSteps: String(preset.steps)
                  }));
                }}
                className={"flex flex-col items-start gap-1 rounded-xl border p-3.5 text-left transition " + (
                  isSelected
                    ? "border-accent bg-accent/10 shadow-sm ring-1 ring-accent"
                    : "border-border bg-surface-raised hover:border-fg-muted/40 hover:bg-surface"
                )}
              >
                <span className="text-sm font-semibold text-fg">{preset.icon} {preset.title}</span>
                <span className="text-xs text-fg-secondary leading-relaxed">{preset.description}</span>
                <span className="mt-1 text-xs font-medium text-accent">
                  Up to {preset.steps.toLocaleString()} steps
                </span>
              </button>
            );
          })}
        </div>
      </div>

      <div className="grid gap-2">
        <label className="text-xs font-semibold uppercase tracking-wider text-fg-muted">
          2. Player Strategy & Persona
        </label>
        <div className="grid gap-2 sm:grid-cols-2">
          <button
            type="button"
            onClick={() => {
              updateAssignment(defaultAssignment.id, (a) => ({
                ...a,
                policyId: "random"
              }));
            }}
            className={"flex items-start gap-3 rounded-xl border p-3 text-left transition " + (
              defaultAssignment.policyId === "random"
                ? "border-accent bg-accent/10 ring-1 ring-accent"
                : "border-border bg-surface-raised hover:bg-surface"
            )}
          >
            <span className="text-xl">🎲</span>
            <div>
              <p className="text-sm font-semibold text-fg">Exploratory Racer (Uniform Legal)</p>
              <p className="text-xs text-fg-secondary">
                Samples diverse legal actions uniformly to stress test physics edge cases and collision boundaries.
              </p>
            </div>
          </button>
          <button
            type="button"
            onClick={() => {
              updateAssignment(defaultAssignment.id, (a) => ({
                ...a,
                policyId: "first-legal"
              }));
            }}
            className={"flex items-start gap-3 rounded-xl border p-3 text-left transition " + (
              defaultAssignment.policyId === "first-legal"
                ? "border-accent bg-accent/10 ring-1 ring-accent"
                : "border-border bg-surface-raised hover:bg-surface"
            )}
          >
            <span className="text-xl">🎯</span>
            <div>
              <p className="text-sm font-semibold text-fg">Goal-Driven Racer (First Legal)</p>
              <p className="text-xs text-fg-secondary">
                Deterministic action selection prioritizing progression, finishing races, and resource management.
              </p>
            </div>
          </button>
        </div>
      </div>

      <div className="grid gap-1.5">
        <label htmlFor="playtest-focus-notes" className="text-xs font-semibold uppercase tracking-wider text-fg-muted">
          3. Areas of Focus & Operator Intent (Optional)
        </label>
        <input
          id="playtest-focus-notes"
          type="text"
          placeholder="e.g., Check if pit cars get stuck behind parked bodies on four-team field"
          className="rounded-lg border border-border bg-surface px-3.5 py-2 text-sm text-fg placeholder:text-fg-muted/60 focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent"
        />
      </div>

      <button
        className="inline-flex min-h-12 w-full items-center justify-center gap-2 rounded-xl bg-accent px-6 py-3.5 text-base font-semibold text-fg-inverse shadow-md transition hover:brightness-110 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:cursor-not-allowed disabled:opacity-60"
        data-playtesting-run-submit="true"
        disabled={pending || !valid}
        type="submit"
      >
        <span aria-hidden="true" className="text-lg leading-none">🚀</span>
        {pending
          ? "Starting adapter playtest…"
          : assignments.length === 1
            ? "Start Adapter Playtest"
            : "Start " + String(assignments.length) + " Adapter Playtests"}
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
            <fieldset
              className={`${NESTED_PANEL_CLASS} grid gap-3 md:grid-cols-3`}
            >
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
              Available seeds:{" "}
              {admissibleSeeds
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
                          changeScenario(
                            assignment.id,
                            event.currentTarget.value
                          )
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
                            {option.policyId} · {option.cohort} ·{" "}
                            {option.strategy}
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
                {String(capabilities.limits!.wallTimeMs / 1000)} seconds maximum
                · {capabilities.limits!.critiqueCount} later critiques maximum.
              </p>
              <p className={MUTED_META_CLASS}>
                Runtime checks the remaining approved workspace budget before
                launching a sandbox. Starting a playtest does not run an analyst
                review.
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

export function playtestingRunSetupBlocker(setup: PlaytestingRunSetup): {
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
  const readiness = setup.capabilities.modeReadiness["adapter-accelerated"];
  if (readiness.status === "ready") return null;
  const firstReason = readiness.reasons[0];
  return {
    label: firstReason?.label ?? "Adapter mode unavailable",
    message: readiness.reasons.map((reason) => reason.message).join(" "),
    ...(firstReason === undefined ? {} : { code: firstReason.code })
  };
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

const PENDING_LAUNCH_STORAGE_PREFIX = "autodev.playtesting.pending-launch.";
const LAST_ACCEPTED_LAUNCH_STORAGE_PREFIX =
  "autodev.playtesting.last-accepted.";
const REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/u;
const CAPABILITY_REVISION_PATTERN = /^[a-f\d]{64}$/u;
const ASSIGNMENT_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/u;
const BATCH_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/u;
type AdapterPlaytestLaunchRequest = Extract<
  PlaytestLaunchRequest,
  { readonly mode: "adapter-accelerated" }
>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function restorePendingLaunch(
  serialized: string,
  workspaceId: string
): AdapterPlaytestLaunchRequest | null {
  let value: unknown;
  try {
    value = JSON.parse(serialized);
  } catch {
    return null;
  }
  if (
    !isRecord(value) ||
    value.schema !== PLAYTEST_LAUNCH_REQUEST_SCHEMA ||
    value.mode !== "adapter-accelerated" ||
    value.workspaceId !== workspaceId ||
    typeof value.requestId !== "string" ||
    !REQUEST_ID_PATTERN.test(value.requestId) ||
    typeof value.capabilityRevision !== "string" ||
    !CAPABILITY_REVISION_PATTERN.test(value.capabilityRevision) ||
    !isRecord(value.operation) ||
    value.operation.kind !== "batch" ||
    !Array.isArray(value.operation.assignments) ||
    value.operation.assignments.length === 0 ||
    !value.operation.assignments.every(
      (assignment) =>
        isRecord(assignment) &&
        typeof assignment.scenario === "string" &&
        typeof assignment.policy === "string" &&
        typeof assignment.seed === "string" &&
        Number.isSafeInteger(assignment.maxSteps)
    )
  ) {
    return null;
  }
  return value as unknown as AdapterPlaytestLaunchRequest;
}

function isRunRequestLookup(
  value: unknown,
  workspaceId: string,
  requestId: string
): value is ControlApiPlaytestingRunRequestLookupResponse {
  if (
    !isRecord(value) ||
    value.schema !== "autodev-control-playtesting-run-request-v1" ||
    value.workspaceId !== workspaceId ||
    value.requestId !== requestId ||
    !["not-found", "expired", "pending", "accepted"].includes(
      String(value.state)
    )
  ) {
    return false;
  }
  if (value.state === "not-found" || value.state === "expired") {
    return (
      value.batchId === null &&
      value.assignmentCount === null &&
      Array.isArray(value.assignmentIds) &&
      value.assignmentIds.length === 0 &&
      value.createdAt === null &&
      value.status === null
    );
  }
  return (
    typeof value.batchId === "string" &&
    Number.isSafeInteger(value.assignmentCount) &&
    typeof value.assignmentCount === "number" &&
    value.assignmentCount > 0 &&
    Array.isArray(value.assignmentIds) &&
    value.assignmentIds.every(
      (id) => typeof id === "string" && ASSIGNMENT_ID_PATTERN.test(id)
    ) &&
    typeof value.createdAt === "string" &&
    Number.isFinite(Date.parse(value.createdAt)) &&
    (value.state === "pending"
      ? value.assignmentIds.length === 0 && value.status === null
      : value.assignmentIds.length === value.assignmentCount &&
        isControlApiPlaytestingRunState(value.status))
  );
}

function isStartedResponse(
  value: unknown,
  workspaceId: string
): value is ControlApiPlaytestingRunStartedResponse {
  return (
    isRecord(value) &&
    value.schema === "autodev-control-playtesting-run-started-v2" &&
    value.workspaceId === workspaceId &&
    typeof value.batchId === "string" &&
    BATCH_ID_PATTERN.test(value.batchId) &&
    typeof value.assignmentCount === "number" &&
    Number.isSafeInteger(value.assignmentCount) &&
    value.assignmentCount > 0 &&
    Array.isArray(value.assignmentIds) &&
    value.assignmentIds.length === value.assignmentCount &&
    new Set(value.assignmentIds).size === value.assignmentIds.length &&
    value.assignmentIds.every(
      (id) => typeof id === "string" && ASSIGNMENT_ID_PATTERN.test(id)
    ) &&
    typeof value.createdAt === "string" &&
    Number.isFinite(Date.parse(value.createdAt)) &&
    isControlApiPlaytestingRunState(value.status)
  );
}

function payloadFingerprint(request: AdapterPlaytestLaunchRequest): string {
  const { requestId: _requestId, ...payload } = request;
  return JSON.stringify(payload);
}

function withPlaytestLaunchLock<Result>(
  workspaceId: string | null,
  operation: () => Promise<Result>
): Promise<Result> {
  if (!workspaceId || !globalThis.navigator.locks) return operation();
  return globalThis.navigator.locks
    .request<Promise<Result>>(
      `autodev-playtest-launch:${workspaceId}`,
      { mode: "exclusive" },
      operation
    )
    .then((result) => result);
}

function requestForConcurrentTab(
  serialized: string,
  workspaceId: string,
  expectedFingerprint: string,
  clickStartedAt: number
): AdapterPlaytestLaunchRequest | null {
  let value: unknown;
  try {
    value = JSON.parse(serialized);
  } catch {
    return null;
  }
  if (
    !isRecord(value) ||
    typeof value.acceptedAt !== "number" ||
    value.acceptedAt < clickStartedAt ||
    value.payloadFingerprint !== expectedFingerprint ||
    typeof value.launchRequest !== "string"
  ) {
    return null;
  }
  return restorePendingLaunch(value.launchRequest, workspaceId);
}

async function readRunRequest(
  workspaceId: string,
  requestId: string
): Promise<
  | {
      readonly kind: "ok";
      readonly data: ControlApiPlaytestingRunRequestLookupResponse;
    }
  | { readonly kind: "error"; readonly message: string }
> {
  try {
    const query = new URLSearchParams({ workspaceId, requestId });
    const response = await fetch("/api/playtesting/runs/by-request?" + query, {
      headers: { accept: "application/json" },
      cache: "no-store"
    });
    const payload: unknown = await response.json();
    if (!response.ok || !isRecord(payload) || payload.kind !== "ok") {
      return { kind: "error", message: responseMessage(payload) };
    }
    if (!isRunRequestLookup(payload.data, workspaceId, requestId)) {
      return {
        kind: "error",
        message: "Runtime returned an incompatible request-recovery receipt."
      };
    }
    return { kind: "ok", data: payload.data };
  } catch {
    return {
      kind: "error",
      message: "The Console could not recover this request receipt."
    };
  }
}

type LaunchPostResult =
  | {
      readonly kind: "accepted";
      readonly receipt: ControlApiPlaytestingRunStartedResponse;
    }
  | { readonly kind: "stale-capabilities" }
  | { readonly kind: "rejected"; readonly message: string }
  | { readonly kind: "invalid-receipt" }
  | { readonly kind: "unreachable" };

async function postRunLaunch(
  launchRequest: AdapterPlaytestLaunchRequest
): Promise<LaunchPostResult> {
  try {
    const form = new URLSearchParams({
      launchRequest: JSON.stringify(launchRequest)
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
      const stale =
        response.status === 409 &&
        isRecord(payload) &&
        payload.code ===
          "autodev_control_playtesting_capability_revision_changed";
      return stale
        ? { kind: "stale-capabilities" }
        : { kind: "rejected", message: responseMessage(payload) };
    }
    if (!isRecord(payload) || payload.kind !== "ok") {
      return { kind: "invalid-receipt" };
    }
    return isStartedResponse(payload.data, launchRequest.workspaceId)
      ? { kind: "accepted", receipt: payload.data }
      : { kind: "invalid-receipt" };
  } catch {
    return { kind: "unreachable" };
  }
}

async function submitPlaytestLaunch(input: {
  readonly capabilities: ControlApiPlaytestingCapabilitiesResponse | null;
  readonly storageKey: string | null;
  readonly launchRequest: AdapterPlaytestLaunchRequest;
  readonly setPending: (pending: boolean) => void;
  readonly setNotice: (notice: string | null) => void;
  readonly setFailure: (failure: string | null) => void;
  readonly setPendingLaunch: (
    launch: AdapterPlaytestLaunchRequest | null
  ) => void;
  readonly requestIdRef: { current: string | null };
  readonly clearPendingLaunch: () => void;
  readonly onRunStarted: (
    receipt: ControlApiPlaytestingRunStartedResponse
  ) => void;
  readonly refresh: () => void;
}): Promise<void> {
  const { capabilities, launchRequest } = input;
  if (!capabilities) return;
  if (launchRequest.workspaceId !== capabilities.workspaceId) {
    input.setFailure(
      "This saved request belongs to another workspace. Switch back to that workspace to recover it."
    );
    return;
  }
  input.setPending(true);
  input.setFailure(null);
  input.setNotice(null);
  try {
    if (input.storageKey) {
      globalThis.localStorage.setItem(
        input.storageKey,
        JSON.stringify(launchRequest)
      );
    }
  } catch {
    input.requestIdRef.current = null;
    input.setPendingLaunch(null);
    input.setFailure(
      "This browser could not preserve the requestId for recovery. Do not retry after an uncertain response without checking active runs."
    );
    input.setPending(false);
    return;
  }
  const result = await postRunLaunch(launchRequest);
  if (result.kind === "stale-capabilities") {
    input.setFailure(
      "Playtesting readiness changed after preflight. Review the refreshed options before starting again."
    );
    input.clearPendingLaunch();
    input.refresh();
  } else if (result.kind === "rejected") {
    input.setPendingLaunch(launchRequest);
    input.setFailure(result.message);
    input.setNotice(
      "The request may have been accepted. Check its requestId before retrying; retries must use the exact saved payload."
    );
  } else if (result.kind === "unreachable") {
    input.setPendingLaunch(launchRequest);
    input.setFailure(
      "The same-origin run request could not confirm acceptance."
    );
    input.setNotice(
      "The request may have been accepted. Recover by requestId before retrying."
    );
  } else if (result.kind === "invalid-receipt") {
    input.setPendingLaunch(launchRequest);
    input.setFailure("The Runtime did not confirm a complete run receipt.");
    input.setNotice(
      "The request may have been accepted. Recover by requestId before retrying."
    );
  } else {
    try {
      globalThis.localStorage.setItem(
        LAST_ACCEPTED_LAUNCH_STORAGE_PREFIX +
          encodeURIComponent(capabilities.workspaceId),
        JSON.stringify({
          acceptedAt: Date.now(),
          payloadFingerprint: payloadFingerprint(launchRequest),
          launchRequest: JSON.stringify(launchRequest)
        })
      );
    } catch {
      // Runtime's durable receipt remains authoritative without the tab hint.
    }
    input.clearPendingLaunch();
    input.onRunStarted(result.receipt);
    input.setNotice(
      "Run accepted. Live status below is read from Runtime; assignment and episode IDs remain distinct."
    );
  }
  input.setPending(false);
}

async function beginPlaytestLaunch(input: {
  readonly capabilities: ControlApiPlaytestingCapabilitiesResponse | null;
  readonly storageKey: string | null;
  readonly request: RunSubmission;
  readonly pendingLaunch: AdapterPlaytestLaunchRequest | null;
  readonly requestIdRef: { current: string | null };
  readonly setPendingLaunch: (
    launch: AdapterPlaytestLaunchRequest | null
  ) => void;
  readonly setFailure: (failure: string | null) => void;
  readonly setNotice: (notice: string | null) => void;
  readonly withLaunchLock: <Result>(
    operation: () => Promise<Result>
  ) => Promise<Result>;
  readonly submit: (launch: AdapterPlaytestLaunchRequest) => Promise<void>;
}): Promise<void> {
  const { capabilities } = input;
  if (!capabilities || input.pendingLaunch) return;
  const clickStartedAt = Date.now();
  const launchPayload = {
    schema: PLAYTEST_LAUNCH_REQUEST_SCHEMA,
    mode: "adapter-accelerated" as const,
    workspaceId: input.request.workspaceId,
    capabilityRevision: capabilities.capabilityRevision,
    operation: {
      kind: "batch" as const,
      assignments: input.request.assignments
    }
  };
  const fingerprint = JSON.stringify(launchPayload);
  await input.withLaunchLock(async () => {
    if (input.storageKey) {
      let saved: string | null;
      try {
        saved = globalThis.localStorage.getItem(input.storageKey);
      } catch {
        input.setFailure(
          "This browser cannot check for an unresolved request in another tab; no launch was submitted."
        );
        return;
      }
      const restored = saved
        ? restorePendingLaunch(saved, capabilities.workspaceId)
        : null;
      if (restored) {
        input.requestIdRef.current = restored.requestId;
        input.setPendingLaunch(restored);
        input.setNotice(
          "Another tab already has an unresolved request. Recover that request before starting another."
        );
        return;
      }
      try {
        const marker = globalThis.localStorage.getItem(
          LAST_ACCEPTED_LAUNCH_STORAGE_PREFIX +
            encodeURIComponent(capabilities.workspaceId)
        );
        const shared = marker
          ? requestForConcurrentTab(
              marker,
              capabilities.workspaceId,
              fingerprint,
              clickStartedAt
            )
          : null;
        if (shared) {
          globalThis.localStorage.setItem(
            input.storageKey,
            JSON.stringify(shared)
          );
          input.requestIdRef.current = shared.requestId;
          input.setPendingLaunch(shared);
          input.setNotice(
            "Another tab submitted this identical request. Check its Runtime receipt before continuing."
          );
          return;
        }
      } catch {
        // The durable Data idempotency record guards every accepted request.
      }
    }
    const launchRequest: AdapterPlaytestLaunchRequest = {
      ...launchPayload,
      requestId: (input.requestIdRef.current ??= globalThis.crypto.randomUUID())
    };
    await input.submit(launchRequest);
  });
}

async function recoverPlaytestLaunch(input: {
  readonly pendingLaunch: AdapterPlaytestLaunchRequest | null;
  readonly workspaceId: string | null;
  readonly setPending: (pending: boolean) => void;
  readonly setFailure: (failure: string | null) => void;
  readonly setNotice: (notice: string | null) => void;
  readonly setRequestLookup: (
    lookup: ControlApiPlaytestingRunRequestLookupResponse | null
  ) => void;
  readonly clearPendingLaunch: () => void;
  readonly onRunStarted: (
    receipt: ControlApiPlaytestingRunStartedResponse
  ) => void;
}): Promise<void> {
  const { pendingLaunch, workspaceId } = input;
  if (
    !pendingLaunch ||
    !workspaceId ||
    pendingLaunch.workspaceId !== workspaceId
  )
    return;
  input.setPending(true);
  input.setFailure(null);
  input.setNotice(null);
  const result = await readRunRequest(workspaceId, pendingLaunch.requestId);
  if (result.kind === "error") {
    input.setFailure(result.message);
    input.setPending(false);
    return;
  }
  const found = result.data;
  input.setRequestLookup(found);
  if (found.state === "accepted") {
    const receipt: ControlApiPlaytestingRunStartedResponse = {
      schema: "autodev-control-playtesting-run-started-v2",
      workspaceId,
      batchId: found.batchId!,
      assignmentCount: found.assignmentCount!,
      assignmentIds: found.assignmentIds,
      createdAt: found.createdAt!,
      status: found.status!
    };
    input.clearPendingLaunch();
    input.onRunStarted(receipt);
    input.setNotice("Recovered the Runtime receipt for the original request.");
  } else if (found.state === "pending") {
    input.setNotice(
      "Runtime reserved this request, but no assignment manifest or episode exists yet. Resume with the same requestId."
    );
  } else if (found.state === "not-found") {
    input.setNotice(
      "Runtime has no receipt for this requestId. Retrying the exact saved payload is safe."
    );
  } else {
    input.setNotice(
      "This requestId has expired. Confirm the prior run history before creating a new request."
    );
  }
  input.setPending(false);
}

function pendingRunPanel(input: {
  readonly launch: AdapterPlaytestLaunchRequest | null;
  readonly lookup: ControlApiPlaytestingRunRequestLookupResponse | null;
  readonly pending: boolean;
  readonly workspaceId: string | null;
  readonly onRetry: () => void;
  readonly onRecover: () => void;
  readonly onDiscard: () => void;
}): React.JSX.Element | null {
  const { launch, lookup, pending } = input;
  if (!launch) return null;
  const lookupPending = lookup?.state === "pending";
  const canDiscard =
    lookup?.state === "not-found" || lookup?.state === "expired";
  const retryLabel =
    lookup?.state === "not-found"
      ? "Retry same request"
      : lookupPending
        ? "Resume same request"
        : "Check request status";
  return React.createElement(
    "section",
    {
      className:
        "grid gap-3 rounded-lg border border-warning/50 bg-surface-raised p-4",
      "aria-label": "Pending playtest request",
      "data-request-id": launch.requestId,
      "aria-live": "polite"
    },
    React.createElement(
      "h3",
      { className: "font-semibold" },
      "Pending run request"
    ),
    React.createElement(
      "p",
      { className: MUTED_BODY_CLASS },
      `${launch.operation.kind === "batch" ? launch.operation.assignments.length : 1} assignment(s) · request ${launch.requestId}`
    ),
    lookupPending
      ? React.createElement(
          "p",
          { className: MUTED_BODY_CLASS },
          `Runtime reserved batch ${lookup.batchId}; no gameplay episode is recorded yet.`
        )
      : null,
    pending
      ? React.createElement(
          "p",
          { className: MUTED_META_CLASS },
          "Checking Runtime…"
        )
      : React.createElement(
          "div",
          { className: "flex flex-wrap gap-2" },
          React.createElement(
            Button,
            {
              type: "button",
              variant: "primary",
              disabled: lookup?.state === "accepted",
              onClick:
                lookup?.state === "not-found" || lookupPending
                  ? input.onRetry
                  : input.onRecover
            },
            retryLabel
          ),
          lookupPending
            ? React.createElement(
                Button,
                {
                  type: "button",
                  variant: "secondary",
                  onClick: input.onRecover
                },
                "Refresh receipt"
              )
            : null,
          canDiscard
            ? React.createElement(
                Button,
                {
                  type: "button",
                  variant: "secondary",
                  onClick: input.onDiscard
                },
                "Discard and edit"
              )
            : null
        )
  );
}

function blockedRunPanel(
  unavailable: ReturnType<typeof playtestingRunSetupBlocker>
): React.JSX.Element | null {
  if (!unavailable) return null;
  return React.createElement(
    "div",
    {
      className:
        "mt-4 flex flex-col gap-2 rounded-md border border-warning/40 bg-surface-raised p-4",
      "data-testid": "playtesting-run-blocked"
    },
    React.createElement(StatusBadge, {
      status:
        unavailable.label === "Approval required" ||
        unavailable.label === "Operator required"
          ? NOT_OBSERVED_STATUS
          : "unavailable",
      label: unavailable.label
    }),
    React.createElement(
      "p",
      { className: MUTED_BODY_CLASS },
      unavailable.message
    ),
    unavailable.code
      ? React.createElement(
          "code",
          { className: MUTED_META_CLASS },
          unavailable.code
        )
      : null
  );
}

export function PlaytestingRunControls({
  setup,
  workspaceId: requestedWorkspaceId,
  onRunStarted
}: {
  readonly setup: PlaytestingRunSetup;
  readonly workspaceId: string | null;
  readonly onRunStarted: (
    started: ControlApiPlaytestingRunStartedResponse
  ) => void;
}): React.JSX.Element {
  const router = useRouter();
  const capabilities = setup.kind === "available" ? setup.capabilities : null;
  const workspaceId = capabilities?.workspaceId ?? requestedWorkspaceId;
  const storageKey = workspaceId
    ? PENDING_LAUNCH_STORAGE_PREFIX + encodeURIComponent(workspaceId)
    : null;
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [pendingLaunch, setPendingLaunch] =
    useState<AdapterPlaytestLaunchRequest | null>(null);
  const [requestLookup, setRequestLookup] =
    useState<ControlApiPlaytestingRunRequestLookupResponse | null>(null);
  const launchRequestId = useRef<string | null>(null);
  const noticeNode = RunStatusMessage({ notice, failure });
  const unavailable = playtestingRunSetupBlocker(setup);
  const adapterRunReady =
    capabilities?.modeReadiness["adapter-accelerated"].status === "ready" &&
    capabilities.runnableAssignments.length > 0;

  function clearPendingLaunch(): void {
    if (storageKey) {
      try {
        globalThis.localStorage.removeItem(storageKey);
      } catch {
        // Browser storage can be unavailable; Runtime remains the authority.
      }
    }
    launchRequestId.current = null;
    setPendingLaunch(null);
    setRequestLookup(null);
  }

  useEffect(() => {
    if (!workspaceId || !storageKey) return () => {};
    if (pendingLaunch && pendingLaunch.workspaceId !== workspaceId) {
      setPendingLaunch(null);
      setRequestLookup(null);
      launchRequestId.current = null;
      return () => {};
    }
    const restore = (serialized: string | null): void => {
      if (!serialized) return;
      const restored = restorePendingLaunch(serialized, workspaceId);
      if (!restored) {
        try {
          globalThis.localStorage.removeItem(storageKey);
        } catch {
          // Ignore corrupt, inaccessible local recovery data.
        }
        return;
      }
      launchRequestId.current = restored.requestId;
      setPendingLaunch(restored);
      setNotice(
        "A prior start request has no confirmed receipt. Recover it before starting or editing another run."
      );
    };
    try {
      if (!pendingLaunch) restore(globalThis.localStorage.getItem(storageKey));
    } catch {
      setNotice(
        "A previous request could not be restored. Check active runs before submitting another launch."
      );
    }
    const onStorage = (event: StorageEvent): void => {
      if (event.key !== storageKey) return;
      if (event.newValue === null) {
        setPendingLaunch(null);
        setRequestLookup(null);
        launchRequestId.current = null;
        setNotice("Another tab confirmed or cleared this launch request.");
        router.refresh();
        return;
      }
      restore(event.newValue);
    };
    globalThis.addEventListener("storage", onStorage);
    return () => globalThis.removeEventListener("storage", onStorage);
  }, [workspaceId, storageKey, pendingLaunch, router]);

  const submitLaunch = (launchRequest: AdapterPlaytestLaunchRequest) =>
    submitPlaytestLaunch({
      capabilities,
      storageKey,
      launchRequest,
      setPending,
      setNotice,
      setFailure,
      setPendingLaunch,
      requestIdRef: launchRequestId,
      clearPendingLaunch,
      onRunStarted,
      refresh: () => router.refresh()
    });

  const startRun = (request: RunSubmission) =>
    beginPlaytestLaunch({
      capabilities,
      storageKey,
      request,
      pendingLaunch,
      requestIdRef: launchRequestId,
      setPendingLaunch,
      setFailure,
      setNotice,
      withLaunchLock: (operation) =>
        withPlaytestLaunchLock(workspaceId, operation),
      submit: submitLaunch
    });

  const recoverLaunch = () =>
    withPlaytestLaunchLock(workspaceId, () =>
      recoverPlaytestLaunch({
        pendingLaunch,
        workspaceId,
        setPending,
        setFailure,
        setNotice,
        setRequestLookup,
        clearPendingLaunch,
        onRunStarted
      })
    );

  function discardUnacceptedRequest(): void {
    if (
      requestLookup?.state !== "not-found" &&
      requestLookup?.state !== "expired"
    ) {
      return;
    }
    clearPendingLaunch();
    setNotice(
      "The unresolved request was cleared. Review the form before starting a new attempt."
    );
    setFailure(null);
  }

  const recoveryPanel = pendingRunPanel({
    launch: pendingLaunch,
    lookup: requestLookup,
    pending,
    workspaceId,
    onRetry: () =>
      withPlaytestLaunchLock(workspaceId, () => submitLaunch(pendingLaunch!)),
    onRecover: () => void recoverLaunch(),
    onDiscard: discardUnacceptedRequest
  });

  return React.createElement(
    "section",
    {
      className: "grid gap-3",
      "data-run-setup": setup.kind
    },
    blockedRunPanel(unavailable),
    capabilities && adapterRunReady && !pendingLaunch
      ? React.createElement(RunRequestForm, {
          capabilities,
          pending,
          onSubmit: (request) => void startRun(request)
        })
      : null,
    recoveryPanel,
    noticeNode
  );
}
