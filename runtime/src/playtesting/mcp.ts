/** Runtime-hosted Playtesting MCP server implementation. */
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  assertPlaytestAssignmentManifest,
  assertPlaytestAssignmentsMatchBenchmark,
  assertPlaytestBatchAssignments,
  assertPlaytestBranchLineage,
  assertPlaytestCheckpointDigest,
  assertPlaytestCoveragePlanCoversAssignments,
  assertPlaytestEvidenceLocatorsWithinPacket,
  assertPlaytestEvidencePacket,
  assertPlaytestFindingEvidenceStatusConsistent,
  assertPlaytestSessionReviewHasEvidence,
  buildPlaytestCoverageManifestDraft,
  buildPlaytestEvidencePacket,
  buildPlaytestFindingIdentity,
  canonicalPlaytestJson,
  type PlaytestArtifactReference,
  type PlaytestAssignmentBranch,
  type PlaytestAssignmentManifest,
  playtestAssignmentManifestHashInput,
  type PlaytestAssignmentOutcome,
  type PlaytestAssignmentTerminalState,
  type PlaytestBatch,
  type PlaytestBatchAssignment,
  type PlaytestBatchCancellationReason,
  playtestBatchCountsFromAssignments,
  type PlaytestBatchReviewSelection,
  playtestBatchTerminalState,
  type PlaytestCapabilityAdvertisement,
  type PlaytestCheckpointDigest,
  type PlaytestComparison,
  type PlaytestCompletionCounts,
  type PlaytestCoverageManifest,
  playtestCoverageManifestHashInput,
  type PlaytestCoveragePlanCell,
  playtestCoveragePlanForRegistry,
  playtestCrossSessionInventoryHashInput,
  type PlaytestDimensionAnchor,
  type PlaytestEpisode,
  type PlaytestEvidenceLocator,
  type PlaytestEvidenceOmittedArtifact,
  type PlaytestEvidencePacket,
  type PlaytestEvidenceTraceStep,
  type PlaytestFinding,
  type PlaytestFindingIdentity,
  playtestFindingIdentityHashInput,
  playtestFindingIdFromFingerprint,
  type PlaytestKnownEvidenceIndex,
  type PlaytestOwnerDisposition,
  type PlaytestReviewCandidate,
  type PlaytestReviewCompleteness,
  playtestReviewOutcomeKey,
  type PlaytestReviewPacketFailureReason,
  type PlaytestReviewPacketReceipt,
  type PlaytestReviewReceipt,
  PLAYTESTS_ASSIGNMENT_MANIFEST_SCHEMA,
  PLAYTESTS_BATCH_SCHEMA,
  PLAYTESTS_EPISODE_SCHEMA,
  PLAYTESTS_EPISODE_STATES,
  PLAYTESTS_EVIDENCE_PACKET_MEDIA_TYPE,
  PLAYTESTS_FINDING_STATUSES,
  PLAYTESTS_GAME_OUTCOMES,
  PLAYTESTS_MAX_BATCH_ASSIGNMENTS,
  PLAYTESTS_MAX_BATCH_REVIEW_SESSIONS,
  PLAYTESTS_MEASUREMENT_VERSION,
  PLAYTESTS_RNG_POLICY_VERSION,
  PLAYTESTS_SESSION_REVIEW_SCHEMA,
  PLAYTESTS_SEVERITIES,
  PLAYTESTS_VERIFICATION_STAGES,
  type PlaytestSessionReview,
  recordPlaytestOwnerDecision,
  scorePlaytestDimensionAnchor,
  selectPlaytestBatchReviews,
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
import { mapConcurrentOrdered } from "../shared/map-concurrent-ordered.ts";
import { writeErrorLine } from "../shared/output.ts";
import {
  type PlaytestArtifactStore,
  type PlaytestArtifactWindowReadResult,
  PLAYTESTS_ARTIFACT_WINDOW_MEDIA_TYPE
} from "./artifact-store.ts";
import {
  launchPlaytestSandbox,
  PlaytestSandboxApprovalError,
  PlaytestSandboxExecutionError,
  type PlaytestSandboxHandle,
  type PlaytestSandboxLaunchOptions,
  PlaytestSandboxUnavailableError,
  type PreparedPlaytestSandbox,
  preparePlaytestSandbox
} from "./docker-sandbox.ts";
import {
  MAX_PLAYTEST_EPISODE_TRACE_STEPS,
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
  readonly assignmentCount: number;
  readonly createdAt: string;
  /**
   * The same owner-read status the single-batch status route returns, so one
   * workspace-scoped list renders every nonterminal batch without a second
   * status authority or one request per batch.
   */
  readonly status: PlaytestRunStatus;
}

export interface PlaytestRunCancellationResult {
  readonly batchId: string;
  readonly cancellationRequested: boolean;
}

/** One bounded batch assignment; pairs to an episode by assignmentId, not seed. */
export interface PlaytestBatchAssignmentRequest {
  readonly scenario: string;
  readonly policy: string;
  readonly seed: string;
  readonly goal?: string | undefined;
  readonly maxSteps?: number | undefined;
}

/** One approved branch is frozen and executed as a one-assignment batch. */
export interface PlaytestBranchRunRequest {
  readonly workspaceId?: string | undefined;
  readonly parentEpisodeId: string;
  readonly branchStep: number;
  readonly alternativeActionId: string;
  readonly policy?: string | undefined;
  /** Maximum continuation steps; replay-prefix steps count against the approval. */
  readonly maxSteps?: number | undefined;
}

/** An ordered batch run or one explicit checkpoint-backed branch request. */
export type PlaytestRunRequest =
  | {
      readonly workspaceId?: string | undefined;
      readonly assignments: readonly PlaytestBatchAssignmentRequest[];
    }
  | PlaytestBranchRunRequest;

export interface PlaytestRunStatus {
  readonly batchId: string;
  readonly status:
    | "running"
    | "persisting"
    | "completed"
    | "failed"
    | "cancelled"
    | "truncated";
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
  readonly maxBatchAssignments: number;
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
  recordComparisonDecision(
    session: PlaytestMcpSession,
    workspaceId: string,
    comparisonId: string,
    expectedVersion: number,
    disposition: Exclude<PlaytestOwnerDisposition, "not-recorded">,
    reason: string
  ): Promise<PlaytestComparison>;
  getCapabilities(
    session: PlaytestMcpSession,
    workspaceId: string
  ): PlaytestRunCapabilities | Promise<PlaytestRunCapabilities>;
  startRun(
    session: PlaytestMcpSession,
    request: PlaytestRunRequest
  ): Promise<{
    readonly batchId: string;
    readonly assignmentCount: number;
    readonly status: "running";
  }>;
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
  getBatch(workspaceId: string, batchId: string): Promise<PlaytestBatch | null>;
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
  insertComparison(comparison: PlaytestComparison): Promise<void>;
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
    prepared: PreparedPlaytestSandbox,
    options?: PlaytestSandboxLaunchOptions
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
const ANALYSIS_READER_ROLES = new Set([
  REVIEWER_ROLE,
  "root",
  "orchestrator",
  "validator",
  "operator"
]);
const OWNER_DECISION_ROLES = new Set(["root", "operator"]);
const FINDING_READER_ROLES = new Set([
  "root",
  "orchestrator",
  "validator",
  "operator"
]);
const APPROVAL_POLL_INTERVAL_MS = 50;
const RUN_SHUTDOWN_GRACE_MS = 2000;
const MAX_FINDINGS_PER_REVIEW = 64;
const PLAYTEST_INFRASTRUCTURE_FAILURE_STATE = "infrastructure-failed" as const;
const MAX_REVIEW_PACKET_BYTES = 64 * 1024;
const REVIEW_PACKET_TOKEN_BUDGET = 16_384;
const NO_EPISODE_OUTCOME_STATES = new Set([
  PLAYTEST_INFRASTRUCTURE_FAILURE_STATE,
  "cancelled"
]);
const FINDING_APPEND_CONCURRENCY = 4;
const APPROVAL_REVOKED_REASON = "approval-revoked" as const;
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
  readonly assignmentCount: number;
  readonly reservedWorkers: number;
  readonly manifestHash: string;
  readonly createdAt: string;
  readonly outcomes: Map<string, PlaytestAssignmentOutcome>;
  readonly controller: AbortController;
  phase: "running" | "persisting";
  reason: PlaytestBatchCancellationReason | null;
  /** Every in-flight assignment sandbox; cancellation reaches all of them. */
  readonly sandboxes: Set<PlaytestSandboxHandle>;
  readonly completion: Promise<PlaytestRunStatus>;
  readonly resolveCompletion: (status: PlaytestRunStatus) => void;
}

type RunCancellationReason = PlaytestBatchCancellationReason;

function isReviewerRole(role: string): role is typeof REVIEWER_ROLE {
  return role === REVIEWER_ROLE;
}

function assertPlaytestToolRole(
  role: string,
  allowedRoles: ReadonlySet<string>,
  toolName: string
): void {
  if (!allowedRoles.has(role)) {
    throw new PlaytestMcpAuthorizationError(
      toolName + " is not available to the trusted session role."
    );
  }
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
  step: z.number().int().min(0).optional(),
  revision: z.number().int().min(0).optional(),
  frameIndex: z.number().int().min(0).optional(),
  phaseId: z.string().max(256).optional()
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

const reviewDimensionEvidenceSchema = z.strictObject({
  dimensionId: z.string().min(1).max(128),
  rationale: z.string().min(1).max(4000),
  evidenceRefs: z.array(evidenceLocatorSchema).max(64).default([]),
  counterexampleId: z.string().min(1).max(256).optional()
});

const reviewClaimSchema = z.strictObject({
  text: z.string().min(1).max(4000),
  evidenceRefs: z.array(evidenceLocatorSchema).min(1).max(64)
});

const reviewCompletenessSchema = z.strictObject({
  crossSessionContext: z.union([
    z.strictObject({
      status: z.literal("available"),
      evidenceRefs: z.array(evidenceLocatorSchema).min(1).max(4)
    }),
    z.strictObject({
      status: z.literal("unavailable"),
      reason: z.string().min(1).max(2000)
    })
  ]),
  alternatives: z.union([
    z.strictObject({ status: z.literal("provided") }),
    z.strictObject({
      status: z.literal("none-identified"),
      reason: z.string().min(1).max(2000)
    })
  ]),
  experiments: z.union([
    z.strictObject({ status: z.literal("proposed") }),
    z.strictObject({
      status: z.literal("none-recommended"),
      reason: z.string().min(1).max(2000)
    })
  ]),
  followUp: z.union([
    z.strictObject({
      status: z.literal("proposed"),
      text: z.string().min(1).max(4000)
    }),
    z.strictObject({
      status: z.literal("none"),
      reason: z.string().min(1).max(2000)
    })
  ])
});

const reviewExperimentSchema = z.strictObject({
  hypothesis: z.string().min(1).max(4000),
  falsifier: z.string().min(1).max(4000),
  metricId: z.string().min(1).max(256),
  controls: z.array(z.string().min(1).max(1000)).min(1).max(32),
  budget: z.string().min(1).max(1000)
});

const playtestBatchAssignmentSchema = z.strictObject({
  scenario: z.string().min(1).max(256),
  policy: z.string().min(1).max(256),
  seed: z.string().min(1).max(256),
  goal: z.string().max(1000).optional(),
  maxSteps: z.number().int().min(1).max(100_000).optional()
});

const playtestRunRequestSchema = z.strictObject({
  workspaceId: z.string().min(1).max(256).optional(),
  assignments: z
    .array(playtestBatchAssignmentSchema)
    .min(1)
    .max(PLAYTESTS_MAX_BATCH_ASSIGNMENTS)
});

const playtestBranchRunRequestSchema = z.strictObject({
  workspaceId: z.string().min(1).max(256).optional(),
  parentEpisodeId: z.string().min(1).max(256),
  branchStep: z.number().int().min(0).max(99_999),
  alternativeActionId: z.string().min(1).max(256),
  policy: z.string().min(1).max(256).optional(),
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
const batchReviewLocks = new Map<string, Promise<unknown>>();

function serializeBatchReview<T>(
  workspaceId: string,
  batchId: string,
  operation: () => Promise<T>
): Promise<T> {
  const key = JSON.stringify([workspaceId, batchId]);
  const previous = batchReviewLocks.get(key) ?? Promise.resolve();
  const settled = previous.catch(() => undefined).then(operation);
  const tracked = settled.then(
    () => undefined,
    () => undefined
  );
  batchReviewLocks.set(key, tracked);
  void tracked.then(() => {
    if (batchReviewLocks.get(key) === tracked) batchReviewLocks.delete(key);
    return undefined;
  });
  return settled;
}

type PlaytestReviewReceiptInput = Omit<PlaytestReviewReceipt, "status">;

function assertReviewReceiptMatchesBatch(
  batch: PlaytestBatch,
  receipt: PlaytestReviewReceiptInput
): void {
  if (batch.reviewSelection.status !== "selected") {
    throw new PlaytestMcpValidationError(
      "The batch has no frozen critique selection."
    );
  }
  if (
    !batch.reviewPackets.some(
      (packet) =>
        packet.status === "prepared" &&
        packet.packetId === receipt.packetId &&
        packet.assignmentId === receipt.assignmentId &&
        packet.episodeId === receipt.episodeId
    )
  ) {
    throw new PlaytestMcpUnavailableError(
      "The review receipt has no matching persisted evidence packet."
    );
  }
  if (
    !batch.reviewSelection.selected.some(
      (selected) =>
        selected.assignmentId === receipt.assignmentId &&
        selected.episodeId === receipt.episodeId
    )
  ) {
    throw new PlaytestMcpAuthorizationError(
      "The review receipt does not match a selected session."
    );
  }
}

async function reserveBatchReviewReceipt(
  batch: PlaytestBatch,
  receipt: PlaytestReviewReceiptInput,
  repository: PlaytestingRepositoryOps
): Promise<PlaytestBatch> {
  const existing = batch.reviewReceipts.find(
    (entry) => entry.reviewId === receipt.reviewId
  );
  if (existing) {
    if (
      existing.packetId !== receipt.packetId ||
      existing.assignmentId !== receipt.assignmentId ||
      existing.episodeId !== receipt.episodeId
    ) {
      throw new PlaytestMcpUnavailableError(
        "The review id already has a conflicting packet receipt."
      );
    }
    return batch;
  }
  if (batch.reviewSelection.status !== "selected") {
    throw new PlaytestMcpValidationError(
      "The batch has no frozen critique selection."
    );
  }
  assertReviewReceiptMatchesBatch(batch, receipt);
  const reserved = batch.reviewReceipts.filter(
    (entry) => entry.status === "reserved"
  ).length;
  if (
    batch.budget.actualCritiques + reserved >=
    batch.reviewSelection.reviewCap
  ) {
    throw new PlaytestMcpValidationError(
      "The frozen batch critique budget is exhausted."
    );
  }
  const updated: PlaytestBatch = {
    ...batch,
    revision: batch.revision + 1,
    reviewReceipts: [
      ...batch.reviewReceipts,
      { ...receipt, status: "reserved" }
    ]
  };
  await repository.insertBatch(updated);
  return updated;
}

async function persistBatchReviewReceipt(
  batch: PlaytestBatch,
  reviewId: string,
  repository: PlaytestingRepositoryOps
): Promise<PlaytestBatch> {
  const existing = batch.reviewReceipts.find(
    (receipt) => receipt.reviewId === reviewId
  );
  if (!existing) {
    throw new PlaytestMcpUnavailableError(
      "The review has no durable critique reservation."
    );
  }
  if (existing.status === "persisted") return batch;
  assertReviewReceiptMatchesBatch(batch, existing);
  const reviewReceipts = batch.reviewReceipts.map((receipt) =>
    receipt.reviewId === reviewId
      ? { ...receipt, status: "persisted" as const }
      : receipt
  );
  const persisted = reviewReceipts.filter(
    (receipt) => receipt.status === "persisted"
  );
  const reviewedAssignments = new Set(
    persisted.map((receipt) => receipt.assignmentId)
  );
  const updated: PlaytestBatch = {
    ...batch,
    revision: batch.revision + 1,
    reviewReceipts,
    counts: { ...batch.counts, reviewed: reviewedAssignments.size },
    budget: { ...batch.budget, actualCritiques: persisted.length }
  };
  await repository.insertBatch(updated);
  return updated;
}

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
    return undefined;
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
      canonicalPlaytestJson(current) !== canonicalPlaytestJson(expected)
    ) {
      return APPROVAL_REVOKED_REASON;
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
    return APPROVAL_REVOKED_REASON;
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
      canonicalPlaytestJson({
        buildSha: approval.buildSha,
        configHash: approval.playtestConfigHash,
        adapterImageDigest: approval.adapterImageDigest,
        runtimeVersion
      })
    )
    .digest("hex");
}

/** Frozen assignment inventory plus everything one batch execution needs. */
interface BranchExecutionPlan {
  readonly manifest: PlaytestAssignmentBranch;
  readonly parentEpisode: PlaytestEpisode;
  readonly traceBytes: Uint8Array;
}

interface ApprovedBatchContext {
  readonly manifest: PlaytestAssignmentManifest;
  readonly prepared: PreparedPlaytestSandbox;
  readonly assignments: readonly PlaytestBatchAssignment[];
  readonly policies: ReadonlyMap<string, PlaytestPolicy>;
  readonly coveragePlan: readonly PlaytestCoveragePlanCell[];
  readonly maxSteps: ReadonlyMap<string, number>;
  readonly branchPlan: BranchExecutionPlan | null;
}

function freezePlaytestCoverageManifest(
  input: Parameters<typeof buildPlaytestCoverageManifestDraft>[0]
): PlaytestCoverageManifest {
  const draft = buildPlaytestCoverageManifestDraft(input);
  return {
    ...draft,
    contentHash: createHash("sha256")
      .update(playtestCoverageManifestHashInput(draft))
      .digest("hex")
  };
}

function coverageManifestForBatch(input: {
  readonly manifest: PlaytestAssignmentManifest;
  readonly prepared: PreparedPlaytestSandbox;
  readonly plan: readonly PlaytestCoveragePlanCell[];
  readonly episodes: readonly PlaytestEpisode[];
  readonly generatedAt: string;
}): PlaytestCoverageManifest {
  return freezePlaytestCoverageManifest({
    rubricHash: input.prepared.rubricHash,
    assignmentManifestHash: input.manifest.contentHash,
    mode: input.prepared.observationContract.mode,
    generatedAt: input.generatedAt,
    batchId: input.manifest.batchId,
    workspaceId: input.manifest.workspaceId,
    buildSha: input.manifest.buildSha,
    plan: input.plan,
    assignments: input.manifest.assignments,
    episodes: input.episodes
  });
}

function batchRecordFor(input: {
  readonly manifest: PlaytestAssignmentManifest;
  readonly prepared: PreparedPlaytestSandbox;
  readonly approval: WorkspacePlaytestApproval;
  readonly revision: number;
  readonly status: PlaytestBatch["status"];
  readonly counts: PlaytestCompletionCounts;
  readonly reviewSelection: PlaytestBatchReviewSelection;
  readonly reviewPackets: readonly PlaytestReviewPacketReceipt[];
  readonly cancellationReason: PlaytestBatchCancellationReason | null;
  readonly failureReason: PlaytestBatch["failureReason"];
  readonly unobservedAssignments: readonly PlaytestAssignmentOutcome[] | null;
  readonly capabilities: PlaytestCapabilityAdvertisement | null;
  readonly coverageManifest: PlaytestCoverageManifest;
  readonly createdAt: string;
  readonly startedAt: string | null;
  readonly completedAt: string | null;
  readonly actualCritiques: number;
}): PlaytestBatch {
  const { manifest, prepared, approval, counts } = input;
  const assignments = manifest.assignments;
  const generatedAt = input.completedAt ?? input.createdAt;
  return {
    schema: PLAYTESTS_BATCH_SCHEMA,
    batchId: manifest.batchId,
    revision: input.revision,
    workspaceId: approval.workspaceId,
    repository: approval.workspaceId,
    buildSha: manifest.buildSha,
    gameBuild: input.capabilities?.engineBuild ?? approval.gameBuild,
    configHash: manifest.configHash,
    rubricHash: prepared.rubricHash,
    actionSchemaHash: input.capabilities?.actionSchemaHash ?? null,
    observationSchemaHash: input.capabilities?.observationSchemaHash ?? null,
    eventSchemaHash: input.capabilities?.eventSchemaHash ?? null,
    measurementVersion: PLAYTESTS_MEASUREMENT_VERSION,
    protocolVersion: 1,
    policyIds: [...new Set(assignments.map((a) => a.policyId))],
    cohortIds: [
      ...new Set(
        assignments.flatMap((assignment) =>
          assignment.cohort === null ? [] : [assignment.cohort]
        )
      )
    ],
    scenarioIds: [...new Set(assignments.map((a) => a.scenarioId))],
    assignmentInventory: {
      status: "frozen",
      manifest
    },
    coverageManifest: input.coverageManifest,
    unobservedAssignments: input.unobservedAssignments,
    reviewSelection: input.reviewSelection,
    reviewPackets: input.reviewPackets,
    reviewReceipts: [],
    status: input.status,
    cancellationReason: input.cancellationReason,
    failureReason: input.failureReason,
    counts,
    budget: {
      assignedEpisodes: assignments.length,
      maxStepsPerEpisode: Math.max(
        ...assignments.map((assignment) => assignment.maxSteps)
      ),
      wallTimeMs: approval.limits.wallTimeMs,
      critiqueBudget: approval.limits.critiqueCount,
      actualCritiques: input.actualCritiques
    },
    startedAt: input.startedAt,
    completedAt: input.completedAt,
    createdAt: input.createdAt,
    provenance: {
      workspaceId: approval.workspaceId,
      buildSha: manifest.buildSha,
      measurementVersion: PLAYTESTS_MEASUREMENT_VERSION,
      generatedAt
    },
    evaluationIds: [],
    spanIds: []
  };
}

/** Batch counts while assignments are still in flight: assigned only. */
function runningBatchCounts(assignmentCount: number): PlaytestCompletionCounts {
  return {
    assigned: assignmentCount,
    started: 0,
    completed: 0,
    crashed: 0,
    infrastructureFailed: 0,
    cancelled: 0,
    budgetTruncated: 0,
    reviewed: 0,
    eligible: 0
  };
}

function cancelActiveRun(
  run: ActivePlaytestRun,
  reason: RunCancellationReason
): boolean {
  if (run.phase !== "running" || run.reason !== null) return false;
  run.reason = reason;
  run.controller.abort(reason);
  for (const sandbox of run.sandboxes) {
    void sandbox.cancel().catch(() => undefined);
  }
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

function persistedEpisodesForBatch(
  repository: PlaytestingRepositoryOps,
  batch: PlaytestBatch
): Promise<readonly PlaytestEpisode[]> {
  const readPage = async (
    cursor: string | undefined,
    episodes: readonly PlaytestEpisode[],
    seenCursors: ReadonlySet<string>
  ): Promise<readonly PlaytestEpisode[]> => {
    const page = await repository.listEpisodes(
      { workspaceId: batch.workspaceId, batchId: batch.batchId },
      { limit: 500, ...(cursor ? { cursor } : {}) }
    );
    const nextCursor = page.nextCursor ?? undefined;
    if (!nextCursor) return [...episodes, ...page.rows];
    if (seenCursors.has(nextCursor)) {
      throw new PlaytestMcpUnavailableError(
        "Playtest Data returned a repeated cursor while restoring batch status."
      );
    }
    const nextSeenCursors = new Set(seenCursors);
    nextSeenCursors.add(nextCursor);
    return readPage(nextCursor, [...episodes, ...page.rows], nextSeenCursors);
  };
  return readPage(undefined, [], new Set());
}

function assertPersistedAssignmentManifestMatchesBatch(
  batch: PlaytestBatch,
  manifest: PlaytestAssignmentManifest
): void {
  try {
    assertPlaytestAssignmentManifest(manifest);
  } catch {
    throw new PlaytestMcpUnavailableError(
      "The persisted batch assignment manifest is invalid."
    );
  }
  const manifestHash = createHash("sha256")
    .update(playtestAssignmentManifestHashInput(manifest))
    .digest("hex");
  if (
    manifestHash !== manifest.contentHash.toLowerCase() ||
    manifest.batchId !== batch.batchId ||
    manifest.workspaceId !== batch.workspaceId ||
    manifest.buildSha !== batch.buildSha ||
    manifest.configHash !== batch.configHash ||
    manifest.rubricHash !== batch.rubricHash ||
    manifest.assignments.length !== batch.budget.assignedEpisodes
  ) {
    throw new PlaytestMcpUnavailableError(
      "The persisted batch identity does not match its assignment manifest."
    );
  }
}

function assertPersistedEpisodeMatchesAssignment(input: {
  readonly batch: PlaytestBatch;
  readonly assignment: PlaytestBatchAssignment;
  readonly episode: PlaytestEpisode;
  readonly episodeByAssignment: ReadonlyMap<string, PlaytestEpisode>;
}): void {
  const { batch, assignment, episode, episodeByAssignment } = input;
  if (
    episode.assignmentId !== assignment.assignmentId ||
    episode.batchId !== batch.batchId ||
    episode.identity.workspaceId !== batch.workspaceId ||
    episode.identity.buildSha !== batch.buildSha ||
    episode.identity.configHash !== batch.configHash ||
    episode.identity.scenarioId !== assignment.scenarioId ||
    episode.identity.policyId !== assignment.policyId ||
    episode.identity.policyVersion !== assignment.policyVersion ||
    episode.identity.seed !== assignment.seed ||
    episode.scenarioFamily !== assignment.scenarioFamily ||
    (assignment.cohort !== null &&
      episode.policyCohort !== assignment.cohort) ||
    episodeByAssignment.has(assignment.assignmentId)
  ) {
    throw new PlaytestMcpUnavailableError(
      "Persisted episodes do not uniquely match the frozen batch assignments."
    );
  }
}

function assertNoEpisodeOutcomesMatchManifest(input: {
  readonly outcomes: readonly PlaytestAssignmentOutcome[];
  readonly assignments: ReadonlyMap<string, PlaytestBatchAssignment>;
}): void {
  const ids = new Set<string>();
  for (const outcome of input.outcomes) {
    if (
      ids.has(outcome.assignmentId) ||
      !input.assignments.has(outcome.assignmentId) ||
      outcome.episodeId !== null ||
      outcome.eligible ||
      !NO_EPISODE_OUTCOME_STATES.has(outcome.state)
    ) {
      throw new PlaytestMcpUnavailableError(
        "The persisted batch contains invalid no-episode assignment outcomes."
      );
    }
    ids.add(outcome.assignmentId);
  }
}

function outcomeForPersistedAssignment(input: {
  readonly assignment: PlaytestBatchAssignment;
  readonly episode?: PlaytestEpisode | undefined;
  readonly unobserved?: PlaytestAssignmentOutcome | undefined;
}): PlaytestAssignmentOutcome {
  const { assignment, episode, unobserved } = input;
  if (episode && unobserved) {
    throw new PlaytestMcpUnavailableError(
      "A batch assignment has both an episode and a no-episode outcome."
    );
  }
  if (unobserved) return unobserved;
  if (!episode) {
    return {
      assignmentId: assignment.assignmentId,
      episodeId: null,
      state: PLAYTEST_INFRASTRUCTURE_FAILURE_STATE,
      started: false,
      eligible: false
    };
  }
  const state: PlaytestAssignmentTerminalState =
    episode.status === "assigned" || episode.status === "started"
      ? PLAYTEST_INFRASTRUCTURE_FAILURE_STATE
      : episode.status;
  return {
    assignmentId: assignment.assignmentId,
    episodeId: episode.episodeId,
    state,
    started: episode.startedAt !== null,
    eligible: state === "completed" && episode.completionCounts.eligible === 1
  };
}

function assignmentOutcomesFromPersistedBatch(
  batch: PlaytestBatch,
  episodes: readonly PlaytestEpisode[]
): readonly PlaytestAssignmentOutcome[] {
  if (batch.assignmentInventory.status !== "frozen") {
    throw new PlaytestMcpUnavailableError(
      "This batch has no frozen assignment manifest for status recovery."
    );
  }
  const manifest = batch.assignmentInventory.manifest;
  assertPersistedAssignmentManifestMatchesBatch(batch, manifest);
  const assignments = new Map(
    manifest.assignments.map((assignment) => [
      assignment.assignmentId,
      assignment
    ])
  );
  const episodeByAssignment = new Map<string, PlaytestEpisode>();
  for (const episode of episodes) {
    const assignment =
      episode.assignmentId === null
        ? undefined
        : assignments.get(episode.assignmentId);
    if (!assignment) {
      throw new PlaytestMcpUnavailableError(
        "Persisted episodes do not uniquely match the frozen batch assignments."
      );
    }
    assertPersistedEpisodeMatchesAssignment({
      batch,
      assignment,
      episode,
      episodeByAssignment
    });
    episodeByAssignment.set(assignment.assignmentId, episode);
  }
  const unobserved = batch.unobservedAssignments ?? [];
  assertNoEpisodeOutcomesMatchManifest({
    outcomes: unobserved,
    assignments
  });
  const unobservedByAssignment = new Map(
    unobserved.map((outcome) => [outcome.assignmentId, outcome])
  );
  return manifest.assignments.map((assignment) =>
    outcomeForPersistedAssignment({
      assignment,
      episode: episodeByAssignment.get(assignment.assignmentId),
      unobserved: unobservedByAssignment.get(assignment.assignmentId)
    })
  );
}

function historicalBatchRunStatus(batch: PlaytestBatch): PlaytestRunStatus {
  if (batch.status === "running" || batch.status === "queued") {
    throw new PlaytestMcpUnavailableError(
      "A pre-manifest batch cannot be safely reconciled after Runtime restart."
    );
  }
  return {
    batchId: batch.batchId,
    status:
      batch.status === "cancelled"
        ? "cancelled"
        : batch.status === "completed" || batch.status === "truncated"
          ? batch.status
          : "failed",
    cancellationReason: batch.cancellationReason,
    result: null,
    error: {
      code: "playtest_legacy_result_unavailable",
      category: "history",
      retryable: false,
      message:
        "This historical batch predates assignment manifests; only its stored status is available."
    }
  };
}

function coverageFromStoredBatch(
  batch: PlaytestBatch,
  episodes: readonly PlaytestEpisode[],
  interrupted: boolean
): PlaytestCoverageManifest | null {
  if (batch.assignmentInventory.status !== "frozen") return null;
  const assignments = batch.assignmentInventory.manifest.assignments;
  const persisted = batch.coverageManifest;
  if (
    persisted === null &&
    assignments.some((assignment) => assignment.cohort !== null)
  ) {
    throw new PlaytestMcpUnavailableError(
      "The frozen batch is missing its required coverage manifest."
    );
  }
  if (persisted === null) return null;
  return freezePlaytestCoverageManifest({
    rubricHash: batch.rubricHash,
    assignmentManifestHash: batch.assignmentInventory.manifest.contentHash,
    mode: persisted.mode,
    generatedAt: interrupted ? new Date().toISOString() : persisted.generatedAt,
    batchId: batch.batchId,
    workspaceId: batch.workspaceId,
    buildSha: batch.buildSha,
    plan: persisted.cells,
    assignments,
    episodes
  });
}

function batchRunResult(
  batch: PlaytestBatch,
  outcomes: readonly PlaytestAssignmentOutcome[],
  counts: PlaytestCompletionCounts,
  reviewSelection: PlaytestBatchReviewSelection,
  cancellation: PlaytestBatchCancellationReason | null
): unknown {
  return {
    batchId: batch.batchId,
    assignmentCount: batch.budget.assignedEpisodes,
    manifestHash:
      batch.assignmentInventory.status === "frozen"
        ? batch.assignmentInventory.manifest.contentHash
        : null,
    concurrency: null,
    outcomes,
    counts,
    reviewSelection,
    cancellation,
    selectedReviewEpisodeIds:
      reviewSelection.status === "selected"
        ? reviewSelection.selected.map((item) => item.episodeId)
        : []
  };
}

async function recoverInterruptedBatch(input: {
  readonly repository: PlaytestingRepositoryOps;
  readonly batch: PlaytestBatch;
  readonly outcomes: readonly PlaytestAssignmentOutcome[];
  readonly counts: PlaytestCompletionCounts;
  readonly coverageManifest: PlaytestCoverageManifest | null;
}): Promise<PlaytestRunStatus> {
  const { repository, batch, outcomes, counts, coverageManifest } = input;
  const recovered: PlaytestBatch = {
    ...batch,
    revision: batch.revision + 1,
    status: playtestBatchTerminalState({
      assignmentCount: batch.budget.assignedEpisodes,
      outcomes,
      cancelled: false,
      aborted: true
    }),
    counts,
    coverageManifest,
    reviewSelection: { status: "unavailable", reason: "batch-incomplete" },
    unobservedAssignments: outcomes.filter(
      (outcome) => outcome.episodeId === null
    ),
    failureReason: "nonterminal-batch-recovered",
    completedAt: new Date().toISOString()
  };
  await repository.insertBatch(recovered);
  return {
    batchId: recovered.batchId,
    status: "failed",
    cancellationReason: null,
    result: batchRunResult(
      recovered,
      outcomes,
      counts,
      recovered.reviewSelection,
      null
    ),
    error: {
      code: "playtest_run_interrupted",
      category: "execution",
      retryable: false,
      message:
        "The Runtime ended without persisting a terminal batch state; missing episode evidence was retained as infrastructure loss."
    }
  };
}

function completedBatchRunStatus(input: {
  readonly batch: PlaytestBatch;
  readonly outcomes: readonly PlaytestAssignmentOutcome[];
  readonly counts: PlaytestCompletionCounts;
  readonly coverageManifest: PlaytestCoverageManifest | null;
}): PlaytestRunStatus {
  const { batch, outcomes, counts, coverageManifest } = input;
  if (canonicalPlaytestJson(counts) !== canonicalPlaytestJson(batch.counts)) {
    throw new PlaytestMcpUnavailableError(
      "Persisted batch counts do not match its assignment and episode history."
    );
  }
  if (
    batch.coverageManifest !== null &&
    canonicalPlaytestJson(coverageManifest) !==
      canonicalPlaytestJson(batch.coverageManifest)
  ) {
    throw new PlaytestMcpUnavailableError(
      "Persisted batch coverage does not match its episode and assignment history."
    );
  }
  const status =
    batch.status === "cancelled"
      ? "cancelled"
      : batch.status === "completed" || batch.status === "truncated"
        ? batch.status
        : "failed";
  return {
    batchId: batch.batchId,
    status,
    cancellationReason: batch.cancellationReason,
    result: batchRunResult(
      batch,
      outcomes,
      counts,
      batch.reviewSelection,
      batch.cancellationReason
    ),
    error:
      batch.failureReason === "nonterminal-batch-recovered"
        ? {
            code: "playtest_run_interrupted",
            category: "execution",
            retryable: false,
            message:
              "The Runtime ended without persisting a terminal batch state; missing episode evidence was retained as infrastructure loss."
          }
        : null
  };
}

async function recoverPersistedRunStatus(
  repository: PlaytestingRepositoryOps,
  batch: PlaytestBatch
): Promise<PlaytestRunStatus> {
  if (batch.assignmentInventory.status !== "frozen") {
    return historicalBatchRunStatus(batch);
  }
  const episodes = await persistedEpisodesForBatch(repository, batch);
  const outcomes = assignmentOutcomesFromPersistedBatch(batch, episodes);
  const interrupted = batch.status === "running" || batch.status === "queued";
  const coverageManifest = coverageFromStoredBatch(
    batch,
    episodes,
    interrupted
  );
  const counts = playtestBatchCountsFromAssignments({
    assignmentCount: batch.budget.assignedEpisodes,
    outcomes,
    reviewed: new Set(
      batch.reviewReceipts.map((receipt) => receipt.assignmentId)
    ).size
  });
  if (interrupted) {
    return recoverInterruptedBatch({
      repository,
      batch,
      outcomes,
      counts,
      coverageManifest
    });
  }
  return completedBatchRunStatus({ batch, outcomes, counts, coverageManifest });
}

function readStoredRunStatus(
  repository: PlaytestingRepositoryOps,
  workspaceId: string,
  batchId: string,
  locks: Map<string, Promise<void>>
): Promise<PlaytestRunStatus> {
  return withAssignmentLock(
    locks,
    "batch-status\0" + workspaceId + "\0" + batchId,
    async () => {
      const batch = await repository.getBatch(workspaceId, batchId);
      if (!batch) {
        throw new PlaytestMcpValidationError(
          "No run with that identifier exists in the authorized workspace."
        );
      }
      if (batch.workspaceId !== workspaceId) {
        throw new PlaytestMcpAuthorizationError(
          "The run is not owned by the authorized workspace."
        );
      }
      return recoverPersistedRunStatus(repository, batch);
    }
  );
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

function markRunPersisting(run: ActivePlaytestRun): void {
  run.phase = "persisting";
}

function activeRunProgress(run: ActivePlaytestRun): {
  readonly batchId: string;
  readonly assignmentCount: number;
  readonly manifestHash: string;
  readonly concurrency: number;
  readonly outcomes: readonly PlaytestAssignmentOutcome[];
  readonly counts: PlaytestCompletionCounts;
  readonly reviewSelection: { readonly status: "pending" };
  readonly cancellation: RunCancellationReason | null;
  readonly selectedReviewEpisodeIds: readonly string[];
} {
  const outcomes = [...run.outcomes.values()].sort((left, right) => {
    if (left.assignmentId < right.assignmentId) return -1;
    if (left.assignmentId > right.assignmentId) return 1;
    return 0;
  });
  return {
    batchId: run.batchId,
    assignmentCount: run.assignmentCount,
    manifestHash: run.manifestHash,
    concurrency: run.reservedWorkers,
    outcomes,
    counts: playtestBatchCountsFromAssignments({
      assignmentCount: run.assignmentCount,
      outcomes,
      reviewed: 0
    }),
    reviewSelection: { status: "pending" },
    cancellation: run.reason,
    selectedReviewEpisodeIds: []
  };
}

/**
 * The single owner read of one live run. Both the workspace-scoped active-run
 * list and the single-batch status route project through this, so a Console
 * watching many batches and one watching one batch cannot disagree.
 */
function activeRunStatus(run: ActivePlaytestRun): PlaytestRunStatus {
  return {
    batchId: run.batchId,
    status: run.phase,
    cancellationReason: run.reason,
    result: activeRunProgress(run),
    error: null
  };
}

function scenarioFamilyFor(
  prepared: PreparedPlaytestSandbox,
  scenario: string
): string {
  const family = prepared.configuration.scenarioFamilies[scenario];
  if (!family) {
    throw new PlaytestMcpValidationError(
      "The approved scenario has no game-owned scenario family."
    );
  }
  return family;
}

function assertBatchReviewBudget(
  prepared: PreparedPlaytestSandbox,
  approval: WorkspacePlaytestApproval
): void {
  const maxReviewedSessions =
    prepared.configuration.analysis.maxReviewedSessions;
  if (maxReviewedSessions > approval.limits.critiqueCount) {
    throw new PlaytestMcpValidationError(
      "The target critique plan exceeds the approved critique budget."
    );
  }
  if (maxReviewedSessions > PLAYTESTS_MAX_BATCH_REVIEW_SESSIONS) {
    throw new PlaytestMcpValidationError(
      "A playtest batch may select at most " +
        String(PLAYTESTS_MAX_BATCH_REVIEW_SESSIONS) +
        " complete-session critiques."
    );
  }
}

async function resolveBranchExecutionPlan(input: {
  readonly request: PlaytestBranchRunRequest;
  readonly workspaceId: string;
  readonly approval: WorkspacePlaytestApproval;
  readonly prepared: PreparedPlaytestSandbox;
  readonly repository: PlaytestingRepositoryOps;
  readonly artifacts: PlaytestArtifactStore;
}): Promise<{
  readonly assignments: readonly PlaytestBatchAssignmentRequest[];
  readonly branchPlan: BranchExecutionPlan;
}> {
  const { request, workspaceId, approval, prepared, repository, artifacts } =
    input;
  if (artifacts.boundWorkspaceId() !== workspaceId) {
    throw new PlaytestMcpAuthorizationError(
      "The branch artifact store is not bound to the authorized workspace."
    );
  }
  const parent = await repository.getEpisode(
    workspaceId,
    request.parentEpisodeId
  );
  if (!parent) {
    throw new PlaytestMcpValidationError(
      "The branch source episode does not exist in the authorized workspace."
    );
  }
  if (
    parent.status !== "completed" ||
    parent.completeness !== "complete" ||
    parent.trace?.kind !== "replay-segment" ||
    (parent.replayStatus !== "trace-replayable" &&
      parent.replayStatus !== "verified") ||
    parent.identity.workspaceId !== workspaceId ||
    parent.identity.buildSha.toLowerCase() !==
      approval.buildSha.toLowerCase() ||
    parent.identity.configHash !== approval.playtestConfigHash ||
    parent.identity.gameBuild !== approval.gameBuild ||
    request.branchStep >= parent.stepCount
  ) {
    throw new PlaytestMcpValidationError(
      "The source episode is incomplete, non-replayable, outside the approved build/config, or has no decision at that step."
    );
  }
  const traceReference = artifacts.referenceForId(parent.trace.id);
  if (!traceReference || traceReference.mediaType !== "application/x-ndjson") {
    throw new PlaytestMcpValidationError(
      "The source episode's indexed replay trace is unavailable or has an unsupported media type."
    );
  }
  let traceWindow: PlaytestArtifactWindowReadResult;
  try {
    traceWindow = artifacts.readWindow(traceReference);
  } catch {
    throw new PlaytestMcpValidationError(
      "The source episode's replay trace is expired, corrupt, or unavailable."
    );
  }
  let stepRecord: Record<string, unknown> | null = null;
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(
      traceWindow.bytes
    );
    for (const line of text.split("\n")) {
      if (!line) continue;
      const candidate: unknown = JSON.parse(line);
      if (
        typeof candidate === "object" &&
        candidate !== null &&
        !Array.isArray(candidate) &&
        (candidate as Record<string, unknown>).step === request.branchStep
      ) {
        stepRecord = candidate as Record<string, unknown>;
        break;
      }
    }
  } catch {
    throw new PlaytestMcpValidationError(
      "The source episode's replay trace is malformed and cannot be branched."
    );
  }
  if (
    !stepRecord ||
    stepRecord.executed !== true ||
    typeof stepRecord.selectedActionId !== "string" ||
    !Array.isArray(stepRecord.legalActionIds) ||
    stepRecord.legalActionIds.some((action) => typeof action !== "string") ||
    !stepRecord.legalActionIds.includes(request.alternativeActionId) ||
    stepRecord.selectedActionId === request.alternativeActionId
  ) {
    throw new PlaytestMcpValidationError(
      "The selected branch step lacks a distinct, recorded legal alternative."
    );
  }
  try {
    assertPlaytestCheckpointDigest(stepRecord.checkpoint);
  } catch {
    throw new PlaytestMcpValidationError(
      "The selected branch step has no verified full-state and RNG checkpoint."
    );
  }
  const parentCheckpoint = stepRecord.checkpoint as PlaytestCheckpointDigest;
  if (
    !parentCheckpoint.rngCheckpoint.reproducible ||
    parentCheckpoint.rngCheckpoint.stateHash === null ||
    parent.identity.rngAlgorithm !== parentCheckpoint.rngCheckpoint.algorithm ||
    parent.identity.rngVersion !== parentCheckpoint.rngCheckpoint.version
  ) {
    throw new PlaytestMcpValidationError(
      "The source decision does not have reproducible, version-matched RNG evidence."
    );
  }
  if (
    !prepared.configuration.scenarios.includes(parent.identity.scenarioId) ||
    !approval.allowedScenarios.includes(parent.identity.scenarioId)
  ) {
    throw new PlaytestMcpValidationError(
      "The source episode scenario is no longer part of the exact approved configuration."
    );
  }
  const policy = request.policy ?? parent.identity.policyId;
  if (
    !prepared.configuration.policies.includes(policy) ||
    !approval.allowedPolicies.includes(policy)
  ) {
    throw new PlaytestMcpValidationError(
      "The branch continuation policy is not approved for this workspace."
    );
  }
  const maximumSteps = Math.min(
    approval.limits.maxStepsPerEpisode,
    prepared.configuration.budget.maxStepsPerEpisode,
    MAX_PLAYTEST_EPISODE_TRACE_STEPS
  );
  const continuationLimit = maximumSteps - request.branchStep;
  if (
    continuationLimit < 1 ||
    (request.maxSteps !== undefined && request.maxSteps > continuationLimit)
  ) {
    throw new PlaytestMcpValidationError(
      "The branch replay prefix plus requested continuation exceeds the approved per-episode step budget."
    );
  }
  const manifest: PlaytestAssignmentBranch = {
    parentEpisodeId: parent.episodeId,
    parentEpisodeRevision: parent.revision,
    parentBatchId: parent.batchId,
    branchStep: request.branchStep,
    parentTrace: traceWindow.reference,
    parentCheckpoint,
    alternativeActionId: request.alternativeActionId,
    rngPolicy: "same-stream",
    rngPolicyVersion: PLAYTESTS_RNG_POLICY_VERSION
  };
  return {
    assignments: [
      {
        scenario: parent.identity.scenarioId,
        policy,
        seed: parent.identity.seed,
        goal: "Branch from episode " + parent.episodeId,
        maxSteps: request.maxSteps ?? continuationLimit
      }
    ],
    branchPlan: {
      manifest,
      parentEpisode: parent,
      traceBytes: traceWindow.bytes
    }
  };
}

/**
 * Validate the whole batch against the exact approval, checked-in config,
 * quota-derived worker limits and allowed policy versions, then freeze the
 * complete, content-hashed assignment inventory. Nothing launches unvalidated.
 */
function prepareApprovedBatch(input: {
  readonly workspaceId: string;
  readonly approval: WorkspacePlaytestApproval;
  readonly prepared: PreparedPlaytestSandbox;
  readonly assignments: readonly PlaytestBatchAssignmentRequest[];
  readonly branchPlan: BranchExecutionPlan | null;
  readonly batchId: string;
}): ApprovedBatchContext {
  const { workspaceId, approval, prepared, assignments, branchPlan, batchId } =
    input;
  if (
    prepared.workspaceId !== workspaceId ||
    prepared.checkoutSha !== approval.buildSha ||
    prepared.imageDigest !== approval.adapterImageDigest ||
    canonicalPlaytestJson(prepared.limits) !==
      canonicalPlaytestJson(approval.limits) ||
    canonicalPlaytestJson(prepared.command) !==
      canonicalPlaytestJson(approval.adapterCommand)
  ) {
    throw new PlaytestMcpValidationError(
      "The prepared sandbox does not match this exact approved batch."
    );
  }
  const configuration = prepared.configuration;
  assertBatchReviewBudget(prepared, approval);
  const maximumSteps = Math.min(
    approval.limits.maxStepsPerEpisode,
    configuration.budget.maxStepsPerEpisode,
    MAX_PLAYTEST_EPISODE_TRACE_STEPS
  );
  const resolved: PlaytestBatchAssignment[] = [];
  const policies = new Map<string, PlaytestPolicy>();
  const maxSteps = new Map<string, number>();
  assignments.forEach((request, index) => {
    const assignmentId = "a-" + String(index + 1).padStart(4, "0");
    if (
      !configuration.scenarios.includes(request.scenario) ||
      !approval.allowedScenarios.includes(request.scenario)
    ) {
      throw new PlaytestMcpValidationError(
        'Scenario "' +
          request.scenario +
          '" is not approved for this workspace.'
      );
    }
    if (
      !configuration.policies.includes(request.policy) ||
      !approval.allowedPolicies.includes(request.policy)
    ) {
      throw new PlaytestMcpValidationError(
        'Policy "' +
          request.policy +
          '" is not an approved policy version for this workspace.'
      );
    }
    if (!policies.has(request.policy)) {
      policies.set(request.policy, resolvePolicy(request.policy));
    }
    const branch = branchPlan?.manifest ?? undefined;
    const replayPrefixSteps = branch?.branchStep ?? 0;
    const continuationLimit = maximumSteps - replayPrefixSteps;
    if (
      continuationLimit < 1 ||
      (request.maxSteps !== undefined && request.maxSteps > continuationLimit)
    ) {
      throw new PlaytestMcpValidationError(
        "Requested branch replay and continuation exceed the checked-in or approved step budget."
      );
    }
    const continuationSteps = Math.min(
      request.maxSteps ?? continuationLimit,
      continuationLimit
    );
    const totalReservedSteps = replayPrefixSteps + continuationSteps;
    maxSteps.set(assignmentId, continuationSteps);
    resolved.push({
      assignmentId,
      scenarioId: request.scenario,
      scenarioFamily: scenarioFamilyFor(prepared, request.scenario),
      policyId: request.policy,
      policyVersion: policies.get(request.policy)!.version,
      cohort: policies.get(request.policy)!.cohort,
      seed: request.seed,
      maxSteps: totalReservedSteps,
      ...(branch === undefined ? {} : { branch })
    });
  });
  try {
    if (prepared.benchmark) {
      assertPlaytestAssignmentsMatchBenchmark(resolved, prepared.benchmark);
    } else {
      assertPlaytestBatchAssignments(resolved);
    }
  } catch (error) {
    if (error instanceof TypeError || error instanceof RangeError) {
      throw new PlaytestMcpValidationError(error.message);
    }
    throw error;
  }
  const base = {
    schema: PLAYTESTS_ASSIGNMENT_MANIFEST_SCHEMA,
    batchId,
    workspaceId,
    buildSha: approval.buildSha,
    configHash: approval.playtestConfigHash,
    rubricHash: prepared.rubricHash,
    approvalRevision: approval.revision,
    createdAt: new Date().toISOString(),
    assignments: resolved
  } as const;
  const manifest: PlaytestAssignmentManifest = {
    ...base,
    contentHash: createHash("sha256")
      .update(playtestAssignmentManifestHashInput(base))
      .digest("hex")
  };
  const coveragePlan = playtestCoveragePlanForRegistry(prepared.rubric);
  try {
    assertPlaytestCoveragePlanCoversAssignments({
      registry: prepared.rubric,
      plan: coveragePlan,
      assignments: resolved
    });
  } catch (error) {
    if (error instanceof TypeError) {
      throw new PlaytestMcpValidationError(error.message);
    }
    throw error;
  }
  return {
    manifest,
    prepared,
    assignments: resolved,
    policies,
    coveragePlan,
    maxSteps,
    branchPlan
  };
}

/**
 * Reserve the whole frozen inventory atomically before any launch, so an
 * over-budget, duplicate or unapproved plan never reaches a sandbox.
 */
async function reserveBatchBudget(input: {
  readonly repository: PlaytestingRepositoryOps;
  readonly activeRuns: Map<string, ActivePlaytestRun>;
  readonly workspaceId: string;
  readonly approval: WorkspacePlaytestApproval;
  readonly prepared: PreparedPlaytestSandbox;
  readonly assignmentCount: number;
  readonly requestedWorkers: number;
}): Promise<void> {
  const {
    repository,
    activeRuns,
    workspaceId,
    approval,
    prepared,
    assignmentCount,
    requestedWorkers
  } = input;
  const assignmentLimit = Math.min(
    approval.limits.episodeCount,
    prepared.configuration.budget.episodes
  );
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
  const reservationsMissingFromData = reservations
    .filter((run) => !persisted.batchIds.has(run.batchId))
    .reduce((sum, run) => sum + run.assignmentCount, 0);
  if (
    persisted.assigned + reservationsMissingFromData + assignmentCount >
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
  const reservedWorkers = reservations.reduce(
    (sum, run) => sum + (run.phase === "running" ? run.reservedWorkers : 0),
    0
  );
  if (reservedWorkers + requestedWorkers > workerLimit) {
    throw new PlaytestMcpValidationError(
      "The approved concurrent worker budget is already reserved by an active batch."
    );
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
  run.sandboxes.add(sandbox);
  return true;
}

/** Terminal state for one assignment; game and infrastructure stay apart. */
function assignmentOutcomeFor(input: {
  readonly assignment: PlaytestBatchAssignment;
  readonly episode: PlaytestEpisode | null;
  readonly cancellation: RunCancellationReason | null;
}): PlaytestAssignmentOutcome {
  if (input.episode) {
    return {
      assignmentId: input.assignment.assignmentId,
      episodeId: input.episode.episodeId,
      state: input.episode.status as PlaytestAssignmentTerminalState,
      started: input.episode.startedAt !== null,
      eligible: input.episode.completionCounts.eligible === 1
    };
  }
  return {
    assignmentId: input.assignment.assignmentId,
    episodeId: null,
    state:
      input.cancellation === null
        ? PLAYTEST_INFRASTRUCTURE_FAILURE_STATE
        : "cancelled",
    started: false,
    eligible: false
  };
}

function assertEpisodeMatchesAssignment(input: {
  readonly episode: PlaytestEpisode;
  readonly approval: WorkspacePlaytestApproval;
  readonly batchId: string;
  readonly assignment: PlaytestBatchAssignment;
  readonly policy: PlaytestPolicy;
  readonly environmentHash: string;
  readonly observationSchemaHash: string;
  readonly capabilities: PlaytestCapabilityAdvertisement;
  readonly runtimeVersion: string;
}): void {
  const { episode, approval, policy, assignment } = input;
  const identity = episode.identity;
  if (assignment.branch === undefined) {
    if (episode.branchLineage !== null) {
      throw new PlaytestMcpValidationError(
        "A non-branch assignment returned forged branch lineage."
      );
    }
  } else {
    const lineage = episode.branchLineage;
    if (lineage === null) {
      throw new PlaytestMcpValidationError(
        "The branch runner omitted its durable source and intervention lineage."
      );
    }
    try {
      assertPlaytestBranchLineage(lineage, episode);
    } catch {
      throw new PlaytestMcpValidationError(
        "The branch runner returned invalid checkpoint, RNG, or snapshot lineage."
      );
    }
    const source = {
      parentEpisodeId: lineage.parentEpisodeId,
      parentEpisodeRevision: lineage.parentEpisodeRevision,
      parentBatchId: lineage.parentBatchId,
      branchStep: lineage.branchStep,
      parentTrace: lineage.parentTrace,
      parentCheckpoint: lineage.parentCheckpoint,
      alternativeActionId: lineage.alternativeActionId,
      rngPolicy: lineage.rngPolicy,
      rngPolicyVersion: lineage.rngPolicyVersion
    };
    if (
      canonicalPlaytestJson(source) !==
        canonicalPlaytestJson(assignment.branch) ||
      lineage.parentEpisodeId === episode.episodeId ||
      lineage.parentBatchId === episode.batchId ||
      lineage.continuationPolicyId !== policy.id ||
      lineage.continuationPolicyVersion !== policy.version
    ) {
      throw new PlaytestMcpValidationError(
        "The persisted branch lineage does not match its frozen assignment or continuation policy."
      );
    }
  }
  if (
    episode.schema !== PLAYTESTS_EPISODE_SCHEMA ||
    episode.batchId !== input.batchId ||
    episode.assignmentId !== assignment.assignmentId ||
    identity.workspaceId !== approval.workspaceId ||
    identity.repository !== approval.workspaceId ||
    identity.buildSha !== approval.buildSha ||
    identity.configHash !== approval.playtestConfigHash ||
    identity.scenarioId !== assignment.scenarioId ||
    identity.seed !== assignment.seed ||
    identity.policyId !== policy.id ||
    identity.policyVersion !== policy.version ||
    identity.modelId !== policy.modelId ||
    identity.modelRevision !== policy.modelRevision ||
    identity.environmentHash !== input.environmentHash ||
    identity.runtimeVersion !== input.runtimeVersion ||
    identity.observationSchemaHash !== input.observationSchemaHash ||
    identity.gameBuild !== input.capabilities.engineBuild ||
    identity.actionSchemaHash !== input.capabilities.actionSchemaHash ||
    identity.eventSchemaHash !== input.capabilities.eventSchemaHash ||
    input.capabilities.protocolVersion !== 1 ||
    identity.protocolVersion !== input.capabilities.protocolVersion ||
    !identity.gameBuild.trim() ||
    episode.scenarioFamily !== assignment.scenarioFamily ||
    episode.policyCohort !== policy.cohort ||
    episode.strategy !== policy.strategy ||
    !SHA256_PATTERN.test(identity.actionSchemaHash) ||
    !SHA256_PATTERN.test(identity.observationSchemaHash) ||
    !SHA256_PATTERN.test(identity.eventSchemaHash) ||
    !SHA256_PATTERN.test(input.capabilities.actionSchemaHash) ||
    !SHA256_PATTERN.test(input.capabilities.observationSchemaHash) ||
    !SHA256_PATTERN.test(input.capabilities.eventSchemaHash)
  ) {
    throw new PlaytestMcpValidationError(
      "The runner returned episode provenance that does not match this approved assignment."
    );
  }
}

interface ExecuteBatchInput {
  readonly session: PlaytestMcpSession;
  readonly workspaceId: string;
  readonly approval: WorkspacePlaytestApproval;
  readonly assignments: readonly PlaytestBatchAssignmentRequest[];
  readonly branchPlan: BranchExecutionPlan | null;
  readonly prepared?: PreparedPlaytestSandbox | undefined;
  readonly artifacts: PlaytestArtifactStore;
  readonly repository: PlaytestingRepositoryOps;
  readonly approvalRepository: WorkspacePlaytestApprovalRepository;
  readonly readWorkspaceCatalog: () => WorkspaceCatalogRead;
  readonly prepareSandbox: (
    approval: WorkspacePlaytestApproval
  ) => PreparedPlaytestSandbox;
  readonly launchSandbox: (
    prepared: PreparedPlaytestSandbox,
    options?: PlaytestSandboxLaunchOptions
  ) => Promise<PlaytestSandboxHandle>;
  readonly runEpisode: (
    options: PlaytestEpisodeRunOptions
  ) => Promise<PlaytestEpisodeRunResult>;
  readonly activeRuns: Map<string, ActivePlaytestRun>;
  readonly assignmentLocks: Map<string, Promise<void>>;
  readonly onRegistered: (batchId: string) => void;
}

interface RegisteredBatchContext extends ApprovedBatchContext {
  readonly activeRun: ActivePlaytestRun;
  /** Observed episodes per assignment, used for the frozen review selection. */
  readonly observedEpisodes: Map<string, PlaytestEpisode>;
}

function runAssignmentInApprovedSandbox(
  input: ExecuteBatchInput,
  context: RegisteredBatchContext,
  assignment: PlaytestBatchAssignment,
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
    batchId: context.manifest.batchId,
    assignmentId: assignment.assignmentId,
    repository: input.workspaceId,
    scenarioId: assignment.scenarioId,
    scenarioFamily: assignment.scenarioFamily,
    seed: assignment.seed,
    goal: "Playtest scenario " + assignment.scenarioId,
    measurementVersion: PLAYTESTS_MEASUREMENT_VERSION,
    runtimeVersion,
    environmentHash,
    policy: context.policies.get(assignment.policyId)!,
    observationContract: context.prepared.observationContract,
    metricRegistry: context.prepared.rubric,
    rubricHash: context.prepared.rubricHash,
    maxSteps:
      context.maxSteps.get(assignment.assignmentId) ?? assignment.maxSteps,
    ...(context.branchPlan === null
      ? {}
      : {
          branch: {
            manifest: context.branchPlan.manifest,
            parentEpisode: context.branchPlan.parentEpisode
          }
        }),
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

async function persistAssignmentResult(input: {
  readonly execute: ExecuteBatchInput;
  readonly context: RegisteredBatchContext;
  readonly assignment: PlaytestBatchAssignment;
  readonly result: PlaytestEpisodeRunResult;
}): Promise<PlaytestAssignmentOutcome> {
  const { execute, context, assignment, result } = input;
  const cancellation = context.activeRun.reason;
  const policy = context.policies.get(assignment.policyId)!;
  if (!result.episode) {
    // Pre-reset or negotiation failure is an assigned infrastructure failure.
    // Game failures are never retried and never relabelled as a new assignment.
    return assignmentOutcomeFor({ assignment, episode: null, cancellation });
  }
  if (!result.capabilities) {
    throw new PlaytestMcpValidationError(
      "The runner returned an episode without negotiated capabilities."
    );
  }
  assertEpisodeMatchesAssignment({
    episode: result.episode,
    approval: execute.approval,
    batchId: context.manifest.batchId,
    assignment,
    policy,
    environmentHash: playtestEnvironmentHash(execute.approval, RUNTIME_VERSION),
    observationSchemaHash: context.prepared.observationContract.schemaHash,
    capabilities: result.capabilities,
    runtimeVersion: RUNTIME_VERSION
  });
  let accepted = result.episode;
  if (cancellation !== null) {
    if (accepted.status !== "cancelled") {
      throw new PlaytestMcpUnavailableError(
        "The runner did not acknowledge cancellation; the result is not accepted as complete."
      );
    }
    const missingReason =
      cancellation === "cancelled" ? "cancelled" : "revoked";
    if (!accepted.missingReasons.includes(missingReason)) {
      accepted = {
        ...accepted,
        missingReasons: [...accepted.missingReasons, missingReason]
      };
    }
  }
  const retainedSnapshot = accepted.branchLineage?.snapshotArtifact;
  if (retainedSnapshot) {
    const storedReference = execute.artifacts.referenceForId(
      retainedSnapshot.artifactId
    );
    if (
      !storedReference ||
      storedReference.sha256.toLowerCase() !==
        retainedSnapshot.sha256.toLowerCase() ||
      storedReference.bytes !== retainedSnapshot.bytes ||
      storedReference.mediaType !== retainedSnapshot.mediaType
    ) {
      throw new PlaytestMcpValidationError(
        "The branch snapshot lineage does not resolve to the workspace artifact store."
      );
    }
    try {
      execute.artifacts.readArtifact(storedReference);
    } catch {
      throw new PlaytestMcpValidationError(
        "The retained branch snapshot is missing, expired, or corrupt."
      );
    }
  }
  await execute.repository.insertEpisode(accepted);
  context.observedEpisodes.set(assignment.assignmentId, accepted);
  return assignmentOutcomeFor({
    assignment,
    episode: accepted,
    cancellation
  });
}

async function registerApprovedBatch(
  input: ExecuteBatchInput
): Promise<RegisteredBatchContext> {
  const batchId = "batch-" + randomUUID();
  const prepared = input.prepared ?? input.prepareSandbox(input.approval);
  const context = prepareApprovedBatch({
    workspaceId: input.workspaceId,
    approval: input.approval,
    prepared,
    assignments: input.assignments,
    branchPlan: input.branchPlan,
    batchId
  });
  const workerLimit = Math.min(
    input.approval.limits.workerCount,
    prepared.configuration.budget.workers
  );
  const reservedWorkers = Math.min(workerLimit, context.assignments.length);
  await reserveBatchBudget({
    repository: input.repository,
    activeRuns: input.activeRuns,
    workspaceId: input.workspaceId,
    approval: input.approval,
    prepared,
    assignmentCount: context.assignments.length,
    requestedWorkers: reservedWorkers
  });
  if (
    approvalIsStillExact(
      input.approval,
      input.approvalRepository,
      input.readWorkspaceCatalog
    ) !== null
  ) {
    throw new PlaytestSandboxApprovalError(
      "The active approval or workspace enablement changed before execution."
    );
  }
  const controller = new AbortController();
  let resolveCompletion!: (status: PlaytestRunStatus) => void;
  const completion = new Promise<PlaytestRunStatus>((resolve) => {
    resolveCompletion = resolve;
  });
  const createdAt = context.manifest.createdAt;
  const activeRun: ActivePlaytestRun = {
    batchId,
    workspaceId: input.workspaceId,
    buildSha: input.approval.buildSha,
    ownerActor: input.session.actor,
    ownerTaskId: input.session.taskId,
    ownerRunId: input.session.runId,
    assignmentCount: context.assignments.length,
    reservedWorkers,
    manifestHash: context.manifest.contentHash,
    createdAt,
    outcomes: new Map(),
    controller,
    phase: "running",
    reason: null,
    sandboxes: new Set(),
    completion,
    resolveCompletion
  };
  const registered: RegisteredBatchContext = {
    ...context,
    observedEpisodes: new Map(),
    activeRun
  };
  await input.repository.insertBatch(
    batchRecordFor({
      manifest: context.manifest,
      prepared,
      approval: input.approval,
      revision: 1,
      status: "running",
      counts: runningBatchCounts(context.assignments.length),
      reviewSelection: { status: "pending" },
      unobservedAssignments: [],
      capabilities: null,
      cancellationReason: null,
      failureReason: null,
      createdAt,
      startedAt: createdAt,
      completedAt: null,
      actualCritiques: 0,
      coverageManifest: coverageManifestForBatch({
        manifest: context.manifest,
        prepared,
        plan: context.coveragePlan,
        episodes: [],
        generatedAt: createdAt
      }),
      reviewPackets: []
    })
  );
  input.activeRuns.set(batchId, activeRun);
  input.onRegistered(batchId);
  return registered;
}

/**
 * Freeze the per-batch critique selection from the terminal inventory.
 * Surveillance runs first inside policy x scenario x outcome strata; discovery
 * ranks only the remaining sessions by the named, versioned evaluator signal.
 */
function selectionForBatch(input: {
  readonly context: RegisteredBatchContext;
  readonly approval: WorkspacePlaytestApproval;
  readonly outcomes: readonly PlaytestAssignmentOutcome[];
}): PlaytestBatchReviewSelection {
  const { context, outcomes } = input;
  const reviewSelection =
    context.prepared.configuration.analysis.reviewSelection;
  const candidates: PlaytestReviewCandidate[] = [];
  let unreviewable = 0;
  for (const outcome of outcomes) {
    const episode = context.observedEpisodes.get(outcome.assignmentId);
    if (outcome.episodeId === null || episode === undefined) {
      unreviewable += 1;
      continue;
    }
    if (
      outcome.state !== "completed" ||
      episode.status !== "completed" ||
      episode.completeness !== "complete"
    ) {
      unreviewable += 1;
      continue;
    }
    const assignment = context.assignments.find(
      (entry) => entry.assignmentId === outcome.assignmentId
    );
    if (!assignment) {
      unreviewable += 1;
      continue;
    }
    candidates.push({
      assignmentId: outcome.assignmentId,
      episodeId: outcome.episodeId,
      policyId: assignment.policyId,
      scenarioId: assignment.scenarioId,
      outcomeKey: playtestReviewOutcomeKey(outcome.state, episode.outcome),
      metrics: episode.metrics
    });
  }
  return selectPlaytestBatchReviews({
    inventoryHash: context.manifest.contentHash,
    maxReviewedSessions:
      context.prepared.configuration.analysis.maxReviewedSessions,
    critiqueBudget: input.approval.limits.critiqueCount,
    surveillanceSessions: reviewSelection.surveillanceSessions,
    discoverySessions: reviewSelection.discoverySessions,
    discoverySignal: reviewSelection.discoverySignal,
    candidates,
    unreviewableAssignments: unreviewable,
    selectedAt: new Date().toISOString()
  });
}

class ReviewPacketPreparationError extends Error {
  readonly reason: PlaytestReviewPacketFailureReason;

  constructor(reason: PlaytestReviewPacketFailureReason, message: string) {
    super(message);
    this.name = "ReviewPacketPreparationError";
    this.reason = reason;
  }
}

const PACKET_TRACE_UNAVAILABLE_REASON = "trace-unavailable" as const;
const PACKET_TRACE_MALFORMED_REASON = "trace-malformed" as const;
const OMITTED_FRAME_REASONS = {
  missing: "missing",
  expired: "expired",
  invalidReference: "invalid-reference",
  unsupportedMedia: "unsupported-media"
} as const;
const REVIEWABLE_FRAME_MEDIA_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/webp"
]);

function isTraceRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function malformedTrace(message: string): ReviewPacketPreparationError {
  return new ReviewPacketPreparationError(
    PACKET_TRACE_MALFORMED_REASON,
    message
  );
}

function readPacketTrace(input: {
  readonly episode: PlaytestEpisode;
  readonly artifacts: PlaytestArtifactStore;
}): { readonly reference: PlaytestArtifactReference; readonly text: string } {
  const trace = input.episode.trace;
  if (trace === null) {
    throw new ReviewPacketPreparationError(
      PACKET_TRACE_UNAVAILABLE_REASON,
      "The selected episode has no stored trace artifact."
    );
  }
  const reference = input.artifacts.referenceForId(trace.id);
  if (
    !reference ||
    reference.mediaType !== PLAYTESTS_ARTIFACT_WINDOW_MEDIA_TYPE
  ) {
    throw new ReviewPacketPreparationError(
      PACKET_TRACE_UNAVAILABLE_REASON,
      "The selected episode trace is not available as a bounded JSONL window."
    );
  }
  try {
    const read = input.artifacts.readWindow(reference);
    return {
      reference,
      text: new TextDecoder("utf-8", { fatal: true }).decode(read.bytes)
    };
  } catch {
    throw new ReviewPacketPreparationError(
      PACKET_TRACE_UNAVAILABLE_REASON,
      "The selected episode trace is missing, expired or corrupt."
    );
  }
}

function frameOmissionReason(
  artifacts: PlaytestArtifactStore,
  reference: PlaytestArtifactReference
): PlaytestEvidenceOmittedArtifact["reason"] | null {
  const state = artifacts.state(reference);
  if (state === "expired") return OMITTED_FRAME_REASONS.expired;
  if (state === "corrupted" || state === "not-authorized") {
    return OMITTED_FRAME_REASONS.invalidReference;
  }
  if (state !== "present") return OMITTED_FRAME_REASONS.missing;
  return REVIEWABLE_FRAME_MEDIA_TYPES.has(reference.mediaType)
    ? null
    : OMITTED_FRAME_REASONS.unsupportedMedia;
}

function frameEvidenceForPacket(input: {
  readonly episode: PlaytestEpisode;
  readonly artifacts: PlaytestArtifactStore;
}): {
  readonly frameHashes: Readonly<Record<string, string>>;
  readonly frameRefsByStep: ReadonlyMap<
    number,
    readonly PlaytestEvidenceLocator[]
  >;
  readonly omittedArtifacts: readonly PlaytestEvidenceOmittedArtifact[];
} {
  const frameHashes: Record<string, string> = {};
  const frameRefsByStep = new Map<number, PlaytestEvidenceLocator[]>();
  const omittedArtifacts: PlaytestEvidenceOmittedArtifact[] = [];
  for (const frame of input.episode.frames) {
    if (frame.kind !== "frame") continue;
    const step = frame.step;
    if (
      typeof step !== "number" ||
      !Number.isSafeInteger(step) ||
      step < 0 ||
      step >= input.episode.stepCount
    ) {
      throw malformedTrace(
        "A selected frame is not linked to a valid episode step."
      );
    }
    const reference = input.artifacts.referenceForId(frame.id);
    if (!reference) {
      omittedArtifacts.push({
        kind: "frame",
        artifactId: frame.id,
        step,
        reason: OMITTED_FRAME_REASONS.missing
      });
      continue;
    }
    const reason = frameOmissionReason(input.artifacts, reference);
    if (reason !== null) {
      omittedArtifacts.push({
        kind: "frame",
        artifactId: frame.id,
        step,
        reason
      });
      continue;
    }
    frameHashes[frame.id] = reference.sha256;
    const refs = frameRefsByStep.get(step) ?? [];
    refs.push(frame);
    frameRefsByStep.set(step, refs);
  }
  return { frameHashes, frameRefsByStep, omittedArtifacts };
}

function projectTraceEvents(
  value: unknown,
  step: number
): PlaytestEvidenceTraceStep["events"] {
  if (!Array.isArray(value)) {
    throw malformedTrace("The stored episode trace has no event list.");
  }
  return value.map((event) => {
    if (!isTraceRecord(event) || event.step !== step) {
      throw malformedTrace(
        "The stored episode trace contains an invalid or misplaced event."
      );
    }
    return {
      eventId: event.eventId as string,
      type: event.type as string,
      phaseId: (event.phaseId ?? null) as string | null,
      revision: event.revision as number
    };
  });
}

function projectedTracePhase(
  entry: Record<string, unknown>,
  events: PlaytestEvidenceTraceStep["events"]
): string | null {
  if (entry.phaseId !== undefined && entry.phaseId !== null) {
    if (typeof entry.phaseId !== "string") {
      throw malformedTrace("The stored episode trace has an invalid phase ID.");
    }
    return entry.phaseId;
  }
  const phases = [
    ...new Set(
      events.flatMap((event) =>
        typeof event.phaseId === "string" ? [event.phaseId] : []
      )
    )
  ];
  return phases.length === 1 ? phases[0]! : null;
}

function projectTraceSteps(input: {
  readonly text: string;
  readonly expectedStepCount: number;
  readonly frameRefsByStep: ReadonlyMap<
    number,
    readonly PlaytestEvidenceLocator[]
  >;
}): readonly PlaytestEvidenceTraceStep[] {
  const steps: PlaytestEvidenceTraceStep[] = [];
  const seenSteps = new Set<number>();
  for (const line of input.text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let entry: unknown;
    try {
      entry = JSON.parse(trimmed);
    } catch {
      throw malformedTrace("The stored episode trace contains malformed JSON.");
    }
    if (!isTraceRecord(entry) || !Number.isSafeInteger(entry.step)) {
      throw malformedTrace(
        "The stored episode trace contains an invalid step."
      );
    }
    const step = entry.step as number;
    if (step < 0 || seenSteps.has(step)) {
      throw malformedTrace(
        "The stored episode trace contains a negative or duplicate step."
      );
    }
    seenSteps.add(step);
    const events = projectTraceEvents(entry.events, step);
    const selectedActionId = entry.selectedActionId;
    if (
      selectedActionId !== undefined &&
      selectedActionId !== null &&
      typeof selectedActionId !== "string"
    ) {
      throw malformedTrace(
        "The stored episode trace contains an invalid selected action."
      );
    }
    steps.push({
      step,
      phaseId: projectedTracePhase(entry, events),
      revisionBefore: entry.revisionBefore as number,
      revisionAfter: (entry.revisionAfter ?? null) as number | null,
      observationVisibility:
        entry.observationVisibility as PlaytestEvidenceTraceStep["observationVisibility"],
      visibleObservation:
        entry.visibleObservation as PlaytestEvidenceTraceStep["visibleObservation"],
      legalActionIds: entry.legalActionIds as readonly string[],
      selectedActionId: (selectedActionId ?? null) as string | null,
      preActionPrediction: (entry.preActionPrediction ??
        null) as PlaytestEvidenceTraceStep["preActionPrediction"],
      authoritativeOutcome: (entry.authoritativeOutcome ??
        null) as PlaytestEvidenceTraceStep["authoritativeOutcome"],
      events,
      frameRefs: input.frameRefsByStep.get(step) ?? []
    });
  }
  if (
    steps.length !== input.expectedStepCount ||
    steps.some((entry, index) => entry.step !== index)
  ) {
    throw malformedTrace(
      "The stored episode trace does not contain every contiguous source step."
    );
  }
  return steps;
}

function traceStepsForPacket(input: {
  readonly episode: PlaytestEpisode;
  readonly artifacts: PlaytestArtifactStore;
}): {
  readonly traceHash: string;
  readonly traceSteps: readonly PlaytestEvidenceTraceStep[];
  readonly frameHashes: Readonly<Record<string, string>>;
  readonly omittedArtifacts: readonly PlaytestEvidenceOmittedArtifact[];
} {
  const trace = readPacketTrace(input);
  const frames = frameEvidenceForPacket(input);
  return {
    traceHash: trace.reference.sha256,
    traceSteps: projectTraceSteps({
      text: trace.text,
      expectedStepCount: input.episode.stepCount,
      frameRefsByStep: frames.frameRefsByStep
    }),
    frameHashes: frames.frameHashes,
    omittedArtifacts: frames.omittedArtifacts
  };
}

function packetFailureReason(
  error: unknown
): PlaytestReviewPacketFailureReason {
  if (error instanceof ReviewPacketPreparationError) return error.reason;
  if (error instanceof RangeError) return "packet-budget-exceeded";
  return "packet-validation-failed";
}

function prepareReviewPacketReceipt(input: {
  readonly context: RegisteredBatchContext;
  readonly selection: Extract<
    PlaytestBatchReviewSelection,
    { status: "selected" }
  >;
  readonly coverageManifest: PlaytestCoverageManifest;
  readonly assignmentId: string;
  readonly episodeId: string;
  readonly artifacts: PlaytestArtifactStore;
  readonly generatedAt: string;
  readonly tokenBudget: number;
  readonly maxPacketBytes: number;
}): PlaytestReviewPacketReceipt {
  const { context, selection, assignmentId, episodeId, artifacts } = input;
  const assignment = context.assignments.find(
    (candidate) => candidate.assignmentId === assignmentId
  );
  const episode = context.observedEpisodes.get(assignmentId);
  const assignmentById = new Map(
    context.assignments.map((candidate) => [candidate.assignmentId, candidate])
  );
  const crossSessionCandidates = [...context.observedEpisodes.values()]
    .filter(
      (candidate) =>
        candidate.episodeId !== episodeId &&
        candidate.status === "completed" &&
        candidate.completeness === "complete"
    )
    .map((candidate) => {
      const siblingAssignment = candidate.assignmentId
        ? assignmentById.get(candidate.assignmentId)
        : undefined;
      if (!siblingAssignment) {
        throw new TypeError(
          "Completed sibling episode has no frozen batch assignment."
        );
      }
      return { episode: candidate, assignment: siblingAssignment };
    });
  const crossSessionInventoryHash = createHash("sha256")
    .update(playtestCrossSessionInventoryHashInput(crossSessionCandidates))
    .digest("hex");
  const crossSessionSelectionSeed = createHash("sha256")
    .update(
      canonicalPlaytestJson({
        purpose: "playtest-cross-session-packet-sample-v1",
        assignmentManifestHash: context.manifest.contentHash,
        targetAssignmentId: assignmentId,
        targetEpisodeId: episodeId,
        inventoryHash: crossSessionInventoryHash
      })
    )
    .digest("hex");
  const sourceIdentity = {
    batchId: context.manifest.batchId,
    workspaceId: context.manifest.workspaceId,
    buildSha: context.manifest.buildSha,
    assignmentId,
    episodeId,
    episodeRevision: episode?.revision ?? null,
    traceArtifactId: episode?.trace?.id ?? null,
    rubricHash: context.prepared.rubricHash,
    selectionHash: context.manifest.contentHash,
    coverageManifestHash: input.coverageManifest.contentHash,
    crossSessionInventoryHash,
    crossSessionSelectionSeed,
    measurementVersion: PLAYTESTS_MEASUREMENT_VERSION,
    tokenBudget: input.tokenBudget,
    maxPacketBytes: input.maxPacketBytes,
    generatedAt: input.generatedAt
  };
  const packetId =
    "packet-" +
    createHash("sha256")
      .update(canonicalPlaytestJson(sourceIdentity))
      .digest("hex");
  const unavailable = (
    failureReason: PlaytestReviewPacketFailureReason
  ): PlaytestReviewPacketReceipt => ({
    status: "unavailable",
    packetId,
    assignmentId,
    episodeId,
    artifact: null,
    failureReason,
    createdAt: input.generatedAt
  });
  if (!assignment || !episode || episode.episodeId !== episodeId) {
    return unavailable("trace-unavailable");
  }
  const selected = selection.selected.find(
    (candidate) =>
      candidate.assignmentId === assignmentId &&
      candidate.episodeId === episodeId
  );
  if (!selected) return unavailable("rubric-mismatch");
  let packet: PlaytestEvidencePacket;
  try {
    const trace = traceStepsForPacket({ episode, artifacts });
    packet = buildPlaytestEvidencePacket({
      packetId,
      episode,
      assignment,
      registry: context.prepared.rubric,
      coverageManifest: input.coverageManifest,
      crossSessionCandidates,
      crossSessionSelectionSeed,
      crossSessionInventoryHash,
      rubricHash: context.prepared.rubricHash,
      measurementVersion: PLAYTESTS_MEASUREMENT_VERSION,
      ...trace,
      modelId: null,
      modelRevision: null,
      promptHash: null,
      tokenBudget: input.tokenBudget,
      maxPacketBytes: input.maxPacketBytes,
      generatedAt: input.generatedAt
    });
    assertPlaytestEvidencePacket(packet);
  } catch (error) {
    return unavailable(packetFailureReason(error));
  }
  let artifact: PlaytestArtifactReference;
  try {
    artifact = artifacts.writeArtifact({
      artifactId: packet.packetId,
      mediaType: PLAYTESTS_EVIDENCE_PACKET_MEDIA_TYPE,
      bytes: new TextEncoder().encode(canonicalPlaytestJson(packet)),
      pendingCommitId: context.manifest.batchId
    }).reference;
  } catch {
    return unavailable("artifact-store-failed");
  }
  return {
    status: "prepared",
    packetId,
    assignmentId,
    episodeId,
    artifact,
    failureReason: null,
    createdAt: input.generatedAt
  };
}

function finalizeReviewPacketArtifactMarkers(
  artifacts: PlaytestArtifactStore,
  batchId: string,
  packets: readonly PlaytestReviewPacketReceipt[]
): void {
  for (const packet of packets) {
    if (packet.status !== "prepared" || packet.artifact === null) continue;
    try {
      artifacts.markArtifactCommitted(packet.artifact, batchId);
    } catch {
      // The durable batch receipt is authoritative. A later startup pass
      // reconciles this local marker from Data instead of failing the run.
    }
  }
}

function prepareReviewPackets(input: {
  readonly context: RegisteredBatchContext;
  readonly selection: PlaytestBatchReviewSelection;
  readonly coverageManifest: PlaytestCoverageManifest;
  readonly artifacts: PlaytestArtifactStore;
  readonly generatedAt: string;
  readonly artifactBudgetBytes: number;
}): readonly PlaytestReviewPacketReceipt[] {
  const selection = input.selection;
  if (selection.status !== "selected") return [];
  const selected = selection.selected;
  if (selected.length === 0) return [];
  const perPacketBudget = Math.min(
    MAX_REVIEW_PACKET_BYTES,
    Math.floor(input.artifactBudgetBytes / selected.length)
  );
  if (perPacketBudget === 0) {
    return selected.map((item) => ({
      status: "unavailable",
      packetId:
        "packet-" +
        createHash("sha256")
          .update(
            canonicalPlaytestJson([
              input.context.manifest.batchId,
              item.episodeId
            ])
          )
          .digest("hex"),
      assignmentId: item.assignmentId,
      episodeId: item.episodeId,
      artifact: null,
      failureReason: "packet-budget-exceeded",
      createdAt: input.generatedAt
    }));
  }
  return selected.map((item) =>
    prepareReviewPacketReceipt({
      context: input.context,
      selection,
      coverageManifest: input.coverageManifest,
      assignmentId: item.assignmentId,
      episodeId: item.episodeId,
      artifacts: input.artifacts,
      generatedAt: input.generatedAt,
      tokenBudget: Math.min(REVIEW_PACKET_TOKEN_BUDGET, perPacketBudget),
      maxPacketBytes: perPacketBudget
    })
  );
}

async function executeApprovedBatch(input: ExecuteBatchInput) {
  const context = await withAssignmentLock(
    input.assignmentLocks,
    input.workspaceId + "\0" + input.approval.buildSha,
    () => registerApprovedBatch(input)
  );
  const { activeRun } = context;
  const concurrency = context.activeRun.reservedWorkers;
  const outcomes: PlaytestAssignmentOutcome[] = [];
  let capabilities: PlaytestCapabilityAdvertisement | null = null;
  let approvalMonitor: NodeJS.Timeout | undefined;
  let terminalWriteOutcomeUnknown = false;
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

    const results = await mapConcurrentOrdered(
      context.assignments,
      concurrency,
      async (assignment) => {
        if (activeRun.reason !== null) {
          const outcome = assignmentOutcomeFor({
            assignment,
            episode: null,
            cancellation: activeRun.reason
          });
          activeRun.outcomes.set(assignment.assignmentId, outcome);
          return { outcome };
        }
        let sandbox: PlaytestSandboxHandle | null = null;
        try {
          sandbox = await input.launchSandbox(
            context.prepared,
            context.branchPlan === null
              ? undefined
              : {
                  inputArtifacts: [
                    {
                      reference: context.branchPlan.manifest.parentTrace,
                      bytes: context.branchPlan.traceBytes
                    }
                  ]
                }
          );
          if (!attachSandboxToRun(activeRun, sandbox)) {
            throw new PlaytestSandboxApprovalError(
              "The active approval or workspace enablement changed before execution."
            );
          }
          if (
            approvalIsStillExact(
              input.approval,
              input.approvalRepository,
              input.readWorkspaceCatalog
            ) !== null
          ) {
            cancelActiveRun(activeRun, APPROVAL_REVOKED_REASON);
            throw new PlaytestSandboxApprovalError(
              "The active approval or workspace enablement changed before execution."
            );
          }
          const result = await runAssignmentInApprovedSandbox(
            input,
            context,
            assignment,
            sandbox
          );
          if (result.capabilities && capabilities === null) {
            capabilities = result.capabilities;
          }
          const outcome = await persistAssignmentResult({
            execute: input,
            context,
            assignment,
            result
          });
          activeRun.outcomes.set(assignment.assignmentId, outcome);
          return { outcome };
        } catch (error) {
          if (
            error instanceof PlaytestMcpValidationError ||
            error instanceof PlaytestSandboxApprovalError
          ) {
            throw error;
          }
          // Sandbox, adapter and timeout faults stay infrastructure failures
          // for this assignment; game failures are never retried.
          const outcome = assignmentOutcomeFor({
            assignment,
            episode: null,
            cancellation: activeRun.reason
          });
          activeRun.outcomes.set(assignment.assignmentId, outcome);
          return { outcome };
        } finally {
          if (sandbox) {
            activeRun.sandboxes.delete(sandbox);
            await sandbox.cleanup();
          }
        }
      }
    );
    if (approvalMonitor) {
      clearInterval(approvalMonitor);
      approvalMonitor = undefined;
    }
    outcomes.push(...results.map((entry) => entry.outcome));
    markRunPersisting(activeRun);
    const completedAt = new Date().toISOString();
    const reviewSelection = selectionForBatch({
      context,
      approval: input.approval,
      outcomes
    });
    const completedEpisodes = [...context.observedEpisodes.values()];
    const coverageManifest = coverageManifestForBatch({
      manifest: context.manifest,
      prepared: context.prepared,
      plan: context.coveragePlan,
      episodes: completedEpisodes,
      generatedAt: completedAt
    });
    const reviewPackets = prepareReviewPackets({
      context,
      selection: reviewSelection,
      coverageManifest,
      artifacts: input.artifacts,
      generatedAt: completedAt,
      artifactBudgetBytes: input.approval.limits.artifactBytes
    });
    const counts = playtestBatchCountsFromAssignments({
      assignmentCount: context.assignments.length,
      outcomes,
      // Selection is a plan, not a critique invocation. The review submit path
      // increments these only after an actual review has been persisted.
      reviewed: 0
    });
    const terminalStatus = playtestBatchTerminalState({
      assignmentCount: context.assignments.length,
      outcomes,
      cancelled: activeRun.reason !== null,
      aborted: false
    });
    const terminalBatch = batchRecordFor({
      manifest: context.manifest,
      prepared: context.prepared,
      approval: input.approval,
      revision: 2,
      status: terminalStatus,
      counts,
      reviewSelection,
      unobservedAssignments: outcomes.filter(
        (outcome) => outcome.episodeId === null
      ),
      capabilities,
      cancellationReason: activeRun.reason,
      failureReason: null,
      createdAt: context.manifest.createdAt,
      startedAt: context.manifest.createdAt,
      completedAt,
      actualCritiques: 0,
      coverageManifest,
      reviewPackets
    });
    const completedResult = () => ({
      batchId: context.manifest.batchId,
      status: terminalStatus,
      assignmentCount: context.assignments.length,
      manifestHash: context.manifest.contentHash,
      concurrency,
      outcomes,
      counts,
      reviewSelection,
      cancellation: activeRun.reason,
      selectedReviewEpisodeIds:
        reviewSelection.status === "selected"
          ? reviewSelection.selected.map((unit) => unit.episodeId)
          : []
    });
    try {
      await input.repository.insertBatch(terminalBatch);
    } catch (error) {
      terminalWriteOutcomeUnknown = true;
      let persisted: PlaytestBatch | null;
      try {
        persisted = await input.repository.getBatch(
          input.workspaceId,
          context.manifest.batchId
        );
      } catch {
        // Do not append a conflicting failed revision when the commit result
        // cannot be read. Status recovery will resolve the durable state.
        throw error;
      }
      if (
        persisted === null ||
        canonicalPlaytestJson(persisted) !==
          canonicalPlaytestJson(terminalBatch)
      ) {
        // A stale read may still hide a successful ClickHouse insert. Preserve
        // revision history rather than overwriting an ambiguous terminal row.
        throw error;
      }
      finalizeReviewPacketArtifactMarkers(
        input.artifacts,
        context.manifest.batchId,
        reviewPackets
      );
      return completedResult();
    }
    finalizeReviewPacketArtifactMarkers(
      input.artifacts,
      context.manifest.batchId,
      reviewPackets
    );
    return completedResult();
  } catch (error) {
    markRunPersisting(activeRun);
    const completedAt = new Date().toISOString();
    const outcomeByAssignment = new Map(
      outcomes.map((outcome) => [outcome.assignmentId, outcome])
    );
    const terminalOutcomes = context.assignments.map((assignment) => {
      const recorded = outcomeByAssignment.get(assignment.assignmentId);
      if (recorded) return recorded;
      const episode =
        context.observedEpisodes.get(assignment.assignmentId) ?? null;
      return assignmentOutcomeFor({
        assignment,
        episode,
        cancellation: activeRun.reason
      });
    });
    const counts = playtestBatchCountsFromAssignments({
      assignmentCount: context.assignments.length,
      outcomes: terminalOutcomes,
      reviewed: 0
    });
    const incompleteEpisodes = [...context.observedEpisodes.values()];
    const coverageManifest = coverageManifestForBatch({
      manifest: context.manifest,
      prepared: context.prepared,
      plan: context.coveragePlan,
      episodes: incompleteEpisodes,
      generatedAt: completedAt
    });
    if (!terminalWriteOutcomeUnknown) {
      try {
        await input.repository.insertBatch(
          batchRecordFor({
            manifest: context.manifest,
            prepared: context.prepared,
            approval: input.approval,
            revision: 2,
            status: playtestBatchTerminalState({
              assignmentCount: context.assignments.length,
              outcomes: terminalOutcomes,
              cancelled: activeRun.reason !== null,
              aborted: true
            }),
            counts,
            reviewSelection: {
              status: "unavailable",
              reason: "batch-incomplete"
            },
            reviewPackets: [],
            unobservedAssignments: terminalOutcomes.filter(
              (outcome) => outcome.episodeId === null
            ),
            capabilities,
            cancellationReason: activeRun.reason,
            failureReason: null,
            createdAt: context.manifest.createdAt,
            startedAt: context.manifest.createdAt,
            completedAt,
            actualCritiques: 0,
            coverageManifest
          })
        );
      } catch {
        // Revision 1 remains the explicit incomplete assignment, never a success.
      }
    }
    throw error;
  } finally {
    if (approvalMonitor) clearInterval(approvalMonitor);
  }
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

/** Parse one JSONL line into a structured trace entry, or null if it is not one. */
function parseTraceLine(line: string): Record<string, unknown> | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }
  return parsed as Record<string, unknown>;
}

/** Normalize a trace entry's selectedActionId to its lower-cased NFKC form, or null. */
function normalizeTraceSelectedActionId(
  entry: Record<string, unknown>
): string | null {
  if (typeof entry.selectedActionId !== "string") return null;
  return entry.selectedActionId.normalize("NFKC").trim().toLowerCase();
}

/** Build a PlaytestTraceEvent from a raw event payload, or null if invalid. */
function tryCreateTraceEvent(
  rawEvent: unknown,
  step: number | null,
  episodeId: string
): { readonly fact: PlaytestTraceEvent; readonly episodeId: string } | null {
  if (
    rawEvent === null ||
    typeof rawEvent !== "object" ||
    Array.isArray(rawEvent)
  ) {
    return null;
  }
  const event = rawEvent as Record<string, unknown>;
  if (
    typeof event.eventId !== "string" ||
    event.eventId.length === 0 ||
    typeof event.type !== "string" ||
    event.type.length === 0
  ) {
    return null;
  }
  return {
    fact: {
      eventId: event.eventId,
      type: event.type,
      phaseId: typeof event.phaseId === "string" ? event.phaseId : null,
      step
    },
    episodeId
  };
}

/** Decode the trace artifact window as UTF-8 text, or null if it cannot be authorized/read. */
function readEpisodeTraceWindow(
  episode: PlaytestEpisode,
  artifacts: PlaytestArtifactStore
): string | null {
  if (!episode.trace) return null;
  try {
    const traceReference = artifacts.referenceForId(episode.trace.id);
    if (!traceReference) throw new Error("trace artifact not authorized");
    const window = artifacts.readWindow(traceReference);
    return new TextDecoder("utf-8", { fatal: true }).decode(window.bytes);
  } catch {
    // Unreadable/expired trace means no event/action identity can be proven.
    return null;
  }
}

/** Parse an episode's persisted JSONL trace as authoritative event/action facts. */
function readEpisodeTraceFacts(
  episode: PlaytestEpisode,
  artifacts: PlaytestArtifactStore
): PlaytestEpisodeTraceFacts {
  const eventEpisodeOf = new Map<string, string>();
  const events: PlaytestTraceEvent[] = [];
  const selectedActionIds = new Set<string>();
  const text = readEpisodeTraceWindow(episode, artifacts);
  if (text === null) {
    return { eventEpisodeOf, events, selectedActionIds };
  }
  for (const line of text.split("\n")) {
    const entry = parseTraceLine(line);
    if (!entry) continue;
    const step = Number.isSafeInteger(entry.step)
      ? (entry.step as number)
      : null;
    const selectedActionId = normalizeTraceSelectedActionId(entry);
    if (selectedActionId !== null) {
      selectedActionIds.add(selectedActionId);
    }
    const rawEvents = entry.events;
    if (!Array.isArray(rawEvents)) continue;
    for (const rawEvent of rawEvents) {
      const created = tryCreateTraceEvent(rawEvent, step, episode.episodeId);
      if (created === null) continue;
      events.push(created.fact);
      eventEpisodeOf.set(created.fact.eventId, created.episodeId);
    }
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
      ...(requestedAction === undefined ? {} : { action: requestedAction }),
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

/** Resolve the finding revision from the latest workspace-owned fingerprint. */
interface PreparedSubmittedFinding {
  readonly finding: PlaytestFinding;
  readonly shouldInsert: boolean;
}

function resolveSubmittedFinding(
  group: SubmittedFindingGroup,
  existing: PlaytestFinding | null
): PreparedSubmittedFinding {
  const { identity, fingerprint, submitted } = group;
  const findingId = deriveStableFindingId(fingerprint);
  if (existing) {
    const evidenceRefs = unionEvidenceRefs(
      existing.evidenceRefs,
      normalizeEvidenceRefs(submitted.evidenceRefs)
    );
    const affectedCohorts = unionStringSet(
      existing.affectedCohorts,
      group.affectedCohorts
    );
    if (
      canonicalPlaytestJson(evidenceRefs) ===
        canonicalPlaytestJson(existing.evidenceRefs) &&
      canonicalPlaytestJson(affectedCohorts) ===
        canonicalPlaytestJson(existing.affectedCohorts)
    ) {
      return { finding: existing, shouldInsert: false };
    }
    return {
      shouldInsert: true,
      finding: {
        // Keep source-owned workflow state and merge only newly cited evidence.
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
        affectedCohorts,
        evidenceRefs,
        experimentIds: existing.experimentIds,
        issueRefs: existing.issueRefs,
        lastVerifiedBuild: existing.lastVerifiedBuild,
        nextReviewAt: existing.nextReviewAt
      }
    };
  }
  return {
    shouldInsert: true,
    finding: {
      identity,
      fingerprint,
      findingId,
      version: 1,
      title: submitted.title,
      description: submitted.description,
      severity: "informational",
      status: "open",
      verificationStage: "not-yet-validated",
      evidenceStatus: "hypothesis",
      affectedEpisodes: null,
      totalEligibleEpisodes: null,
      affectedOpportunities: null,
      totalEligibleOpportunities: null,
      affectedCohorts: [...group.affectedCohorts],
      evidenceRefs: normalizeEvidenceRefs(submitted.evidenceRefs),
      experimentIds: [],
      issueRefs: [],
      lastVerifiedBuild: null,
      nextReviewAt: null
    }
  };
}

function assertSubmittedFindingEvidenceStatus(
  finding: PlaytestFinding,
  group: SubmittedFindingGroup,
  evidenceIndex: PlaytestKnownEvidenceIndex
): void {
  try {
    // Prior revisions may cite other episodes and were validated when they
    // were recorded. Validate this submission against this episode's index.
    assertPlaytestFindingEvidenceStatusConsistent(
      {
        ...finding,
        evidenceRefs: normalizeEvidenceRefs(group.submitted.evidenceRefs)
      },
      evidenceIndex
    );
  } catch {
    throw new PlaytestMcpValidationError(
      "A submitted finding conflicts with its existing evidence status."
    );
  }
}

async function resolveAndValidateSubmittedFinding(
  workspaceId: string,
  group: SubmittedFindingGroup,
  evidenceIndex: PlaytestKnownEvidenceIndex,
  playtestRepository: PlaytestingRepositoryOps
): Promise<PreparedSubmittedFinding> {
  const existing = await playtestRepository.getLatestFindingByFingerprint(
    workspaceId,
    group.fingerprint
  );
  const resolved = resolveSubmittedFinding(group, existing);
  assertSubmittedFindingEvidenceStatus(resolved.finding, group, evidenceIndex);
  return resolved;
}

async function preflightSubmittedFindingGroups(
  workspaceId: string,
  groups: readonly SubmittedFindingGroup[],
  evidenceIndex: PlaytestKnownEvidenceIndex,
  playtestRepository: PlaytestingRepositoryOps
): Promise<void> {
  await mapConcurrentOrdered(groups, FINDING_APPEND_CONCURRENCY, (group) =>
    resolveAndValidateSubmittedFinding(
      workspaceId,
      group,
      evidenceIndex,
      playtestRepository
    )
  );
}

/** Persist one already preflight-validated finding under its fingerprint lock. */
async function appendSubmittedFindingGroup(
  workspaceId: string,
  group: SubmittedFindingGroup,
  evidenceIndex: PlaytestKnownEvidenceIndex,
  playtestRepository: PlaytestingRepositoryOps
): Promise<PlaytestFinding> {
  const resolved = await resolveAndValidateSubmittedFinding(
    workspaceId,
    group,
    evidenceIndex,
    playtestRepository
  );
  if (resolved.shouldInsert) {
    await playtestRepository.insertFinding(workspaceId, resolved.finding);
  }
  return resolved.finding;
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
  const branch = playtestBranchRunRequestSchema.safeParse(request);
  if (branch.success) return branch.data;
  const batch = playtestRunRequestSchema.safeParse(request);
  if (batch.success) return batch.data;
  throw new PlaytestMcpValidationError("The playtest run request is invalid.");
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

type PlaytestRunnableAssignment =
  PlaytestRunCapabilities["runnableAssignments"][number];

function collectRunnableAssignments(input: {
  readonly approval: WorkspacePlaytestApproval | null;
  readonly workspaceId: string;
  readonly workspaceEnabled: boolean;
  readonly prepareSandbox: (
    approval: WorkspacePlaytestApproval
  ) => PreparedPlaytestSandbox;
}): {
  readonly configurationStatus: PlaytestRunCapabilities["configurationStatus"];
  readonly maxBatchAssignments: number;
  readonly assignments: readonly PlaytestRunnableAssignment[];
} {
  const { approval, workspaceId, workspaceEnabled, prepareSandbox } = input;
  if (!approval || approval.revokedAt !== null || !workspaceEnabled) {
    return {
      configurationStatus: "not-checked",
      maxBatchAssignments: 0,
      assignments: []
    };
  }

  const assignments: PlaytestRunnableAssignment[] = [];
  try {
    const prepared = prepareSandbox(approval);
    assertBatchReviewBudget(prepared, approval);
    const maxBatchAssignments = Math.min(
      PLAYTESTS_MAX_BATCH_ASSIGNMENTS,
      approval.limits.episodeCount,
      prepared.configuration.budget.episodes
    );
    for (const scenarioId of approval.allowedScenarios) {
      for (const policyId of approval.allowedPolicies) {
        if (!SUPPORTED_POLICY_IDS.has(policyId)) continue;
        try {
          // The capability probe mirrors batch admission exactly, so an
          // approved cell is only advertised when a batch would be accepted.
          prepareApprovedBatch({
            workspaceId,
            approval,
            prepared,
            batchId: "batch-capability-probe",
            assignments: [
              { scenario: scenarioId, policy: policyId, seed: "probe" }
            ],
            branchPlan: null
          });
          const scenarioFamily = scenarioFamilyFor(prepared, scenarioId);
          const policy = resolvePolicy(policyId);
          assignments.push({
            scenarioId,
            scenarioFamily,
            policyId: policy.id,
            policyVersion: policy.version,
            cohort: policy.cohort,
            strategy: policy.strategy,
            maxStepsPerEpisode: Math.min(
              approval.limits.maxStepsPerEpisode,
              prepared.configuration.budget.maxStepsPerEpisode,
              MAX_PLAYTEST_EPISODE_TRACE_STEPS
            )
          });
        } catch {
          // An approval alone cannot make an incompatible target cell runnable.
        }
      }
    }
    return {
      configurationStatus: "validated",
      maxBatchAssignments,
      assignments
    };
  } catch {
    return {
      configurationStatus: "invalid",
      maxBatchAssignments: 0,
      assignments: []
    };
  }
}

function uniqueRunnablePolicyProfiles(
  assignments: readonly PlaytestRunnableAssignment[]
): PlaytestRunCapabilities["policyProfiles"] {
  const seen = new Set<string>();
  const profiles: PlaytestRunCapabilities["policyProfiles"][number][] = [];
  for (const assignment of assignments) {
    if (seen.has(assignment.policyId)) continue;
    seen.add(assignment.policyId);
    profiles.push({
      policyId: assignment.policyId,
      version: assignment.policyVersion,
      cohort: assignment.cohort,
      strategy: assignment.strategy
    });
  }
  return profiles;
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
    recordComparisonDecision(
      session,
      workspaceId,
      comparisonId,
      expectedVersion,
      disposition,
      reason
    ) {
      assertPlaytestToolRole(
        session.role,
        OWNER_DECISION_ROLES,
        "playtest.decideComparison"
      );
      const authorizedWorkspaceId = authorizeWorkspace(workspaceId, session);
      if (
        !Number.isSafeInteger(expectedVersion) ||
        expectedVersion < 1 ||
        comparisonId.trim().length === 0
      ) {
        throw new PlaytestMcpValidationError(
          "Comparison decision identity or expected revision is invalid."
        );
      }
      const repository = requiredRunRepository(playtestRepository);
      return withAssignmentLock(
        assignmentLocks,
        "comparison-owner-decision\0" +
          authorizedWorkspaceId +
          "\0" +
          comparisonId,
        async () => {
          const current = await repository.getLatestComparison(
            authorizedWorkspaceId,
            comparisonId
          );
          if (
            !current ||
            current.comparisonId !== comparisonId ||
            current.provenance.workspaceId !== authorizedWorkspaceId
          ) {
            throw new PlaytestMcpValidationError(
              "The comparison does not exist in the authorized workspace."
            );
          }
          if (current.version !== expectedVersion) {
            if (
              current.version === expectedVersion + 1 &&
              current.ownerDecisionBy === session.actor &&
              current.ownerDisposition === disposition &&
              current.ownerDecisionReason === reason
            ) {
              return current;
            }
            throw new PlaytestMcpValidationError(
              "The comparison revision changed; read the latest comparison before deciding."
            );
          }

          let decided: PlaytestComparison;
          try {
            decided = recordPlaytestOwnerDecision(current, {
              disposition,
              decidedAt: new Date().toISOString(),
              decidedBy: session.actor,
              reason
            });
          } catch (error) {
            if (error instanceof TypeError || error instanceof RangeError) {
              throw new PlaytestMcpValidationError(error.message);
            }
            throw error;
          }
          try {
            await repository.insertComparison(decided);
            return decided;
          } catch {
            let latest: PlaytestComparison | null;
            try {
              latest = await repository.getLatestComparison(
                authorizedWorkspaceId,
                comparisonId
              );
            } catch {
              throw new PlaytestMcpUnavailableError(
                "Comparison decision persistence is ambiguous; retry the same decision against its expected version."
              );
            }
            if (
              latest &&
              canonicalPlaytestJson(latest) === canonicalPlaytestJson(decided)
            ) {
              return latest;
            }
            throw new PlaytestMcpUnavailableError(
              "Comparison decision was not durably confirmed; no release or deployment action was taken."
            );
          }
        }
      );
    },
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
          maxBatchAssignments: 0,
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
      const runnable = collectRunnableAssignments({
        approval,
        workspaceId: authorizedWorkspaceId,
        workspaceEnabled: workspace.enabled,
        prepareSandbox: prepareSandboxHandler
      });
      const runnableAssignments = runnable.assignments;
      const runnablePolicies = [
        ...new Set(runnableAssignments.map((assignment) => assignment.policyId))
      ];
      const profiles = uniqueRunnablePolicyProfiles(runnableAssignments);
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
        configurationStatus: runnable.configurationStatus,
        maxBatchAssignments: runnable.maxBatchAssignments,
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
      let assignments: readonly PlaytestBatchAssignmentRequest[];
      let branchPlan: BranchExecutionPlan | null = null;
      let prepared: PreparedPlaytestSandbox | undefined;
      if ("parentEpisodeId" in parsed) {
        prepared = prepareSandboxHandler(approval);
        const resolved = await resolveBranchExecutionPlan({
          request: parsed,
          workspaceId: targetWorkspaceId,
          approval,
          prepared,
          repository,
          artifacts
        });
        assignments = resolved.assignments;
        branchPlan = resolved.branchPlan;
      } else {
        assignments = parsed.assignments;
      }

      let resolveStarted!: (batchId: string) => void;
      let rejectStarted!: (error: unknown) => void;
      let registeredBatchId: string | null = null;
      const started = new Promise<string>((resolve, reject) => {
        resolveStarted = resolve;
        rejectStarted = reject;
      });
      const execution = executeApprovedBatch({
        session,
        workspaceId: targetWorkspaceId,
        approval,
        assignments,
        branchPlan,
        ...(prepared === undefined ? {} : { prepared }),
        artifacts,
        repository,
        approvalRepository: approvalRepository!,
        readWorkspaceCatalog,
        prepareSandbox: prepareSandboxHandler,
        launchSandbox: launchSandboxHandler ?? launchPlaytestSandbox,
        runEpisode: runEpisodeHandler,
        activeRuns,
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
              status: cancellationReason === null ? result.status : "cancelled",
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
              result: active ? activeRunProgress(active) : null,
              error: safeError
            },
            targetWorkspaceId
          );
          return undefined;
        }
      );
      return {
        batchId: await started,
        assignmentCount:
          "assignments" in parsed ? parsed.assignments.length : 1,
        status: "running"
      };
    },
    async listActiveRuns(session, workspaceId) {
      assertRunStatusReader(session);
      const authorizedWorkspaceId = authorizeExistingRunWorkspace(
        session,
        workspaceId,
        readWorkspaceCatalog
      );
      if (playtestRepository) {
        const reconcilePage = async (
          cursor: string | undefined,
          seenCursors: ReadonlySet<string>
        ): Promise<void> => {
          const page = await playtestRepository.listBatches(
            { workspaceId: authorizedWorkspaceId, status: "running" },
            { limit: 500, ...(cursor ? { cursor } : {}) }
          );
          const interrupted = page.rows.filter(
            (batch) => !activeRuns.has(batch.batchId)
          );
          await mapConcurrentOrdered(interrupted, 4, (batch) =>
            readStoredRunStatus(
              playtestRepository,
              authorizedWorkspaceId,
              batch.batchId,
              assignmentLocks
            )
          );
          const nextCursor = page.nextCursor ?? undefined;
          if (!nextCursor) return;
          if (seenCursors.has(nextCursor)) {
            throw new PlaytestMcpUnavailableError(
              "Playtest Data returned a repeated cursor while reconciling active runs."
            );
          }
          const nextSeenCursors = new Set(seenCursors);
          nextSeenCursors.add(nextCursor);
          await reconcilePage(nextCursor, nextSeenCursors);
        };
        await reconcilePage(undefined, new Set());
      }
      return [...activeRuns.values()]
        .filter((run) => run.workspaceId === authorizedWorkspaceId)
        .map((run) => ({
          batchId: run.batchId,
          assignmentCount: run.assignmentCount,
          createdAt: run.createdAt,
          status: activeRunStatus(run)
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
        const repository = playtestRepository;
        if (!repository) {
          throw new PlaytestMcpUnavailableError(
            "Playtest Data storage is unavailable for persisted run status."
          );
        }
        return readStoredRunStatus(
          repository,
          authorizedWorkspaceId,
          batchId,
          assignmentLocks
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
      return activeRunStatus(current);
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

async function readPreparedReviewPacket(input: {
  readonly workspaceId: string;
  readonly episode: PlaytestEpisode;
  readonly repository: PlaytestingRepositoryOps;
  readonly artifacts: PlaytestArtifactStore;
}): Promise<{
  readonly packet: PlaytestEvidencePacket;
  readonly artifact: PlaytestArtifactReference;
}> {
  const { workspaceId, episode, repository, artifacts } = input;
  if (!episode.assignmentId) {
    throw new PlaytestMcpValidationError(
      "Historical episodes without frozen assignment identity have no analyst packet."
    );
  }
  const batch = await repository.getBatch(workspaceId, episode.batchId);
  if (
    !batch ||
    batch.assignmentInventory.status !== "frozen" ||
    batch.reviewSelection.status !== "selected" ||
    batch.coverageManifest === null
  ) {
    throw new PlaytestMcpUnavailableError(
      "The episode has no persisted completed-batch analyst packet selection."
    );
  }
  const selected = batch.reviewSelection.selected.find(
    (entry) =>
      entry.assignmentId === episode.assignmentId &&
      entry.episodeId === episode.episodeId
  );
  if (!selected) {
    throw new PlaytestMcpAuthorizationError(
      "This episode was not selected for bounded analyst review."
    );
  }
  const receipt = batch.reviewPackets.find(
    (entry) =>
      entry.assignmentId === episode.assignmentId &&
      entry.episodeId === episode.episodeId
  );
  if (!receipt) {
    throw new PlaytestMcpUnavailableError(
      "No persisted evidence packet exists for this selected session."
    );
  }
  if (receipt.status === "unavailable") {
    throw new PlaytestMcpUnavailableError(
      "The selected session packet is unavailable: " +
        receipt.failureReason +
        "."
    );
  }
  const reference = artifacts.referenceForId(receipt.artifact.artifactId);
  if (
    !reference ||
    reference.sha256.toLowerCase() !== receipt.artifact.sha256.toLowerCase() ||
    reference.bytes !== receipt.artifact.bytes ||
    reference.mediaType !== PLAYTESTS_EVIDENCE_PACKET_MEDIA_TYPE ||
    artifacts.boundWorkspaceId() !== workspaceId
  ) {
    throw new PlaytestMcpUnavailableError(
      "The persisted evidence packet artifact no longer matches its batch receipt."
    );
  }
  let packet: unknown;
  try {
    const bytes = artifacts.readArtifact(reference).bytes;
    packet = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes)
    );
    assertPlaytestEvidencePacket(packet);
  } catch {
    throw new PlaytestMcpUnavailableError(
      "The persisted evidence packet is malformed, expired, or corrupt."
    );
  }
  const typed = packet as PlaytestEvidencePacket;
  const assignment = batch.assignmentInventory.manifest.assignments.find(
    (entry) => entry.assignmentId === episode.assignmentId
  );
  const traceReference =
    episode.trace === null ? null : artifacts.referenceForId(episode.trace.id);
  if (
    !assignment ||
    typed.packetId !== receipt.packetId ||
    typed.workspaceId !== workspaceId ||
    typed.batchId !== batch.batchId ||
    typed.episodeId !== episode.episodeId ||
    typed.episodeRevision !== episode.revision ||
    typed.assignmentId !== assignment.assignmentId ||
    typed.generatedAt !== receipt.createdAt ||
    typed.buildSha !== batch.buildSha ||
    typed.policyId !== assignment.policyId ||
    typed.policyVersion !== assignment.policyVersion ||
    typed.scenarioId !== assignment.scenarioId ||
    typed.scenarioFamily !== assignment.scenarioFamily ||
    typed.cohort !== assignment.cohort ||
    typed.rubricHash !== batch.rubricHash ||
    typed.coverageManifestHash !== batch.coverageManifest.contentHash ||
    !traceReference ||
    !typed.suppliedArtifacts.some(
      (artifact) =>
        artifact.kind === "trace" &&
        artifact.artifactId === traceReference.artifactId &&
        artifact.sha256.toLowerCase() === traceReference.sha256.toLowerCase()
    )
  ) {
    throw new PlaytestMcpUnavailableError(
      "The evidence packet does not match its selected episode, batch, rubric and source trace."
    );
  }
  return { packet: typed, artifact: reference };
}

type ReviewDimensionEvidence = z.infer<typeof reviewDimensionEvidenceSchema>;
type ReviewExperiment = z.infer<typeof reviewExperimentSchema>;

function anchorsForReview(
  packet: PlaytestEvidencePacket,
  evidence: readonly ReviewDimensionEvidence[]
): readonly PlaytestDimensionAnchor[] {
  const notes = new Map<string, ReviewDimensionEvidence>();
  const rubricIds = new Set(
    packet.dimensionRubrics.map((rubric) => rubric.dimensionId)
  );
  for (const item of evidence) {
    if (!rubricIds.has(item.dimensionId) || notes.has(item.dimensionId)) {
      throw new PlaytestMcpValidationError(
        "Dimension evidence must refer to one unique rubric dimension in the prepared packet."
      );
    }
    notes.set(item.dimensionId, item);
  }

  return packet.dimensionRubrics.map((rubric) => {
    const note = notes.get(rubric.dimensionId);
    const evidenceRefs = note ? normalizeEvidenceRefs(note.evidenceRefs) : [];
    const matchingMetrics = packet.metrics.filter(
      (metric) =>
        rubric.indicator ===
        `${metric.metricId}@${String(metric.metricVersion)}`
    );
    const metric =
      matchingMetrics.length === 1 &&
      evidenceRefs.length > 0 &&
      rubric.modality === packet.observationMode
        ? matchingMetrics[0]!
        : null;
    const anchor = scorePlaytestDimensionAnchor(rubric, {
      dimensionId: rubric.dimensionId,
      ratio: metric?.estimate ?? null,
      independentUnits: metric?.independentUnits ?? null,
      eligibleOpportunities: metric?.opportunityCount ?? null,
      evidenceRefs,
      ...(note?.counterexampleId === undefined
        ? {}
        : { counterexampleId: note.counterexampleId })
    });
    return {
      ...anchor,
      rationale: note?.rationale ?? anchor.rationale,
      ...(metric === null && rubric.modality !== packet.observationMode
        ? { insufficientReason: "unsupported-modality" as const }
        : {})
    };
  });
}

function assertReviewExperimentMetrics(
  packet: PlaytestEvidencePacket,
  experiments: readonly ReviewExperiment[]
): void {
  const metricIds = new Set([
    ...packet.metrics.map((metric) => metric.metricId),
    ...packet.metricIntent.map((metric) => metric.metricId)
  ]);
  if (experiments.some((experiment) => !metricIds.has(experiment.metricId))) {
    throw new PlaytestMcpValidationError(
      "Review experiments must target a metric declared by the prepared packet."
    );
  }
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
    playtestRunControl
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
        return playtestRunControl.getCapabilities(session, targetWorkspaceId);
      })
  );

  // 2. playtest.run
  mcp.registerTool(
    "playtest.run",
    {
      description:
        "Execute one approved ordered batch of assignments in isolated sandboxes with game adapter negotiation, verified artifact recording and a frozen per-batch critique selection. A one-episode request is a one-element assignments array.",
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
        "Cancel one active batch by its server-generated immutable batch id; every in-flight assignment stops.",
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
        assertPlaytestToolRole(
          session.role,
          RUN_STATUS_READER_ROLES,
          "playtest.listEpisodes"
        );
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
        assertPlaytestToolRole(
          session.role,
          RUN_STATUS_READER_ROLES,
          "playtest.readEpisode"
        );
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
        assertPlaytestToolRole(
          session.role,
          RUN_STATUS_READER_ROLES,
          "playtest.readWindow"
        );
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
        assertPlaytestToolRole(
          session.role,
          ANALYSIS_READER_ROLES,
          "playtest.metrics"
        );
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
        assertPlaytestToolRole(
          session.role,
          ANALYSIS_READER_ROLES,
          "playtest.compare"
        );
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

  mcp.registerTool(
    "playtest.decideComparison",
    {
      description:
        "Append a root/operator-authored promote-or-hold decision to the exact current stored comparison revision. Promotion records eligibility only; this tool never deploys, merges, or changes a workspace approval.",
      inputSchema: z.strictObject({
        workspaceId: z.string().min(1).max(256).optional(),
        comparisonId: z.string().min(1).max(256),
        expectedVersion: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
        disposition: z.enum(["promote", "hold"]),
        reason: z.string().min(1).max(4000)
      })
    },
    ({ workspaceId, comparisonId, expectedVersion, disposition, reason }) =>
      safely(async () => {
        const session = await sessionProvider.current();
        assertPlaytestToolRole(
          session.role,
          OWNER_DECISION_ROLES,
          "playtest.decideComparison"
        );
        const targetWorkspaceId = authorizeWorkspace(workspaceId, session);
        return playtestRunControl.recordComparisonDecision(
          session,
          targetWorkspaceId,
          comparisonId,
          expectedVersion,
          disposition,
          reason
        );
      })
  );

  // 8. playtest.prepareReview
  mcp.registerTool(
    "playtest.prepareReview",
    {
      description:
        "Return the frozen, prebuilt and bounded evidence packet for one preselected completed session. The packet's omitted-window reasons and artifact hashes are authoritative; do not substitute ad hoc trace reads.",
      inputSchema: {
        workspaceId: z.string().min(1).max(256).optional(),
        episodeId: z.string().min(1).max(256)
      }
    },
    ({ workspaceId, episodeId }) =>
      safely(async () => {
        const session = await sessionProvider.current();
        if (!isReviewerRole(session.role)) {
          throw new PlaytestMcpAuthorizationError(
            "playtest.prepareReview requires the read-only playtest analyst role."
          );
        }
        const targetWorkspaceId = authorizeWorkspace(workspaceId, session);
        if (!playtestRepository) {
          throw new PlaytestMcpUnavailableError(
            "Playtest Data storage is unavailable for analyst packet retrieval."
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
        const packet = await readPreparedReviewPacket({
          workspaceId: targetWorkspaceId,
          episode,
          repository: playtestRepository,
          artifacts: artifactStoreForWorkspace(targetWorkspaceId)
        });
        return {
          packet: packet.packet,
          packetArtifact: packet.artifact
        };
      })
  );

  // 9. playtest.submitReview
  mcp.registerTool(
    "playtest.submitReview",
    {
      description:
        "Submit an immutable playtest review for an episode with evidence locator validation against the real stored evidence index.",
      inputSchema: {
        workspaceId: z.string().min(1).max(256).optional(),
        episodeId: z.string().min(1).max(256),
        packetId: z.string().min(1).max(128),
        packetArtifactId: z.string().min(1).max(128),
        packetSha256: z.string().regex(SHA256_PATTERN),
        chronologicalSummary: z.string().min(1).max(10_000),
        status: z.enum(REVIEWABLE_STATUSES),
        evidenceRefs: z.array(evidenceLocatorSchema).min(1),
        observations: z.array(reviewClaimSchema).min(1).max(64),
        interpretations: z.array(reviewClaimSchema).min(1).max(64),
        dimensionEvidence: z
          .array(reviewDimensionEvidenceSchema)
          .max(32)
          .default([]),
        alternativeExplanations: z.array(z.string().min(1).max(4000)).max(32),
        reportCompleteness: reviewCompletenessSchema,
        experiments: z.array(reviewExperimentSchema).max(32),
        findings: z
          .array(findingSchema)
          .max(MAX_FINDINGS_PER_REVIEW)
          .default([]),
        rubricHash: z.string().min(1).max(256),
        notes: z.string().max(4000).optional()
      }
    },
    (args) =>
      safely(async () => {
        const session = await sessionProvider.current();
        const reviewerRole = session.role;
        if (!isReviewerRole(reviewerRole)) {
          throw new PlaytestMcpAuthorizationError(
            "playtest.submitReview requires an authorized reviewer role."
          );
        }
        if (
          !Array.isArray(args.observations) ||
          args.observations.length === 0 ||
          !Array.isArray(args.interpretations) ||
          args.interpretations.length === 0 ||
          !Array.isArray(args.alternativeExplanations) ||
          !Array.isArray(args.experiments)
        ) {
          throw new PlaytestMcpValidationError(
            "A review must include observed and interpreted claims, alternatives, and an explicit experiment list."
          );
        }
        const evidenceRefs = normalizeEvidenceRefs(args.evidenceRefs ?? []);
        const observations = (args.observations ?? []).map((claim) => ({
          text: claim.text,
          evidenceRefs: normalizeEvidenceRefs(claim.evidenceRefs)
        }));
        const interpretations = (args.interpretations ?? []).map((claim) => ({
          text: claim.text,
          evidenceRefs: normalizeEvidenceRefs(claim.evidenceRefs)
        }));
        const submittedFindings = args.findings ?? [];
        if (submittedFindings.length > MAX_FINDINGS_PER_REVIEW) {
          throw new PlaytestMcpValidationError(
            `A review may include at most ${String(MAX_FINDINGS_PER_REVIEW)} findings.`
          );
        }
        let findings: SubmittedFinding[];
        try {
          findings = submittedFindings.map((finding) =>
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
        const assignmentId = episode.assignmentId;
        if (!assignmentId) {
          throw new PlaytestMcpValidationError(
            "Historical episodes without assignment identity cannot receive batch-budgeted reviews."
          );
        }
        const packet = await readPreparedReviewPacket({
          workspaceId: targetWorkspaceId,
          episode,
          repository: playtestRepository,
          artifacts: artifactStoreForWorkspace(targetWorkspaceId)
        });
        if (
          packet.packet.packetId !== args.packetId ||
          packet.artifact.artifactId !== args.packetArtifactId ||
          packet.artifact.sha256.toLowerCase() !==
            args.packetSha256.toLowerCase() ||
          args.rubricHash !== packet.packet.rubricHash
        ) {
          throw new PlaytestMcpValidationError(
            "The submitted review does not match the frozen evidence packet."
          );
        }
        const dimensionEvidence = args.dimensionEvidence ?? [];
        const alternativeExplanations = args.alternativeExplanations ?? [];
        const experiments = args.experiments ?? [];
        const reportCompleteness =
          args.reportCompleteness as PlaytestReviewCompleteness;
        assertReviewExperimentMetrics(packet.packet, experiments);
        const anchors = anchorsForReview(packet.packet, dimensionEvidence);
        const packetEvidenceRefs = [
          ...evidenceRefs,
          ...(reportCompleteness.crossSessionContext.status === "available"
            ? reportCompleteness.crossSessionContext.evidenceRefs
            : []),
          ...findings.flatMap((finding) => finding.evidenceRefs),
          ...observations.flatMap((claim) => claim.evidenceRefs),
          ...interpretations.flatMap((claim) => claim.evidenceRefs),
          ...dimensionEvidence.flatMap((dimension) => dimension.evidenceRefs)
        ] as PlaytestEvidenceLocator[];
        try {
          assertPlaytestEvidenceLocatorsWithinPacket(
            packetEvidenceRefs,
            packet.packet
          );
        } catch {
          throw new PlaytestMcpValidationError(
            "Review citations include evidence that was not supplied in the frozen analyst packet."
          );
        }
        const reviewId =
          "review-" +
          createHash("sha256")
            .update(
              canonicalPlaytestJson({
                workspaceId: targetWorkspaceId,
                batchId: episode.batchId,
                episodeId: episode.episodeId,
                chronologicalSummary: args.chronologicalSummary,
                status: args.status,
                evidenceRefs,
                observations,
                interpretations,
                dimensionEvidence,
                alternativeExplanations,
                reportCompleteness,
                experiments,
                findings,
                rubricHash: args.rubricHash,
                packetId: packet.packet.packetId,
                packetSha256: packet.artifact.sha256,
                notes: args.notes ?? ""
              })
            )
            .digest("hex");

        return serializeBatchReview(
          targetWorkspaceId,
          episode.batchId,
          async () => {
            const batch = await playtestRepository.getBatch(
              targetWorkspaceId,
              episode.batchId
            );
            if (
              !batch ||
              batch.assignmentInventory.status !== "frozen" ||
              batch.reviewSelection.status !== "selected"
            ) {
              throw new PlaytestMcpValidationError(
                "This episode has no frozen, completed batch review selection."
              );
            }
            const assignment =
              batch.assignmentInventory.manifest.assignments.find(
                (candidate) => candidate.assignmentId === assignmentId
              );
            const selected = batch.reviewSelection.selected.find(
              (candidate) =>
                candidate.assignmentId === assignmentId &&
                candidate.episodeId === episode.episodeId
            );
            if (
              !assignment ||
              assignment.scenarioId !== episode.identity.scenarioId ||
              assignment.policyId !== episode.identity.policyId ||
              assignment.seed !== episode.identity.seed ||
              !selected
            ) {
              throw new PlaytestMcpAuthorizationError(
                "The episode was not selected for this batch's bounded analyst review."
              );
            }
            const storedPacketReceipt = batch.reviewPackets.find(
              (receipt) =>
                receipt.status === "prepared" &&
                receipt.packetId === packet.packet.packetId &&
                receipt.assignmentId === assignmentId &&
                receipt.episodeId === episode.episodeId &&
                receipt.artifact.artifactId === packet.artifact.artifactId &&
                receipt.artifact.sha256 === packet.artifact.sha256
            );
            if (!storedPacketReceipt) {
              throw new PlaytestMcpAuthorizationError(
                "The evidence packet is not a durable packet receipt for this selected assignment."
              );
            }
            const receiptInput: PlaytestReviewReceiptInput = {
              reviewId,
              assignmentId,
              episodeId: episode.episodeId,
              packetId: packet.packet.packetId
            };
            const existing = await playtestRepository.getLatestReview(
              targetWorkspaceId,
              episode.episodeId,
              reviewId
            );
            if (existing) {
              if (
                existing.evidencePacket === null ||
                existing.evidencePacket.packetId !== packet.packet.packetId ||
                existing.evidencePacket.artifact.sha256 !==
                  packet.artifact.sha256
              ) {
                throw new PlaytestMcpUnavailableError(
                  "The persisted review does not match the selected evidence packet."
                );
              }
              const reservedBatch = await reserveBatchReviewReceipt(
                batch,
                receiptInput,
                playtestRepository
              );
              await persistBatchReviewReceipt(
                reservedBatch,
                reviewId,
                playtestRepository
              );
              return existing;
            }
            const priorReceipt = batch.reviewReceipts.find(
              (receipt) => receipt.reviewId === reviewId
            );
            if (priorReceipt?.status === "persisted") {
              throw new PlaytestMcpUnavailableError(
                "A persisted batch review receipt has no matching review record."
              );
            }

            const allEvidenceRefs = [
              ...evidenceRefs,
              ...findings.flatMap((finding) => finding.evidenceRefs),
              ...observations.flatMap((claim) => claim.evidenceRefs),
              ...interpretations.flatMap((claim) => claim.evidenceRefs)
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
                evidenceRefs,
                observations,
                interpretations,
                alternativeExplanations,
                experiments,
                reportCompleteness,
                findings: findings.map((finding, index) => ({
                  findingId: "review-precheck-finding-" + String(index + 1),
                  evidenceRefs: normalizeEvidenceRefs(finding.evidenceRefs)
                }))
              });
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
            await preflightSubmittedFindingGroups(
              targetWorkspaceId,
              findingGroups,
              knownIndex,
              playtestRepository
            );
            const reservedBatch = await reserveBatchReviewReceipt(
              batch,
              receiptInput,
              playtestRepository
            );
            const resolvedFindings = await mapConcurrentOrdered(
              findingGroups,
              FINDING_APPEND_CONCURRENCY,
              (group) =>
                serializeFindingAppend(
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

            const review: PlaytestSessionReview = {
              schema: PLAYTESTS_SESSION_REVIEW_SCHEMA,
              reviewId,
              version: 1,
              episodeId: args.episodeId,
              supersedes: null,
              evidencePacket: {
                packetId: packet.packet.packetId,
                artifact: packet.artifact
              },
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
              authoritativeMetrics: packet.packet.metrics,
              observations,
              interpretations,
              anchors,
              alternativeExplanations,
              reportCompleteness,
              experiments,
              status: args.status,
              findings: resolvedFindings,
              evidenceRefs,
              createdAt: new Date().toISOString(),
              notes: args.notes ?? ""
            };

            await playtestRepository.insertReview(review);
            await persistBatchReviewReceipt(
              reservedBatch,
              reviewId,
              playtestRepository
            );
            return review;
          }
        );
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
        assertPlaytestToolRole(
          session.role,
          FINDING_READER_ROLES,
          "playtest.findings"
        );
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
        "Create a separately budgeted, same-stream counterfactual assignment. Runtime requires a complete source episode, verified full-state/RNG checkpoint, an alternate legal action, and exact approved build/config provenance.",
      inputSchema: z.strictObject({
        workspaceId: z.string().min(1).max(256).optional(),
        parentEpisodeId: z.string().min(1).max(256),
        branchStep: z.number().int().min(0).max(99_999),
        alternativeActionId: z.string().min(1).max(256),
        policy: z.string().min(1).max(256).optional(),
        maxSteps: z.number().int().min(1).max(100_000).optional()
      })
    },
    ({
      workspaceId,
      parentEpisodeId,
      branchStep,
      alternativeActionId,
      policy,
      maxSteps
    }) =>
      safely(async () => {
        const session = await sessionProvider.current();
        return playtestRunControl.startRun(session, {
          workspaceId,
          parentEpisodeId,
          branchStep,
          alternativeActionId,
          ...(policy === undefined ? {} : { policy }),
          ...(maxSteps === undefined ? {} : { maxSteps })
        });
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
