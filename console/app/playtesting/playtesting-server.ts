/** Server-only authenticated Playtesting reads for the Console resource. */
import {
  type ControlApiPlaytestingCapabilitiesResponse,
  type ControlApiPlaytestingEntityMap,
  type ControlApiPlaytestingEpisodeDetailResponse,
  type ControlApiPlaytestingHumanValidationResponse,
  type ControlApiPlaytestingPageResponse,
  type ControlApiPlaytestingResource,
  type ControlApiPlaytestingRunCancellationResponse,
  type ControlApiPlaytestingRunRequest,
  type ControlApiPlaytestingRunStartedResponse,
  type ControlApiPlaytestingRunStatusResponse,
  type ControlApiPlaytestingWindowResponse,
  type HumanPlaytestStudy,
  type PlaytestBatch,
  type PlaytestBenchmark,
  type PlaytestComparison,
  type PlaytestEpisode,
  type PlaytestExperiment,
  type PlaytestFinding,
  type PlaytestJsonValue,
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
  type ControlApiResult,
  fetchControlApi,
  fetchControlApiBinary,
  type FetchControlApiOptions,
  postControlApi
} from "../../src/lib/server/control-api.ts";

const RESOURCE_SCHEMAS: Readonly<
  Record<ControlApiPlaytestingResource, string>
> = {
  batches: "autodev-playtest-batch-v1",
  episodes: "autodev-playtest-episode-v1",
  findings: "",
  comparisons: "autodev-playtest-comparison-v1",
  benchmarks: "",
  experiments: "autodev-playtest-experiment-v1",
  "human-studies": "autodev-playtest-human-study-v1"
};
const SHA_PATTERN = /^(?:[a-f\d]{40}|[a-f\d]{64})$/iu;
const WORKSPACE_ID_PATTERN = /^[^/\s]+\/[^/\s]+$/u;
const ENTITY_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/u;
export type PlaytestingPage<Row> =
  ControlApiPlaytestingPageResponse<Row>["page"];

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

function hasSchema(
  value: unknown,
  resource: ControlApiPlaytestingResource
): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
  const expectedSchema = RESOURCE_SCHEMAS[resource];
  return expectedSchema === "" || value.schema === expectedSchema;
}

function validPlaytestRecord<R extends ControlApiPlaytestingResource>(
  value: unknown,
  resource: R,
  workspaceId: string
): value is ControlApiPlaytestingEntityMap[R] {
  if (!hasSchema(value, resource)) return false;
  switch (resource) {
    case "batches": {
      const batch = value as unknown as PlaytestBatch;
      return (
        batch.workspaceId === workspaceId &&
        isNonEmptyString(batch.batchId) &&
        isCount(batch.revision) &&
        Array.isArray(batch.policyIds) &&
        isCount(batch.counts?.assigned)
      );
    }
    case "episodes": {
      const episode = value as unknown as PlaytestEpisode;
      return (
        episode.identity?.workspaceId === workspaceId &&
        isNonEmptyString(episode.episodeId) &&
        isNonEmptyString(episode.batchId) &&
        isCount(episode.revision) &&
        isCount(episode.stepCount) &&
        Array.isArray(episode.metrics) &&
        Array.isArray(episode.frames)
      );
    }
    case "findings": {
      const finding = value as unknown as PlaytestFinding;
      return (
        isNonEmptyString(finding.findingId) &&
        isNonEmptyString(finding.title) &&
        isCount(finding.version) &&
        (finding.affectedEpisodes === null || isCount(finding.affectedEpisodes)) &&
        (finding.totalEligibleEpisodes === null || isCount(finding.totalEligibleEpisodes)) &&
        (finding.affectedOpportunities === null || isCount(finding.affectedOpportunities)) &&
        (finding.totalEligibleOpportunities === null || isCount(finding.totalEligibleOpportunities)) &&
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
    value.schema === "autodev-playtest-session-review-v1" &&
    value.episodeId === episodeId &&
    isNonEmptyString(value.reviewId) &&
    isCount(value.version) &&
    value.authorRole === "playtest-analyst" &&
    Array.isArray(value.findings) &&
    Array.isArray(value.evidenceRefs)
  );
}

function isEpisodeDetailResponse(
  value: unknown,
  workspaceId: string,
  episodeId: string
): value is ControlApiPlaytestingEpisodeDetailResponse {
  return (
    isRecord(value) &&
    value.schema === "autodev-control-playtesting-detail-v1" &&
    value.workspaceId === workspaceId &&
    value.resource === "episode" &&
    value.readOnly === true &&
    validPlaytestRecord(value.record, "episodes", workspaceId) &&
    value.record.episodeId === episodeId &&
    (value.latestReview === null || isReview(value.latestReview, episodeId))
  );
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
    return invalidResponse("Playtesting page", "a canonical workspaceId");
  }
  const result = await fetchControlApi<unknown>(
    pagePath(request, resource),
    config,
    options
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
  const result = await fetchControlApi<unknown>(path, config, options);
  if (result.kind !== "ok") return result;
  return isEpisodeDetailResponse(result.data, workspaceId, episodeId)
    ? { kind: "ok", data: result.data }
    : invalidResponse(
        "Playtesting episode",
        "autodev-control-playtesting-detail-v1"
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
  return fetchControlApiBinary(path, config, options);
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
  const result = await fetchControlApi<unknown>(path, config, options);
  if (result.kind !== "ok") return result;
  return isWindowResponse(result.data, request)
    ? { kind: "ok", data: result.data }
    : invalidResponse(
        "Playtesting evidence window",
        "autodev-control-playtesting-window-v1"
      );
}

function isPlaytestingCapabilitiesResponse(
  value: unknown,
  workspaceId: string
): value is ControlApiPlaytestingCapabilitiesResponse {
  return (
    isRecord(value) &&
    value.schema === "autodev-control-playtesting-capabilities-v1" &&
    value.workspaceId === workspaceId &&
    ["valid", "invalid", "unavailable"].includes(
      String(value.workspaceCatalog)
    ) &&
    typeof value.workspaceEnabled === "boolean" &&
    typeof value.operatorActionsAvailable === "boolean" &&
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
      "a canonical workspaceId"
    );
  }
  const path = `${CONTROL_API_PATHS.playtesting}/capabilities?workspaceId=${encodeURIComponent(workspaceId)}`;
  const result = await fetchControlApi<unknown>(path, config, options);
  if (result.kind !== "ok") return result;
  return isPlaytestingCapabilitiesResponse(result.data, workspaceId)
    ? { kind: "ok", data: result.data }
    : invalidResponse(
        "Playtesting capabilities",
        "autodev-control-playtesting-capabilities-v1"
      );
}

const RUN_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/u;

function isRunStartedResponse(
  value: unknown,
  workspaceId: string
): value is ControlApiPlaytestingRunStartedResponse {
  return (
    isRecord(value) &&
    value.schema === "autodev-control-playtesting-run-started-v1" &&
    value.workspaceId === workspaceId &&
    isNonEmptyString(value.batchId) &&
    RUN_ID_PATTERN.test(value.batchId) &&
    value.status === "running"
  );
}

function isRunStatusResponse(
  value: unknown,
  workspaceId: string,
  batchId: string
): value is ControlApiPlaytestingRunStatusResponse {
  if (
    !isRecord(value) ||
    value.schema !== "autodev-control-playtesting-run-status-v1" ||
    value.workspaceId !== workspaceId ||
    !isRecord(value.run) ||
    value.run.batchId !== batchId ||
    !["running", "persisting", "completed", "failed", "cancelled"].includes(
      String(value.run.status)
    ) ||
    (value.run.cancellationReason !== null &&
      !isNonEmptyString(value.run.cancellationReason)) ||
    (value.run.result !== null && !isJsonValue(value.run.result))
  ) {
    return false;
  }
  if (value.run.error === null) return true;
  return (
    isRecord(value.run.error) &&
    isNonEmptyString(value.run.error.code) &&
    isNonEmptyString(value.run.error.category) &&
    typeof value.run.error.retryable === "boolean" &&
    isNonEmptyString(value.run.error.message)
  );
}

export async function startPlaytestingRun(
  request: ControlApiPlaytestingRunRequest,
  config: ControlApiConfig,
  options: FetchControlApiOptions = {}
): Promise<ControlApiResult<ControlApiPlaytestingRunStartedResponse>> {
  if (!WORKSPACE_ID_PATTERN.test(request.workspaceId)) {
    return invalidResponse("Playtesting run", "a canonical workspaceId");
  }
  const result = await postControlApi<unknown>(
    `${CONTROL_API_PATHS.playtesting}/runs`,
    request,
    config,
    options
  );
  if (result.kind !== "ok") return result;
  return isRunStartedResponse(result.data, request.workspaceId)
    ? { kind: "ok", data: result.data }
    : invalidResponse(
        "Playtesting run",
        "autodev-control-playtesting-run-started-v1"
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
    options
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
    options
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
    !hasNoRestrictedHumanFields(value)
  ) {
    return false;
  }
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
  const result = await fetchControlApi<unknown>(path, config, options);
  if (result.kind !== "ok") return result;
  return isHumanValidationResponse(result.data, workspaceId, studyId, buildSha)
    ? { kind: "ok", data: result.data }
    : invalidResponse(
        "Playtesting human validation",
        "autodev-control-playtesting-human-validation-v1"
      );
}
