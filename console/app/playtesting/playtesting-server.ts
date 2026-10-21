/** Server-only authenticated Playtesting reads for the Console resource. */
import {
  assertPlaytestCoverageManifest,
  assertPlaytestDiscoverySessionReview,
  assertPlaytestExecutionProvenance,
  assertPlaytestNumericResults,
  assertWorkspaceVisualPlaytestTargetApproval,
  CONTROL_API_PLAYTESTING_READINESS_SCHEMA,
  type ControlApiPlaytestingActiveRunsResponse,
  type ControlApiPlaytestingAnalysesResponse,
  type ControlApiPlaytestingAnalysisDispatchResponse,
  type ControlApiPlaytestingAnalystRun,
  type ControlApiPlaytestingCapabilitiesResponse,
  type ControlApiPlaytestingComparisonDecisionRequest,
  type ControlApiPlaytestingComparisonDecisionResponse,
  type ControlApiPlaytestingEntityMap,
  type ControlApiPlaytestingEpisodeDetailResponse,
  type ControlApiPlaytestingHumanValidationResponse,
  type ControlApiPlaytestingPageResponse,
  type ControlApiPlaytestingReadinessResponse,
  type ControlApiPlaytestingResource,
  type ControlApiPlaytestingRunCancellationResponse,
  type ControlApiPlaytestingRunRecord,
  type ControlApiPlaytestingRunRequestLookupResponse,
  type ControlApiPlaytestingRunStartedResponse,
  type ControlApiPlaytestingRunStatusResponse,
  type ControlApiPlaytestingVisualAssignment,
  type ControlApiPlaytestingWindowResponse,
  type HumanPlaytestStudy,
  isControlApiPlaytestingRunState,
  type PlaytestBatch,
  type PlaytestBenchmark,
  type PlaytestComparison,
  type PlaytestEpisode,
  type PlaytestExperiment,
  type PlaytestFinding,
  type PlaytestJsonValue,
  type PlaytestLaunchRequest,
  type PlaytestSessionReference,
  PLAYTESTS_BATCH_SCHEMA,
  PLAYTESTS_BATCH_SCHEMA_V1,
  PLAYTESTS_BATCH_SCHEMA_V2,
  PLAYTESTS_BATCH_SCHEMA_V3,
  PLAYTESTS_COMPARISON_SCHEMA,
  PLAYTESTS_EPISODE_SCHEMA,
  PLAYTESTS_EPISODE_SCHEMA_V1,
  PLAYTESTS_EPISODE_SCHEMA_V2,
  PLAYTESTS_EPISODE_SCHEMA_V3,
  PLAYTESTS_EPISODE_SCHEMA_V4,
  PLAYTESTS_EPISODE_SCHEMA_V5,
  PLAYTESTS_EPISODE_SCHEMA_V6,
  PLAYTESTS_EPISODE_TERMINATION_REASONS,
  PLAYTESTS_MAX_ANALYSIS_SESSIONS,
  PLAYTESTS_MAX_BATCH_ASSIGNMENTS,
  PLAYTESTS_SESSION_REVIEW_SCHEMA,
  type PlaytestSessionReview
} from "@simulatorlife/autodev-core";

import {
  PLAYTESTING_FILTERS_BY_RESOURCE,
  type PlaytestingFilterKey
} from "../../src/features/playtesting/playtesting-url.ts";
import {
  CONTROL_API_PATHS,
  type ControlApiBinaryData,
  type ControlApiConfig,
  controlApiFailureCode,
  type ControlApiResult,
  fetchControlApi,
  fetchControlApiBinary,
  type FetchControlApiOptions,
  PLAYTESTING_CONTROL_API_TIMEOUT_MS,
  postControlApi
} from "../../src/lib/server/control-api.ts";

/**
 * Give every playtesting Control API call the playtesting budget. The
 * playtesting store is ClickHouse-backed and answers one read in seconds,
 * while the playtesting page fans several reads out in parallel, so the
 * generic Control API deadline would expire against a service that is
 * answering normally.
 */
function playtestingControlApiOptions(
  options: FetchControlApiOptions
): FetchControlApiOptions {
  return {
    ...options,
    timeoutMs: options.timeoutMs ?? PLAYTESTING_CONTROL_API_TIMEOUT_MS
  };
}

const RESOURCE_SCHEMAS: Readonly<
  Record<ControlApiPlaytestingResource, string>
> = {
  batches: PLAYTESTS_BATCH_SCHEMA,
  episodes: PLAYTESTS_EPISODE_SCHEMA,
  findings: "",
  comparisons: PLAYTESTS_COMPARISON_SCHEMA,
  benchmarks: "",
  experiments: "autodev-playtest-experiment-v1",
  "human-studies": "autodev-playtest-human-study-v1"
};
const SHA_PATTERN = /^(?:[a-f\d]{40}|[a-f\d]{64})$/iu;
const CAPABILITY_REVISION_PATTERN = /^[a-f\d]{64}$/u;
const REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/u;
const ASSIGNMENT_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/u;
const EPISODE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;
const WORKSPACE_ID_PATTERN = /^[^/\s]+\/[^/\s]+$/u;
const ENTITY_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/u;
const PLAYTESTING_READINESS_LABEL = "Playtesting readiness";
const CANONICAL_WORKSPACE_REQUIREMENT = "a canonical workspaceId";
export type PlaytestingPage<Row> =
  ControlApiPlaytestingPageResponse<Row>["page"];

export async function fetchPlaytestingReadiness(
  workspaceId: string,
  config: ControlApiConfig,
  options: FetchControlApiOptions & { readonly retry?: boolean } = {}
): Promise<ControlApiResult<ControlApiPlaytestingReadinessResponse>> {
  if (!WORKSPACE_ID_PATTERN.test(workspaceId)) {
    return invalidResponse(
      PLAYTESTING_READINESS_LABEL,
      CANONICAL_WORKSPACE_REQUIREMENT
    );
  }
  const path = `${options.retry ? CONTROL_API_PATHS.playtestingInitialization : CONTROL_API_PATHS.playtestingReadiness}?workspaceId=${encodeURIComponent(workspaceId)}`;
  const result = options.retry
    ? await postControlApi<unknown>(
        path,
        undefined,
        config,
        playtestingControlApiOptions(options)
      )
    : await fetchControlApi<unknown>(
        path,
        config,
        playtestingControlApiOptions(options)
      );
  if (result.kind !== "ok") return result;
  const value = result.data;
  return isRecord(value) &&
    value.schema === CONTROL_API_PLAYTESTING_READINESS_SCHEMA &&
    value.workspaceId === workspaceId &&
    (value.status === "initializing" || value.status === "ready")
    ? {
        kind: "ok",
        data: value as unknown as ControlApiPlaytestingReadinessResponse
      }
    : invalidResponse(
        PLAYTESTING_READINESS_LABEL,
        CONTROL_API_PLAYTESTING_READINESS_SCHEMA
      );
}

export interface PlaytestingReadinessFailure {
  readonly status: "initializing" | "unavailable";
  readonly code: string;
  readonly message: string;
}

export function playtestingReadinessFailure(
  result: Exclude<ControlApiResult<unknown>, { readonly kind: "ok" }>
): PlaytestingReadinessFailure | null {
  const code = controlApiFailureCode(result);
  if (
    code !== "autodev_control_playtesting_source_initializing" &&
    code !== "autodev_control_playtesting_source_unavailable"
  ) {
    return null;
  }
  return {
    status:
      code === "autodev_control_playtesting_source_initializing"
        ? "initializing"
        : "unavailable",
    code,
    message: result.message
  };
}

export interface PlaytestingPageRequest {
  readonly workspaceId: string;
  readonly limit: number;
  readonly cursor?: string | null;
  readonly filters?: Readonly<Partial<Record<PlaytestingFilterKey, string>>>;
}

export interface PlaytestingWindowRequest {
  readonly workspaceId: string;
  readonly episodeId: string;
  readonly artifactId: string;
  readonly startStep: number;
  readonly endStep: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isCount(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isJsonValue(value: unknown, depth = 0): value is PlaytestJsonValue {
  if (depth > 64) return false;
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "string"
  ) {
    return true;
  }
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value))
    return value.every((entry) => isJsonValue(entry, depth + 1));
  return (
    isRecord(value) &&
    Object.values(value).every((entry) => isJsonValue(entry, depth + 1))
  );
}

const VALID_BATCH_SCHEMAS = new Set<string>([
  PLAYTESTS_BATCH_SCHEMA,
  PLAYTESTS_BATCH_SCHEMA_V3,
  PLAYTESTS_BATCH_SCHEMA_V2,
  PLAYTESTS_BATCH_SCHEMA_V1
]);

const VALID_EPISODE_SCHEMAS = new Set<string>([
  PLAYTESTS_EPISODE_SCHEMA,
  PLAYTESTS_EPISODE_SCHEMA_V6,
  PLAYTESTS_EPISODE_SCHEMA_V5,
  PLAYTESTS_EPISODE_SCHEMA_V4,
  PLAYTESTS_EPISODE_SCHEMA_V3,
  PLAYTESTS_EPISODE_SCHEMA_V2,
  PLAYTESTS_EPISODE_SCHEMA_V1
]);

function hasSchema(
  value: unknown,
  resource: ControlApiPlaytestingResource
): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
  if (resource === "batches") {
    return (
      typeof value.schema === "string" && VALID_BATCH_SCHEMAS.has(value.schema)
    );
  }
  if (resource === "episodes") {
    return (
      typeof value.schema === "string" &&
      VALID_EPISODE_SCHEMAS.has(value.schema)
    );
  }
  const expectedSchema = RESOURCE_SCHEMAS[resource];
  return expectedSchema === "" || value.schema === expectedSchema;
}

function validBatchRecord(
  value: Record<string, unknown>,
  workspaceId: string
): boolean {
  const batch = value as unknown as PlaytestBatch;
  if (batch.coverageManifest !== null) {
    try {
      assertPlaytestCoverageManifest(batch.coverageManifest);
    } catch {
      return false;
    }
    if (
      batch.assignmentInventory.status !== "frozen" ||
      batch.coverageManifest.workspaceId !== batch.workspaceId ||
      batch.coverageManifest.batchId !== batch.batchId ||
      batch.coverageManifest.buildSha !== batch.buildSha ||
      batch.coverageManifest.rubricHash !== batch.rubricHash ||
      batch.coverageManifest.assignmentManifestHash !==
        batch.assignmentInventory.manifest.contentHash ||
      batch.coverageManifest.assignedEpisodes !== batch.budget.assignedEpisodes
    ) {
      return false;
    }
  }
  return (
    batch.workspaceId === workspaceId &&
    isNonEmptyString(batch.batchId) &&
    isCount(batch.revision) &&
    Array.isArray(batch.policyIds) &&
    isCount(batch.counts?.assigned)
  );
}

function validEpisodeRecord(
  value: Record<string, unknown>,
  workspaceId: string
): boolean {
  const episode = value as unknown as PlaytestEpisode;
  try {
    assertPlaytestExecutionProvenance(episode.executionProvenance);
    assertPlaytestNumericResults(episode.metrics);
  } catch {
    return false;
  }
  const termination = episode.termination;
  return (
    episode.identity?.workspaceId === workspaceId &&
    isNonEmptyString(episode.episodeId) &&
    isNonEmptyString(episode.batchId) &&
    isCount(episode.revision) &&
    isCount(episode.stepCount) &&
    Array.isArray(episode.frames) &&
    isRecord(termination) &&
    (PLAYTESTS_EPISODE_TERMINATION_REASONS as readonly unknown[]).includes(
      termination.reason
    ) &&
    (termination.step === null || isCount(termination.step))
  );
}

function validPlaytestRecord<R extends ControlApiPlaytestingResource>(
  value: unknown,
  resource: R,
  workspaceId: string
): value is ControlApiPlaytestingEntityMap[R] {
  if (!hasSchema(value, resource)) return false;
  switch (resource) {
    case "batches": {
      return validBatchRecord(value, workspaceId);
    }
    case "episodes": {
      return validEpisodeRecord(value, workspaceId);
    }
    case "findings": {
      const finding = value as unknown as PlaytestFinding;
      return (
        isNonEmptyString(finding.findingId) &&
        isNonEmptyString(finding.title) &&
        isCount(finding.version) &&
        (finding.affectedEpisodes === null ||
          isCount(finding.affectedEpisodes)) &&
        (finding.totalEligibleEpisodes === null ||
          isCount(finding.totalEligibleEpisodes)) &&
        (finding.affectedOpportunities === null ||
          isCount(finding.affectedOpportunities)) &&
        (finding.totalEligibleOpportunities === null ||
          isCount(finding.totalEligibleOpportunities)) &&
        Array.isArray(finding.evidenceRefs)
      );
    }
    case "comparisons": {
      const comparison = value as unknown as PlaytestComparison;
      return (
        isNonEmptyString(comparison.comparisonId) &&
        isNonEmptyString(comparison.benchmarkId) &&
        isCount(comparison.version) &&
        Array.isArray(comparison.metrics)
      );
    }
    case "benchmarks": {
      const benchmark = value as unknown as PlaytestBenchmark;
      return (
        benchmark.workspaceId === workspaceId &&
        isNonEmptyString(benchmark.benchmarkId) &&
        isCount(benchmark.version) &&
        SHA_PATTERN.test(benchmark.referenceBuildSha)
      );
    }
    case "experiments": {
      const experiment = value as unknown as PlaytestExperiment;
      return (
        experiment.workspaceId === workspaceId &&
        isNonEmptyString(experiment.experimentId) &&
        isCount(experiment.version) &&
        Array.isArray(experiment.findingIds)
      );
    }
    case "human-studies": {
      const study = value as unknown as HumanPlaytestStudy;
      return (
        study.workspaceId === workspaceId &&
        isNonEmptyString(study.studyId) &&
        isCount(study.version) &&
        isNonEmptyString(study.instrumentVersion) &&
        !("participantId" in value) &&
        !("responses" in value)
      );
    }
    default: {
      return false;
    }
  }
}

function isPlaytestingPageResponse<R extends ControlApiPlaytestingResource>(
  value: unknown,
  resource: R,
  workspaceId: string
): value is ControlApiPlaytestingPageResponse<
  ControlApiPlaytestingEntityMap[R]
> {
  if (
    !isRecord(value) ||
    value.schema !== "autodev-control-playtesting-page-v1" ||
    value.workspaceId !== workspaceId ||
    value.resource !== resource ||
    value.readOnly !== true ||
    !isRecord(value.page) ||
    !Array.isArray(value.page.rows) ||
    !isCount(value.page.total) ||
    (value.page.nextCursor !== null && !isNonEmptyString(value.page.nextCursor))
  ) {
    return false;
  }
  return value.page.rows.every((row) =>
    validPlaytestRecord(row, resource, workspaceId)
  );
}

function isReview(
  value: unknown,
  episodeId: string
): value is PlaytestSessionReview {
  return (
    isRecord(value) &&
    value.schema === PLAYTESTS_SESSION_REVIEW_SCHEMA &&
    value.episodeId === episodeId &&
    isNonEmptyString(value.reviewId) &&
    isCount(value.version) &&
    value.authorRole === "playtest-analyst" &&
    (value.evidencePacket === null ||
      (isRecord(value.evidencePacket) &&
        isNonEmptyString(value.evidencePacket.packetId) &&
        isRecord(value.evidencePacket.artifact) &&
        isNonEmptyString(value.evidencePacket.artifact.artifactId) &&
        SHA_PATTERN.test(String(value.evidencePacket.artifact.sha256)) &&
        isCount(value.evidencePacket.artifact.bytes) &&
        value.evidencePacket.artifact.mediaType ===
          "application/vnd.autodev.playtest-evidence-packet+json")) &&
    Array.isArray(value.findings) &&
    Array.isArray(value.evidenceRefs)
  );
}

function isDiscoveryReview(
  value: unknown,
  workspaceId: string,
  episodeId: string
): boolean {
  try {
    assertPlaytestDiscoverySessionReview(value);
    return value.workspaceId === workspaceId && value.episodeId === episodeId;
  } catch {
    return false;
  }
}

const VISUAL_ASSIGNMENT_KEYS = new Set([
  "areasOfFocus",
  "targetApprovalId",
  "targetId",
  "targetOrigin",
  "targetRevision"
]);

function isVisualAssignment(
  value: unknown,
  episode: PlaytestEpisode
): value is ControlApiPlaytestingVisualAssignment {
  const source = episode.executionProvenance.source;
  return (
    episode.executionProvenance.mode === "autonomous-visual" &&
    isRecord(value) &&
    Object.keys(value).length === VISUAL_ASSIGNMENT_KEYS.size &&
    Object.keys(value).every((key) => VISUAL_ASSIGNMENT_KEYS.has(key)) &&
    value.targetId === source.targetId &&
    value.targetOrigin === source.targetOrigin &&
    isNonEmptyString(value.targetApprovalId) &&
    isCount(value.targetRevision) &&
    value.targetRevision > 0 &&
    (value.areasOfFocus === null ||
      (typeof value.areasOfFocus === "string" &&
        value.areasOfFocus.length > 0 &&
        value.areasOfFocus.length <= 2000))
  );
}

function isEpisodeDetailResponse(
  value: unknown,
  workspaceId: string,
  episodeId: string
): value is ControlApiPlaytestingEpisodeDetailResponse {
  if (
    !isRecord(value) ||
    value.schema !== "autodev-control-playtesting-detail-v4" ||
    value.workspaceId !== workspaceId ||
    value.resource !== "episode" ||
    value.readOnly !== true ||
    !validPlaytestRecord(value.record, "episodes", workspaceId) ||
    value.record.episodeId !== episodeId ||
    (value.latestReview !== null && !isReview(value.latestReview, episodeId)) ||
    (value.latestDiscoveryReview !== null &&
      !isDiscoveryReview(value.latestDiscoveryReview, workspaceId, episodeId))
  ) {
    return false;
  }
  const episode = value.record;
  return episode.executionProvenance.mode === "autonomous-visual"
    ? isVisualAssignment(value.visualAssignment, episode)
    : value.visualAssignment === null;
}

function invalidResponse<T>(
  subject: string,
  schema: string
): ControlApiResult<T> {
  return {
    kind: "invalid-response",
    code: "autodev_control_playtesting_invalid_response",
    message: `AutoDev Control API returned an incompatible ${subject} response; the Console requires ${schema}.`
  };
}

function pagePath(
  request: PlaytestingPageRequest,
  resource: ControlApiPlaytestingResource
): string {
  const params = new URLSearchParams({
    workspaceId: request.workspaceId,
    limit: String(request.limit)
  });
  if (request.cursor) params.set("cursor", request.cursor);
  for (const key of PLAYTESTING_FILTERS_BY_RESOURCE[resource]) {
    const value = request.filters?.[key];
    if (value) params.set(key, value);
  }
  return `${CONTROL_API_PATHS.playtesting}/${resource}?${params.toString()}`;
}

export async function fetchPlaytestingPage<
  R extends ControlApiPlaytestingResource
>(
  resource: R,
  request: PlaytestingPageRequest,
  config: ControlApiConfig,
  options: FetchControlApiOptions = {}
): Promise<
  ControlApiResult<
    ControlApiPlaytestingPageResponse<ControlApiPlaytestingEntityMap[R]>
  >
> {
  if (!WORKSPACE_ID_PATTERN.test(request.workspaceId)) {
    return invalidResponse("Playtesting page", CANONICAL_WORKSPACE_REQUIREMENT);
  }
  const result = await fetchControlApi<unknown>(
    pagePath(request, resource),
    config,
    playtestingControlApiOptions(options)
  );
  if (result.kind !== "ok") return result;
  return isPlaytestingPageResponse(result.data, resource, request.workspaceId)
    ? { kind: "ok", data: result.data }
    : invalidResponse(resource, "autodev-control-playtesting-page-v1");
}

export async function fetchPlaytestingEpisode(
  workspaceId: string,
  episodeId: string,
  config: ControlApiConfig,
  options: FetchControlApiOptions = {}
): Promise<ControlApiResult<ControlApiPlaytestingEpisodeDetailResponse>> {
  const path = `${CONTROL_API_PATHS.playtesting}/episodes/${encodeURIComponent(episodeId)}?workspaceId=${encodeURIComponent(workspaceId)}`;
  const result = await fetchControlApi<unknown>(
    path,
    config,
    playtestingControlApiOptions(options)
  );
  if (result.kind !== "ok") return result;
  return isEpisodeDetailResponse(result.data, workspaceId, episodeId)
    ? { kind: "ok", data: result.data }
    : invalidResponse(
        "Playtesting episode",
        "autodev-control-playtesting-detail-v4"
      );
}

export function fetchPlaytestingFrame(
  workspaceId: string,
  episodeId: string,
  artifactId: string,
  config: ControlApiConfig,
  options: FetchControlApiOptions = {}
): Promise<ControlApiResult<ControlApiBinaryData>> {
  const path = `${CONTROL_API_PATHS.playtesting}/episodes/${encodeURIComponent(
    episodeId
  )}/media/${encodeURIComponent(artifactId)}?workspaceId=${encodeURIComponent(workspaceId)}`;
  return fetchControlApiBinary(
    path,
    config,
    playtestingControlApiOptions(options)
  );
}

function isWindowResponse(
  value: unknown,
  request: PlaytestingWindowRequest
): value is ControlApiPlaytestingWindowResponse {
  return (
    isRecord(value) &&
    value.schema === "autodev-control-playtesting-window-v1" &&
    value.workspaceId === request.workspaceId &&
    value.episodeId === request.episodeId &&
    value.artifactId === request.artifactId &&
    SHA_PATTERN.test(String(value.sha256)) &&
    isNonEmptyString(value.mediaType) &&
    value.startStep === request.startStep &&
    value.endStep === request.endStep &&
    isCount(value.sourceLineCount) &&
    isCount(value.omittedLineCount) &&
    Array.isArray(value.entries) &&
    value.entries.every((entry) => isJsonValue(entry))
  );
}

export async function fetchPlaytestingWindow(
  request: PlaytestingWindowRequest,
  config: ControlApiConfig,
  options: FetchControlApiOptions = {}
): Promise<ControlApiResult<ControlApiPlaytestingWindowResponse>> {
  const path = `${CONTROL_API_PATHS.playtesting}/episodes/${encodeURIComponent(request.episodeId)}/windows/${encodeURIComponent(request.artifactId)}?workspaceId=${encodeURIComponent(request.workspaceId)}&startStep=${request.startStep}&endStep=${request.endStep}`;
  const result = await fetchControlApi<unknown>(
    path,
    config,
    playtestingControlApiOptions(options)
  );
  if (result.kind !== "ok") return result;
  return isWindowResponse(result.data, request)
    ? { kind: "ok", data: result.data }
    : invalidResponse(
        "Playtesting evidence window",
        "autodev-control-playtesting-window-v1"
      );
}

function isPlaytestingModeReadiness(value: unknown): boolean {
  if (
    !isRecord(value) ||
    (value.status !== "ready" &&
      value.status !== "check-required" &&
      value.status !== "unavailable") ||
    !Array.isArray(value.reasons)
  ) {
    return false;
  }
  const reasons = value.reasons;
  if (
    !reasons.every(
      (reason) =>
        isRecord(reason) &&
        isNonEmptyString(reason.code) &&
        isNonEmptyString(reason.label) &&
        isNonEmptyString(reason.message) &&
        (reason.severity === "check-required" ||
          reason.severity === "unavailable")
    )
  ) {
    return false;
  }
  const expectedStatus = reasons.some(
    (reason) => isRecord(reason) && reason.severity === "unavailable"
  )
    ? "unavailable"
    : reasons.length > 0
      ? "check-required"
      : "ready";
  return value.status === expectedStatus;
}

function isVisualModeReadiness(value: unknown, workspaceId: string): boolean {
  if (
    !isPlaytestingModeReadiness(value) ||
    !isRecord(value) ||
    (value.targetStore !== "available" &&
      value.targetStore !== "unavailable") ||
    !Array.isArray(value.targets)
  ) {
    return false;
  }
  const targetIds = new Set<string>();
  try {
    for (const targetReadiness of value.targets) {
      if (
        !isRecord(targetReadiness) ||
        (targetReadiness.eligibility !== "supported" &&
          targetReadiness.eligibility !== "unsupported") ||
        !Array.isArray(targetReadiness.reasons) ||
        !targetReadiness.reasons.every(
          (reason) =>
            isRecord(reason) &&
            isNonEmptyString(reason.code) &&
            isNonEmptyString(reason.label) &&
            isNonEmptyString(reason.message) &&
            (reason.severity === "check-required" ||
              reason.severity === "unavailable")
        )
      ) {
        return false;
      }
      const target = targetReadiness.target;
      assertWorkspaceVisualPlaytestTargetApproval(target);
      if (
        target.workspaceId !== workspaceId ||
        target.revokedAt !== null ||
        targetIds.has(target.targetId)
      ) {
        return false;
      }
      targetIds.add(target.targetId);
    }
  } catch {
    return false;
  }
  return value.targetStore !== "unavailable" || value.targets.length === 0;
}

function isPlaytestingCapabilitiesResponse(
  value: unknown,
  workspaceId: string
): value is ControlApiPlaytestingCapabilitiesResponse {
  return (
    isRecord(value) &&
    value.schema === "autodev-control-playtesting-capabilities-v3" &&
    value.workspaceId === workspaceId &&
    typeof value.capabilityRevision === "string" &&
    CAPABILITY_REVISION_PATTERN.test(value.capabilityRevision) &&
    ["valid", "invalid", "unavailable"].includes(
      String(value.workspaceCatalog)
    ) &&
    typeof value.workspaceEnabled === "boolean" &&
    typeof value.operatorActionsAvailable === "boolean" &&
    isRecord(value.modeReadiness) &&
    isPlaytestingModeReadiness(value.modeReadiness["adapter-accelerated"]) &&
    isVisualModeReadiness(
      value.modeReadiness["autonomous-visual"],
      workspaceId
    ) &&
    isPlaytestingModeReadiness(value.modeReadiness["scripted-regression"]) &&
    typeof value.approved === "boolean" &&
    (value.approvalRevision === null || isCount(value.approvalRevision)) &&
    (value.buildSha === null ||
      (typeof value.buildSha === "string" &&
        SHA_PATTERN.test(value.buildSha))) &&
    (value.gameBuild === null || typeof value.gameBuild === "string") &&
    Array.isArray(value.allowedScenarios) &&
    value.allowedScenarios.every(isNonEmptyString) &&
    Array.isArray(value.approvedPolicies) &&
    value.approvedPolicies.every(isNonEmptyString) &&
    Array.isArray(value.supportedPolicies) &&
    value.supportedPolicies.every(isNonEmptyString) &&
    Array.isArray(value.runnablePolicies) &&
    value.runnablePolicies.every(isNonEmptyString) &&
    Array.isArray(value.unsupportedApprovedPolicies) &&
    value.unsupportedApprovedPolicies.every(isNonEmptyString) &&
    (value.configurationStatus === "validated" ||
      value.configurationStatus === "invalid" ||
      value.configurationStatus === "not-checked") &&
    isCount(value.maxBatchAssignments) &&
    Array.isArray(value.runnableAssignments) &&
    value.runnableAssignments.every(
      (assignment) =>
        isRecord(assignment) &&
        isNonEmptyString(assignment.scenarioId) &&
        isNonEmptyString(assignment.scenarioFamily) &&
        isNonEmptyString(assignment.policyId) &&
        isNonEmptyString(assignment.policyVersion) &&
        isNonEmptyString(assignment.cohort) &&
        isNonEmptyString(assignment.strategy) &&
        Number.isSafeInteger(assignment.maxStepsPerEpisode) &&
        (assignment.maxStepsPerEpisode as number) > 0
    ) &&
    (value.admissibleSeeds === null ||
      (Array.isArray(value.admissibleSeeds) &&
        value.admissibleSeeds.length > 0 &&
        value.admissibleSeeds.every(
          (entry) =>
            isRecord(entry) &&
            isNonEmptyString(entry.seed) &&
            (entry.purpose === "discovery" ||
              entry.purpose === "confirmation" ||
              entry.purpose === "regression")
        ))) &&
    Array.isArray(value.policyProfiles) &&
    value.policyProfiles.every(
      (profile) =>
        isRecord(profile) &&
        isNonEmptyString(profile.policyId) &&
        isNonEmptyString(profile.version) &&
        isNonEmptyString(profile.cohort) &&
        isNonEmptyString(profile.strategy)
    ) &&
    (value.limits === null ||
      (isRecord(value.limits) &&
        isCount(value.limits.workerCount) &&
        isCount(value.limits.episodeCount) &&
        isCount(value.limits.maxStepsPerEpisode) &&
        isCount(value.limits.wallTimeMs))) &&
    (value.issueReporting === "disabled" ||
      value.issueReporting === "review") &&
    typeof value.humanStudyAllowed === "boolean" &&
    (value.revokedAt === null || isNonEmptyString(value.revokedAt)) &&
    value.runPreflight === "required-at-start"
  );
}

export async function fetchPlaytestingRunCapabilities(
  workspaceId: string,
  config: ControlApiConfig,
  options: FetchControlApiOptions = {}
): Promise<ControlApiResult<ControlApiPlaytestingCapabilitiesResponse>> {
  if (!WORKSPACE_ID_PATTERN.test(workspaceId)) {
    return invalidResponse(
      "Playtesting capabilities",
      CANONICAL_WORKSPACE_REQUIREMENT
    );
  }
  const path = `${CONTROL_API_PATHS.playtesting}/capabilities?workspaceId=${encodeURIComponent(workspaceId)}`;
  const result = await fetchControlApi<unknown>(
    path,
    config,
    playtestingControlApiOptions(options)
  );
  if (result.kind !== "ok") return result;
  return isPlaytestingCapabilitiesResponse(result.data, workspaceId)
    ? { kind: "ok", data: result.data }
    : invalidResponse(
        "Playtesting capabilities",
        "autodev-control-playtesting-capabilities-v3"
      );
}

const RUN_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/u;

function isSessionReferenceList(
  value: unknown,
  expectedCount: number,
  assignmentIds?: readonly string[]
): value is readonly PlaytestSessionReference[] {
  if (!Array.isArray(value) || value.length !== expectedCount) return false;
  const expectedAssignments =
    assignmentIds === undefined ? null : new Set(assignmentIds);
  if (
    assignmentIds !== undefined &&
    expectedAssignments?.size !== assignmentIds.length
  ) {
    return false;
  }
  const seenAssignments = new Set<string>();
  const seenEpisodes = new Set<string>();
  for (const entry of value) {
    if (
      !isRecord(entry) ||
      !isNonEmptyString(entry.assignmentId) ||
      !ASSIGNMENT_ID_PATTERN.test(entry.assignmentId) ||
      !isNonEmptyString(entry.episodeId) ||
      !EPISODE_ID_PATTERN.test(entry.episodeId) ||
      seenAssignments.has(entry.assignmentId) ||
      seenEpisodes.has(entry.episodeId) ||
      (expectedAssignments !== null &&
        !expectedAssignments.has(entry.assignmentId))
    ) {
      return false;
    }
    seenAssignments.add(entry.assignmentId);
    seenEpisodes.add(entry.episodeId);
  }
  return (
    expectedAssignments === null ||
    seenAssignments.size === expectedAssignments.size
  );
}

function isRunStartedResponse(
  value: unknown,
  workspaceId: string
): value is ControlApiPlaytestingRunStartedResponse {
  if (
    !isRecord(value) ||
    value.schema !== "autodev-control-playtesting-run-started-v3" ||
    value.workspaceId !== workspaceId ||
    !isNonEmptyString(value.batchId) ||
    !RUN_ID_PATTERN.test(value.batchId) ||
    !isCount(value.assignmentCount) ||
    value.assignmentCount < 1 ||
    !Array.isArray(value.assignmentIds) ||
    value.assignmentIds.length !== value.assignmentCount ||
    new Set(value.assignmentIds).size !== value.assignmentIds.length ||
    !value.assignmentIds.every(
      (id) => typeof id === "string" && ASSIGNMENT_ID_PATTERN.test(id)
    ) ||
    !isRunStartedTimestamp(value.createdAt) ||
    !isControlApiPlaytestingRunState(value.status)
  ) {
    return false;
  }
  return isSessionReferenceList(
    value.sessions,
    value.assignmentCount,
    value.assignmentIds as string[]
  );
}

function isRunStartedTimestamp(value: unknown): value is string {
  return isNonEmptyString(value) && Number.isFinite(Date.parse(value));
}

function isRunRequestLookupResponse(
  value: unknown,
  workspaceId: string,
  requestId: string
): value is ControlApiPlaytestingRunRequestLookupResponse {
  if (
    !isRecord(value) ||
    value.schema !== "autodev-control-playtesting-run-request-v2" ||
    value.workspaceId !== workspaceId ||
    value.requestId !== requestId ||
    !["not-found", "expired", "pending", "accepted"].includes(
      String(value.state)
    ) ||
    !Array.isArray(value.assignmentIds) ||
    value.assignmentIds.some(
      (id) => !isNonEmptyString(id) || !ASSIGNMENT_ID_PATTERN.test(id)
    )
  ) {
    return false;
  }
  const sessions = value.sessions;
  if (value.state === "not-found" || value.state === "expired") {
    return (
      isSessionReferenceList(sessions, 0) &&
      value.batchId === null &&
      value.assignmentCount === null &&
      value.assignmentIds.length === 0 &&
      value.createdAt === null &&
      value.status === null
    );
  }
  if (
    !isNonEmptyString(value.batchId) ||
    !RUN_ID_PATTERN.test(value.batchId) ||
    !isCount(value.assignmentCount) ||
    value.assignmentCount < 1 ||
    !isRunStartedTimestamp(value.createdAt)
  ) {
    return false;
  }
  if (value.state === "pending") {
    return (
      value.assignmentIds.length === 0 &&
      isSessionReferenceList(sessions, 0) &&
      value.status === null
    );
  }
  return (
    value.assignmentIds.length === value.assignmentCount &&
    new Set(value.assignmentIds).size === value.assignmentIds.length &&
    isSessionReferenceList(
      sessions,
      value.assignmentCount,
      value.assignmentIds as string[]
    ) &&
    isControlApiPlaytestingRunState(value.status)
  );
}

function isRunRecord(value: unknown): value is ControlApiPlaytestingRunRecord {
  if (
    !isRecord(value) ||
    !isNonEmptyString(value.batchId) ||
    !isControlApiPlaytestingRunState(value.status) ||
    (value.cancellationReason !== null &&
      !isNonEmptyString(value.cancellationReason)) ||
    (value.result !== null && !isJsonValue(value.result))
  ) {
    return false;
  }
  if (value.error === null) return true;
  return (
    isRecord(value.error) &&
    isNonEmptyString(value.error.code) &&
    isNonEmptyString(value.error.category) &&
    typeof value.error.retryable === "boolean" &&
    isNonEmptyString(value.error.message)
  );
}

function isRunStatusResponse(
  value: unknown,
  workspaceId: string,
  batchId: string
): value is ControlApiPlaytestingRunStatusResponse {
  return (
    isRecord(value) &&
    value.schema === "autodev-control-playtesting-run-status-v1" &&
    value.workspaceId === workspaceId &&
    isRunRecord(value.run) &&
    value.run.batchId === batchId
  );
}

export async function fetchPlaytestingActiveRuns(
  workspaceId: string,
  config: ControlApiConfig,
  options: FetchControlApiOptions = {}
): Promise<ControlApiResult<ControlApiPlaytestingActiveRunsResponse>> {
  if (!WORKSPACE_ID_PATTERN.test(workspaceId)) {
    return invalidResponse(
      "Playtesting active runs",
      "a canonical workspace identifier"
    );
  }
  const params = new URLSearchParams({ workspaceId });
  const result = await fetchControlApi<unknown>(
    `${CONTROL_API_PATHS.playtesting}/runs?${params}`,
    config,
    playtestingControlApiOptions(options)
  );
  if (result.kind !== "ok") return result;
  const data = result.data;
  if (
    !isRecord(data) ||
    data.schema !== "autodev-control-playtesting-runs-v2" ||
    data.workspaceId !== workspaceId ||
    !Array.isArray(data.runs) ||
    // One malformed live entry fails the whole read rather than leaving the
    // operator looking at a partial view presented as current.
    !data.runs.every(
      (run) =>
        isRecord(run) &&
        isNonEmptyString(run.batchId) &&
        RUN_ID_PATTERN.test(run.batchId) &&
        isCount(run.assignmentCount) &&
        run.assignmentCount > 0 &&
        isNonEmptyString(run.createdAt) &&
        isSessionReferenceList(run.sessions, run.assignmentCount) &&
        isRunRecord(run.status) &&
        run.status.batchId === run.batchId
    )
  ) {
    return invalidResponse(
      "Playtesting active runs",
      "autodev-control-playtesting-runs-v2"
    );
  }
  return {
    kind: "ok",
    data: data as unknown as ControlApiPlaytestingActiveRunsResponse
  };
}

function isPlaytestingAnalystRun(
  value: unknown
): value is ControlApiPlaytestingAnalystRun {
  if (!isRecord(value)) return false;
  const requestedEpisodeIds = value.requestedEpisodeIds;
  const packets = value.packets;
  const receipts = value.receipts;
  const budget = value.budget;
  const reviews = value.reviews;
  if (
    !isNonEmptyString(value.analysisId) ||
    !isNonEmptyString(value.workspaceId) ||
    (value.analysisKind !== undefined &&
      value.analysisKind !== "confirmatory" &&
      value.analysisKind !== "discovery") ||
    !["running", "completed", "partial", "failed"].includes(
      String(value.status)
    ) ||
    !isNonEmptyString(value.createdAt) ||
    (value.finishedAt !== null && !isNonEmptyString(value.finishedAt)) ||
    !Array.isArray(requestedEpisodeIds) ||
    !requestedEpisodeIds.every(isNonEmptyString) ||
    !Array.isArray(packets) ||
    !packets.every(
      (packet) =>
        isRecord(packet) &&
        isNonEmptyString(packet.episodeId) &&
        isNonEmptyString(packet.batchId) &&
        isNonEmptyString(packet.packetId)
    ) ||
    !Array.isArray(receipts) ||
    !receipts.every(
      (receipt) =>
        isRecord(receipt) &&
        isNonEmptyString(receipt.episodeId) &&
        (receipt.batchId === null || isNonEmptyString(receipt.batchId)) &&
        isNonEmptyString(receipt.reason) &&
        isNonEmptyString(receipt.detail)
    ) ||
    !Array.isArray(budget) ||
    !budget.every(
      (entry) =>
        isRecord(entry) &&
        isNonEmptyString(entry.batchId) &&
        isCount(entry.reviewCap) &&
        isCount(entry.actualCritiques) &&
        isCount(entry.reserved) &&
        isCount(entry.requested) &&
        isCount(entry.remaining)
    ) ||
    !Array.isArray(reviews) ||
    !reviews.every(
      (review) =>
        isRecord(review) &&
        isNonEmptyString(review.episodeId) &&
        isNonEmptyString(review.reviewId) &&
        ["verified", "corroborated", "hypothesis", "not observed"].includes(
          String(review.status)
        )
    ) ||
    (value.error !== null && typeof value.error !== "string")
  ) {
    return false;
  }
  const accountedEpisodeIds = [
    ...packets.map((packet) => (isRecord(packet) ? packet.episodeId : null)),
    ...receipts.map((receipt) => (isRecord(receipt) ? receipt.episodeId : null))
  ];
  return (
    packets.length + receipts.length === requestedEpisodeIds.length &&
    new Set(accountedEpisodeIds).size === requestedEpisodeIds.length &&
    accountedEpisodeIds.every(
      (episodeId) =>
        typeof episodeId === "string" && requestedEpisodeIds.includes(episodeId)
    )
  );
}

export async function listPlaytestingAnalyses(
  workspaceId: string,
  config: ControlApiConfig,
  options: FetchControlApiOptions = {}
): Promise<ControlApiResult<ControlApiPlaytestingAnalysesResponse>> {
  if (!WORKSPACE_ID_PATTERN.test(workspaceId)) {
    return invalidResponse(
      "Playtesting analyst status",
      CANONICAL_WORKSPACE_REQUIREMENT
    );
  }
  const params = new URLSearchParams({ workspaceId });
  const result = await fetchControlApi(
    `${CONTROL_API_PATHS.playtesting}/analyses?${params}`,
    config,
    playtestingControlApiOptions(options)
  );
  if (result.kind !== "ok") return result;
  const data = result.data;
  if (
    !isRecord(data) ||
    data.schema !== "autodev-control-playtesting-analyses-v1" ||
    data.workspaceId !== workspaceId ||
    !Array.isArray(data.runs) ||
    !Array.isArray(data.syntheses) ||
    !data.runs.every(
      (run) => isPlaytestingAnalystRun(run) && run.workspaceId === workspaceId
    )
  ) {
    return invalidResponse(
      "Playtesting analyst status",
      "autodev-control-playtesting-analyses-v1"
    );
  }
  return {
    kind: "ok",
    data: data as unknown as ControlApiPlaytestingAnalysesResponse
  };
}

export async function requestPlaytestingAnalysis(
  workspaceId: string,
  episodeIds: readonly string[],
  config: ControlApiConfig,
  options: FetchControlApiOptions = {}
): Promise<ControlApiResult<ControlApiPlaytestingAnalysisDispatchResponse>> {
  const selected = [...new Set(episodeIds)];
  if (
    !WORKSPACE_ID_PATTERN.test(workspaceId) ||
    selected.length === 0 ||
    selected.length > PLAYTESTS_MAX_ANALYSIS_SESSIONS
  ) {
    // Refused before the request, against the same bound Runtime enforces.
    return invalidResponse(
      "Playtesting analysis",
      `1 to ${String(PLAYTESTS_MAX_ANALYSIS_SESSIONS)} distinct sessions`
    );
  }
  const params = new URLSearchParams({ workspaceId });
  const result = await postControlApi(
    `${CONTROL_API_PATHS.playtesting}/analyses?${params}`,
    { episodeIds: selected, operation: "dispatch" },
    config,
    playtestingControlApiOptions(options)
  );
  if (result.kind !== "ok") return result;
  const data = result.data;
  if (
    !isRecord(data) ||
    data.schema !== "autodev-control-playtesting-analysis-v1" ||
    data.operation !== "dispatch" ||
    data.workspaceId !== workspaceId ||
    data.requested !== selected.length ||
    !Array.isArray(data.packets) ||
    !data.packets.every(
      (packet) =>
        isRecord(packet) &&
        isNonEmptyString(packet.episodeId) &&
        isNonEmptyString(packet.batchId) &&
        isNonEmptyString(packet.packetId)
    ) ||
    !Array.isArray(data.receipts) ||
    (data.analysis !== null && !isPlaytestingAnalystRun(data.analysis)) ||
    (data.analysis !== null &&
      (data.analysis.workspaceId !== workspaceId ||
        data.analysis.requestedEpisodeIds.length !== selected.length ||
        !data.analysis.requestedEpisodeIds.every((id) =>
          selected.includes(id)
        ))) ||
    (data.packets.length > 0 && data.analysis === null) ||
    // Every requested session is accounted for. A missing one would let the
    // Console show "3 sessions analysed" from a selection of 4.
    [...data.packets, ...data.receipts].length !== selected.length ||
    new Set(
      [...data.packets, ...data.receipts].map((entry) =>
        isRecord(entry) ? entry.episodeId : null
      )
    ).size !== selected.length ||
    ![...data.packets, ...data.receipts].every(
      (entry) => isRecord(entry) && selected.includes(String(entry.episodeId))
    ) ||
    !data.receipts.every(
      (receipt) =>
        isRecord(receipt) &&
        isNonEmptyString(receipt.episodeId) &&
        isNonEmptyString(receipt.reason) &&
        isNonEmptyString(receipt.detail)
    )
  ) {
    return invalidResponse(
      "Playtesting analysis",
      "autodev-control-playtesting-analysis-v1"
    );
  }
  return {
    kind: "ok",
    data: data as unknown as ControlApiPlaytestingAnalysisDispatchResponse
  };
}

export async function startPlaytestingRun(
  request: PlaytestLaunchRequest,
  config: ControlApiConfig,
  options: FetchControlApiOptions = {}
): Promise<ControlApiResult<ControlApiPlaytestingRunStartedResponse>> {
  if (
    !WORKSPACE_ID_PATTERN.test(request.workspaceId) ||
    !REQUEST_ID_PATTERN.test(request.requestId) ||
    !CAPABILITY_REVISION_PATTERN.test(request.capabilityRevision) ||
    (request.mode === "adapter-accelerated" &&
      request.operation.kind === "batch" &&
      (request.operation.assignments.length === 0 ||
        request.operation.assignments.length > PLAYTESTS_MAX_BATCH_ASSIGNMENTS))
  ) {
    return invalidResponse(
      "Playtesting batch",
      "a canonical workspaceId and 1-" +
        String(PLAYTESTS_MAX_BATCH_ASSIGNMENTS) +
        " assignments"
    );
  }
  const result = await postControlApi<unknown>(
    `${CONTROL_API_PATHS.playtesting}/runs`,
    request,
    config,
    playtestingControlApiOptions(options)
  );
  if (result.kind !== "ok") return result;
  return isRunStartedResponse(result.data, request.workspaceId)
    ? { kind: "ok", data: result.data }
    : invalidResponse(
        "Playtesting run",
        "autodev-control-playtesting-run-started-v3"
      );
}

export async function fetchPlaytestingRunRequest(
  workspaceId: string,
  requestId: string,
  config: ControlApiConfig,
  options: FetchControlApiOptions = {}
): Promise<ControlApiResult<ControlApiPlaytestingRunRequestLookupResponse>> {
  if (
    !WORKSPACE_ID_PATTERN.test(workspaceId) ||
    !REQUEST_ID_PATTERN.test(requestId)
  ) {
    return invalidResponse(
      "Playtesting request recovery",
      "a canonical workspaceId and valid requestId"
    );
  }
  const query = new URLSearchParams({ workspaceId, requestId });
  const path = `${CONTROL_API_PATHS.playtesting}/runs/by-request?${query}`;
  const result = await fetchControlApi<unknown>(
    path,
    config,
    playtestingControlApiOptions(options)
  );
  if (result.kind !== "ok") return result;
  return isRunRequestLookupResponse(result.data, workspaceId, requestId)
    ? { kind: "ok", data: result.data }
    : invalidResponse(
        "Playtesting request recovery",
        "autodev-control-playtesting-run-request-v2"
      );
}

export async function fetchPlaytestingRunStatus(
  workspaceId: string,
  batchId: string,
  config: ControlApiConfig,
  options: FetchControlApiOptions = {}
): Promise<ControlApiResult<ControlApiPlaytestingRunStatusResponse>> {
  if (
    !WORKSPACE_ID_PATTERN.test(workspaceId) ||
    !RUN_ID_PATTERN.test(batchId)
  ) {
    return invalidResponse(
      "Playtesting run status",
      "a workspace and batch identifier"
    );
  }
  const params = new URLSearchParams({ workspaceId, waitMs: "0" });
  const result = await fetchControlApi<unknown>(
    `${CONTROL_API_PATHS.playtesting}/runs/${encodeURIComponent(batchId)}?${params}`,
    config,
    playtestingControlApiOptions(options)
  );
  if (result.kind !== "ok") return result;
  return isRunStatusResponse(result.data, workspaceId, batchId)
    ? { kind: "ok", data: result.data }
    : invalidResponse(
        "Playtesting run status",
        "autodev-control-playtesting-run-status-v1"
      );
}

export async function cancelPlaytestingRun(
  workspaceId: string,
  batchId: string,
  config: ControlApiConfig,
  options: FetchControlApiOptions = {}
): Promise<ControlApiResult<ControlApiPlaytestingRunCancellationResponse>> {
  if (
    !WORKSPACE_ID_PATTERN.test(workspaceId) ||
    !RUN_ID_PATTERN.test(batchId)
  ) {
    return invalidResponse(
      "Playtesting run cancellation",
      "a workspace and batch identifier"
    );
  }
  const params = new URLSearchParams({ workspaceId });
  const result = await postControlApi<unknown>(
    `${CONTROL_API_PATHS.playtesting}/runs/${encodeURIComponent(batchId)}/cancel?${params}`,
    { expectedStatus: "running" },
    config,
    playtestingControlApiOptions(options)
  );
  if (result.kind !== "ok") return result;
  const data = result.data;
  if (
    !isRecord(data) ||
    data.schema !== "autodev-control-playtesting-run-cancellation-v1" ||
    data.workspaceId !== workspaceId ||
    data.batchId !== batchId ||
    typeof data.cancellationRequested !== "boolean"
  ) {
    return invalidResponse(
      "Playtesting cancellation",
      "autodev-control-playtesting-run-cancellation-v1"
    );
  }
  const validData: ControlApiPlaytestingRunCancellationResponse = {
    schema: "autodev-control-playtesting-run-cancellation-v1",
    workspaceId,
    batchId,
    cancellationRequested: data.cancellationRequested
  };
  return { kind: "ok", data: validData };
}

export async function recordPlaytestingComparisonDecision(
  request: ControlApiPlaytestingComparisonDecisionRequest,
  config: ControlApiConfig,
  options: FetchControlApiOptions = {}
): Promise<ControlApiResult<ControlApiPlaytestingComparisonDecisionResponse>> {
  if (
    !WORKSPACE_ID_PATTERN.test(request.workspaceId) ||
    !ENTITY_ID_PATTERN.test(request.comparisonId) ||
    !Number.isSafeInteger(request.expectedVersion) ||
    request.expectedVersion < 1 ||
    !["promote", "hold"].includes(request.disposition) ||
    !isNonEmptyString(request.reason) ||
    request.reason.length > 4000
  ) {
    return invalidResponse(
      "Playtesting comparison decision",
      "a bounded workspace, comparison revision, disposition, and reason"
    );
  }
  const path = `${CONTROL_API_PATHS.playtesting}/comparisons/${encodeURIComponent(request.comparisonId)}/decision`;
  const result = await postControlApi<unknown>(
    path,
    request,
    config,
    playtestingControlApiOptions(options)
  );
  if (result.kind !== "ok") return result;
  const response = result.data;
  if (
    !isRecord(response) ||
    response.schema !== "autodev-control-playtesting-comparison-decision-v1" ||
    response.workspaceId !== request.workspaceId ||
    !isRecord(response.comparison) ||
    response.comparison.comparisonId !== request.comparisonId ||
    response.comparison.version !== request.expectedVersion + 1 ||
    response.comparison.ownerDisposition !== request.disposition ||
    response.comparison.ownerDecisionReason !== request.reason ||
    !isNonEmptyString(response.comparison.ownerDecisionBy)
  ) {
    return invalidResponse(
      "Playtesting comparison decision",
      "autodev-control-playtesting-comparison-decision-v1"
    );
  }
  return {
    kind: "ok",
    data: response as unknown as ControlApiPlaytestingComparisonDecisionResponse
  };
}

const HUMAN_SUPPRESSION_STATES = new Set([
  "suppressed",
  "partially-suppressed",
  "unsuppressed"
]);

function validNullableCount(value: unknown): boolean {
  return value === null || isCount(value);
}

function hasNoRestrictedHumanFields(value: unknown): boolean {
  if (Array.isArray(value)) return value.every(hasNoRestrictedHumanFields);
  if (!isRecord(value)) return true;
  const forbidden = new Set([
    "participantId",
    "pseudonymousParticipantId",
    "responseId",
    "responses",
    "freeText",
    "text"
  ]);
  return Object.entries(value).every(
    ([key, entry]) => !forbidden.has(key) && hasNoRestrictedHumanFields(entry)
  );
}

const HUMAN_PREFERENCE_DECISIONS = new Set([
  "supports-b-preference",
  "supports-a-preference",
  "no-material-preference",
  "inconclusive"
]);

function validHumanPreferenceSummary(value: unknown): boolean {
  if (value === null) return true;
  const preference = isRecord(value) ? value : null;
  if (
    !preference ||
    Object.keys(preference).length !== 7 ||
    !isNonEmptyString(preference.analysisPlanRef) ||
    (preference.suppressionState !== "suppressed" &&
      preference.suppressionState !== "unsuppressed") ||
    !validNullableCount(preference.incompleteExposurePairs) ||
    !HUMAN_PREFERENCE_DECISIONS.has(String(preference.decision)) ||
    !Array.isArray(preference.reasons) ||
    preference.reasons.some((reason) => !isNonEmptyString(reason))
  ) {
    return false;
  }
  let countsValid = preference.counts === null;
  if (isRecord(preference.counts)) {
    const counts = preference.counts;
    countsValid =
      Object.keys(counts).length === 6 &&
      isCount(counts.eligibleParticipants) &&
      isCount(counts.preferA) &&
      isCount(counts.preferB) &&
      isCount(counts.ties) &&
      isCount(counts.unableToJudge) &&
      isCount(counts.missing) &&
      counts.eligibleParticipants ===
        counts.preferA +
          counts.preferB +
          counts.ties +
          counts.unableToJudge +
          counts.missing;
  }
  let intervalValid = preference.interval === null;
  if (isRecord(preference.interval)) {
    const interval = preference.interval;
    intervalValid =
      typeof interval.lower === "number" &&
      Number.isFinite(interval.lower) &&
      interval.lower >= 0 &&
      typeof interval.upper === "number" &&
      Number.isFinite(interval.upper) &&
      interval.upper <= 1 &&
      interval.lower <= interval.upper &&
      isNonEmptyString(interval.method) &&
      isNonEmptyString(interval.libraryVersion) &&
      typeof interval.confidenceLevel === "number" &&
      Number.isFinite(interval.confidenceLevel) &&
      interval.confidenceLevel > 0 &&
      interval.confidenceLevel < 1 &&
      (interval.resamples === null || isCount(interval.resamples)) &&
      (interval.seed === null || isNonEmptyString(interval.seed));
  }
  return (
    countsValid &&
    intervalValid &&
    (preference.counts !== null ||
      (preference.interval === null &&
        preference.decision === "inconclusive")) &&
    (preference.interval !== null || preference.decision === "inconclusive")
  );
}

function isHumanValidationResponse(
  value: unknown,
  workspaceId: string,
  studyId: string,
  buildSha: string
): value is ControlApiPlaytestingHumanValidationResponse {
  if (
    !isRecord(value) ||
    value.schema !== "autodev-control-playtesting-human-validation-v1" ||
    value.workspaceId !== workspaceId ||
    value.studyId !== studyId ||
    value.buildSha !== buildSha ||
    !hasNoRestrictedHumanFields(value) ||
    !("preference" in value)
  ) {
    return false;
  }
  if (!validHumanPreferenceSummary(value.preference)) return false;
  if (value.summary === null) return true;
  const summary = isRecord(value.summary) ? value.summary : null;
  if (
    !summary ||
    !isCount(summary.revision) ||
    (summary.benchmarkId !== null && !isNonEmptyString(summary.benchmarkId)) ||
    !isNonEmptyString(summary.instrument) ||
    !isNonEmptyString(summary.measurementVersion) ||
    typeof summary.suppressionState !== "string" ||
    !HUMAN_SUPPRESSION_STATES.has(summary.suppressionState) ||
    !validNullableCount(summary.retainedParticipants) ||
    !Array.isArray(summary.items) ||
    !Array.isArray(summary.constructs) ||
    !Array.isArray(summary.pairedDifferences)
  ) {
    return false;
  }
  const validItem = (item: unknown): boolean => {
    const row = isRecord(item) ? item : null;
    if (
      !row ||
      !isNonEmptyString(row.itemId) ||
      typeof row.suppressionState !== "string" ||
      !HUMAN_SUPPRESSION_STATES.has(row.suppressionState) ||
      (row.mean !== null &&
        (typeof row.mean !== "number" || !Number.isFinite(row.mean))) ||
      !validNullableCount(row.respondentCount) ||
      !validNullableCount(row.missingCount) ||
      !isNonEmptyString(row.unit)
    ) {
      return false;
    }
    if (row.categoryCounts === null) return true;
    const counts = isRecord(row.categoryCounts) ? row.categoryCounts : null;
    return (
      counts !== null &&
      Object.values(counts).every((count) => validNullableCount(count))
    );
  };
  const validConstruct = (construct: unknown): boolean => {
    const row = isRecord(construct) ? construct : null;
    return (
      !!row &&
      isNonEmptyString(row.constructId) &&
      typeof row.suppressionState === "string" &&
      HUMAN_SUPPRESSION_STATES.has(row.suppressionState) &&
      (row.mean === null ||
        (typeof row.mean === "number" && Number.isFinite(row.mean))) &&
      validNullableCount(row.respondentCount) &&
      validNullableCount(row.missingCount) &&
      isNonEmptyString(row.unit)
    );
  };
  const validPair = (pair: unknown): boolean => {
    const row = isRecord(pair) ? pair : null;
    return (
      !!row &&
      isNonEmptyString(row.itemId) &&
      (row.suppressionState === "suppressed" ||
        row.suppressionState === "unsuppressed") &&
      validNullableCount(row.pairedParticipants) &&
      (row.meanDifference === null ||
        (typeof row.meanDifference === "number" &&
          Number.isFinite(row.meanDifference)))
    );
  };
  return (
    summary.items.every(validItem) &&
    summary.constructs.every(validConstruct) &&
    summary.pairedDifferences.every(validPair)
  );
}

/** Reads only suppression-aware aggregates; no response or participant IDs enter the Console. */
export async function fetchPlaytestingHumanValidation(
  workspaceId: string,
  studyId: string,
  buildSha: string,
  config: ControlApiConfig,
  options: FetchControlApiOptions = {}
): Promise<ControlApiResult<ControlApiPlaytestingHumanValidationResponse>> {
  if (
    !WORKSPACE_ID_PATTERN.test(workspaceId) ||
    !ENTITY_ID_PATTERN.test(studyId) ||
    !SHA_PATTERN.test(buildSha)
  ) {
    return invalidResponse(
      "Playtesting human validation",
      "a workspace, study, and build identity"
    );
  }
  const params = new URLSearchParams({ workspaceId, buildSha });
  const path = `${CONTROL_API_PATHS.playtesting}/human-studies/${encodeURIComponent(studyId)}/validation?${params}`;
  const result = await fetchControlApi<unknown>(
    path,
    config,
    playtestingControlApiOptions(options)
  );
  if (result.kind !== "ok") return result;
  return isHumanValidationResponse(result.data, workspaceId, studyId, buildSha)
    ? { kind: "ok", data: result.data }
    : invalidResponse(
        "Playtesting human validation",
        "autodev-control-playtesting-human-validation-v1"
      );
}
