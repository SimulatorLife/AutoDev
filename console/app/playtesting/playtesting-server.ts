/**
Server-only authenticated Playtesting reads for the Console resource.

Every Control API payload is validated against its owning Zod schema from
`@simulatorlife/autodev-core` rather than re-spelled in local guards.
*/
import {
  CONTROL_API_PLAYTESTING_ANALYSES_SCHEMA_ID,
  CONTROL_API_PLAYTESTING_ANALYSIS_SCHEMA_ID,
  CONTROL_API_PLAYTESTING_CAPABILITIES_SCHEMA_ID,
  CONTROL_API_PLAYTESTING_COMPARISON_DECISION_SCHEMA_ID,
  CONTROL_API_PLAYTESTING_DETAIL_SCHEMA_ID,
  CONTROL_API_PLAYTESTING_HUMAN_VALIDATION_SCHEMA_ID,
  CONTROL_API_PLAYTESTING_PAGE_SCHEMA_ID,
  CONTROL_API_PLAYTESTING_READINESS_SCHEMA,
  CONTROL_API_PLAYTESTING_REVIEWS_SCHEMA_ID,
  CONTROL_API_PLAYTESTING_RUN_CANCELLATION_SCHEMA_ID,
  CONTROL_API_PLAYTESTING_RUN_REQUEST_SCHEMA_ID,
  CONTROL_API_PLAYTESTING_RUN_STARTED_SCHEMA_ID,
  CONTROL_API_PLAYTESTING_RUN_STATUS_SCHEMA_ID,
  CONTROL_API_PLAYTESTING_RUNS_SCHEMA_ID,
  CONTROL_API_PLAYTESTING_WINDOW_SCHEMA_ID,
  type ControlApiPlaytestingActiveRunsResponse,
  controlApiPlaytestingActiveRunsResponseSchema,
  type ControlApiPlaytestingAnalysesResponse,
  controlApiPlaytestingAnalysesResponseSchema,
  type ControlApiPlaytestingAnalysisDispatchResponse,
  controlApiPlaytestingAnalysisDispatchResponseSchema,
  type ControlApiPlaytestingCapabilitiesResponse,
  controlApiPlaytestingCapabilitiesResponseSchema,
  type ControlApiPlaytestingComparisonDecisionRequest,
  controlApiPlaytestingComparisonDecisionRequestSchema,
  type ControlApiPlaytestingComparisonDecisionResponse,
  controlApiPlaytestingComparisonDecisionResponseSchema,
  type ControlApiPlaytestingEntityMap,
  type ControlApiPlaytestingEpisodeDetailResponse,
  controlApiPlaytestingEpisodeDetailResponseSchema,
  type ControlApiPlaytestingHumanValidationResponse,
  controlApiPlaytestingHumanValidationResponseSchema,
  type ControlApiPlaytestingPageResponse,
  controlApiPlaytestingPageResponseSchema,
  type ControlApiPlaytestingReadinessResponse,
  controlApiPlaytestingReadinessResponseSchema,
  type ControlApiPlaytestingResource,
  type ControlApiPlaytestingReviewsResponse,
  controlApiPlaytestingReviewsResponseSchema,
  type ControlApiPlaytestingRunCancellationResponse,
  controlApiPlaytestingRunCancellationResponseSchema,
  type ControlApiPlaytestingRunRequestLookupResponse,
  controlApiPlaytestingRunRequestLookupResponseSchema,
  type ControlApiPlaytestingRunStartedResponse,
  controlApiPlaytestingRunStartedResponseSchema,
  type ControlApiPlaytestingRunStatusResponse,
  controlApiPlaytestingRunStatusResponseSchema,
  type ControlApiPlaytestingWindowResponse,
  controlApiPlaytestingWindowResponseSchema,
  PLAYTEST_CAPABILITY_REVISION_PATTERN,
  PLAYTEST_ENTITY_ID_PATTERN,
  PLAYTEST_REQUEST_ID_PATTERN,
  PLAYTEST_RUN_ID_PATTERN,
  PLAYTEST_SHA_PATTERN,
  PLAYTEST_WORKSPACE_ID_PATTERN,
  type PlaytestFinding,
  type PlaytestLaunchRequest,
  PLAYTESTS_MAX_ANALYSIS_SESSIONS,
  PLAYTESTS_MAX_BATCH_ASSIGNMENTS
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
Give every playtesting Control API call the playtesting budget. The
playtesting store is ClickHouse-backed and answers one read in seconds,
while the playtesting page fans several reads out in parallel, so the
generic Control API deadline would expire against a service that is
answering normally.
*/
function playtestingControlApiOptions(
  options: FetchControlApiOptions
): FetchControlApiOptions {
  return {
    ...options,
    timeoutMs: options.timeoutMs ?? PLAYTESTING_CONTROL_API_TIMEOUT_MS
  };
}

const CANONICAL_WORKSPACE_REQUIREMENT = "a canonical workspaceId";

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

function parsePlaytestingResponse<T>(
  schema: {
    readonly safeParse: (
      value: unknown
    ) =>
      | { readonly success: true; readonly data: T }
      | { readonly success: false };
  },
  value: unknown,
  subject: string,
  schemaId: string,
  isAllowed?: (data: T) => boolean
): ControlApiResult<T> {
  const parsed = schema.safeParse(value);
  if (!parsed.success || (isAllowed !== undefined && !isAllowed(parsed.data))) {
    return invalidResponse(subject, schemaId);
  }
  return { kind: "ok", data: parsed.data };
}

export async function fetchPlaytestingReadiness(
  workspaceId: string,
  config: ControlApiConfig,
  options: FetchControlApiOptions & { readonly retry?: boolean } = {}
): Promise<ControlApiResult<ControlApiPlaytestingReadinessResponse>> {
  if (!PLAYTEST_WORKSPACE_ID_PATTERN.test(workspaceId)) {
    return invalidResponse(
      "Playtesting readiness",
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
  return parsePlaytestingResponse(
    controlApiPlaytestingReadinessResponseSchema,
    result.data,
    "Playtesting readiness",
    CONTROL_API_PLAYTESTING_READINESS_SCHEMA,
    (data) => data.workspaceId === workspaceId
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
  /**
  One finding by id, for the findings resource.

  It is a request field rather than a filter because it is a selection, not
  a narrowing: a finding is opened by id from a link that names it, and the
  list's own filters are the reader's, not the selection's.
  */
  readonly findingId?: string | null | undefined;
}

export interface PlaytestingWindowRequest {
  readonly workspaceId: string;
  readonly episodeId: string;
  readonly artifactId: string;
  readonly startStep: number;
  readonly endStep: number;
}

function pagePath(
  request: PlaytestingPageRequest,
  resource: ControlApiPlaytestingResource
): string {
  const parameters = new URLSearchParams({
    workspaceId: request.workspaceId,
    limit: String(request.limit)
  });
  if (request.cursor) parameters.set("cursor", request.cursor);
  const filterKeys = PLAYTESTING_FILTERS_BY_RESOURCE[resource];
  for (const key of filterKeys) {
    const value = request.filters?.[key];
    if (value) parameters.set(key, value);
  }
  // A selected finding is read by id, so it is asked for on the findings
  // resource only; another resource has no such selection to honour.
  if (resource === "findings" && request.findingId) {
    parameters.set("findingId", request.findingId);
  }
  return `${CONTROL_API_PATHS.playtesting}/${resource}?${parameters.toString()}`;
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
  if (!PLAYTEST_WORKSPACE_ID_PATTERN.test(request.workspaceId)) {
    return invalidResponse("Playtesting page", CANONICAL_WORKSPACE_REQUIREMENT);
  }
  const result = await fetchControlApi<unknown>(
    pagePath(request, resource),
    config,
    playtestingControlApiOptions(options)
  );
  if (result.kind !== "ok") return result;
  return parsePlaytestingResponse(
    controlApiPlaytestingPageResponseSchema(resource),
    result.data,
    resource,
    CONTROL_API_PLAYTESTING_PAGE_SCHEMA_ID,
    (data) => data.workspaceId === request.workspaceId
  );
}

/**
One finding, read by id.

A finding is opened by id from the links that name it -- a review that
raised it, a shared address -- so the read has to resolve that one finding
rather than the first page of the list, which may not hold it. A finding
that does not exist reads as "no such finding" rather than as an empty
page: the list and the detail are different questions.
*/
export async function fetchPlaytestingFinding(
  workspaceId: string,
  findingId: string,
  config: ControlApiConfig,
  options: FetchControlApiOptions = {}
): Promise<ControlApiResult<PlaytestFinding | null>> {
  const result = await fetchPlaytestingPage(
    "findings",
    { workspaceId, limit: 1, findingId },
    config,
    options
  );
  if (result.kind !== "ok") return result;
  return { kind: "ok", data: result.data.page.rows[0] ?? null };
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
  return parsePlaytestingResponse(
    controlApiPlaytestingEpisodeDetailResponseSchema,
    result.data,
    "Playtesting episode",
    CONTROL_API_PLAYTESTING_DETAIL_SCHEMA_ID,
    (data) =>
      data.workspaceId === workspaceId && data.record.episodeId === episodeId
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
  return parsePlaytestingResponse(
    controlApiPlaytestingWindowResponseSchema,
    result.data,
    "Playtesting evidence window",
    CONTROL_API_PLAYTESTING_WINDOW_SCHEMA_ID,
    (data) =>
      data.workspaceId === request.workspaceId &&
      data.episodeId === request.episodeId &&
      data.artifactId === request.artifactId &&
      data.startStep === request.startStep &&
      data.endStep === request.endStep
  );
}

export async function fetchPlaytestingRunCapabilities(
  workspaceId: string,
  config: ControlApiConfig,
  options: FetchControlApiOptions = {}
): Promise<ControlApiResult<ControlApiPlaytestingCapabilitiesResponse>> {
  if (!PLAYTEST_WORKSPACE_ID_PATTERN.test(workspaceId)) {
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
  return parsePlaytestingResponse(
    controlApiPlaytestingCapabilitiesResponseSchema,
    result.data,
    "Playtesting capabilities",
    CONTROL_API_PLAYTESTING_CAPABILITIES_SCHEMA_ID,
    (data) => data.workspaceId === workspaceId
  );
}

export async function fetchPlaytestingActiveRuns(
  workspaceId: string,
  config: ControlApiConfig,
  options: FetchControlApiOptions = {}
): Promise<ControlApiResult<ControlApiPlaytestingActiveRunsResponse>> {
  if (!PLAYTEST_WORKSPACE_ID_PATTERN.test(workspaceId)) {
    return invalidResponse(
      "Playtesting active runs",
      "a canonical workspace identifier"
    );
  }
  const parameters = new URLSearchParams({ workspaceId });
  const result = await fetchControlApi<unknown>(
    `${CONTROL_API_PATHS.playtesting}/runs?${parameters}`,
    config,
    playtestingControlApiOptions(options)
  );
  if (result.kind !== "ok") return result;
  return parsePlaytestingResponse(
    controlApiPlaytestingActiveRunsResponseSchema,
    result.data,
    "Playtesting active runs",
    CONTROL_API_PLAYTESTING_RUNS_SCHEMA_ID,
    (data) => data.workspaceId === workspaceId
  );
}

export async function listPlaytestingAnalyses(
  workspaceId: string,
  config: ControlApiConfig,
  options: FetchControlApiOptions = {}
): Promise<ControlApiResult<ControlApiPlaytestingAnalysesResponse>> {
  if (!PLAYTEST_WORKSPACE_ID_PATTERN.test(workspaceId)) {
    return invalidResponse(
      "Playtesting analyst status",
      CANONICAL_WORKSPACE_REQUIREMENT
    );
  }
  const parameters = new URLSearchParams({ workspaceId });
  const result = await fetchControlApi<unknown>(
    `${CONTROL_API_PATHS.playtesting}/analyses?${parameters}`,
    config,
    playtestingControlApiOptions(options)
  );
  if (result.kind !== "ok") return result;
  return parsePlaytestingResponse(
    controlApiPlaytestingAnalysesResponseSchema,
    result.data,
    "Playtesting analyst status",
    CONTROL_API_PLAYTESTING_ANALYSES_SCHEMA_ID,
    (data) => data.workspaceId === workspaceId
  );
}

/**
The workspace's persisted analyst reviews.

The reviews are the analyst's durable record: they are stored, so they
outlive the Runtime process that produced them.
*/
export async function fetchPlaytestingReviews(
  workspaceId: string,
  config: ControlApiConfig,
  options: FetchControlApiOptions = {},
  limit?: number
): Promise<ControlApiResult<ControlApiPlaytestingReviewsResponse>> {
  if (!PLAYTEST_WORKSPACE_ID_PATTERN.test(workspaceId)) {
    return invalidResponse(
      "Playtesting reviews",
      CANONICAL_WORKSPACE_REQUIREMENT
    );
  }
  const parameters = new URLSearchParams({ workspaceId });
  if (limit !== undefined) parameters.set("limit", String(limit));
  const result = await fetchControlApi<unknown>(
    `${CONTROL_API_PATHS.playtesting}/reviews?${parameters}`,
    config,
    playtestingControlApiOptions(options)
  );
  if (result.kind !== "ok") return result;
  return parsePlaytestingResponse(
    controlApiPlaytestingReviewsResponseSchema,
    result.data,
    "Playtesting reviews",
    CONTROL_API_PLAYTESTING_REVIEWS_SCHEMA_ID,
    (data) => data.workspaceId === workspaceId
  );
}

export async function requestPlaytestingAnalysis(
  workspaceId: string,
  episodeIds: readonly string[],
  config: ControlApiConfig,
  options: FetchControlApiOptions & {
    readonly requireFindings?: boolean;
  } = {}
): Promise<ControlApiResult<ControlApiPlaytestingAnalysisDispatchResponse>> {
  const { requireFindings = false, ...fetchOptions } = options;
  const selected = [...new Set(episodeIds)];
  if (
    !PLAYTEST_WORKSPACE_ID_PATTERN.test(workspaceId) ||
    selected.length === 0 ||
    selected.length > PLAYTESTS_MAX_ANALYSIS_SESSIONS
  ) {
    return invalidResponse(
      "Playtesting analysis",
      `1 to ${String(PLAYTESTS_MAX_ANALYSIS_SESSIONS)} distinct sessions`
    );
  }
  const parameters = new URLSearchParams({ workspaceId });
  const result = await postControlApi<unknown>(
    `${CONTROL_API_PATHS.playtesting}/analyses?${parameters}`,
    {
      episodeIds: selected,
      operation: "dispatch",
      requireFindings
    },
    config,
    playtestingControlApiOptions(fetchOptions)
  );
  if (result.kind !== "ok") return result;
  return parsePlaytestingResponse(
    controlApiPlaytestingAnalysisDispatchResponseSchema,
    result.data,
    "Playtesting analysis",
    CONTROL_API_PLAYTESTING_ANALYSIS_SCHEMA_ID,
    (data) => {
      const selectedSet = new Set(selected);
      const accounted = [...data.packets, ...data.receipts];
      return (
        data.workspaceId === workspaceId &&
        data.requested === selected.length &&
        accounted.every((entry) => selectedSet.has(entry.episodeId)) &&
        (data.analysis === null ||
          data.analysis.requestedEpisodeIds.every((id) => selectedSet.has(id)))
      );
    }
  );
}

export async function startPlaytestingRun(
  request: PlaytestLaunchRequest,
  config: ControlApiConfig,
  options: FetchControlApiOptions = {}
): Promise<ControlApiResult<ControlApiPlaytestingRunStartedResponse>> {
  if (
    !PLAYTEST_WORKSPACE_ID_PATTERN.test(request.workspaceId) ||
    !PLAYTEST_REQUEST_ID_PATTERN.test(request.requestId) ||
    !PLAYTEST_CAPABILITY_REVISION_PATTERN.test(request.capabilityRevision) ||
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
  return parsePlaytestingResponse(
    controlApiPlaytestingRunStartedResponseSchema,
    result.data,
    "Playtesting run",
    CONTROL_API_PLAYTESTING_RUN_STARTED_SCHEMA_ID,
    (data) => data.workspaceId === request.workspaceId
  );
}

export async function fetchPlaytestingRunRequest(
  workspaceId: string,
  requestId: string,
  config: ControlApiConfig,
  options: FetchControlApiOptions = {}
): Promise<ControlApiResult<ControlApiPlaytestingRunRequestLookupResponse>> {
  if (
    !PLAYTEST_WORKSPACE_ID_PATTERN.test(workspaceId) ||
    !PLAYTEST_REQUEST_ID_PATTERN.test(requestId)
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
  return parsePlaytestingResponse(
    controlApiPlaytestingRunRequestLookupResponseSchema,
    result.data,
    "Playtesting request recovery",
    CONTROL_API_PLAYTESTING_RUN_REQUEST_SCHEMA_ID,
    (data) => data.workspaceId === workspaceId && data.requestId === requestId
  );
}

export async function fetchPlaytestingRunStatus(
  workspaceId: string,
  batchId: string,
  config: ControlApiConfig,
  options: FetchControlApiOptions = {}
): Promise<ControlApiResult<ControlApiPlaytestingRunStatusResponse>> {
  if (
    !PLAYTEST_WORKSPACE_ID_PATTERN.test(workspaceId) ||
    !PLAYTEST_RUN_ID_PATTERN.test(batchId)
  ) {
    return invalidResponse(
      "Playtesting run status",
      "a workspace and batch identifier"
    );
  }
  const parameters = new URLSearchParams({ workspaceId, waitMs: "0" });
  const result = await fetchControlApi<unknown>(
    `${CONTROL_API_PATHS.playtesting}/runs/${encodeURIComponent(batchId)}?${parameters}`,
    config,
    playtestingControlApiOptions(options)
  );
  if (result.kind !== "ok") return result;
  return parsePlaytestingResponse(
    controlApiPlaytestingRunStatusResponseSchema,
    result.data,
    "Playtesting run status",
    CONTROL_API_PLAYTESTING_RUN_STATUS_SCHEMA_ID,
    (data) => data.workspaceId === workspaceId && data.run.batchId === batchId
  );
}

export async function cancelPlaytestingRun(
  workspaceId: string,
  batchId: string,
  config: ControlApiConfig,
  options: FetchControlApiOptions = {}
): Promise<ControlApiResult<ControlApiPlaytestingRunCancellationResponse>> {
  if (
    !PLAYTEST_WORKSPACE_ID_PATTERN.test(workspaceId) ||
    !PLAYTEST_RUN_ID_PATTERN.test(batchId)
  ) {
    return invalidResponse(
      "Playtesting run cancellation",
      "a workspace and batch identifier"
    );
  }
  const parameters = new URLSearchParams({ workspaceId });
  const result = await postControlApi<unknown>(
    `${CONTROL_API_PATHS.playtesting}/runs/${encodeURIComponent(batchId)}/cancel?${parameters}`,
    { expectedStatus: "running" },
    config,
    playtestingControlApiOptions(options)
  );
  if (result.kind !== "ok") return result;
  return parsePlaytestingResponse(
    controlApiPlaytestingRunCancellationResponseSchema,
    result.data,
    "Playtesting cancellation",
    CONTROL_API_PLAYTESTING_RUN_CANCELLATION_SCHEMA_ID,
    (data) => data.workspaceId === workspaceId && data.batchId === batchId
  );
}

export async function recordPlaytestingComparisonDecision(
  request: ControlApiPlaytestingComparisonDecisionRequest,
  config: ControlApiConfig,
  options: FetchControlApiOptions = {}
): Promise<ControlApiResult<ControlApiPlaytestingComparisonDecisionResponse>> {
  if (
    !controlApiPlaytestingComparisonDecisionRequestSchema.safeParse(request)
      .success
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
  return parsePlaytestingResponse(
    controlApiPlaytestingComparisonDecisionResponseSchema,
    result.data,
    "Playtesting comparison decision",
    CONTROL_API_PLAYTESTING_COMPARISON_DECISION_SCHEMA_ID,
    (data) =>
      data.workspaceId === request.workspaceId &&
      data.comparison.comparisonId === request.comparisonId &&
      data.comparison.version === request.expectedVersion + 1 &&
      data.comparison.ownerDisposition === request.disposition &&
      data.comparison.ownerDecisionReason === request.reason
  );
}

/**
Reads only suppression-aware aggregates; no response or participant IDs enter the Console.
*/
export async function fetchPlaytestingHumanValidation(
  workspaceId: string,
  studyId: string,
  buildSha: string,
  config: ControlApiConfig,
  options: FetchControlApiOptions = {}
): Promise<ControlApiResult<ControlApiPlaytestingHumanValidationResponse>> {
  if (
    !PLAYTEST_WORKSPACE_ID_PATTERN.test(workspaceId) ||
    !PLAYTEST_ENTITY_ID_PATTERN.test(studyId) ||
    !PLAYTEST_SHA_PATTERN.test(buildSha)
  ) {
    return invalidResponse(
      "Playtesting human validation",
      "a workspace, study, and build identity"
    );
  }
  const parameters = new URLSearchParams({ workspaceId, buildSha });
  const path = `${CONTROL_API_PATHS.playtesting}/human-studies/${encodeURIComponent(studyId)}/validation?${parameters}`;
  const result = await fetchControlApi<unknown>(
    path,
    config,
    playtestingControlApiOptions(options)
  );
  if (result.kind !== "ok") return result;
  return parsePlaytestingResponse(
    controlApiPlaytestingHumanValidationResponseSchema,
    result.data,
    "Playtesting human validation",
    CONTROL_API_PLAYTESTING_HUMAN_VALIDATION_SCHEMA_ID,
    (data) =>
      data.workspaceId === workspaceId &&
      data.studyId === studyId &&
      data.buildSha === buildSha
  );
}
