/** Shareable, workspace-scoped address state for Playtesting lists and replay. */
import {
  type ControlApiPlaytestingResource,
  PLAYTESTS_MAX_ANALYSIS_SESSIONS
} from "@simulatorlife/autodev-core";

export const PLAYTESTING_VIEWS = [
  "overview",
  "sessions",
  "findings",
  "compare"
] as const;
export type PlaytestingView = (typeof PLAYTESTING_VIEWS)[number];

export const PLAYTESTING_FILTER_KEYS = [
  "buildSha",
  "scenario",
  "policy",
  "cohort",
  "status",
  "gameOutcome",
  "severity",
  "decision",
  "batchId",
  "reviewStatus",
  "startedAtFrom",
  "startedAtTo",
  "verificationStage",
  "evidenceStatus",
  "benchmarkId",
  "experimentId",
  "referenceBuildSha",
  "measurementVersion",
  "state",
  "instrument",
  "approved"
] as const;

const FILTERS_BY_VIEW: Readonly<
  Record<PlaytestingView, ReadonlySet<PlaytestingFilterKey>>
> = {
  overview: new Set<PlaytestingFilterKey>(),
  sessions: new Set<PlaytestingFilterKey>([
    "buildSha",
    "scenario",
    "policy",
    "cohort",
    "status",
    "gameOutcome",
    "batchId",
    "reviewStatus",
    "startedAtFrom",
    "startedAtTo"
  ]),
  findings: new Set<PlaytestingFilterKey>([
    "severity",
    "status",
    "verificationStage",
    "evidenceStatus"
  ]),
  compare: new Set<PlaytestingFilterKey>([
    "benchmarkId",
    "experimentId",
    "decision"
  ])
};
export type PlaytestingFilterKey = (typeof PLAYTESTING_FILTER_KEYS)[number];

const FILTER_KEY_SET: ReadonlySet<string> = new Set(PLAYTESTING_FILTER_KEYS);
const FILTER_KEY_ORDER = new Map<string, number>(
  PLAYTESTING_FILTER_KEYS.map((key, index) => [key, index] as const)
);

function orderedPresentFilterKeys(
  source: object
): PlaytestingFilterKey[] {
  return Object.keys(source)
    .filter((key): key is PlaytestingFilterKey => FILTER_KEY_SET.has(key))
    .sort((left, right) => FILTER_KEY_ORDER.get(left)! - FILTER_KEY_ORDER.get(right)!);
}

/** Query keys accepted by each server-filtered Data resource. */
export const PLAYTESTING_FILTERS_BY_RESOURCE = {
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
} as const satisfies Record<
  ControlApiPlaytestingResource,
  readonly PlaytestingFilterKey[]
>;

export interface PlaytestingScope {
  readonly view: PlaytestingView;
  readonly workspaceId: string | null;
  readonly filters: Readonly<Partial<Record<PlaytestingFilterKey, string>>>;
  readonly limit: number;
  readonly cursor: string | null;
  readonly step: number | null;
  /** Finding to restore focus to when the inspector returns to its source list. */
  readonly returnFindingId: string | null;
  /** Focused batch in the live view; bounded so it stays shareable. */
  readonly liveBatchId: string | null;
  /** Explicit analysis selection; bounded by the same limit Runtime enforces. */
  readonly selectedEpisodeIds: readonly string[];
  readonly invalidSelection: boolean;
  readonly invalidQuery: boolean;
}

export const DEFAULT_PLAYTESTING_PAGE_SIZE = 50;
export const PLAYTESTING_PAGE_SIZES = [25, 50, 100] as const;
const PLAYTESTING_ROUTE = "/playtesting";
const HASH_PATTERN = /^(?:[a-f\d]{40}|[a-f\d]{64})$/iu;
const POSITIVE_INTEGER_PATTERN = /^[1-9]\d{0,2}$/u;
const STEP_PATTERN = /^(0|[1-9]\d{0,5})$/u;
const FINDING_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/u;
/** Batch ids are bounded so the live view's address state stays shareable. */
const BATCH_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/u;
const SESSION_ID_PATTERN = /^[A-Za-z0-9._:-]{1,256}$/u;

/**
 * The analysis selection is explicit and bounded. An empty, oversized or
 * malformed value is refused rather than silently trimmed, so a shared link
 * either reproduces the operator's selection exactly or says it was invalid.
 */
function parseSessionSelection(value: string | undefined): {
  readonly episodeIds: readonly string[];
  readonly invalid: boolean;
} {
  if (value === undefined) return { episodeIds: [], invalid: false };
  if (
    value.length === 0 ||
    value.length > PLAYTESTS_MAX_ANALYSIS_SESSIONS * 257
  ) {
    return { episodeIds: [], invalid: true };
  }
  const parts = value.split(",");
  const episodeIds: string[] = [];
  for (const part of parts) {
    if (part.length === 0) return { episodeIds: [], invalid: true };
    if (!SESSION_ID_PATTERN.test(part))
      return { episodeIds: [], invalid: true };
    if (!episodeIds.includes(part)) episodeIds.push(part);
  }
  if (
    episodeIds.length === 0 ||
    episodeIds.length > PLAYTESTS_MAX_ANALYSIS_SESSIONS
  ) {
    return { episodeIds: [], invalid: true };
  }
  return { episodeIds, invalid: false };
}

function hasControlCharacters(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code <= 31 || code === 127) return true;
  }
  return false;
}

function singleValue(
  value: string | readonly string[] | undefined
): string | undefined {
  if (value === undefined || typeof value === "string") return value;
  return value.length === 1 ? value[0] : undefined;
}

function hasRepeatedValues(
  value: string | readonly string[] | undefined
): boolean {
  return Array.isArray(value) && value.length > 1;
}

function isView(value: string | undefined): value is PlaytestingView {
  return (
    value !== undefined &&
    (PLAYTESTING_VIEWS as readonly string[]).includes(value)
  );
}

function normalizedFilters(
  input: Record<string, string | readonly string[] | undefined>,
  view: PlaytestingView
): {
  readonly filters: Partial<Record<PlaytestingFilterKey, string>>;
  readonly invalid: boolean;
} {
  const filters: Partial<Record<PlaytestingFilterKey, string>> = {};
  const supported = FILTERS_BY_VIEW[view];
  let invalid = false;
  for (const key of orderedPresentFilterKeys(input)) {
    const raw = input[key];
    const candidate = singleValue(raw);
    if (hasRepeatedValues(raw)) invalid = true;
    if (!candidate) continue;
    const value = candidate.trim();
    if (value.length === 0 || value.length > 256) {
      invalid = true;
      continue;
    }
    if (
      (key === "buildSha" || key === "referenceBuildSha") &&
      !HASH_PATTERN.test(value)
    ) {
      invalid = true;
      continue;
    }
    if (!supported.has(key)) {
      invalid = true;
      continue;
    }
    filters[key] = value;
  }
  return { filters, invalid };
}

function parseLimit(value: string | undefined): {
  readonly limit: number;
  readonly invalid: boolean;
} {
  if (value === undefined) {
    return { limit: DEFAULT_PLAYTESTING_PAGE_SIZE, invalid: false };
  }
  if (!POSITIVE_INTEGER_PATTERN.test(value)) {
    return { limit: DEFAULT_PLAYTESTING_PAGE_SIZE, invalid: true };
  }
  const limit = Number(value);
  return (PLAYTESTING_PAGE_SIZES as readonly number[]).includes(limit)
    ? { limit, invalid: false }
    : { limit: DEFAULT_PLAYTESTING_PAGE_SIZE, invalid: true };
}

function parseStep(value: string | undefined): {
  readonly step: number | null;
  readonly invalid: boolean;
} {
  if (value === undefined) return { step: null, invalid: false };
  if (!STEP_PATTERN.test(value)) return { step: null, invalid: true };
  return { step: Number(value), invalid: false };
}

export function parsePlaytestingScope(
  input: Record<string, string | readonly string[] | undefined>
): PlaytestingScope {
  const rawView = singleValue(input.view);
  const rawWorkspace = singleValue(input.workspaceId);
  const rawLimit = singleValue(input.limit);
  const rawCursor = singleValue(input.cursor);
  const rawStep = singleValue(input.step);
  const rawReturnFinding = singleValue(input.returnFinding);
  const rawLiveBatch = singleValue(input.liveBatch);
  const rawSelection = singleValue(input.sessions);
  const view = isView(rawView) ? rawView : "overview";
  const parsedFilters = normalizedFilters(input, view);
  const parsedLimit = parseLimit(rawLimit);
  const parsedStep = parseStep(rawStep);
  const workspaceId = rawWorkspace?.trim() || null;
  const cursor = rawCursor?.trim() || null;
  const candidateFindingId = rawReturnFinding?.trim() || null;
  const returnFindingId =
    candidateFindingId && FINDING_ID_PATTERN.test(candidateFindingId)
      ? candidateFindingId
      : null;
  const candidateLiveBatchId = rawLiveBatch?.trim() || null;
  const liveBatchId =
    candidateLiveBatchId && BATCH_ID_PATTERN.test(candidateLiveBatchId)
      ? candidateLiveBatchId
      : null;
  const liveBatchInvalid =
    candidateLiveBatchId !== null && liveBatchId === null;
  const selection = parseSessionSelection(rawSelection);
  const selectionInvalid =
    hasRepeatedValues(input.sessions) || selection.invalid;
  const workspaceInvalid =
    workspaceId !== null &&
    (workspaceId.length > 256 || hasControlCharacters(workspaceId));
  const cursorInvalid = cursor !== null && cursor.length > 2048;
  const findingInvalid =
    candidateFindingId !== null && returnFindingId === null;

  return {
    view,
    workspaceId,
    filters: parsedFilters.filters,
    limit: parsedLimit.limit,
    cursor,
    step: parsedStep.step,
    returnFindingId,
    liveBatchId,
    selectedEpisodeIds: selection.episodeIds,
    invalidSelection: selectionInvalid,
    invalidQuery:
      hasRepeatedValues(input.view) ||
      (rawView !== undefined && !isView(rawView)) ||
      hasRepeatedValues(input.workspaceId) ||
      hasRepeatedValues(input.limit) ||
      hasRepeatedValues(input.cursor) ||
      hasRepeatedValues(input.step) ||
      hasRepeatedValues(input.returnFinding) ||
      hasRepeatedValues(input.liveBatch) ||
      selectionInvalid ||
      parsedFilters.invalid ||
      parsedLimit.invalid ||
      parsedStep.invalid ||
      workspaceInvalid ||
      cursorInvalid ||
      findingInvalid ||
      liveBatchInvalid
  };
}

function paramsForScope(
  scope: PlaytestingScope,
  options: {
    readonly includeCursor?: boolean;
    readonly includeStep?: boolean;
  } = {}
): URLSearchParams {
  const params = new URLSearchParams();
  if (scope.view !== "overview") params.set("view", scope.view);
  if (scope.workspaceId) params.set("workspaceId", scope.workspaceId);
  for (const key of orderedPresentFilterKeys(scope.filters)) {
    const value = scope.filters[key];
    if (value) params.set(key, value);
  }
  if (scope.limit !== DEFAULT_PLAYTESTING_PAGE_SIZE) {
    params.set("limit", String(scope.limit));
  }
  if (options.includeCursor !== false && scope.cursor) {
    params.set("cursor", scope.cursor);
  }
  if (options.includeStep !== false && scope.step !== null) {
    params.set("step", String(scope.step));
  }
  // The focused live batch is address state, so a refresh or Back returns the
  // operator to the batch they were watching rather than a bare list.
  if (scope.liveBatchId) params.set("liveBatch", scope.liveBatchId);
  // The selection is address state so a shared link, a refresh or Back
  // reproduces the same set of sessions.
  if (scope.selectedEpisodeIds.length > 0) {
    params.set("sessions", scope.selectedEpisodeIds.join(","));
  }
  return params;
}

function withQuery(path: string, params: URLSearchParams): string {
  const query = params.toString();
  return query ? `${path}?${query}` : path;
}

/** Current view with all active filters and cursor state. */
export function playtestingListHref(scope: PlaytestingScope): string {
  return withQuery(PLAYTESTING_ROUTE, paramsForScope(scope));
}

/** Switching views retains shared filters but resets its independent keyset cursor. */
export function playtestingViewHref(
  scope: PlaytestingScope,
  view: PlaytestingView
): string {
  const supported = FILTERS_BY_VIEW[view];
  const filters: Partial<Record<PlaytestingFilterKey, string>> = {};
  for (const key of supported) {
    const value = scope.filters[key];
    if (value) filters[key] = value;
  }
  const next: PlaytestingScope = {
    ...scope,
    view,
    filters,
    cursor: null,
    step: null
  };
  return withQuery(
    PLAYTESTING_ROUTE,
    paramsForScope(next, { includeCursor: false, includeStep: false })
  );
}

/** A keyset page link for the active list; filters remain exactly as selected. */
export function playtestingPageHref(
  scope: PlaytestingScope,
  cursor: string
): string {
  const params = paramsForScope(scope, {
    includeCursor: false,
    includeStep: false
  });
  if (cursor) params.set("cursor", cursor);
  return withQuery(PLAYTESTING_ROUTE, params);
}

/** Sessions view with exactly this episode preselected for optional analysis. */
export function playtestingAnalyzeEpisodeHref(
  scope: PlaytestingScope,
  episodeId: string
): string {
  return playtestingViewHref(
    { ...scope, selectedEpisodeIds: [episodeId] },
    "sessions"
  );
}

/** Full-page episode route preserving the originating list and exact step. */
export function playtestingEpisodeHref(
  scope: PlaytestingScope,
  episodeId: string,
  step: number | null = null,
  returnFindingId?: string
): string {
  const params = paramsForScope(
    { ...scope, step },
    { includeCursor: true, includeStep: step !== null }
  );
  if (returnFindingId && FINDING_ID_PATTERN.test(returnFindingId)) {
    params.set("returnFinding", returnFindingId);
  }
  return withQuery(
    `${PLAYTESTING_ROUTE}/sessions/${encodeURIComponent(episodeId)}`,
    params
  );
}

/** Return to the exact source list and restore the cited finding anchor. */
export function playtestingInspectorBackHref(scope: PlaytestingScope): string {
  const href = playtestingListHref({ ...scope, step: null });
  return scope.returnFindingId
    ? `${href}#finding-${encodeURIComponent(scope.returnFindingId)}`
    : href;
}

/** Replace all list filters and reset pagination in one URL transition. */
export function playtestingFilterHref(
  scope: PlaytestingScope,
  updates: Partial<Record<PlaytestingFilterKey, string | null>> & {
    readonly workspaceId?: string | null;
    readonly view?: PlaytestingView;
    readonly limit?: number;
  }
): string {
  const filters = { ...scope.filters };
  for (const key of orderedPresentFilterKeys(updates)) {
    const value = updates[key];
    if (value) filters[key] = value;
    else delete filters[key];
  }
  return playtestingListHref({
    ...scope,
    view: updates.view ?? scope.view,
    workspaceId:
      updates.workspaceId === undefined
        ? scope.workspaceId
        : updates.workspaceId,
    limit: updates.limit ?? scope.limit,
    cursor: null,
    step: null,
    filters
  });
}
