/** Shareable, workspace-scoped address state for Playtesting lists and replay. */
import type { ControlApiPlaytestingResource } from "@simulatorlife/autodev-core";

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
  Record<PlaytestingView, readonly PlaytestingFilterKey[]>
> = {
  overview: [],
  sessions: [
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
  ],
  findings: ["severity", "status", "verificationStage", "evidenceStatus"],
  compare: ["benchmarkId", "experimentId", "decision"]
};
export type PlaytestingFilterKey = (typeof PLAYTESTING_FILTER_KEYS)[number];

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
  readonly invalidQuery: boolean;
}

export const DEFAULT_PLAYTESTING_PAGE_SIZE = 50;
export const PLAYTESTING_PAGE_SIZES = [25, 50, 100] as const;
const PLAYTESTING_ROUTE = "/playtesting";
const HASH_PATTERN = /^(?:[a-f\d]{40}|[a-f\d]{64})$/iu;
const POSITIVE_INTEGER_PATTERN = /^[1-9]\d{0,2}$/u;
const STEP_PATTERN = /^(0|[1-9]\d{0,5})$/u;
const FINDING_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/u;

function hasControlCharacters(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code <= 31 || code === 127) return true;
  }
  return false;
}

function single(value: string | readonly string[] | undefined): {
  readonly value: string | undefined;
  readonly invalid: boolean;
} {
  if (value === undefined || typeof value === "string") {
    return { value, invalid: false };
  }
  return value.length === 1
    ? { value: value[0], invalid: false }
    : { value: undefined, invalid: value.length > 1 };
}

function isView(value: string | undefined): value is PlaytestingView {
  return (
    value !== undefined &&
    (PLAYTESTING_VIEWS as readonly string[]).includes(value)
  );
}

function normalizedFilters(
  input: Record<string, string | readonly string[] | undefined>
): {
  readonly filters: Partial<Record<PlaytestingFilterKey, string>>;
  readonly invalid: boolean;
} {
  const filters: Partial<Record<PlaytestingFilterKey, string>> = {};
  let invalid = false;
  for (const key of PLAYTESTING_FILTER_KEYS) {
    const selected = single(input[key]);
    invalid ||= selected.invalid;
    if (!selected.value) continue;
    const value = selected.value.trim();
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

function filtersForView(
  view: PlaytestingView,
  input: Readonly<Partial<Record<PlaytestingFilterKey, string>>>
): {
  readonly filters: Partial<Record<PlaytestingFilterKey, string>>;
  readonly invalid: boolean;
} {
  const supported = new Set(FILTERS_BY_VIEW[view]);
  const filters: Partial<Record<PlaytestingFilterKey, string>> = {};
  let invalid = false;
  for (const key of PLAYTESTING_FILTER_KEYS) {
    const value = input[key];
    if (value === undefined) continue;
    if (supported.has(key)) filters[key] = value;
    else invalid = true;
  }
  return { filters, invalid };
}

export function parsePlaytestingScope(
  input: Record<string, string | readonly string[] | undefined>
): PlaytestingScope {
  const rawView = single(input.view);
  const rawWorkspace = single(input.workspaceId);
  const rawLimit = single(input.limit);
  const rawCursor = single(input.cursor);
  const rawStep = single(input.step);
  const rawReturnFinding = single(input.returnFinding);
  const parsedFilters = normalizedFilters(input);
  const view = isView(rawView.value) ? rawView.value : "overview";
  const scopedFilters = filtersForView(view, parsedFilters.filters);
  const parsedLimit = parseLimit(rawLimit.value);
  const parsedStep = parseStep(rawStep.value);
  const workspaceId = rawWorkspace.value?.trim() || null;
  const cursor = rawCursor.value?.trim() || null;
  const candidateFindingId = rawReturnFinding.value?.trim() || null;
  const returnFindingId =
    candidateFindingId && FINDING_ID_PATTERN.test(candidateFindingId)
      ? candidateFindingId
      : null;
  const workspaceInvalid =
    workspaceId !== null &&
    (workspaceId.length > 256 || hasControlCharacters(workspaceId));
  const cursorInvalid = cursor !== null && cursor.length > 2048;
  const findingInvalid =
    candidateFindingId !== null && returnFindingId === null;

  return {
    view,
    workspaceId,
    filters: scopedFilters.filters,
    limit: parsedLimit.limit,
    cursor,
    step: parsedStep.step,
    returnFindingId,
    invalidQuery:
      rawView.invalid ||
      (rawView.value !== undefined && !isView(rawView.value)) ||
      rawWorkspace.invalid ||
      rawLimit.invalid ||
      rawCursor.invalid ||
      rawStep.invalid ||
      rawReturnFinding.invalid ||
      parsedFilters.invalid ||
      scopedFilters.invalid ||
      parsedLimit.invalid ||
      parsedStep.invalid ||
      workspaceInvalid ||
      cursorInvalid ||
      findingInvalid
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
  for (const key of PLAYTESTING_FILTER_KEYS) {
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
  const supported = new Set(FILTERS_BY_VIEW[view]);
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

/** Full-page episode route preserving the originating list and exact step. */
export function playtestingEpisodeHref(
  scope: PlaytestingScope,
  episodeId: string,
  step: number,
  returnFindingId?: string
): string {
  const params = paramsForScope(
    { ...scope, step },
    { includeCursor: true, includeStep: true }
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
  for (const key of PLAYTESTING_FILTER_KEYS) {
    if (key in updates) {
      const value = updates[key];
      if (value) filters[key] = value;
      else delete filters[key];
    }
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
