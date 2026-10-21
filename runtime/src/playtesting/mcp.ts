/** Runtime-hosted Playtesting MCP server implementation. */
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  aggregatePlaytestCrossSessionMetrics,
  assertPlaytestAdapterEpisode,
  assertPlaytestAssignmentManifest,
  assertPlaytestAssignmentsMatchBenchmark,
  assertPlaytestBatchAssignments,
  assertPlaytestBranchLineage,
  assertPlaytestCheckpointDigest,
  assertPlaytestCoveragePlanCoversAssignments,
  assertPlaytestCrossSessionMetricAggregation,
  assertPlaytestCrossSessionSynthesis,
  assertPlaytestEvidenceLocatorsWithinPacket,
  assertPlaytestEvidencePacket,
  assertPlaytestFindingEvidenceStatusConsistent,
  assertPlaytestReviewNarrativeGroundedInPacket,
  assertPlaytestReviewNarrativeMinimums,
  assertPlaytestSessionReviewHasEvidence,
  buildPlaytestCoverageManifestDraft,
  buildPlaytestEvidencePacket,
  buildPlaytestFindingIdentity,
  buildPlaytestIssueDrafts,
  canonicalPlaytestJson,
  type PlaytestAdapterAssignmentManifest,
  type PlaytestAdapterBatch,
  type PlaytestAdapterBranchOperation,
  type PlaytestArtifactReference,
  type PlaytestAssignmentBranch,
  playtestAssignmentManifestHashInput,
  playtestEpisodeRecordId,
  playtestVisualEpisodeRecordId,
  type PlaytestAssignmentOutcome,
  type PlaytestAssignmentTerminalState,
  type PlaytestBatch,
  type PlaytestBatchAssignment,
  type PlaytestBatchCancellationReason,
  playtestBatchCountsFromAssignments,
  type PlaytestBatchReviewSelection,
  playtestBatchTerminalState,
  type PlaytestBenchmark,
  type PlaytestCapabilityAdvertisement,
  type PlaytestCheckpointDigest,
  type PlaytestComparison,
  type PlaytestCompletionCounts,
  type PlaytestCoverageEpisode,
  type PlaytestCoverageManifest,
  playtestCoverageManifestHashInput,
  type PlaytestCoveragePlanCell,
  playtestCoveragePlanForRegistry,
  type PlaytestCrossSessionClaim,
  type PlaytestCrossSessionExperiment,
  playtestCrossSessionInventoryHashInput,
  type PlaytestCrossSessionMetricAggregation,
  type PlaytestCrossSessionSynthesis,
  type PlaytestDiscoveryEvidencePacketV3,
  type PlaytestDiscoverySessionReview,
  type PlaytestDiscoveryReviewDraft,
  type PlaytestDimensionAnchor,
  type PlaytestEpisode,
  type PlaytestEpisodeState,
  type PlaytestEvidenceLocator,
  type PlaytestEvidenceOmittedArtifact,
  type PlaytestEvidencePacket,
  type PlaytestEvidenceTraceStep,
  type PlaytestFinding,
  type PlaytestFindingIdentity,
  type PlaytestPlayerDebriefV1,
  type PlaytestPlayerEvidenceReference,
  playtestFindingIdentityHashInput,
  playtestFindingIdFromFingerprint,
  type PlaytestIssueDraft,
  playtestIssueReportingRefusal,
  type PlaytestKnownEvidenceIndex,
  type PlaytestLaunchAssignment,
  type PlaytestLaunchRequest,
  type PlaytestMissingReason,
  type PlaytestOwnerDisposition,
  type PlaytestReviewCandidate,
  type PlaytestReviewCompleteness,
  playtestReviewOutcomeKey,
  type PlaytestReviewPacketFailureReason,
  type PlaytestReviewPacketReceipt,
  type PlaytestReviewReceipt,
  type PlaytestRunAssignmentOutcome,
  type PlaytestSessionReference,
  PLAYTESTS_ASSIGNMENT_MANIFEST_SCHEMA,
  PLAYTESTS_BATCH_SCHEMA,
  PLAYTESTS_CROSS_SESSION_SYNTHESIS_SCHEMA,
  PLAYTESTS_EPISODE_SCHEMA,
  PLAYTESTS_EPISODE_STATES,
  PLAYTESTS_EVIDENCE_PACKET_MAX_TOKENS,
  PLAYTESTS_EVIDENCE_PACKET_MEDIA_TYPE,
  PLAYTESTS_DISCOVERY_EVIDENCE_PACKET_MEDIA_TYPE,
  PLAYTESTS_DISCOVERY_EVIDENCE_PACKET_MAX_TOKENS,
  PLAYTESTS_DISCOVERY_SESSION_REVIEW_SCHEMA,
  PLAYTESTS_FINDING_STATUSES,
  PLAYTESTS_GAME_OUTCOMES,
  PLAYTESTS_MAX_ANALYSIS_SESSIONS,
  PLAYTESTS_MAX_BATCH_ASSIGNMENTS,
  PLAYTESTS_MAX_BATCH_REVIEW_SESSIONS,
  PLAYTESTS_MAX_CROSS_SESSION_PACKET_SESSIONS,
  PLAYTESTS_MEASUREMENT_VERSION,
  PLAYTEST_PLAYER_DEBRIEF_SCHEMA,
  PLAYTESTS_RNG_POLICY_VERSION,
  PLAYTESTS_SESSION_REVIEW_SCHEMA,
  PLAYTESTS_SEVERITIES,
  PLAYTESTS_VERIFICATION_STAGES,
  type PlaytestSessionReview,
  assertPlaytestDiscoveryEvidencePacket,
  assertPlaytestDiscoveryReviewDraft,
  assertPlaytestDiscoveryReviewGroundedInPacket,
  assertPlaytestDiscoverySessionReview,
  recordPlaytestOwnerDecision,
  scorePlaytestDimensionAnchor,
  selectPlaytestBatchReviews,
  triagePlaytestFindings,
  type PlaytestAssignmentManifestDraft,
  type PlaytestJsonValue,
  PLAYTESTS_VISUAL_ASSIGNMENT_MANIFEST_SCHEMA,
  type PlaytestVisualAssignmentManifest,
  type PlaytestVisualBatch,
  type PlaytestVisualBatchAssignment,
  PLAYTEST_VISUAL_ACTION_SCHEMA,
  PLAYTEST_VISUAL_OBSERVATION_SCHEMA,
  type PlaytestVisualAction,
  type PlaytestVisualObservation,
  type WorkspacePlaytestApproval,
  type WorkspacePlaytestBuild,
  type WorkspaceVisualPlaytestLimits,
  type WorkspaceVisualPlaytestTargetApproval
} from "@simulatorlife/autodev-core";
import {
  ConfigRepository,
  type WorkspaceCatalogRead
} from "@simulatorlife/autodev-data";
import {
  PlaytestInvalidCursorError,
  type PlaytestLaunchIntent,
  PlaytestSourceUnavailableError
} from "@simulatorlife/autodev-data/playtesting";
import {
  WorkspaceVisualPlaytestTargetRepository,
  type WorkspacePlaytestApprovalRepository
} from "@simulatorlife/autodev-data/workspaces";
import { z } from "zod/v4";

import type { PlaytestingReadRepository } from "../control-api/playtesting.ts";
import { mapConcurrentOrdered } from "../shared/map-concurrent-ordered.ts";
import { writeErrorLine } from "../shared/output.ts";
import type {
  PlaytestAnalystProcess,
  PlaytestAnalystProcessInput,
  PlaytestAnalystProcessResult
} from "./analyst-process.ts";
import {
  type PlaytestArtifactStore,
  type PlaytestArtifactWindowReadResult,
  PLAYTESTS_ARTIFACT_WINDOW_MEDIA_TYPE
} from "./artifact-store.ts";
import { standardizePlaytestCohorts } from "./cohort-standardization-run.ts";
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
  playtestBranchLaunchRequestSchema,
  playtestLaunchRequestSchema
} from "./launch-request-schema.ts";
import {
  createBuiltinPlaytestPolicy,
  type PlaytestPolicy,
  PLAYTESTS_BUILTIN_POLICY_IDS
} from "./policies.ts";
import { derivePlaytestPolicyValidity } from "./policy-validity-run.ts";
import { preparePlaytestDiscoveryEvidencePacket } from "./discovery-review.ts";
import {
  SmartDirectPolicyError,
  SMART_DIRECT_POLICY_VERSION,
  SmartDirectVisualPolicy
} from "./smart-direct-policy.ts";
import {
  createPlaytestPolicyWorkspace,
  removePlaytestPolicyWorkspace,
  type PlaytestPolicyWorkspace
} from "./policy-workspace.ts";
import {
  PlaytestVisualBrowserDriver,
  PlaytestVisualBrowserDriverError,
  type PlaytestVisualDriverOpener,
  type PlaytestVisualEpisodeDriver,
  type PlaytestVisualObservationBlockReason
} from "./visual-browser-driver.ts";

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

export class PlaytestMcpConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PlaytestMcpConflictError";
  }
}

class PlaytestReviewNarrativeValidationError extends Error {
  constructor() {
    super(
      "Review narrative fields must contain at least three words and sixteen characters. Add packet-specific detail or an evidence-based reason for unavailable sections; compact experiment controls are allowed."
    );
    this.name = "PlaytestReviewNarrativeValidationError";
  }
}

class PlaytestReviewGroundingValidationError extends Error {
  constructor(detail: string) {
    super(`Review narrative is not grounded in the selected packet: ${detail}`);
    this.name = "PlaytestReviewGroundingValidationError";
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
  /** Trusted Runtime analysis task id; present only in an analyst process. */
  readonly analysisId?: string;
}

export interface PlaytestMcpSession extends PlaytestRunControlActor {
  readonly repositoryRoot?: string | null;
  /** Runtime-bound packet selection for a dispatched analyst task. */
  readonly selectedEpisodeIds?: readonly string[];
  /** Runtime-computed immutable metric context for this exact analyst task. */
  readonly analysisKind?: "confirmatory" | "discovery";
  readonly metricAggregation?: PlaytestCrossSessionMetricAggregation;
}

function preparedAnalystPacketCacheKey(
  session: PlaytestMcpSession,
  workspaceId: string,
  episodeId: string
): string | null {
  return session.role === REVIEWER_ROLE && session.analysisId
    ? JSON.stringify([workspaceId, session.analysisId, episodeId])
    : null;
}

export interface PlaytestMcpSessionProvider {
  current(): Promise<PlaytestMcpSession> | PlaytestMcpSession;
}

export interface PlaytestActiveRunSummary {
  readonly batchId: string;
  readonly assignmentCount: number;
  readonly createdAt: string;
  readonly sessions: readonly PlaytestSessionReference[];
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

export interface PlaytestLaunchIntentRepository {
  getLaunchIntent(
    workspaceId: string,
    actorId: string,
    requestId: string
  ): Promise<PlaytestLaunchIntent | null>;
  insertLaunchIntent(intent: PlaytestLaunchIntent): Promise<void>;
}

export interface PlaytestRunStartReceipt {
  readonly batchId: string;
  readonly assignmentCount: number;
  readonly assignmentIds: readonly string[];
  readonly sessions: readonly PlaytestSessionReference[];
  readonly createdAt: string;
  readonly status: PlaytestRunStatus["status"];
}

export interface PlaytestRunRequestLookup {
  readonly requestId: string;
  readonly state: "not-found" | "expired" | "pending" | "accepted";
  readonly batchId: string | null;
  readonly assignmentCount: number | null;
  readonly assignmentIds: readonly string[];
  readonly sessions: readonly PlaytestSessionReference[];
  readonly createdAt: string | null;
  readonly status: PlaytestRunStatus["status"] | null;
}

export interface PlaytestAnalystReviewReceipt {
  readonly episodeId: string;
  readonly reviewId: string;
  readonly status: PlaytestSessionReview["status"];
}

export interface PlaytestAnalystReviewRun {
  readonly analysisId: string;
  readonly workspaceId: string;
  readonly analysisKind?: "confirmatory" | "discovery";
  readonly status: "running" | "completed" | "partial" | "failed";
  readonly createdAt: string;
  readonly finishedAt: string | null;
  readonly requestedEpisodeIds: readonly string[];
  readonly packets: readonly {
    readonly episodeId: string;
    readonly batchId: string;
    readonly packetId: string;
  }[];
  readonly receipts: readonly PlaytestCrossSessionReceipt[];
  readonly budget: readonly PlaytestCrossSessionBudget[];
  readonly reviews: readonly PlaytestAnalystReviewReceipt[];
  readonly synthesisId: string | null;
  readonly error: string | null;
}

export interface PlaytestAnalystReviewStatus {
  readonly runs: readonly PlaytestAnalystReviewRun[];
  readonly syntheses: readonly PlaytestCrossSessionSynthesis[];
}

export interface PlaytestAnalystReviewDispatch {
  dispatchCrossSessionReview(
    session: PlaytestMcpSession,
    workspaceId: string,
    episodeIds: readonly string[]
  ): Promise<{
    readonly run: PlaytestAnalystReviewRun | null;
    readonly packets: readonly PlaytestCrossSessionPacket[];
    readonly receipts: readonly PlaytestCrossSessionReceipt[];
    readonly budget: readonly PlaytestCrossSessionBudget[];
  }>;
  listAnalystReviewRuns(
    session: PlaytestMcpSession,
    workspaceId: string
  ): Promise<PlaytestAnalystReviewStatus>;
}

export interface PlaytestAnalystProcessLauncher {
  (input: PlaytestAnalystProcessInput): PlaytestAnalystProcess;
}

/**
 * Shared Runtime-owned run/cancellation surface. The Control API hosts the
 * process singleton; the stdio MCP facade calls it through the scoped,
 * loopback-only Control API client instead of creating a second run registry.
 */
export interface PlaytestRunCapabilities {
  readonly workspaceId: string;
  /** Revision returned by authenticated Control API preflight when present. */
  readonly capabilityRevision?: string | undefined;
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
  /**
   * Seeds the latest build's frozen benchmark admits, in inventory order.
   * `null` when that build freezes no benchmark, so any bounded printable
   * seed is admissible. A run request outside this list is refused.
   */
  readonly admissibleSeeds:
    | readonly {
        readonly seed: string;
        readonly purpose: "discovery" | "confirmation" | "regression";
      }[]
    | null;
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
  /**
   * The game's checked-in `reporting.githubIssues`. Carried here because the
   * operator's `issueReporting` grant above means nothing without it: before
   * this existed the config value was validated and read by no code path, so a
   * game that asked for review and an operator who granted it were
   * indistinguishable from a game that asked for nothing.
   */
  readonly configuredIssueReporting: "disabled" | "review";
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
    request: PlaytestLaunchRequest
  ): Promise<PlaytestRunStartReceipt>;
  lookupRunByRequest(
    session: PlaytestRunControlActor,
    workspaceId: string,
    requestId: string
  ): Promise<PlaytestRunRequestLookup>;
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
  /**
   * Prepare evidence packets over an explicit, bounded selection. The owner,
   * not any caller, decides eligibility, the per-batch critique cap, and which
   * selected sessions yielded packet-unavailable receipts, so the Console and
   * MCP tool cannot reach different answers about the same selection.
   */
  prepareCrossSessionReview(
    session: PlaytestRunControlActor,
    workspaceId: string,
    episodeIds: readonly string[]
  ): Promise<{
    readonly packets: readonly PlaytestCrossSessionPacket[];
    readonly receipts: readonly PlaytestCrossSessionReceipt[];
    readonly budget: readonly PlaytestCrossSessionBudget[];
  }>;
}

/** Process owner lifecycle used by Runtime shutdown; MCP clients do not implement it. */
export interface PlaytestRunOwner
  extends PlaytestRunControl, PlaytestAnalystReviewDispatch {
  shutdown(): Promise<void>;
}

export type PlaytestMcpServer = McpServer & {
  readonly playtestRunControl: PlaytestRunControl | null;
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
  getLatestDiscoveryReviewForEpisode(
    workspaceId: string,
    episodeId: string
  ): Promise<PlaytestDiscoverySessionReview | null>;
  insertDiscoveryReview(review: PlaytestDiscoverySessionReview): Promise<void>;
  insertCrossSessionSynthesis(
    synthesis: PlaytestCrossSessionSynthesis
  ): Promise<void>;
  getCrossSessionSynthesisForAnalysis(
    workspaceId: string,
    analysisId: string
  ): Promise<PlaytestCrossSessionSynthesis | null>;
  listCrossSessionSyntheses(
    workspaceId: string,
    listOptions?: { readonly cursor?: string; readonly limit?: number }
  ): Promise<{
    readonly rows: readonly PlaytestCrossSessionSynthesis[];
    readonly total: number;
    readonly nextCursor: string | null;
  }>;
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
  /** Durable Data owner; required at launch, omitted only for read-only test owners. */
  readonly launchIntentRepository?: PlaytestLaunchIntentRepository | undefined;
  readonly approvalRepository?: WorkspacePlaytestApprovalRepository | undefined;
  readonly visualTargetRepository?:
    WorkspaceVisualPlaytestTargetRepository | undefined;
  readonly runEpisodeHandler?: (
    options: PlaytestEpisodeRunOptions
  ) => Promise<PlaytestEpisodeRunResult>;
  readonly launchSandboxHandler?: (
    prepared: PreparedPlaytestSandbox,
    options?: PlaytestSandboxLaunchOptions
  ) => Promise<PlaytestSandboxHandle>;
  /** Resolves the approval's latest committed build and loads that commit's target files. */
  readonly prepareSandboxHandler?: (
    approval: WorkspacePlaytestApproval
  ) => PreparedPlaytestSandbox;
  /** Overridable for tests; defaults to the real canonical workspace catalog. */
  readonly readWorkspaceCatalog?: () => WorkspaceCatalogRead;
  readonly launchAnalystProcess?: PlaytestAnalystProcessLauncher;
  /** Opens the browser for one visual episode; overridable so the episode loop is testable. */
  readonly openVisualDriver?: PlaytestVisualDriverOpener;
  /**
   * Builds the policy one visual episode asks for its next action;
   * overridable so the episode loop is testable without a live router.
   */
  readonly createVisualPolicy?: PlaytestVisualPolicyFactory;
}

/** The visual policy surface the episode loop depends on. */
export type PlaytestVisualPolicy = Pick<
  SmartDirectVisualPolicy,
  "decide" | "usage"
>;

/** Builds the policy for one approved visual episode. */
export type PlaytestVisualPolicyFactory = (input: {
  readonly target: WorkspaceVisualPlaytestTargetApproval;
  readonly workspacePath: string;
}) => PlaytestVisualPolicy;

export interface PlaytestMcpOptions extends PlaytestRunControlOptions {
  readonly sessionProvider: PlaytestMcpSessionProvider;
  /**
   * Process-shared Runtime owner; the MCP facade never creates another
   * scheduler. Null only for the analyst, whose allowlisted packet/review tools
   * use the workspace-bound repository and do not call run control.
   */
  readonly playtestRunControl: PlaytestRunControl | null;
}

/** Explicit supported policy baselines. No generic scored/heuristic fallback. */
const RUNNER_ROLES = new Set(["playtester", "root", "orchestrator"]);
const REVIEWER_ROLE = "playtest-analyst" as const;
const PLAYTEST_ADAPTER_MODE = "adapter-accelerated" as const;

function requirePlaytestRunControl(
  control: PlaytestRunControl | null
): PlaytestRunControl {
  if (!control) {
    throw new PlaytestMcpUnavailableError(
      "The Runtime Playtesting run owner is unavailable to this MCP role."
    );
  }
  return control;
}
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
const ANALYST_DISPATCH_ROLES = new Set(["root", "operator"]);
const CROSS_SESSION_PACKET_READER_ROLES = new Set([
  "root",
  "orchestrator",
  "validator",
  "operator"
]);
const ANALYST_STATUS_READER_ROLES = new Set([
  ...ANALYSIS_READER_ROLES,
  "control-viewer"
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
const MAX_ACTIVE_ANALYST_RUNS = 4;
const MAX_RETAINED_ANALYST_RUNS = 64;
const CROSS_SESSION_PACKET_READ_CONCURRENCY = 4;
const ANALYST_REVIEW_RUN_COLLATOR = new Intl.Collator();
const MAX_FINDINGS_PER_REVIEW = 64;
const PLAYTEST_INFRASTRUCTURE_FAILURE_STATE = "infrastructure-failed" as const;
const MAX_REVIEW_PACKET_BYTES = 64 * 1024;
const REVIEW_PACKET_TOKEN_BUDGET = PLAYTESTS_EVIDENCE_PACKET_MAX_TOKENS;
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

async function readPersistedAnalystReviews(
  repository: PlaytestingRepositoryOps,
  run: PlaytestAnalystReviewRun
): Promise<readonly PlaytestAnalystReviewReceipt[]> {
  const reviews = await Promise.all(
    run.packets.map(async (packet) => {
      if (run.analysisKind === "discovery") {
        const review = await repository.getLatestDiscoveryReviewForEpisode(
          run.workspaceId,
          packet.episodeId
        );
        return review?.evidencePacket.packetId === packet.packetId
          ? {
              episodeId: packet.episodeId,
              reviewId: review.reviewId,
              status: review.status
            }
          : null;
      }
      const review = await repository.getLatestReviewForEpisode(
        run.workspaceId,
        packet.episodeId
      );
      return review?.evidencePacket?.packetId === packet.packetId
        ? {
            episodeId: packet.episodeId,
            reviewId: review.reviewId,
            status: review.status
          }
        : null;
    })
  );
  return reviews.filter(
    (review): review is PlaytestAnalystReviewReceipt => review !== null
  );
}

function analystReviewRunStatus(input: {
  readonly run: PlaytestAnalystReviewRun;
  readonly result: PlaytestAnalystProcessResult;
  readonly reviews: readonly PlaytestAnalystReviewReceipt[];
  readonly reviewReadFailed: boolean;
  readonly synthesisId: string | null;
  readonly synthesisReadFailed: boolean;
}): PlaytestAnalystReviewRun["status"] {
  const synthesisRequired =
    input.run.analysisKind !== "discovery" && input.run.packets.length >= 2;
  if (
    !input.reviewReadFailed &&
    !input.synthesisReadFailed &&
    input.reviews.length === input.run.packets.length &&
    (!synthesisRequired || input.synthesisId !== null) &&
    input.result.exitCode === 0 &&
    !input.result.launchFailed &&
    !input.result.timedOut
  ) {
    return "completed";
  }
  return input.reviews.length > 0 ? "partial" : "failed";
}

/** The analyst's own words, bounded, so a failure report can name the cause. */
function boundedAnalystDiagnostic(diagnostic: string): string {
  const collapsed = diagnostic.replaceAll(/\s+/gu, " ").trim();
  return collapsed.length > 600 ? `${collapsed.slice(0, 600)}…` : collapsed;
}

function analystReviewRunError(input: {
  readonly status: PlaytestAnalystReviewRun["status"];
  readonly run: PlaytestAnalystReviewRun;
  readonly result: PlaytestAnalystProcessResult;
  readonly reviews: readonly PlaytestAnalystReviewReceipt[];
  readonly reviewReadFailed: boolean;
  readonly synthesisId: string | null;
  readonly synthesisReadFailed: boolean;
}): string | null {
  if (input.status === "completed") return null;
  if (input.reviewReadFailed) {
    return "Runtime could not verify the persisted analyst reviews.";
  }
  if (input.synthesisReadFailed) {
    return "Runtime could not verify the persisted cross-session synthesis.";
  }
  if (input.run.packets.length >= 2 && input.synthesisId === null) {
    return "The analyst did not persist a packet-grounded cross-session synthesis.";
  }
  if (input.result.timedOut) {
    return "The analyst review exceeded its Runtime time limit.";
  }
  if (input.result.launchFailed) {
    return "The Runtime could not start the analyst process.";
  }
  if (input.result.exitCode !== 0) {
    const diagnostic = input.result.diagnostic?.trim();
    return `The analyst process ended without completing all reviews (exit ${String(input.result.exitCode)}${input.result.signal ? `, ${input.result.signal}` : ""}).${diagnostic ? ` The analyst reported: ${boundedAnalystDiagnostic(diagnostic)}` : ""}`;
  }
  const diagnostic = input.result.diagnostic?.trim();
  return `The analyst submitted ${String(input.reviews.length)} of ${String(input.run.packets.length)} selected reviews.${diagnostic ? ` The analyst reported: ${boundedAnalystDiagnostic(diagnostic)}` : ""}`;
}

interface ActivePlaytestRun {
  readonly batchId: string;
  readonly workspaceId: string;
  readonly buildSha: string;
  readonly ownerActor: string;
  readonly ownerTaskId: string | undefined;
  readonly ownerRunId: string | undefined;
  readonly assignmentCount: number;
  readonly assignmentIds: readonly string[];
  readonly sessions: readonly PlaytestSessionReference[];
  readonly reservedWorkers: number;
  readonly manifestHash: string;
  readonly createdAt: string;
  readonly outcomes: Map<string, PlaytestRunAssignmentOutcome>;
  readonly controller: AbortController;
  phase: "running" | "persisting";
  reason: PlaytestBatchCancellationReason | null;
  /** Every in-flight assignment sandbox; cancellation reaches all of them. */
  readonly sandboxes: Set<PlaytestSandboxHandle>;
  readonly completion: Promise<PlaytestRunStatus>;
  readonly resolveCompletion: (status: PlaytestRunStatus) => void;
}

interface ActiveAnalystReviewRun {
  readonly process: PlaytestAnalystProcess;
}

type RunCancellationReason = PlaytestBatchCancellationReason;

function isReviewerRole(role: string): role is typeof REVIEWER_ROLE {
  return role === REVIEWER_ROLE;
}

function assertAnalystEpisodeSelected(
  session: PlaytestMcpSession,
  episodeId: string,
  toolName: string
): void {
  if (!isReviewerRole(session.role)) return;
  if (!session.selectedEpisodeIds?.includes(episodeId)) {
    throw new PlaytestMcpAuthorizationError(
      `${toolName} is limited to the sessions selected by Runtime for this analyst task.`
    );
  }
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
      !SAFE_SESSION_VALUE_PATTERN.test(session.runId)) ||
    (session.analysisId !== undefined &&
      !SAFE_SESSION_VALUE_PATTERN.test(session.analysisId))
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

const crossSessionEvidenceRefSchema = z.strictObject({
  episodeId: z.string().min(1).max(256),
  packetId: z.string().min(1).max(128),
  locator: evidenceLocatorSchema
});

const crossSessionClaimSchema = z.strictObject({
  kind: z.enum(["pattern", "counterexample", "confounder"]),
  text: z.string().min(1).max(8000),
  evidenceRefs: z.array(crossSessionEvidenceRefSchema).min(1).max(64)
});

const crossSessionExperimentSchema = z.strictObject({
  hypothesis: z.string().min(1).max(4000),
  falsifier: z.string().min(1).max(4000),
  metricId: z.string().min(1).max(256),
  controls: z.array(z.string().min(1).max(4000)).min(1).max(16),
  budget: z.string().min(1).max(4000),
  evidenceRefs: z.array(crossSessionEvidenceRefSchema).min(1).max(64)
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

function playtestEvidenceLocatorFromInput(
  locator: z.infer<typeof evidenceLocatorSchema>
): PlaytestEvidenceLocator {
  return {
    kind: locator.kind,
    id: locator.id,
    ...(locator.step === undefined ? {} : { step: locator.step }),
    ...(locator.revision === undefined ? {} : { revision: locator.revision }),
    ...(locator.frameIndex === undefined
      ? {}
      : { frameIndex: locator.frameIndex }),
    ...(locator.phaseId === undefined ? {} : { phaseId: locator.phaseId })
  };
}

const reviewExperimentSchema = z.strictObject({
  hypothesis: z.string().min(1).max(4000),
  falsifier: z.string().min(1).max(4000),
  metricId: z.string().min(1).max(256),
  controls: z.array(z.string().min(1).max(1000)).min(1).max(32),
  budget: z.string().min(1).max(1000)
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
const crossSessionSynthesisLocks = new Map<string, Promise<void>>();

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
  batch: PlaytestAdapterBatch,
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
  batch: PlaytestAdapterBatch,
  receipt: PlaytestReviewReceiptInput,
  repository: PlaytestingRepositoryOps
): Promise<PlaytestAdapterBatch> {
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
  const updated: PlaytestAdapterBatch = {
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
  batch: PlaytestAdapterBatch,
  reviewId: string,
  repository: PlaytestingRepositoryOps
): Promise<PlaytestAdapterBatch> {
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
  const updated: PlaytestAdapterBatch = {
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
  prepared: PreparedPlaytestSandbox,
  runtimeVersion: string
): string {
  return createHash("sha256")
    .update(
      canonicalPlaytestJson({
        buildSha: prepared.build.buildSha,
        configHash: prepared.build.configHash,
        adapterImageDigest: prepared.imageDigest,
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
  readonly manifest: PlaytestAdapterAssignmentManifest;
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
  readonly manifest: PlaytestAdapterAssignmentManifest;
  readonly prepared: PreparedPlaytestSandbox;
  readonly plan: readonly PlaytestCoveragePlanCell[];
  readonly episodes: readonly PlaytestEpisode[];
  readonly generatedAt: string;
}): PlaytestCoverageManifest {
  const episodes: PlaytestCoverageEpisode[] = input.episodes.map(
    coverageEpisodeProjection
  );
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
    episodes
  });
}

/** Confirmatory batch coverage consumes adapter identity only. */
function coverageEpisodeProjection(
  episode: PlaytestEpisode
): PlaytestCoverageEpisode {
  assertPlaytestAdapterEpisode(episode);
  const identity = episode.identity;
  if (
    episode.executionProvenance.mode !== PLAYTEST_ADAPTER_MODE ||
    identity.buildSha === null ||
    identity.scenarioId === null ||
    identity.seed === null
  ) {
    throw new PlaytestMcpUnavailableError(
      "Adapter coverage cannot include a visual or source-unknown episode."
    );
  }
  return {
    episodeId: episode.episodeId,
    batchId: episode.batchId,
    assignmentId: episode.assignmentId,
    identity: {
      workspaceId: identity.workspaceId,
      buildSha: identity.buildSha,
      scenarioId: identity.scenarioId,
      policyId: identity.policyId,
      policyVersion: identity.policyVersion,
      seed: identity.seed
    },
    scenarioFamily: episode.scenarioFamily,
    policyCohort: episode.policyCohort,
    metrics: episode.metrics
  };
}

function batchRecordFor(input: {
  readonly manifest: PlaytestAdapterAssignmentManifest;
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
    executionMode: "adapter-accelerated",
    batchId: manifest.batchId,
    revision: input.revision,
    workspaceId: approval.workspaceId,
    repository: approval.workspaceId,
    buildSha: manifest.buildSha,
    gameBuild: input.capabilities?.engineBuild ?? prepared.build.gameBuild,
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
  batch: PlaytestAdapterBatch,
  manifest: PlaytestAdapterAssignmentManifest
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
  readonly batch: PlaytestAdapterBatch;
  readonly assignment: PlaytestBatchAssignment;
  readonly episode: PlaytestEpisode;
  readonly episodeByAssignment: ReadonlyMap<string, PlaytestEpisode>;
}): void {
  const { batch, assignment, episode, episodeByAssignment } = input;
  const identity = episode.identity;
  if (
    episode.executionProvenance.mode !== PLAYTEST_ADAPTER_MODE ||
    identity.buildSha === null ||
    identity.configHash === null ||
    identity.scenarioId === null ||
    identity.seed === null ||
    episode.assignmentId !== assignment.assignmentId ||
    episode.batchId !== batch.batchId ||
    identity.workspaceId !== batch.workspaceId ||
    identity.buildSha !== batch.buildSha ||
    identity.configHash !== batch.configHash ||
    identity.scenarioId !== assignment.scenarioId ||
    identity.policyId !== assignment.policyId ||
    identity.policyVersion !== assignment.policyVersion ||
    identity.seed !== assignment.seed ||
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
}): PlaytestRunAssignmentOutcome {
  const { assignment, episode, unobserved } = input;
  if (episode && unobserved) {
    throw new PlaytestMcpUnavailableError(
      "A batch assignment has both an episode and a no-episode outcome."
    );
  }
  if (unobserved) return { ...unobserved, gameOutcome: null };
  if (!episode) {
    return {
      assignmentId: assignment.assignmentId,
      episodeId: null,
      state: PLAYTEST_INFRASTRUCTURE_FAILURE_STATE,
      started: false,
      eligible: false,
      gameOutcome: null
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
    eligible: state === "completed" && episode.completionCounts.eligible === 1,
    gameOutcome: episode.outcome
  };
}

function assignmentOutcomesFromPersistedBatch(
  batch: PlaytestAdapterBatch,
  episodes: readonly PlaytestEpisode[]
): readonly PlaytestRunAssignmentOutcome[] {
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
  batch: PlaytestAdapterBatch,
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
    episodes: episodes.map(coverageEpisodeProjection)
  });
}

function batchRunResult(
  batch: PlaytestBatch,
  outcomes: readonly PlaytestRunAssignmentOutcome[],
  counts: PlaytestCompletionCounts,
  reviewSelection: PlaytestBatchReviewSelection,
  cancellation: PlaytestBatchCancellationReason | null
): unknown {
  return {
    batchId: batch.batchId,
    assignmentCount: batch.budget.assignedEpisodes,
    manifestHash:
      batch.assignmentInventory.status === "frozen" ||
      batch.assignmentInventory.status === "frozen-visual"
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
  readonly batch: PlaytestAdapterBatch;
  readonly outcomes: readonly PlaytestRunAssignmentOutcome[];
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
    unobservedAssignments: unobservedAssignmentOutcomes(outcomes),
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

function playerDebriefForInterruptedVisualEpisode(
  report: PlaytestPlayerDebriefV1
): PlaytestPlayerDebriefV1 {
  if (report.status === "partial") {
    return { ...report, reason: "episode-interrupted" };
  }
  if (report.status === "unavailable") return report;
  return {
    schema: PLAYTEST_PLAYER_DEBRIEF_SCHEMA,
    status: "unavailable",
    reason: "interrupted-before-checkpoint"
  };
}

function recoveredVisualAssignmentOutcome(
  assignment: PlaytestVisualBatchAssignment,
  episode: PlaytestEpisode | null,
  cancellationRequested: boolean
): PlaytestRunAssignmentOutcome {
  if (!episode) {
    return {
      assignmentId: assignment.assignmentId,
      state: cancellationRequested ? "cancelled" : "infrastructure-failed",
      episodeId: null,
      started: false,
      eligible: false,
      gameOutcome: null
    };
  }
  const state: PlaytestAssignmentTerminalState =
    episode.status === "completed"
      ? "completed"
      : episode.status === "crashed"
        ? "crashed"
        : episode.status === "cancelled"
          ? "cancelled"
          : episode.status === "budget-truncated"
            ? "budget-truncated"
            : "infrastructure-failed";
  return {
    assignmentId: assignment.assignmentId,
    state,
    episodeId: episode.episodeId,
    started: episode.startedAt !== null,
    eligible: false,
    gameOutcome: episode.outcome
  };
}

async function recoverInterruptedVisualBatch(input: {
  readonly repository: PlaytestingRepositoryOps;
  readonly batch: PlaytestVisualBatch;
  readonly episodes: readonly PlaytestEpisode[];
}): Promise<PlaytestRunStatus> {
  const { repository, batch } = input;
  const cancellationRequested = batch.cancellationReason !== null;
  const episodeByAssignment = new Map(
    input.episodes
      .filter((episode) => episode.assignmentId !== null)
      .map((episode) => [episode.assignmentId!, episode])
  );
  const completedAt = new Date().toISOString();

  const assignments = batch.assignmentInventory.manifest.assignments;
  const recoveredEpisodes = await mapConcurrentOrdered(
    assignments,
    4,
    async (assignment) => {
      const episode = episodeByAssignment.get(assignment.assignmentId);
      if (
        !episode ||
        (episode.status !== "assigned" && episode.status !== "started")
      ) {
        return null;
      }
      const recoveredEpisode: PlaytestEpisode = {
        ...episode,
        revision: episode.revision + 1,
        status: cancellationRequested ? "cancelled" : "infrastructure-failed",
        termination: {
          reason: cancellationRequested ? "cancelled" : "runtime-failure",
          step: episode.stepCount === 0 ? null : episode.stepCount - 1
        },
        completionCounts: visualCompletionCounts(
          cancellationRequested ? "cancelled" : "infrastructure-failed",
          episode.startedAt !== null
        ),
        completedAt,
        completeness: episode.stepCount === 0 ? "unknown" : "partial",
        missingReasons: [
          ...new Set<PlaytestMissingReason>([
            ...episode.missingReasons,
            cancellationRequested ? "cancelled" : "infrastructure-failed"
          ])
        ],
        playerDebrief: playerDebriefForInterruptedVisualEpisode(
          episode.playerDebrief
        )
      };
      await repository.insertEpisode(recoveredEpisode);
      return recoveredEpisode;
    }
  );
  for (const [index, recoveredEpisode] of recoveredEpisodes.entries()) {
    if (recoveredEpisode !== null) {
      episodeByAssignment.set(
        assignments[index]!.assignmentId,
        recoveredEpisode
      );
    }
  }

  const outcomes = batch.assignmentInventory.manifest.assignments.map(
    (assignment) =>
      recoveredVisualAssignmentOutcome(
        assignment,
        episodeByAssignment.get(assignment.assignmentId) ?? null,
        cancellationRequested
      )
  );
  const counts = playtestBatchCountsFromAssignments({
    assignmentCount: batch.budget.assignedEpisodes,
    outcomes,
    reviewed: 0
  });
  const recovered: PlaytestVisualBatch = {
    ...batch,
    revision: batch.revision + 1,
    status: playtestBatchTerminalState({
      assignmentCount: batch.budget.assignedEpisodes,
      outcomes,
      cancelled: cancellationRequested,
      aborted: !cancellationRequested
    }),
    counts,
    reviewSelection: {
      status: "unavailable",
      reason: "visual-discovery-session-level"
    },
    unobservedAssignments: unobservedAssignmentOutcomes(outcomes),
    failureReason: cancellationRequested ? null : "nonterminal-batch-recovered",
    completedAt
  };
  await repository.insertBatch(recovered);
  return {
    batchId: recovered.batchId,
    status: cancellationRequested ? "cancelled" : "failed",
    cancellationReason: recovered.cancellationReason,
    result: batchRunResult(
      recovered,
      outcomes,
      counts,
      recovered.reviewSelection,
      recovered.cancellationReason
    ),
    error: cancellationRequested
      ? null
      : {
          code: "playtest_run_interrupted",
          category: "execution",
          retryable: false,
          message:
            "The Runtime ended without persisting a terminal visual batch state; any captured checkpoints remain explicitly partial or unavailable."
        }
  };
}

function completedBatchRunStatus(input: {
  readonly batch: PlaytestAdapterBatch;
  readonly outcomes: readonly PlaytestRunAssignmentOutcome[];
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
  if (
    batch.executionMode === "autonomous-visual" &&
    batch.assignmentInventory.status === "frozen-visual"
  ) {
    const episodes = await persistedEpisodesForBatch(repository, batch);
    if (batch.status === "running" || batch.status === "queued") {
      return recoverInterruptedVisualBatch({ repository, batch, episodes });
    }
    const episodeByAssignment = new Map(
      episodes
        .filter((ep) => ep.assignmentId !== null)
        .map((ep) => [ep.assignmentId!, ep])
    );
    const outcomes: PlaytestRunAssignmentOutcome[] =
      batch.assignmentInventory.manifest.assignments.map((assignment) => {
        const episode = episodeByAssignment.get(assignment.assignmentId);
        if (!episode) {
          return {
            assignmentId: assignment.assignmentId,
            state: "infrastructure-failed",
            episodeId: null,
            started: false,
            eligible: false,
            gameOutcome: null
          };
        }
        return {
          assignmentId: assignment.assignmentId,
          state:
            episode.status === "completed"
              ? "completed"
              : episode.status === "crashed"
                ? "crashed"
                : "infrastructure-failed",
          episodeId: episode.episodeId,
          started: true,
          eligible: true,
          gameOutcome: episode.outcome
        };
      });
    const status =
      batch.status === "cancelled"
        ? "cancelled"
        : batch.status === "completed"
          ? "completed"
          : "failed";
    return {
      batchId: batch.batchId,
      status,
      cancellationReason: batch.cancellationReason,
      result: batchRunResult(
        batch,
        outcomes,
        batch.counts,
        batch.reviewSelection,
        batch.cancellationReason
      ),
      error: null
    };
  }
  if (
    batch.executionMode !== PLAYTEST_ADAPTER_MODE ||
    batch.assignmentInventory.status !== "frozen"
  ) {
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
  readonly outcomes: readonly PlaytestRunAssignmentOutcome[];
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

const LAUNCH_INTENT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const LAUNCH_INTENT_REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/u;

function launchIntentHash(request: PlaytestLaunchRequest): string {
  const { requestId: _requestId, ...immutablePayload } = request;
  return createHash("sha256")
    .update(canonicalPlaytestJson(immutablePayload))
    .digest("hex");
}

function batchAssignmentIds(batch: PlaytestBatch): readonly string[] {
  if (batch.assignmentInventory.status === "frozen") {
    return batch.assignmentInventory.manifest.assignments.map(
      (assignment) => assignment.assignmentId
    );
  }
  if (batch.assignmentInventory.status === "frozen-visual") {
    return batch.assignmentInventory.manifest.assignments.map(
      (assignment) => assignment.assignmentId
    );
  }
  return [];
}

function sessionReferencesForAssignments(
  mode: "adapter-accelerated" | "autonomous-visual",
  batchId: string,
  assignmentIds: readonly string[]
): readonly PlaytestSessionReference[] {
  return assignmentIds.map((assignmentId) => ({
    assignmentId,
    episodeId:
      mode === "autonomous-visual"
        ? playtestVisualEpisodeRecordId(batchId, assignmentId)
        : playtestEpisodeRecordId(batchId, assignmentId)
  }));
}

function sessionReferencesForBatch(
  batch: PlaytestBatch
): readonly PlaytestSessionReference[] {
  if (batch.assignmentInventory.status === "unavailable") return [];
  return sessionReferencesForAssignments(
    batch.executionMode,
    batch.batchId,
    batch.assignmentInventory.manifest.assignments.map(
      (assignment) => assignment.assignmentId
    )
  );
}

function startReceiptForActiveRun(
  run: ActivePlaytestRun
): PlaytestRunStartReceipt {
  return {
    batchId: run.batchId,
    assignmentCount: run.assignmentCount,
    assignmentIds: run.assignmentIds,
    sessions: run.sessions,
    createdAt: run.createdAt,
    status: run.phase
  };
}

async function startReceiptForPersistedBatch(input: {
  readonly repository: PlaytestingRepositoryOps;
  readonly workspaceId: string;
  readonly batch: PlaytestBatch;
  readonly activeRun: ActivePlaytestRun | undefined;
  readonly locks: Map<string, Promise<void>>;
}): Promise<PlaytestRunStartReceipt> {
  const assignmentIds = batchAssignmentIds(input.batch);
  const sessions = sessionReferencesForBatch(input.batch);
  if (
    input.batch.workspaceId !== input.workspaceId ||
    assignmentIds.length !== input.batch.budget.assignedEpisodes ||
    sessions.length !== assignmentIds.length
  ) {
    throw new PlaytestMcpUnavailableError(
      "The persisted launch receipt does not match its frozen batch."
    );
  }
  const status = input.activeRun
    ? activeRunStatus(input.activeRun)
    : await readStoredRunStatus(
        input.repository,
        input.workspaceId,
        input.batch.batchId,
        input.locks
      );
  return {
    batchId: input.batch.batchId,
    assignmentCount: input.batch.budget.assignedEpisodes,
    assignmentIds,
    sessions,
    createdAt: input.batch.createdAt,
    status: status.status
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
  readonly request: PlaytestAdapterBranchOperation;
  readonly workspaceId: string;
  readonly approval: WorkspacePlaytestApproval;
  readonly prepared: PreparedPlaytestSandbox;
  readonly repository: PlaytestingRepositoryOps;
  readonly artifacts: PlaytestArtifactStore;
}): Promise<{
  readonly assignments: readonly PlaytestLaunchAssignment[];
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
  const parentIdentity = parent.identity;
  if (
    parent.status !== "completed" ||
    parent.completeness !== "complete" ||
    parent.trace?.kind !== "replay-segment" ||
    (parent.replayStatus !== "trace-replayable" &&
      parent.replayStatus !== "verified") ||
    parent.executionProvenance.mode !== PLAYTEST_ADAPTER_MODE ||
    parentIdentity.workspaceId !== workspaceId ||
    parentIdentity.buildSha === null ||
    parentIdentity.configHash === null ||
    parentIdentity.gameBuild === null ||
    parentIdentity.scenarioId === null ||
    parentIdentity.seed === null ||
    parentIdentity.buildSha.toLowerCase() !== prepared.build.buildSha ||
    parentIdentity.configHash !== prepared.build.configHash ||
    parentIdentity.gameBuild !== prepared.build.gameBuild ||
    request.branchStep >= parent.stepCount
  ) {
    throw new PlaytestMcpValidationError(
      "The source episode is incomplete, non-replayable, outside the latest committed build/config, or has no decision at that step."
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
    parentIdentity.rngAlgorithm !== parentCheckpoint.rngCheckpoint.algorithm ||
    parentIdentity.rngVersion !== parentCheckpoint.rngCheckpoint.version
  ) {
    throw new PlaytestMcpValidationError(
      "The source decision does not have reproducible, version-matched RNG evidence."
    );
  }
  if (
    !prepared.configuration.scenarios.includes(parentIdentity.scenarioId) ||
    !approval.allowedScenarios.includes(parentIdentity.scenarioId)
  ) {
    throw new PlaytestMcpValidationError(
      "The source episode scenario is no longer part of the exact approved configuration."
    );
  }
  const policy = request.policy ?? parentIdentity.policyId;
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
        scenario: parentIdentity.scenarioId,
        policy,
        seed: parentIdentity.seed,
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
  readonly assignments: readonly PlaytestLaunchAssignment[];
  readonly branchPlan: BranchExecutionPlan | null;
  readonly batchId: string;
  readonly createdAt?: string;
}): ApprovedBatchContext {
  const { workspaceId, approval, prepared, assignments, branchPlan, batchId } =
    input;
  if (
    prepared.workspaceId !== workspaceId ||
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
      policies.set(
        request.policy,
        resolvePolicy(request.policy, prepared.benchmark)
      );
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
    mode: PLAYTEST_ADAPTER_MODE,
    batchId,
    workspaceId,
    buildSha: prepared.build.buildSha,
    configHash: prepared.build.configHash,
    rubricHash: prepared.rubricHash,
    approvalRevision: approval.revision,
    createdAt: input.createdAt ?? new Date().toISOString(),
    assignments: resolved
  } as const;
  const manifest: PlaytestAdapterAssignmentManifest = {
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
    prepared.build.buildSha,
    assignmentLimit
  );
  const reservations = [...activeRuns.values()].filter(
    (run) =>
      run.workspaceId === workspaceId &&
      run.buildSha === prepared.build.buildSha
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
}): PlaytestRunAssignmentOutcome {
  if (input.episode) {
    return {
      assignmentId: input.assignment.assignmentId,
      episodeId: input.episode.episodeId,
      state: input.episode.status as PlaytestAssignmentTerminalState,
      started: input.episode.startedAt !== null,
      eligible: input.episode.completionCounts.eligible === 1,
      gameOutcome: input.episode.outcome
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
    eligible: false,
    gameOutcome: null
  };
}

/** Keep the live response projection out of the durable batch schema. */
function unobservedAssignmentOutcomes(
  outcomes: readonly PlaytestRunAssignmentOutcome[]
): readonly PlaytestAssignmentOutcome[] {
  return outcomes
    .filter((outcome) => outcome.episodeId === null)
    .map(({ assignmentId, episodeId, state, started, eligible }) => ({
      assignmentId,
      episodeId,
      state,
      started,
      eligible
    }));
}

function assertEpisodeMatchesAssignment(input: {
  readonly episode: PlaytestEpisode;
  readonly approval: WorkspacePlaytestApproval;
  readonly build: WorkspacePlaytestBuild;
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
  if (
    episode.executionProvenance.mode !== PLAYTEST_ADAPTER_MODE ||
    identity.repository === null ||
    identity.buildSha === null ||
    identity.gameBuild === null ||
    identity.scenarioId === null ||
    identity.configHash === null ||
    identity.seed === null ||
    identity.protocolVersion !== 1 ||
    identity.observationSchemaHash === null ||
    identity.actionSchemaHash === null ||
    identity.eventSchemaHash === null
  ) {
    throw new PlaytestMcpValidationError(
      "Adapter assignments require exact build, scenario, seed, and protocol identity."
    );
  }
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
    identity.buildSha !== input.build.buildSha ||
    identity.configHash !== input.build.configHash ||
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
  readonly requestedBatchId: string;
  readonly createdAt: string;
  readonly assignments: readonly PlaytestLaunchAssignment[];
  readonly branchPlan: BranchExecutionPlan | null;
  /** The latest committed build, resolved and snapshotted once for this batch. */
  readonly prepared: PreparedPlaytestSandbox;
  readonly artifacts: PlaytestArtifactStore;
  readonly repository: PlaytestingRepositoryOps;
  readonly approvalRepository: WorkspacePlaytestApprovalRepository;
  readonly readWorkspaceCatalog: () => WorkspaceCatalogRead;
  readonly launchSandbox: (
    prepared: PreparedPlaytestSandbox,
    options?: PlaytestSandboxLaunchOptions
  ) => Promise<PlaytestSandboxHandle>;
  readonly runEpisode: (
    options: PlaytestEpisodeRunOptions
  ) => Promise<PlaytestEpisodeRunResult>;
  readonly activeRuns: Map<string, ActivePlaytestRun>;
  readonly assignmentLocks: Map<string, Promise<void>>;
  readonly onRegistered: (
    batchId: string,
    createdAt: string,
    assignmentIds: readonly string[],
    sessions: readonly PlaytestSessionReference[]
  ) => void;
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
    context.prepared,
    runtimeVersion
  );
  return input.runEpisode({
    approval: input.approval,
    build: context.prepared.build,
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
}): Promise<PlaytestRunAssignmentOutcome> {
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
    build: context.prepared.build,
    batchId: context.manifest.batchId,
    assignment,
    policy,
    environmentHash: playtestEnvironmentHash(context.prepared, RUNTIME_VERSION),
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
  const batchId = input.requestedBatchId;
  const prepared = input.prepared;
  const context = prepareApprovedBatch({
    workspaceId: input.workspaceId,
    approval: input.approval,
    prepared,
    assignments: input.assignments,
    branchPlan: input.branchPlan,
    batchId,
    createdAt: input.createdAt
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
    buildSha: context.prepared.build.buildSha,
    ownerActor: input.session.actor,
    ownerTaskId: input.session.taskId,
    ownerRunId: input.session.runId,
    assignmentCount: context.assignments.length,
    assignmentIds: context.assignments.map(
      (assignment) => assignment.assignmentId
    ),
    sessions: sessionReferencesForAssignments(
      "adapter-accelerated",
      batchId,
      context.assignments.map((assignment) => assignment.assignmentId)
    ),
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
  input.onRegistered(
    batchId,
    activeRun.createdAt,
    activeRun.assignmentIds,
    activeRun.sessions
  );
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
const PACKET_OBSERVATION_EQUIVALENCE_UNVERIFIED_REASON =
  "observation-equivalence-unverified" as const;
const OBSERVATION_EQUIVALENCE_UNVERIFIED_DETAIL =
  "Player-visible analyst review is withheld because the game's " +
  "observation/UI equivalence is unverified for this episode's trace; " +
  "the step is recorded without being projected into player-visible evidence.";
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
    if (entry.observationVisibility === "unverified") {
      throw new ReviewPacketPreparationError(
        PACKET_OBSERVATION_EQUIVALENCE_UNVERIFIED_REASON,
        OBSERVATION_EQUIVALENCE_UNVERIFIED_DETAIL
      );
    }
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
    executionProvenance: episode?.executionProvenance ?? null,
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
    input.workspaceId + "\0" + input.prepared.build.buildSha,
    () => registerApprovedBatch(input)
  );
  const { activeRun } = context;
  const concurrency = context.activeRun.reservedWorkers;
  const outcomes: PlaytestRunAssignmentOutcome[] = [];
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
      unobservedAssignments: unobservedAssignmentOutcomes(outcomes),
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
            unobservedAssignments:
              unobservedAssignmentOutcomes(terminalOutcomes),
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

/**
 * Refuse (never clamp) a visual launch that requests any limit above the
 * approved target's own ceiling. Admission must fail closed: a caller that
 * wants a smaller run can just ask for one, but nothing here silently
 * substitutes the approved limit for a larger requested one.
 */
export function assertVisualLaunchLimitsWithinApprovedTarget(
  requested: WorkspaceVisualPlaytestLimits,
  approved: WorkspaceVisualPlaytestLimits
): void {
  const fields: readonly (keyof WorkspaceVisualPlaytestLimits)[] = [
    "episodeCount",
    "maxStepsPerEpisode",
    "wallTimeMs",
    "smartRequestsPerEpisode",
    "smartTokensPerEpisode",
    "screenshotCountPerEpisode",
    "artifactBytesPerEpisode"
  ];
  for (const field of fields) {
    if (requested[field] > approved[field]) {
      throw new PlaytestMcpValidationError(
        'Requested limit "' +
          field +
          '" (' +
          String(requested[field]) +
          ") exceeds the approved target's limit (" +
          String(approved[field]) +
          ")."
      );
    }
  }
}

interface ExecuteVisualBatchInput {
  readonly session: PlaytestMcpSession;
  readonly workspaceId: string;
  readonly target: WorkspaceVisualPlaytestTargetApproval;
  readonly request: Extract<
    PlaytestLaunchRequest,
    { mode: "autonomous-visual" }
  >;
  readonly requestedBatchId: string;
  readonly createdAt: string;
  readonly artifacts: PlaytestArtifactStore;
  readonly repository: PlaytestingRepositoryOps;
  readonly visualTargetRepository: WorkspaceVisualPlaytestTargetRepository;
  readonly readWorkspaceCatalog: () => WorkspaceCatalogRead;
  readonly activeRuns: Map<string, ActivePlaytestRun>;
  readonly assignmentLocks: Map<string, Promise<void>>;
  readonly openVisualDriver: PlaytestVisualDriverOpener;
  readonly createVisualPolicy: PlaytestVisualPolicyFactory;
  readonly onRegistered: (
    batchId: string,
    createdAt: string,
    assignmentIds: readonly string[],
    sessions: readonly PlaytestSessionReference[]
  ) => void;
}

/**
 * The approved per-episode usage budget of the decision policy ran out before
 * the step cap. The episode is budget-truncated, but it did not reach the step
 * limit, and recording it as one tells the operator and the analyst that a cap
 * they chose was reached when it was not.
 */
const USAGE_BUDGET = "usage-budget" as const;

/** Visual-session loop exit signal; mapped to a Core termination/status pair. */
type VisualEpisodeExit =
  | { readonly kind: "cancelled"; readonly step: number | null }
  | { readonly kind: "step-limit"; readonly step: number | null }
  | { readonly kind: typeof USAGE_BUDGET; readonly step: number | null }
  | { readonly kind: "loop-guard"; readonly step: number | null }
  | { readonly kind: "policy-stop"; readonly step: number | null }
  | {
      readonly kind: "driver-blocked";
      readonly reason: PlaytestVisualObservationBlockReason;
      readonly step: number | null;
    }
  | {
      readonly kind: "action-refused";
      readonly reason: string;
      readonly step: number | null;
    }
  | {
      readonly kind: "wall-time-limit";
      readonly step: number | null;
    }
  | {
      readonly kind: "infrastructure-failure";
      readonly code: string;
      readonly step: number | null;
    };

function playerEvidenceReferenceForStep(
  step: number,
  capturedFrames: readonly PlaytestArtifactReference[]
): PlaytestPlayerEvidenceReference | null {
  const frame = capturedFrames[step];
  if (!frame) return null;
  return {
    kind: "frame",
    id: frame.artifactId,
    step,
    frameIndex: step
  };
}

function playerDebriefSource(modelId: string | null) {
  if (modelId === null) return null;
  return {
    authorRole: "player" as const,
    policyId: "smart-direct" as const,
    policyVersion: SMART_DIRECT_POLICY_VERSION,
    modelId,
    modelVersion: null
  };
}

function playerDebriefCheckpoint(
  step: number,
  decision: {
    readonly modelId: string | null;
    readonly intention: string;
    readonly predictedVisibleEffect: string;
  },
  capturedFrames: readonly PlaytestArtifactReference[]
): PlaytestPlayerDebriefV1 {
  const source = playerDebriefSource(decision.modelId);
  if (source === null) {
    return {
      schema: PLAYTEST_PLAYER_DEBRIEF_SCHEMA,
      status: "unavailable",
      reason: "model-response-invalid"
    };
  }
  const evidence = playerEvidenceReferenceForStep(step, capturedFrames);
  if (evidence === null) {
    return {
      schema: PLAYTEST_PLAYER_DEBRIEF_SCHEMA,
      status: "unavailable",
      reason: "model-response-invalid"
    };
  }
  return {
    schema: PLAYTEST_PLAYER_DEBRIEF_SCHEMA,
    status: "partial",
    reason: "checkpoint-only",
    source,
    checkpoint: {
      schema: "autodev-playtest-player-checkpoint-v1",
      intention: decision.intention,
      predictedVisibleEffect: decision.predictedVisibleEffect,
      evidence
    }
  };
}

function completePlayerDebrief(input: {
  readonly requestedFocus: string | null;
  readonly traceSteps: readonly PlaytestEvidenceTraceStep[];
  readonly capturedFrames: readonly PlaytestArtifactReference[];
  readonly decision: Extract<
    Awaited<ReturnType<SmartDirectVisualPolicy["decide"]>>,
    { readonly status: "stop" }
  >;
}): PlaytestPlayerDebriefV1 {
  const source = playerDebriefSource(input.decision.modelId);
  if (source === null) {
    return {
      schema: PLAYTEST_PLAYER_DEBRIEF_SCHEMA,
      status: "unavailable",
      reason: "model-response-invalid"
    };
  }
  const evidence = input.decision.focusReport.evidenceSteps.map((step) => {
    const recordedStep = input.traceSteps.find((entry) => entry.step === step);
    const frameRef = recordedStep?.frameRefs.find(
      (reference) => reference.kind === "frame"
    );
    const frameIndex = input.capturedFrames.findIndex(
      (frame) => frame.artifactId === frameRef?.id
    );
    if (frameRef === undefined || frameIndex === -1) return null;
    return {
      kind: "frame" as const,
      id: frameRef.id,
      step,
      frameIndex
    };
  });
  if (evidence.includes(null)) {
    return {
      schema: PLAYTEST_PLAYER_DEBRIEF_SCHEMA,
      status: "unavailable",
      reason: "model-response-invalid"
    };
  }
  return {
    schema: PLAYTEST_PLAYER_DEBRIEF_SCHEMA,
    status: "complete",
    source,
    focusInterpretation: {
      schema: "autodev-playtest-focus-interpretation-v1",
      requestedFocus: input.requestedFocus,
      objective: input.decision.focusReport.objective,
      inScope: input.decision.focusReport.inScope,
      forbiddenScope: input.decision.focusReport.forbiddenScope,
      stopCriteria: input.decision.focusReport.stopCriteria,
      outcome: input.decision.focusReport.outcome,
      assessmentSource: "smart-direct-self-report",
      evidence: evidence.filter(
        (reference): reference is PlaytestPlayerEvidenceReference =>
          reference !== null
      )
    },
    summary: input.decision.focusReport.summary
  };
}

function playerDebriefAfterExit(
  current: PlaytestPlayerDebriefV1,
  exit: VisualEpisodeExit
): PlaytestPlayerDebriefV1 {
  if (
    current.status === "complete" ||
    current.status === "not-applicable" ||
    current.status === "absent" ||
    current.status === "unavailable"
  ) {
    return current;
  }
  if (current.status === "partial") {
    const reason: Extract<
      PlaytestPlayerDebriefV1,
      { readonly status: "partial" }
    >["reason"] =
      exit.kind === "action-refused"
        ? "action-refused"
        : exit.kind === "step-limit" ||
            exit.kind === USAGE_BUDGET ||
            exit.kind === "loop-guard" ||
            exit.kind === "wall-time-limit" ||
            (exit.kind === "driver-blocked" &&
              VISUAL_BUDGET_BLOCK_REASONS.has(exit.reason))
          ? "budget-truncated"
          : "episode-interrupted";
    return { ...current, reason };
  }
  return {
    schema: PLAYTEST_PLAYER_DEBRIEF_SCHEMA,
    status: "unavailable",
    reason: "interrupted-before-checkpoint"
  };
}

/** Driver-observed budgets that exhaust like a step cap, not a safety stop. */
const VISUAL_BUDGET_BLOCK_REASONS =
  new Set<PlaytestVisualObservationBlockReason>([
    "capture-budget-exhausted",
    "event-budget-exhausted",
    "wall-time-limit"
  ]);

/**
 * Map an actual visual-session exit to the Core-owned termination reason and
 * execution state. Every branch names a value from
 * PLAYTESTS_EPISODE_TERMINATION_REASONS; nothing here fabricates a
 * game-verified outcome the driver never observed, so \"game-terminal\" is
 * never produced by a URL-only visual session.
 */
function visualEpisodeDisposition(exit: VisualEpisodeExit): {
  readonly status: PlaytestAssignmentTerminalState;
  readonly termination: PlaytestEpisode["termination"];
  readonly missingReason: PlaytestMissingReason | null;
} {
  switch (exit.kind) {
    case "cancelled":
      return {
        status: "cancelled",
        termination: { reason: "cancelled", step: exit.step },
        missingReason: "cancelled"
      };
    case "step-limit":
      return {
        status: "budget-truncated",
        termination: { reason: "step-limit", step: exit.step },
        missingReason: "budget-truncated"
      };
    case USAGE_BUDGET: {
      return {
        status: "budget-truncated",
        termination: { reason: USAGE_BUDGET, step: exit.step },
        missingReason: "budget-truncated"
      };
    }
    case "loop-guard":
      return {
        status: "budget-truncated",
        termination: { reason: "loop-guard", step: exit.step },
        missingReason: "budget-truncated"
      };
    case "infrastructure-failure":
      return {
        status: "infrastructure-failed",
        termination: { reason: "runtime-failure", step: exit.step },
        missingReason: "infrastructure-failed"
      };
    case "driver-blocked":
      return VISUAL_BUDGET_BLOCK_REASONS.has(exit.reason)
        ? {
            status: "budget-truncated",
            termination: { reason: "step-limit", step: exit.step },
            missingReason: "budget-truncated"
          }
        : {
            status: "crashed",
            termination: { reason: "unknown", step: exit.step },
            missingReason: "unobserved"
          };
    case "action-refused":
      return {
        status: "crashed",
        termination: { reason: "unknown", step: exit.step },
        missingReason: "unobserved"
      };
    case "wall-time-limit":
      return {
        status: "budget-truncated",
        termination: { reason: "step-limit", step: exit.step },
        missingReason: "budget-truncated"
      };
    case "policy-stop":
      return {
        status: "completed",
        termination: { reason: "unknown", step: exit.step },
        missingReason: null
      };
  }
}

/** Typed, non-secret failure tag; never includes a raw error message. */
function visualRuntimeFailureCode(err: unknown): string {
  if (err instanceof SmartDirectPolicyError) {
    return "smart-direct:" + err.code;
  }
  if (err instanceof PlaytestVisualBrowserDriverError) {
    return "visual-driver:" + err.code;
  }
  if (err instanceof Error) return "error:" + err.constructor.name;
  return "unknown-runtime-failure";
}

/**
 * Report a visual episode that could not start.
 *
 * The episode failed before it produced any evidence, so the episode record
 * only says "infrastructure-failed" and the batch says it was recovered. The
 * reason a playtest could not run is invisible without this line: the same
 * episode looks the same whether the browser could not start, the game could
 * not be reached, or the Runtime was too busy to answer. The failure code is
 * the same typed tag the episode uses for runtime failures, and the message
 * is bounded.
 */
function reportVisualDriverOpenFailure(input: {
  readonly batchId: string;
  readonly episodeId: string;
  readonly assignmentId: string;
  readonly error: unknown;
}): void {
  const message =
    input.error instanceof Error ? input.error.message : String(input.error);
  writeErrorLine(
    JSON.stringify({
      schema: "autodev-playtest-runtime-event-v1",
      timestamp: new Date().toISOString(),
      event: "visual_driver_open_failed",
      batchId: input.batchId,
      episodeId: input.episodeId,
      assignmentId: input.assignmentId,
      failureCode: visualRuntimeFailureCode(input.error),
      errorName:
        input.error instanceof Error
          ? input.error.name
          : "unknown-runtime-failure",
      message: message.slice(0, 300)
    })
  );
}

/**
 * Whether a Smart-direct failure is the decision deadline running out.
 *
 * The deadline encodes the approved per-episode wall-time budget, so this
 * separates "the approved budget was spent" from "the provider could not
 * answer in time" — the first truncates the episode, the second is a runtime
 * failure.
 */
function isDecisionDeadlineFailure(err: unknown): boolean {
  return (
    err instanceof SmartDirectPolicyError &&
    err.code === "decision-deadline-exceeded"
  );
}

/**
 * Whether a Smart-direct failure is an approved budget running out.
 *
 * The request count, the token budget and the per-response usage are approved
 * ceilings, and an episode that reaches one of them was cut short by its
 * approval rather than lost to a runtime failure. The two must not be
 * reported the same way: the first is a truncation the operator can read in
 * the episode, the second is infrastructure loss.
 */
function isSmartDirectBudgetExhaustion(err: unknown): boolean {
  return (
    err instanceof SmartDirectPolicyError &&
    (err.code === "request-budget-exhausted" ||
      err.code === "token-budget-exhausted" ||
      err.code === "response-usage-exceeds-budget")
  );
}

/** Nine-field completion counters for exactly one visual-session episode. */
function visualCompletionCounts(
  status: PlaytestEpisodeState,
  started: boolean
): PlaytestCompletionCounts {
  return {
    assigned: 1,
    started: started ? 1 : 0,
    completed: status === "completed" ? 1 : 0,
    crashed: status === "crashed" ? 1 : 0,
    infrastructureFailed: status === "infrastructure-failed" ? 1 : 0,
    cancelled: status === "cancelled" ? 1 : 0,
    budgetTruncated: status === "budget-truncated" ? 1 : 0,
    reviewed: 0,
    // Visual URL-only exploration never asserts a verified game-terminal
    // outcome (Core's visual identity contract forbids claiming an
    // unobserved scenario/outcome), so no visual episode is ever eligible
    // for the adapter-only cross-session review path.
    eligible: 0
  };
}

async function executeApprovedVisualBatch(input: ExecuteVisualBatchInput) {
  const batchId = input.requestedBatchId;
  const areasOfFocus = input.request.areasOfFocus?.trim() || null;
  // Approval limits are ceilings. Run against the exact, already-validated
  // request limits so a smaller per-episode budget cannot be widened back to
  // the target's maximum when the driver or Smart-direct policy is created.
  const sessionTarget: WorkspaceVisualPlaytestTargetApproval = {
    ...input.target,
    limits: input.request.limits
  };
  const assignments: PlaytestVisualBatchAssignment[] = Array.from(
    { length: input.request.limits.episodeCount },
    (_, index) => ({
      assignmentId:
        "vis-assign-" +
        batchId.replace(/^batch-/u, "").slice(0, 12) +
        "-" +
        String(index),
      ordinal: index,
      maxSteps: input.request.limits.maxStepsPerEpisode
    })
  );

  const targetOrigin = new URL(input.target.entryUrl).origin;
  const manifestDraft: PlaytestAssignmentManifestDraft = {
    schema: PLAYTESTS_VISUAL_ASSIGNMENT_MANIFEST_SCHEMA,
    mode: "autonomous-visual",
    batchId,
    workspaceId: input.workspaceId,
    targetId: input.target.targetId,
    targetApprovalId: input.target.approvalId,
    targetRevision: input.target.revision,
    targetOrigin,
    policyId: "smart-direct",
    policyVersion: SMART_DIRECT_POLICY_VERSION,
    cohortId: null,
    areasOfFocus,
    limits: input.request.limits,
    createdAt: input.createdAt,
    assignments
  };

  const contentHash = createHash("sha256")
    .update(playtestAssignmentManifestHashInput(manifestDraft))
    .digest("hex");
  const manifest: PlaytestVisualAssignmentManifest = {
    ...manifestDraft,
    contentHash
  };
  assertPlaytestAssignmentManifest(manifest);

  const initialBatch: PlaytestVisualBatch = {
    schema: PLAYTESTS_BATCH_SCHEMA,
    batchId,
    revision: 1,
    workspaceId: input.workspaceId,
    measurementVersion: PLAYTESTS_MEASUREMENT_VERSION,
    policyIds: ["smart-direct"],
    cohortIds: [],
    scenarioIds: [],
    // A frozen assignment inventory with no terminal no-episode outcomes
    // is an explicit empty list; null is reserved for unavailable/legacy
    // inventory and is rejected by Data's indexed batch codec.
    unobservedAssignments: [],
    reviewPackets: [],
    reviewReceipts: [],
    status: "running",
    cancellationReason: null,
    failureReason: null,
    counts: {
      assigned: assignments.length,
      started: 0,
      completed: 0,
      crashed: 0,
      infrastructureFailed: 0,
      cancelled: 0,
      budgetTruncated: 0,
      reviewed: 0,
      eligible: 0
    },
    budget: {
      assignedEpisodes: assignments.length,
      maxStepsPerEpisode: input.request.limits.maxStepsPerEpisode,
      wallTimeMs: input.request.limits.wallTimeMs,
      critiqueBudget: 0,
      actualCritiques: 0
    },
    startedAt: input.createdAt,
    completedAt: null,
    createdAt: input.createdAt,
    provenance: {
      workspaceId: input.workspaceId,
      buildSha: null,
      generatedAt: input.createdAt,
      measurementVersion: PLAYTESTS_MEASUREMENT_VERSION
    },
    evaluationIds: [],
    spanIds: [],
    executionMode: "autonomous-visual",
    repository: null,
    buildSha: null,
    gameBuild: null,
    configHash: null,
    rubricHash: null,
    actionSchemaHash: null,
    observationSchemaHash: null,
    eventSchemaHash: null,
    protocolVersion: null,
    assignmentInventory: {
      status: "frozen-visual",
      manifest
    },
    coverageManifest: null,
    reviewSelection: {
      status: "unavailable",
      reason: "visual-discovery-session-level"
    }
  };
  await input.repository.insertBatch(initialBatch);

  const controller = new AbortController();
  let resolveCompletion!: (status: PlaytestRunStatus) => void;
  const completion = new Promise<PlaytestRunStatus>((resolve) => {
    resolveCompletion = resolve;
  });
  const activeRun: ActivePlaytestRun = {
    batchId,
    workspaceId: input.workspaceId,
    buildSha: "",
    ownerActor: input.session.actor,
    ownerTaskId: input.session.taskId,
    ownerRunId: input.session.runId,
    assignmentCount: assignments.length,
    assignmentIds: assignments.map((a) => a.assignmentId),
    sessions: sessionReferencesForAssignments(
      "autonomous-visual",
      batchId,
      assignments.map((assignment) => assignment.assignmentId)
    ),
    reservedWorkers: 1,
    manifestHash: manifest.contentHash,
    createdAt: input.createdAt,
    outcomes: new Map(),
    controller,
    phase: "running",
    reason: null,
    sandboxes: new Set(),
    completion,
    resolveCompletion
  };
  input.activeRuns.set(batchId, activeRun);
  input.onRegistered(
    batchId,
    input.createdAt,
    activeRun.assignmentIds,
    activeRun.sessions
  );

  const policyWorkspaces: PlaytestPolicyWorkspace[] = [];
  try {
    for (const assignment of assignments) {
      if (activeRun.reason !== null) {
        activeRun.outcomes.set(assignment.assignmentId, {
          assignmentId: assignment.assignmentId,
          state: "cancelled",
          episodeId: null,
          started: false,
          eligible: false,
          gameOutcome: null
        });
        continue;
      }
      // The Smart-direct decision turns are bound to a private, source-empty
      // workspace: the Router refuses to resolve a turn without one, and the
      // policy plays a game rather than editing one.
      const policyWorkspace = createPlaytestPolicyWorkspace();
      policyWorkspaces.push(policyWorkspace);
      const episodeId = playtestVisualEpisodeRecordId(
        batchId,
        assignment.assignmentId
      );

      const executionProvenance: PlaytestEpisode["executionProvenance"] = {
        mode: "autonomous-visual",
        source: {
          kind: "URL-only",
          repository: null,
          revision: null,
          revisionConfidence: "not-applicable",
          checkoutState: "not-applicable",
          artifactFingerprint: null,
          targetId: input.target.targetId,
          targetOrigin
        },
        observationSource: "browser-ui",
        actionSource: "browser-input",
        derivedFrom: null
      };
      const identity: PlaytestEpisode["identity"] = {
        workspaceId: input.workspaceId,
        repository: null,
        buildSha: null,
        gameBuild: null,
        scenarioId: null,
        configHash: null,
        seed: null,
        protocolVersion: null,
        policyId: "smart-direct",
        policyVersion: SMART_DIRECT_POLICY_VERSION,
        modelId: "autodev/smart",
        modelRevision: null,
        observationSchemaHash: createHash("sha256")
          .update(PLAYTEST_VISUAL_OBSERVATION_SCHEMA)
          .digest("hex"),
        actionSchemaHash: createHash("sha256")
          .update(PLAYTEST_VISUAL_ACTION_SCHEMA)
          .digest("hex"),
        eventSchemaHash: createHash("sha256")
          .update("autodev-playtest-visual-event-v1")
          .digest("hex"),
        runtimeVersion: RUNTIME_VERSION,
        environmentHash: createHash("sha256")
          .update(input.target.entryUrl)
          .digest("hex"),
        rngAlgorithm: null,
        rngVersion: null,
        rngInitialStateHash: null
      };

      let revision = 1;
      const capturedFrames: PlaytestArtifactReference[] = [];
      let stepCount = 0;
      let startedAtIso: string | null = null;
      let playerDebrief: PlaytestPlayerDebriefV1 = {
        schema: PLAYTEST_PLAYER_DEBRIEF_SCHEMA,
        status: "pending",
        reason: "episode-in-progress"
      };

      const persistRevision = async (overrides: {
        readonly status: PlaytestEpisodeState;
        readonly termination: PlaytestEpisode["termination"];
        readonly completionCounts: PlaytestCompletionCounts;
        readonly trace: PlaytestEvidenceLocator | null;
        readonly completedAt: string | null;
        readonly completeness: "complete" | "partial" | "unknown";
        readonly missingReasons: readonly PlaytestMissingReason[];
        readonly policyInferenceMs: number;
        readonly simulationWallMs: number | null;
      }): Promise<PlaytestEpisode> => {
        const episode: PlaytestEpisode = {
          schema: PLAYTESTS_EPISODE_SCHEMA,
          episodeId,
          revision,
          batchId,
          assignmentId: assignment.assignmentId,
          branchLineage: null,
          executionProvenance,
          playerDebrief,
          identity,
          scenarioFamily: null,
          policyCohort: null,
          strategy: "smart-direct-visual",
          status: overrides.status,
          termination: overrides.termination,
          outcome: "unknown",
          outcomeMetrics: {},
          completionCounts: overrides.completionCounts,
          replayStatus: "unavailable",
          trace: overrides.trace,
          frames: capturedFrames.map((frame, index) => ({
            id: frame.artifactId,
            kind: "frame",
            step: index,
            frameIndex: index
          })),
          stepCount,
          metrics: [],
          findingIds: [],
          assignedAt: input.createdAt,
          startedAt: startedAtIso,
          completedAt: overrides.completedAt,
          simulationWallMs: overrides.simulationWallMs,
          logicalTicks: null,
          policyInferenceMs: overrides.policyInferenceMs,
          nativeDurationMs: null,
          completeness: overrides.completeness,
          missingReasons: overrides.missingReasons
        };
        revision += 1;
        await input.repository.insertEpisode(episode);
        return episode;
      };

      await persistRevision({
        status: "assigned",
        termination: { reason: "unknown", step: null },
        completionCounts: visualCompletionCounts("assigned", false),
        trace: null,
        completedAt: null,
        completeness: "unknown",
        missingReasons: [],
        policyInferenceMs: 0,
        simulationWallMs: null
      });

      let driver: PlaytestVisualEpisodeDriver;
      try {
        driver = await input.openVisualDriver({
          target: sessionTarget,
          episodeId,
          artifacts: input.artifacts,
          viewport: { width: 1280, height: 720, deviceScaleFactor: 1 },
          actionTimeoutMs: Math.min(10_000, sessionTarget.limits.wallTimeMs),
          maxSteps: assignment.maxSteps
        });
      } catch (err) {
        reportVisualDriverOpenFailure({
          batchId,
          episodeId,
          assignmentId: assignment.assignmentId,
          error: err
        });
        playerDebrief = {
          schema: PLAYTEST_PLAYER_DEBRIEF_SCHEMA,
          status: "unavailable",
          reason: "interrupted-before-checkpoint"
        };
        const failedEpisode = await persistRevision({
          status: "infrastructure-failed",
          termination: { reason: "runtime-failure", step: null },
          completionCounts: visualCompletionCounts(
            "infrastructure-failed",
            false
          ),
          trace: null,
          completedAt: new Date().toISOString(),
          completeness: "unknown",
          missingReasons: ["infrastructure-failed"],
          policyInferenceMs: 0,
          simulationWallMs: null
        });
        activeRun.outcomes.set(assignment.assignmentId, {
          assignmentId: assignment.assignmentId,
          state: "infrastructure-failed",
          episodeId: failedEpisode.episodeId,
          started: false,
          eligible: false,
          gameOutcome: null
        });
        continue;
      }

      const episodeStartedAt = new Date().toISOString();
      startedAtIso = episodeStartedAt;
      await persistRevision({
        status: "started",
        termination: { reason: "unknown", step: null },
        completionCounts: visualCompletionCounts("started", true),
        trace: null,
        completedAt: null,
        completeness: "unknown",
        missingReasons: [],
        policyInferenceMs: 0,
        simulationWallMs: 0
      });

      const policy = input.createVisualPolicy({
        target: sessionTarget,
        workspacePath: policyWorkspace.workspacePath
      });
      const history: { step: number; action: string; observation: string }[] =
        [];
      const traceSteps: PlaytestEvidenceTraceStep[] = [];
      let exit: VisualEpisodeExit = { kind: "step-limit", step: null };

      for (let step = 0; step < assignment.maxSteps; step += 1) {
        if (activeRun.controller.signal.aborted) {
          exit = { kind: "cancelled", step };
          break;
        }
        let obsResult;
        try {
          obsResult = await driver.observe();
        } catch (err) {
          exit = {
            kind: "infrastructure-failure",
            code: visualRuntimeFailureCode(err),
            step
          };
          break;
        }
        if (obsResult.status !== "observed") {
          exit = { kind: "driver-blocked", reason: obsResult.reason, step };
          break;
        }

        capturedFrames.push(obsResult.observation.frame);
        await persistRevision({
          status: "started",
          termination: { reason: "unknown", step: null },
          completionCounts: visualCompletionCounts("started", true),
          trace: null,
          completedAt: null,
          completeness: "unknown",
          missingReasons: [],
          policyInferenceMs: 0,
          simulationWallMs: 0
        });
        const frameBytes = input.artifacts.readArtifact(
          obsResult.observation.frame
        ).bytes;
        let decision;
        try {
          decision = await policy.decide({
            target: sessionTarget,
            observation: obsResult.observation,
            frameBytes,
            areasOfFocus,
            history,
            // The approved per-episode wall-time budget owns the decision
            // deadline. The driver enforces that same ceiling before every
            // observation and every action, so a decision may not outlive it;
            // a deadline shorter than the budget would cut a healthy provider
            // off mid-answer and report the episode as a runtime failure.
            deadlineMonotonicMs:
              performance.now() + driver.remainingWallTimeMs()
          });
        } catch (err) {
          const code = visualRuntimeFailureCode(err);
          traceSteps.push({
            step,
            phaseId: obsResult.observation.phaseEvidence,
            revisionBefore: step,
            revisionAfter: step,
            observationVisibility: "visual-only",
            visibleObservation: {
              capturedAt: obsResult.observation.capturedAt,
              viewport: obsResult.observation.viewport,
              privacyState: obsResult.observation.privacyState,
              controls: obsResult.observation.controls.map((c) => ({
                controlId: c.controlId,
                name: c.name,
                role: c.role,
                bounds: c.bounds,
                enabled: c.enabled
              })),
              warnings: obsResult.observation.visibleWarnings,
              phase: obsResult.observation.phaseEvidence,
              progress: obsResult.observation.progressEvidence
            } as unknown as PlaytestJsonValue,
            legalActionIds: obsResult.observation.controls
              .filter((control) => control.enabled)
              .map((control) => control.controlId),
            selectedActionId: null,
            preActionPrediction: null,
            authoritativeOutcome: {
              runtimeFailureCode: code
            },
            events: [],
            frameRefs: [
              { id: obsResult.observation.frame.artifactId, kind: "frame" }
            ]
          });
          exit =
            isDecisionDeadlineFailure(err) && driver.remainingWallTimeMs() <= 0
              ? { kind: "wall-time-limit", step }
              : isSmartDirectBudgetExhaustion(err)
                ? { kind: USAGE_BUDGET, step }
                : { kind: "infrastructure-failure", code, step };
          break;
        }

        if (decision.status === "stop") {
          traceSteps.push({
            step,
            phaseId: obsResult.observation.phaseEvidence,
            revisionBefore: step,
            revisionAfter: step,
            observationVisibility: "visual-only",
            visibleObservation: {
              capturedAt: obsResult.observation.capturedAt,
              viewport: obsResult.observation.viewport,
              privacyState: obsResult.observation.privacyState,
              controls: obsResult.observation.controls.map((c) => ({
                controlId: c.controlId,
                name: c.name,
                role: c.role,
                bounds: c.bounds,
                enabled: c.enabled
              })),
              warnings: obsResult.observation.visibleWarnings,
              phase: obsResult.observation.phaseEvidence,
              progress: obsResult.observation.progressEvidence
            } as unknown as PlaytestJsonValue,
            legalActionIds: obsResult.observation.controls
              .filter((control) => control.enabled)
              .map((control) => control.controlId),
            selectedActionId: null,
            preActionPrediction: {
              intention: decision.intention,
              predictedVisibleEffect: decision.predictedVisibleEffect,
              reasonCode: decision.reasonCode
            },
            authoritativeOutcome: {
              stopReason: decision.stopReason
            },
            events: [],
            frameRefs: [
              { id: obsResult.observation.frame.artifactId, kind: "frame" }
            ]
          });
          playerDebrief = completePlayerDebrief({
            requestedFocus: areasOfFocus,
            traceSteps,
            capturedFrames,
            decision
          });
          exit =
            decision.stopReason === "stuck"
              ? { kind: "loop-guard", step }
              : { kind: "policy-stop", step };
          break;
        }

        const receipt = await driver.act(decision.action);
        history.push({
          step,
          action: JSON.stringify(decision.action),
          observation: JSON.stringify({
            phase: obsResult.observation.phaseEvidence,
            controls: obsResult.observation.controls.map((c) => c.name)
          })
        });
        traceSteps.push({
          step,
          phaseId: obsResult.observation.phaseEvidence,
          revisionBefore: step,
          revisionAfter: step + 1,
          observationVisibility: "visual-only",
          visibleObservation: {
            capturedAt: obsResult.observation.capturedAt,
            viewport: obsResult.observation.viewport,
            privacyState: obsResult.observation.privacyState,
            controls: obsResult.observation.controls.map((c) => ({
              controlId: c.controlId,
              name: c.name,
              role: c.role,
              bounds: c.bounds,
              enabled: c.enabled
            })),
            warnings: obsResult.observation.visibleWarnings,
            phase: obsResult.observation.phaseEvidence,
            progress: obsResult.observation.progressEvidence
          } as unknown as PlaytestJsonValue,
          legalActionIds: obsResult.observation.controls
            .filter((control) => control.enabled)
            .map((control) => control.controlId),
          selectedActionId:
            decision.action.kind === "activate-control"
              ? decision.action.controlId
              : null,
          preActionPrediction: {
            intention: decision.intention,
            predictedVisibleEffect: decision.predictedVisibleEffect,
            reasonCode: decision.reasonCode
          },
          authoritativeOutcome: {
            status: receipt.status,
            actionKind: decision.action.kind,
            observationId: decision.action.observationId,
            actionDetail:
              decision.action.kind === "activate-control"
                ? { controlId: decision.action.controlId }
                : decision.action.kind === "pointer-click"
                  ? {
                      frameArtifactId: decision.action.frameArtifactId,
                      x: decision.action.x,
                      y: decision.action.y
                    }
                  : decision.action.kind === "key-press"
                    ? { key: decision.action.key }
                    : { button: decision.action.button },
            dispatchedAt:
              receipt.status === "dispatched" ? receipt.dispatchedAt : null,
            receiptAt: new Date().toISOString(),
            refusalReason: receipt.status === "refused" ? receipt.reason : null
          },
          events: [],
          frameRefs: [
            { id: obsResult.observation.frame.artifactId, kind: "frame" }
          ]
        });
        playerDebrief = playerDebriefCheckpoint(step, decision, capturedFrames);
        if (receipt.status !== "dispatched") {
          exit = { kind: "action-refused", reason: receipt.reason, step };
          break;
        }

        stepCount = traceSteps.length;
        const progressArtifact = input.artifacts.writeWindow({
          artifactId: "trace-" + episodeId + "-r" + String(revision),
          entries: traceSteps
        }).reference;
        await persistRevision({
          status: "started",
          termination: { reason: "unknown", step: null },
          completionCounts: visualCompletionCounts("started", true),
          trace: { id: progressArtifact.artifactId, kind: "replay-segment" },
          completedAt: null,
          completeness: "unknown",
          missingReasons: [],
          policyInferenceMs: policy.usage().lastLatencyMs ?? 0,
          simulationWallMs: Date.now() - Date.parse(episodeStartedAt)
        });
      }

      stepCount = traceSteps.length;
      await driver.close().catch(() => {});

      const traceArtifact = input.artifacts.writeWindow({
        artifactId: "trace-" + episodeId,
        entries: traceSteps
      }).reference;

      const disposition = visualEpisodeDisposition(exit);
      const completeness: "complete" | "partial" | "unknown" =
        disposition.status === "completed"
          ? "complete"
          : stepCount > 0
            ? "partial"
            : "unknown";
      const missingReasons: readonly PlaytestMissingReason[] =
        disposition.missingReason === null ? [] : [disposition.missingReason];
      const completedAt = new Date().toISOString();
      playerDebrief = playerDebriefAfterExit(playerDebrief, exit);
      const finalEpisode = await persistRevision({
        status: disposition.status,
        termination: disposition.termination,
        completionCounts: visualCompletionCounts(disposition.status, true),
        trace: { id: traceArtifact.artifactId, kind: "replay-segment" },
        completedAt,
        completeness,
        missingReasons,
        policyInferenceMs: policy.usage().lastLatencyMs ?? 0,
        simulationWallMs: Date.now() - Date.parse(episodeStartedAt)
      });
      activeRun.outcomes.set(assignment.assignmentId, {
        assignmentId: assignment.assignmentId,
        state: disposition.status,
        episodeId: finalEpisode.episodeId,
        started: true,
        // Visual URL-only exploration never asserts a verified game-terminal
        // outcome, so no visual episode is eligible for adapter-only review.
        eligible: false,
        gameOutcome: null
      });
    }

    markRunPersisting(activeRun);
    const finalCounts = playtestBatchCountsFromAssignments({
      assignmentCount: assignments.length,
      outcomes: [...activeRun.outcomes.values()],
      reviewed: 0
    });
    const finalBatch: PlaytestVisualBatch = {
      ...initialBatch,
      revision: 2,
      status: playtestBatchTerminalState({
        assignmentCount: assignments.length,
        outcomes: [...activeRun.outcomes.values()],
        cancelled: activeRun.reason !== null,
        aborted: false
      }),
      completedAt: new Date().toISOString(),
      counts: finalCounts
    };
    await input.repository.insertBatch(finalBatch);
    return {
      ...activeRunProgress(activeRun),
      status: finalBatch.status
    };
  } finally {
    for (const workspace of policyWorkspaces) {
      removePlaytestPolicyWorkspace(workspace);
    }
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
/**
 * Resolve an explicitly supported policy baseline; never fabricate a heuristic.
 *
 * Exported so the resolution seam itself is testable: a policy can be correct
 * in `policies.ts` and still unreachable if nothing here constructs it, which
 * is exactly how a scored policy sat unused behind a single-entry gate.
 */
export function resolvePolicy(
  policyId: string,
  benchmark?: PlaytestBenchmark | null
): PlaytestPolicy {
  const version = benchmark?.policyVersions?.[policyId];
  const policy = createBuiltinPlaytestPolicy(
    policyId,
    version ? { version } : undefined
  );
  if (policy !== null) return policy;
  throw new PlaytestMcpValidationError(
    'Policy "' +
      policyId +
      '" is not an explicitly supported baseline. Supported baselines: [' +
      [...PLAYTESTS_BUILTIN_POLICY_IDS].join(", ") +
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
  assertPlaytestAdapterEpisode(episode);
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
  assertPlaytestAdapterEpisode(episode);
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

function parsePlaytestLaunchRequest(request: unknown): PlaytestLaunchRequest {
  const parsed = playtestLaunchRequestSchema.safeParse(request);
  if (parsed.success) return parsed.data;
  throw new PlaytestMcpValidationError(
    "The versioned PlaytestLaunchRequest is invalid."
  );
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

/**
 * The issue-reporting mode the game declared in its checked-in config, read
 * from the approved checkout.
 *
 * Fail-closed on purpose. An absent approval, a revoked one, or a config that
 * cannot be loaded reports no declared authority: a capability probe must not
 * throw because a game has not onboarded yet, and an unreadable config is not
 * evidence of authority. A config that is invalid but readable still says
 * exactly what it declared — only failing to read it collapses to "disabled".
 */
function configuredIssueReporting(
  prepared: PreparedPlaytestSandbox | null
): "disabled" | "review" {
  return prepared?.configuration.reporting.githubIssues ?? "disabled";
}

/**
 * Resolve and load the active approval's latest committed build once per
 * capability read. An unreadable or incompatible target yields null.
 */
function tryPrepareLatestBuild(
  approval: WorkspacePlaytestApproval | null,
  prepareSandbox: (
    approval: WorkspacePlaytestApproval
  ) => PreparedPlaytestSandbox
): PreparedPlaytestSandbox | null {
  if (!approval || approval.revokedAt !== null) return null;
  try {
    return prepareSandbox(approval);
  } catch {
    return null;
  }
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

function requiredLaunchIntentRepository(
  repository: PlaytestLaunchIntentRepository | undefined
): PlaytestLaunchIntentRepository {
  if (!repository) {
    throw new PlaytestMcpUnavailableError(
      "Durable launch-intent storage is unavailable; no playtest was started."
    );
  }
  return repository;
}

async function reserveLaunchIntent(input: {
  readonly repository: PlaytestLaunchIntentRepository;
  readonly workspaceId: string;
  readonly actorId: string;
  readonly request: PlaytestLaunchRequest;
  readonly assignmentCount: number;
}): Promise<PlaytestLaunchIntent> {
  if (!LAUNCH_INTENT_REQUEST_ID_PATTERN.test(input.request.requestId)) {
    throw new PlaytestMcpValidationError(
      "requestId must be a client-generated 1-128 character launch key."
    );
  }
  const expectedHash = launchIntentHash(input.request);
  const resolveExisting = (intent: PlaytestLaunchIntent | null) => {
    if (!intent) return null;
    if (
      intent.workspaceId !== input.workspaceId ||
      intent.actorId !== input.actorId ||
      intent.requestId !== input.request.requestId
    ) {
      throw new PlaytestMcpUnavailableError(
        "Launch-intent storage returned a mismatched identity."
      );
    }
    if (intent.expiresAt !== "" && Date.parse(intent.expiresAt) <= Date.now()) {
      throw new PlaytestMcpConflictError(
        "This requestId has expired. Check its recovery receipt before starting a new attempt."
      );
    }
    if (intent.launchIntentHash !== expectedHash) {
      throw new PlaytestMcpConflictError(
        "This requestId is already bound to a different immutable launch payload. Recover that request or choose a new requestId after reviewing the result."
      );
    }
    return intent;
  };
  const prior = resolveExisting(
    await input.repository.getLaunchIntent(
      input.workspaceId,
      input.actorId,
      input.request.requestId
    )
  );
  if (prior) return prior;

  const createdAt = new Date().toISOString();
  const intent: PlaytestLaunchIntent = {
    workspaceId: input.workspaceId,
    actorId: input.actorId,
    requestId: input.request.requestId,
    launchIntentHash: expectedHash,
    batchId: "batch-" + randomUUID(),
    assignmentCount: input.assignmentCount,
    createdAt,
    expiresAt: new Date(
      Date.parse(createdAt) + LAUNCH_INTENT_RETENTION_MS
    ).toISOString()
  };
  try {
    await input.repository.insertLaunchIntent(intent);
    return intent;
  } catch {
    // A transport failure may occur after ClickHouse committed the row. Read
    // back the same identity; never launch from an ambiguous insert ack.
    let persisted: PlaytestLaunchIntent | null;
    try {
      persisted = await input.repository.getLaunchIntent(
        input.workspaceId,
        input.actorId,
        input.request.requestId
      );
    } catch {
      throw new PlaytestMcpUnavailableError(
        "Launch receipt persistence is ambiguous; recover this request before retrying."
      );
    }
    const resolved = resolveExisting(persisted);
    if (!resolved) {
      throw new PlaytestMcpUnavailableError(
        "Runtime could not durably reserve the launch request; no game process was started."
      );
    }
    return resolved;
  }
}

type PlaytestRunnableAssignment =
  PlaytestRunCapabilities["runnableAssignments"][number];

function collectRunnableAssignments(input: {
  readonly approval: WorkspacePlaytestApproval | null;
  readonly workspaceId: string;
  readonly workspaceEnabled: boolean;
  readonly prepared: PreparedPlaytestSandbox | null;
}): {
  readonly configurationStatus: PlaytestRunCapabilities["configurationStatus"];
  readonly maxBatchAssignments: number;
  readonly assignments: readonly PlaytestRunnableAssignment[];
} {
  const { approval, workspaceId, workspaceEnabled, prepared } = input;
  if (!approval || approval.revokedAt !== null || !workspaceEnabled) {
    return {
      configurationStatus: "not-checked",
      maxBatchAssignments: 0,
      assignments: []
    };
  }

  const assignments: PlaytestRunnableAssignment[] = [];
  try {
    if (prepared === null) {
      throw new PlaytestMcpValidationError(
        "The latest committed build's target configuration is unavailable."
      );
    }
    assertBatchReviewBudget(prepared, approval);
    const maxBatchAssignments = Math.min(
      PLAYTESTS_MAX_BATCH_ASSIGNMENTS,
      approval.limits.episodeCount,
      prepared.configuration.budget.episodes
    );
    for (const scenarioId of approval.allowedScenarios) {
      for (const policyId of approval.allowedPolicies) {
        if (!PLAYTESTS_BUILTIN_POLICY_IDS.has(policyId)) continue;
        try {
          // The capability probe mirrors batch admission exactly, so an
          // approved cell is only advertised when a batch would be accepted.
          const probeSeed =
            prepared.benchmark?.seedInventory?.[0]?.seed ?? "probe";
          prepareApprovedBatch({
            workspaceId,
            approval,
            prepared,
            batchId: "batch-capability-probe",
            assignments: [
              { scenario: scenarioId, policy: policyId, seed: probeSeed }
            ],
            branchPlan: null
          });
          const scenarioFamily = scenarioFamilyFor(prepared, scenarioId);
          const policy = resolvePolicy(policyId, prepared.benchmark);
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
    visualTargetRepository = options.visualTargetRepository ??
      new WorkspaceVisualPlaytestTargetRepository(),
    runEpisodeHandler = runPlaytestEpisode,
    launchSandboxHandler,
    prepareSandboxHandler = preparePlaytestSandbox,
    readWorkspaceCatalog = () => new ConfigRepository().readWorkspaceCatalog(),
    launchAnalystProcess,
    createVisualPolicy = ({ target, workspacePath }) =>
      new SmartDirectVisualPolicy(target, { workspacePath })
  } = options;
  const activeRuns = new Map<string, ActivePlaytestRun>();
  const analystReviewRuns = new Map<string, PlaytestAnalystReviewRun>();
  const activeAnalystRuns = new Map<string, ActiveAnalystReviewRun>();
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
  const pruneAnalystReviewHistory = (): void => {
    while (analystReviewRuns.size > MAX_RETAINED_ANALYST_RUNS) {
      let oldestTerminal: string | undefined;
      for (const analysisId of analystReviewRuns.keys()) {
        if (!activeAnalystRuns.has(analysisId)) {
          oldestTerminal = analysisId;
          break;
        }
      }
      if (oldestTerminal === undefined) return;
      analystReviewRuns.delete(oldestTerminal);
    }
  };

  const finalizeAnalystRun = async (
    analysisId: string,
    result: PlaytestAnalystProcessResult
  ): Promise<void> => {
    const active = activeAnalystRuns.get(analysisId);
    const current = analystReviewRuns.get(analysisId);
    if (!active || !current) return;
    activeAnalystRuns.delete(analysisId);

    const repository = requiredRunRepository(playtestRepository);
    let reviews: readonly PlaytestAnalystReviewReceipt[] = [];
    let reviewReadFailed = false;
    let synthesis: PlaytestCrossSessionSynthesis | null = null;
    let synthesisReadFailed = false;
    try {
      reviews = await readPersistedAnalystReviews(repository, current);
    } catch {
      reviewReadFailed = true;
    }
    if (current.analysisKind !== "discovery") {
      try {
        synthesis = await repository.getCrossSessionSynthesisForAnalysis(
          current.workspaceId,
          current.analysisId
        );
      } catch {
        synthesisReadFailed = true;
      }
    }
    const status = analystReviewRunStatus({
      run: current,
      result,
      reviews,
      reviewReadFailed,
      synthesisId: synthesis?.synthesisId ?? null,
      synthesisReadFailed
    });
    analystReviewRuns.set(analysisId, {
      ...current,
      status,
      finishedAt: new Date().toISOString(),
      reviews,
      synthesisId: synthesis?.synthesisId ?? null,
      error: analystReviewRunError({
        status,
        run: current,
        result,
        reviews,
        reviewReadFailed,
        synthesisId: synthesis?.synthesisId ?? null,
        synthesisReadFailed
      })
    });
    pruneAnalystReviewHistory();
  };

  const unpersistedAnalystReservations = async (
    workspaceId: string,
    requestedBatchIds: readonly string[]
  ): Promise<{
    readonly counts: ReadonlyMap<string, number>;
    readonly batches: ReadonlyMap<string, PlaytestBatch | null>;
  }> => {
    const repository = requiredRunRepository(playtestRepository);
    const activeAnalysisRecords = Array.from(
      activeAnalystRuns.keys(),
      (analysisId) => analystReviewRuns.get(analysisId)
    ).filter(
      (run): run is PlaytestAnalystReviewRun =>
        run !== undefined && run.workspaceId === workspaceId
    );
    const packetEntries = activeAnalysisRecords.flatMap((run) => run.packets);
    const batchIds = [
      ...new Set([
        ...requestedBatchIds,
        ...packetEntries.map((packet) => packet.batchId)
      ])
    ];
    const batchRows = await Promise.all(
      batchIds.map(
        async (batchId) =>
          [batchId, await repository.getBatch(workspaceId, batchId)] as const
      )
    );
    const batches = new Map(batchRows);
    const counts = new Map<string, number>();
    for (const packet of packetEntries) {
      const durableReservation = batches
        .get(packet.batchId)
        ?.reviewReceipts.some(
          (receipt) =>
            receipt.episodeId === packet.episodeId &&
            receipt.packetId === packet.packetId
        );
      if (!durableReservation) {
        counts.set(packet.batchId, (counts.get(packet.batchId) ?? 0) + 1);
      }
    }
    return { counts, batches };
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
          supportedPolicies: [...PLAYTESTS_BUILTIN_POLICY_IDS],
          runnablePolicies: [],
          unsupportedApprovedPolicies: [],
          configurationStatus: "not-checked",
          maxBatchAssignments: 0,
          runnableAssignments: [],
          admissibleSeeds: null,
          policyProfiles: [],
          limits: null,
          issueReporting: "disabled",
          // No readable catalog means no approved checkout and therefore no
          // readable config: report no declared authority rather than guessing.
          configuredIssueReporting: "disabled",
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
      const latestBuild = tryPrepareLatestBuild(
        approval,
        prepareSandboxHandler
      );
      const runnable = collectRunnableAssignments({
        approval,
        workspaceId: authorizedWorkspaceId,
        workspaceEnabled: workspace.enabled,
        prepared: latestBuild
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
        buildSha: latestBuild?.build.buildSha ?? null,
        gameBuild: latestBuild?.build.gameBuild ?? null,
        allowedScenarios: approval?.allowedScenarios ?? [],
        approvedPolicies,
        supportedPolicies: [...PLAYTESTS_BUILTIN_POLICY_IDS],
        runnablePolicies,
        unsupportedApprovedPolicies: approvedPolicies.filter(
          (policyId) => !PLAYTESTS_BUILTIN_POLICY_IDS.has(policyId)
        ),
        configurationStatus: runnable.configurationStatus,
        maxBatchAssignments: runnable.maxBatchAssignments,
        runnableAssignments,
        admissibleSeeds:
          runnable.configurationStatus === "validated" && latestBuild?.benchmark
            ? latestBuild.benchmark.seedInventory.map(({ seed, purpose }) => ({
                seed,
                purpose
              }))
            : null,
        policyProfiles: profiles,
        limits: approval?.limits ?? null,
        issueReporting: approval?.issueReporting ?? "disabled",
        configuredIssueReporting: configuredIssueReporting(latestBuild),
        humanStudyAllowed: approval?.humanStudyAllowed ?? false,
        revokedAt: approval?.revokedAt ?? null,
        runPreflight: "required-at-start"
      };
    },
    startRun(session, request) {
      const parsed = parsePlaytestLaunchRequest(request);
      const targetWorkspaceId = authorizeRunnerWorkspace(
        session,
        parsed.workspaceId,
        readWorkspaceCatalog
      );
      if (
        parsed.mode !== PLAYTEST_ADAPTER_MODE &&
        parsed.mode !== "autonomous-visual"
      ) {
        throw new PlaytestMcpUnavailableError(
          "Scripted regression launch is unavailable until its approved replay recipe runner is installed."
        );
      }
      const repository = requiredRunRepository(playtestRepository);
      const intentRepository = requiredLaunchIntentRepository(
        options.launchIntentRepository
      );
      const assignmentCount =
        parsed.mode === "autonomous-visual"
          ? parsed.limits.episodeCount
          : parsed.operation.kind === "batch"
            ? parsed.operation.assignments.length
            : 1;
      const lockKey =
        "launch-intent\0" +
        targetWorkspaceId +
        "\0" +
        session.actor +
        "\0" +
        parsed.requestId;

      return withAssignmentLock(assignmentLocks, lockKey, async () => {
        const expectedHash = launchIntentHash(parsed);
        const priorIntent = await intentRepository.getLaunchIntent(
          targetWorkspaceId,
          session.actor,
          parsed.requestId
        );
        if (priorIntent) {
          if (
            priorIntent.workspaceId !== targetWorkspaceId ||
            priorIntent.actorId !== session.actor ||
            priorIntent.requestId !== parsed.requestId
          ) {
            throw new PlaytestMcpUnavailableError(
              "Launch-intent storage returned a mismatched identity."
            );
          }
          if (
            priorIntent.expiresAt !== "" &&
            Date.parse(priorIntent.expiresAt) <= Date.now()
          ) {
            throw new PlaytestMcpConflictError(
              "This requestId has expired. Check its recovery receipt before starting a new attempt."
            );
          }
          if (priorIntent.launchIntentHash !== expectedHash) {
            throw new PlaytestMcpConflictError(
              "This requestId is already bound to a different immutable launch payload. Recover that request or choose a new requestId after reviewing the result."
            );
          }
          const livePriorRun = activeRuns.get(priorIntent.batchId);
          if (livePriorRun) return startReceiptForActiveRun(livePriorRun);
          const priorBatch = await repository.getBatch(
            targetWorkspaceId,
            priorIntent.batchId
          );
          if (priorBatch) {
            if (
              priorBatch.budget.assignedEpisodes !== priorIntent.assignmentCount
            ) {
              throw new PlaytestMcpUnavailableError(
                "The persisted launch receipt does not match its frozen batch."
              );
            }
            return startReceiptForPersistedBatch({
              repository,
              workspaceId: targetWorkspaceId,
              batch: priorBatch,
              activeRun: activeRuns.get(priorBatch.batchId),
              locks: assignmentLocks
            });
          }
        }

        if (parsed.mode === "autonomous-visual") {
          const target = visualTargetRepository.read(
            targetWorkspaceId,
            parsed.targetId
          );
          if (!target || target.revokedAt !== null) {
            throw new PlaytestMcpValidationError(
              "The requested visual target is not approved or has been revoked."
            );
          }
          assertVisualLaunchLimitsWithinApprovedTarget(
            parsed.limits,
            target.limits
          );
          const artifacts = artifactStoreForWorkspace(targetWorkspaceId);
          const intent = await reserveLaunchIntent({
            repository: intentRepository,
            workspaceId: targetWorkspaceId,
            actorId: session.actor,
            request: parsed,
            assignmentCount
          });
          const alreadyPersisted = await repository.getBatch(
            targetWorkspaceId,
            intent.batchId
          );
          if (alreadyPersisted) {
            return startReceiptForPersistedBatch({
              repository,
              workspaceId: targetWorkspaceId,
              batch: alreadyPersisted,
              activeRun: activeRuns.get(alreadyPersisted.batchId),
              locks: assignmentLocks
            });
          }

          let resolveStarted!: (registration: {
            readonly batchId: string;
            readonly createdAt: string;
            readonly assignmentIds: readonly string[];
            readonly sessions: readonly PlaytestSessionReference[];
          }) => void;
          let rejectStarted!: (error: unknown) => void;
          let registeredBatchId: string | null = null;
          const started = new Promise<{
            readonly batchId: string;
            readonly createdAt: string;
            readonly assignmentIds: readonly string[];
            readonly sessions: readonly PlaytestSessionReference[];
          }>((resolve, reject) => {
            resolveStarted = resolve;
            rejectStarted = reject;
          });
          const execution = executeApprovedVisualBatch({
            session,
            workspaceId: targetWorkspaceId,
            target,
            request: parsed,
            requestedBatchId: intent.batchId,
            createdAt: intent.createdAt,
            artifacts,
            repository,
            visualTargetRepository,
            readWorkspaceCatalog,
            activeRuns,
            assignmentLocks,
            openVisualDriver:
              options.openVisualDriver ??
              ((driverOptions) =>
                PlaytestVisualBrowserDriver.open(driverOptions)),
            createVisualPolicy,
            onRegistered(batchId, createdAt, assignmentIds, sessions) {
              registeredBatchId = batchId;
              resolveStarted({ batchId, createdAt, assignmentIds, sessions });
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
                    cancellationReason === null
                      ? ((result as any).status ?? "completed")
                      : "cancelled",
                  cancellationReason,
                  result: result as any,
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
          const registration = await started;
          const active = activeRuns.get(registration.batchId);
          const completed = completedRuns.get(registration.batchId);
          return {
            ...registration,
            assignmentCount,
            status: active
              ? active.phase
              : (completed?.status.status ?? "running")
          };
        }

        const approval = activeRunApproval(
          approvalRepository,
          targetWorkspaceId
        );
        const artifacts = artifactStoreForWorkspace(targetWorkspaceId);
        // One latest-commit resolution per batch: every assignment, the frozen
        // manifest and each sandbox run that exact snapshot.
        const prepared = prepareSandboxHandler(approval);
        let assignments: readonly PlaytestLaunchAssignment[];
        let branchPlan: BranchExecutionPlan | null = null;
        if (parsed.operation.kind === "branch") {
          const resolved = await resolveBranchExecutionPlan({
            request: parsed.operation,
            workspaceId: targetWorkspaceId,
            approval,
            prepared,
            repository,
            artifacts
          });
          assignments = resolved.assignments;
          branchPlan = resolved.branchPlan;
        } else {
          assignments = parsed.operation.assignments;
        }

        const intent = await reserveLaunchIntent({
          repository: intentRepository,
          workspaceId: targetWorkspaceId,
          actorId: session.actor,
          request: parsed,
          assignmentCount
        });
        const alreadyPersisted = await repository.getBatch(
          targetWorkspaceId,
          intent.batchId
        );
        if (alreadyPersisted) {
          return startReceiptForPersistedBatch({
            repository,
            workspaceId: targetWorkspaceId,
            batch: alreadyPersisted,
            activeRun: activeRuns.get(alreadyPersisted.batchId),
            locks: assignmentLocks
          });
        }

        let resolveStarted!: (registration: {
          readonly batchId: string;
          readonly createdAt: string;
          readonly assignmentIds: readonly string[];
          readonly sessions: readonly PlaytestSessionReference[];
        }) => void;
        let rejectStarted!: (error: unknown) => void;
        let registeredBatchId: string | null = null;
        const started = new Promise<{
          readonly batchId: string;
          readonly createdAt: string;
          readonly assignmentIds: readonly string[];
          readonly sessions: readonly PlaytestSessionReference[];
        }>((resolve, reject) => {
          resolveStarted = resolve;
          rejectStarted = reject;
        });
        const execution = executeApprovedBatch({
          session,
          workspaceId: targetWorkspaceId,
          approval,
          requestedBatchId: intent.batchId,
          createdAt: intent.createdAt,
          assignments,
          branchPlan,
          prepared,
          artifacts,
          repository,
          approvalRepository: approvalRepository!,
          readWorkspaceCatalog,
          launchSandbox: launchSandboxHandler ?? launchPlaytestSandbox,
          runEpisode: runEpisodeHandler,
          activeRuns,
          assignmentLocks,
          onRegistered(batchId, createdAt, assignmentIds, sessions) {
            registeredBatchId = batchId;
            resolveStarted({ batchId, createdAt, assignmentIds, sessions });
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
                  cancellationReason === null ? result.status : "cancelled",
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
        const registration = await started;
        const active = activeRuns.get(registration.batchId);
        const completed = completedRuns.get(registration.batchId);
        return {
          ...registration,
          assignmentCount,
          status: active
            ? active.phase
            : (completed?.status.status ?? "running")
        };
      });
    },
    async lookupRunByRequest(session, workspaceId, requestId) {
      assertRunStatusReader(session);
      const authorizedWorkspaceId = authorizeExistingRunWorkspace(
        session,
        workspaceId,
        readWorkspaceCatalog
      );
      if (!LAUNCH_INTENT_REQUEST_ID_PATTERN.test(requestId)) {
        throw new PlaytestMcpValidationError("requestId is invalid.");
      }
      const intent = await requiredLaunchIntentRepository(
        options.launchIntentRepository
      ).getLaunchIntent(authorizedWorkspaceId, session.actor, requestId);
      if (!intent) {
        return {
          requestId,
          state: "not-found",
          batchId: null,
          assignmentCount: null,
          assignmentIds: [],
          sessions: [],
          createdAt: null,
          status: null
        };
      }
      if (
        intent.workspaceId !== authorizedWorkspaceId ||
        intent.actorId !== session.actor ||
        intent.requestId !== requestId
      ) {
        throw new PlaytestMcpUnavailableError(
          "Launch-intent storage returned a mismatched identity."
        );
      }
      if (Date.parse(intent.expiresAt) <= Date.now()) {
        return {
          requestId,
          state: "expired",
          batchId: null,
          assignmentCount: null,
          assignmentIds: [],
          sessions: [],
          createdAt: null,
          status: null
        };
      }
      const repository = requiredRunRepository(playtestRepository);
      const activeRun = activeRuns.get(intent.batchId);
      if (activeRun) {
        if (
          activeRun.batchId !== intent.batchId ||
          activeRun.workspaceId !== authorizedWorkspaceId ||
          activeRun.assignmentCount !== intent.assignmentCount ||
          activeRun.assignmentIds.length !== intent.assignmentCount ||
          activeRun.sessions.length !== intent.assignmentCount
        ) {
          throw new PlaytestMcpUnavailableError(
            "The active launch receipt does not match its workspace-scoped intent."
          );
        }
        return {
          requestId,
          state: "accepted",
          ...startReceiptForActiveRun(activeRun)
        };
      }
      const batch = await repository.getBatch(
        authorizedWorkspaceId,
        intent.batchId
      );
      if (!batch) {
        return {
          requestId,
          state: "pending",
          batchId: intent.batchId,
          assignmentCount: intent.assignmentCount,
          assignmentIds: [],
          sessions: [],
          createdAt: intent.createdAt,
          status: null
        };
      }
      if (
        batch.batchId !== intent.batchId ||
        batch.workspaceId !== authorizedWorkspaceId ||
        batch.budget.assignedEpisodes !== intent.assignmentCount
      ) {
        throw new PlaytestMcpUnavailableError(
          "The persisted launch receipt does not match its workspace-scoped frozen batch."
        );
      }
      const receipt = await startReceiptForPersistedBatch({
        repository,
        workspaceId: authorizedWorkspaceId,
        batch,
        activeRun: activeRuns.get(batch.batchId),
        locks: assignmentLocks
      });
      return {
        requestId,
        state: "accepted",
        ...receipt
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
          sessions: run.sessions,
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
      const activeAnalysts = [...activeAnalystRuns.values()];
      for (const run of active) cancelActiveRun(run, "cancelled");
      for (const analysis of activeAnalysts) analysis.process.terminate();
      if (active.length === 0 && activeAnalysts.length === 0) return;
      let timeout: NodeJS.Timeout | undefined;
      try {
        await Promise.race([
          Promise.allSettled([
            ...active.map((run) => run.completion),
            ...activeAnalysts.map((analysis) => analysis.process.completion)
          ]),
          new Promise<void>((resolve) => {
            timeout = setTimeout(resolve, RUN_SHUTDOWN_GRACE_MS);
          })
        ]);
      } finally {
        if (timeout) clearTimeout(timeout);
      }
    },
    dispatchCrossSessionReview(session, workspaceId, episodeIds) {
      assertPlaytestToolRole(
        session.role,
        ANALYST_DISPATCH_ROLES,
        "Console playtest analyst dispatch"
      );
      const authorizedWorkspaceId = authorizeWorkspace(workspaceId, session);
      const uniqueEpisodeIds = [...new Set(episodeIds)];
      if (
        uniqueEpisodeIds.length === 0 ||
        uniqueEpisodeIds.length > PLAYTESTS_MAX_ANALYSIS_SESSIONS ||
        uniqueEpisodeIds.length !== episodeIds.length
      ) {
        throw new PlaytestMcpValidationError(
          `Analyst dispatch requires 1-${String(PLAYTESTS_MAX_ANALYSIS_SESSIONS)} distinct sessions.`
        );
      }
      return withAssignmentLock(
        assignmentLocks,
        "analyst-review-dispatch",
        async () => {
          if (!launchAnalystProcess) {
            throw new PlaytestMcpUnavailableError(
              "Runtime analyst dispatch is not configured."
            );
          }
          if (activeAnalystRuns.size >= MAX_ACTIVE_ANALYST_RUNS) {
            throw new PlaytestMcpUnavailableError(
              "Runtime analyst capacity is full; wait for a current review to finish."
            );
          }

          const visualRepository = requiredRunRepository(playtestRepository);
          const firstEpisode = await visualRepository.getEpisode(
            authorizedWorkspaceId,
            uniqueEpisodeIds[0]!
          );
          const firstBatch =
            firstEpisode === null
              ? null
              : await visualRepository.getBatch(
                  authorizedWorkspaceId,
                  firstEpisode.batchId
                );
          if (firstBatch?.executionMode === "autonomous-visual") {
            if (uniqueEpisodeIds.length !== 1) {
              throw new PlaytestMcpValidationError(
                "Visual discovery reviews are dispatched one episode at a time and cannot be mixed with adapter confirmatory reviews."
              );
            }
            if (
              firstBatch.assignmentInventory.status !== "frozen-visual" ||
              firstBatch.status === "running" ||
              firstBatch.status === "queued"
            ) {
              throw new PlaytestMcpUnavailableError(
                "Visual discovery review requires a terminal run and its frozen visual assignment manifest."
              );
            }
            const episode = firstEpisode!;
            if (episode.stepCount < 1 || episode.trace === null) {
              return {
                run: null,
                packets: [],
                receipts: [
                  {
                    episodeId: episode.episodeId,
                    batchId: firstBatch.batchId,
                    reason: "packet-unavailable",
                    detail:
                      "The visual session has no persisted trace steps to review."
                  }
                ],
                budget: []
              };
            }
            const activeDiscoveryReservations = [...analystReviewRuns.values()]
              .filter(
                (run) =>
                  run.workspaceId === authorizedWorkspaceId &&
                  run.analysisKind === "discovery" &&
                  run.status === "running"
              )
              .flatMap((run) =>
                run.packets
                  .filter((packet) => packet.batchId === firstBatch.batchId)
                  .map((packet) => packet.episodeId)
              );
            const assignmentLimit =
              firstBatch.assignmentInventory.manifest.assignments.length;
            const assignmentEpisodeIds =
              firstBatch.assignmentInventory.manifest.assignments.map(
                (assignment) =>
                  playtestVisualEpisodeRecordId(
                    firstBatch.batchId,
                    assignment.assignmentId
                  )
              );
            const priorDiscoveryReviews = await mapConcurrentOrdered(
              assignmentEpisodeIds,
              4,
              (episodeId) =>
                visualRepository.getLatestDiscoveryReviewForEpisode(
                  authorizedWorkspaceId,
                  episodeId
                )
            );
            const actualCritiques = priorDiscoveryReviews.filter(
              (review) => review !== null
            ).length;
            const reserved = activeDiscoveryReservations.length;
            const remaining = Math.max(
              0,
              assignmentLimit - actualCritiques - reserved
            );
            const budget: PlaytestCrossSessionBudget = {
              batchId: firstBatch.batchId,
              reviewCap: assignmentLimit,
              actualCritiques,
              reserved,
              requested: 1,
              remaining
            };
            if (activeDiscoveryReservations.includes(episode.episodeId)) {
              return {
                run: null,
                packets: [],
                receipts: [
                  {
                    episodeId: episode.episodeId,
                    batchId: firstBatch.batchId,
                    reason: "review-already-running",
                    detail:
                      "A discovery review for this visual episode is already running."
                  }
                ],
                budget: [budget]
              };
            }
            const currentAssignmentIndex =
              firstBatch.assignmentInventory.manifest.assignments.findIndex(
                (assignment) => assignment.assignmentId === episode.assignmentId
              );
            const existingReview =
              currentAssignmentIndex < 0
                ? null
                : (priorDiscoveryReviews[currentAssignmentIndex] ?? null);
            if (existingReview !== null) {
              return {
                run: null,
                packets: [],
                receipts: [
                  {
                    episodeId: episode.episodeId,
                    batchId: firstBatch.batchId,
                    reason: "review-already-submitted",
                    detail:
                      "This visual discovery episode already has a persisted analyst review."
                  }
                ],
                budget: [budget]
              };
            }
            if (remaining < 1) {
              return {
                run: null,
                packets: [],
                receipts: [
                  {
                    episodeId: episode.episodeId,
                    batchId: firstBatch.batchId,
                    reason: "critique-budget-exhausted",
                    detail:
                      "The visual batch's one-review-per-frozen-assignment discovery cap is exhausted."
                  }
                ],
                budget: [budget]
              };
            }
            const preparedPacket = await readPreparedReviewPacket({
              workspaceId: authorizedWorkspaceId,
              episode,
              repository: visualRepository,
              artifacts: artifactStoreForWorkspace(authorizedWorkspaceId)
            });
            if (preparedPacket.analysisKind !== "discovery") {
              throw new PlaytestMcpUnavailableError(
                "Visual discovery packet preparation returned a confirmatory packet."
              );
            }
            const packet: PlaytestCrossSessionPacket = {
              episodeId: episode.episodeId,
              batchId: firstBatch.batchId,
              packet: preparedPacket.packet,
              artifact: preparedPacket.artifact
            };
            const analysisId = randomUUID();
            const createdAt = new Date().toISOString();
            const record: PlaytestAnalystReviewRun = {
              analysisId,
              workspaceId: authorizedWorkspaceId,
              analysisKind: "discovery",
              status: "running",
              createdAt,
              finishedAt: null,
              requestedEpisodeIds: uniqueEpisodeIds,
              packets: [
                {
                  episodeId: episode.episodeId,
                  batchId: firstBatch.batchId,
                  packetId: preparedPacket.packet.packetId
                }
              ],
              receipts: [],
              budget: [
                {
                  ...budget,
                  reserved: budget.reserved + 1,
                  remaining: Math.max(0, budget.remaining - 1)
                }
              ],
              reviews: [],
              synthesisId: null,
              error: null
            };
            let process: PlaytestAnalystProcess;
            try {
              process = launchAnalystProcess({
                analysisId,
                workspaceId: authorizedWorkspaceId,
                actor: session.actor,
                episodeIds: uniqueEpisodeIds,
                analysisKind: "discovery",
                metricAggregation: null
              });
            } catch (error) {
              throw new PlaytestMcpUnavailableError(
                error instanceof Error
                  ? error.message
                  : "The discovery analyst process could not be started."
              );
            }
            analystReviewRuns.set(analysisId, record);
            activeAnalystRuns.set(analysisId, { process });
            void process.completion.then(
              (result) => finalizeAnalystRun(analysisId, result),
              () =>
                finalizeAnalystRun(analysisId, {
                  exitCode: null,
                  signal: null,
                  timedOut: false,
                  launchFailed: true,
                  diagnostic: null
                })
            );
            pruneAnalystReviewHistory();
            return {
              run: record,
              packets: [packet],
              receipts: [],
              budget: record.budget
            };
          }

          const prepared = await prepareCrossSessionReview({
            workspaceId: authorizedWorkspaceId,
            episodeIds: uniqueEpisodeIds,
            selectionLimit: PLAYTESTS_MAX_ANALYSIS_SESSIONS,
            repository: requiredRunRepository(playtestRepository),
            artifacts: safeArtifactStoreForWorkspace(
              authorizedWorkspaceId,
              artifactStoreForWorkspace
            )
          });
          const receipts = [...prepared.receipts];
          const activeEpisodeIds = new Set(
            [...analystReviewRuns.values()]
              .filter(
                (run) =>
                  run.workspaceId === authorizedWorkspaceId &&
                  run.status === "running"
              )
              .flatMap((run) => run.packets.map((packet) => packet.episodeId))
          );
          const reservationSnapshot = await unpersistedAnalystReservations(
            authorizedWorkspaceId,
            prepared.budget.map((entry) => entry.batchId)
          );
          const currentBudgets = prepared.budget.map((entry) => {
            const batch = reservationSnapshot.batches.get(entry.batchId);
            if (
              !batch ||
              batch.status !== "completed" ||
              batch.reviewSelection.status !== "selected" ||
              batch.assignmentInventory.status !== "frozen" ||
              batch.coverageManifest === null
            ) {
              throw new PlaytestMcpUnavailableError(
                "A selected review batch changed before analyst dispatch."
              );
            }
            return {
              ...entry,
              reviewCap: batch.reviewSelection.reviewCap,
              actualCritiques: batch.budget.actualCritiques,
              reserved: batch.reviewReceipts.filter(
                (receipt) => receipt.status === "reserved"
              ).length,
              remaining: Math.max(
                0,
                batch.reviewSelection.reviewCap -
                  batch.budget.actualCritiques -
                  batch.reviewReceipts.filter(
                    (receipt) => receipt.status === "reserved"
                  ).length
              )
            };
          });
          const remainingByBatch = new Map(
            currentBudgets.map((entry) => [
              entry.batchId,
              Math.max(
                0,
                entry.remaining -
                  (reservationSnapshot.counts.get(entry.batchId) ?? 0)
              )
            ])
          );
          const newlyReservedByBatch = new Map<string, number>();
          const packets: PlaytestCrossSessionPacket[] = [];
          const repository = requiredRunRepository(playtestRepository);
          const packetReviewStates = await Promise.all(
            prepared.packets.map(async (packet) => ({
              packet,
              alreadyRunning: activeEpisodeIds.has(packet.episodeId),
              latest: activeEpisodeIds.has(packet.episodeId)
                ? null
                : await repository.getLatestReviewForEpisode(
                    authorizedWorkspaceId,
                    packet.episodeId
                  )
            }))
          );
          for (const { packet, alreadyRunning, latest } of packetReviewStates) {
            if (alreadyRunning) {
              receipts.push({
                episodeId: packet.episodeId,
                batchId: packet.batchId,
                reason: "review-already-running",
                detail:
                  "An analyst review for this selected packet is already running."
              });
              continue;
            }
            if (latest?.evidencePacket?.packetId === packet.packet.packetId) {
              receipts.push({
                episodeId: packet.episodeId,
                batchId: packet.batchId,
                reason: "review-already-submitted",
                detail:
                  "This exact frozen evidence packet already has a submitted analyst review."
              });
              continue;
            }
            const remaining = remainingByBatch.get(packet.batchId) ?? 0;
            if (remaining < 1) {
              receipts.push({
                episodeId: packet.episodeId,
                batchId: packet.batchId,
                reason: "critique-budget-exhausted",
                detail:
                  "The workspace's remaining critique capacity is reserved by another active analyst review."
              });
              continue;
            }
            remainingByBatch.set(packet.batchId, remaining - 1);
            newlyReservedByBatch.set(
              packet.batchId,
              (newlyReservedByBatch.get(packet.batchId) ?? 0) + 1
            );
            packets.push(packet);
          }
          if (packets.length === 0) {
            return {
              run: null,
              packets,
              receipts,
              budget: prepared.budget
            };
          }
          if (activeAnalystRuns.size >= MAX_ACTIVE_ANALYST_RUNS) {
            throw new PlaytestMcpUnavailableError(
              "Runtime analyst capacity filled before this review could start."
            );
          }

          const analysisId = randomUUID();
          const createdAt = new Date().toISOString();
          const confirmatoryPackets = packets.filter(
            (
              packet
            ): packet is PlaytestCrossSessionPacket & {
              readonly packet: PlaytestEvidencePacket;
            } => "rubricHash" in packet.packet
          );
          if (confirmatoryPackets.length !== packets.length) {
            throw new PlaytestMcpValidationError(
              "Confirmatory analysis cannot aggregate visual discovery packets."
            );
          }
          const metricAggregation = aggregatePlaytestCrossSessionMetrics({
            workspaceId: authorizedWorkspaceId,
            analysisId,
            packets: confirmatoryPackets
          });
          const record: PlaytestAnalystReviewRun = {
            analysisId,
            workspaceId: authorizedWorkspaceId,
            analysisKind: "confirmatory",
            status: "running",
            createdAt,
            finishedAt: null,
            requestedEpisodeIds: uniqueEpisodeIds,
            packets: packets.map(({ episodeId, batchId, packet }) => ({
              episodeId,
              batchId,
              packetId: packet.packetId
            })),
            receipts,
            budget: currentBudgets.map((entry) => {
              const activeReserved =
                (reservationSnapshot.counts.get(entry.batchId) ?? 0) +
                (newlyReservedByBatch.get(entry.batchId) ?? 0);
              return {
                ...entry,
                reserved: entry.reserved + activeReserved,
                remaining: Math.max(0, entry.remaining - activeReserved)
              };
            }),
            reviews: [],
            synthesisId: null,
            error: null
          };
          let process: PlaytestAnalystProcess;
          try {
            process = launchAnalystProcess({
              analysisId,
              workspaceId: authorizedWorkspaceId,
              actor: session.actor,
              episodeIds: packets.map((packet) => packet.episodeId),
              analysisKind: "confirmatory",
              metricAggregation
            });
          } catch (error) {
            throw new PlaytestMcpUnavailableError(
              error instanceof Error
                ? error.message
                : "The analyst process could not be started."
            );
          }
          analystReviewRuns.set(analysisId, record);
          activeAnalystRuns.set(analysisId, { process });
          void process.completion.then(
            (result) => finalizeAnalystRun(analysisId, result),
            () =>
              finalizeAnalystRun(analysisId, {
                exitCode: null,
                signal: null,
                timedOut: false,
                launchFailed: true,
                diagnostic: null
              })
          );
          pruneAnalystReviewHistory();
          return {
            run: record,
            packets,
            receipts,
            budget: record.budget
          };
        }
      );
    },
    async listAnalystReviewRuns(session, workspaceId) {
      assertPlaytestToolRole(
        session.role,
        ANALYST_STATUS_READER_ROLES,
        "Console playtest analyst status"
      );
      const authorizedWorkspaceId = authorizeWorkspace(workspaceId, session);
      const repository = requiredRunRepository(playtestRepository);
      const workspaceRuns = [...analystReviewRuns.values()]
        .filter((run) => run.workspaceId === authorizedWorkspaceId)
        .sort((left, right) =>
          ANALYST_REVIEW_RUN_COLLATOR.compare(right.createdAt, left.createdAt)
        );
      const active = workspaceRuns.filter((run) => run.status === "running");
      const recent = workspaceRuns
        .filter((run) => run.status !== "running")
        .slice(0, Math.max(0, 20 - active.length));
      const persistedSyntheses = await repository.listCrossSessionSyntheses(
        authorizedWorkspaceId,
        { limit: 20 }
      );
      return {
        runs: [...active, ...recent].sort((left, right) =>
          ANALYST_REVIEW_RUN_COLLATOR.compare(right.createdAt, left.createdAt)
        ),
        syntheses: persistedSyntheses.rows
      };
    },
    prepareCrossSessionReview(receivedSession, workspaceId, episodeIds) {
      assertPlaytestToolRole(
        receivedSession.role,
        CROSS_SESSION_PACKET_READER_ROLES,
        "playtest.prepareCrossSessionReview"
      );
      const authorizedWorkspaceId = authorizeWorkspace(
        workspaceId,
        receivedSession
      );
      if (!playtestRepository) {
        throw new PlaytestMcpUnavailableError(
          "Playtest Data storage is unavailable for analyst packet retrieval."
        );
      }
      return prepareCrossSessionReview({
        workspaceId: authorizedWorkspaceId,
        episodeIds,
        selectionLimit: PLAYTESTS_MAX_CROSS_SESSION_PACKET_SESSIONS,
        repository: playtestRepository,
        // A store that cannot be opened is not a selection that failed: it is
        // a packet that could not be read, and is reported per session rather
        // than collapsing the whole dispatch into one opaque error.
        artifacts: safeArtifactStoreForWorkspace(
          authorizedWorkspaceId,
          artifactStoreForWorkspace
        )
      });
    }
  };
  return playtestRunControl;
}

/**
 * A selection is explicit and bounded: the operator names the sessions, and a
 * session that cannot contribute evidence comes back as a named receipt rather
 * than being dropped from the result.
 */

/** Why a selected session could not contribute an analyst packet. */
type CrossSessionReceiptReason =
  | "unknown-session"
  | "excluded-ineligible-session"
  | "batch-not-completed"
  | "not-selected-for-review"
  | "critique-budget-exhausted"
  | "packet-unavailable"
  | "not-authorized"
  | "review-already-running"
  | "review-already-submitted";

export interface PlaytestCrossSessionReceipt {
  readonly episodeId: string;
  readonly batchId: string | null;
  readonly reason: CrossSessionReceiptReason;
  /** Named, not a fabricated packet: why this session contributed nothing. */
  readonly detail: string;
}

export interface PlaytestCrossSessionPacket {
  readonly episodeId: string;
  readonly batchId: string;
  readonly packet: PlaytestEvidencePacket | PlaytestDiscoveryEvidencePacketV3;
  readonly artifact: PlaytestArtifactReference;
}

/** Per-batch critique headroom, so a selection cannot quietly overspend. */
export interface PlaytestCrossSessionBudget {
  readonly batchId: string;
  readonly reviewCap: number;
  readonly actualCritiques: number;
  readonly reserved: number;
  readonly requested: number;
  readonly remaining: number;
}

/**
 * Sessions that cannot support an analyst claim: partial, cancelled, crashed,
 * infrastructure-failed or truncated. Excluded here and reported, so an
 * analyst never reasons over a session whose evidence is incomplete.
 */
function crossSessionIneligibility(
  episode: PlaytestEpisode,
  batch: PlaytestBatch | null
): string | null {
  if (!batch) return "The session's batch is not available in this workspace.";
  if (batch.status !== "completed") {
    return `The session's batch is ${batch.status}, not completed.`;
  }
  if (batch.executionMode !== PLAYTEST_ADAPTER_MODE) {
    return "Autonomous visual sessions require discovery review and cannot enter adapter confirmatory analysis.";
  }
  switch (episode.status) {
    case "completed": {
      return null;
    }
    case "assigned":
    case "started": {
      return `The session is partial (${episode.status}).`;
    }
    case "crashed": {
      return "The session crashed.";
    }
    case "infrastructure-failed": {
      return "The session became infrastructure loss.";
    }
    case "cancelled": {
      return "The session was cancelled.";
    }
    case "budget-truncated": {
      return "The session was truncated before completion.";
    }
    default: {
      return "The session state is not analysable.";
    }
  }
}

/**
 * A store that cannot be opened still has a bounded, typed shape, so callers
 * report a packet that could not be read instead of failing opaquely.
 */
function safeArtifactStoreForWorkspace(
  workspaceId: string,
  open: (workspaceId: string) => PlaytestArtifactStore
): PlaytestArtifactStore {
  try {
    return open(workspaceId);
  } catch (error) {
    const detail = error instanceof Error ? error.message : "";
    return {
      boundWorkspaceId: () => workspaceId,
      referenceForId: () => null,
      readArtifact: () => {
        throw new PlaytestMcpUnavailableError(
          `Evidence artifact storage is unavailable${detail === "" ? "." : `: ${detail}`}`
        );
      }
    } as unknown as PlaytestArtifactStore;
  }
}

async function readPreparedReviewPacket(input: {
  readonly workspaceId: string;
  readonly episode: PlaytestEpisode;
  readonly repository: PlaytestingRepositoryOps;
  readonly artifacts: PlaytestArtifactStore;
}): Promise<
  | {
      readonly analysisKind: "confirmatory";
      readonly packet: PlaytestEvidencePacket;
      readonly artifact: PlaytestArtifactReference;
    }
  | {
      readonly analysisKind: "discovery";
      readonly packet: PlaytestDiscoveryEvidencePacketV3;
      readonly artifact: PlaytestArtifactReference;
    }
> {
  const { workspaceId, episode, repository, artifacts } = input;
  if (!episode.assignmentId) {
    throw new PlaytestMcpValidationError(
      "Historical episodes without frozen assignment identity have no analyst packet."
    );
  }
  const batch = await repository.getBatch(workspaceId, episode.batchId);
  if (!batch) {
    throw new PlaytestMcpUnavailableError(
      "The episode's batch is unavailable in the authorized workspace."
    );
  }
  if (batch.executionMode === "autonomous-visual") {
    try {
      const prepared = preparePlaytestDiscoveryEvidencePacket({
        workspaceId,
        episode,
        batch,
        artifacts
      });
      return {
        analysisKind: "discovery",
        packet: prepared.packet,
        artifact: prepared.artifact
      };
    } catch (error) {
      throw new PlaytestMcpUnavailableError(
        error instanceof Error
          ? "The visual discovery packet is unavailable: " + error.message
          : "The visual discovery packet is unavailable."
      );
    }
  }
  if (
    batch.executionMode !== PLAYTEST_ADAPTER_MODE ||
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
      receipt.failureReason === PACKET_OBSERVATION_EQUIVALENCE_UNVERIFIED_REASON
        ? OBSERVATION_EQUIVALENCE_UNVERIFIED_DETAIL
        : "The selected session packet is unavailable: " +
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
  return { analysisKind: "confirmatory", packet: typed, artifact: reference };
}

/**
 * Prepare packets for analysis over an explicit, bounded selection.
 *
 * Runtime owns the whole decision: eligibility, the per-batch critique cap,
 * and which selected sessions yielded packet-unavailable receipts. Every
 * excluded or unreadable session is reported by name; nothing is dropped
 * silently, because a silently dropped session would make the analyst's
 * cross-session claims look grounded in evidence that was never read.
 */
interface EligibleCrossSessionSelection {
  readonly episodeId: string;
  readonly episode: PlaytestEpisode;
  readonly batch: PlaytestAdapterBatch;
}

type CrossSessionResolution =
  | {
      readonly kind: "eligible";
      readonly selection: EligibleCrossSessionSelection;
    }
  | { readonly kind: "receipt"; readonly receipt: PlaytestCrossSessionReceipt };

async function resolveCrossSessionEpisode(
  workspaceId: string,
  episodeId: string,
  repository: PlaytestingRepositoryOps
): Promise<CrossSessionResolution> {
  const episode = await repository.getEpisode(workspaceId, episodeId);
  if (!episode) {
    return {
      kind: "receipt",
      receipt: {
        episodeId,
        batchId: null,
        reason: "unknown-session",
        detail: "The session does not exist in the authorized workspace."
      }
    };
  }
  const batch = await repository.getBatch(workspaceId, episode.batchId);
  const ineligible = crossSessionIneligibility(episode, batch);
  if (ineligible !== null || !batch) {
    return {
      kind: "receipt",
      receipt: {
        episodeId,
        batchId: episode.batchId,
        reason: "excluded-ineligible-session",
        detail: ineligible ?? "The session's batch is unavailable."
      }
    };
  }
  if (batch.executionMode !== PLAYTEST_ADAPTER_MODE) {
    return {
      kind: "receipt",
      receipt: {
        episodeId,
        batchId: episode.batchId,
        reason: "excluded-ineligible-session",
        detail:
          "Autonomous visual sessions require discovery review and cannot enter adapter confirmatory analysis."
      }
    };
  }
  if (
    batch.reviewSelection.status !== "selected" ||
    batch.assignmentInventory.status !== "frozen" ||
    batch.coverageManifest === null
  ) {
    return {
      kind: "receipt",
      receipt: {
        episodeId,
        batchId: episode.batchId,
        reason: "not-selected-for-review",
        detail: "The session's batch has no persisted frozen review selection."
      }
    };
  }
  // Membership is checked here so an unselected session is reported as
  // ineligible selection rather than surfacing as an authorization failure.
  if (
    episode.assignmentId !== null &&
    !batch.reviewSelection.selected.some(
      (entry) =>
        entry.assignmentId === episode.assignmentId &&
        entry.episodeId === episode.episodeId
    )
  ) {
    return {
      kind: "receipt",
      receipt: {
        episodeId,
        batchId: episode.batchId,
        reason: "not-selected-for-review",
        detail:
          "The session was not among the frozen bounded review selection for its batch."
      }
    };
  }
  return {
    kind: "eligible",
    selection: { episodeId, episode, batch }
  };
}

async function prepareCrossSessionReview(input: {
  readonly workspaceId: string;
  readonly episodeIds: readonly string[];
  readonly selectionLimit: number;
  readonly repository: PlaytestingRepositoryOps;
  readonly artifacts: PlaytestArtifactStore;
}): Promise<{
  readonly packets: readonly PlaytestCrossSessionPacket[];
  readonly receipts: readonly PlaytestCrossSessionReceipt[];
  readonly budget: readonly PlaytestCrossSessionBudget[];
}> {
  const { workspaceId, episodeIds, selectionLimit, repository, artifacts } =
    input;
  const unique = [...new Set(episodeIds)];
  if (unique.length === 0 || unique.length > selectionLimit) {
    throw new PlaytestMcpValidationError(
      `A cross-session analysis must name between 1 and ${String(selectionLimit)} distinct sessions.`
    );
  }

  // Resolve eligibility concurrently, retaining request order so budget sampling
  // and receipts remain deterministic for the same explicit selection.
  const resolution = await Promise.all(
    unique.map((episodeId) =>
      resolveCrossSessionEpisode(workspaceId, episodeId, repository)
    )
  );
  const resolved = resolution.flatMap((entry) =>
    entry.kind === "eligible" ? [entry.selection] : []
  );
  const receipts = resolution.flatMap((entry) =>
    entry.kind === "receipt" ? [entry.receipt] : []
  );

  // The per-batch cap is checked across the whole selection, not per session:
  // N sessions that each fit under the cap must still not exceed it together.
  const selectionsByBatch = new Map<string, EligibleCrossSessionSelection[]>();
  for (const selection of resolved) {
    const group = selectionsByBatch.get(selection.batch.batchId) ?? [];
    group.push(selection);
    selectionsByBatch.set(selection.batch.batchId, group);
  }
  const budgets: PlaytestCrossSessionBudget[] = [];
  const allowed = new Map<string, ReadonlySet<string>>();
  for (const [batchId, selections] of selectionsByBatch) {
    const batch = selections[0]!.batch;
    if (batch.reviewSelection.status !== "selected") continue;
    const requested = selections.length;
    const reserved = batch.reviewReceipts.filter(
      (receipt) => receipt.status === "reserved"
    ).length;
    const remaining = Math.max(
      0,
      batch.reviewSelection.reviewCap - batch.budget.actualCritiques - reserved
    );
    budgets.push({
      batchId,
      reviewCap: batch.reviewSelection.reviewCap,
      actualCritiques: batch.budget.actualCritiques,
      reserved,
      requested,
      remaining
    });
    allowed.set(
      batchId,
      new Set(
        selections.slice(0, remaining).map((selection) => selection.episodeId)
      )
    );
  }

  const packetResults = await mapConcurrentOrdered(
    resolved,
    CROSS_SESSION_PACKET_READ_CONCURRENCY,
    async (selection) => {
      const { episodeId, episode, batch } = selection;
      if (!(allowed.get(batch.batchId)?.has(episodeId) ?? false)) {
        return {
          kind: "receipt" as const,
          receipt: {
            episodeId,
            batchId: batch.batchId,
            reason: "critique-budget-exhausted" as const,
            detail:
              "The batch's frozen critique cap cannot cover this selection; the sessions past the cap are excluded rather than analysed unbudgeted."
          }
        };
      }
      try {
        const prepared = await readPreparedReviewPacket({
          workspaceId,
          episode,
          repository,
          artifacts
        });
        if (prepared.analysisKind !== "confirmatory") {
          return {
            kind: "receipt" as const,
            receipt: {
              episodeId,
              batchId: batch.batchId,
              reason: "excluded-ineligible-session" as const,
              detail:
                "Visual discovery packets cannot enter adapter confirmatory cross-session analysis."
            }
          };
        }
        return {
          kind: "packet" as const,
          packet: {
            episodeId,
            batchId: batch.batchId,
            packet: prepared.packet,
            artifact: prepared.artifact
          }
        };
      } catch (error) {
        return {
          kind: "receipt" as const,
          receipt: {
            episodeId,
            batchId: batch.batchId,
            reason:
              error instanceof PlaytestMcpAuthorizationError
                ? ("not-authorized" as const)
                : ("packet-unavailable" as const),
            detail:
              error instanceof Error
                ? error.message
                : "The session packet could not be read."
          }
        };
      }
    }
  );
  const packets = packetResults.flatMap((entry) =>
    entry.kind === "packet" ? [entry.packet] : []
  );
  receipts.push(
    ...packetResults.flatMap((entry) =>
      entry.kind === "receipt" ? [entry.receipt] : []
    )
  );

  return {
    packets,
    receipts,
    budget: budgets.sort((a, b) =>
      ANALYST_REVIEW_RUN_COLLATOR.compare(a.batchId, b.batchId)
    )
  };
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
  options: PlaytestMcpOptions & {
    readonly playtestRunControl: PlaytestRunControl;
  }
): McpServer & { readonly playtestRunControl: PlaytestRunControl };
export function createPlaytestMcpServer(
  options: PlaytestMcpOptions
): PlaytestMcpServer;
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
    prepareSandboxHandler = preparePlaytestSandbox
  } = options;
  const preparedAnalystPackets = new Map<string, PlaytestEvidencePacket>();

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
        return requirePlaytestRunControl(playtestRunControl).getCapabilities(
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
        "Start one versioned PlaytestLaunchRequest with a capabilityRevision from playtest.capabilities and a unique client requestId that remains stable across uncertain retries. mode=adapter-accelerated with operation.kind=batch runs an ordered approved assignment set; mode=autonomous-visual requires a Workspaces-approved target and policyId=smart-direct; mode=scripted-regression requires an approved replay recipe. Runtime refuses unavailable modes and never substitutes another mode.",
      inputSchema: z.strictObject({
        launchRequest: playtestLaunchRequestSchema
      })
    },
    ({ launchRequest }) =>
      safely(async () => {
        const session = await sessionProvider.current();
        return requirePlaytestRunControl(playtestRunControl).startRun(
          session,
          launchRequest
        );
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
          runs: await requirePlaytestRunControl(
            playtestRunControl
          ).listActiveRuns(session, targetWorkspaceId)
        };
      })
  );

  mcp.registerTool(
    "playtest.lookupRequest",
    {
      description:
        "Recover a launch with its original requestId after an uncertain POST; lookup is scoped to the trusted actor and workspace and never starts a new run.",
      inputSchema: z.strictObject({
        workspaceId: z.string().min(1).max(256).optional(),
        requestId: z.string().regex(LAUNCH_INTENT_REQUEST_ID_PATTERN)
      })
    },
    ({ workspaceId, requestId }) =>
      safely(async () => {
        const session = await sessionProvider.current();
        const targetWorkspaceId = authorizeWorkspace(workspaceId, session);
        return requirePlaytestRunControl(playtestRunControl).lookupRunByRequest(
          session,
          targetWorkspaceId,
          requestId
        );
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
        return requirePlaytestRunControl(playtestRunControl).waitForRun(
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
        return requirePlaytestRunControl(playtestRunControl).cancelRun(
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
        return requirePlaytestRunControl(
          playtestRunControl
        ).recordComparisonDecision(
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
        assertAnalystEpisodeSelected(
          session,
          episodeId,
          "playtest.prepareReview"
        );
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
        const cacheKey = preparedAnalystPacketCacheKey(
          session,
          targetWorkspaceId,
          episodeId
        );
        if (cacheKey !== null && packet.analysisKind === "confirmatory") {
          preparedAnalystPackets.set(cacheKey, packet.packet);
        }
        return {
          analysisKind: packet.analysisKind,
          packet: packet.packet,
          packetArtifact: packet.artifact
        };
      })
  );

  // 8b. playtest.prepareCrossSessionReview
  mcp.registerTool(
    "playtest.prepareCrossSessionReview",
    {
      description:
        "Prepare bounded evidence packets for an explicit selection of persisted sessions. Runtime owns eligibility, the per-batch critique cap, and a named receipt for every selected session that contributed no packet. This tool does not invoke a model. Each packet belongs to exactly one session, so later cross-session synthesis must cite each contributing session's own packet and be reported as cross-session.",
      inputSchema: {
        workspaceId: z.string().min(1).max(256).optional(),
        episodeIds: z
          .array(z.string().min(1).max(256))
          .min(1)
          .max(PLAYTESTS_MAX_CROSS_SESSION_PACKET_SESSIONS)
      }
    },
    ({ workspaceId, episodeIds }) =>
      safely(async () => {
        const session = await sessionProvider.current();
        assertPlaytestToolRole(
          session.role,
          CROSS_SESSION_PACKET_READER_ROLES,
          "playtest.prepareCrossSessionReview"
        );
        const targetWorkspaceId = authorizeWorkspace(workspaceId, session);
        const result = await requirePlaytestRunControl(
          playtestRunControl
        ).prepareCrossSessionReview(session, targetWorkspaceId, episodeIds);
        // Every requested session appears exactly once, in packets or receipts,
        // so a silent drop is structurally impossible.
        return {
          schema: "autodev-playtest-cross-session-v1" as const,
          requested: episodeIds.length,
          packets: result.packets,
          receipts: result.receipts,
          budget: result.budget
        };
      })
  );

  // Discovery reviews are a separate unscored write contract; the confirmatory
  // submitReview DTO stays adapter/rubric-bound.
  mcp.registerTool(
    "playtest.submitDiscoveryReview",
    {
      description:
        "Persist one unscored, evidence-cited hypothesis review for an autonomous visual discovery packet. This tool cannot score a session, assert a verified bug, or produce a finding.",
      inputSchema: z.strictObject({
        workspaceId: z.string().min(1).max(256).optional(),
        episodeId: z.string().min(1).max(256),
        packetId: z.string().min(1).max(128),
        packetArtifactId: z.string().min(1).max(128),
        packetSha256: z.string().regex(SHA256_PATTERN),
        chronologicalSummary: z.string().min(1).max(4096),
        observations: z
          .array(
            z.strictObject({
              hypothesisId: z.string().min(1).max(256),
              status: z.enum(["hypothesis", "not-observed"]),
              text: z.string().min(1).max(4096),
              evidenceRefs: z.array(evidenceLocatorSchema).min(1).max(64)
            })
          )
          .min(1)
          .max(64),
        interpretations: z
          .array(
            z.strictObject({
              hypothesisId: z.string().min(1).max(256),
              status: z.enum(["hypothesis", "not-observed"]),
              text: z.string().min(1).max(4096),
              evidenceRefs: z.array(evidenceLocatorSchema).min(1).max(64)
            })
          )
          .min(1)
          .max(64),
        alternativeExplanations: z
          .array(
            z.strictObject({
              hypothesisId: z.string().min(1).max(256),
              status: z.enum(["hypothesis", "not-observed"]),
              text: z.string().min(1).max(4096),
              evidenceRefs: z.array(evidenceLocatorSchema).min(1).max(64)
            })
          )
          .max(32),
        experiments: z
          .array(
            z.strictObject({
              hypothesis: z.string().min(1).max(4096),
              falsifier: z.string().min(1).max(4096),
              controls: z.array(z.string().min(1).max(1024)).min(1).max(16),
              budget: z.string().min(1).max(1024),
              evidenceRefs: z.array(evidenceLocatorSchema).min(1).max(64)
            })
          )
          .max(32)
      })
    },
    (args) =>
      safely(async () => {
        const session = await sessionProvider.current();
        if (!isReviewerRole(session.role)) {
          throw new PlaytestMcpAuthorizationError(
            "playtest.submitDiscoveryReview requires the read-only playtest analyst role."
          );
        }
        if (session.analysisKind !== "discovery") {
          throw new PlaytestMcpAuthorizationError(
            "Discovery reviews may only be submitted from a Runtime-bound discovery analysis."
          );
        }
        assertAnalystEpisodeSelected(
          session,
          args.episodeId,
          "playtest.submitDiscoveryReview"
        );
        const workspaceId = authorizeWorkspace(args.workspaceId, session);
        if (!playtestRepository?.insertDiscoveryReview) {
          throw new PlaytestMcpUnavailableError(
            "Playtest Data storage does not support discovery review persistence."
          );
        }
        const episode = await playtestRepository.getEpisode(
          workspaceId,
          args.episodeId
        );
        if (!episode) {
          throw new PlaytestMcpValidationError(
            "The requested visual discovery episode does not exist in the authorized workspace."
          );
        }
        const prepared = await readPreparedReviewPacket({
          workspaceId,
          episode,
          repository: playtestRepository,
          artifacts: artifactStoreForWorkspace(workspaceId)
        });
        if (prepared.analysisKind !== "discovery") {
          throw new PlaytestMcpAuthorizationError(
            "The requested episode has a confirmatory packet, not a discovery packet."
          );
        }
        if (
          prepared.packet.packetId !== args.packetId ||
          prepared.artifact.artifactId !== args.packetArtifactId ||
          prepared.artifact.sha256.toLowerCase() !==
            args.packetSha256.toLowerCase()
        ) {
          throw new PlaytestMcpValidationError(
            "The submitted discovery review does not match the exact persisted packet artifact."
          );
        }
        const observations: PlaytestDiscoveryReviewDraft["observations"] =
          args.observations.map((claim) => ({
            hypothesisId: claim.hypothesisId,
            status: claim.status,
            text: claim.text,
            evidenceRefs: normalizeEvidenceRefs(claim.evidenceRefs)
          }));
        const interpretations: PlaytestDiscoveryReviewDraft["interpretations"] =
          args.interpretations.map((claim) => ({
            hypothesisId: claim.hypothesisId,
            status: claim.status,
            text: claim.text,
            evidenceRefs: normalizeEvidenceRefs(claim.evidenceRefs)
          }));
        const alternativeExplanations: PlaytestDiscoveryReviewDraft["alternativeExplanations"] =
          args.alternativeExplanations.map((claim) => ({
            hypothesisId: claim.hypothesisId,
            status: claim.status,
            text: claim.text,
            evidenceRefs: normalizeEvidenceRefs(claim.evidenceRefs)
          }));
        const experiments: PlaytestDiscoveryReviewDraft["experiments"] =
          args.experiments.map((experiment) => ({
            ...experiment,
            evidenceRefs: normalizeEvidenceRefs(experiment.evidenceRefs)
          }));
        const draftCore: PlaytestDiscoveryReviewDraft = {
          reviewId: "discovery-pending",
          packetId: prepared.packet.packetId,
          chronologicalSummary: args.chronologicalSummary,
          observations,
          interpretations,
          alternativeExplanations,
          experiments,
          authorRole: "playtest-analyst"
        };
        try {
          assertPlaytestDiscoveryReviewDraft(draftCore);
          assertPlaytestDiscoveryReviewGroundedInPacket(
            draftCore,
            prepared.packet
          );
        } catch (error) {
          throw new PlaytestMcpValidationError(
            error instanceof Error
              ? "The discovery review is not grounded in its exact packet: " +
                  error.message
              : "The discovery review is not grounded in its exact packet."
          );
        }
        const allClaims = [
          ...observations,
          ...interpretations,
          ...alternativeExplanations
        ];
        const allWords = [
          args.chronologicalSummary,
          ...allClaims.map((claim) => claim.text),
          ...alternativeExplanations.map((claim) => claim.text),
          ...experiments.flatMap((experiment) => [
            experiment.hypothesis,
            experiment.falsifier
          ])
        ];
        if (
          allWords.some(
            (text) => text.trim().split(/\s+/u).filter(Boolean).length < 5
          )
        ) {
          throw new PlaytestReviewNarrativeValidationError();
        }
        const evidenceRefs = [
          ...new Map(
            [
              ...allClaims.flatMap((claim) => claim.evidenceRefs),
              ...experiments.flatMap((experiment) => experiment.evidenceRefs)
            ].map((reference) => [JSON.stringify(reference), reference])
          ).values()
        ] as PlaytestEvidenceLocator[];
        const status = allClaims.some((claim) => claim.status === "hypothesis")
          ? "hypothesis"
          : "not observed";
        const reviewId =
          "discovery-review-" +
          createHash("sha256")
            .update(
              canonicalPlaytestJson({
                workspaceId,
                episodeId: episode.episodeId,
                packetId: prepared.packet.packetId,
                packetSha256: prepared.artifact.sha256,
                chronologicalSummary: args.chronologicalSummary,
                observations,
                interpretations,
                alternativeExplanations,
                experiments
              })
            )
            .digest("hex");
        const existing =
          await playtestRepository.getLatestDiscoveryReviewForEpisode(
            workspaceId,
            episode.episodeId
          );
        if (existing) {
          if (
            existing.reviewId === reviewId &&
            existing.evidencePacket.packetId === prepared.packet.packetId &&
            existing.evidencePacket.artifact.sha256 === prepared.artifact.sha256
          ) {
            return existing;
          }
          throw new PlaytestMcpConflictError(
            "This visual discovery episode already has a persisted analyst review."
          );
        }
        const record: PlaytestDiscoverySessionReview = {
          schema: PLAYTESTS_DISCOVERY_SESSION_REVIEW_SCHEMA,
          analysisKind: "discovery",
          reviewId,
          version: 1,
          workspaceId,
          batchId: episode.batchId,
          episodeId: episode.episodeId,
          supersedes: null,
          evidencePacket: {
            packetId: prepared.packet.packetId,
            artifact: prepared.artifact
          },
          authorRole: "playtest-analyst",
          authorId: session.actor,
          measurementVersion: prepared.packet.measurementVersion,
          chronologicalSummary: args.chronologicalSummary,
          observations,
          interpretations,
          alternativeExplanations,
          experiments,
          evidenceRefs,
          createdAt: new Date().toISOString(),
          status
        };
        assertPlaytestDiscoverySessionReview(record);
        await playtestRepository.insertDiscoveryReview(record);
        return record;
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
        assertAnalystEpisodeSelected(
          session,
          args.episodeId,
          "playtest.submitReview"
        );
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
        if (packet.analysisKind !== "confirmatory") {
          throw new PlaytestMcpValidationError(
            "Autonomous visual episodes require playtest.submitDiscoveryReview; scored confirmatory review is unavailable."
          );
        }
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
              batch.executionMode !== PLAYTEST_ADAPTER_MODE ||
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

            try {
              assertPlaytestReviewNarrativeMinimums({
                reviewId: "review-precheck",
                chronologicalSummary: args.chronologicalSummary,
                observations,
                interpretations,
                alternativeExplanations,
                experiments,
                reportCompleteness,
                anchors
              });
            } catch {
              throw new PlaytestReviewNarrativeValidationError();
            }
            try {
              assertPlaytestReviewNarrativeGroundedInPacket(
                {
                  chronologicalSummary: args.chronologicalSummary,
                  observations,
                  interpretations,
                  alternativeExplanations,
                  experiments,
                  reportCompleteness
                },
                packet.packet
              );
            } catch (error) {
              throw new PlaytestReviewGroundingValidationError(
                error instanceof Error
                  ? error.message
                  : "include a packet-specific fact with its citation."
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

  // 9b. playtest.submitCrossSessionSynthesis
  mcp.registerTool(
    "playtest.submitCrossSessionSynthesis",
    {
      description:
        "Persist one hypothesis-only batch synthesis. Every cited locator must belong to the exact Runtime-selected packet for that episode; this artifact is distinct from all per-session reviews.",
      inputSchema: z.strictObject({
        summary: z.string().min(1).max(16_000),
        claims: z.array(crossSessionClaimSchema).min(1).max(64),
        experiments: z.array(crossSessionExperimentSchema).max(32)
      })
    },
    (args) =>
      safely(async () => {
        const session = await sessionProvider.current();
        if (session.role !== REVIEWER_ROLE) {
          throw new PlaytestMcpAuthorizationError(
            "Cross-session synthesis is only available to Runtime-dispatched playtest analysts."
          );
        }
        const analysisId = session.analysisId;
        const selectedEpisodeIds = session.selectedEpisodeIds;
        const metricAggregation = session.metricAggregation;
        if (
          !analysisId ||
          !metricAggregation ||
          !selectedEpisodeIds ||
          selectedEpisodeIds.length < 2 ||
          selectedEpisodeIds.length > PLAYTESTS_MAX_ANALYSIS_SESSIONS ||
          new Set(selectedEpisodeIds).size !== selectedEpisodeIds.length
        ) {
          throw new PlaytestMcpAuthorizationError(
            "The trusted Runtime analysis identity, metric aggregation, or multi-session selection is missing."
          );
        }
        const workspaceId = authorizeWorkspace(undefined, session);
        try {
          assertPlaytestCrossSessionMetricAggregation(
            metricAggregation,
            workspaceId,
            analysisId,
            selectedEpisodeIds
          );
        } catch {
          throw new PlaytestMcpAuthorizationError(
            "The Runtime metric aggregation is not bound to this analysis selection."
          );
        }
        const repository = requiredRunRepository(playtestRepository);
        const lockKey = JSON.stringify([workspaceId, analysisId]);
        return withAssignmentLock(
          crossSessionSynthesisLocks,
          lockKey,
          async () => {
            const existing =
              await repository.getCrossSessionSynthesisForAnalysis(
                workspaceId,
                analysisId
              );
            if (existing) return existing;

            const packetsByEpisode = new Map<
              string,
              {
                readonly episodeId: string;
                readonly batchId: string;
                readonly packet: PlaytestEvidencePacket;
              }
            >();
            for (const episodeId of selectedEpisodeIds) {
              const cacheKey = preparedAnalystPacketCacheKey(
                session,
                workspaceId,
                episodeId
              );
              const packet =
                cacheKey === null
                  ? undefined
                  : preparedAnalystPackets.get(cacheKey);
              if (packet) {
                packetsByEpisode.set(episodeId, {
                  episodeId,
                  batchId: packet.batchId,
                  packet
                });
              }
            }
            const referencedEpisodes = new Set<string>();
            const normalizedClaims: PlaytestCrossSessionClaim[] = [];
            const normalizedExperiments: PlaytestCrossSessionExperiment[] = [];
            const validateReferences = (
              references: readonly z.infer<
                typeof crossSessionEvidenceRefSchema
              >[]
            ): void => {
              for (const reference of references) {
                assertAnalystEpisodeSelected(
                  session,
                  reference.episodeId,
                  "playtest.submitCrossSessionSynthesis"
                );
                const packet = packetsByEpisode.get(reference.episodeId);
                if (!packet || packet.packet.packetId !== reference.packetId) {
                  throw new PlaytestMcpAuthorizationError(
                    "Every synthesis citation must match the frozen packet for its selected episode."
                  );
                }
                try {
                  assertPlaytestEvidenceLocatorsWithinPacket(
                    [playtestEvidenceLocatorFromInput(reference.locator)],
                    packet.packet
                  );
                } catch {
                  throw new PlaytestMcpValidationError(
                    "Every synthesis locator must resolve inside its cited frozen packet."
                  );
                }
                referencedEpisodes.add(reference.episodeId);
              }
            };
            for (const claim of args.claims) {
              validateReferences(claim.evidenceRefs);
              normalizedClaims.push({
                ...claim,
                evidenceRefs: claim.evidenceRefs.map((reference) => ({
                  episodeId: reference.episodeId,
                  packetId: reference.packetId,
                  locator: playtestEvidenceLocatorFromInput(reference.locator)
                }))
              });
            }
            for (const experiment of args.experiments) {
              validateReferences(experiment.evidenceRefs);
              normalizedExperiments.push({
                ...experiment,
                evidenceRefs: experiment.evidenceRefs.map((reference) => ({
                  episodeId: reference.episodeId,
                  packetId: reference.packetId,
                  locator: playtestEvidenceLocatorFromInput(reference.locator)
                }))
              });
            }
            if (referencedEpisodes.size < 2) {
              throw new PlaytestMcpValidationError(
                "A batch synthesis must cite evidence from at least two distinct selected sessions."
              );
            }
            const contributors = selectedEpisodeIds.flatMap((episodeId) => {
              const packet = packetsByEpisode.get(episodeId);
              return packet && referencedEpisodes.has(episodeId)
                ? [
                    {
                      episodeId,
                      batchId: packet.batchId,
                      packetId: packet.packet.packetId
                    }
                  ]
                : [];
            });
            const synthesis: PlaytestCrossSessionSynthesis = {
              schema: PLAYTESTS_CROSS_SESSION_SYNTHESIS_SCHEMA,
              synthesisId: randomUUID(),
              version: 1,
              analysisId,
              workspaceId,
              authorRole: REVIEWER_ROLE,
              authorId: session.actor,
              modelId: null,
              modelRevision: null,
              promptHash: null,
              generatedAt: new Date().toISOString(),
              status: "hypothesis",
              summary: args.summary,
              contributors,
              packetEligibleEpisodeIds: [...selectedEpisodeIds],
              metricAggregation,
              claims: normalizedClaims,
              experiments: normalizedExperiments
            };
            assertPlaytestCrossSessionSynthesis(synthesis);
            await repository.insertCrossSessionSynthesis(synthesis);
            return synthesis;
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

  // 10. playtest.issueDrafts
  mcp.registerTool(
    "playtest.issueDrafts",
    {
      description:
        "Propose review-gated issue drafts for a workspace's findings. AutoDev never publishes: drafts are returned for an operator to read, and every draft carries requiresOperatorAction.",
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
          "playtest.issueDrafts"
        );
        const targetWorkspaceId = authorizeWorkspace(args.workspaceId, session);
        if (!playtestRepository) {
          throw new PlaytestMcpUnavailableError(
            "Playtest data repository is not configured for drafting issues."
          );
        }
        // Both gates come from the owner's capabilities view, which already
        // resolves the operator's grant and the game's checked-in declaration.
        // Reading either from anywhere else would give the gate two answers.
        const capabilities = await requirePlaytestRunControl(
          playtestRunControl
        ).getCapabilities(session, targetWorkspaceId);
        const gates = {
          configuredReporting: capabilities.configuredIssueReporting,
          approvedReporting: capabilities.issueReporting
        };
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
        const drafts: readonly PlaytestIssueDraft[] = buildPlaytestIssueDrafts({
          ...gates,
          findings: page.rows
        });
        return {
          drafts,
          // A non-null refusal names the gate that withheld authority, so a
          // caller can explain an empty result instead of guessing.
          refusal: playtestIssueReportingRefusal({
            ...gates,
            findings: page.rows
          }),
          // Explicit about the window examined: a truncated page must not read
          // as "these were all the issues worth filing".
          examinedFindings: page.total,
          nextCursor: page.nextCursor,
          published: false as const,
          requiresOperatorAction: true as const
        };
      })
  );

  // 10b. playtest.policyValidity
  mcp.registerTool(
    "playtest.policyValidity",
    {
      description:
        "Derive PlayerPolicyValidity for the policies a batch actually ran, per measurement contract §6. Reports a validity record plus the sentence a caller must carry when a policy may not stand in for a human player. This tool takes no human-evidence input: the held-out decision states and acceptance bounds are the project's preregistration, so with none registered every record is unvalidated-synthetic.",
      inputSchema: {
        workspaceId: z.string().min(1).max(256).optional(),
        batchId: z.string().min(1).max(256)
      }
    },
    (args) =>
      safely(async () => {
        const session = await sessionProvider.current();
        assertPlaytestToolRole(
          session.role,
          ANALYSIS_READER_ROLES,
          "playtest.policyValidity"
        );
        const targetWorkspaceId = authorizeWorkspace(args.workspaceId, session);
        const repository = requiredRunRepository(playtestRepository);
        const batch = await repository.getBatch(
          targetWorkspaceId,
          args.batchId
        );
        if (!batch) {
          throw new PlaytestMcpValidationError(
            `No batch '${args.batchId}' exists in this workspace.`
          );
        }

        // Policy versions come from the approved benchmark rather than from
        // this call: an id means whatever the approval said it means, and a
        // validity record pinned to a guessed version would look checkable
        // without being checkable. An unreadable approval is reported as an
        // absent basis rather than silently substituted.
        let policyVersions: Readonly<Record<string, string>> = {};
        let policyVersionsBasis: string | null = null;
        try {
          const approval = approvalRepository?.read(targetWorkspaceId);
          if (approval && approval.revokedAt === null) {
            const prepared = prepareSandboxHandler(approval);
            if (prepared.benchmark) {
              policyVersions = prepared.benchmark.policyVersions;
              policyVersionsBasis = prepared.benchmarkHash;
            }
          }
        } catch {
          policyVersions = {};
          policyVersionsBasis = null;
        }

        const derived = derivePlaytestPolicyValidity({
          batch,
          policyVersions,
          createdAt: new Date().toISOString()
        });

        return {
          batchId: batch.batchId,
          batchStatus: batch.status,
          buildSha: batch.buildSha,
          // The content address of the frozen manifest the records rest on, so
          // a reader can verify the basis rather than trust this summary.
          coverageManifestHash: batch.coverageManifest?.contentHash ?? null,
          policyVersionsBasis,
          records: derived.records,
          unmeasurable: derived.unmeasurable,
          // No human-evidence source is wired yet; stating it keeps an absent
          // preregistration from reading as an omitted field.
          preregisteredHumanEvidence: false as const
        };
      })
  );

  // 10c. playtest.triageFindings
  mcp.registerTool(
    "playtest.triageFindings",
    {
      description:
        "Rank a workspace's findings by the measurement contract §9 triage order and say why each one landed where it did. Findings whose exposure was never measured are reported as unmeasured rather than as zero exposure. Operator overrides are supplied per call, are carried with their author and reason, and are never persisted here.",
      inputSchema: {
        workspaceId: z.string().min(1).max(256).optional(),
        severity: z.enum([...PLAYTESTS_SEVERITIES]).optional(),
        status: z.enum([...PLAYTESTS_FINDING_STATUSES]).optional(),
        verificationStage: z
          .enum([...PLAYTESTS_VERIFICATION_STAGES])
          .optional(),
        overrides: z
          .array(
            z.object({
              findingId: z.string().min(1).max(256),
              author: z.string().min(1).max(256),
              reason: z.string().min(1).max(1024),
              forcedSeverity: z.enum([...PLAYTESTS_SEVERITIES])
            })
          )
          .max(200)
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
          "playtest.triageFindings"
        );
        const targetWorkspaceId = authorizeWorkspace(args.workspaceId, session);
        if (!playtestRepository) {
          throw new PlaytestMcpUnavailableError(
            "Playtest data repository is not configured for triage."
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
        const overrides = args.overrides ?? [];
        const ranked = triagePlaytestFindings(page.rows, overrides);
        const examined = new Set(page.rows.map((finding) => finding.findingId));
        return {
          ranked,
          // A truncated page must not read as "these are the findings worth
          // working on": the ranking is exactly as complete as the page.
          examinedFindings: page.total,
          rankedFindings: ranked.length,
          nextCursor: page.nextCursor,
          // An override naming a finding that is not in the examined page is
          // inert. Naming it beats applying it silently or failing the call.
          overridesNotInPage: overrides
            .filter((override) => !examined.has(override.findingId))
            .map((override) => override.findingId),
          // Overrides rank a reading; this tool records nothing.
          persisted: false as const
        };
      })
  );

  // 10d. playtest.cohortMixShift
  mcp.registerTool(
    "playtest.cohortMixShift",
    {
      description:
        "Standardize per-cohort observation counts across runs against the approved benchmark's frozen cohort weights (§10/§11 mix-shift gate). This is a comparison, so it takes a reference and a candidate batch: a cohort mix can only have shifted between two builds. Refuses rather than padding: if the benchmark weights a cohort any supplied build never observed, or a build observed a cohort the benchmark does not weight, it names those cohorts and returns no result, because a zero-filled cohort would claim the run looked and observed nothing.",
      inputSchema: {
        workspaceId: z.string().min(1).max(256).optional(),
        referenceBatchId: z.string().min(1).max(256),
        candidateBatchId: z.string().min(1).max(256),
        metricId: z.string().min(1).max(256)
      }
    },
    (args) =>
      safely(async () => {
        const session = await sessionProvider.current();
        assertPlaytestToolRole(
          session.role,
          ANALYSIS_READER_ROLES,
          "playtest.cohortMixShift"
        );
        const targetWorkspaceId = authorizeWorkspace(args.workspaceId, session);
        const repository = requiredRunRepository(playtestRepository);
        const reference = await repository.getBatch(
          targetWorkspaceId,
          args.referenceBatchId
        );
        if (!reference) {
          throw new PlaytestMcpValidationError(
            `No batch '${args.referenceBatchId}' exists in this workspace.`
          );
        }
        const candidate = await repository.getBatch(
          targetWorkspaceId,
          args.candidateBatchId
        );
        if (!candidate) {
          throw new PlaytestMcpValidationError(
            `No batch '${args.candidateBatchId}' exists in this workspace.`
          );
        }
        if (
          reference.executionMode !== PLAYTEST_ADAPTER_MODE ||
          candidate.executionMode !== PLAYTEST_ADAPTER_MODE
        ) {
          throw new PlaytestMcpValidationError(
            "Cohort mix-shift standardization requires adapter batches with verified builds; visual batches are not comparable on that axis."
          );
        }

        // The weights are the approved benchmark's, so the gate is judged
        // against the frozen distribution rather than this build's sample mix.
        let benchmark: PlaytestBenchmark | null = null;
        let benchmarkHash: string | null = null;
        try {
          const approval = approvalRepository?.read(targetWorkspaceId);
          if (approval && approval.revokedAt === null) {
            const prepared = prepareSandboxHandler(approval);
            if (prepared.benchmark) {
              benchmark = prepared.benchmark;
              benchmarkHash = prepared.benchmarkHash;
            }
          }
        } catch {
          benchmark = null;
          benchmarkHash = null;
        }
        if (!benchmark) {
          throw new PlaytestMcpValidationError(
            "No approved benchmark declares cohort weights for this workspace."
          );
        }

        const pages = await Promise.all(
          [reference, candidate].map((run) =>
            repository.listEpisodes({
              workspaceId: targetWorkspaceId,
              batchId: run.batchId
            })
          )
        );
        const outcome = standardizePlaytestCohorts({
          benchmark,
          runs: [
            { batch: reference, episodes: pages[0]!.rows },
            { batch: candidate, episodes: pages[1]!.rows }
          ],
          metricId: args.metricId
        });

        return {
          referenceBatchId: reference.batchId,
          candidateBatchId: candidate.batchId,
          referenceBuildSha: reference.buildSha,
          candidateBuildSha: candidate.buildSha,
          metricId: args.metricId,
          benchmarkId: benchmark.benchmarkId,
          benchmarkContentHash: benchmarkHash,
          standardized: outcome.result !== null,
          result: outcome.result,
          buildObservations: outcome.buildObservations,
          contributingEpisodesByBuild: outcome.contributingEpisodesByBuild,
          skippedRowsByBuild: outcome.skippedRowsByBuild,
          // Named rather than folded into the result, because a non-empty list
          // is the whole reason there is no result.
          refusals: outcome.refusals,
          // Explicit about the window: a truncated episode page undercounts
          // every cohort, so the counts must not read as complete.
          examinedEpisodes: pages.map((page) => page.total),
          scoredEpisodes: pages.map((page) => page.rows.length),
          nextCursor: pages.map((page) => page.nextCursor)
        };
      })
  );

  // 11. playtest.branch
  mcp.registerTool(
    "playtest.branch",
    {
      description:
        "Accept `{launchRequest}` using the same Core PlaytestLaunchRequest schema as playtest.run, including its current capabilityRevision and unique client requestId, with mode=adapter-accelerated and operation.kind=branch. Runtime requires a complete source episode, verified full-state/RNG checkpoint, an alternate legal action, and exact approved build/config provenance.",
      inputSchema: z.strictObject({
        launchRequest: playtestBranchLaunchRequestSchema
      })
    },
    ({ launchRequest }) =>
      safely(async () => {
        const session = await sessionProvider.current();
        return requirePlaytestRunControl(playtestRunControl).startRun(
          session,
          launchRequest
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
      // Keep a breadcrumb without serializing stacks that can contain
      // checkout paths or untrusted adapter/Data error text.
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
  if (error instanceof PlaytestMcpConflictError) {
    return {
      code: "playtest_request_id_conflict",
      category: "conflict",
      retryable: false,
      message: error.message
    };
  }
  if (error instanceof PlaytestReviewNarrativeValidationError) {
    return {
      code: "playtest_review_narrative_too_terse",
      category: "validation",
      retryable: false,
      message: error.message
    };
  }
  if (error instanceof PlaytestReviewGroundingValidationError) {
    return {
      code: "playtest_review_narrative_not_grounded",
      category: "validation",
      retryable: false,
      message: error.message
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
