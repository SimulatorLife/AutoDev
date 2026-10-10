/** Runtime-hosted Playtesting MCP server implementation. */
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  assertPlaytestFindingEvidenceStatusConsistent,
  assertPlaytestSessionReviewHasEvidence,
  buildPlaytestFindingIdentity,
  type PlaytestBatch,
  type PlaytestCapabilityAdvertisement,
  type PlaytestComparison,
  type PlaytestCompletionCounts,
  type PlaytestEpisode,
  type PlaytestEvidenceLocator,
  type PlaytestFinding,
  type PlaytestFindingIdentity,
  type PlaytestKnownEvidenceIndex,
  type PlaytestMissingReason,
  PLAYTESTS_BATCH_SCHEMA,
  PLAYTESTS_EPISODE_SCHEMA,
  PLAYTESTS_EPISODE_STATES,
  PLAYTESTS_FINDING_STATUSES,
  PLAYTESTS_GAME_OUTCOMES,
  PLAYTESTS_MEASUREMENT_VERSION,
  PLAYTESTS_SESSION_REVIEW_SCHEMA,
  PLAYTESTS_SEVERITIES,
  PLAYTESTS_VERIFICATION_STAGES,
  playtestFindingIdentityHashInput,
  playtestFindingIdFromFingerprint,
  type PlaytestSessionReview,
  type WorkspacePlaytestApproval
} from "@simulatorlife/autodev-core";
import {
  ConfigRepository,
  type WorkspaceCatalogRead
} from "@simulatorlife/autodev-data";
import {
  PlaytestInvalidCursorError,
  PlaytestSourceUnavailableError
} from "@simulatorlife/autodev-data/playtesting";
import type { WorkspacePlaytestApprovalRepository } from "@simulatorlife/autodev-data/workspaces";
import { z } from "zod/v4";

import type { PlaytestingReadRepository } from "../control-api/playtesting.ts";
import { writeErrorLine } from "../shared/output.ts";
import type {
  PlaytestArtifactStore,
  PlaytestArtifactWindowReadResult
} from "./artifact-store.ts";
import {
  launchPlaytestSandbox,
  PlaytestSandboxApprovalError,
  PlaytestSandboxExecutionError,
  type PlaytestSandboxHandle,
  PlaytestSandboxUnavailableError,
  type PreparedPlaytestSandbox,
  preparePlaytestSandbox
} from "./docker-sandbox.ts";
import {
  type PlaytestEpisodeRunFailure,
  type PlaytestEpisodeRunOptions,
  type PlaytestEpisodeRunResult,
  runPlaytestEpisode
} from "./episode-runner.ts";
import {
  createSeededRandomPlaytestPolicy,
  type PlaytestPolicy
} from "./policies.ts";

export class PlaytestMcpAuthorizationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PlaytestMcpAuthorizationError";
  }
}

export class PlaytestMcpValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PlaytestMcpValidationError";
  }
}

export class PlaytestMcpUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PlaytestMcpUnavailableError";
  }
}

/** Trusted Runtime identity accepted by the reusable playtesting run owner. */
export interface PlaytestRunControlActor {
  readonly workspaceId: string;
  readonly role: string;
  readonly actor: string;
  readonly taskId?: string;
  readonly runId?: string;
}

export interface PlaytestMcpSession extends PlaytestRunControlActor {
  readonly repositoryRoot?: string | null;
}

export interface PlaytestMcpSessionProvider {
  current(): Promise<PlaytestMcpSession> | PlaytestMcpSession;
}

export interface PlaytestActiveRunSummary {
  readonly batchId: string;
  readonly scenarioId: string;
  readonly createdAt: string;
}

export interface PlaytestRunCancellationResult {
  readonly batchId: string;
  readonly cancellationRequested: boolean;
}

export interface PlaytestRunRequest {
  readonly workspaceId?: string | undefined;
  readonly scenario: string;
  readonly policy: string;
  readonly seed: string;
  readonly goal?: string | undefined;
  readonly maxSteps?: number | undefined;
}

export interface PlaytestRunStatus {
  readonly batchId: string;
  readonly status:
    "running" | "persisting" | "completed" | "failed" | "cancelled";
  readonly cancellationReason: RunCancellationReason | null;
  readonly result: unknown | null;
  readonly error: {
    readonly code: string;
    readonly category: string;
    readonly retryable: boolean;
    readonly message: string;
  } | null;
}

/**
 * Shared Runtime-owned run/cancellation surface. The Control API hosts the
 * process singleton; the stdio MCP facade calls it through the scoped,
 * loopback-only Control API client instead of creating a second run registry.
 */
export interface PlaytestRunCapabilities {
  readonly workspaceId: string;
  readonly workspaceEnabled: boolean;
  readonly workspaceCatalog: WorkspaceCatalogRead["status"];
  readonly approved: boolean;
  readonly approvalRevision: number | null;
  readonly buildSha: string | null;
  readonly gameBuild: string | null;
  readonly allowedScenarios: readonly string[];
  readonly approvedPolicies: readonly string[];
  readonly supportedPolicies: readonly string[];
  readonly runnablePolicies: readonly string[];
  readonly unsupportedApprovedPolicies: readonly string[];
  readonly configurationStatus: "validated" | "invalid" | "not-checked";
  readonly runnableAssignments: readonly {
    readonly scenarioId: string;
    readonly scenarioFamily: string;
    readonly policyId: string;
    readonly policyVersion: string;
    readonly cohort: string;
    readonly strategy: string;
    readonly maxStepsPerEpisode: number;
  }[];
  readonly policyProfiles: readonly {
    readonly policyId: string;
    readonly version: string;
    readonly cohort: string;
    readonly strategy: string;
  }[];
  readonly limits: WorkspacePlaytestApproval["limits"] | null;
  readonly issueReporting: "disabled" | "review";
  readonly humanStudyAllowed: boolean;
  readonly revokedAt: string | null;
  readonly runPreflight: "required-at-start";
}

export interface PlaytestRunControl {
  getCapabilities(
    session: PlaytestMcpSession,
    workspaceId: string
  ): PlaytestRunCapabilities | Promise<PlaytestRunCapabilities>;
  startRun(
    session: PlaytestMcpSession,
    request: PlaytestRunRequest
  ): Promise<{ readonly batchId: string; readonly status: "running" }>;
  listActiveRuns(
    session: PlaytestRunControlActor,
    workspaceId: string
  ):
    | readonly PlaytestActiveRunSummary[]
    | Promise<readonly PlaytestActiveRunSummary[]>;
  cancelRun(
    session: PlaytestRunControlActor,
    workspaceId: string,
    batchId: string
  ): PlaytestRunCancellationResult | Promise<PlaytestRunCancellationResult>;
  waitForRun(
    session: PlaytestRunControlActor,
    workspaceId: string,
    batchId: string,
    waitMs: number
  ): Promise<PlaytestRunStatus>;
}

/** Process owner lifecycle used by Runtime shutdown; MCP clients do not implement it. */
export interface PlaytestRunOwner extends PlaytestRunControl {
  shutdown(): Promise<void>;
}

export type PlaytestMcpServer = McpServer & {
  readonly playtestRunControl: PlaytestRunControl;
};

export interface PlaytestingRepositoryOps extends PlaytestingReadRepository {
  insertBatch(batch: PlaytestBatch): Promise<void>;
  insertEpisode(episode: PlaytestEpisode): Promise<void>;
  insertReview(review: PlaytestSessionReview): Promise<void>;
  insertFinding(workspaceId: string, finding: PlaytestFinding): Promise<void>;
  getFinding(
    workspaceId: string,
    findingId: string
  ): Promise<PlaytestFinding | null>;
  /** Latest revision of the finding with this workspace+identity fingerprint, or null. */
  getLatestFindingByFingerprint(
    workspaceId: string,
    fingerprint: string
  ): Promise<PlaytestFinding | null>;
  getLatestReview(
    workspaceId: string,
    episodeId: string,
    reviewId: string
  ): Promise<PlaytestSessionReview | null>;
  getLatestComparison(
    workspaceId: string,
    comparisonId: string
  ): Promise<PlaytestComparison | null>;
}

export interface PlaytestRunControlOptions {
  readonly artifactStoreForWorkspace: (
    workspaceId: string
  ) => PlaytestArtifactStore;
  readonly playtestRepository?: PlaytestingRepositoryOps | undefined;
  readonly approvalRepository?: WorkspacePlaytestApprovalRepository | undefined;
  readonly runEpisodeHandler?: (
    options: PlaytestEpisodeRunOptions
  ) => Promise<PlaytestEpisodeRunResult>;
  readonly launchSandboxHandler?: (
    prepared: PreparedPlaytestSandbox
  ) => Promise<PlaytestSandboxHandle>;
  /** Reads the exact target-owned config/observation/rubric bound to an approval. */
  readonly prepareSandboxHandler?: (
    approval: WorkspacePlaytestApproval
  ) => PreparedPlaytestSandbox;
  /** Overridable for tests; defaults to the real canonical workspace catalog. */
  readonly readWorkspaceCatalog?: () => WorkspaceCatalogRead;
}

export interface PlaytestMcpOptions extends PlaytestRunControlOptions {
  readonly sessionProvider: PlaytestMcpSessionProvider;
  /** Process-shared Runtime owner; the MCP facade never creates another scheduler. */
  readonly playtestRunControl: PlaytestRunControl;
}

/** Explicit supported policy baselines. No generic scored/heuristic fallback. */
const SUPPORTED_POLICY_IDS: ReadonlySet<string> = new Set(["random"]);
const RUNNER_ROLES = new Set(["playtester", "root", "orchestrator"]);
const REVIEWER_ROLE = "playtest-analyst" as const;
const RUN_STATUS_READER_ROLES = new Set([
  ...RUNNER_ROLES,
  REVIEWER_ROLE,
  "validator",
  "operator",
  "control-viewer"
]);
const APPROVAL_POLL_INTERVAL_MS = 50;
const RUN_SHUTDOWN_GRACE_MS = 2000;
const WORKSPACE_ID_PATTERN = /^[^/\s]+\/[^/\s]+$/u;
const SAFE_SESSION_VALUE_PATTERN = /^[A-Za-z0-9@._:-]{1,256}$/u;
const SHA256_PATTERN = /^[a-f\d]{64}$/iu;
const REVIEWABLE_STATUSES = ["hypothesis", "not observed"] as const;

interface ActivePlaytestRun {
  readonly batchId: string;
  readonly workspaceId: string;
  readonly buildSha: string;
  readonly ownerActor: string;
  readonly ownerTaskId: string | undefined;
  readonly ownerRunId: string | undefined;
  readonly scenarioId: string;
  readonly createdAt: string;
  readonly controller: AbortController;
  phase: "running" | "persisting";
  reason: "cancelled" | "approval-revoked" | "workspace-disabled" | null;
  sandbox: PlaytestSandboxHandle | null;
  readonly completion: Promise<PlaytestRunStatus>;
  readonly resolveCompletion: (status: PlaytestRunStatus) => void;
}

type RunCancellationReason = Exclude<ActivePlaytestRun["reason"], null>;

interface PlaytestRunExecutionResult {
  readonly batchId: string;
  readonly episodeId: string | null;
  readonly status: PlaytestEpisode["status"] | "failed";
  readonly outcome: PlaytestEpisode["outcome"];
  readonly stepsCount: number;
  readonly durationMs: number | null;
  readonly traceReference: PlaytestEpisodeRunResult["traceReference"];
  readonly failure: {
    readonly stage: string;
    readonly category: string;
    readonly code: number | null;
  } | null;
  readonly cancellation: RunCancellationReason | null;
  readonly numericResults: PlaytestEpisode["metrics"];
}

function isReviewerRole(role: string): role is typeof REVIEWER_ROLE {
  return role === REVIEWER_ROLE;
}

function assertSessionIdentity(session: PlaytestRunControlActor): void {
  if (
    !WORKSPACE_ID_PATTERN.test(session.workspaceId) ||
    !SAFE_SESSION_VALUE_PATTERN.test(session.role) ||
    !SAFE_SESSION_VALUE_PATTERN.test(session.actor) ||
    (session.taskId !== undefined &&
      !SAFE_SESSION_VALUE_PATTERN.test(session.taskId)) ||
    (session.runId !== undefined &&
      !SAFE_SESSION_VALUE_PATTERN.test(session.runId))
  ) {
    throw new PlaytestMcpAuthorizationError(
      "The trusted playtesting session identity is invalid."
    );
  }
}

const evidenceLocatorSchema = z.strictObject({
  kind: z.enum([
    "episode",
    "event",
    "frame",
    "review",
    "finding",
    "comparison",
    "replay-segment"
  ]),
  id: z.string().min(1).max(256),
  subId: z.string().max(256).optional(),
  stepIndex: z.number().int().min(0).optional(),
  frameIndex: z.number().int().min(0).optional(),
  timestampMs: z.number().min(0).optional()
});

/**
 * Strict finding input. Caller-supplied event types, episode scope, IDs,
 * fingerprints, and revisions are rejected: Runtime derives event types
 * from cited persisted trace entries and derives scope from the stored
 * episode. Only the proposed mechanic/action/witness and descriptive
 * finding content cross this boundary. Workflow state, prevalence,
 * cohorts, external links and verification dates are supplied only by their
 * source-owning Runtime/Data workflows.
 */
const findingIdentityFailureSignatureSchema = z.strictObject({
  action: z.string().min(1).max(200).nullable().optional(),
  witness: z.string().min(1).max(200)
});

const findingIdentityInputSchema = z.strictObject({
  mechanicKey: z.string().min(1).max(200),
  failureSignature: findingIdentityFailureSignatureSchema
});

const findingSchema = z.strictObject({
  identity: findingIdentityInputSchema,
  title: z.string().min(1).max(500),
  description: z.string().min(1).max(10_000),
  evidenceStatus: z.literal("hypothesis"),
  evidenceRefs: z.array(evidenceLocatorSchema)
});

const playtestRunRequestSchema = z.strictObject({
  workspaceId: z.string().min(1).max(256).optional(),
  scenario: z.string().min(1).max(256),
  policy: z.string().min(1).max(256),
  seed: z.string().min(1).max(256),
  goal: z.string().max(1000).optional(),
  maxSteps: z.number().int().min(1).max(100_000).optional()
});

/**
 * §11's missed-known-issue / duplicate-flood gate lives here: the stable
 * `findingId` is derived from the SHA-256 fingerprint of the canonical
 * identity (not from anything a caller controls), so the same underlying
 * defect across builds/policies/seed/batches deterministically produces the
 * same finding ID. Prefix is fixed so Data/Console can recognize the
 * namespace without parsing the hash.
 */
function deriveStableFindingId(fingerprint: string): string {
  if (!SHA256_PATTERN.test(fingerprint)) {
    throw new PlaytestMcpValidationError(
      "Computed fingerprint is not a SHA-256 hexadecimal digest."
    );
  }
  return playtestFindingIdFromFingerprint(fingerprint);
}

/**
 * Compute the SHA-256 fingerprint over `playtestFindingIdentityHashInput`.
 * Runtime owns the actual hashing; Core never computes the digest itself,
 * matching the division of responsibility used by `playtestBenchmarkHashInput`
 * in `core/src/playtesting/benchmark.ts`.
 */
function computeFindingFingerprint(identity: PlaytestFindingIdentity): string {
  return createHash("sha256")
    .update(playtestFindingIdentityHashInput(identity))
    .digest("hex");
}

/** JSON-stable key for a locator used by the duplicate-flood merge. */
function evidenceLocatorKey(locator: PlaytestEvidenceLocator): string {
  const parts = [
    locator.kind,
    locator.id,
    locator.step ?? "",
    locator.frameIndex ?? "",
    locator.phaseId ?? "",
    "stepIndex" in locator ? String(locator.stepIndex ?? "") : "",
    "frameIndex" in locator ? String(locator.frameIndex ?? "") : ""
  ];
  return JSON.stringify(parts);
}

function unionEvidenceRefs(
  a: readonly PlaytestEvidenceLocator[],
  b: readonly PlaytestEvidenceLocator[]
): readonly PlaytestEvidenceLocator[] {
  const seen = new Map<string, PlaytestEvidenceLocator>();
  for (const locator of a) seen.set(evidenceLocatorKey(locator), locator);
  for (const locator of b) seen.set(evidenceLocatorKey(locator), locator);
  // Filter out any locator-derived artifacts whose `frameIndex` is set to
  // `undefined` (allowed in zod's input, forbidden by
  // exactOptionalPropertyTypes in the canonical type).
  return [...seen.values()].filter(
    (locator) =>
      !("frameIndex" in locator) || typeof locator.frameIndex === "number"
  );
}

function unionStringSet(
  a: readonly string[],
  b: readonly string[]
): readonly string[] {
  return [...new Set([...a, ...b])];
}

/**
 * Per-(workspace, fingerprint) in-process serialization point for finding
 * writes. The MCP server reads the latest revision and persists the
 * resulting append inside the SAME critical section keyed by
 * `workspaceId::fingerprint`, so two concurrent submitReview calls that
 * resolve to the same identity can never both observe the same "latest
 * version" and race to insert a colliding revision. ClickHouse does NOT
 * enforce cross-process uniqueness of `(workspace_id, fingerprint,
 * version)` -- a distributed Runtime would still need a coordinating
 * store (e.g. a lease table or a single-writer queue) to guarantee it;
 * this in-process map only guarantees ordering within one Runtime
 * process. Completed chains are removed from the map once settled so it
 * never grows unbounded across the process lifetime.
 */
const findingAppendLocks = new Map<string, Promise<unknown>>();
function serializeFindingAppend<T>(
  workspaceId: string,
  fingerprint: string,
  operation: () => Promise<T>
): Promise<T> {
  const key = JSON.stringify([workspaceId, fingerprint]);
  const previous = findingAppendLocks.get(key) ?? Promise.resolve();
  const settled = previous.catch(() => undefined).then(operation);
  // Track the chain so later callers queue behind it, but never surface
  // this tracked promise's rejection itself (the caller's own awaited
  // `settled` promise still rejects normally).
  const tracked = settled.then(
    () => undefined,
    () => undefined
  );
  findingAppendLocks.set(key, tracked);
  void tracked.then(() => {
    // Clean up the completed lock so it does not leak, but only if no
    // newer waiter has already replaced it.
    if (findingAppendLocks.get(key) === tracked) {
      findingAppendLocks.delete(key);
    }
  });
  return settled;
}

function authorizeWorkspace(
  requestedWorkspaceId: string | undefined,
  session: PlaytestRunControlActor
): string {
  assertSessionIdentity(session);
  if (requestedWorkspaceId && requestedWorkspaceId !== session.workspaceId) {
    if (
      session.role !== "root" &&
      session.role !== "orchestrator" &&
      session.role !== "operator"
    ) {
      throw new PlaytestMcpAuthorizationError(
        'Cross-workspace playtest operation is not permitted (requested: "' +
          requestedWorkspaceId +
          '", session: "' +
          session.workspaceId +
          '").'
      );
    }
    return requestedWorkspaceId;
  }
  return session.workspaceId;
}

/** Confirm the workspace is a real, operator-enabled entry in the canonical catalog. */
function assertCanonicalWorkspaceEnabled(
  workspaceId: string,
  readWorkspaceCatalog: () => WorkspaceCatalogRead
): WorkspaceCatalogRead["workspaces"][number] {
  const catalog = readWorkspaceCatalog();
  if (catalog.status !== "valid") {
    throw new PlaytestMcpUnavailableError(
      "The canonical workspace catalog is unavailable."
    );
  }
  const entry = catalog.workspaces.find(
    (workspace) => workspace.id === workspaceId
  );
  if (!entry || !entry.enabled) {
    throw new PlaytestMcpAuthorizationError(
      'Workspace "' + workspaceId + '" is not an enabled canonical workspace.'
    );
  }
  return entry;
}

function assertRunStatusReader(session: PlaytestRunControlActor): void {
  assertSessionIdentity(session);
  if (!RUN_STATUS_READER_ROLES.has(session.role)) {
    throw new PlaytestMcpAuthorizationError(
      "Run status is not available to this playtesting role."
    );
  }
}

function authorizeExistingRunWorkspace(
  session: PlaytestRunControlActor,
  workspaceId: string,
  readWorkspaceCatalog: () => WorkspaceCatalogRead
): string {
  const authorizedWorkspaceId = authorizeWorkspace(workspaceId, session);
  const catalog = readWorkspaceCatalog();
  if (catalog.status !== "valid") {
    throw new PlaytestMcpUnavailableError(
      "The canonical workspace catalog is unavailable."
    );
  }
  const workspace = catalog.workspaces.find(
    (entry) => entry.id === authorizedWorkspaceId
  );
  if (!workspace) {
    throw new PlaytestMcpAuthorizationError(
      "The requested workspace is not in the canonical catalog."
    );
  }
  assertSessionWorkspaceRole(session, workspace);
  return authorizedWorkspaceId;
}

function assertSessionWorkspaceRole(
  session: PlaytestRunControlActor,
  workspace: WorkspaceCatalogRead["workspaces"][number]
): void {
  if (
    session.role === "operator" ||
    session.role === "root" ||
    session.role === "orchestrator" ||
    session.role === "control-viewer"
  )
    return;
  if (
    workspace.agentRoles !== null &&
    !workspace.agentRoles.includes(session.role)
  ) {
    throw new PlaytestMcpAuthorizationError(
      "The trusted session role is not enabled for this workspace."
    );
  }
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return "[" + value.map(canonicalJson).join(",") + "]";
  }
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return (
      "{" +
      Object.keys(record)
        .sort()
        .map((key) => JSON.stringify(key) + ":" + canonicalJson(record[key]))
        .join(",") +
      "}"
    );
  }
  return JSON.stringify(value);
}

function approvalIsStillExact(
  expected: WorkspacePlaytestApproval,
  approvalRepository: WorkspacePlaytestApprovalRepository,
  readWorkspaceCatalog: () => WorkspaceCatalogRead
): RunCancellationReason | null {
  try {
    const current = approvalRepository.read(expected.workspaceId);
    if (
      !current ||
      current.revokedAt !== null ||
      canonicalJson(current) !== canonicalJson(expected)
    ) {
      return "approval-revoked";
    }
    const catalog = readWorkspaceCatalog();
    if (
      catalog.status !== "valid" ||
      !catalog.workspaces.some(
        (workspace) =>
          workspace.id === expected.workspaceId && workspace.enabled
      )
    ) {
      return "workspace-disabled";
    }
    return null;
  } catch {
    // Approval/catalog read failures revoke the execution authority fail-closed.
    return "approval-revoked";
  }
}

function currentRuntimeVersion(): string {
  try {
    const manifest = JSON.parse(
      readFileSync(new URL("../../package.json", import.meta.url), "utf8")
    ) as { version?: unknown };
    return typeof manifest.version === "string" && manifest.version.length > 0
      ? manifest.version
      : "unknown";
  } catch {
    return "unknown";
  }
}

const RUNTIME_VERSION = currentRuntimeVersion();

function playtestEnvironmentHash(
  approval: WorkspacePlaytestApproval,
  runtimeVersion: string
): string {
  return createHash("sha256")
    .update(
      canonicalJson({
        buildSha: approval.buildSha,
        configHash: approval.playtestConfigHash,
        adapterImageDigest: approval.adapterImageDigest,
        runtimeVersion
      })
    )
    .digest("hex");
}

function batchStatusForEpisode(
  episode: PlaytestEpisode
): PlaytestBatch["status"] {
  if (episode.status === "completed") return "completed";
  if (episode.status === "cancelled") return "cancelled";
  if (episode.status === "budget-truncated") return "truncated";
  return "failed";
}

function attemptCounts(
  status: "running" | "failed" | "cancelled",
  started = false
): PlaytestCompletionCounts {
  return {
    assigned: 1,
    started: started ? 1 : 0,
    completed: 0,
    crashed: 0,
    infrastructureFailed: status === "failed" ? 1 : 0,
    cancelled: status === "cancelled" ? 1 : 0,
    budgetTruncated: 0,
    reviewed: 0,
    eligible: 0
  };
}

function batchForAttempt(input: {
  readonly approval: WorkspacePlaytestApproval;
  readonly prepared: PreparedPlaytestSandbox;
  readonly batchId: string;
  readonly scenario: string;
  readonly policy: PlaytestPolicy;
  readonly maxSteps: number;
  readonly revision: number;
  readonly status: "running" | "failed" | "cancelled";
  readonly counts: PlaytestCompletionCounts;
  readonly capabilities: PlaytestCapabilityAdvertisement | null;
  readonly createdAt: string;
  readonly completedAt: string | null;
}): PlaytestBatch {
  const { approval, prepared, batchId, scenario, policy, maxSteps } = input;
  const generatedAt = input.completedAt ?? input.createdAt;
  return {
    schema: PLAYTESTS_BATCH_SCHEMA,
    batchId,
    revision: input.revision,
    workspaceId: approval.workspaceId,
    repository: approval.workspaceId,
    buildSha: approval.buildSha,
    gameBuild: input.capabilities?.engineBuild ?? null,
    configHash: approval.playtestConfigHash,
    rubricHash: prepared.rubricHash,
    actionSchemaHash: input.capabilities?.actionSchemaHash ?? null,
    observationSchemaHash: input.capabilities?.observationSchemaHash ?? null,
    eventSchemaHash: input.capabilities?.eventSchemaHash ?? null,
    measurementVersion: PLAYTESTS_MEASUREMENT_VERSION,
    protocolVersion: 1,
    policyIds: [policy.id],
    cohortIds: [policy.cohort],
    scenarioIds: [scenario],
    samplingPlan: null,
    status: input.status,
    counts: input.counts,
    budget: {
      assignedEpisodes: 1,
      maxStepsPerEpisode: maxSteps,
      wallTimeMs: approval.limits.wallTimeMs,
      critiqueBudget: approval.limits.critiqueCount,
      actualCritiques: 0
    },
    startedAt: input.counts.started > 0 ? input.createdAt : null,
    completedAt: input.completedAt,
    createdAt: input.createdAt,
    provenance: {
      workspaceId: approval.workspaceId,
      buildSha: approval.buildSha,
      measurementVersion: PLAYTESTS_MEASUREMENT_VERSION,
      generatedAt
    },
    evaluationIds: [],
    spanIds: []
  };
}

function batchForEpisode(input: {
  readonly episode: PlaytestEpisode;
  readonly approval: WorkspacePlaytestApproval;
  readonly rubricHash: string;
  readonly batchId: string;
  readonly maxSteps: number;
}): PlaytestBatch {
  const { episode, approval, rubricHash, batchId, maxSteps } = input;
  const generatedAt = new Date().toISOString();
  return {
    schema: PLAYTESTS_BATCH_SCHEMA,
    batchId,
    revision: 2,
    workspaceId: approval.workspaceId,
    repository: approval.workspaceId,
    buildSha: episode.identity.buildSha,
    gameBuild: episode.identity.gameBuild,
    configHash: episode.identity.configHash,
    rubricHash,
    actionSchemaHash: episode.identity.actionSchemaHash,
    observationSchemaHash: episode.identity.observationSchemaHash,
    eventSchemaHash: episode.identity.eventSchemaHash,
    measurementVersion: PLAYTESTS_MEASUREMENT_VERSION,
    protocolVersion: episode.identity.protocolVersion,
    policyIds: [episode.identity.policyId],
    cohortIds: [episode.policyCohort],
    scenarioIds: [episode.identity.scenarioId],
    samplingPlan: null,
    status: batchStatusForEpisode(episode),
    counts: episode.completionCounts,
    budget: {
      assignedEpisodes: episode.completionCounts.assigned,
      maxStepsPerEpisode: maxSteps,
      wallTimeMs: approval.limits.wallTimeMs,
      critiqueBudget: approval.limits.critiqueCount,
      actualCritiques: 0
    },
    startedAt: episode.startedAt,
    completedAt: episode.completedAt,
    createdAt: episode.assignedAt,
    provenance: {
      workspaceId: approval.workspaceId,
      buildSha: episode.identity.buildSha,
      measurementVersion: PLAYTESTS_MEASUREMENT_VERSION,
      generatedAt
    },
    evaluationIds: [],
    spanIds: []
  };
}

function assertEpisodeMatchesRun(input: {
  readonly episode: PlaytestEpisode;
  readonly approval: WorkspacePlaytestApproval;
  readonly batchId: string;
  readonly scenario: string;
  readonly scenarioFamily: string;
  readonly seed: string;
  readonly policy: PlaytestPolicy;
  readonly environmentHash: string;
  readonly observationSchemaHash: string;
  readonly capabilities: PlaytestCapabilityAdvertisement;
  readonly runtimeVersion: string;
}): void {
  const { episode, approval, policy } = input;
  const identity = episode.identity;
  if (
    episode.schema !== PLAYTESTS_EPISODE_SCHEMA ||
    episode.batchId !== input.batchId ||
    identity.workspaceId !== approval.workspaceId ||
    identity.repository !== approval.workspaceId ||
    identity.buildSha !== approval.buildSha ||
    identity.configHash !== approval.playtestConfigHash ||
    identity.scenarioId !== input.scenario ||
    identity.seed !== input.seed ||
    identity.policyId !== policy.id ||
    identity.policyVersion !== policy.version ||
    identity.modelId !== policy.modelId ||
    identity.modelRevision !== policy.modelRevision ||
    identity.environmentHash !== input.environmentHash ||
    identity.runtimeVersion !== input.runtimeVersion ||
    identity.observationSchemaHash !== input.observationSchemaHash ||
    identity.gameBuild !== input.capabilities.engineBuild ||
    identity.observationSchemaHash !==
      input.capabilities.observationSchemaHash ||
    identity.actionSchemaHash !== input.capabilities.actionSchemaHash ||
    identity.eventSchemaHash !== input.capabilities.eventSchemaHash ||
    input.capabilities.protocolVersion !== 1 ||
    identity.protocolVersion !== input.capabilities.protocolVersion ||
    !identity.gameBuild.trim() ||
    episode.scenarioFamily !== input.scenarioFamily ||
    episode.policyCohort !== policy.cohort ||
    episode.strategy !== policy.strategy ||
    (identity.rngInitialStateHash !== null &&
      !SHA256_PATTERN.test(identity.rngInitialStateHash)) ||
    !SHA256_PATTERN.test(identity.actionSchemaHash) ||
    !SHA256_PATTERN.test(identity.observationSchemaHash) ||
    !SHA256_PATTERN.test(identity.eventSchemaHash) ||
    !SHA256_PATTERN.test(input.capabilities.actionSchemaHash) ||
    !SHA256_PATTERN.test(input.capabilities.observationSchemaHash) ||
    !SHA256_PATTERN.test(input.capabilities.eventSchemaHash)
  ) {
    throw new PlaytestMcpValidationError(
      "The runner returned episode provenance that does not match this approved run."
    );
  }
}

interface ExecuteRunInput {
  readonly session: PlaytestMcpSession;
  readonly workspaceId: string;
  readonly approval: WorkspacePlaytestApproval;
  readonly scenario: string;
  readonly policyId: string;
  readonly seed: string;
  readonly goal: string | undefined;
  readonly maxSteps: number | undefined;
  readonly artifacts: PlaytestArtifactStore;
  readonly repository: PlaytestingRepositoryOps;
  readonly approvalRepository: WorkspacePlaytestApprovalRepository;
  readonly readWorkspaceCatalog: () => WorkspaceCatalogRead;
  readonly prepareSandbox: (
    approval: WorkspacePlaytestApproval
  ) => PreparedPlaytestSandbox;
  readonly launchSandbox: (
    prepared: PreparedPlaytestSandbox
  ) => Promise<PlaytestSandboxHandle>;
  readonly runEpisode: (
    options: PlaytestEpisodeRunOptions
  ) => Promise<PlaytestEpisodeRunResult>;
  readonly activeRuns: Map<string, ActivePlaytestRun>;
  readonly unpersistedAttempts: Map<string, number>;
  readonly assignmentLocks: Map<string, Promise<void>>;
  readonly onRegistered: (batchId: string) => void;
}

function cancelActiveRun(
  run: ActivePlaytestRun,
  reason: RunCancellationReason
): boolean {
  if (run.phase !== "running" || run.reason !== null) return false;
  run.reason = reason;
  run.controller.abort(reason);
  if (run.sandbox) void run.sandbox.cancel().catch(() => undefined);
  return true;
}

interface PersistedAssignmentSummary {
  readonly assigned: number;
  readonly batchIds: ReadonlySet<string>;
}

function persistedAssignedEpisodes(
  repository: PlaytestingRepositoryOps,
  workspaceId: string,
  buildSha: string,
  stopAt: number
): Promise<PersistedAssignmentSummary> {
  const readPage = async (
    cursor: string | undefined,
    assigned: number,
    batchIds: Set<string>
  ): Promise<PersistedAssignmentSummary> => {
    const page = await repository.listBatches(
      { workspaceId, buildSha },
      { limit: 500, ...(cursor ? { cursor } : {}) }
    );
    const total =
      assigned +
      page.rows.reduce((sum, batch) => sum + batch.counts.assigned, 0);
    for (const batch of page.rows) batchIds.add(batch.batchId);
    if (total >= stopAt || page.nextCursor === null) {
      return { assigned: total, batchIds };
    }
    return readPage(page.nextCursor, total, batchIds);
  };
  return readPage(undefined, 0, new Set());
}

async function withAssignmentLock<Result>(
  locks: Map<string, Promise<void>>,
  key: string,
  operation: () => Promise<Result>
): Promise<Result> {
  const previous = locks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  locks.set(key, current);
  await previous;
  try {
    return await operation();
  } finally {
    release();
    if (locks.get(key) === current) locks.delete(key);
  }
}

function attachSandboxToRun(
  run: ActivePlaytestRun,
  sandbox: PlaytestSandboxHandle
): boolean {
  if (run.reason !== null || run.controller.signal.aborted) {
    void sandbox.cancel().catch(() => undefined);
    return false;
  }
  run.sandbox = sandbox;
  return true;
}

function markRunPersisting(run: ActivePlaytestRun): void {
  run.phase = "persisting";
}

function failureAfterCancellation(
  reason: RunCancellationReason
): PlaytestEpisodeRunFailure {
  return {
    stage: "execution",
    category: reason === "cancelled" ? "cancelled" : "approval-revoked",
    code: null,
    disposition: reason
  };
}

function selectWindowRange(input: {
  readonly result: PlaytestArtifactWindowReadResult;
  readonly fromStep: number;
  readonly toStep: number;
  readonly maxBytes: number | undefined;
}): { readonly bytes: Uint8Array; readonly lineCount: number } {
  const text = new TextDecoder("utf-8", { fatal: true }).decode(
    input.result.bytes
  );
  const matchedLines: string[] = [];
  const seenSteps = new Set<number>();
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      throw new PlaytestMcpValidationError(
        "The linked episode trace contains malformed JSON evidence."
      );
    }
    const step =
      parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as { step?: unknown }).step
        : undefined;
    if (typeof step !== "number" || !Number.isSafeInteger(step) || step < 0) {
      throw new PlaytestMcpValidationError(
        "The linked episode trace contains an invalid step record."
      );
    }
    if (seenSteps.has(step)) {
      throw new PlaytestMcpValidationError(
        "The linked episode trace contains duplicate step records."
      );
    }
    seenSteps.add(step);
    if (step >= input.fromStep && step <= input.toStep) {
      matchedLines.push(trimmed);
    }
  }
  if (matchedLines.length !== input.toStep - input.fromStep + 1) {
    throw new PlaytestMcpValidationError(
      "The linked episode trace does not contain the exact requested step range."
    );
  }
  const bytes = new TextEncoder().encode(matchedLines.join("\n") + "\n");
  if (input.maxBytes !== undefined && bytes.byteLength > input.maxBytes) {
    throw new PlaytestMcpValidationError(
      "The requested step range exceeds maxBytes."
    );
  }
  return { bytes, lineCount: matchedLines.length };
}

function validatePreparedRun(
  prepared: PreparedPlaytestSandbox,
  approval: WorkspacePlaytestApproval,
  workspaceId: string,
  scenario: string,
  policyId: string
): string {
  if (
    prepared.workspaceId !== workspaceId ||
    prepared.checkoutSha !== approval.buildSha ||
    prepared.imageDigest !== approval.adapterImageDigest ||
    canonicalJson(prepared.limits) !== canonicalJson(approval.limits) ||
    canonicalJson(prepared.command) !==
      canonicalJson(approval.adapterCommand) ||
    prepared.configuration.budget.episodes < approval.limits.episodeCount ||
    prepared.configuration.budget.maxStepsPerEpisode <
      approval.limits.maxStepsPerEpisode ||
    prepared.configuration.budget.workers < approval.limits.workerCount ||
    prepared.configuration.budget.wallTimeMinutes * 60_000 <
      approval.limits.wallTimeMs ||
    prepared.configuration.analysis.maxReviewedSessions <
      approval.limits.critiqueCount ||
    prepared.configuration.scenarios.includes(scenario) === false ||
    prepared.configuration.policies.includes(policyId) === false ||
    !approval.allowedScenarios.includes(scenario) ||
    !approval.allowedPolicies.includes(policyId)
  ) {
    throw new PlaytestMcpValidationError(
      "The prepared sandbox does not match this exact approved run."
    );
  }
  const family = prepared.configuration.scenarioFamilies[scenario];
  if (!family) {
    throw new PlaytestMcpValidationError(
      "The approved scenario has no game-owned scenario family."
    );
  }
  return family;
}

async function assertRunBudgets(input: {
  readonly repository: PlaytestingRepositoryOps;
  readonly activeRuns: Map<string, ActivePlaytestRun>;
  readonly unpersistedAttempts: Map<string, number>;
  readonly workspaceId: string;
  readonly approval: WorkspacePlaytestApproval;
  readonly prepared: PreparedPlaytestSandbox;
}): Promise<string> {
  const {
    repository,
    activeRuns,
    unpersistedAttempts,
    workspaceId,
    approval,
    prepared
  } = input;
  const assignmentLimit = Math.min(
    approval.limits.episodeCount,
    prepared.configuration.budget.episodes
  );
  const assignmentKey = workspaceId + "\0" + approval.buildSha;
  const persisted = await persistedAssignedEpisodes(
    repository,
    workspaceId,
    approval.buildSha,
    assignmentLimit
  );
  const reservations = [...activeRuns.values()].filter(
    (run) =>
      run.workspaceId === workspaceId && run.buildSha === approval.buildSha
  );
  const reservationsMissingFromData = reservations.filter(
    (run) => !persisted.batchIds.has(run.batchId)
  ).length;
  if (
    persisted.assigned +
      (unpersistedAttempts.get(assignmentKey) ?? 0) +
      reservationsMissingFromData >=
    assignmentLimit
  ) {
    throw new PlaytestMcpValidationError(
      "The approved episode assignment budget is exhausted."
    );
  }
  const workerLimit = Math.min(
    approval.limits.workerCount,
    prepared.configuration.budget.workers
  );
  if (
    reservations.filter((run) => run.phase === "running").length >= workerLimit
  ) {
    throw new PlaytestMcpValidationError(
      "The approved concurrent worker budget is exhausted."
    );
  }
  return assignmentKey;
}

interface ApprovedRunContext {
  readonly policy: PlaytestPolicy;
  readonly prepared: PreparedPlaytestSandbox;
  readonly scenarioFamily: string;
  readonly effectiveMaxSteps: number;
  readonly assignmentKey: string;
}

async function prepareApprovedRun(
  input: ExecuteRunInput
): Promise<ApprovedRunContext> {
  const {
    workspaceId,
    approval,
    scenario,
    policyId,
    maxSteps,
    artifacts,
    repository,
    approvalRepository,
    readWorkspaceCatalog,
    prepareSandbox,
    activeRuns,
    unpersistedAttempts
  } = input;
  if (artifacts.boundWorkspaceId() !== workspaceId) {
    throw new PlaytestMcpAuthorizationError(
      "The artifact store is not bound to the authorized workspace."
    );
  }
  const policy = resolvePolicy(policyId);
  const prepared = prepareSandbox(approval);
  const scenarioFamily = validatePreparedRun(
    prepared,
    approval,
    workspaceId,
    scenario,
    policyId
  );
  const maximumSteps = Math.min(
    approval.limits.maxStepsPerEpisode,
    prepared.configuration.budget.maxStepsPerEpisode
  );
  if (maxSteps !== undefined && maxSteps > maximumSteps) {
    throw new PlaytestMcpValidationError(
      "Requested maxSteps exceeds the checked-in or approved budget."
    );
  }
  const assignmentKey = await assertRunBudgets({
    repository,
    activeRuns,
    unpersistedAttempts,
    workspaceId,
    approval,
    prepared
  });
  if (
    approvalIsStillExact(approval, approvalRepository, readWorkspaceCatalog) !==
    null
  ) {
    throw new PlaytestSandboxApprovalError(
      "The active approval or workspace enablement changed before execution."
    );
  }
  return {
    policy,
    prepared,
    scenarioFamily,
    effectiveMaxSteps: maxSteps ?? maximumSteps,
    assignmentKey
  };
}

interface RegisteredRunContext extends ApprovedRunContext {
  readonly batchId: string;
  readonly assignedAt: string;
  readonly activeRun: ActivePlaytestRun;
}

async function launchApprovedSandbox(
  input: ExecuteRunInput,
  context: RegisteredRunContext
): Promise<PlaytestSandboxHandle> {
  const sandbox = await input.launchSandbox(context.prepared);
  if (!attachSandboxToRun(context.activeRun, sandbox)) {
    throw new PlaytestSandboxApprovalError(
      "The active approval or workspace enablement changed before execution."
    );
  }
  const reason = approvalIsStillExact(
    input.approval,
    input.approvalRepository,
    input.readWorkspaceCatalog
  );
  if (reason !== null) {
    cancelActiveRun(context.activeRun, reason);
    throw new PlaytestSandboxApprovalError(
      "The active approval or workspace enablement changed before execution."
    );
  }
  return sandbox;
}

function runEpisodeInApprovedSandbox(
  input: ExecuteRunInput,
  context: RegisteredRunContext,
  sandbox: PlaytestSandboxHandle
): Promise<PlaytestEpisodeRunResult> {
  const runtimeVersion = RUNTIME_VERSION;
  const environmentHash = playtestEnvironmentHash(
    input.approval,
    runtimeVersion
  );
  return input.runEpisode({
    approval: input.approval,
    sandbox,
    artifacts: input.artifacts,
    batchId: context.batchId,
    repository: input.workspaceId,
    scenarioId: input.scenario,
    scenarioFamily: context.scenarioFamily,
    seed: input.seed,
    goal: input.goal ?? "Playtest scenario " + input.scenario,
    measurementVersion: PLAYTESTS_MEASUREMENT_VERSION,
    runtimeVersion,
    environmentHash,
    policy: context.policy,
    observationContract: context.prepared.observationContract,
    maxSteps: context.effectiveMaxSteps,
    signal: context.activeRun.controller.signal,
    isApprovalActive: () => {
      const reason = approvalIsStillExact(
        input.approval,
        input.approvalRepository,
        input.readWorkspaceCatalog
      );
      if (reason !== null) cancelActiveRun(context.activeRun, reason);
      return reason === null;
    }
  });
}

function runFailureResult(
  batchId: string,
  stepsCount: number,
  traceReference: PlaytestEpisodeRunResult["traceReference"],
  failure: PlaytestEpisodeRunFailure | null,
  cancellation: RunCancellationReason | null
) {
  return {
    batchId,
    episodeId: null,
    status:
      cancellation === null ? ("failed" as const) : ("cancelled" as const),
    outcome: "unknown" as const,
    stepsCount,
    durationMs: 0,
    traceReference,
    failure: failure
      ? { stage: failure.stage, category: failure.category, code: failure.code }
      : null,
    cancellation,
    numericResults: []
  };
}

async function persistRunWithoutEpisode(input: {
  readonly execute: ExecuteRunInput;
  readonly context: RegisteredRunContext;
  readonly result: PlaytestEpisodeRunResult;
  readonly capabilities: PlaytestCapabilityAdvertisement | null;
}): Promise<PlaytestRunExecutionResult> {
  const { execute, context, result, capabilities } = input;
  const cancellation = context.activeRun.reason;
  const status = cancellation === null ? "failed" : "cancelled";
  await execute.repository.insertBatch(
    batchForAttempt({
      approval: execute.approval,
      prepared: context.prepared,
      batchId: context.batchId,
      scenario: execute.scenario,
      policy: context.policy,
      maxSteps: context.effectiveMaxSteps,
      revision: 2,
      status,
      counts: attemptCounts(status),
      capabilities,
      createdAt: context.assignedAt,
      completedAt: new Date().toISOString()
    })
  );
  return runFailureResult(
    context.batchId,
    result.steps.length,
    result.traceReference,
    cancellation === null
      ? result.failure
      : failureAfterCancellation(cancellation),
    cancellation
  );
}

async function persistRunEpisode(input: {
  readonly execute: ExecuteRunInput;
  readonly context: RegisteredRunContext;
  readonly result: PlaytestEpisodeRunResult;
  readonly capabilities: PlaytestCapabilityAdvertisement;
  readonly onEpisodePersisted: () => void;
}): Promise<PlaytestRunExecutionResult> {
  const { execute, context, result } = input;
  const episode = result.episode;
  if (!episode) {
    throw new TypeError("A completed playtest episode is required.");
  }
  const runtimeVersion = RUNTIME_VERSION;
  const environmentHash = playtestEnvironmentHash(
    execute.approval,
    runtimeVersion
  );
  assertEpisodeMatchesRun({
    episode,
    approval: execute.approval,
    batchId: context.batchId,
    scenario: execute.scenario,
    scenarioFamily: context.scenarioFamily,
    seed: execute.seed,
    policy: context.policy,
    environmentHash,
    observationSchemaHash: context.prepared.observationContract.schemaHash,
    capabilities: input.capabilities,
    runtimeVersion
  });

  let acceptedEpisode = episode;
  if (context.activeRun.reason !== null) {
    if (episode.status !== "cancelled") {
      throw new PlaytestMcpUnavailableError(
        "The runner did not acknowledge cancellation; the result is not accepted as complete."
      );
    }
    const missingReason: PlaytestMissingReason =
      context.activeRun.reason === "cancelled" ? "cancelled" : "revoked";
    if (!episode.missingReasons.includes(missingReason)) {
      acceptedEpisode = {
        ...episode,
        missingReasons: [...episode.missingReasons, missingReason]
      };
    }
  }

  await execute.repository.insertEpisode(acceptedEpisode);
  input.onEpisodePersisted();
  await execute.repository.insertBatch(
    batchForEpisode({
      episode: acceptedEpisode,
      approval: execute.approval,
      rubricHash: context.prepared.rubricHash,
      batchId: context.batchId,
      maxSteps: context.effectiveMaxSteps
    })
  );
  const failure = context.activeRun.reason
    ? failureAfterCancellation(context.activeRun.reason)
    : result.failure;
  return {
    batchId: context.batchId,
    episodeId: acceptedEpisode.episodeId,
    status: acceptedEpisode.status,
    outcome: acceptedEpisode.outcome,
    stepsCount: result.steps.length,
    durationMs: acceptedEpisode.simulationWallMs,
    traceReference: result.traceReference,
    failure: failure
      ? { stage: failure.stage, category: failure.category, code: failure.code }
      : null,
    cancellation: context.activeRun.reason,
    numericResults: acceptedEpisode.metrics
  };
}

async function persistTerminalFailure(input: {
  readonly execute: ExecuteRunInput;
  readonly context: RegisteredRunContext;
  readonly capabilities: PlaytestCapabilityAdvertisement | null;
  readonly episodePersisted: boolean;
}): Promise<void> {
  const { execute, context, capabilities, episodePersisted } = input;
  // An episode row is authoritative even if its batch revision failed to
  // persist. Never append a contradictory failed revision over it.
  if (episodePersisted) return;
  const cancellation = context.activeRun.reason;
  const status = cancellation === null ? "failed" : "cancelled";
  try {
    await execute.repository.insertBatch(
      batchForAttempt({
        approval: execute.approval,
        prepared: context.prepared,
        batchId: context.batchId,
        scenario: execute.scenario,
        policy: context.policy,
        maxSteps: context.effectiveMaxSteps,
        revision: 2,
        status,
        counts: attemptCounts(status),
        capabilities,
        createdAt: context.assignedAt,
        completedAt: new Date().toISOString()
      })
    );
  } catch {
    // The original run/persistence failure remains authoritative; revision 1
    // is still an explicit incomplete assignment, never a success.
  }
}

function persistRunResult(
  execute: ExecuteRunInput,
  context: RegisteredRunContext,
  result: PlaytestEpisodeRunResult,
  onEpisodePersisted: () => void
): Promise<PlaytestRunExecutionResult> {
  if (!result.episode) {
    return persistRunWithoutEpisode({
      execute,
      context,
      result,
      capabilities: result.capabilities
    });
  }
  if (!result.capabilities) {
    throw new PlaytestMcpValidationError(
      "The runner returned an episode without negotiated capabilities."
    );
  }
  return persistRunEpisode({
    execute,
    context,
    result,
    capabilities: result.capabilities,
    onEpisodePersisted
  });
}

async function registerApprovedRun(
  input: ExecuteRunInput
): Promise<RegisteredRunContext> {
  const { policy, prepared, scenarioFamily, effectiveMaxSteps, assignmentKey } =
    await prepareApprovedRun(input);
  const batchId = "batch-" + randomUUID();
  const controller = new AbortController();
  let resolveCompletion!: (status: PlaytestRunStatus) => void;
  const completion = new Promise<PlaytestRunStatus>((resolve) => {
    resolveCompletion = resolve;
  });
  const assignedAt = new Date().toISOString();
  const activeRun: ActivePlaytestRun = {
    batchId,
    workspaceId: input.workspaceId,
    buildSha: input.approval.buildSha,
    ownerActor: input.session.actor,
    ownerTaskId: input.session.taskId,
    ownerRunId: input.session.runId,
    scenarioId: input.scenario,
    createdAt: assignedAt,
    controller,
    phase: "running",
    reason: null,
    sandbox: null,
    completion,
    resolveCompletion
  };
  const context: RegisteredRunContext = {
    policy,
    prepared,
    scenarioFamily,
    effectiveMaxSteps,
    assignmentKey,
    batchId,
    assignedAt,
    activeRun
  };
  try {
    await input.repository.insertBatch(
      batchForAttempt({
        approval: input.approval,
        prepared,
        batchId,
        scenario: input.scenario,
        policy,
        maxSteps: effectiveMaxSteps,
        revision: 1,
        status: "running",
        counts: attemptCounts("running"),
        capabilities: null,
        createdAt: assignedAt,
        completedAt: null
      })
    );
  } catch (error) {
    input.unpersistedAttempts.set(
      assignmentKey,
      (input.unpersistedAttempts.get(assignmentKey) ?? 0) + 1
    );
    throw error;
  }
  input.activeRuns.set(batchId, activeRun);
  input.onRegistered(batchId);
  return context;
}

async function executeApprovedRun(input: ExecuteRunInput) {
  const lockKey = input.workspaceId + "\0" + input.approval.buildSha;
  const context = await withAssignmentLock(input.assignmentLocks, lockKey, () =>
    registerApprovedRun(input)
  );
  const { activeRun } = context;
  let approvalMonitor: NodeJS.Timeout | undefined;
  let sandbox: PlaytestSandboxHandle | null = null;
  let capabilities: PlaytestCapabilityAdvertisement | null = null;
  let episodePersisted = false;
  try {
    approvalMonitor = setInterval(() => {
      const reason = approvalIsStillExact(
        input.approval,
        input.approvalRepository,
        input.readWorkspaceCatalog
      );
      if (reason !== null) cancelActiveRun(activeRun, reason);
    }, APPROVAL_POLL_INTERVAL_MS);
    approvalMonitor.unref();

    sandbox = await launchApprovedSandbox(input, context);
    const result = await runEpisodeInApprovedSandbox(input, context, sandbox);
    if (approvalMonitor) {
      clearInterval(approvalMonitor);
      approvalMonitor = undefined;
    }
    capabilities = result.capabilities;
    markRunPersisting(activeRun);
    return await persistRunResult(input, context, result, () => {
      episodePersisted = true;
    });
  } catch (error) {
    await persistTerminalFailure({
      execute: input,
      context,
      capabilities,
      episodePersisted
    });
    throw error;
  } finally {
    if (approvalMonitor) clearInterval(approvalMonitor);
    if (sandbox) await sandbox.cleanup();
  }
}
/** Resolve an explicitly supported policy baseline; never fabricate a heuristic. */
function resolvePolicy(policyId: string): PlaytestPolicy {
  if (policyId === "random") {
    return createSeededRandomPlaytestPolicy({ id: policyId });
  }
  throw new PlaytestMcpValidationError(
    'Policy "' +
      policyId +
      '" is not an explicitly supported baseline. Supported baselines: [' +
      [...SUPPORTED_POLICY_IDS].join(", ") +
      "]."
  );
}

/**
 * Build the known-evidence index from real stored records -- never from the
 * locators the caller is simultaneously trying to get verified. Episode
 * identity and frames come from the indexed episode row; event identity
 * comes from parsing the episode's own persisted trace artifact; review,
 * finding and comparison identity come from the real repository.
 */
interface PlaytestTraceEvent {
  readonly eventId: string;
  readonly type: string;
  readonly phaseId: string | null;
  readonly step: number | null;
}

interface PlaytestEpisodeTraceFacts {
  readonly eventEpisodeOf: ReadonlyMap<string, string>;
  readonly events: readonly PlaytestTraceEvent[];
  readonly selectedActionIds: ReadonlySet<string>;
}

/** Parse an episode's persisted JSONL trace as authoritative event/action facts. */
function readEpisodeTraceFacts(
  episode: PlaytestEpisode,
  artifacts: PlaytestArtifactStore
): PlaytestEpisodeTraceFacts {
  const eventEpisodeOf = new Map<string, string>();
  const events: PlaytestTraceEvent[] = [];
  const selectedActionIds = new Set<string>();
  if (!episode.trace) return { eventEpisodeOf, events, selectedActionIds };
  try {
    const traceReference = artifacts.referenceForId(episode.trace.id);
    if (!traceReference) throw new Error("trace artifact not authorized");
    const window = artifacts.readWindow(traceReference);
    const text = new TextDecoder("utf-8", { fatal: true }).decode(window.bytes);
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        continue;
      }
      if (
        parsed === null ||
        typeof parsed !== "object" ||
        Array.isArray(parsed)
      ) {
        continue;
      }
      const entry = parsed as Record<string, unknown>;
      const step = Number.isSafeInteger(entry.step)
        ? (entry.step as number)
        : null;
      if (typeof entry.selectedActionId === "string") {
        selectedActionIds.add(
          entry.selectedActionId.normalize("NFKC").trim().toLowerCase()
        );
      }
      if (!Array.isArray(entry.events)) continue;
      for (const rawEvent of entry.events) {
        if (
          rawEvent === null ||
          typeof rawEvent !== "object" ||
          Array.isArray(rawEvent)
        )
          continue;
        const event = rawEvent as Record<string, unknown>;
        if (
          typeof event.eventId !== "string" ||
          event.eventId.length === 0 ||
          typeof event.type !== "string" ||
          event.type.length === 0
        )
          continue;
        const fact: PlaytestTraceEvent = {
          eventId: event.eventId,
          type: event.type,
          phaseId: typeof event.phaseId === "string" ? event.phaseId : null,
          step
        };
        events.push(fact);
        eventEpisodeOf.set(fact.eventId, episode.episodeId);
      }
    }
  } catch {
    // Unreadable/expired trace means no event/action identity can be proven.
  }
  return { eventEpisodeOf, events, selectedActionIds };
}

/**
 * Shape accepted by `resolveSubmittedFinding`. Mirrors `findingSchema`
 * but is structurally typed so we can keep callers strictly typed through
 * zod while passing the resolved shape to the helper.
 */
type SubmittedFinding = z.infer<typeof findingSchema>;

function normalizeEvidenceRefs(
  locators: SubmittedFinding["evidenceRefs"]
): readonly PlaytestEvidenceLocator[] {
  // Strip zod-output `undefined`s from optional numeric fields so the
  // resulting objects satisfy PlaytestEvidenceLocator under
  // exactOptionalPropertyTypes. Anything not actually set is dropped.
  return locators.map((locator) => {
    const out: PlaytestEvidenceLocator = {
      kind: locator.kind,
      id: locator.id
    };
    if ("step" in locator && typeof locator.step === "number") {
      (out as { step?: number }).step = locator.step;
    }
    if ("revision" in locator && typeof locator.revision === "number") {
      (out as { revision?: number }).revision = locator.revision;
    }
    if ("frameIndex" in locator && typeof locator.frameIndex === "number") {
      (out as { frameIndex?: number }).frameIndex = locator.frameIndex;
    }
    if ("phaseId" in locator && typeof locator.phaseId === "string") {
      (out as { phaseId?: string }).phaseId = locator.phaseId;
    }
    return out;
  });
}

/** Derive finding scope/events from the stored episode and cited trace, never caller claims. */
function buildSubmittedFindingIdentity(
  episode: PlaytestEpisode,
  traceFacts: PlaytestEpisodeTraceFacts,
  submitted: SubmittedFinding
): {
  readonly identity: PlaytestFindingIdentity;
  readonly fingerprint: string;
} {
  const citedEventIds = new Set(
    submitted.evidenceRefs
      .filter((reference) => reference.kind === "event")
      .map((reference) => reference.id)
  );
  const events = traceFacts.events
    .filter((event) => citedEventIds.has(event.eventId))
    .map((event) => event.type);
  if (events.length === 0) {
    throw new PlaytestMcpValidationError(
      "A finding identity requires at least one cited event from the stored episode trace."
    );
  }
  const requestedAction = submitted.identity.failureSignature.action;
  if (requestedAction !== undefined && requestedAction !== null) {
    const normalizedAction = requestedAction
      .normalize("NFKC")
      .trim()
      .toLowerCase();
    if (!traceFacts.selectedActionIds.has(normalizedAction)) {
      throw new PlaytestMcpValidationError(
        "Finding identity action must match a selected action recorded in the stored episode trace."
      );
    }
  }
  const identity = buildPlaytestFindingIdentity({
    workspaceId: episode.identity.workspaceId,
    mechanicKey: submitted.identity.mechanicKey,
    failureSignature: {
      events,
      ...(requestedAction !== undefined ? { action: requestedAction } : {}),
      witness: submitted.identity.failureSignature.witness
    },
    scope: {
      // These fields are deliberately server-derived. Phase and modality
      // remain null until the stored evidence contains a verified mapping.
      scenarioFamily: episode.scenarioFamily,
      phase: null,
      modality: null
    }
  });
  return { identity, fingerprint: computeFindingFingerprint(identity) };
}

interface SubmittedFindingGroup {
  readonly identity: PlaytestFindingIdentity;
  readonly fingerprint: string;
  readonly submitted: SubmittedFinding;
  readonly affectedCohorts: readonly string[];
}

/**
 * Collapse findings within ONE submitted review that resolve to the same
 * stable identity fingerprint before any Data read/append happens, so a
 * single review can never create two persisted revisions -- or two
 * entries in its own findings array -- for the same underlying defect.
 * The first occurrence in review order keeps its severity/title/description;
 * later in-review duplicates only contribute additional validated evidence.
 * Cohort is derived from the stored episode. Workflow state, prevalence,
 * external links and verification dates are owned by separate workflows.
 */
function collapseInReviewDuplicateFindings(
  episode: PlaytestEpisode,
  traceFacts: PlaytestEpisodeTraceFacts,
  findings: readonly SubmittedFinding[]
): readonly SubmittedFindingGroup[] {
  const order: string[] = [];
  const byFingerprint = new Map<string, SubmittedFindingGroup>();
  for (const submitted of findings) {
    const { identity, fingerprint } = buildSubmittedFindingIdentity(
      episode,
      traceFacts,
      submitted
    );
    const group = byFingerprint.get(fingerprint);
    if (!group) {
      byFingerprint.set(fingerprint, {
        identity,
        fingerprint,
        submitted,
        affectedCohorts: [episode.policyCohort]
      });
      order.push(fingerprint);
      continue;
    }
    byFingerprint.set(fingerprint, {
      identity: group.identity,
      fingerprint,
      submitted: {
        ...group.submitted,
        evidenceRefs: [
          ...group.submitted.evidenceRefs,
          ...submitted.evidenceRefs
        ]
      },
      affectedCohorts: [
        ...unionStringSet(group.affectedCohorts, [episode.policyCohort])
      ]
    });
  }
  return order.map((fingerprint) => byFingerprint.get(fingerprint)!);
}

/**
 * Resolve the authoritative, server-derived identity/fingerprint/
 * findingId/version for one (already in-review-deduplicated) finding
 * group, and persist it. The Data read (`getLatestFindingByFingerprint`)
 * and the Data append (`insertFinding`) happen inside the SAME
 * `serializeFindingAppend` critical section the caller wraps this in, so
 * the latest-by-fingerprint lookup and the resulting append are strictly
 * ordered per (workspace, fingerprint) and cannot race with a concurrent
 * submitReview call resolving to the same identity.
 *
 * Duplicate handling across reviews (§11's duplicate-flood gate):
 * - If a finding with the same fingerprint already exists in the
 *   workspace, this writes exactly one new revision (version = latest +
 *   1) that unions the new evidence/experiment/issue references into the
 *   existing ones without inventing counts/status. The earlier
 *   severity/title/description/status/verificationStage/lastVerifiedBuild/
 *   nextReviewAt win so a follow-up report cannot rewrite them.
 * - If the fingerprint is new, version = 1; workflow and verification
 *   fields are initialized by Runtime, prevalence is null, and the proposed
 *   severity/title/description remain a hypothesis.
 */
async function appendSubmittedFindingGroup(
  workspaceId: string,
  group: SubmittedFindingGroup,
  evidenceIndex: PlaytestKnownEvidenceIndex,
  playtestRepository: PlaytestingRepositoryOps
): Promise<PlaytestFinding> {
  const { identity, fingerprint, submitted } = group;
  const findingId = deriveStableFindingId(fingerprint);

  const existing = await playtestRepository.getLatestFindingByFingerprint(
    workspaceId,
    fingerprint
  );

  const resolved: PlaytestFinding = !existing
    ? {
        identity,
        fingerprint,
        findingId,
        version: 1,
        title: submitted.title,
        description: submitted.description,
        // No game-owned severity rule is bound to this review path yet.
        // Keep the candidate unranked rather than trusting an LLM severity.
        severity: "informational",
        status: "open",
        verificationStage: "not-yet-validated",
        evidenceStatus: "hypothesis",
        // Analyst reports are single-episode hypotheses, not a valid
        // frequency sample. Keep prevalence explicitly unobserved until an
        // indexed source-owned aggregation supplies the denominators.
        affectedEpisodes: null,
        totalEligibleEpisodes: null,
        affectedOpportunities: null,
        totalEligibleOpportunities: null,
        affectedCohorts: [...group.affectedCohorts],
        evidenceRefs: unionEvidenceRefs(
          normalizeEvidenceRefs(submitted.evidenceRefs),
          []
        ),
        experimentIds: [],
        issueRefs: [],
        lastVerifiedBuild: null,
        nextReviewAt: null
      }
    : {
        // Duplicate-flood merge: keep the existing authoritative fields
        // (severity, title, description, status, verificationStage,
        // evidenceStatus, affected counts, lastVerifiedBuild,
        // nextReviewAt) and union the new evidence/experiment/issue
        // references into them. Counts/status are NEVER invented here.
        identity: existing.identity,
        fingerprint: existing.fingerprint,
        findingId: existing.findingId,
        version: existing.version + 1,
        title: existing.title,
        description: existing.description,
        severity: existing.severity,
        status: existing.status,
        verificationStage: existing.verificationStage,
        evidenceStatus: existing.evidenceStatus,
        affectedEpisodes: existing.affectedEpisodes,
        totalEligibleEpisodes: existing.totalEligibleEpisodes,
        affectedOpportunities: existing.affectedOpportunities,
        totalEligibleOpportunities: existing.totalEligibleOpportunities,
        affectedCohorts: unionStringSet(
          existing.affectedCohorts,
          group.affectedCohorts
        ),
        evidenceRefs: unionEvidenceRefs(
          existing.evidenceRefs,
          normalizeEvidenceRefs(submitted.evidenceRefs)
        ),
        experimentIds: existing.experimentIds,
        issueRefs: existing.issueRefs,
        lastVerifiedBuild: existing.lastVerifiedBuild,
        nextReviewAt: existing.nextReviewAt
      };

  assertPlaytestFindingEvidenceStatusConsistent(resolved, evidenceIndex);
  await playtestRepository.insertFinding(workspaceId, resolved);
  return resolved;
}

async function buildKnownPlaytestEvidenceIndex(
  workspaceId: string,
  episode: PlaytestEpisode,
  evidenceRefs: readonly PlaytestEvidenceLocator[],
  traceFacts: PlaytestEpisodeTraceFacts,
  playtestRepository: PlaytestingRepositoryOps
): Promise<PlaytestKnownEvidenceIndex> {
  const episodeIds = new Set<string>([episode.episodeId]);

  const frameEpisodeOf = new Map<string, string>();
  for (const frame of episode.frames) {
    frameEpisodeOf.set(frame.id, episode.episodeId);
  }

  const eventEpisodeOf = traceFacts.eventEpisodeOf;

  const reviewIds = new Set<string>();
  const latestReview = await playtestRepository.getLatestReviewForEpisode(
    workspaceId,
    episode.episodeId
  );
  if (latestReview) reviewIds.add(latestReview.reviewId);

  const findingIds = new Set<string>();
  const findingRefs = new Set(
    evidenceRefs
      .filter((reference) => reference.kind === "finding")
      .map((ref) => ref.id)
  );
  const findings = await Promise.all(
    Array.from(findingRefs, (findingId) =>
      playtestRepository.getFinding(workspaceId, findingId)
    )
  );
  for (const finding of findings) {
    if (finding) findingIds.add(finding.findingId);
  }

  const comparisonIds = new Set<string>();
  const comparisonRefs = new Set(
    evidenceRefs
      .filter((reference) => reference.kind === "comparison")
      .map((ref) => ref.id)
  );
  const comparisons = await Promise.all(
    Array.from(comparisonRefs, (comparisonId) =>
      playtestRepository.getLatestComparison(workspaceId, comparisonId)
    )
  );
  for (const comparison of comparisons) {
    if (comparison) comparisonIds.add(comparison.comparisonId);
  }

  return {
    episodeIds,
    eventEpisodeOf,
    eventRelevantRuleOf: new Map(),
    reviewIds,
    findingIds,
    comparisonIds,
    frameEpisodeOf
  };
}

function assertKnownEvidenceLocators(
  references: readonly PlaytestEvidenceLocator[],
  index: PlaytestKnownEvidenceIndex
): void {
  for (const reference of references) {
    if (!knownEvidenceLocatorExists(reference, index)) {
      throw new PlaytestMcpValidationError(
        "Every review locator must resolve to evidence stored by Runtime or Data."
      );
    }
  }
}

function knownEvidenceLocatorExists(
  reference: PlaytestEvidenceLocator,
  index: PlaytestKnownEvidenceIndex
): boolean {
  switch (reference.kind) {
    case "episode":
    case "replay-segment": {
      return index.episodeIds.has(reference.id);
    }
    case "event": {
      return index.eventEpisodeOf.has(reference.id);
    }
    case "frame": {
      return index.frameEpisodeOf.has(reference.id);
    }
    case "review": {
      return index.reviewIds.has(reference.id);
    }
    case "finding": {
      return index.findingIds.has(reference.id);
    }
    case "comparison": {
      return index.comparisonIds.has(reference.id);
    }
    default: {
      return false;
    }
  }
}

function parsePlaytestRunRequest(
  request: PlaytestRunRequest
): PlaytestRunRequest {
  const parsed = playtestRunRequestSchema.safeParse(request);
  if (!parsed.success) {
    throw new PlaytestMcpValidationError(
      "The playtest run request is invalid."
    );
  }
  return parsed.data;
}

function authorizeRunnerWorkspace(
  session: PlaytestMcpSession,
  requestedWorkspaceId: string | undefined,
  readWorkspaceCatalog: () => WorkspaceCatalogRead
): string {
  if (!RUNNER_ROLES.has(session.role) && session.role !== "operator") {
    throw new PlaytestMcpAuthorizationError(
      "playtest.run requires an authorized runner role."
    );
  }
  const workspaceId = authorizeWorkspace(requestedWorkspaceId, session);
  assertSessionWorkspaceRole(
    session,
    assertCanonicalWorkspaceEnabled(workspaceId, readWorkspaceCatalog)
  );
  return workspaceId;
}

function activeRunApproval(
  repository: WorkspacePlaytestApprovalRepository | undefined,
  workspaceId: string
): WorkspacePlaytestApproval {
  if (!repository) {
    throw new PlaytestMcpUnavailableError(
      "Workspace approval storage is unavailable."
    );
  }
  const approval = repository.read(workspaceId);
  if (!approval || approval.revokedAt !== null) {
    throw new PlaytestSandboxApprovalError(
      "An active playtesting approval is required."
    );
  }
  return approval;
}

function requiredRunRepository(
  repository: PlaytestingRepositoryOps | undefined
): PlaytestingRepositoryOps {
  if (!repository) {
    throw new PlaytestMcpUnavailableError(
      "Playtest Data storage is unavailable; the run cannot be recorded."
    );
  }
  return repository;
}

export function createPlaytestRunControl(
  options: PlaytestRunControlOptions
): PlaytestRunOwner {
  const {
    artifactStoreForWorkspace,
    playtestRepository,
    approvalRepository,
    runEpisodeHandler = runPlaytestEpisode,
    launchSandboxHandler,
    prepareSandboxHandler = preparePlaytestSandbox,
    readWorkspaceCatalog = () => new ConfigRepository().readWorkspaceCatalog()
  } = options;
  const activeRuns = new Map<string, ActivePlaytestRun>();
  const completedRuns = new Map<
    string,
    { readonly workspaceId: string; readonly status: PlaytestRunStatus }
  >();
  const unpersistedAttempts = new Map<string, number>();
  const assignmentLocks = new Map<string, Promise<void>>();
  const finishRun = (
    batchId: string,
    terminal: PlaytestRunStatus,
    workspaceId: string
  ): void => {
    const active = activeRuns.get(batchId);
    completedRuns.set(batchId, { workspaceId, status: terminal });
    activeRuns.delete(batchId);
    active?.resolveCompletion(terminal);
    while (completedRuns.size > 256) {
      const oldest = completedRuns.keys().next().value;
      if (oldest === undefined) break;
      completedRuns.delete(oldest);
    }
  };
  const playtestRunControl: PlaytestRunOwner = {
    getCapabilities(session, workspaceId) {
      assertRunStatusReader(session);
      const authorizedWorkspaceId = authorizeWorkspace(workspaceId, session);
      const catalog = readWorkspaceCatalog();
      if (catalog.status !== "valid") {
        return {
          workspaceId: authorizedWorkspaceId,
          workspaceEnabled: false,
          workspaceCatalog: catalog.status,
          approved: false,
          approvalRevision: null,
          buildSha: null,
          gameBuild: null,
          allowedScenarios: [],
          approvedPolicies: [],
          supportedPolicies: [...SUPPORTED_POLICY_IDS],
          runnablePolicies: [],
          unsupportedApprovedPolicies: [],
          configurationStatus: "not-checked",
          runnableAssignments: [],
          policyProfiles: [],
          limits: null,
          issueReporting: "disabled",
          humanStudyAllowed: false,
          revokedAt: null,
          runPreflight: "required-at-start"
        };
      }
      const workspace = catalog.workspaces.find(
        (entry) => entry.id === authorizedWorkspaceId
      );
      if (!workspace) {
        throw new PlaytestMcpAuthorizationError(
          "The requested workspace is not in the canonical catalog."
        );
      }
      assertSessionWorkspaceRole(session, workspace);
      if (!approvalRepository) {
        throw new PlaytestMcpUnavailableError(
          "Workspace approval storage is unavailable."
        );
      }
      const approval = approvalRepository.read(authorizedWorkspaceId);
      const activeApproval = approval !== null && approval.revokedAt === null;
      const approvedPolicies = approval?.allowedPolicies ?? [];
      const runnableAssignments: PlaytestRunCapabilities["runnableAssignments"][number][] =
        [];
      let configurationStatus: PlaytestRunCapabilities["configurationStatus"] =
        "not-checked";
      if (activeApproval && workspace.enabled) {
        try {
          const prepared = prepareSandboxHandler(approval);
          for (const scenarioId of approval.allowedScenarios) {
            for (const policyId of approvedPolicies) {
              if (!SUPPORTED_POLICY_IDS.has(policyId)) continue;
              try {
                const scenarioFamily = validatePreparedRun(
                  prepared,
                  approval,
                  authorizedWorkspaceId,
                  scenarioId,
                  policyId
                );
                const policy = resolvePolicy(policyId);
                runnableAssignments.push({
                  scenarioId,
                  scenarioFamily,
                  policyId: policy.id,
                  policyVersion: policy.version,
                  cohort: policy.cohort,
                  strategy: policy.strategy,
                  maxStepsPerEpisode: Math.min(
                    approval.limits.maxStepsPerEpisode,
                    prepared.configuration.budget.maxStepsPerEpisode
                  )
                });
              } catch {
                // The approval is not enough: incompatible target config cells are not runnable.
              }
            }
          }
          configurationStatus = "validated";
        } catch {
          configurationStatus = "invalid";
        }
      }
      const runnablePolicies = [
        ...new Set(runnableAssignments.map((assignment) => assignment.policyId))
      ];
      const profiles = runnableAssignments
        .filter(
          (assignment, index, all) =>
            all.findIndex(
              (candidate) => candidate.policyId === assignment.policyId
            ) === index
        )
        .map(({ policyId, policyVersion, cohort, strategy }) => ({
          policyId,
          version: policyVersion,
          cohort,
          strategy
        }));
      return {
        workspaceId: authorizedWorkspaceId,
        workspaceEnabled: workspace.enabled,
        workspaceCatalog: catalog.status,
        approved: activeApproval,
        approvalRevision: approval?.revision ?? null,
        buildSha: approval?.buildSha ?? null,
        gameBuild: approval?.gameBuild ?? null,
        allowedScenarios: approval?.allowedScenarios ?? [],
        approvedPolicies,
        supportedPolicies: [...SUPPORTED_POLICY_IDS],
        runnablePolicies,
        unsupportedApprovedPolicies: approvedPolicies.filter(
          (policyId) => !SUPPORTED_POLICY_IDS.has(policyId)
        ),
        configurationStatus,
        runnableAssignments,
        policyProfiles: profiles,
        limits: approval?.limits ?? null,
        issueReporting: approval?.issueReporting ?? "disabled",
        humanStudyAllowed: approval?.humanStudyAllowed ?? false,
        revokedAt: approval?.revokedAt ?? null,
        runPreflight: "required-at-start"
      };
    },
    async startRun(session, request) {
      const parsed = parsePlaytestRunRequest(request);
      const targetWorkspaceId = authorizeRunnerWorkspace(
        session,
        parsed.workspaceId,
        readWorkspaceCatalog
      );
      const approval = activeRunApproval(approvalRepository, targetWorkspaceId);
      const repository = requiredRunRepository(playtestRepository);
      const artifacts = artifactStoreForWorkspace(targetWorkspaceId);

      let resolveStarted!: (batchId: string) => void;
      let rejectStarted!: (error: unknown) => void;
      let registeredBatchId: string | null = null;
      const started = new Promise<string>((resolve, reject) => {
        resolveStarted = resolve;
        rejectStarted = reject;
      });
      const execution = executeApprovedRun({
        session,
        workspaceId: targetWorkspaceId,
        approval,
        scenario: parsed.scenario,
        policyId: parsed.policy,
        seed: parsed.seed,
        goal: parsed.goal,
        maxSteps: parsed.maxSteps,
        artifacts,
        repository,
        approvalRepository: approvalRepository!,
        readWorkspaceCatalog,
        prepareSandbox: prepareSandboxHandler,
        launchSandbox: launchSandboxHandler ?? launchPlaytestSandbox,
        runEpisode: runEpisodeHandler,
        activeRuns,
        unpersistedAttempts,
        assignmentLocks,
        onRegistered(batchId) {
          registeredBatchId = batchId;
          resolveStarted(batchId);
        }
      });
      void execution.then(
        (result) => {
          const cancellationReason =
            result.cancellation as RunCancellationReason | null;
          finishRun(
            result.batchId,
            {
              batchId: result.batchId,
              status:
                cancellationReason !== null || result.status === "cancelled"
                  ? "cancelled"
                  : result.status === "completed"
                    ? "completed"
                    : "failed",
              cancellationReason,
              result,
              error: null
            },
            targetWorkspaceId
          );
          return undefined;
        },
        (error: unknown) => {
          if (registeredBatchId === null) {
            rejectStarted(error);
            return undefined;
          }
          const active = activeRuns.get(registeredBatchId);
          const safeError = playtestMcpErrorDetails(error);
          if (safeError.code === "playtest_internal_error") {
            writeErrorLine("playtest-mcp: internal operation failure.");
          }
          finishRun(
            registeredBatchId,
            {
              batchId: registeredBatchId,
              status: active?.reason ? "cancelled" : "failed",
              cancellationReason: active?.reason ?? null,
              result: null,
              error: safeError
            },
            targetWorkspaceId
          );
          return undefined;
        }
      );
      return { batchId: await started, status: "running" };
    },
    listActiveRuns(session, workspaceId) {
      assertRunStatusReader(session);
      const authorizedWorkspaceId = authorizeExistingRunWorkspace(
        session,
        workspaceId,
        readWorkspaceCatalog
      );
      return [...activeRuns.values()]
        .filter(
          (run) =>
            run.workspaceId === authorizedWorkspaceId && run.phase === "running"
        )
        .map(({ batchId, scenarioId, createdAt }) => ({
          batchId,
          scenarioId,
          createdAt
        }));
    },
    cancelRun(session, workspaceId, batchId) {
      if (!RUNNER_ROLES.has(session.role) && session.role !== "operator") {
        throw new PlaytestMcpAuthorizationError(
          "Run cancellation requires an authorized runner role."
        );
      }
      const authorizedWorkspaceId = authorizeExistingRunWorkspace(
        session,
        workspaceId,
        readWorkspaceCatalog
      );
      const run = activeRuns.get(batchId);
      if (
        !run ||
        run.workspaceId !== authorizedWorkspaceId ||
        run.phase !== "running"
      ) {
        throw new PlaytestMcpValidationError(
          "No active run with that identifier exists in the authorized workspace."
        );
      }
      if (
        session.role !== "root" &&
        session.role !== "orchestrator" &&
        session.role !== "operator" &&
        (run.ownerActor !== session.actor ||
          run.ownerTaskId !== session.taskId ||
          run.ownerRunId !== session.runId)
      ) {
        throw new PlaytestMcpAuthorizationError(
          "Only the run owner or an authorized operator may cancel this run."
        );
      }
      return {
        batchId,
        cancellationRequested: cancelActiveRun(run, "cancelled")
      };
    },
    async waitForRun(session, workspaceId, batchId, waitMs) {
      assertRunStatusReader(session);
      const authorizedWorkspaceId = authorizeExistingRunWorkspace(
        session,
        workspaceId,
        readWorkspaceCatalog
      );
      if (!Number.isSafeInteger(waitMs) || waitMs < 0 || waitMs > 30_000) {
        throw new PlaytestMcpValidationError(
          "Run wait duration must be between 0 and 30000 milliseconds."
        );
      }
      const active = activeRuns.get(batchId);
      const completed = completedRuns.get(batchId);
      if (
        (active && active.workspaceId !== authorizedWorkspaceId) ||
        (completed && completed.workspaceId !== authorizedWorkspaceId)
      ) {
        throw new PlaytestMcpAuthorizationError(
          "The run is not owned by the authorized workspace."
        );
      }
      if (!active && !completed) {
        throw new PlaytestMcpValidationError(
          "No active or recently completed run with that identifier exists."
        );
      }
      if (active && waitMs > 0) {
        let timeout: NodeJS.Timeout | undefined;
        try {
          await Promise.race([
            active.completion,
            new Promise<void>((resolve) => {
              timeout = setTimeout(resolve, waitMs);
              timeout.unref();
            })
          ]);
        } finally {
          if (timeout) clearTimeout(timeout);
        }
      }
      const terminal = completedRuns.get(batchId);
      if (terminal) return terminal.status;
      const current = activeRuns.get(batchId);
      if (!current) {
        throw new PlaytestMcpUnavailableError(
          "Run status expired before it could be read."
        );
      }
      return {
        batchId,
        status: current.phase,
        cancellationReason: current.reason,
        result: null,
        error: null
      };
    },
    async shutdown() {
      const active = [...activeRuns.values()];
      for (const run of active) cancelActiveRun(run, "cancelled");
      if (active.length === 0) return;
      let timeout: NodeJS.Timeout | undefined;
      try {
        await Promise.race([
          Promise.allSettled(active.map((run) => run.completion)),
          new Promise<void>((resolve) => {
            timeout = setTimeout(resolve, RUN_SHUTDOWN_GRACE_MS);
          })
        ]);
      } finally {
        if (timeout) clearTimeout(timeout);
      }
    }
  };
  return playtestRunControl;
}

export function createPlaytestMcpServer(
  options: PlaytestMcpOptions
): PlaytestMcpServer {
  const mcp = new McpServer(
    { name: "playtest", version: RUNTIME_VERSION },
    { capabilities: { tools: {} } }
  );

  const {
    sessionProvider,
    artifactStoreForWorkspace,
    playtestRepository,
    approvalRepository,
    playtestRunControl,
    readWorkspaceCatalog = () => new ConfigRepository().readWorkspaceCatalog()
  } = options;

  // 1. playtest.capabilities
  mcp.registerTool(
    "playtest.capabilities",
    {
      description:
        "Inspect playtesting capabilities, budget limits, allowed scenarios and policies for an approved workspace.",
      inputSchema: {
        workspaceId: z.string().min(1).max(256).optional()
      }
    },
    ({ workspaceId }) =>
      safely(async () => {
        const session = await sessionProvider.current();
        const targetWorkspaceId = authorizeWorkspace(workspaceId, session);
        return await playtestRunControl.getCapabilities(
          session,
          targetWorkspaceId
        );
      })
  );

  // 2. playtest.run
  mcp.registerTool(
    "playtest.run",
    {
      description:
        "Execute an approved single-episode playtest run in an isolated sandbox with game adapter negotiation and verified artifact recording.",
      inputSchema: playtestRunRequestSchema
    },
    (request) =>
      safely(async () => {
        const session = await sessionProvider.current();
        return playtestRunControl.startRun(session, request);
      })
  );

  // The run tool returns the server-generated batch ID as soon as the active
  // operation is registered; these tools poll, wait for, or cancel that run.
  mcp.registerTool(
    "playtest.activeRuns",
    {
      description:
        "List active run identifiers in the caller's authorized workspace.",
      inputSchema: { workspaceId: z.string().min(1).max(256).optional() }
    },
    ({ workspaceId }) =>
      safely(async () => {
        const session = await sessionProvider.current();
        const targetWorkspaceId = authorizeWorkspace(workspaceId, session);
        return {
          runs: await playtestRunControl.listActiveRuns(
            session,
            targetWorkspaceId
          )
        };
      })
  );

  mcp.registerTool(
    "playtest.wait",
    {
      description:
        "Read run status immediately or wait a bounded duration for its result.",
      inputSchema: z.strictObject({
        workspaceId: z.string().min(1).max(256).optional(),
        batchId: z.string().min(1).max(256),
        waitMs: z.number().int().min(0).max(30_000).default(0)
      })
    },
    ({ workspaceId, batchId, waitMs }) =>
      safely(async () => {
        const session = await sessionProvider.current();
        const targetWorkspaceId = authorizeWorkspace(workspaceId, session);
        return playtestRunControl.waitForRun(
          session,
          targetWorkspaceId,
          batchId,
          waitMs
        );
      })
  );

  mcp.registerTool(
    "playtest.cancel",
    {
      description:
        "Cancel one active run by its server-generated immutable batch id.",
      inputSchema: z.strictObject({
        workspaceId: z.string().min(1).max(256).optional(),
        batchId: z.string().min(1).max(256)
      })
    },
    ({ workspaceId, batchId }) =>
      safely(async () => {
        const session = await sessionProvider.current();
        const targetWorkspaceId = authorizeWorkspace(workspaceId, session);
        return playtestRunControl.cancelRun(
          session,
          targetWorkspaceId,
          batchId
        );
      })
  );

  // 3. playtest.listEpisodes
  mcp.registerTool(
    "playtest.listEpisodes",
    {
      description:
        "List indexed playtest episodes with validated filtering and keyset pagination.",
      inputSchema: {
        workspaceId: z.string().min(1).max(256).optional(),
        batchId: z.string().max(256).optional(),
        buildSha: z.string().max(256).optional(),
        scenario: z.string().max(256).optional(),
        policy: z.string().max(256).optional(),
        cohort: z.string().max(256).optional(),
        status: z.enum([...PLAYTESTS_EPISODE_STATES]).optional(),
        gameOutcome: z.enum([...PLAYTESTS_GAME_OUTCOMES]).optional(),
        reviewStatus: z.enum(["reviewed", "unreviewed"]).optional(),
        cursor: z.string().max(2048).optional(),
        limit: z.number().int().min(1).max(500).default(50)
      }
    },
    (args) =>
      safely(async () => {
        const session = await sessionProvider.current();
        const targetWorkspaceId = authorizeWorkspace(args.workspaceId, session);
        if (!playtestRepository) {
          throw new PlaytestMcpUnavailableError(
            "Playtest data repository is not configured for episode listing."
          );
        }

        const page = await playtestRepository.listEpisodes(
          {
            workspaceId: targetWorkspaceId,
            ...(args.batchId ? { batchId: args.batchId } : {}),
            ...(args.buildSha ? { buildSha: args.buildSha } : {}),
            ...(args.scenario ? { scenario: args.scenario } : {}),
            ...(args.policy ? { policy: args.policy } : {}),
            ...(args.cohort ? { cohort: args.cohort } : {}),
            ...(args.status ? { status: args.status } : {}),
            ...(args.gameOutcome ? { gameOutcome: args.gameOutcome } : {}),
            ...(args.reviewStatus ? { reviewStatus: args.reviewStatus } : {})
          },
          {
            limit: args.limit,
            ...(args.cursor ? { cursor: args.cursor } : {})
          }
        );

        return {
          rows: page.rows,
          total: page.total,
          nextCursor: page.nextCursor
        };
      })
  );

  // 4. playtest.readEpisode
  mcp.registerTool(
    "playtest.readEpisode",
    {
      description:
        "Read an indexed playtest episode record and its latest review.",
      inputSchema: {
        episodeId: z.string().min(1).max(256),
        workspaceId: z.string().min(1).max(256).optional()
      }
    },
    ({ episodeId, workspaceId }) =>
      safely(async () => {
        const session = await sessionProvider.current();
        const targetWorkspaceId = authorizeWorkspace(workspaceId, session);
        if (!playtestRepository) {
          throw new PlaytestMcpUnavailableError(
            "Playtest data repository is not configured for reading episodes."
          );
        }

        const episode = await playtestRepository.getEpisode(
          targetWorkspaceId,
          episodeId
        );
        if (!episode) {
          throw new PlaytestMcpValidationError(
            'Playtest episode "' +
              episodeId +
              '" was not found in workspace "' +
              targetWorkspaceId +
              '".'
          );
        }

        const review = await playtestRepository.getLatestReviewForEpisode(
          targetWorkspaceId,
          episodeId
        );

        return { episode, review };
      })
  );

  // 5. playtest.readWindow
  mcp.registerTool(
    "playtest.readWindow",
    {
      description:
        "Read a bounded step window from an episode artifact, filtered to the requested step range.",
      inputSchema: {
        episodeId: z.string().min(1).max(256),
        artifactId: z.string().min(1).max(256),
        fromStep: z.number().int().min(0),
        toStep: z.number().int().min(0),
        maxBytes: z.number().int().min(1).max(10_000_000).optional(),
        workspaceId: z.string().min(1).max(256).optional()
      }
    },
    ({ episodeId, artifactId, fromStep, toStep, maxBytes, workspaceId }) =>
      safely(async () => {
        const session = await sessionProvider.current();
        const targetWorkspaceId = authorizeWorkspace(workspaceId, session);

        if (
          toStep < fromStep ||
          toStep - fromStep > 4095 ||
          toStep >= 100_000
        ) {
          throw new PlaytestMcpValidationError(
            "The requested step range must be ordered and bounded to at most 4096 steps."
          );
        }
        const artifacts = artifactStoreForWorkspace(targetWorkspaceId);
        if (artifacts.boundWorkspaceId() !== targetWorkspaceId) {
          throw new PlaytestMcpAuthorizationError(
            "The artifact store is not bound to the authorized workspace."
          );
        }
        if (!playtestRepository) {
          throw new PlaytestMcpUnavailableError(
            "Playtest Data storage is unavailable for episode ownership checks."
          );
        }
        const episode = await playtestRepository.getEpisode(
          targetWorkspaceId,
          episodeId
        );
        if (!episode) {
          throw new PlaytestMcpValidationError(
            "The requested episode does not exist in the authorized workspace."
          );
        }
        if (toStep >= episode.stepCount) {
          throw new PlaytestMcpValidationError(
            "The requested step range extends beyond the episode."
          );
        }
        if (episode.trace?.id !== artifactId) {
          throw new PlaytestMcpAuthorizationError(
            "The requested window artifact is not linked to this episode."
          );
        }
        const reference = artifacts.referenceForId(artifactId);
        if (!reference) {
          throw new PlaytestMcpValidationError(
            "The linked episode trace is unavailable in the artifact store."
          );
        }
        const windowResult: PlaytestArtifactWindowReadResult =
          artifacts.readWindow(reference);

        const filtered = selectWindowRange({
          result: windowResult,
          fromStep,
          toStep,
          maxBytes
        });

        return {
          artifactId: windowResult.reference.artifactId,
          sourceSha256: windowResult.reference.sha256,
          contentSha256: createHash("sha256")
            .update(filtered.bytes)
            .digest("hex"),
          bytes: filtered.bytes.byteLength,
          fromStep,
          toStep,
          lineCount: filtered.lineCount,
          bytesBase64: Buffer.from(filtered.bytes).toString("base64")
        };
      })
  );

  // 6. playtest.metrics
  mcp.registerTool(
    "playtest.metrics",
    {
      description:
        "Calculate or retrieve deterministic playtest metrics for an episode or batch.",
      inputSchema: {
        workspaceId: z.string().min(1).max(256).optional(),
        episodeId: z.string().max(256).optional(),
        batchId: z.string().max(256).optional(),
        cursor: z.string().max(2048).optional(),
        limit: z.number().int().min(1).max(500).default(50)
      }
    },
    ({ workspaceId, episodeId, batchId, cursor, limit }) =>
      safely(async () => {
        const session = await sessionProvider.current();
        const targetWorkspaceId = authorizeWorkspace(workspaceId, session);
        if (Boolean(episodeId) === Boolean(batchId)) {
          throw new PlaytestMcpValidationError(
            "Provide exactly one episodeId or batchId."
          );
        }
        if (!playtestRepository) {
          throw new PlaytestMcpUnavailableError(
            "Playtest data repository is not configured for metrics."
          );
        }

        if (episodeId) {
          const episode = await playtestRepository.getEpisode(
            targetWorkspaceId,
            episodeId
          );
          if (!episode) {
            throw new PlaytestMcpValidationError(
              'Episode "' +
                episodeId +
                '" not found in workspace "' +
                targetWorkspaceId +
                '".'
            );
          }
          return {
            episodeId,
            outcome: episode.outcome,
            numericResults: episode.metrics
          };
        }

        if (batchId) {
          const page = await playtestRepository.listEpisodes(
            { workspaceId: targetWorkspaceId, batchId },
            { limit: limit ?? 50, ...(cursor ? { cursor } : {}) }
          );
          return {
            kind: "per-episode-metrics",
            batchId,
            rows: page.rows.map((episode) => ({
              episodeId: episode.episodeId,
              metrics: episode.metrics
            })),
            total: page.total,
            nextCursor: page.nextCursor
          };
        }
        throw new PlaytestMcpValidationError(
          "A metric identifier is required."
        );
      })
  );

  // 7. playtest.compare
  mcp.registerTool(
    "playtest.compare",
    {
      description:
        "Return the latest code-owned PlaytestComparison stored for a benchmark/experiment pair. Never computes or fabricates a comparison inline.",
      inputSchema: {
        workspaceId: z.string().min(1).max(256).optional(),
        benchmarkId: z.string().min(1).max(256),
        experimentId: z.string().min(1).max(256)
      }
    },
    ({ workspaceId, benchmarkId, experimentId }) =>
      safely(async () => {
        const session = await sessionProvider.current();
        const targetWorkspaceId = authorizeWorkspace(workspaceId, session);
        if (!playtestRepository) {
          throw new PlaytestMcpUnavailableError(
            "Playtest data repository is not configured for comparisons."
          );
        }

        const page = await playtestRepository.listComparisons(
          {
            workspaceId: targetWorkspaceId,
            benchmarkId,
            experimentId
          },
          { limit: 1 }
        );

        const latest = page.rows[0];
        if (!latest) {
          throw new PlaytestMcpValidationError(
            'No stored comparison exists for benchmark "' +
              benchmarkId +
              '" and experiment "' +
              experimentId +
              '". A comparison must be computed and persisted by the owning analysis pipeline before it can be read here.'
          );
        }

        return latest;
      })
  );

  // 8. playtest.submitReview
  mcp.registerTool(
    "playtest.submitReview",
    {
      description:
        "Submit an immutable playtest review for an episode with evidence locator validation against the real stored evidence index.",
      inputSchema: {
        workspaceId: z.string().min(1).max(256).optional(),
        episodeId: z.string().min(1).max(256),
        chronologicalSummary: z.string().min(1).max(10_000),
        status: z.enum(REVIEWABLE_STATUSES),
        evidenceRefs: z.array(evidenceLocatorSchema).min(1),
        observations: z.array(z.string()).default([]),
        interpretations: z.array(z.string()).default([]),
        findings: z.array(findingSchema).default([]),
        rubricHash: z.string().min(1).max(256),
        notes: z.string().max(4000).optional()
      }
    },
    (args) =>
      safely(async () => {
        const session = await sessionProvider.current();
        const evidenceRefs = args.evidenceRefs ?? [];
        const reviewerRole = session.role;
        if (!isReviewerRole(reviewerRole)) {
          throw new PlaytestMcpAuthorizationError(
            "playtest.submitReview requires an authorized reviewer role."
          );
        }
        let findings: SubmittedFinding[];
        try {
          findings = (args.findings ?? []).map((finding) =>
            findingSchema.parse(finding)
          );
        } catch {
          throw new PlaytestMcpValidationError(
            "Submitted finding does not satisfy the finding schema."
          );
        }
        const targetWorkspaceId = authorizeWorkspace(args.workspaceId, session);
        if (!playtestRepository) {
          throw new PlaytestMcpUnavailableError(
            "Playtest data repository is not configured; the review cannot be recorded."
          );
        }
        if (!playtestRepository.insertReview) {
          throw new PlaytestMcpUnavailableError(
            "Playtest data repository does not support review persistence."
          );
        }
        if (args.status !== "hypothesis" && args.status !== "not observed") {
          throw new PlaytestMcpValidationError(
            "Reviewer conclusions remain hypothesis or not-observed until independent validation is available."
          );
        }
        const episode = await playtestRepository.getEpisode(
          targetWorkspaceId,
          args.episodeId
        );
        if (!episode) {
          throw new PlaytestMcpValidationError(
            'Playtest episode "' +
              args.episodeId +
              '" was not found in workspace "' +
              targetWorkspaceId +
              '".'
          );
        }

        const allEvidenceRefs = [
          ...evidenceRefs,
          ...findings.flatMap((finding) => finding.evidenceRefs)
        ] as PlaytestEvidenceLocator[];
        const traceFacts = readEpisodeTraceFacts(
          episode,
          artifactStoreForWorkspace(targetWorkspaceId)
        );
        const knownIndex = await buildKnownPlaytestEvidenceIndex(
          targetWorkspaceId,
          episode,
          allEvidenceRefs,
          traceFacts,
          playtestRepository
        );

        try {
          assertKnownEvidenceLocators(allEvidenceRefs, knownIndex);
          assertPlaytestSessionReviewHasEvidence({
            reviewId: "review-precheck",
            evidenceRefs: evidenceRefs as PlaytestEvidenceLocator[],
            findings: []
          });
          for (const finding of findings) {
            if (finding.evidenceRefs.length === 0) {
              throw new TypeError("Finding evidence is required.");
            }
          }
        } catch {
          throw new PlaytestMcpValidationError(
            "Review evidence references do not satisfy the stored-evidence contract."
          );
        }

        // §11 missed-known-issue / duplicate-flood gate. Collapse any
        // findings in THIS review that resolve to the same stable
        // identity fingerprint (so one review can never persist two
        // revisions of the same defect), then, per distinct fingerprint,
        // read the latest persisted revision and append the merged
        // result inside one serialized (workspace, fingerprint) critical
        // section so a concurrent submitReview on the same identity
        // cannot race to the same version number.
        const findingGroups = collapseInReviewDuplicateFindings(
          episode,
          traceFacts,
          findings
        );
        const resolvedFindings: PlaytestFinding[] = [];
        for (const group of findingGroups) {
          resolvedFindings.push(
            await serializeFindingAppend(
              targetWorkspaceId,
              group.fingerprint,
              () =>
                appendSubmittedFindingGroup(
                  targetWorkspaceId,
                  group,
                  knownIndex,
                  playtestRepository
                )
            )
          );
        }

        const review: PlaytestSessionReview = {
          schema: PLAYTESTS_SESSION_REVIEW_SCHEMA,
          reviewId: "rev-" + randomUUID(),
          version: 1,
          episodeId: args.episodeId,
          supersedes: null,
          authorRole: reviewerRole,
          authorId: session.actor,
          rubricHash: args.rubricHash,
          measurementVersion: PLAYTESTS_MEASUREMENT_VERSION,
          provenance: {
            workspaceId: targetWorkspaceId,
            measurementVersion: PLAYTESTS_MEASUREMENT_VERSION,
            generatedAt: new Date().toISOString()
          },
          chronologicalSummary: args.chronologicalSummary,
          authoritativeMetrics: [],
          observations: args.observations ?? [],
          interpretations: args.interpretations ?? [],
          anchors: [],
          alternativeExplanations: [],
          experiments: [],
          status: args.status,
          findings: resolvedFindings,
          evidenceRefs: evidenceRefs as PlaytestEvidenceLocator[],
          createdAt: new Date().toISOString(),
          notes: args.notes ?? ""
        };

        // Findings for this review are already persisted above, inside
        // the per-(workspace, fingerprint) serialized critical section;
        // only the review itself remains to be written.
        await playtestRepository.insertReview(review);

        return review;
      })
  );

  // 9. playtest.findings
  mcp.registerTool(
    "playtest.findings",
    {
      description:
        "List verified or hypothesized playtest findings with filter and pagination.",
      inputSchema: {
        workspaceId: z.string().min(1).max(256).optional(),
        severity: z.enum([...PLAYTESTS_SEVERITIES]).optional(),
        status: z.enum([...PLAYTESTS_FINDING_STATUSES]).optional(),
        verificationStage: z
          .enum([...PLAYTESTS_VERIFICATION_STAGES])
          .optional(),
        cursor: z.string().max(2048).optional(),
        limit: z.number().int().min(1).max(500).default(50)
      }
    },
    (args) =>
      safely(async () => {
        const session = await sessionProvider.current();
        const targetWorkspaceId = authorizeWorkspace(args.workspaceId, session);
        if (!playtestRepository) {
          throw new PlaytestMcpUnavailableError(
            "Playtest data repository is not configured for listing findings."
          );
        }

        const page = await playtestRepository.listFindings(
          {
            workspaceId: targetWorkspaceId,
            ...(args.severity ? { severity: args.severity } : {}),
            ...(args.status ? { status: args.status } : {}),
            ...(args.verificationStage
              ? { verificationStage: args.verificationStage }
              : {})
          },
          {
            limit: args.limit,
            ...(args.cursor ? { cursor: args.cursor } : {})
          }
        );

        return {
          rows: page.rows,
          total: page.total,
          nextCursor: page.nextCursor
        };
      })
  );

  // 10. playtest.branch
  mcp.registerTool(
    "playtest.branch",
    {
      description:
        "Execute a branched playtest episode starting from a specific parent episode step. Not yet supported by the Runtime; reports unavailable rather than fabricating a result.",
      inputSchema: {
        workspaceId: z.string().min(1).max(256).optional(),
        parentEpisodeId: z.string().min(1).max(256),
        branchStep: z.number().int().min(0),
        policy: z.string().min(1).max(256),
        scenario: z.string().max(256).optional(),
        maxSteps: z.number().int().min(1).max(100_000).optional()
      }
    },
    ({
      workspaceId,
      parentEpisodeId: _parentEpisodeId,
      branchStep: _branchStep,
      policy: _policy,
      scenario: _scenario,
      maxSteps: _maxSteps
    }) =>
      safely(async () => {
        const session = await sessionProvider.current();
        if (!RUNNER_ROLES.has(session.role)) {
          throw new PlaytestMcpAuthorizationError(
            "playtest.branch requires an authorized runner role."
          );
        }
        const targetWorkspaceId = authorizeWorkspace(workspaceId, session);
        assertSessionWorkspaceRole(
          session,
          assertCanonicalWorkspaceEnabled(
            targetWorkspaceId,
            readWorkspaceCatalog
          )
        );
        throw new PlaytestMcpUnavailableError(
          "playtest.branch is not yet supported: the Runtime has no checkpoint/resume adapter protocol to execute a branched episode from a parent step."
        );
      })
  );

  return Object.assign(mcp, { playtestRunControl });
}

async function safely<T>(operation: () => Promise<T>) {
  try {
    const result = await operation();
    return {
      content: [
        { type: "text" as const, text: JSON.stringify(result, null, 2) }
      ]
    };
  } catch (error) {
    const safeError = playtestMcpErrorDetails(error);
    if (safeError.code === "playtest_internal_error") {
      writeErrorLine("playtest-mcp: internal operation failure.");
    }
    return {
      isError: true,
      content: [
        { type: "text" as const, text: JSON.stringify({ error: safeError }) }
      ]
    };
  }
}

function playtestMcpErrorDetails(error: unknown): {
  readonly code: string;
  readonly category: string;
  readonly retryable: boolean;
  readonly message: string;
} {
  if (error instanceof PlaytestSourceUnavailableError) {
    return {
      code: "playtest_data_source_unavailable",
      category: "data-source",
      retryable: true,
      message: "Playtest Data is temporarily unavailable."
    };
  }
  if (error instanceof PlaytestInvalidCursorError) {
    return {
      code: "playtest_invalid_cursor",
      category: "validation",
      retryable: false,
      message: "The playtesting cursor is invalid."
    };
  }
  if (error instanceof PlaytestMcpAuthorizationError) {
    return {
      code: "playtest_forbidden",
      category: "authorization",
      retryable: false,
      message: "The playtesting request is not authorized."
    };
  }
  if (error instanceof PlaytestMcpValidationError) {
    return {
      code: "playtest_invalid_request",
      category: "validation",
      retryable: false,
      message: "The playtesting request is invalid or unsupported."
    };
  }
  if (error instanceof PlaytestMcpUnavailableError) {
    return {
      code: "playtest_unavailable",
      category: "unavailable",
      retryable: true,
      message: "The requested playtesting capability or storage is unavailable."
    };
  }
  if (error instanceof PlaytestSandboxApprovalError) {
    return {
      code: "playtest_approval_required",
      category: "approval",
      retryable: false,
      message: "An active approved playtesting configuration is required."
    };
  }
  if (error instanceof PlaytestSandboxExecutionError) {
    const retryable = [
      "docker-unavailable",
      "image-unavailable",
      "timeout"
    ].includes(error.category);
    return {
      code: "playtest_sandbox_" + error.category,
      category: "sandbox-execution",
      retryable,
      message: "The playtesting sandbox execution failed."
    };
  }
  if (error instanceof PlaytestSandboxUnavailableError) {
    return {
      code: "playtest_sandbox_unavailable",
      category: "sandbox-availability",
      retryable: true,
      message: "The playtesting sandbox is unavailable."
    };
  }
  return {
    code: "playtest_internal_error",
    category: "internal",
    retryable: false,
    message: "The playtesting operation failed. See Runtime diagnostics."
  };
}
