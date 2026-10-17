/** Approved, single-episode gameplay loop over the v1 adapter transport. */
import { performance } from "node:perf_hooks";

import {
  assertPlaytestExecutionProvenance,
  assertWorkspacePlaytestApproval,
  canonicalPlaytestJson,
  type GameCaptureEvent,
  type GameCaptureEventsResult,
  type GameForkResult,
  type GameLegalAction,
  type GameObserveResult,
  type GameOutcomeResult,
  type GameReplayResult,
  type GameResetResult,
  type GameSnapshotResult,
  type GameStepResult,
  normalizeGameMetricEvaluations,
  type PlaytestArtifactReference,
  type PlaytestAssignmentBranch,
  type PlaytestBranchLineage,
  type PlaytestCapabilityAdvertisement,
  type PlaytestCheckpointDigest,
  type PlaytestEpisode,
  type PlaytestEpisodeIdentity,
  playtestEpisodeRecordId,
  type PlaytestEpisodeStep,
  type PlaytestEvidenceLocator,
  type PlaytestJsonValue,
  type PlaytestMetricRegistry,
  type PlaytestMissingReason,
  type PlaytestNumericResult,
  type PlaytestObservationContract,
  type PlaytestProvenance,
  PLAYTESTS_EPISODE_SCHEMA,
  PLAYTESTS_GAME_OUTCOMES,
  samePlaytestCheckpoint,
  samePlaytestRngCheckpoint,
  type WorkspacePlaytestApproval,
  type WorkspacePlaytestBuild
} from "@simulatorlife/autodev-core";

import {
  type PlaytestAdapterCallResult,
  PlaytestAdapterClient
} from "./adapter-client.ts";
import type { PlaytestArtifactStore } from "./artifact-store.ts";
import {
  PlaytestSandboxExecutionError,
  type PlaytestSandboxHandle,
  type PlaytestSandboxResult,
  readStagedPlaytestArtifact
} from "./docker-sandbox.ts";
import { PlaytestLoopGuard } from "./loop-guard.ts";
import type { PlaytestPolicy, PlaytestPolicyDecision } from "./policies.ts";
import { projectPlaytestVisibleObservation } from "./visible-observation.ts";

const SHA256_PATTERN = /^[a-f\d]{64}$/iu;
const COMMIT_PATTERN = /^(?:[a-f\d]{40}|[a-f\d]{64})$/iu;
const ASSIGNMENT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/u;
export const MAX_PLAYTEST_EPISODE_TRACE_STEPS = 4096;
const MAX_EPISODE_WINDOW_STEPS = MAX_PLAYTEST_EPISODE_TRACE_STEPS;
const MAX_TRACE_EVENT_COUNT = 100_000;
const BUDGET_TRUNCATED = "budget-truncated" as const;
const APPROVAL_REVOKED = "approval-revoked" as const;
const LOOP_GUARD = "loop-guard" as const;
const INFRASTRUCTURE_FAILED = "infrastructure-failed" as const;
const EMPTY_COMPLETION_COUNTS = {
  assigned: 1,
  started: 0,
  completed: 0,
  crashed: 0,
  infrastructureFailed: 0,
  cancelled: 0,
  budgetTruncated: 0,
  reviewed: 0,
  eligible: 0
} as const;

export interface PlaytestEpisodeBranchExecution {
  readonly manifest: PlaytestAssignmentBranch;
  readonly parentEpisode: PlaytestEpisode;
}

export interface PlaytestEpisodeRunOptions {
  readonly approval: WorkspacePlaytestApproval;
  /** The latest committed build this batch resolved and snapshotted at start. */
  readonly build: WorkspacePlaytestBuild;
  readonly sandbox: PlaytestSandboxHandle;
  readonly artifacts: PlaytestArtifactStore;
  readonly batchId: string;
  /** Batch-local frozen assignment id; paired in Data, never sent to the game. */
  readonly assignmentId: string;
  readonly repository: string;
  readonly scenarioId: string;
  readonly scenarioFamily: string;
  readonly seed: string;
  readonly goal: string;
  readonly measurementVersion: string;
  readonly runtimeVersion: string;
  readonly environmentHash: string;
  readonly policy: PlaytestPolicy;
  readonly observationContract: PlaytestObservationContract;
  readonly metricRegistry: PlaytestMetricRegistry;
  readonly rubricHash: string;
  readonly maxSteps: number;
  readonly branch?: PlaytestEpisodeBranchExecution;
  readonly signal?: AbortSignal;
  readonly now?: () => number;
  /** Game-authored mapping; absent mappings leave the game outcome unknown. */
  readonly classifyOutcome?: (
    outcome: PlaytestJsonValue | null
  ) => PlaytestEpisode["outcome"];
  /** Only this public projection may enter the analyst-visible trace. */
  readonly projectPublicOutcome?: (
    outcome: PlaytestJsonValue | null
  ) => PlaytestJsonValue | null;
  readonly isApprovalActive?: () => boolean;
  readonly cancelProcess?: (reason: string) => Promise<void>;
}

export interface PlaytestEpisodeRunFailure {
  readonly stage: "execution" | "evidence";
  readonly category:
    | "adapter"
    | "policy"
    | "sandbox"
    | "cancelled"
    | typeof APPROVAL_REVOKED
    | "trace"
    | "no-legal-actions"
    | typeof LOOP_GUARD
    | typeof BUDGET_TRUNCATED
    | "evaluator";
  readonly code: number | null;
  readonly disposition: string | null;
}

export interface PlaytestEpisodeRunResult {
  /** Last validated adapter capabilities, if negotiation completed before failure. */
  readonly capabilities: PlaytestCapabilityAdvertisement | null;
  /** Null when adapter negotiation/reset failed before the game assigned an episode ID. */
  readonly episode: PlaytestEpisode | null;
  readonly steps: readonly PlaytestEpisodeStep[];
  readonly traceReference: PlaytestArtifactReference | null;
  readonly sandboxResult: PlaytestSandboxResult | null;
  readonly failure: PlaytestEpisodeRunFailure | null;
  readonly loopDetectedAtStep: number | null;
}

interface StepDraft {
  readonly step: number;
  readonly revisionBefore: number;
  readonly revisionAfter: number;
  readonly observationHash: string;
  readonly observationVisibility: PlaytestEpisodeStep["observationVisibility"];
  readonly observation: PlaytestJsonValue;
  readonly legalActionIds: readonly string[];
  readonly selectedActionId: string;
  readonly preActionPrediction: PlaytestJsonValue | null;
  readonly authoritativeOutcome: PlaytestJsonValue | null;
  readonly eventRefs: readonly PlaytestEvidenceLocator[];
  readonly frameRef: PlaytestEvidenceLocator | null;
  readonly checkpoint: PlaytestCheckpointDigest | null;
  readonly executed: boolean;
  readonly simulationWallMs: number;
  readonly policyInferenceMs: number;
  readonly capturedEvents: readonly GameCaptureEvent[];
}

interface PendingFrame {
  readonly step: number;
  readonly frameIndex: number;
  readonly reference: PlaytestArtifactReference;
}

interface EpisodeExecutionContext {
  readonly options: PlaytestEpisodeRunOptions;
  readonly client: PlaytestAdapterClient;
  readonly assignedAt: string;
  readonly events: GameCaptureEvent[];
  readonly eventById: Map<string, GameCaptureEvent>;
  readonly drafts: StepDraft[];
  readonly pendingFrames: PendingFrame[];
  readonly missingReasons: Set<PlaytestMissingReason>;
  branchSnapshot: GameSnapshotResult | null;
  branchReplayTransitionHash: string | null;
  branchForkStateHash: string | null;
  branchForkRngCheckpoint: GameForkResult["rngCheckpoint"] | null;
  persistedBranchSnapshot: PlaytestArtifactReference | null;
  capabilities: PlaytestCapabilityAdvertisement | null;
  reset: GameResetResult | null;
  startedAt: string | null;
  /** The adapter's protocol handle for this episode; never a persisted key. */
  episodeId: string;
  revision: number;
  simulationWallMs: number;
  policyInferenceMs: number;
  outcome: GameOutcomeResult | null;
  failure: PlaytestEpisodeRunFailure | null;
  loopDetectedAtStep: number | null;
  unsubscribe: () => void;
  sandboxResult: PlaytestSandboxResult | null;
}

class AdapterCallFailure extends Error {
  readonly result: Extract<PlaytestAdapterCallResult, { readonly ok: false }>;
  constructor(
    result: Extract<PlaytestAdapterCallResult, { readonly ok: false }>
  ) {
    super("A game-adapter operation did not complete successfully.");
    this.name = "AdapterCallFailure";
    this.result = result;
  }
}

class PolicyViolationError extends Error {
  constructor() {
    super("Policy selected an action not in the current legal-action set.");
    this.name = "PolicyViolationError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isJsonValue(value: unknown, depth = 0): value is PlaytestJsonValue {
  if (depth > 64) return false;
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return true;
  }
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value))
    return value.every((item) => isJsonValue(item, depth + 1));
  return (
    isRecord(value) &&
    Object.values(value).every((item) => isJsonValue(item, depth + 1))
  );
}

function assertRunInputs(options: PlaytestEpisodeRunOptions): void {
  assertWorkspacePlaytestApproval(options.approval);
  if (options.approval.revokedAt !== null) {
    throw new TypeError("Workspace playtesting approval has been revoked.");
  }
  if (
    options.metricRegistry.workspaceId !== options.approval.workspaceId ||
    !SHA256_PATTERN.test(options.rubricHash)
  ) {
    throw new TypeError(
      "Episode metric registry or rubric hash does not match the workspace approval."
    );
  }
  if (options.artifacts.boundWorkspaceId() !== options.approval.workspaceId) {
    throw new TypeError(
      "Artifact store workspace does not match the approval."
    );
  }
  if (options.repository !== options.approval.workspaceId) {
    throw new TypeError(
      "Repository identity does not match the approved workspace."
    );
  }
  if (!options.approval.allowedScenarios.includes(options.scenarioId)) {
    throw new TypeError("Scenario is not permitted by the workspace approval.");
  }
  if (!options.approval.allowedPolicies.includes(options.policy.id)) {
    throw new TypeError("Policy is not permitted by the workspace approval.");
  }
  if (
    !Number.isSafeInteger(options.maxSteps) ||
    options.maxSteps < 1 ||
    options.maxSteps > options.approval.limits.maxStepsPerEpisode ||
    options.maxSteps > MAX_EPISODE_WINDOW_STEPS
  ) {
    throw new RangeError(
      "Episode step limit exceeds the approved or artifact window bound."
    );
  }
  if (!ASSIGNMENT_ID_PATTERN.test(options.assignmentId)) {
    throw new TypeError(
      "Episode assignmentId must be a bounded batch-local identifier."
    );
  }
  const required = [
    options.batchId,
    options.scenarioFamily,
    options.seed,
    options.goal,
    options.measurementVersion,
    options.runtimeVersion,
    options.repository
  ];
  if (required.some((value) => !value.trim() || value.length > 256)) {
    throw new TypeError(
      "Episode identity fields must be bounded non-empty strings."
    );
  }
  if (!SHA256_PATTERN.test(options.environmentHash)) {
    throw new TypeError("Episode environmentHash must be a SHA-256 digest.");
  }
  if (
    options.observationContract.visibilityMode !== "structured" ||
    options.observationContract.mode !== "headless"
  ) {
    throw new TypeError(
      "This runner requires structured headless player-visible observations."
    );
  }
}

function outcomeFromCall<T>(result: PlaytestAdapterCallResult): T {
  if (!result.ok) throw new AdapterCallFailure(result);
  return result.result as T;
}

async function callAdapter<T>(
  client: PlaytestAdapterClient,
  method: Parameters<PlaytestAdapterClient["call"]>[0],
  params: Readonly<Record<string, unknown>>
): Promise<{ readonly value: T; readonly durationMs: number }> {
  const start = performance.now();
  const result = await client.call(method, params);
  return {
    value: outcomeFromCall<T>(result),
    durationMs: Math.max(0, performance.now() - start)
  };
}

function failureFor(
  error: unknown,
  signal?: AbortSignal
): PlaytestEpisodeRunFailure {
  if (signal?.aborted) {
    return {
      stage: "execution",
      category: "cancelled",
      code: null,
      disposition: "aborted"
    };
  }
  if (error instanceof AdapterCallFailure) {
    return {
      stage: "execution",
      category: error.result.code === -32_006 ? "cancelled" : "adapter",
      code: error.result.code,
      disposition: error.result.disposition
    };
  }
  if (error instanceof PolicyViolationError) {
    return {
      stage: "execution",
      category: "policy",
      code: null,
      disposition: "unchanged"
    };
  }
  if (error instanceof PlaytestSandboxExecutionError) {
    return {
      stage: "execution",
      category: "sandbox",
      code: error.exitCode,
      disposition: error.category
    };
  }
  return {
    stage: "execution",
    category: "adapter",
    code: null,
    disposition: "unknown"
  };
}

function statusForFailure(
  failure: PlaytestEpisodeRunFailure | null
): PlaytestEpisode["status"] {
  if (failure === null || failure.stage === "evidence") return "completed";
  if (
    failure.category === "cancelled" ||
    failure.category === APPROVAL_REVOKED
  ) {
    return "cancelled";
  }
  if (
    failure.category === "no-legal-actions" ||
    (failure.category === "adapter" &&
      (failure.code === -32_003 || failure.code === -32_007)) ||
    (failure.category === "sandbox" &&
      (failure.disposition === "exit-code" ||
        failure.disposition === "process-error"))
  ) {
    return "crashed";
  }
  if (
    failure.category === LOOP_GUARD ||
    failure.category === BUDGET_TRUNCATED
  ) {
    return BUDGET_TRUNCATED;
  }
  return INFRASTRUCTURE_FAILED;
}

function completionCounts(
  status: PlaytestEpisode["status"],
  started: boolean,
  eligible: boolean
): PlaytestEpisode["completionCounts"] {
  return {
    ...EMPTY_COMPLETION_COUNTS,
    started: started ? 1 : 0,
    completed: status === "completed" ? 1 : 0,
    crashed: status === "crashed" ? 1 : 0,
    infrastructureFailed: status === INFRASTRUCTURE_FAILED ? 1 : 0,
    cancelled: status === "cancelled" ? 1 : 0,
    budgetTruncated: status === BUDGET_TRUNCATED ? 1 : 0,
    eligible: eligible ? 1 : 0
  };
}

function validateOutcomeMetrics(
  metrics: Readonly<Record<string, number | null>>
): Readonly<Record<string, number | null>> {
  for (const [key, value] of Object.entries(metrics)) {
    if (!key.trim() || (value !== null && !Number.isFinite(value))) {
      throw new TypeError(
        "Game outcome metrics must be finite numbers or null."
      );
    }
  }
  return { ...metrics };
}

function validatePolicyDecision(
  decision: PlaytestPolicyDecision,
  legalActionIds: readonly string[]
): void {
  if (!legalActionIds.includes(decision.actionId))
    throw new PolicyViolationError();
  if (decision.prediction !== null && !isJsonValue(decision.prediction)) {
    throw new TypeError("Policy prediction must be JSON data or null.");
  }
}

function episodeStep(draft: StepDraft, traceId: string): PlaytestEpisodeStep {
  return {
    step: draft.step,
    revisionBefore: draft.revisionBefore,
    revisionAfter: draft.revisionAfter,
    observationHash: draft.observationHash,
    observationVisibility: draft.observationVisibility,
    observationRef: {
      kind: "replay-segment",
      id: traceId,
      step: draft.step,
      revision: draft.revisionAfter
    },
    legalActionIds: draft.legalActionIds,
    selectedActionId: draft.selectedActionId,
    preActionPrediction: draft.preActionPrediction,
    authoritativeOutcome: draft.authoritativeOutcome,
    eventRefs: draft.eventRefs,
    frameRef: draft.frameRef,
    checkpoint: draft.checkpoint,
    simulationWallMs: draft.simulationWallMs,
    logicalTicks: null,
    policyInferenceMs: draft.policyInferenceMs,
    nativeIntervals: []
  };
}

function artifactEntry(draft: StepDraft): PlaytestJsonValue {
  return {
    step: draft.step,
    revisionBefore: draft.revisionBefore,
    revisionAfter: draft.revisionAfter,
    observationHash: draft.observationHash,
    observationVisibility: draft.observationVisibility,
    visibleObservation: draft.observation,
    legalActionIds: [...draft.legalActionIds],
    selectedActionId: draft.selectedActionId,
    preActionPrediction: draft.preActionPrediction,
    authoritativeOutcome: draft.authoritativeOutcome,
    executed: draft.executed,
    checkpoint:
      draft.checkpoint === null
        ? null
        : {
            stateHash: draft.checkpoint.stateHash,
            rngCheckpoint: {
              algorithm: draft.checkpoint.rngCheckpoint.algorithm,
              version: draft.checkpoint.rngCheckpoint.version,
              stateHash: draft.checkpoint.rngCheckpoint.stateHash,
              reproducible: draft.checkpoint.rngCheckpoint.reproducible
            }
          },
    events: draft.capturedEvents.map((event) => ({
      eventId: event.eventId,
      type: event.type,
      phaseId: event.phaseId,
      step: event.step,
      revision: event.revision,
      actor: event.actor
    })),
    simulationWallMs: draft.simulationWallMs,
    policyInferenceMs: draft.policyInferenceMs
  };
}

function captureEvent(
  context: EpisodeExecutionContext,
  event: GameCaptureEvent
): void {
  const existing = context.eventById.get(event.eventId);
  if (existing !== undefined) {
    if (canonicalPlaytestJson(existing) !== canonicalPlaytestJson(event)) {
      context.missingReasons.add(INFRASTRUCTURE_FAILED);
    }
    return;
  }
  if (context.eventById.size >= MAX_TRACE_EVENT_COUNT) return;
  context.eventById.set(event.eventId, event);
  context.events.push(event);
}

function captureNotifications(context: EpisodeExecutionContext): void {
  context.unsubscribe = context.client.onNotification((notification) => {
    if (notification.method !== "game.event") return;
    if (!isRecord(notification.params) || !isRecord(notification.params.event))
      return;
    captureEvent(
      context,
      notification.params.event as unknown as GameCaptureEvent
    );
  });
}

function eventsForRevision(
  context: EpisodeExecutionContext,
  revision: number
): readonly GameCaptureEvent[] {
  return context.events.filter((event) => event.revision === revision);
}

function eventReferences(
  context: EpisodeExecutionContext,
  ids: readonly string[]
): readonly PlaytestEvidenceLocator[] {
  return ids.flatMap((id) => {
    const event = context.eventById.get(id);
    if (event === undefined) return [];
    return [
      {
        kind: "event" as const,
        id,
        step: event.step,
        revision: event.revision,
        ...(event.phaseId === null ? {} : { phaseId: event.phaseId })
      }
    ];
  });
}

function eventsMatchStep(
  context: EpisodeExecutionContext,
  ids: readonly string[]
): boolean {
  return ids.every((id) => context.eventById.has(id));
}

/** Retrieve the exact step's game-authored events when the adapter supports it. */
async function captureEventsForStep(
  context: EpisodeExecutionContext,
  step: number,
  eventIds: readonly string[]
): Promise<void> {
  if (
    !context.capabilities?.optionalOperations.includes("game.captureEvents")
  ) {
    return;
  }
  const captured = await callAdapter<GameCaptureEventsResult>(
    context.client,
    "game.captureEvents",
    {
      episodeId: context.episodeId,
      expectedRevision: context.revision,
      startStep: step,
      endStep: step
    }
  );
  context.simulationWallMs += captured.durationMs;
  const expectedEventIds = new Set(eventIds);
  for (const event of captured.value.events) {
    if (
      event.step !== step ||
      event.revision !== context.revision ||
      !expectedEventIds.has(event.eventId)
    ) {
      context.missingReasons.add(INFRASTRUCTURE_FAILED);
    }
    captureEvent(context, event);
  }
  if (captured.value.omittedCount > 0) {
    context.missingReasons.add("missing-action-or-revision-events");
  }
}

function storeCapabilities(
  context: EpisodeExecutionContext,
  capabilities: PlaytestCapabilityAdvertisement
): void {
  context.capabilities = capabilities;
}

function supportsVerifiedBranching(
  capabilities: PlaytestCapabilityAdvertisement
): boolean {
  const optional = new Set(capabilities.optionalOperations);
  return (
    capabilities.deterministic.seededRuns &&
    capabilities.deterministic.traceReplayable &&
    optional.has("game.snapshot") &&
    optional.has("game.replay") &&
    optional.has("game.fork")
  );
}

function checkpointFromSnapshot(
  snapshot: GameSnapshotResult
): PlaytestCheckpointDigest {
  return {
    stateHash: snapshot.stateHash,
    rngCheckpoint: snapshot.rngCheckpoint
  };
}

function storeReset(
  context: EpisodeExecutionContext,
  reset: GameResetResult,
  startedAt: string
): void {
  context.reset = reset;
  context.startedAt = startedAt;
  context.episodeId = reset.episodeId;
  context.revision = reset.revision;
}

async function negotiateAndInitialize(
  context: EpisodeExecutionContext
): Promise<void> {
  const { options, client } = context;
  const capabilities = await client.negotiateCapabilities();
  storeCapabilities(context, capabilities);
  if (capabilities.engineBuild !== options.build.gameBuild) {
    throw new TypeError(
      "Adapter build does not match the resolved committed game build."
    );
  }
  if (!capabilities.scenarioIds.includes(options.scenarioId)) {
    throw new TypeError("Adapter does not advertise the approved scenario.");
  }
  if (!capabilities.modes.includes(options.observationContract.mode)) {
    throw new TypeError(
      "Adapter does not advertise the observation contract mode."
    );
  }
  if (
    options.observationContract.schemaHash !==
    capabilities.observationSchemaHash
  ) {
    throw new TypeError(
      "Observation contract hash differs from negotiated capabilities."
    );
  }
  const startedAt = new Date((options.now ?? Date.now)()).toISOString();
  if (options.branch) {
    await initializeBranch(context, startedAt);
    return;
  }
  captureNotifications(context);
  const reset = await callAdapter<GameResetResult>(client, "game.reset", {
    seed: options.seed,
    scenarioId: options.scenarioId,
    approvedVariantHash: options.build.configHash
  });
  context.simulationWallMs += reset.durationMs;
  storeReset(context, reset.value, startedAt);
  const reproducibilityMatches =
    reset.value.rngProvenance.reproducible ===
    capabilities.deterministic.seededRuns;
  const rngVersionMatches =
    !capabilities.deterministic.seededRuns ||
    reset.value.rngProvenance.version === capabilities.deterministic.rngVersion;
  if (!reproducibilityMatches || !rngVersionMatches) {
    throw new TypeError(
      "game.reset RNG provenance does not match the capability advertisement."
    );
  }
}

async function initializeBranch(
  context: EpisodeExecutionContext,
  startedAt: string
): Promise<void> {
  const { options, client } = context;
  const branch = options.branch;
  const capabilities = context.capabilities;
  if (!branch || !capabilities || !supportsVerifiedBranching(capabilities)) {
    throw new TypeError(
      "The approved adapter does not advertise verified checkpoint, replay, and fork support."
    );
  }
  if (
    !SHA256_PATTERN.test(branch.manifest.parentTrace.sha256) ||
    branch.manifest.parentEpisodeId !== branch.parentEpisode.episodeId ||
    branch.manifest.parentEpisodeRevision !== branch.parentEpisode.revision ||
    branch.manifest.parentBatchId !== branch.parentEpisode.batchId ||
    branch.parentEpisode.identity.workspaceId !==
      options.approval.workspaceId ||
    branch.parentEpisode.identity.buildSha.toLowerCase() !==
      options.build.buildSha ||
    branch.parentEpisode.identity.configHash !== options.build.configHash ||
    branch.parentEpisode.identity.scenarioId !== options.scenarioId ||
    branch.parentEpisode.identity.seed !== options.seed ||
    branch.parentEpisode.identity.observationSchemaHash !==
      capabilities.observationSchemaHash ||
    branch.parentEpisode.identity.actionSchemaHash !==
      capabilities.actionSchemaHash ||
    branch.parentEpisode.identity.eventSchemaHash !==
      capabilities.eventSchemaHash
  ) {
    throw new TypeError(
      "The frozen branch source does not match this approved run."
    );
  }
  const replay = await callAdapter<GameReplayResult>(client, "game.replay", {
    trace: branch.manifest.parentTrace,
    expectedBuildSha: options.build.buildSha,
    throughStep: branch.manifest.branchStep
  });
  context.simulationWallMs += replay.durationMs;
  if (
    replay.value.replayStatus !== "verified" ||
    replay.value.firstDivergentStep !== null ||
    replay.value.replayedThroughStep !== branch.manifest.branchStep ||
    replay.value.transitionHash === null ||
    !SHA256_PATTERN.test(replay.value.transitionHash) ||
    replay.value.stateHash === null ||
    !SHA256_PATTERN.test(replay.value.stateHash)
  ) {
    throw new TypeError(
      "The parent trace could not be replayed to the exact decision state."
    );
  }
  const replayCheckpoint: PlaytestCheckpointDigest = {
    stateHash: replay.value.stateHash,
    rngCheckpoint: replay.value.rngCheckpoint
  };
  if (
    !samePlaytestCheckpoint(replayCheckpoint, branch.manifest.parentCheckpoint)
  ) {
    throw new TypeError(
      "The replayed hidden state or RNG differs from the parent checkpoint."
    );
  }
  const snapshot = await callAdapter<GameSnapshotResult>(
    client,
    "game.snapshot",
    {
      episodeId: replay.value.episodeId,
      expectedRevision: replay.value.revision,
      includeArtifact: true
    }
  );
  context.simulationWallMs += snapshot.durationMs;
  if (
    snapshot.value.snapshot === null ||
    snapshot.value.integrityHash === null ||
    snapshot.value.stateHash !== branch.manifest.parentCheckpoint.stateHash ||
    !samePlaytestCheckpoint(
      checkpointFromSnapshot(snapshot.value),
      branch.manifest.parentCheckpoint
    )
  ) {
    throw new TypeError(
      "The materialized branch snapshot does not match its source checkpoint."
    );
  }
  const fork = await callAdapter<GameForkResult>(client, "game.fork", {
    snapshot: snapshot.value.snapshot,
    alternativeActionId: branch.manifest.alternativeActionId,
    rngPolicy: branch.manifest.rngPolicy,
    rngPolicyVersion: branch.manifest.rngPolicyVersion
  });
  context.simulationWallMs += fork.durationMs;
  if (
    fork.value.initialStateHash !==
      branch.manifest.parentCheckpoint.stateHash ||
    !samePlaytestRngCheckpoint(
      fork.value.rngCheckpoint,
      branch.manifest.parentCheckpoint.rngCheckpoint
    )
  ) {
    throw new TypeError(
      "The forked state or RNG differs from its verified snapshot."
    );
  }
  const parentIdentity = branch.parentEpisode.identity;
  if (!parentIdentity.rngAlgorithm || !parentIdentity.rngVersion) {
    throw new TypeError("The parent episode is missing its RNG identity.");
  }
  context.branchSnapshot = snapshot.value;
  context.branchReplayTransitionHash = replay.value.transitionHash;
  context.branchForkStateHash = fork.value.initialStateHash;
  context.branchForkRngCheckpoint = fork.value.rngCheckpoint;
  storeReset(
    context,
    {
      episodeId: fork.value.episodeId,
      revision: fork.value.revision,
      rngProvenance: {
        algorithm: parentIdentity.rngAlgorithm,
        version: parentIdentity.rngVersion,
        initialStateHash: parentIdentity.rngInitialStateHash,
        reproducible: true
      }
    },
    startedAt
  );
  captureNotifications(context);
}

function capturePendingFrame(
  context: EpisodeExecutionContext,
  step: number,
  reference: PlaytestArtifactReference | null
): void {
  if (reference !== null) {
    context.pendingFrames.push({
      step,
      frameIndex: context.pendingFrames.length,
      reference
    });
  }
}

async function runOneStep(
  context: EpisodeExecutionContext,
  loopGuard: PlaytestLoopGuard,
  step: number
): Promise<boolean> {
  const { options, client } = context;
  if (options.signal?.aborted) throw new Error("assignment cancelled");
  if (
    options.approval.revokedAt !== null ||
    options.isApprovalActive?.() === false
  ) {
    context.failure = {
      stage: "execution",
      category: APPROVAL_REVOKED,
      code: null,
      disposition: "revoked"
    };
    context.missingReasons.add("revoked");
    return true;
  }

  const revisionBefore = context.revision;
  const simulationStarted = context.simulationWallMs;
  const observation = await callAdapter<GameObserveResult>(
    client,
    "game.observe",
    {
      episodeId: context.episodeId,
      expectedRevision: revisionBefore
    }
  );
  context.simulationWallMs += observation.durationMs;
  const visibleObservation = projectPlaytestVisibleObservation(
    observation.value.observation,
    options.observationContract
  );
  const legal = await callAdapter<{
    readonly episodeId: string;
    readonly revision: number;
    readonly actions: readonly GameLegalAction[];
  }>(client, "game.legalActions", {
    episodeId: context.episodeId,
    expectedRevision: revisionBefore
  });
  context.simulationWallMs += legal.durationMs;
  if (legal.value.actions.length === 0) {
    context.failure = {
      stage: "execution",
      category: "no-legal-actions",
      code: null,
      disposition: "unchanged"
    };
    context.missingReasons.add("unobserved");
    return true;
  }
  const legalActionIds = legal.value.actions.map((action) => action.actionId);
  let checkpoint: PlaytestCheckpointDigest | null = null;
  if (context.capabilities && supportsVerifiedBranching(context.capabilities)) {
    const snapshot = await callAdapter<GameSnapshotResult>(
      client,
      "game.snapshot",
      {
        episodeId: context.episodeId,
        expectedRevision: revisionBefore,
        includeArtifact: false
      }
    );
    context.simulationWallMs += snapshot.durationMs;
    checkpoint = checkpointFromSnapshot(snapshot.value);
    if (
      options.branch &&
      step === 0 &&
      !samePlaytestCheckpoint(
        checkpoint,
        options.branch.manifest.parentCheckpoint
      )
    ) {
      throw new TypeError(
        "The branched decision state changed before its alternative action."
      );
    }
  }
  const forcedActionId =
    options.branch && step === 0
      ? options.branch.manifest.alternativeActionId
      : null;
  const policyStarted = performance.now();
  const decision =
    forcedActionId === null
      ? await options.policy.chooseAction({
          seed: options.seed,
          episodeId: context.episodeId,
          step,
          observation: visibleObservation,
          legalActionIds
        })
      : { actionId: forcedActionId, prediction: null };
  const policyInferenceMs =
    forcedActionId === null
      ? Math.max(0, performance.now() - policyStarted)
      : 0;
  context.policyInferenceMs += policyInferenceMs;
  validatePolicyDecision(decision, legalActionIds);
  const loop = loopGuard.inspect(
    { goal: options.goal, visibleState: visibleObservation, legalActionIds },
    decision.actionId
  );
  if (loop.loop) {
    context.loopDetectedAtStep = step;
    context.failure = {
      stage: "execution",
      category: LOOP_GUARD,
      code: null,
      disposition: "aborted"
    };
    context.missingReasons.add(BUDGET_TRUNCATED);
    context.drafts.push({
      step,
      revisionBefore,
      revisionAfter: revisionBefore,
      observationHash: loop.observationHash,
      observationVisibility:
        options.observationContract.uiEquivalence === "verified"
          ? "structured"
          : "unverified",
      observation: visibleObservation,
      legalActionIds,
      selectedActionId: decision.actionId,
      preActionPrediction: decision.prediction,
      authoritativeOutcome: null,
      eventRefs: [],
      frameRef: null,
      checkpoint,
      executed: false,
      simulationWallMs: Math.round(
        context.simulationWallMs - simulationStarted
      ),
      policyInferenceMs,
      capturedEvents: []
    });
    return true;
  }

  const stepResult = await callAdapter<GameStepResult>(client, "game.step", {
    episodeId: context.episodeId,
    actionId: decision.actionId,
    expectedRevision: revisionBefore
  });
  context.simulationWallMs += stepResult.durationMs;
  context.revision = stepResult.value.revision;
  await captureEventsForStep(context, step, stepResult.value.eventIds);
  capturePendingFrame(context, step, observation.value.frame);
  const eventRefs = eventReferences(context, stepResult.value.eventIds);
  if (!eventsMatchStep(context, stepResult.value.eventIds)) {
    context.missingReasons.add(INFRASTRUCTURE_FAILED);
  }
  const draft: StepDraft = {
    step,
    revisionBefore,
    revisionAfter: context.revision,
    observationHash: loop.observationHash,
    observationVisibility:
      options.observationContract.uiEquivalence === "verified"
        ? "structured"
        : "unverified",
    observation: visibleObservation,
    legalActionIds,
    selectedActionId: decision.actionId,
    preActionPrediction: decision.prediction,
    authoritativeOutcome: null,
    eventRefs,
    frameRef: null,
    checkpoint,
    executed: true,
    simulationWallMs: 0,
    policyInferenceMs,
    capturedEvents: eventsForRevision(context, context.revision)
  };
  context.drafts.push(draft);
  if (options.signal?.aborted) throw new Error("assignment cancelled");
  const outcome = await callAdapter<GameOutcomeResult>(client, "game.outcome", {
    episodeId: context.episodeId,
    expectedRevision: context.revision
  });
  context.simulationWallMs += outcome.durationMs;
  context.drafts[context.drafts.length - 1] = {
    ...draft,
    authoritativeOutcome:
      outcome.value.state === "terminal"
        ? (options.projectPublicOutcome?.(outcome.value.outcome) ?? null)
        : null,
    simulationWallMs: Math.round(context.simulationWallMs - simulationStarted)
  };
  if (stepResult.value.terminal !== (outcome.value.state === "terminal")) {
    throw new TypeError("game.step terminal flag disagrees with game.outcome.");
  }
  context.outcome = outcome.value;
  return outcome.value.state === "terminal";
}

function importBranchSnapshot(context: EpisodeExecutionContext): void {
  const result = context.branchSnapshot;
  if (!result?.snapshot) return;
  if (context.sandboxResult === null) {
    context.missingReasons.add(INFRASTRUCTURE_FAILED);
    return;
  }
  try {
    const bytes = readStagedPlaytestArtifact(
      result.snapshot,
      context.sandboxResult.stagingDirectory,
      context.sandboxResult.artifacts
    );
    context.persistedBranchSnapshot = context.options.artifacts.writeArtifact({
      mediaType: result.snapshot.mediaType,
      bytes
    }).reference;
  } catch {
    context.missingReasons.add(INFRASTRUCTURE_FAILED);
  }
}

function importFrames(
  context: EpisodeExecutionContext
): readonly PlaytestEvidenceLocator[] {
  if (context.pendingFrames.length === 0) return [];
  if (context.sandboxResult === null) {
    context.missingReasons.add(INFRASTRUCTURE_FAILED);
    return [];
  }
  const imported = context.pendingFrames.map(
    ({ step, frameIndex, reference }) => {
      try {
        const bytes = readStagedPlaytestArtifact(
          reference,
          context.sandboxResult!.stagingDirectory,
          context.sandboxResult!.artifacts
        );
        const stored = context.options.artifacts.writeArtifact({
          mediaType: reference.mediaType,
          bytes
        });
        return {
          kind: "frame" as const,
          id: stored.reference.artifactId,
          frameIndex,
          step
        };
      } catch {
        context.missingReasons.add(INFRASTRUCTURE_FAILED);
        return null;
      }
    }
  );
  for (const locator of imported) {
    if (locator === null) continue;
    const draft = context.drafts[locator.step];
    if (draft !== undefined) {
      context.drafts[locator.step] = { ...draft, frameRef: locator };
    }
  }
  return imported.filter(
    (locator): locator is Extract<PlaytestEvidenceLocator, { kind: "frame" }> =>
      locator !== null
  );
}

function persistTrace(
  context: EpisodeExecutionContext
): PlaytestArtifactReference | null {
  if (context.drafts.length === 0) return null;
  try {
    return context.options.artifacts.writeWindow({
      entries: context.drafts.map(artifactEntry)
    }).reference;
  } catch {
    context.failure ??= {
      stage: "evidence",
      category: "trace",
      code: null,
      disposition: "unknown"
    };
    context.missingReasons.add(INFRASTRUCTURE_FAILED);
    return null;
  }
}

function evaluateMetrics(
  context: EpisodeExecutionContext,
  provenance: PlaytestProvenance
): readonly PlaytestNumericResult[] {
  if (context.outcome?.state !== "terminal" || context.reset === null) {
    return [];
  }
  try {
    return normalizeGameMetricEvaluations({
      registry: context.options.metricRegistry,
      evaluations: context.outcome.evaluations,
      workspaceId: provenance.workspaceId,
      buildSha: context.options.build.buildSha,
      rubricHash: context.options.rubricHash,
      measurementVersion: provenance.measurementVersion,
      generatedAt: provenance.generatedAt,
      scenarioId: context.options.scenarioId,
      scenarioFamily: context.options.scenarioFamily,
      cohort: context.options.policy.cohort,
      policy: context.options.policy.id,
      modality: context.options.observationContract.mode
    });
  } catch {
    context.failure ??= {
      stage: "evidence",
      category: "evaluator",
      code: null,
      disposition: "invalid-game-evaluator-output"
    };
    context.missingReasons.add(INFRASTRUCTURE_FAILED);
    return [];
  }
}

function buildBranchLineage(
  context: EpisodeExecutionContext
): PlaytestBranchLineage | null {
  const branch = context.options.branch;
  const snapshot = context.branchSnapshot;
  if (
    !branch ||
    !snapshot?.snapshot ||
    !snapshot.integrityHash ||
    !context.branchReplayTransitionHash ||
    !context.branchForkStateHash ||
    !context.branchForkRngCheckpoint
  ) {
    return null;
  }
  return {
    ...branch.manifest,
    replayTransitionHash: context.branchReplayTransitionHash,
    snapshotArtifact: context.persistedBranchSnapshot,
    snapshotIntegrityHash: snapshot.integrityHash,
    forkStateHash: context.branchForkStateHash,
    forkRngCheckpoint: context.branchForkRngCheckpoint,
    continuationPolicyId: context.options.policy.id,
    continuationPolicyVersion: context.options.policy.version
  };
}

function episodeTermination(
  context: EpisodeExecutionContext
): PlaytestEpisode["termination"] {
  if (context.outcome?.state === "terminal") {
    const executed = context.drafts.filter((draft) => draft.executed);
    return {
      reason: "game-terminal",
      step: executed.at(-1)?.step ?? null
    };
  }
  if (context.failure?.category === LOOP_GUARD) {
    return { reason: LOOP_GUARD, step: context.loopDetectedAtStep };
  }
  if (context.failure?.category === BUDGET_TRUNCATED) {
    return { reason: "step-limit", step: null };
  }
  if (context.failure?.category === "cancelled") {
    return { reason: "cancelled", step: null };
  }
  if (context.failure?.category === APPROVAL_REVOKED) {
    return { reason: APPROVAL_REVOKED, step: null };
  }
  return { reason: "runtime-failure", step: null };
}

function assembleEpisode(
  context: EpisodeExecutionContext,
  trace: PlaytestArtifactReference | null,
  frameRefs: readonly PlaytestEvidenceLocator[]
): PlaytestEpisode | null {
  const { options } = context;
  if (context.reset === null || context.capabilities === null) return null;
  const status = statusForFailure(context.failure);
  if (status === BUDGET_TRUNCATED) context.missingReasons.add(BUDGET_TRUNCATED);
  if (context.outcome === null && status !== "cancelled") {
    context.missingReasons.add("unobserved");
  }
  const classifiedOutcome =
    context.outcome?.state === "terminal"
      ? (options.classifyOutcome?.(context.outcome.outcome) ??
        ((PLAYTESTS_GAME_OUTCOMES as readonly string[]).includes(
          typeof context.outcome.outcome === "string"
            ? context.outcome.outcome
            : ""
        )
          ? (context.outcome.outcome as PlaytestEpisode["outcome"])
          : "unknown"))
      : "unknown";
  if (
    !(PLAYTESTS_GAME_OUTCOMES as readonly string[]).includes(classifiedOutcome)
  ) {
    context.failure ??= {
      stage: "evidence",
      category: "evaluator",
      code: null,
      disposition: "invalid-outcome-classification"
    };
    context.missingReasons.add(INFRASTRUCTURE_FAILED);
  }
  const generatedAt = new Date((options.now ?? Date.now)()).toISOString();
  const provenance: PlaytestProvenance = {
    workspaceId: options.approval.workspaceId,
    buildSha: options.build.buildSha,
    measurementVersion: options.measurementVersion,
    generatedAt
  };
  const identity: PlaytestEpisodeIdentity = {
    workspaceId: options.approval.workspaceId,
    repository: options.repository,
    buildSha: options.build.buildSha,
    gameBuild: context.capabilities.engineBuild,
    scenarioId: options.scenarioId,
    configHash: options.build.configHash,
    seed: options.seed,
    rngInitialStateHash: context.reset.rngProvenance.initialStateHash,
    rngAlgorithm: context.reset.rngProvenance.algorithm,
    rngVersion: context.reset.rngProvenance.version,
    policyId: options.policy.id,
    policyVersion: options.policy.version,
    modelId: options.policy.modelId,
    modelRevision: options.policy.modelRevision,
    observationSchemaHash: context.capabilities.observationSchemaHash,
    actionSchemaHash: context.capabilities.actionSchemaHash,
    eventSchemaHash: context.capabilities.eventSchemaHash,
    protocolVersion: 1,
    runtimeVersion: options.runtimeVersion,
    environmentHash: options.environmentHash
  };
  const metrics = evaluateMetrics(context, provenance);
  const isComplete =
    status === "completed" && context.missingReasons.size === 0;
  const branchLineage = buildBranchLineage(context);
  const sourceRevisionVerified = COMMIT_PATTERN.test(options.build.buildSha);
  const executionProvenance = {
    mode: "adapter-accelerated",
    source: {
      kind: "repo-checkout",
      repository: options.repository,
      revision: sourceRevisionVerified ? options.build.buildSha : null,
      revisionConfidence: sourceRevisionVerified ? "verified" : "unknown",
      checkoutState: sourceRevisionVerified ? "clean" : "unknown",
      artifactFingerprint: null,
      targetId: null,
      targetOrigin: null
    },
    observationSource: "engine-adapter",
    actionSource: "engine-policy",
    derivedFrom:
      branchLineage === null
        ? null
        : {
            episodeId: branchLineage.parentEpisodeId,
            stepId: branchLineage.branchStep,
            stateDigest: branchLineage.forkStateHash
          }
  } as const;
  assertPlaytestExecutionProvenance(executionProvenance);
  return {
    schema: PLAYTESTS_EPISODE_SCHEMA,
    episodeId: playtestEpisodeRecordId(options.batchId, options.assignmentId),
    revision: 1,
    batchId: options.batchId,
    assignmentId: options.assignmentId,
    branchLineage,
    executionProvenance,
    identity,
    scenarioFamily: options.scenarioFamily,
    policyCohort: options.policy.cohort,
    strategy: options.policy.strategy,
    status,
    termination: episodeTermination(context),
    outcome:
      context.outcome?.state === "terminal" ? classifiedOutcome : "unknown",
    outcomeMetrics:
      context.outcome === null
        ? {}
        : validateOutcomeMetrics(context.outcome.metrics),
    completionCounts: completionCounts(
      status,
      context.startedAt !== null,
      context.outcome?.state === "terminal"
    ),
    replayStatus:
      context.capabilities.deterministic.traceReplayable &&
      context.reset.rngProvenance.reproducible
        ? "trace-replayable"
        : "non-reproducible",
    trace:
      trace === null ? null : { kind: "replay-segment", id: trace.artifactId },
    frames: frameRefs,
    stepCount: context.drafts.filter((draft) => draft.executed).length,
    metrics,
    findingIds: [],
    assignedAt: context.assignedAt,
    startedAt: context.startedAt,
    completedAt: context.startedAt === null ? null : generatedAt,
    simulationWallMs: Math.round(context.simulationWallMs),
    logicalTicks: context.drafts.filter((draft) => draft.executed).length,
    policyInferenceMs: Math.round(context.policyInferenceMs),
    nativeDurationMs: null,
    completeness: isComplete
      ? "complete"
      : context.drafts.length > 0
        ? "partial"
        : "unknown",
    missingReasons: [...context.missingReasons]
  };
}

async function closeSandboxAfterAbort(
  context: EpisodeExecutionContext
): Promise<void> {
  try {
    await context.client.cancelInflightRequests();
  } catch {
    // Process-tree termination below remains the final cancellation boundary.
  }
  await context.options.sandbox.cancel();
  await context.options.cancelProcess?.("playtest episode cancelled");
}

async function runStepsRecursively(
  context: EpisodeExecutionContext,
  guard: PlaytestLoopGuard,
  step: number
): Promise<void> {
  if (step >= context.options.maxSteps) return;
  if (await runOneStep(context, guard, step)) return;
  await runStepsRecursively(context, guard, step + 1);
}

function bindAbortCancellation(context: EpisodeExecutionContext): () => void {
  const listener = (): void => {
    if (!context.options.signal?.aborted) return;
    void closeSandboxAfterAbort(context).catch(() => undefined);
  };
  context.options.signal?.addEventListener("abort", listener, { once: true });
  return () => context.options.signal?.removeEventListener("abort", listener);
}

async function runSteps(context: EpisodeExecutionContext): Promise<void> {
  if (context.options.signal?.aborted) throw new Error("assignment cancelled");
  const guard = new PlaytestLoopGuard(context.options.goal);
  await runStepsRecursively(context, guard, 0);
  if (context.failure === null && context.outcome?.state !== "terminal") {
    context.failure = {
      stage: "execution",
      category: BUDGET_TRUNCATED,
      code: null,
      disposition: "unchanged"
    };
    context.missingReasons.add(BUDGET_TRUNCATED);
  }
}

function contextFor(
  options: PlaytestEpisodeRunOptions
): EpisodeExecutionContext {
  return {
    options,
    client: new PlaytestAdapterClient(options.sandbox.streams),
    assignedAt: new Date((options.now ?? Date.now)()).toISOString(),
    startedAt: null,
    events: [],
    eventById: new Map(),
    drafts: [],
    pendingFrames: [],
    missingReasons: new Set(),
    branchSnapshot: null,
    branchReplayTransitionHash: null,
    branchForkStateHash: null,
    branchForkRngCheckpoint: null,
    persistedBranchSnapshot: null,
    capabilities: null,
    reset: null,
    episodeId: `unstarted:${options.batchId}`,
    revision: 0,
    simulationWallMs: 0,
    policyInferenceMs: 0,
    outcome: null,
    failure: null,
    loopDetectedAtStep: null,
    unsubscribe: () => {},
    sandboxResult: null
  };
}

/**
 * Run one episode in an already launched, approved Docker sandbox. An attempt
 * that fails before game.reset has no episode ID and returns `episode: null`;
 * the owning batch records that assigned infrastructure failure separately.
 */
export async function runPlaytestEpisode(
  options: PlaytestEpisodeRunOptions
): Promise<PlaytestEpisodeRunResult> {
  assertRunInputs(options);
  const context = contextFor(options);
  const removeAbortListener = bindAbortCancellation(context);
  try {
    await negotiateAndInitialize(context);
    await runSteps(context);
  } catch (error) {
    context.failure = failureFor(error, options.signal);
    if (context.failure.category === "cancelled") {
      context.missingReasons.add("cancelled");
    } else if (context.failure.category === APPROVAL_REVOKED) {
      context.missingReasons.add("revoked");
    } else {
      context.missingReasons.add(INFRASTRUCTURE_FAILED);
    }
  } finally {
    context.unsubscribe();
    removeAbortListener();
  }
  if (options.signal?.aborted && context.failure === null) {
    context.failure = {
      stage: "execution",
      category: "cancelled",
      code: null,
      disposition: "aborted"
    };
    context.missingReasons.add("cancelled");
  }

  const shouldCloseGracefully =
    context.failure === null ||
    context.failure.category === LOOP_GUARD ||
    context.failure.category === BUDGET_TRUNCATED;
  try {
    if (shouldCloseGracefully && !options.signal?.aborted) {
      options.sandbox.stdin.end();
    } else {
      await options.sandbox.cancel();
    }
    context.sandboxResult = await options.sandbox.result;
  } catch (error) {
    if (context.failure === null) {
      context.failure = failureFor(error, options.signal);
      context.missingReasons.add(INFRASTRUCTURE_FAILED);
    }
  }

  importBranchSnapshot(context);
  const frames = importFrames(context);
  const trace = persistTrace(context);
  const episode = assembleEpisode(context, trace, frames);
  const steps =
    trace === null
      ? []
      : context.drafts.map((draft) => episodeStep(draft, trace.artifactId));
  try {
    await options.sandbox.cleanup();
  } catch {
    context.missingReasons.add(INFRASTRUCTURE_FAILED);
  }
  return {
    capabilities: context.capabilities,
    episode,
    steps,
    traceReference: trace,
    sandboxResult: context.sandboxResult,
    failure: context.failure,
    loopDetectedAtStep: context.loopDetectedAtStep
  };
}
