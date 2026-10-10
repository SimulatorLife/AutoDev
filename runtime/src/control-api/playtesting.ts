import type { IncomingMessage, ServerResponse } from "node:http";

import {
  CONTROL_API_PLAYTESTING_RESOURCES,
  type ControlApiPlaytestingEntityMap,
  type ControlApiPlaytestingEpisodeDetailResponse,
  type ControlApiPlaytestingPageResponse,
  type ControlApiPlaytestingResource,
  type ControlApiPlaytestingWindowResponse,
  type PlaytestFinding,
  type PlaytestJsonValue,
  PLAYTESTS_BATCH_STATES,
  PLAYTESTS_DECISION_STATUSES,
  PLAYTESTS_EPISODE_STATES,
  PLAYTESTS_EXPERIMENT_STATES,
  PLAYTESTS_FINDING_STATUSES,
  PLAYTESTS_GAME_OUTCOMES,
  PLAYTESTS_HUMAN_INSTRUMENTS,
  PLAYTESTS_SEVERITIES,
  PLAYTESTS_VERIFICATION_STAGES
} from "@simulatorlife/autodev-core";
import { ConfigRepository } from "@simulatorlife/autodev-data";
import {
  PlaytestInvalidCursorError,
  PlaytestRepository,
  PlaytestSourceUnavailableError as DataUnavailableError
} from "@simulatorlife/autodev-data/playtesting";

import {
  PlaytestArtifactConfigurationError,
  PlaytestArtifactExpiredError,
  PlaytestArtifactFormatError,
  PlaytestArtifactIntegrityError,
  PlaytestArtifactMissingError,
  PlaytestArtifactNotAuthorizedError,
  PlaytestArtifactOversizedError,
  PlaytestArtifactStore,
  type PlaytestArtifactWindowReadResult,
  PLAYTESTS_ARTIFACT_MAX_WINDOW_BYTES
} from "../playtesting/artifact-store.ts";
import { errorBody, sendJson } from "../router/proxy.ts";

const CONTROL_PATH = "/control/playtesting/";
const WORKSPACE_ID_PATTERN = /^[^/\s]+\/[^/\s]+$/u;
const ENTITY_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/u;
const SHA_PATTERN = /^(?:[a-f\d]{40}|[a-f\d]{64})$/iu;
const DATE_PATTERN = /^\d{4}-\d\d-\d\dT.*(?:Z|[+-]\d\d:\d\d)$/u;
const PAGE_LIMIT_PATTERN = /^[1-9]\d{0,2}$/u;
const STEP_PATTERN = /^(0|[1-9]\d{0,5})$/u;
const FILTER_VALUE_MAX_CHARS = 256;
const CURSOR_MAX_CHARS = 2048;
const DEFAULT_PAGE_LIMIT = 50;
const MAX_PAGE_LIMIT = 500;
const COMMON_FILTERS = ["workspaceId", "limit", "cursor"] as const;
const RESOURCE_FILTERS: Readonly<
  Record<ControlApiPlaytestingResource, readonly string[]>
> = {
  batches: ["buildSha", "status"],
  episodes: [
    "batchId",
    "buildSha",
    "scenario",
    "policy",
    "cohort",
    "status",
    "gameOutcome",
    "reviewStatus",
    "startedAtFrom",
    "startedAtTo"
  ],
  findings: ["severity", "status", "verificationStage", "evidenceStatus"],
  comparisons: ["benchmarkId", "experimentId", "decision"],
  benchmarks: ["referenceBuildSha", "measurementVersion"],
  experiments: ["benchmarkId", "state"],
  "human-studies": ["benchmarkId", "instrument", "approved"]
};
const REVIEW_STATUSES = ["reviewed", "unreviewed"] as const;
const FINDING_EVIDENCE_STATUSES = [
  "verified",
  "corroborated",
  "hypothesis",
  "not observed"
] as const;

type FilterName =
  (typeof RESOURCE_FILTERS)[ControlApiPlaytestingResource][number];

export type PlaytestingReadRepository = Pick<
  PlaytestRepository,
  | "listBatches"
  | "listEpisodes"
  | "listFindings"
  | "listComparisons"
  | "listBenchmarks"
  | "listExperiments"
  | "listHumanStudies"
  | "getEpisode"
  | "getLatestReviewForEpisode"
>;

export interface PlaytestingControlApiOptions {
  readonly repositoryRoot?: string;
  readonly repository?: PlaytestingReadRepository;
  readonly readWorkspaceCatalog?: () => ReturnType<
    ConfigRepository["readWorkspaceCatalog"]
  >;
  readonly artifactStoreForWorkspace?: (
    workspaceId: string
  ) => PlaytestArtifactStore;
}

export interface PlaytestingControlActor {
  readonly actor: string;
  readonly role: "viewer" | "operator";
}

interface ParsedRoute {
  readonly resource: ControlApiPlaytestingResource;
  readonly id: string | null;
  readonly windowId: string | null;
  readonly mediaId: string | null;
}

interface WindowRequest {
  readonly workspaceId: string;
  readonly startStep: number;
  readonly endStep: number;
}

interface PageRequest {
  readonly workspaceId: string;
  readonly limit: number;
  readonly cursor?: string;
  readonly filters: Readonly<Partial<Record<FilterName, string>>>;
}

function sendPlaytestingError(
  response: ServerResponse,
  status: number,
  code: string,
  message: string
): void {
  sendJson(
    response,
    status,
    errorBody(message, "autodev_control_playtesting_error", { code }),
    { "cache-control": "no-store" }
  );
}

function decodeEntityId(value: string): string | null {
  let id: string;
  try {
    id = decodeURIComponent(value);
  } catch {
    return null;
  }
  return ENTITY_ID_PATTERN.test(id) ? id : null;
}

function routeFor(pathname: string): ParsedRoute | null {
  if (!pathname.startsWith(CONTROL_PATH)) return null;
  const parts = pathname.slice(CONTROL_PATH.length).split("/");
  if (parts.length === 1 && parts[0]) {
    const resource = parts[0];
    if (
      !(CONTROL_API_PLAYTESTING_RESOURCES as readonly string[]).includes(
        resource
      )
    ) {
      return null;
    }
    return {
      resource: resource as ControlApiPlaytestingResource,
      id: null,
      windowId: null,
      mediaId: null
    };
  }
  if (parts.length === 2 && parts[0] === "episodes" && parts[1]) {
    const id = decodeEntityId(parts[1]);
    return id === null
      ? null
      : { resource: "episodes", id, windowId: null, mediaId: null };
  }
  if (
    parts.length === 4 &&
    parts[0] === "episodes" &&
    parts[1] &&
    (parts[2] === "windows" || parts[2] === "media") &&
    parts[3]
  ) {
    const id = decodeEntityId(parts[1]);
    const assetId = decodeEntityId(parts[3]);
    if (id === null || assetId === null) return null;
    return parts[2] === "windows"
      ? { resource: "episodes", id, windowId: assetId, mediaId: null }
      : { resource: "episodes", id, windowId: null, mediaId: assetId };
  }
  return null;
}

function hasControlCharacters(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code <= 31 || code === 127) return true;
  }
  return false;
}

function oneValue(
  params: URLSearchParams,
  key: string,
  maximum = FILTER_VALUE_MAX_CHARS
): string | undefined {
  const values = params.getAll(key);
  if (values.length > 1)
    throw new TypeError(`Duplicate '${key}' query parameter.`);
  const value = values[0]?.trim();
  if (
    value !== undefined &&
    (value.length === 0 ||
      value.length > maximum ||
      hasControlCharacters(value))
  ) {
    throw new TypeError(`Invalid '${key}' query parameter.`);
  }
  return value;
}

function allowedFilterValues(
  resource: ControlApiPlaytestingResource,
  name: string
): readonly string[] | undefined {
  if (name === "status") {
    if (resource === "batches") return PLAYTESTS_BATCH_STATES;
    if (resource === "episodes") return PLAYTESTS_EPISODE_STATES;
    if (resource === "findings") return PLAYTESTS_FINDING_STATUSES;
  }
  const domains: Readonly<Record<string, readonly string[]>> = {
    gameOutcome: PLAYTESTS_GAME_OUTCOMES,
    reviewStatus: REVIEW_STATUSES,
    severity: PLAYTESTS_SEVERITIES,
    verificationStage: PLAYTESTS_VERIFICATION_STAGES,
    evidenceStatus: FINDING_EVIDENCE_STATUSES,
    decision: PLAYTESTS_DECISION_STATUSES,
    state: PLAYTESTS_EXPERIMENT_STATES,
    instrument: PLAYTESTS_HUMAN_INSTRUMENTS
  };
  return domains[name];
}

function validateFilters(
  resource: ControlApiPlaytestingResource,
  filters: Readonly<Partial<Record<FilterName, string>>>
): void {
  for (const [name, value] of Object.entries(filters)) {
    if (value === undefined) continue;
    const domain = allowedFilterValues(resource, name);
    if (domain !== undefined && !domain.includes(value)) {
      throw new TypeError(`Invalid '${name}' filter.`);
    }
    if (
      (name === "buildSha" || name === "referenceBuildSha") &&
      !SHA_PATTERN.test(value)
    ) {
      throw new TypeError(`Invalid '${name}' filter.`);
    }
    if (
      (name === "startedAtFrom" || name === "startedAtTo") &&
      (!DATE_PATTERN.test(value) || !Number.isFinite(Date.parse(value)))
    ) {
      throw new TypeError(`Invalid '${name}' filter.`);
    }
    if (name === "approved" && value !== "true" && value !== "false") {
      throw new TypeError("Invalid 'approved' filter.");
    }
  }
  const from = filters.startedAtFrom;
  const to = filters.startedAtTo;
  if (
    from !== undefined &&
    to !== undefined &&
    Date.parse(from) > Date.parse(to)
  ) {
    throw new TypeError("'startedAtFrom' must not be after 'startedAtTo'.");
  }
}

function pageRequest(
  params: URLSearchParams,
  resource: ControlApiPlaytestingResource
): PageRequest {
  const permitted = new Set<string>([
    ...COMMON_FILTERS,
    ...RESOURCE_FILTERS[resource]
  ]);
  for (const key of params.keys()) {
    if (!permitted.has(key))
      throw new TypeError(`Unknown '${key}' query parameter.`);
  }

  const workspaceId = oneValue(params, "workspaceId");
  if (!workspaceId || !WORKSPACE_ID_PATTERN.test(workspaceId)) {
    throw new TypeError("A valid workspaceId query parameter is required.");
  }
  const limitText = oneValue(params, "limit");
  const limit =
    limitText === undefined ? DEFAULT_PAGE_LIMIT : Number(limitText);
  if (
    limitText !== undefined &&
    (!PAGE_LIMIT_PATTERN.test(limitText) || limit > MAX_PAGE_LIMIT)
  ) {
    throw new TypeError("'limit' must be an integer between 1 and 500.");
  }
  const cursor = oneValue(params, "cursor", CURSOR_MAX_CHARS);
  const filters: Partial<Record<FilterName, string>> = {};
  for (const name of RESOURCE_FILTERS[resource]) {
    const value = oneValue(params, name);
    if (value !== undefined) filters[name as FilterName] = value;
  }
  validateFilters(resource, filters);
  return {
    workspaceId,
    limit,
    ...(cursor === undefined ? {} : { cursor }),
    filters
  };
}

function episodeDetailWorkspace(params: URLSearchParams): string {
  for (const key of params.keys()) {
    if (key !== "workspaceId")
      throw new TypeError(`Unknown '${key}' query parameter.`);
  }
  const workspaceId = oneValue(params, "workspaceId");
  if (!workspaceId || !WORKSPACE_ID_PATTERN.test(workspaceId)) {
    throw new TypeError("A valid workspaceId query parameter is required.");
  }
  return workspaceId;
}

function requestParams(
  request: IncomingMessage,
  pathname: string
): { readonly pathname: string; readonly params: URLSearchParams } {
  const url = new URL(request.url ?? pathname, "http://127.0.0.1");
  return { pathname: url.pathname, params: url.searchParams };
}

function workspaceExists(
  workspaceId: string,
  catalog: ReturnType<ConfigRepository["readWorkspaceCatalog"]>
): boolean {
  return (
    catalog.status === "valid" &&
    catalog.workspaces.some((workspace) => workspace.id === workspaceId)
  );
}

function windowRequest(params: URLSearchParams): WindowRequest {
  for (const key of params.keys()) {
    if (!["workspaceId", "startStep", "endStep"].includes(key)) {
      throw new TypeError(`Unknown '${key}' query parameter.`);
    }
  }
  const workspaceId = oneValue(params, "workspaceId");
  if (!workspaceId || !WORKSPACE_ID_PATTERN.test(workspaceId)) {
    throw new TypeError("A valid workspaceId query parameter is required.");
  }
  const startText = oneValue(params, "startStep");
  const endText = oneValue(params, "endStep");
  if (
    startText === undefined ||
    endText === undefined ||
    !STEP_PATTERN.test(startText) ||
    !STEP_PATTERN.test(endText)
  ) {
    throw new TypeError("A bounded startStep/endStep range is required.");
  }
  const startStep = Number(startText);
  const endStep = Number(endText);
  if (
    !Number.isSafeInteger(startStep) ||
    !Number.isSafeInteger(endStep) ||
    endStep < startStep ||
    endStep - startStep > 4095
  ) {
    throw new TypeError(
      "Step range must be ordered and no wider than 4096 steps."
    );
  }
  return { workspaceId, startStep, endStep };
}

function pageEnvelope<K extends ControlApiPlaytestingResource>(
  workspaceId: string,
  resource: K,
  page: {
    readonly rows: readonly ControlApiPlaytestingEntityMap[K][];
    readonly total: number;
    readonly nextCursor: string | null;
  }
): ControlApiPlaytestingPageResponse<ControlApiPlaytestingEntityMap[K]> {
  return {
    schema: "autodev-control-playtesting-page-v1",
    workspaceId,
    resource,
    readOnly: true,
    page
  };
}

function pageOptions(query: PageRequest) {
  return {
    limit: query.limit,
    ...(query.cursor === undefined ? {} : { cursor: query.cursor })
  };
}

function readBatchPage(
  repository: PlaytestingReadRepository,
  query: PageRequest
) {
  const f = query.filters;
  return repository.listBatches(
    {
      workspaceId: query.workspaceId,
      ...(f.buildSha === undefined ? {} : { buildSha: f.buildSha }),
      ...(f.status === undefined
        ? {}
        : { status: f.status as (typeof PLAYTESTS_BATCH_STATES)[number] })
    },
    pageOptions(query)
  );
}

function readEpisodePage(
  repository: PlaytestingReadRepository,
  query: PageRequest
) {
  const f = query.filters;
  return repository.listEpisodes(
    {
      workspaceId: query.workspaceId,
      ...(f.batchId === undefined ? {} : { batchId: f.batchId }),
      ...(f.buildSha === undefined ? {} : { buildSha: f.buildSha }),
      ...(f.scenario === undefined ? {} : { scenario: f.scenario }),
      ...(f.policy === undefined ? {} : { policy: f.policy }),
      ...(f.cohort === undefined ? {} : { cohort: f.cohort }),
      ...(f.status === undefined
        ? {}
        : { status: f.status as (typeof PLAYTESTS_EPISODE_STATES)[number] }),
      ...(f.gameOutcome === undefined
        ? {}
        : {
            gameOutcome:
              f.gameOutcome as (typeof PLAYTESTS_GAME_OUTCOMES)[number]
          }),
      ...(f.reviewStatus === undefined
        ? {}
        : { reviewStatus: f.reviewStatus as "reviewed" | "unreviewed" }),
      ...(f.startedAtFrom === undefined
        ? {}
        : { startedAtFrom: f.startedAtFrom }),
      ...(f.startedAtTo === undefined ? {} : { startedAtTo: f.startedAtTo })
    },
    pageOptions(query)
  );
}

function readFindingPage(
  repository: PlaytestingReadRepository,
  query: PageRequest
) {
  const f = query.filters;
  return repository.listFindings(
    {
      workspaceId: query.workspaceId,
      ...(f.severity === undefined
        ? {}
        : { severity: f.severity as PlaytestFinding["severity"] }),
      ...(f.status === undefined
        ? {}
        : { status: f.status as PlaytestFinding["status"] }),
      ...(f.verificationStage === undefined
        ? {}
        : {
            verificationStage:
              f.verificationStage as PlaytestFinding["verificationStage"]
          }),
      ...(f.evidenceStatus === undefined
        ? {}
        : {
            evidenceStatus:
              f.evidenceStatus as PlaytestFinding["evidenceStatus"]
          })
    },
    pageOptions(query)
  );
}

function readComparisonPage(
  repository: PlaytestingReadRepository,
  query: PageRequest
) {
  const f = query.filters;
  return repository.listComparisons(
    {
      workspaceId: query.workspaceId,
      ...(f.benchmarkId === undefined ? {} : { benchmarkId: f.benchmarkId }),
      ...(f.experimentId === undefined ? {} : { experimentId: f.experimentId }),
      ...(f.decision === undefined
        ? {}
        : {
            decision: f.decision as (typeof PLAYTESTS_DECISION_STATUSES)[number]
          })
    },
    pageOptions(query)
  );
}

function readBenchmarkPage(
  repository: PlaytestingReadRepository,
  query: PageRequest
) {
  const f = query.filters;
  return repository.listBenchmarks(
    {
      workspaceId: query.workspaceId,
      ...(f.referenceBuildSha === undefined
        ? {}
        : { referenceBuildSha: f.referenceBuildSha }),
      ...(f.measurementVersion === undefined
        ? {}
        : { measurementVersion: f.measurementVersion })
    },
    pageOptions(query)
  );
}

function readExperimentPage(
  repository: PlaytestingReadRepository,
  query: PageRequest
) {
  const f = query.filters;
  return repository.listExperiments(
    {
      workspaceId: query.workspaceId,
      ...(f.benchmarkId === undefined ? {} : { benchmarkId: f.benchmarkId }),
      ...(f.state === undefined
        ? {}
        : { state: f.state as (typeof PLAYTESTS_EXPERIMENT_STATES)[number] })
    },
    pageOptions(query)
  );
}

function readHumanStudyPage(
  repository: PlaytestingReadRepository,
  query: PageRequest
) {
  const f = query.filters;
  return repository.listHumanStudies(
    {
      workspaceId: query.workspaceId,
      ...(f.benchmarkId === undefined ? {} : { benchmarkId: f.benchmarkId }),
      ...(f.instrument === undefined
        ? {}
        : {
            instrument:
              f.instrument as (typeof PLAYTESTS_HUMAN_INSTRUMENTS)[number]
          }),
      ...(f.approved === undefined ? {} : { approved: f.approved === "true" })
    },
    pageOptions(query)
  );
}

async function readPage(
  repository: PlaytestingReadRepository,
  resource: ControlApiPlaytestingResource,
  query: PageRequest
): Promise<ControlApiPlaytestingPageResponse<unknown>> {
  switch (resource) {
    case "batches": {
      return pageEnvelope(
        query.workspaceId,
        resource,
        await readBatchPage(repository, query)
      );
    }
    case "episodes": {
      return pageEnvelope(
        query.workspaceId,
        resource,
        await readEpisodePage(repository, query)
      );
    }
    case "findings": {
      return pageEnvelope(
        query.workspaceId,
        resource,
        await readFindingPage(repository, query)
      );
    }
    case "comparisons": {
      return pageEnvelope(
        query.workspaceId,
        resource,
        await readComparisonPage(repository, query)
      );
    }
    case "benchmarks": {
      return pageEnvelope(
        query.workspaceId,
        resource,
        await readBenchmarkPage(repository, query)
      );
    }
    case "experiments": {
      return pageEnvelope(
        query.workspaceId,
        resource,
        await readExperimentPage(repository, query)
      );
    }
    case "human-studies": {
      return pageEnvelope(
        query.workspaceId,
        resource,
        await readHumanStudyPage(repository, query)
      );
    }
    default: {
      const exhaustive: never = resource;
      throw new TypeError("Unsupported Playtesting resource: " + exhaustive);
    }
  }
}

function respondQueryFailure(response: ServerResponse, error: unknown): true {
  sendPlaytestingError(
    response,
    400,
    "autodev_control_playtesting_invalid_query",
    error instanceof Error ? error.message : "Playtesting query is invalid."
  );
  return true;
}

function parseQuery(
  route: ParsedRoute,
  params: URLSearchParams,
  response: ServerResponse
): PageRequest | WindowRequest | null {
  try {
    if (route.windowId !== null) return windowRequest(params);
    if (route.mediaId !== null) {
      return {
        workspaceId: episodeDetailWorkspace(params),
        limit: 1,
        filters: {}
      };
    }
    if (route.id === null) return pageRequest(params, route.resource);
    return {
      workspaceId: episodeDetailWorkspace(params),
      limit: 1,
      filters: {}
    };
  } catch (error) {
    respondQueryFailure(response, error);
    return null;
  }
}

async function readEpisodeDetail(
  repository: PlaytestingReadRepository,
  workspaceId: string,
  episodeId: string
): Promise<ControlApiPlaytestingEpisodeDetailResponse | null> {
  const record = await repository.getEpisode(workspaceId, episodeId);
  if (record === null) return null;
  const latestReview = await repository.getLatestReviewForEpisode(
    workspaceId,
    episodeId
  );
  return {
    schema: "autodev-control-playtesting-detail-v1",
    workspaceId,
    resource: "episode",
    readOnly: true,
    record,
    latestReview
  };
}

function entryStep(value: unknown): number | null {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return null;
  const record = value as Record<string, unknown>;
  if (Number.isSafeInteger(record.step) && (record.step as number) >= 0) {
    return record.step as number;
  }
  const event = record.event;
  if (
    typeof event === "object" &&
    event !== null &&
    !Array.isArray(event) &&
    Number.isSafeInteger((event as Record<string, unknown>).step) &&
    ((event as Record<string, unknown>).step as number) >= 0
  ) {
    return (event as Record<string, unknown>).step as number;
  }
  return null;
}

function parseWindowEntries(
  result: PlaytestArtifactWindowReadResult,
  startStep: number,
  endStep: number
): {
  readonly entries: readonly PlaytestJsonValue[];
  readonly omitted: number;
} {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(result.bytes);
  } catch {
    throw new PlaytestArtifactFormatError(
      "Stored evidence is not valid UTF-8."
    );
  }
  const lines = text.split("\n").filter((line) => line.length > 0);
  const entries: PlaytestJsonValue[] = [];
  for (const line of lines) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      throw new PlaytestArtifactFormatError(
        "Stored evidence contains an invalid JSON line."
      );
    }
    const step = entryStep(parsed);
    if (step !== null && step >= startStep && step <= endStep) {
      entries.push(parsed as PlaytestJsonValue);
    }
  }
  return { entries, omitted: lines.length - entries.length };
}

async function readEpisodeWindow(
  repository: PlaytestingReadRepository,
  route: ParsedRoute,
  query: WindowRequest,
  artifactStoreForWorkspace: (workspaceId: string) => PlaytestArtifactStore
): Promise<ControlApiPlaytestingWindowResponse | null> {
  const episodeId = route.id;
  const artifactId = route.windowId;
  if (episodeId === null || artifactId === null) return null;
  const episode = await repository.getEpisode(query.workspaceId, episodeId);
  if (episode === null || episode.trace?.id !== artifactId) return null;
  const store = artifactStoreForWorkspace(query.workspaceId);
  if (store.boundWorkspaceId() !== query.workspaceId) return null;
  const reference = store.referenceForId(artifactId);
  if (reference === null) return null;
  const window = store.readWindow(reference);
  const parsed = parseWindowEntries(window, query.startStep, query.endStep);
  const response: ControlApiPlaytestingWindowResponse = {
    schema: "autodev-control-playtesting-window-v1",
    workspaceId: query.workspaceId,
    episodeId,
    artifactId,
    sha256: window.reference.sha256,
    mediaType: window.reference.mediaType,
    startStep: query.startStep,
    endStep: query.endStep,
    sourceLineCount: window.lineCount,
    omittedLineCount: parsed.omitted,
    entries: parsed.entries
  };
  const responseBytes = Buffer.byteLength(JSON.stringify(response), "utf8");
  if (responseBytes > PLAYTESTS_ARTIFACT_MAX_WINDOW_BYTES) {
    throw new PlaytestArtifactOversizedError("window", responseBytes);
  }
  return response;
}

const FRAME_MEDIA_TYPES = ["image/png", "image/jpeg", "image/webp"] as const;
const MAX_CONSOLE_FRAME_BYTES = 8 * 1024 * 1024;

function matchesImageSignature(mediaType: string, bytes: Uint8Array): boolean {
  if (mediaType === "image/png") {
    return Buffer.from(bytes.subarray(0, 8)).equals(
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    );
  }
  if (mediaType === "image/jpeg") {
    return (
      bytes.length >= 3 &&
      bytes[0] === 0xff &&
      bytes[1] === 0xd8 &&
      bytes[2] === 0xff
    );
  }
  return (
    mediaType === "image/webp" &&
    bytes.length >= 12 &&
    Buffer.from(bytes.subarray(0, 4)).toString("ascii") === "RIFF" &&
    Buffer.from(bytes.subarray(8, 12)).toString("ascii") === "WEBP"
  );
}

async function readEpisodeFrame(
  repository: PlaytestingReadRepository,
  route: ParsedRoute,
  workspaceId: string,
  artifactStoreForWorkspace: (workspaceId: string) => PlaytestArtifactStore
): Promise<{ readonly mediaType: string; readonly bytes: Uint8Array } | null> {
  const episodeId = route.id;
  const mediaId = route.mediaId;
  if (episodeId === null || mediaId === null) return null;
  const episode = await repository.getEpisode(workspaceId, episodeId);
  if (
    episode === null ||
    !episode.frames.some((frame) => frame.id === mediaId)
  ) {
    return null;
  }
  const store = artifactStoreForWorkspace(workspaceId);
  if (store.boundWorkspaceId() !== workspaceId) return null;
  const reference = store.referenceForId(mediaId);
  if (reference === null) return null;
  if (!(FRAME_MEDIA_TYPES as readonly string[]).includes(reference.mediaType)) {
    throw new PlaytestArtifactFormatError(
      "Frame media type is not supported for browser display."
    );
  }
  const artifact = store.readArtifact(reference);
  if (artifact.bytes.byteLength > MAX_CONSOLE_FRAME_BYTES) {
    throw new PlaytestArtifactOversizedError("blob", artifact.bytes.byteLength);
  }
  if (!matchesImageSignature(reference.mediaType, artifact.bytes)) {
    throw new PlaytestArtifactIntegrityError(
      mediaId,
      reference.sha256,
      "invalid-image-signature"
    );
  }
  return { mediaType: reference.mediaType, bytes: artifact.bytes };
}

function sendFrame(
  response: ServerResponse,
  frame: { readonly mediaType: string; readonly bytes: Uint8Array }
): void {
  response.writeHead(200, {
    "content-type": frame.mediaType,
    "content-length": frame.bytes.byteLength,
    "cache-control": "private, no-store",
    "x-content-type-options": "nosniff",
    "content-security-policy": "default-src 'none'; sandbox"
  });
  response.end(Buffer.from(frame.bytes));
}

function readDataResponse(
  repository: PlaytestingReadRepository,
  route: ParsedRoute,
  query: PageRequest | WindowRequest,
  artifactStoreForWorkspace: (workspaceId: string) => PlaytestArtifactStore
): Promise<
  | ControlApiPlaytestingPageResponse<unknown>
  | ControlApiPlaytestingEpisodeDetailResponse
  | ControlApiPlaytestingWindowResponse
  | null
> {
  if (route.windowId !== null && "startStep" in query) {
    return readEpisodeWindow(
      repository,
      route,
      query,
      artifactStoreForWorkspace
    );
  }
  if (route.id !== null && !("startStep" in query)) {
    return readEpisodeDetail(repository, query.workspaceId, route.id);
  }
  if ("limit" in query) return readPage(repository, route.resource, query);
  return Promise.resolve(null);
}

function isDataUnavailable(error: unknown): error is Error {
  return error instanceof DataUnavailableError;
}

function respondDataFailure(response: ServerResponse, error: unknown): boolean {
  if (error instanceof PlaytestInvalidCursorError) {
    sendPlaytestingError(
      response,
      400,
      "autodev_control_playtesting_invalid_cursor",
      error.message
    );
    return true;
  }
  if (isDataUnavailable(error)) {
    sendPlaytestingError(
      response,
      503,
      "autodev_control_playtesting_source_unavailable",
      "The Playtesting data source is unavailable."
    );
    return true;
  }
  if (error instanceof PlaytestArtifactExpiredError) {
    sendPlaytestingError(
      response,
      410,
      "autodev_control_playtesting_artifact_expired",
      "The selected evidence window has expired."
    );
    return true;
  }
  if (
    error instanceof PlaytestArtifactMissingError ||
    error instanceof PlaytestArtifactNotAuthorizedError
  ) {
    sendPlaytestingError(
      response,
      404,
      "autodev_control_playtesting_artifact_not_found",
      "The selected evidence window is unavailable."
    );
    return true;
  }
  if (
    error instanceof PlaytestArtifactIntegrityError ||
    error instanceof PlaytestArtifactConfigurationError ||
    error instanceof PlaytestArtifactFormatError
  ) {
    sendPlaytestingError(
      response,
      503,
      "autodev_control_playtesting_artifact_corrupted",
      "The selected evidence window failed integrity or format verification."
    );
    return true;
  }
  if (error instanceof PlaytestArtifactOversizedError) {
    sendPlaytestingError(
      response,
      413,
      "autodev_control_playtesting_window_too_large",
      "Request a narrower episode window."
    );
    return true;
  }
  return false;
}

/** Authenticated, workspace-scoped Playtesting read API. */
export async function handlePlaytestingControlApiRequest(
  request: IncomingMessage,
  response: ServerResponse,
  pathname: string,
  actor: PlaytestingControlActor,
  options: PlaytestingControlApiOptions = {}
): Promise<boolean> {
  const parsed = requestParams(request, pathname);
  if (!parsed.pathname.startsWith(CONTROL_PATH)) return false;
  const route = routeFor(parsed.pathname);
  if (route === null) {
    sendPlaytestingError(
      response,
      404,
      "autodev_control_playtesting_unknown_path",
      "Unknown Playtesting resource path."
    );
    return true;
  }
  if ((request.method ?? "GET") !== "GET") {
    response.setHeader("allow", "GET");
    sendPlaytestingError(
      response,
      405,
      "autodev_control_playtesting_read_only",
      "Playtesting reads accept GET only."
    );
    return true;
  }
  if (actor.role !== "viewer" && actor.role !== "operator") {
    sendPlaytestingError(
      response,
      403,
      "autodev_control_playtesting_forbidden",
      "Playtesting read access is not authorized."
    );
    return true;
  }

  const query = parseQuery(route, parsed.params, response);
  if (query === null) return true;
  const readWorkspaceCatalog =
    options.readWorkspaceCatalog ??
    (() => new ConfigRepository(options.repositoryRoot).readWorkspaceCatalog());
  const catalog = readWorkspaceCatalog();
  if (catalog.status !== "valid") {
    sendPlaytestingError(
      response,
      503,
      "autodev_control_playtesting_workspace_catalog_unavailable",
      "The canonical workspace catalog is unavailable."
    );
    return true;
  }
  if (!workspaceExists(query.workspaceId, catalog)) {
    sendPlaytestingError(
      response,
      404,
      "autodev_control_playtesting_workspace_not_found",
      "The requested workspace was not found."
    );
    return true;
  }

  const repository = options.repository ?? new PlaytestRepository();
  const artifactStoreForWorkspace =
    options.artifactStoreForWorkspace ??
    ((workspaceId: string) => new PlaytestArtifactStore({ workspaceId }));
  try {
    if (route.mediaId !== null) {
      const frame = await readEpisodeFrame(
        repository,
        route,
        query.workspaceId,
        artifactStoreForWorkspace
      );
      if (frame === null) {
        sendPlaytestingError(
          response,
          404,
          "autodev_control_playtesting_frame_not_found",
          "The selected frame is not linked to this episode."
        );
        return true;
      }
      sendFrame(response, frame);
      return true;
    }
    const body = await readDataResponse(
      repository,
      route,
      query,
      artifactStoreForWorkspace
    );
    if (body === null) {
      sendPlaytestingError(
        response,
        404,
        "autodev_control_playtesting_episode_not_found",
        "The requested episode was not found."
      );
      return true;
    }
    sendJson(response, 200, body, { "cache-control": "no-store" });
    return true;
  } catch (error) {
    if (respondDataFailure(response, error)) return true;
    throw error;
  }
}
