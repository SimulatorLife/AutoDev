/** Runtime-owned Playtest run control: approved run lifecycle, evidence and analyst dispatch behind the MCP gateway and Control API. */
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

import {
  aggregatePlaytestCrossSessionMetrics,
  assertPlaytestAdapterEpisode,
  assertPlaytestAssignmentManifest,
  assertPlaytestAssignmentsMatchBenchmark,
  assertPlaytestBatchAssignments,
  assertPlaytestBranchLineage,
  assertPlaytestCheckpointDigest,
  assertPlaytestCoveragePlanCoversAssignments,
  assertPlaytestEvidencePacket,
  buildPlaytestCoverageManifestDraft,
  buildPlaytestEvidencePacket,
  canonicalPlaytestJson,
  PLAYTEST_PLAYER_DEBRIEF_SCHEMA,
  PLAYTEST_VISUAL_ACTION_SCHEMA,
  PLAYTEST_VISUAL_OBSERVATION_SCHEMA,
  playtestActionRefusalMeansPageMoved,
  type PlaytestAdapterAssignmentManifest,
  type PlaytestAdapterBatch,
  type PlaytestAdapterBranchOperation,
  type PlaytestArtifactReference,
  type PlaytestAssignmentBranch,
  type PlaytestAssignmentManifestDraft,
  playtestAssignmentManifestHashInput,
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
  playtestCrossSessionInventoryHashInput,
  type PlaytestCrossSessionMetricAggregation,
  type PlaytestCrossSessionSynthesis,
  type PlaytestDiscoveryEvidencePacketV3,
  type PlaytestDiscoverySessionReview,
  type PlaytestEpisode,
  playtestEpisodeRecordId,
  type PlaytestEpisodeState,
  type PlaytestEvidenceLocator,
  type PlaytestEvidenceOmittedArtifact,
  type PlaytestEvidencePacket,
  type PlaytestEvidenceTraceStep,
  type PlaytestFinding,
  type PlaytestJsonValue,
  type PlaytestLaunchAssignment,
  type PlaytestLaunchRequest,
  type PlaytestMissingReason,
  type PlaytestOwnerDisposition,
  type PlaytestPlayerDebriefV1,
  type PlaytestPlayerEvidenceReference,
  type PlaytestReviewCandidate,
  playtestReviewOutcomeKey,
  type PlaytestReviewPacketFailureReason,
  type PlaytestReviewPacketReceipt,
  type PlaytestRunAssignmentOutcome,
  PLAYTESTS_ASSIGNMENT_MANIFEST_SCHEMA,
  PLAYTESTS_BATCH_SCHEMA,
  PLAYTESTS_EPISODE_SCHEMA,
  PLAYTESTS_EVIDENCE_PACKET_MAX_TOKENS,
  PLAYTESTS_EVIDENCE_PACKET_MEDIA_TYPE,
  PLAYTESTS_MAX_ANALYSIS_SESSIONS,
  PLAYTESTS_MAX_BATCH_ASSIGNMENTS,
  PLAYTESTS_MAX_BATCH_REVIEW_SESSIONS,
  PLAYTESTS_MAX_CROSS_SESSION_PACKET_SESSIONS,
  PLAYTESTS_MEASUREMENT_VERSION,
  PLAYTESTS_RNG_POLICY_VERSION,
  PLAYTESTS_VISUAL_ASSIGNMENT_MANIFEST_SCHEMA,
  PLAYTESTS_VISUAL_PROGRESS_VERSION,
  PLAYTESTS_VISUAL_STUCK_POLICY_VERSION,
  type PlaytestSessionReference,
  type PlaytestSessionReview,
  type PlaytestVisualAction,
  type PlaytestVisualAssignmentManifest,
  type PlaytestVisualBatch,
  type PlaytestVisualBatchAssignment,
  type PlaytestVisualDecision,
  type PlaytestVisualDecisionProgress,
  playtestVisualEpisodeRecordId,
  type PlaytestVisualHistoryEntry,
  type PlaytestVisualObservation,
  type PlaytestVisualPolicy as CorePlaytestVisualPolicy,
  type PlaytestVisualPolicyId,
  type PlaytestVisualProgressOutcome,
  playtestVisualProgressOutcome,
  playtestVisualProgressPolicy,
  type PlaytestVisualProgressState,
  playtestVisualProgressState,
  playtestVisualProgressStuck,
  recordPlaytestOwnerDecision,
  selectPlaytestBatchReviews,
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
  type WorkspacePlaytestApprovalRepository,
  WorkspaceVisualPlaytestTargetRepository
} from "@simulatorlife/autodev-data/workspaces";

import type { PlaytestingReadRepository } from "../control-api/playtesting.ts";
import { mapConcurrentOrdered } from "../shared/map-concurrent-ordered.ts";
import { writeErrorLine } from "../shared/output.ts";
import { resolveRuntimePackageManifest } from "../shared/runtime-source-root.ts";
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
import { preparePlaytestDiscoveryEvidencePacket } from "./discovery-review.ts";
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
import { playtestLaunchRequestSchema } from "./launch-request-schema.ts";
import {
  ONEJEV_LOCAL_POLICY_VERSION,
  OneJevLocalVisualPolicy
} from "./onejev-local-policy.ts";
import {
  createBuiltinPlaytestPolicy,
  type PlaytestPolicy,
  PLAYTESTS_BUILTIN_POLICY_IDS
} from "./policies.ts";
import {
  createPlaytestPolicyWorkspace,
  type PlaytestPolicyWorkspace,
  removePlaytestPolicyWorkspace
} from "./policy-workspace.ts";
import {
  SMART_DIRECT_POLICY_VERSION,
  SmartDirectPolicyError,
  SmartDirectVisualPolicy
} from "./smart-direct-policy.ts";
import {
  PlaytestVisualBrowserDriver,
  PlaytestVisualBrowserDriverError,
  type PlaytestVisualDriverOpener,
  type PlaytestVisualEpisodeDriver,
  type PlaytestVisualObservationBlockReason
} from "./visual-browser-driver.ts";
import {
  buildVisualCandidateSet,
  visualCandidateOffer
} from "./visual-candidates.ts";

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

export class PlaytestReviewNarrativeValidationError extends Error {
  constructor() {
    super(
      "Review narrative fields must contain at least three words and sixteen characters. Add packet-specific detail or an evidence-based reason for unavailable sections; compact experiment controls are allowed."
    );
    this.name = "PlaytestReviewNarrativeValidationError";
  }
}

export class PlaytestReviewGroundingValidationError extends Error {
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
  /**
   * Whether the request asked the analyst to file findings.
   *
   * The record says which job the run was given, because a run that filed a
   * defect and a run that only described one are not the same result, and a
   * reader of the register has to be able to tell them apart.
   */
  readonly requireFindings?: boolean;
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
    episodeIds: readonly string[],
    request?: { readonly requireFindings?: boolean }
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
export type PlaytestVisualPolicy = CorePlaytestVisualPolicy;

/** Builds the policy for one approved visual episode. */
export type PlaytestVisualPolicyFactory = (input: {
  readonly target: WorkspaceVisualPlaytestTargetApproval;
  readonly workspacePath: string;
  /** The decision backend the launch asked for. */
  readonly policyId: PlaytestVisualPolicyId;
}) => PlaytestVisualPolicy;

/** Explicit supported policy baselines. No generic scored/heuristic fallback. */
const RUNNER_ROLES = new Set(["playtester", "root", "orchestrator"]);
export const REVIEWER_ROLE = "playtest-analyst" as const;
export const PLAYTEST_ADAPTER_MODE = "adapter-accelerated" as const;
export const RUN_STATUS_READER_ROLES = new Set([
  ...RUNNER_ROLES,
  REVIEWER_ROLE,
  "validator",
  "operator",
  "control-viewer"
]);
export const ANALYSIS_READER_ROLES = new Set([
  REVIEWER_ROLE,
  "root",
  "orchestrator",
  "validator",
  "operator"
]);
const ANALYST_DISPATCH_ROLES = new Set(["root", "operator"]);
export const CROSS_SESSION_PACKET_READER_ROLES = new Set([
  "root",
  "orchestrator",
  "validator",
  "operator"
]);
const ANALYST_STATUS_READER_ROLES = new Set([
  ...ANALYSIS_READER_ROLES,
  "control-viewer"
]);
export const OWNER_DECISION_ROLES = new Set(["root", "operator"]);
const APPROVAL_POLL_INTERVAL_MS = 50;
const RUN_SHUTDOWN_GRACE_MS = 2000;
const MAX_ACTIVE_ANALYST_RUNS = 4;
const MAX_RETAINED_ANALYST_RUNS = 64;
const CROSS_SESSION_PACKET_READ_CONCURRENCY = 4;
const ANALYST_REVIEW_RUN_COLLATOR = new Intl.Collator();
const PLAYTEST_INFRASTRUCTURE_FAILURE_STATE = "infrastructure-failed" as const;
const PLAYTEST_BUDGET_TRUNCATED_STATE = "budget-truncated" as const;
const PLAYTEST_AUTONOMOUS_VISUAL_MODE = "autonomous-visual" as const;
export const PLAYTEST_REPLAY_SEGMENT_KIND = "replay-segment" as const;
const PLAYTEST_FROZEN_VISUAL_INVENTORY_STATUS = "frozen-visual" as const;
const PLAYTEST_DEBRIEF_NOT_APPLICABLE_STATUS = "not-applicable" as const;
const PLAYTEST_DEBRIEF_MODEL_RESPONSE_INVALID_REASON =
  "model-response-invalid" as const;
const PLAYTEST_VISUAL_ACTION_REFUSED_KIND = "action-refused" as const;
const PLAYTEST_VISUAL_STEP_LIMIT_KIND = "step-limit" as const;
const PLAYTEST_VISUAL_LOOP_GUARD_KIND = "loop-guard" as const;
/**
 * The Runtime's own measurement says the game has not advanced.
 *
 * This is not the decision backend reporting that it is stuck; it is the
 * Runtime comparing what the player sees now with what they saw before, and
 * finding the game where it was, for as long as the operator allowed.
 */
const PLAYTEST_VISUAL_NO_PROGRESS_KIND = "no-progress" as const;
const PLAYTEST_VISUAL_WALL_TIME_LIMIT_KIND = "wall-time-limit" as const;
const MAX_REVIEW_PACKET_BYTES = 64 * 1024;
const REVIEW_PACKET_TOKEN_BUDGET = PLAYTESTS_EVIDENCE_PACKET_MAX_TOKENS;
const NO_EPISODE_OUTCOME_STATES = new Set([
  PLAYTEST_INFRASTRUCTURE_FAILURE_STATE,
  "cancelled"
]);
const APPROVAL_REVOKED_REASON = "approval-revoked" as const;
const WORKSPACE_ID_PATTERN = /^[^/\s]+\/[^/\s]+$/u;
const SAFE_SESSION_VALUE_PATTERN = /^[A-Za-z0-9@._:-]{1,256}$/u;
export const SHA256_PATTERN = /^[a-f\d]{64}$/iu;
const PLAYTEST_BATCH_ID_PREFIX_PATTERN = /^batch-/u;

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

export function assertPlaytestToolRole(
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

export function authorizeWorkspace(
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
      readFileSync(resolveRuntimePackageManifest(import.meta.dirname), "utf8")
    ) as { version?: unknown };
    return typeof manifest.version === "string" && manifest.version.length > 0
      ? manifest.version
      : "unknown";
  } catch {
    return "unknown";
  }
}

export const RUNTIME_VERSION = currentRuntimeVersion();

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
      batch.assignmentInventory.status ===
        PLAYTEST_FROZEN_VISUAL_INVENTORY_STATUS
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
      state: cancellationRequested
        ? "cancelled"
        : PLAYTEST_INFRASTRUCTURE_FAILURE_STATE,
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
          : episode.status === PLAYTEST_BUDGET_TRUNCATED_STATE
            ? PLAYTEST_BUDGET_TRUNCATED_STATE
            : PLAYTEST_INFRASTRUCTURE_FAILURE_STATE;
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
        status: cancellationRequested
          ? "cancelled"
          : PLAYTEST_INFRASTRUCTURE_FAILURE_STATE,
        termination: {
          reason: cancellationRequested ? "cancelled" : "runtime-failure",
          step: episode.stepCount === 0 ? null : episode.stepCount - 1
        },
        completionCounts: visualCompletionCounts(
          cancellationRequested
            ? "cancelled"
            : PLAYTEST_INFRASTRUCTURE_FAILURE_STATE,
          episode.startedAt !== null
        ),
        completedAt,
        completeness: episode.stepCount === 0 ? "unknown" : "partial",
        missingReasons: [
          ...new Set<PlaytestMissingReason>([
            ...episode.missingReasons,
            cancellationRequested
              ? "cancelled"
              : PLAYTEST_INFRASTRUCTURE_FAILURE_STATE
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
    batch.executionMode === PLAYTEST_AUTONOMOUS_VISUAL_MODE &&
    batch.assignmentInventory.status === PLAYTEST_FROZEN_VISUAL_INVENTORY_STATUS
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
            state: PLAYTEST_INFRASTRUCTURE_FAILURE_STATE,
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
                : PLAYTEST_INFRASTRUCTURE_FAILURE_STATE,
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

export async function withAssignmentLock<Result>(
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
export const LAUNCH_INTENT_REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/u;

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
  if (
    batch.assignmentInventory.status === PLAYTEST_FROZEN_VISUAL_INVENTORY_STATUS
  ) {
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
      mode === PLAYTEST_AUTONOMOUS_VISUAL_MODE
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

/**
 * The receipt a repeated launch request already has.
 *
 * A launch intent records the immutable payload a requestId was bound to, so
 * a repeat of that requestId either resumes the run it started or reports the
 * conflict that stopped it. A requestId with no intent yet has no receipt,
 * and the caller starts the run the request asked for.
 */
async function priorLaunchReceiptForRequest(input: {
  readonly repository: PlaytestingRepositoryOps;
  readonly intentRepository: PlaytestLaunchIntentRepository;
  readonly activeRuns: Map<string, ActivePlaytestRun>;
  readonly assignmentLocks: Map<string, Promise<void>>;
  readonly targetWorkspaceId: string;
  readonly session: PlaytestMcpSession;
  readonly parsed: PlaytestLaunchRequest;
}): Promise<PlaytestRunStartReceipt | null> {
  const expectedHash = launchIntentHash(input.parsed);
  const priorIntent = await input.intentRepository.getLaunchIntent(
    input.targetWorkspaceId,
    input.session.actor,
    input.parsed.requestId
  );
  if (!priorIntent) return null;
  if (
    priorIntent.workspaceId !== input.targetWorkspaceId ||
    priorIntent.actorId !== input.session.actor ||
    priorIntent.requestId !== input.parsed.requestId
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
  const livePriorRun = input.activeRuns.get(priorIntent.batchId);
  if (livePriorRun) return startReceiptForActiveRun(livePriorRun);
  const priorBatch = await input.repository.getBatch(
    input.targetWorkspaceId,
    priorIntent.batchId
  );
  if (!priorBatch) return null;
  if (priorBatch.budget.assignedEpisodes !== priorIntent.assignmentCount) {
    throw new PlaytestMcpUnavailableError(
      "The persisted launch receipt does not match its frozen batch."
    );
  }
  return startReceiptForPersistedBatch({
    repository: input.repository,
    workspaceId: input.targetWorkspaceId,
    batch: priorBatch,
    activeRun: input.activeRuns.get(priorBatch.batchId),
    locks: input.assignmentLocks
  });
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
    parent.trace?.kind !== PLAYTEST_REPLAY_SEGMENT_KIND ||
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
  | {
      readonly kind: typeof PLAYTEST_VISUAL_STEP_LIMIT_KIND;
      readonly step: number | null;
    }
  | { readonly kind: typeof USAGE_BUDGET; readonly step: number | null }
  | {
      readonly kind: typeof PLAYTEST_VISUAL_LOOP_GUARD_KIND;
      readonly step: number | null;
    }
  | {
      readonly kind: typeof PLAYTEST_VISUAL_NO_PROGRESS_KIND;
      readonly step: number | null;
    }
  | { readonly kind: "policy-stop"; readonly step: number | null }
  | {
      readonly kind: "driver-blocked";
      readonly reason: PlaytestVisualObservationBlockReason;
      readonly step: number | null;
    }
  | {
      readonly kind: typeof PLAYTEST_VISUAL_ACTION_REFUSED_KIND;
      readonly reason: string;
      readonly step: number | null;
    }
  | {
      readonly kind: typeof PLAYTEST_VISUAL_WALL_TIME_LIMIT_KIND;
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

/**
 * The recorded version of a visual decision backend.
 *
 * The version is part of the frozen manifest, so it names the contract
 * the episode was run under — not a model's weight revision, which the
 * backend reports per decision.
 */
function visualPolicyVersion(policyId: PlaytestVisualPolicyId): string {
  return policyId === "onejev-local"
    ? ONEJEV_LOCAL_POLICY_VERSION
    : SMART_DIRECT_POLICY_VERSION;
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
    readonly intention: string | null;
    readonly predictedVisibleEffect: string | null;
  },
  capturedFrames: readonly PlaytestArtifactReference[]
): PlaytestPlayerDebriefV1 {
  // A checkpoint is the player's own account of the step it is about to
  // take. A decision backend that reports no intention has no such
  // account, and the honest record is that the debrief does not apply --
  // not an empty intention.
  if (decision.intention === null) {
    return {
      schema: PLAYTEST_PLAYER_DEBRIEF_SCHEMA,
      status: PLAYTEST_DEBRIEF_NOT_APPLICABLE_STATUS,
      reason: "non-reflective-policy"
    };
  }
  const source = playerDebriefSource(decision.modelId);
  if (source === null) {
    return {
      schema: PLAYTEST_PLAYER_DEBRIEF_SCHEMA,
      status: "unavailable",
      reason: PLAYTEST_DEBRIEF_MODEL_RESPONSE_INVALID_REASON
    };
  }
  const evidence = playerEvidenceReferenceForStep(step, capturedFrames);
  if (evidence === null) {
    return {
      schema: PLAYTEST_PLAYER_DEBRIEF_SCHEMA,
      status: "unavailable",
      reason: PLAYTEST_DEBRIEF_MODEL_RESPONSE_INVALID_REASON
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
      predictedVisibleEffect: decision.predictedVisibleEffect ?? "",
      evidence
    }
  };
}

function completePlayerDebrief(input: {
  readonly requestedFocus: string | null;
  readonly traceSteps: readonly PlaytestEvidenceTraceStep[];
  readonly capturedFrames: readonly PlaytestArtifactReference[];
  readonly decision: PlaytestVisualDecision;
}): PlaytestPlayerDebriefV1 {
  // A complete debrief is the player's reflective account of the episode.
  // A backend that produces no self-report has none to give.
  if (input.decision.selfReport === null) {
    return {
      schema: PLAYTEST_PLAYER_DEBRIEF_SCHEMA,
      status: PLAYTEST_DEBRIEF_NOT_APPLICABLE_STATUS,
      reason: "non-reflective-policy"
    };
  }
  const source = playerDebriefSource(input.decision.modelId);
  if (source === null) {
    return {
      schema: PLAYTEST_PLAYER_DEBRIEF_SCHEMA,
      status: "unavailable",
      reason: PLAYTEST_DEBRIEF_MODEL_RESPONSE_INVALID_REASON
    };
  }
  const evidence = input.decision.selfReport.evidenceSteps.map((step) => {
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
      reason: PLAYTEST_DEBRIEF_MODEL_RESPONSE_INVALID_REASON
    };
  }
  return {
    schema: PLAYTEST_PLAYER_DEBRIEF_SCHEMA,
    status: "complete",
    source,
    focusInterpretation: {
      schema: "autodev-playtest-focus-interpretation-v1",
      requestedFocus: input.requestedFocus,
      objective: input.decision.selfReport.objective,
      inScope: input.decision.selfReport.inScope,
      forbiddenScope: input.decision.selfReport.forbiddenScope,
      stopCriteria: input.decision.selfReport.stopCriteria,
      outcome: input.decision.selfReport.outcome,
      assessmentSource: "smart-direct-self-report",
      evidence: evidence.filter(
        (reference): reference is PlaytestPlayerEvidenceReference =>
          reference !== null
      )
    },
    summary: input.decision.selfReport.summary
  };
}

function playerDebriefAfterExit(
  current: PlaytestPlayerDebriefV1,
  exit: VisualEpisodeExit
): PlaytestPlayerDebriefV1 {
  if (
    current.status === "complete" ||
    current.status === PLAYTEST_DEBRIEF_NOT_APPLICABLE_STATUS ||
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
      exit.kind === PLAYTEST_VISUAL_ACTION_REFUSED_KIND
        ? PLAYTEST_VISUAL_ACTION_REFUSED_KIND
        : exit.kind === PLAYTEST_VISUAL_STEP_LIMIT_KIND ||
            exit.kind === USAGE_BUDGET ||
            exit.kind === PLAYTEST_VISUAL_LOOP_GUARD_KIND ||
            exit.kind === PLAYTEST_VISUAL_NO_PROGRESS_KIND ||
            exit.kind === PLAYTEST_VISUAL_WALL_TIME_LIMIT_KIND ||
            (exit.kind === "driver-blocked" &&
              VISUAL_BUDGET_BLOCK_REASONS.has(exit.reason))
          ? PLAYTEST_BUDGET_TRUNCATED_STATE
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
    PLAYTEST_VISUAL_WALL_TIME_LIMIT_KIND
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
    case "cancelled": {
      return {
        status: "cancelled",
        termination: { reason: "cancelled", step: exit.step },
        missingReason: "cancelled"
      };
    }
    case PLAYTEST_VISUAL_STEP_LIMIT_KIND:
    case PLAYTEST_VISUAL_WALL_TIME_LIMIT_KIND: {
      return {
        status: PLAYTEST_BUDGET_TRUNCATED_STATE,
        termination: {
          reason: PLAYTEST_VISUAL_STEP_LIMIT_KIND,
          step: exit.step
        },
        missingReason: PLAYTEST_BUDGET_TRUNCATED_STATE
      };
    }
    case USAGE_BUDGET: {
      return {
        status: PLAYTEST_BUDGET_TRUNCATED_STATE,
        termination: { reason: USAGE_BUDGET, step: exit.step },
        missingReason: PLAYTEST_BUDGET_TRUNCATED_STATE
      };
    }
    case PLAYTEST_VISUAL_LOOP_GUARD_KIND: {
      return {
        status: PLAYTEST_BUDGET_TRUNCATED_STATE,
        termination: {
          reason: PLAYTEST_VISUAL_LOOP_GUARD_KIND,
          step: exit.step
        },
        missingReason: PLAYTEST_BUDGET_TRUNCATED_STATE
      };
    }
    case PLAYTEST_VISUAL_NO_PROGRESS_KIND: {
      // The episode was cut short by the operator's no-progress limit. The
      // reason names which limit it was, so the run is not read as a budget
      // that ran out or as a game that crashed.
      return {
        status: PLAYTEST_BUDGET_TRUNCATED_STATE,
        termination: {
          reason: PLAYTEST_VISUAL_NO_PROGRESS_KIND,
          step: exit.step
        },
        missingReason: PLAYTEST_BUDGET_TRUNCATED_STATE
      };
    }
    case "infrastructure-failure": {
      return {
        status: PLAYTEST_INFRASTRUCTURE_FAILURE_STATE,
        termination: { reason: "runtime-failure", step: exit.step },
        missingReason: PLAYTEST_INFRASTRUCTURE_FAILURE_STATE
      };
    }
    case "driver-blocked": {
      return VISUAL_BUDGET_BLOCK_REASONS.has(exit.reason)
        ? {
            status: PLAYTEST_BUDGET_TRUNCATED_STATE,
            termination: {
              reason: PLAYTEST_VISUAL_STEP_LIMIT_KIND,
              step: exit.step
            },
            missingReason: PLAYTEST_BUDGET_TRUNCATED_STATE
          }
        : {
            status: "crashed",
            termination: { reason: "unknown", step: exit.step },
            missingReason: "unobserved"
          };
    }
    case PLAYTEST_VISUAL_ACTION_REFUSED_KIND: {
      return {
        status: "crashed",
        termination: { reason: "action-refused", step: exit.step },
        missingReason: "unobserved"
      };
    }
    case "policy-stop": {
      return {
        status: "completed",
        termination: { reason: "unknown", step: exit.step },
        missingReason: null
      };
    }
    default: {
      // Every exit kind is a case above, so this is unreachable with the
      // kinds this Runtime knows. It is here because an exit kind that
      // grows later must be reported rather than fall out of the function
      // with no disposition at all.
      const exhaustive: never = exit;
      throw new Error(
        `Unsupported visual episode exit: ${JSON.stringify(exhaustive)}`
      );
    }
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
    infrastructureFailed:
      status === PLAYTEST_INFRASTRUCTURE_FAILURE_STATE ? 1 : 0,
    cancelled: status === "cancelled" ? 1 : 0,
    budgetTruncated: status === PLAYTEST_BUDGET_TRUNCATED_STATE ? 1 : 0,
    reviewed: 0,
    // Visual URL-only exploration never asserts a verified game-terminal
    // outcome (Core's visual identity contract forbids claiming an
    // unobserved scenario/outcome), so no visual episode is ever eligible
    // for the adapter-only cross-session review path.
    eligible: 0
  };
}

/**
 * The episode view one persisted revision records.
 *
 * The step loop and the writer that persists each revision describe the same
 * episode, so the writer takes the view it records rather than reading a
 * shared copy that could drift from it.
 */
interface VisualEpisodeView {
  readonly playerDebrief: PlaytestPlayerDebriefV1;
  readonly stepCount: number;
}

/** What one visual episode's step loop leaves behind for the episode writer. */
interface VisualEpisodeStepOutcome {
  readonly exit: VisualEpisodeExit;
  readonly playerDebrief: PlaytestPlayerDebriefV1;
}

/** The episode fields one persisted revision overrides. */
interface VisualEpisodeRevisionOverrides {
  readonly status: PlaytestEpisodeState;
  readonly termination: PlaytestEpisode["termination"];
  readonly completionCounts: PlaytestCompletionCounts;
  readonly trace: PlaytestEvidenceLocator | null;
  readonly completedAt: string | null;
  readonly completeness: "complete" | "partial" | "unknown";
  readonly missingReasons: readonly PlaytestMissingReason[];
  readonly policyInferenceMs: number;
  readonly simulationWallMs: number | null;
}

/** The player-visible observation one visual trace step records. */
function visualVisibleObservation(
  observation: PlaytestVisualObservation
): PlaytestJsonValue {
  return {
    capturedAt: observation.capturedAt,
    viewport: observation.viewport,
    privacyState: observation.privacyState,
    controls: observation.controls.map((control) => ({
      controlId: control.controlId,
      name: control.name,
      role: control.role,
      bounds: control.bounds,
      enabled: control.enabled
    })),
    warnings: observation.visibleWarnings,
    phase: observation.phaseEvidence,
    progress: observation.progressEvidence
  } as unknown as PlaytestJsonValue;
}

/** The control ids the observation offers as legal actions. */
function visualLegalActionIds(
  observation: PlaytestVisualObservation
): readonly string[] {
  return observation.controls
    .filter((control) => control.enabled)
    .map((control) => control.controlId);
}

/** The control a dispatched action names, or null for the other action kinds. */
function visualSelectedActionId(action: PlaytestVisualAction): string | null {
  return action.kind === "activate-control" ? action.controlId : null;
}

/** The action detail one dispatched action records for the analyst. */
function visualActionDetail(action: PlaytestVisualAction): PlaytestJsonValue {
  if (action.kind === "activate-control") {
    return { controlId: action.controlId };
  }
  if (action.kind === "pointer-click") {
    return {
      frameArtifactId: action.frameArtifactId,
      x: action.x,
      y: action.y
    };
  }
  if (action.kind === "key-press") {
    return { key: action.key };
  }
  return { button: action.button };
}

/**
 * The exit a failed decision produces.
 *
 * A decision that failed because the approved wall-time budget ran out
 * truncates the episode; a decision that failed because an approved request,
 * token or usage budget ran out truncates it too; every other failure is
 * infrastructure loss. The budget is read only once the failure is known to
 * be a deadline, so the driver is not asked for its remaining time on a
 * failure that has nothing to do with time.
 */
function visualDecisionFailureExit(input: {
  readonly error: unknown;
  readonly code: string;
  readonly step: number;
  readonly driver: PlaytestVisualEpisodeDriver;
}): VisualEpisodeExit {
  if (
    isDecisionDeadlineFailure(input.error) &&
    input.driver.remainingWallTimeMs() <= 0
  ) {
    return {
      kind: PLAYTEST_VISUAL_WALL_TIME_LIMIT_KIND,
      step: input.step
    };
  }
  if (isSmartDirectBudgetExhaustion(input.error)) {
    return { kind: USAGE_BUDGET, step: input.step };
  }
  return {
    kind: "infrastructure-failure",
    code: input.code,
    step: input.step
  };
}

/** The exit a policy stop produces, classified by why the policy stopped. */
function visualStopExit(
  decision: PlaytestVisualDecision,
  step: number
): VisualEpisodeExit {
  return decision.stopReason === "stuck"
    ? { kind: PLAYTEST_VISUAL_LOOP_GUARD_KIND, step }
    : { kind: "policy-stop", step };
}

/**
 * What the episode did with one action.
 *
 * "dispatched" is the action that reached the game, "page-moved" is the
 * refusal that says the page no longer offers what the observation promised,
 * and "refused" is the refusal that is final.
 */
type VisualActOutcome =
  | { readonly status: "dispatched" }
  | { readonly status: "page-moved" }
  | { readonly status: "refused"; readonly exit: VisualEpisodeExit };

/**
 * Dispatches one action and records what it did.
 *
 * The refusal is the interesting part. A refusal that says the page moved is
 * not the end of the episode: the player looks again and chooses with the
 * refusal in its history. Every other refusal is final, and the episode ends
 * with the reason it was refused. What bounds the retries is the budgets the
 * operator approved -- the per-episode step cap, the request and token
 * budgets, and the wall-time budget -- and not a retry count of the
 * Runtime's own.
 */
async function actVisualStep(input: {
  readonly step: number;
  readonly decision: PlaytestVisualDecision;
  readonly action: PlaytestVisualAction;
  readonly observation: PlaytestVisualObservation;
  readonly driver: PlaytestVisualEpisodeDriver;
  readonly policy: PlaytestVisualPolicy;
  readonly artifacts: PlaytestArtifactStore;
  readonly episodeId: string;
  readonly episodeStartedAt: string;
  readonly persistedRevision: number;
  readonly history: PlaytestVisualHistoryEntry[];
  readonly traceSteps: PlaytestEvidenceTraceStep[];
  readonly capturedFrames: readonly PlaytestArtifactReference[];
  /** What the Runtime measured about the game before this action. */
  readonly progress: PlaytestVisualDecisionProgress;
  /** How much of the screen the decision backend was asked about. */
  readonly offer: PlaytestJsonValue;
  readonly persistRevision: (
    overrides: VisualEpisodeRevisionOverrides,
    view: VisualEpisodeView
  ) => Promise<PlaytestEpisode>;
}): Promise<{
  readonly outcome: VisualActOutcome;
  readonly playerDebrief: PlaytestPlayerDebriefV1;
  readonly stepCount: number;
}> {
  const receipt = await input.driver.act(input.action);
  input.history.push({
    step: input.step,
    action: JSON.stringify(input.action),
    observation: JSON.stringify({
      phase: input.observation.phaseEvidence,
      controls: input.observation.controls.map((control) => control.name)
    }),
    outcome:
      receipt.status === "dispatched"
        ? "dispatched"
        : "refused: " + receipt.reason
  });
  input.traceSteps.push({
    step: input.step,
    phaseId: input.observation.phaseEvidence,
    revisionBefore: input.step,
    revisionAfter: input.step + 1,
    observationVisibility: VISUAL_OBSERVATION_VISIBILITY,
    visibleObservation: visualVisibleObservation(input.observation),
    legalActionIds: visualLegalActionIds(input.observation),
    selectedActionId: visualSelectedActionId(input.action),
    preActionPrediction: {
      intention: input.decision.intention ?? "",
      predictedVisibleEffect: input.decision.predictedVisibleEffect ?? "",
      reasonCode: input.decision.reasonCode
    },
    authoritativeOutcome: {
      status: receipt.status,
      actionKind: input.action.kind,
      observationId: input.action.observationId,
      actionDetail: visualActionDetail(input.action),
      dispatchedAt:
        receipt.status === "dispatched" ? receipt.dispatchedAt : null,
      receiptAt: new Date().toISOString(),
      refusalReason: receipt.status === "refused" ? receipt.reason : null,
      // How much of the screen the decision was made from, so a reader of
      // the trace can tell an offer the contract's bound shortened from a
      // decision made on everything the screen showed.
      offer: input.offer,
      // What the Runtime measured about the game at this step, so a reader
      // of the trace can see the reading the episode was stopped by.
      progress: visualProgressJson(input.progress)
    },
    events: [],
    frameRefs: [{ id: input.observation.frame.artifactId, kind: "frame" }]
  });
  const playerDebrief = playerDebriefCheckpoint(
    input.step,
    input.decision,
    input.capturedFrames
  );
  const stepCount = input.traceSteps.length;
  const progressArtifact = input.artifacts.writeWindow({
    // The trace window is named for the revision the episode writes next,
    // so the windows are named in the order the episode wrote them.
    artifactId:
      "trace-" + input.episodeId + "-r" + String(input.persistedRevision + 1),
    entries: input.traceSteps
  }).reference;
  await input.persistRevision(
    {
      status: "started",
      termination: { reason: "unknown", step: null },
      completionCounts: visualCompletionCounts("started", true),
      trace: {
        id: progressArtifact.artifactId,
        kind: PLAYTEST_REPLAY_SEGMENT_KIND
      },
      completedAt: null,
      completeness: "unknown",
      missingReasons: [],
      policyInferenceMs: input.policy.usage().lastLatencyMs ?? 0,
      simulationWallMs: Date.now() - Date.parse(input.episodeStartedAt)
    },
    { playerDebrief, stepCount }
  );
  if (receipt.status === "dispatched") {
    return { outcome: { status: "dispatched" }, playerDebrief, stepCount };
  }
  if (playtestActionRefusalMeansPageMoved(receipt.reason)) {
    return { outcome: { status: "page-moved" }, playerDebrief, stepCount };
  }
  return {
    outcome: {
      status: "refused",
      exit: {
        kind: PLAYTEST_VISUAL_ACTION_REFUSED_KIND,
        reason: receipt.reason,
        step: input.step
      }
    },
    playerDebrief,
    stepCount
  };
}

/**
 * The progress reading as the trace carries it.
 *
 * The trace's outcome is free-form JSON, so the reading is spelled out here
 * rather than handed over as an object with a contract of its own: a reader
 * of the trace sees the numbers the episode was stopped by.
 */
function visualProgressJson(
  progress: PlaytestVisualDecisionProgress
): PlaytestJsonValue {
  return {
    version: progress.version,
    stuckPolicyVersion: progress.stuckPolicyVersion,
    advanced: progress.advanced,
    loading: progress.loading,
    unchangedSteps: progress.unchangedSteps,
    unchangedMs: progress.unchangedMs,
    policy:
      progress.policy === null
        ? null
        : {
            maxUnchangedDecisions: progress.policy.maxUnchangedDecisions,
            maxUnchangedMs: progress.policy.maxUnchangedMs
          }
  };
}

/**
 * How much of the episode the player could see.
 *
 * A visual episode has no text the player reads, so every trace step says
 * what it saw rather than what it inferred.
 */
const VISUAL_OBSERVATION_VISIBILITY = "visual-only";

/**
 * The Runtime's measurement of one step.
 *
 * What the game did since the previous observation, and the counters the
 * operator's thresholds are measured against. A page that is still loading
 * moves neither the count nor the clock: the game has not had the chance to
 * advance, and a game that is still starting up must not be cut short.
 */
function measureVisualProgress(input: {
  readonly observation: PlaytestVisualObservation;
  readonly previous: PlaytestVisualProgressState | null;
  readonly unchangedSteps: number;
  readonly unchangedMs: number;
  readonly elapsedMs: number;
}): {
  readonly state: PlaytestVisualProgressState;
  readonly outcome: PlaytestVisualProgressOutcome;
  readonly advanced: boolean;
  readonly unchangedSteps: number;
  readonly unchangedMs: number;
} {
  const state = playtestVisualProgressState(input.observation);
  const outcome = playtestVisualProgressOutcome(input.previous, state);
  if (outcome === "advanced") {
    return {
      state,
      outcome,
      advanced: true,
      unchangedSteps: 0,
      unchangedMs: 0
    };
  }
  if (outcome === "unchanged") {
    return {
      state,
      outcome,
      advanced: false,
      unchangedSteps: input.unchangedSteps + 1,
      unchangedMs: input.unchangedMs + input.elapsedMs
    };
  }
  return {
    state,
    outcome,
    advanced: false,
    unchangedSteps: input.unchangedSteps,
    unchangedMs: input.unchangedMs
  };
}

/**
 * Run one visual episode's step loop.
 *
 * The steps are deliberately sequential. Each step observes the game as the
 * previous step's dispatched action left it, so the observation, the decision
 * taken from it and the action dispatched from that decision all depend on
 * the frame before them and cannot be reordered or run together.
 */
async function runVisualEpisodeSteps(input: {
  readonly assignment: PlaytestVisualBatchAssignment;
  readonly driver: PlaytestVisualEpisodeDriver;
  readonly policy: PlaytestVisualPolicy;
  readonly abortSignal: AbortSignal;
  readonly artifacts: PlaytestArtifactStore;
  readonly sessionTarget: WorkspaceVisualPlaytestTargetApproval;
  readonly areasOfFocus: string | null;
  readonly episodeStartedAt: string;
  readonly episodeId: string;
  readonly capturedFrames: PlaytestArtifactReference[];
  readonly traceSteps: PlaytestEvidenceTraceStep[];
  readonly playerDebrief: PlaytestPlayerDebriefV1;
  readonly persistRevision: (
    overrides: VisualEpisodeRevisionOverrides,
    view: VisualEpisodeView
  ) => Promise<PlaytestEpisode>;
}): Promise<VisualEpisodeStepOutcome> {
  const history: PlaytestVisualHistoryEntry[] = [];
  let exit: VisualEpisodeExit = {
    kind: PLAYTEST_VISUAL_STEP_LIMIT_KIND,
    step: null
  };
  let playerDebrief = input.playerDebrief;
  let stepCount = 0;
  // The Runtime's own measurement of whether the game is advancing. The
  // thresholds are the operator's; the measurement is the Runtime's.
  const progressPolicy = playtestVisualProgressPolicy(input.sessionTarget);
  let previousProgress: PlaytestVisualProgressState | null = null;
  let unchangedSteps = 0;
  let unchangedMs = 0;
  let lastMeasuredAtMs = Date.now();

  for (let step = 0; step < input.assignment.maxSteps; step += 1) {
    if (input.abortSignal.aborted) {
      exit = { kind: "cancelled", step };
      break;
    }
    let obsResult;
    try {
      // eslint-disable-next-line no-await-in-loop -- the observation must see the game as the previous step's dispatched action left it.
      obsResult = await input.driver.observe();
    } catch (error) {
      exit = {
        kind: "infrastructure-failure",
        code: visualRuntimeFailureCode(error),
        step
      };
      break;
    }
    if (obsResult.status !== "observed") {
      exit = { kind: "driver-blocked", reason: obsResult.reason, step };
      break;
    }

    const measuredAtMs = Date.now();
    const measurement = measureVisualProgress({
      observation: obsResult.observation,
      previous: previousProgress,
      unchangedSteps,
      unchangedMs,
      elapsedMs: Math.max(0, measuredAtMs - lastMeasuredAtMs)
    });
    previousProgress = measurement.state;
    unchangedSteps = measurement.unchangedSteps;
    unchangedMs = measurement.unchangedMs;
    lastMeasuredAtMs = measuredAtMs;
    const progress: PlaytestVisualDecisionProgress = {
      version: PLAYTESTS_VISUAL_PROGRESS_VERSION,
      stuckPolicyVersion: PLAYTESTS_VISUAL_STUCK_POLICY_VERSION,
      advanced: measurement.advanced,
      loading: measurement.state.loading,
      unchangedSteps,
      unchangedMs,
      policy: progressPolicy
    };
    // The frame the player was looking at when the game stopped advancing is
    // part of the evidence, so it is captured before the guard can end the
    // episode.
    input.capturedFrames.push(obsResult.observation.frame);
    if (
      playtestVisualProgressStuck({
        unchangedSteps,
        unchangedMs,
        policy: progressPolicy
      })
    ) {
      // The game has not advanced for as long as the operator allowed. The
      // episode stops here and says so, instead of spending the rest of its
      // budget on a game that is not responding. The step that showed it is
      // recorded, so the operator can see the screen the game was showing
      // when it stopped.
      input.traceSteps.push({
        step,
        phaseId: obsResult.observation.phaseEvidence,
        revisionBefore: step,
        revisionAfter: step,
        observationVisibility: VISUAL_OBSERVATION_VISIBILITY,
        visibleObservation: visualVisibleObservation(obsResult.observation),
        legalActionIds: visualLegalActionIds(obsResult.observation),
        selectedActionId: null,
        preActionPrediction: null,
        authoritativeOutcome: {
          stopReason: PLAYTEST_VISUAL_NO_PROGRESS_KIND,
          progress: visualProgressJson(progress)
        },
        events: [],
        frameRefs: [
          { id: obsResult.observation.frame.artifactId, kind: "frame" }
        ]
      });
      exit = { kind: PLAYTEST_VISUAL_NO_PROGRESS_KIND, step };
      break;
    }

    // eslint-disable-next-line no-await-in-loop -- the revision must be persisted before the decision that reads the frame it captured.
    const persisted = await input.persistRevision(
      {
        status: "started",
        termination: { reason: "unknown", step: null },
        completionCounts: visualCompletionCounts("started", true),
        trace: null,
        completedAt: null,
        completeness: "unknown",
        missingReasons: [],
        policyInferenceMs: 0,
        simulationWallMs: 0
      },
      { playerDebrief, stepCount }
    );
    const frameBytes = input.artifacts.readArtifact(
      obsResult.observation.frame
    ).bytes;
    // The offer is what a finite-choice backend chooses from. It is derived
    // from the observation, so every action a backend can return is one the
    // Runtime proposed, and the bound on it is the contract's.
    const candidateSet = buildVisualCandidateSet(obsResult.observation);
    const offer = visualCandidateOffer(candidateSet);
    let decision;
    try {
      // eslint-disable-next-line no-await-in-loop -- the decision must be taken from the frame this step captured.
      decision = await input.policy.decide({
        target: input.sessionTarget,
        observation: obsResult.observation,
        frameBytes,
        areasOfFocus: input.areasOfFocus,
        history,
        candidates: candidateSet.candidates,
        // The approved per-episode wall-time budget owns the decision
        // deadline. The driver enforces that same ceiling before every
        // observation and every action, so a decision may not outlive it;
        // a deadline shorter than the budget would cut a healthy provider
        // off mid-answer and report the episode as a runtime failure.
        deadlineMonotonicMs:
          performance.now() + input.driver.remainingWallTimeMs(),
        // What the Runtime measured about the game. A backend that is told
        // the game has not advanced can choose differently; one that is not
        // told cannot.
        progress
      });
    } catch (error) {
      const code = visualRuntimeFailureCode(error);
      input.traceSteps.push({
        step,
        phaseId: obsResult.observation.phaseEvidence,
        revisionBefore: step,
        revisionAfter: step,
        observationVisibility: VISUAL_OBSERVATION_VISIBILITY,
        visibleObservation: visualVisibleObservation(obsResult.observation),
        legalActionIds: visualLegalActionIds(obsResult.observation),
        selectedActionId: null,
        preActionPrediction: null,
        authoritativeOutcome: {
          runtimeFailureCode: code,
          progress: visualProgressJson(progress),
          offer
        },
        events: [],
        frameRefs: [
          { id: obsResult.observation.frame.artifactId, kind: "frame" }
        ]
      });
      exit = visualDecisionFailureExit({
        error,
        code,
        step,
        driver: input.driver
      });
      break;
    }

    if (decision.status === "stop") {
      input.traceSteps.push({
        step,
        phaseId: obsResult.observation.phaseEvidence,
        revisionBefore: step,
        revisionAfter: step,
        observationVisibility: VISUAL_OBSERVATION_VISIBILITY,
        visibleObservation: visualVisibleObservation(obsResult.observation),
        legalActionIds: visualLegalActionIds(obsResult.observation),
        selectedActionId: null,
        preActionPrediction: {
          intention: decision.intention ?? "",
          predictedVisibleEffect: decision.predictedVisibleEffect ?? "",
          reasonCode: decision.reasonCode
        },
        authoritativeOutcome: {
          stopReason: decision.stopReason ?? "",
          progress: visualProgressJson(progress),
          offer
        },
        events: [],
        frameRefs: [
          { id: obsResult.observation.frame.artifactId, kind: "frame" }
        ]
      });
      playerDebrief = completePlayerDebrief({
        requestedFocus: input.areasOfFocus,
        traceSteps: input.traceSteps,
        capturedFrames: input.capturedFrames,
        decision
      });
      exit = visualStopExit(decision, step);
      break;
    }

    const chosenAction = decision.action;
    if (chosenAction === null) {
      exit = { kind: "policy-stop", step };
      break;
    }
    // eslint-disable-next-line no-await-in-loop -- the action must reach the game before the next step observes it.
    const act = await actVisualStep({
      step,
      decision,
      action: chosenAction,
      observation: obsResult.observation,
      driver: input.driver,
      policy: input.policy,
      artifacts: input.artifacts,
      episodeId: input.episodeId,
      episodeStartedAt: input.episodeStartedAt,
      persistedRevision: persisted.revision,
      history,
      traceSteps: input.traceSteps,
      capturedFrames: input.capturedFrames,
      progress,
      offer,
      persistRevision: input.persistRevision
    });
    playerDebrief = act.playerDebrief;
    stepCount = act.stepCount;
    if (act.outcome.status === "refused") {
      exit = act.outcome.exit;
      break;
    }
    if (act.outcome.status === "page-moved") {
      // The page moved under the observation: the driver refused to act on a
      // control the game no longer offers as the observation promised. The
      // episode is not over -- the player looks again and chooses with the
      // refusal in its history.
      continue;
    }
  }
  return { exit, playerDebrief };
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
        batchId.replace(PLAYTEST_BATCH_ID_PREFIX_PATTERN, "").slice(0, 12) +
        "-" +
        String(index),
      ordinal: index,
      maxSteps: input.request.limits.maxStepsPerEpisode
    })
  );

  const targetOrigin = new URL(input.target.entryUrl).origin;
  const manifestDraft: PlaytestAssignmentManifestDraft = {
    schema: PLAYTESTS_VISUAL_ASSIGNMENT_MANIFEST_SCHEMA,
    mode: PLAYTEST_AUTONOMOUS_VISUAL_MODE,
    batchId,
    workspaceId: input.workspaceId,
    targetId: input.target.targetId,
    targetApprovalId: input.target.approvalId,
    targetRevision: input.target.revision,
    targetOrigin,
    policyId: input.request.policyId,
    policyVersion: visualPolicyVersion(input.request.policyId),
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
    policyIds: [input.request.policyId],
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
    executionMode: PLAYTEST_AUTONOMOUS_VISUAL_MODE,
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
      status: PLAYTEST_FROZEN_VISUAL_INVENTORY_STATUS,
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
      PLAYTEST_AUTONOMOUS_VISUAL_MODE,
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
        mode: PLAYTEST_AUTONOMOUS_VISUAL_MODE,
        source: {
          kind: "URL-only",
          repository: null,
          revision: null,
          revisionConfidence: PLAYTEST_DEBRIEF_NOT_APPLICABLE_STATUS,
          checkoutState: PLAYTEST_DEBRIEF_NOT_APPLICABLE_STATUS,
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
        policyId: input.request.policyId,
        policyVersion: visualPolicyVersion(input.request.policyId),
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

      const capturedFrames: PlaytestArtifactReference[] = [];
      let revision = 1;
      let stepCount = 0;
      let startedAtIso: string | null = null;
      let playerDebrief: PlaytestPlayerDebriefV1 = {
        schema: PLAYTEST_PLAYER_DEBRIEF_SCHEMA,
        status: "pending",
        reason: "episode-in-progress"
      };

      const persistRevision = async (
        overrides: VisualEpisodeRevisionOverrides,
        view: VisualEpisodeView
      ): Promise<PlaytestEpisode> => {
        const episode: PlaytestEpisode = {
          schema: PLAYTESTS_EPISODE_SCHEMA,
          episodeId,
          revision,
          batchId,
          assignmentId: assignment.assignmentId,
          branchLineage: null,
          executionProvenance,
          playerDebrief: view.playerDebrief,
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
          stepCount: view.stepCount,
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

      // eslint-disable-next-line no-await-in-loop -- the assigned revision must be persisted before the driver opens, so the episode record exists before any step runs.
      await persistRevision(
        {
          status: "assigned",
          termination: { reason: "unknown", step: null },
          completionCounts: visualCompletionCounts("assigned", false),
          trace: null,
          completedAt: null,
          completeness: "unknown",
          missingReasons: [],
          policyInferenceMs: 0,
          simulationWallMs: null
        },
        { playerDebrief, stepCount }
      );

      let driver: PlaytestVisualEpisodeDriver;
      try {
        // eslint-disable-next-line no-await-in-loop -- the batch runs one episode at a time, so the browser opens only after the previous episode closed.
        driver = await input.openVisualDriver({
          target: sessionTarget,
          episodeId,
          artifacts: input.artifacts,
          viewport: { width: 1280, height: 720, deviceScaleFactor: 1 },
          actionTimeoutMs: Math.min(10_000, sessionTarget.limits.wallTimeMs),
          maxSteps: assignment.maxSteps
        });
      } catch (error) {
        reportVisualDriverOpenFailure({
          batchId,
          episodeId,
          assignmentId: assignment.assignmentId,
          error: error
        });
        playerDebrief = {
          schema: PLAYTEST_PLAYER_DEBRIEF_SCHEMA,
          status: "unavailable",
          reason: "interrupted-before-checkpoint"
        };
        // eslint-disable-next-line no-await-in-loop -- the failed revision must be persisted before the next episode starts, so the batch sees each episode's terminal state in order.
        const failedEpisode = await persistRevision(
          {
            status: PLAYTEST_INFRASTRUCTURE_FAILURE_STATE,
            termination: { reason: "runtime-failure", step: null },
            completionCounts: visualCompletionCounts(
              PLAYTEST_INFRASTRUCTURE_FAILURE_STATE,
              false
            ),
            trace: null,
            completedAt: new Date().toISOString(),
            completeness: "unknown",
            missingReasons: [PLAYTEST_INFRASTRUCTURE_FAILURE_STATE],
            policyInferenceMs: 0,
            simulationWallMs: null
          },
          { playerDebrief, stepCount }
        );
        activeRun.outcomes.set(assignment.assignmentId, {
          assignmentId: assignment.assignmentId,
          state: PLAYTEST_INFRASTRUCTURE_FAILURE_STATE,
          episodeId: failedEpisode.episodeId,
          started: false,
          eligible: false,
          gameOutcome: null
        });
        continue;
      }

      const episodeStartedAt = new Date().toISOString();
      startedAtIso = episodeStartedAt;
      // eslint-disable-next-line no-await-in-loop -- the started revision must be persisted before the first step, so the episode record is ordered before the steps it records.
      await persistRevision(
        {
          status: "started",
          termination: { reason: "unknown", step: null },
          completionCounts: visualCompletionCounts("started", true),
          trace: null,
          completedAt: null,
          completeness: "unknown",
          missingReasons: [],
          policyInferenceMs: 0,
          simulationWallMs: 0
        },
        { playerDebrief, stepCount }
      );

      const policy = input.createVisualPolicy({
        target: sessionTarget,
        workspacePath: policyWorkspace.workspacePath,
        policyId: input.request.policyId
      });
      const traceSteps: PlaytestEvidenceTraceStep[] = [];
      // eslint-disable-next-line no-await-in-loop -- the batch runs one episode at a time, so each episode's steps land in the shared batch state in order.
      const outcome = await runVisualEpisodeSteps({
        assignment,
        driver,
        policy,
        abortSignal: activeRun.controller.signal,
        artifacts: input.artifacts,
        sessionTarget,
        areasOfFocus,
        episodeStartedAt,
        episodeId,
        capturedFrames,
        traceSteps,
        playerDebrief,
        persistRevision
      });
      const exit = outcome.exit;
      playerDebrief = outcome.playerDebrief;

      stepCount = traceSteps.length;
      // eslint-disable-next-line no-await-in-loop -- the driver must close before the next episode opens, so the browser budget is released in the order the episodes ran.
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
      // eslint-disable-next-line no-await-in-loop -- the final revision must be persisted before the next episode starts, so the batch sees each episode's terminal state in order.
      const finalEpisode = await persistRevision(
        {
          status: disposition.status,
          termination: disposition.termination,
          completionCounts: visualCompletionCounts(disposition.status, true),
          trace: {
            id: traceArtifact.artifactId,
            kind: PLAYTEST_REPLAY_SEGMENT_KIND
          },
          completedAt,
          completeness,
          missingReasons,
          policyInferenceMs: policy.usage().lastLatencyMs ?? 0,
          simulationWallMs: Date.now() - Date.parse(episodeStartedAt)
        },
        { playerDebrief, stepCount }
      );
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
    const terminalStatus = playtestBatchTerminalState({
      assignmentCount: assignments.length,
      outcomes: [...activeRun.outcomes.values()],
      cancelled: activeRun.reason !== null,
      aborted: false
    });
    const finalBatch: PlaytestVisualBatch = {
      ...initialBatch,
      revision: 2,
      status: terminalStatus,
      completedAt: new Date().toISOString(),
      counts: finalCounts
    };
    await input.repository.insertBatch(finalBatch);
    return {
      ...activeRunProgress(activeRun),
      status: terminalStatus
    };
  } finally {
    for (const workspace of policyWorkspaces) {
      removePlaytestPolicyWorkspace(workspace);
    }
  }
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

export function requiredRunRepository(
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
    createVisualPolicy = ({ target, workspacePath, policyId }) =>
      policyId === "onejev-local"
        ? new OneJevLocalVisualPolicy(target, {
            ...(process.env.AUTODEV_ONEJEV_ENDPOINT === undefined
              ? {}
              : { endpoint: process.env.AUTODEV_ONEJEV_ENDPOINT })
          })
        : new SmartDirectVisualPolicy(target, { workspacePath })
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
        parsed.mode !== PLAYTEST_AUTONOMOUS_VISUAL_MODE
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
        parsed.mode === PLAYTEST_AUTONOMOUS_VISUAL_MODE
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
        const priorReceipt = await priorLaunchReceiptForRequest({
          repository,
          intentRepository,
          activeRuns,
          assignmentLocks,
          targetWorkspaceId,
          session,
          parsed
        });
        if (priorReceipt !== null) return priorReceipt;

        if (parsed.mode === PLAYTEST_AUTONOMOUS_VISUAL_MODE) {
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
              // The execution always reports a terminal status, but the
              // finisher treats a result that carries none as a completed
              // run rather than reporting a status it does not have.
              const executionStatus: PlaytestRunStatus["status"] | undefined =
                result.status;
              finishRun(
                result.batchId,
                {
                  batchId: result.batchId,
                  status:
                    cancellationReason === null
                      ? (executionStatus ?? "completed")
                      : "cancelled",
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
    dispatchCrossSessionReview(session, workspaceId, episodeIds, request) {
      assertPlaytestToolRole(
        session.role,
        ANALYST_DISPATCH_ROLES,
        "Console playtest analyst dispatch"
      );
      const authorizedWorkspaceId = authorizeWorkspace(workspaceId, session);
      const uniqueEpisodeIds = [...new Set(episodeIds)];
      // A request that asks for findings is a different job from a hypothesis
      // review, and the analyst has to be told which one it is running.
      const requireFindings = request?.requireFindings === true;
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
          if (firstBatch?.executionMode === PLAYTEST_AUTONOMOUS_VISUAL_MODE) {
            // A findings request against a discovery selection would come back
            // as a discovery review: the discovery contract has no findings
            // field, so the analyst could not file one even if the evidence
            // showed a defect. Refusing here keeps "the review asked for
            // findings" and "the review filed findings" from being two
            // different claims about the same run.
            if (requireFindings) {
              throw new PlaytestMcpValidationError(
                "Findings require a confirmatory review of a completed, selected batch; visual discovery sessions cannot file findings."
              );
            }
            return dispatchVisualDiscoveryReview({
              workspaceId: authorizedWorkspaceId,
              actor: session.actor,
              episodeIds: uniqueEpisodeIds,
              episode: firstEpisode!,
              batch: firstBatch,
              repository: visualRepository,
              artifactStoreForWorkspace,
              analystReviewRuns,
              activeAnalystRuns,
              launchAnalystProcess,
              finalizeAnalystRun,
              pruneAnalystReviewHistory
            });
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
            requireFindings: requireFindings,
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
          const process = startAnalystProcess({
            launchAnalystProcess,
            analysisId,
            workspaceId: authorizedWorkspaceId,
            actor: session.actor,
            episodeIds: packets.map((packet) => packet.episodeId),
            analysisKind: "confirmatory",
            metricAggregation,
            requireFindings,
            failureMessage: "The analyst process could not be started."
          });
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
    case PLAYTEST_INFRASTRUCTURE_FAILURE_STATE: {
      return "The session became infrastructure loss.";
    }
    case "cancelled": {
      return "The session was cancelled.";
    }
    case PLAYTEST_BUDGET_TRUNCATED_STATE: {
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

/** What one visual discovery dispatch reports back to the caller. */
interface VisualDiscoveryReviewDispatch {
  readonly run: PlaytestAnalystReviewRun | null;
  readonly packets: readonly PlaytestCrossSessionPacket[];
  readonly receipts: readonly PlaytestCrossSessionReceipt[];
  readonly budget: readonly PlaytestCrossSessionBudget[];
}

/**
 * Start one analyst process, reporting a launch failure as unavailable.
 *
 * The launcher throws when the analyst process cannot start at all. The
 * caller reports that as an unavailable dispatch rather than as a review
 * that ran and failed.
 */
function startAnalystProcess(input: {
  readonly launchAnalystProcess: PlaytestAnalystProcessLauncher;
  readonly analysisId: string;
  readonly workspaceId: string;
  readonly actor: string;
  readonly episodeIds: readonly string[];
  readonly analysisKind: "confirmatory" | "discovery";
  readonly metricAggregation: PlaytestCrossSessionMetricAggregation | null;
  readonly requireFindings: boolean;
  readonly failureMessage: string;
}): PlaytestAnalystProcess {
  try {
    return input.launchAnalystProcess({
      analysisId: input.analysisId,
      workspaceId: input.workspaceId,
      actor: input.actor,
      episodeIds: input.episodeIds,
      analysisKind: input.analysisKind,
      metricAggregation: input.metricAggregation,
      requireFindings: input.requireFindings
    });
  } catch (error) {
    throw new PlaytestMcpUnavailableError(
      error instanceof Error ? error.message : input.failureMessage
    );
  }
}

/**
 * Dispatch one visual discovery review.
 *
 * A visual discovery batch reviews one episode at a time against its frozen
 * assignment inventory, and the frozen inventory is the review cap: one
 * review per assignment. The dispatch reports the episode it refused rather
 * than starting a review it cannot complete.
 */
async function dispatchVisualDiscoveryReview(input: {
  readonly workspaceId: string;
  readonly actor: string;
  readonly episodeIds: readonly string[];
  readonly episode: PlaytestEpisode;
  readonly batch: PlaytestVisualBatch;
  readonly repository: PlaytestingRepositoryOps;
  readonly artifactStoreForWorkspace: (
    workspaceId: string
  ) => PlaytestArtifactStore;
  readonly analystReviewRuns: Map<string, PlaytestAnalystReviewRun>;
  readonly activeAnalystRuns: Map<string, ActiveAnalystReviewRun>;
  readonly launchAnalystProcess: PlaytestAnalystProcessLauncher;
  readonly finalizeAnalystRun: (
    analysisId: string,
    result: PlaytestAnalystProcessResult
  ) => Promise<void>;
  readonly pruneAnalystReviewHistory: () => void;
}): Promise<VisualDiscoveryReviewDispatch> {
  const episode = input.episode;
  const firstBatch = input.batch;
  if (input.episodeIds.length !== 1) {
    throw new PlaytestMcpValidationError(
      "Visual discovery reviews are dispatched one episode at a time and cannot be mixed with adapter confirmatory reviews."
    );
  }
  if (
    firstBatch.assignmentInventory.status !==
      PLAYTEST_FROZEN_VISUAL_INVENTORY_STATUS ||
    firstBatch.status === "running" ||
    firstBatch.status === "queued"
  ) {
    throw new PlaytestMcpUnavailableError(
      "Visual discovery review requires a terminal run and its frozen visual assignment manifest."
    );
  }
  if (episode.stepCount < 1 || episode.trace === null) {
    return {
      run: null,
      packets: [],
      receipts: [
        {
          episodeId: episode.episodeId,
          batchId: firstBatch.batchId,
          reason: "packet-unavailable",
          detail: "The visual session has no persisted trace steps to review."
        }
      ],
      budget: []
    };
  }
  const activeDiscoveryReservations = [...input.analystReviewRuns.values()]
    .filter(
      (run) =>
        run.workspaceId === input.workspaceId &&
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
    firstBatch.assignmentInventory.manifest.assignments.map((assignment) =>
      playtestVisualEpisodeRecordId(firstBatch.batchId, assignment.assignmentId)
    );
  const priorDiscoveryReviews = await mapConcurrentOrdered(
    assignmentEpisodeIds,
    4,
    (episodeId) =>
      input.repository.getLatestDiscoveryReviewForEpisode(
        input.workspaceId,
        episodeId
      )
  );
  const actualCritiques = priorDiscoveryReviews.filter(
    (review) => review !== null
  ).length;
  const reserved = activeDiscoveryReservations.length;
  const remaining = Math.max(0, assignmentLimit - actualCritiques - reserved);
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
    currentAssignmentIndex === -1
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
    workspaceId: input.workspaceId,
    episode,
    repository: input.repository,
    artifacts: input.artifactStoreForWorkspace(input.workspaceId)
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
    workspaceId: input.workspaceId,
    analysisKind: "discovery",
    status: "running",
    createdAt,
    finishedAt: null,
    requestedEpisodeIds: input.episodeIds,
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
  const process = startAnalystProcess({
    launchAnalystProcess: input.launchAnalystProcess,
    analysisId,
    workspaceId: input.workspaceId,
    actor: input.actor,
    episodeIds: input.episodeIds,
    analysisKind: "discovery",
    metricAggregation: null,
    requireFindings: false,
    failureMessage: "The discovery analyst process could not be started."
  });
  input.analystReviewRuns.set(analysisId, record);
  input.activeAnalystRuns.set(analysisId, { process });
  void process.completion.then(
    (result) => input.finalizeAnalystRun(analysisId, result),
    () =>
      input.finalizeAnalystRun(analysisId, {
        exitCode: null,
        signal: null,
        timedOut: false,
        launchFailed: true,
        diagnostic: null
      })
  );
  input.pruneAnalystReviewHistory();
  return {
    run: record,
    packets: [packet],
    receipts: [],
    budget: record.budget
  };
}

export async function readPreparedReviewPacket(input: {
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
  if (batch.executionMode === PLAYTEST_AUTONOMOUS_VISUAL_MODE) {
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

export function playtestMcpErrorDetails(error: unknown): {
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
