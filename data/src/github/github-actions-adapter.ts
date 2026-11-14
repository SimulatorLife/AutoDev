import { Octokit } from "@octokit/rest";
import type {
  GithubActionsRunStats,
  GithubWorkflowRun
} from "@simulatorlife/autodev-core";

import { computeRunStats } from "./github-run-stats.ts";

const GITHUB_API_ORIGIN = "https://api.github.com";
const GITHUB_API_VERSION = "2026-03-10";
const GITHUB_API_HEADERS = {
  accept: "application/vnd.github+json",
  "X-GitHub-Api-Version": GITHUB_API_VERSION
};
const OCTOKIT_SILENT_LOGGER = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {}
};
const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BYTES = 1_048_576;
const RESPONSE_TOO_LARGE_CODE = "response_too_large";
const MAX_WORKFLOWS = 100;
const MAX_BOUNDED_RUNS = 100;
const DEFAULT_RUNS_LIMIT = 30;
const REPO_SEGMENT_PATTERN = /^[a-zA-Z0-9_.-]+$/u;
const GITHUB_WORKFLOW_RECORD = "workflow";
const GITHUB_WORKFLOW_RUN_RECORD = "workflow run";

function requestTimeoutError(timeoutMs: number): GithubActionsApiError {
  return new GithubActionsApiError(
    `GitHub Actions API request timed out after ${timeoutMs}ms`,
    504,
    "timeout"
  );
}

function boundedRunsLimit(value: unknown): number {
  if (value === undefined) return DEFAULT_RUNS_LIMIT;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new GithubActionsApiError(
      "GitHub Actions run limit must be a finite number",
      400,
      "invalid_limit"
    );
  }
  return Math.max(1, Math.min(Math.trunc(value), MAX_BOUNDED_RUNS));
}

function validateWorkflowCount(totalCount: unknown, actualCount: number): void {
  if (
    totalCount !== undefined &&
    (typeof totalCount !== "number" ||
      !Number.isSafeInteger(totalCount) ||
      totalCount < 0)
  ) {
    throw new GithubActionsApiError(
      "GitHub Actions API returned an invalid workflow total_count",
      502,
      "invalid_payload"
    );
  }

  if (
    actualCount > MAX_WORKFLOWS ||
    (typeof totalCount === "number" && totalCount > MAX_WORKFLOWS) ||
    (totalCount === undefined && actualCount === MAX_WORKFLOWS) ||
    (typeof totalCount === "number" && totalCount > actualCount)
  ) {
    throw new GithubActionsApiError(
      `GitHub Actions workflow result is partial; more than ${MAX_WORKFLOWS} workflows may exist`,
      502,
      "partial_result"
    );
  }

  if (typeof totalCount === "number" && totalCount !== actualCount) {
    throw new GithubActionsApiError(
      "GitHub Actions API workflow total_count does not match the returned page",
      502,
      "invalid_payload"
    );
  }
}

function assertRequestWithinTimeout(
  controller: AbortController,
  startedAt: number,
  timeoutMs: number
): void {
  if (controller.signal.aborted || performance.now() - startedAt >= timeoutMs) {
    controller.abort();
    throw requestTimeoutError(timeoutMs);
  }
}

interface BoundedResponseBody {
  readonly bytes: Uint8Array;
  readonly tooLarge: boolean;
}

async function readBoundedBody(
  response: Response,
  controller: AbortController,
  startedAt: number,
  timeoutMs: number
): Promise<BoundedResponseBody> {
  const contentLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > MAX_RESPONSE_BYTES) {
    void response.body?.cancel().catch(() => {});
    return { bytes: new Uint8Array(), tooLarge: true };
  }

  if (!response.body) return { bytes: new Uint8Array(), tooLarge: false };

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  const cancelOnAbort = (): void => {
    void reader.cancel().catch(() => {});
  };
  controller.signal.addEventListener("abort", cancelOnAbort, { once: true });

  try {
    while (true) {
      assertRequestWithinTimeout(controller, startedAt, timeoutMs);
      // eslint-disable-next-line no-await-in-loop -- Stream chunks must be bounded sequentially.
      const { done, value } = await reader.read();
      assertRequestWithinTimeout(controller, startedAt, timeoutMs);
      if (done) break;
      if (!value) continue;

      totalBytes += value.byteLength;
      if (totalBytes > MAX_RESPONSE_BYTES) {
        void reader.cancel().catch(() => {});
        return { bytes: new Uint8Array(), tooLarge: true };
      }
      chunks.push(value);
    }
  } finally {
    controller.signal.removeEventListener("abort", cancelOnAbort);
    reader.releaseLock();
  }

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return { bytes, tooLarge: false };
}

function responseWithBody(
  response: Response,
  bytes: Uint8Array,
  requestUrl: string
): Response {
  const headers = new Headers(response.headers);
  headers.delete("content-length");
  headers.delete("content-encoding");
  const responseBytes = new Uint8Array(bytes.byteLength);
  responseBytes.set(bytes);
  const boundedResponse = new Response(
    responseBytes.byteLength > 0 ? responseBytes : null,
    {
      status: response.status,
      statusText: response.statusText,
      headers
    }
  );
  Object.defineProperty(boundedResponse, "url", {
    value: response.url || requestUrl
  });
  return boundedResponse;
}

function internalErrorResponse(
  code: string,
  message: string,
  originalStatus?: number
): Response {
  return Response.json(
    {
      autodevErrorCode: code,
      message,
      ...(originalStatus === undefined ? {} : { originalStatus })
    },
    { status: 502 }
  );
}

function paginationConflictResponse(response: Response): Response | null {
  if (response.status !== 409) return null;
  return internalErrorResponse(
    "api_error",
    "GitHub Actions API request failed with status 409",
    response.status
  );
}

function invalidSuccessPayload(
  bytes: Uint8Array,
  collectionField: string
): string | undefined {
  let data: unknown;
  try {
    data = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    return "invalid_json";
  }
  return isRecord(data) && Array.isArray(data[collectionField])
    ? undefined
    : "invalid_payload";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

interface CollectionPage {
  readonly items: readonly unknown[];
  readonly totalCount: unknown;
  readonly incompleteResults: unknown;
}

function collectionPage(data: unknown, field: string): CollectionPage {
  if (Array.isArray(data)) {
    const metadata = data as unknown as Record<string, unknown>;
    return {
      items: data,
      totalCount: metadata.total_count,
      incompleteResults: metadata.incomplete_results
    };
  }
  if (isRecord(data) && Array.isArray(data[field])) {
    return {
      items: data[field],
      totalCount: data.total_count,
      incompleteResults: data.incomplete_results
    };
  }
  throw new GithubActionsApiError(
    typeof data === "string"
      ? "GitHub Actions API returned invalid JSON"
      : `GitHub Actions API returned an invalid ${field} array`,
    502,
    typeof data === "string" ? "invalid_json" : "invalid_payload"
  );
}

interface PaginatedResponse {
  readonly data: unknown;
  readonly headers: { readonly link?: string };
}

function throwPartialResult(message: string): never {
  throw new GithubActionsApiError(message, 502, "partial_result");
}

function validateWorkflowPage(
  page: CollectionPage,
  currentCount: number,
  hasNextPage: boolean,
  totalCount: unknown,
  limit: number
): unknown {
  if (page.totalCount !== undefined) {
    if (
      typeof page.totalCount !== "number" ||
      !Number.isSafeInteger(page.totalCount) ||
      page.totalCount < 0
    ) {
      throw new GithubActionsApiError(
        "GitHub Actions API returned an invalid workflow total_count",
        502,
        "invalid_payload"
      );
    }
    if (totalCount !== undefined && page.totalCount !== totalCount) {
      throw new GithubActionsApiError(
        "GitHub Actions API workflow total_count changed during pagination",
        502,
        "invalid_payload"
      );
    }
    if (page.totalCount > limit) {
      throwPartialResult(
        `GitHub Actions workflow result is partial; more than ${limit} workflows may exist`
      );
    }
  }
  if (currentCount + page.items.length > limit) {
    throwPartialResult(
      `GitHub Actions workflow result is partial; more than ${limit} workflows may exist`
    );
  }
  if (currentCount + page.items.length === limit && hasNextPage) {
    throwPartialResult(
      `GitHub Actions workflow result is partial; more than ${limit} workflows may exist`
    );
  }
  return page.totalCount ?? totalCount;
}

async function collectPaginatedItems(
  pages: AsyncIterable<PaginatedResponse>,
  field: string,
  limit: number,
  rejectOverflow: boolean
): Promise<{ items: unknown[]; totalCount: unknown }> {
  const items: unknown[] = [];
  let totalCount: unknown;

  for await (const response of pages) {
    const page = collectionPage(response.data, field);
    const hasNextPage = response.headers.link?.includes('rel="next"') ?? false;
    if (
      page.incompleteResults === true ||
      (page.items.length === 0 && hasNextPage)
    ) {
      throwPartialResult(
        `GitHub Actions API returned an incomplete ${field} collection`
      );
    }
    if (rejectOverflow) {
      totalCount = validateWorkflowPage(
        page,
        items.length,
        hasNextPage,
        totalCount,
        limit
      );
    }
    items.push(...page.items);
    if (items.length >= limit) {
      break;
    }
  }

  return { items, totalCount };
}

function invalidRecord(
  collection: typeof GITHUB_WORKFLOW_RECORD | typeof GITHUB_WORKFLOW_RUN_RECORD,
  index: number,
  field?: string
): GithubActionsApiError {
  const detail = field ? ` field "${field}"` : " record";
  return new GithubActionsApiError(
    `GitHub Actions API returned an invalid ${collection}${detail} at index ${index}`,
    502,
    "invalid_payload"
  );
}

function requiredIdentifier(
  record: Record<string, unknown>,
  field: string,
  collection: typeof GITHUB_WORKFLOW_RECORD | typeof GITHUB_WORKFLOW_RUN_RECORD,
  index: number
): number {
  const value = record[field];
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw invalidRecord(collection, index, field);
  }
  return value;
}

function requiredString(
  record: Record<string, unknown>,
  field: string,
  collection: typeof GITHUB_WORKFLOW_RECORD | typeof GITHUB_WORKFLOW_RUN_RECORD,
  index: number
): string {
  const value = record[field];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw invalidRecord(collection, index, field);
  }
  return value;
}

function optionalString(
  record: Record<string, unknown>,
  field: string,
  collection: typeof GITHUB_WORKFLOW_RECORD | typeof GITHUB_WORKFLOW_RUN_RECORD,
  index: number
): string {
  const value = record[field];
  if (value === undefined) return "";
  if (typeof value !== "string") throw invalidRecord(collection, index, field);
  return value;
}

function optionalNullableString(
  record: Record<string, unknown>,
  field: string,
  collection: typeof GITHUB_WORKFLOW_RECORD | typeof GITHUB_WORKFLOW_RUN_RECORD,
  index: number
): string | null {
  const value = record[field];
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") throw invalidRecord(collection, index, field);
  return value;
}

function parseApiWorkflow(item: unknown, index: number): GithubApiWorkflow {
  if (!isRecord(item)) throw invalidRecord(GITHUB_WORKFLOW_RECORD, index);
  return {
    id: requiredIdentifier(item, "id", GITHUB_WORKFLOW_RECORD, index),
    name: requiredString(item, "name", GITHUB_WORKFLOW_RECORD, index),
    path: requiredString(item, "path", GITHUB_WORKFLOW_RECORD, index),
    state: requiredString(item, "state", GITHUB_WORKFLOW_RECORD, index),
    htmlUrl: optionalString(item, "html_url", GITHUB_WORKFLOW_RECORD, index),
    createdAt: optionalString(
      item,
      "created_at",
      GITHUB_WORKFLOW_RECORD,
      index
    ),
    updatedAt: optionalString(item, "updated_at", GITHUB_WORKFLOW_RECORD, index)
  };
}

function parseWorkflowRun(item: unknown, index: number): GithubWorkflowRun {
  if (!isRecord(item)) throw invalidRecord(GITHUB_WORKFLOW_RUN_RECORD, index);
  const runAttempt = item.run_attempt;
  if (
    runAttempt !== undefined &&
    (typeof runAttempt !== "number" ||
      !Number.isSafeInteger(runAttempt) ||
      runAttempt < 1)
  ) {
    throw invalidRecord(GITHUB_WORKFLOW_RUN_RECORD, index, "run_attempt");
  }

  return {
    id: requiredIdentifier(item, "id", GITHUB_WORKFLOW_RUN_RECORD, index),
    name: optionalNullableString(
      item,
      "name",
      GITHUB_WORKFLOW_RUN_RECORD,
      index
    ),
    workflowId: requiredIdentifier(
      item,
      "workflow_id",
      GITHUB_WORKFLOW_RUN_RECORD,
      index
    ),
    workflowPath: optionalString(
      item,
      "path",
      GITHUB_WORKFLOW_RUN_RECORD,
      index
    ),
    headBranch: optionalNullableString(
      item,
      "head_branch",
      GITHUB_WORKFLOW_RUN_RECORD,
      index
    ),
    headSha: optionalString(
      item,
      "head_sha",
      GITHUB_WORKFLOW_RUN_RECORD,
      index
    ),
    event: requiredString(item, "event", GITHUB_WORKFLOW_RUN_RECORD, index),
    status: requiredString(item, "status", GITHUB_WORKFLOW_RUN_RECORD, index),
    conclusion: optionalNullableString(
      item,
      "conclusion",
      GITHUB_WORKFLOW_RUN_RECORD,
      index
    ),
    htmlUrl: optionalString(
      item,
      "html_url",
      GITHUB_WORKFLOW_RUN_RECORD,
      index
    ),
    createdAt: optionalString(
      item,
      "created_at",
      GITHUB_WORKFLOW_RUN_RECORD,
      index
    ),
    updatedAt: optionalString(
      item,
      "updated_at",
      GITHUB_WORKFLOW_RUN_RECORD,
      index
    ),
    runAttempt: runAttempt ?? 1
  };
}

function throwHttpError(
  status: number,
  data: unknown,
  token: string | undefined
): never {
  const errorDetail =
    isRecord(data) && typeof data.message === "string"
      ? `: ${sanitizeErrorMessage(data.message, token)}`
      : "";
  const knownErrors: Record<number, { message: string; code: string }> = {
    401: {
      message: "GitHub Actions API authentication failed (401 Unauthorized)",
      code: "unauthorized"
    },
    403: {
      message: "GitHub Actions API forbidden or rate limited (403 Forbidden)",
      code: "forbidden"
    },
    429: {
      message: "GitHub Actions API rate limited (429 Too Many Requests)",
      code: "rate_limited"
    },
    404: {
      message:
        "GitHub Actions repository or resource not found (404 Not Found)",
      code: "not_found"
    }
  };
  const known = knownErrors[status];
  throw new GithubActionsApiError(
    known
      ? `${known.message}${errorDetail}`
      : `GitHub Actions API request failed with status ${status}${errorDetail}`,
    status,
    known?.code ?? "api_error"
  );
}

function rethrowRequestError(
  error: unknown,
  controller: AbortController,
  timedOut: boolean,
  timeoutMs: number,
  token: string | undefined
): never {
  if (error instanceof GithubActionsApiError) throw error;
  const errorRecord = isRecord(error) ? error : undefined;
  const cause = errorRecord?.cause;
  const errorName =
    errorRecord && typeof errorRecord.name === "string"
      ? errorRecord.name
      : cause && typeof cause === "object" && "name" in cause
        ? (cause as { name: string }).name
        : "";
  if (
    timedOut ||
    controller.signal.aborted ||
    errorName === "AbortError" ||
    errorName === "TimeoutError"
  ) {
    throw requestTimeoutError(timeoutMs);
  }

  if (cause instanceof GithubActionsApiError) throw cause;

  const response = errorRecord?.response;
  if (isRecord(response) && typeof response.status === "number") {
    const data = response.data;
    if (
      isRecord(data) &&
      typeof data.autodevErrorCode === "string" &&
      typeof data.message === "string"
    ) {
      throw new GithubActionsApiError(
        data.message,
        data.originalStatus === 409 ? 409 : response.status,
        data.autodevErrorCode
      );
    }
    throwHttpError(response.status, data, token);
  }

  const rawMessage =
    cause instanceof Error
      ? cause.message
      : error instanceof Error
        ? error.message
        : String(error);
  throw new GithubActionsApiError(
    `GitHub Actions API network failure: ${sanitizeErrorMessage(rawMessage, token)}`,
    502,
    "network_error"
  );
}

export interface GithubActionsAdapterOptions {
  readonly fetchFn?: typeof fetch;
  readonly timeoutMs?: number;
}

export interface GithubApiWorkflow {
  readonly id: number;
  readonly name: string;
  readonly path: string;
  readonly state: string;
  readonly htmlUrl: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface GithubActionsRuntimeSnapshot {
  readonly workflows: readonly GithubApiWorkflow[];
  readonly runs: readonly GithubWorkflowRun[];
  readonly stats: GithubActionsRunStats;
}

export class GithubActionsApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(
    message: string,
    status: number = 500,
    code: string = "github_api_error"
  ) {
    super(message);
    this.name = "GithubActionsApiError";
    this.status = status;
    this.code = code;
  }
}

function sanitizeErrorMessage(
  message: string,
  token: string | undefined
): string {
  if (!token || token.trim().length === 0) return message;
  return message.replaceAll(token, "[REDACTED]");
}

export class GithubActionsAdapter {
  private readonly fetchFn: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: GithubActionsAdapterOptions = {}) {
    this.fetchFn = options.fetchFn ?? globalThis.fetch;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  private validateRepository(
    owner: string,
    repo: string
  ): { owner: string; repo: string } {
    if (
      !owner ||
      !repo ||
      owner === "." ||
      owner === ".." ||
      repo === "." ||
      repo === ".." ||
      !REPO_SEGMENT_PATTERN.test(owner) ||
      !REPO_SEGMENT_PATTERN.test(repo)
    ) {
      throw new GithubActionsApiError(
        `Invalid repository coordinates: owner="${owner}", repo="${repo}"`,
        400,
        "invalid_repository"
      );
    }
    return { owner, repo };
  }

  private async withOctokit<T>(
    token: string | undefined,
    operation: (octokit: Octokit) => Promise<T>
  ): Promise<T> {
    const controller = new AbortController();
    const startedAt = performance.now();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.timeoutMs);
    timer.unref();

    const fetchBounded: typeof fetch = async (input, init) => {
      const url = new URL(
        typeof input === "string" || input instanceof URL ? input : input.url
      );
      if (url.origin !== GITHUB_API_ORIGIN) {
        throw new GithubActionsApiError(
          "GitHub Actions API pagination attempted to leave the fixed API origin",
          502,
          "invalid_pagination"
        );
      }
      const method =
        init?.method ?? (input instanceof Request ? input.method : "GET");
      if (method.toUpperCase() !== "GET") {
        throw new GithubActionsApiError(
          "GitHub Actions API adapter only permits GET requests",
          502,
          "invalid_request"
        );
      }

      assertRequestWithinTimeout(controller, startedAt, this.timeoutMs);
      const response = await this.fetchFn(input, {
        ...init,
        method,
        signal: controller.signal,
        redirect: "error"
      });
      assertRequestWithinTimeout(controller, startedAt, this.timeoutMs);

      let body: BoundedResponseBody;
      try {
        body = await readBoundedBody(
          response,
          controller,
          startedAt,
          this.timeoutMs
        );
      } catch (error: unknown) {
        if (!response.ok && !timedOut && !controller.signal.aborted) {
          return (
            paginationConflictResponse(response) ??
            responseWithBody(response, new Uint8Array(), url.href)
          );
        }
        throw error;
      }
      assertRequestWithinTimeout(controller, startedAt, this.timeoutMs);

      if (body.tooLarge) {
        if (!response.ok) {
          return (
            paginationConflictResponse(response) ??
            responseWithBody(response, new Uint8Array(), url.href)
          );
        }
        return internalErrorResponse(
          RESPONSE_TOO_LARGE_CODE,
          `GitHub Actions API response exceeded the ${MAX_RESPONSE_BYTES}-byte limit`
        );
      }

      // Octokit's iterator must not reinterpret a 409 response as an empty page.
      const paginationError = paginationConflictResponse(response);
      if (paginationError) return paginationError;

      if (response.ok) {
        const collectionField = url.pathname.endsWith("/actions/workflows")
          ? "workflows"
          : "workflow_runs";
        const invalidPayload = invalidSuccessPayload(
          body.bytes,
          collectionField
        );
        if (invalidPayload === "invalid_json") {
          return internalErrorResponse(
            invalidPayload,
            "GitHub Actions API returned invalid JSON"
          );
        }
        if (invalidPayload) {
          return internalErrorResponse(
            invalidPayload,
            "GitHub Actions API returned an invalid JSON object"
          );
        }
      }
      return responseWithBody(response, body.bytes, url.href);
    };

    const octokit = new Octokit({
      auth: token?.trim() || undefined,
      baseUrl: GITHUB_API_ORIGIN,
      userAgent: "AutoDev-Control-API",
      log: OCTOKIT_SILENT_LOGGER,
      request: {
        fetch: fetchBounded,
        redirect: "error",
        signal: controller.signal
      }
    });

    try {
      const result = await operation(octokit);
      assertRequestWithinTimeout(controller, startedAt, this.timeoutMs);
      return result;
    } catch (error: unknown) {
      return rethrowRequestError(
        error,
        controller,
        timedOut,
        this.timeoutMs,
        token
      );
    } finally {
      clearTimeout(timer);
    }
  }

  listWorkflows(
    owner: string,
    repo: string,
    token?: string
  ): Promise<readonly GithubApiWorkflow[]> {
    return Promise.resolve().then(() => {
      const repository = this.validateRepository(owner, repo);
      return this.withOctokit(token, async (octokit) => {
        const result = await collectPaginatedItems(
          octokit.paginate.iterator(octokit.rest.actions.listRepoWorkflows, {
            ...repository,
            per_page: MAX_WORKFLOWS,
            headers: GITHUB_API_HEADERS
          }),
          "workflows",
          MAX_WORKFLOWS,
          true
        );
        validateWorkflowCount(result.totalCount, result.items.length);
        return result.items.map(parseApiWorkflow);
      });
    });
  }

  listRecentRuns(
    owner: string,
    repo: string,
    token?: string,
    options: { limit?: number } = {}
  ): Promise<readonly GithubWorkflowRun[]> {
    return Promise.resolve().then(() => {
      const repository = this.validateRepository(owner, repo);
      const limit = boundedRunsLimit(options.limit);
      return this.withOctokit(token, async (octokit) => {
        const result = await collectPaginatedItems(
          octokit.paginate.iterator(
            octokit.rest.actions.listWorkflowRunsForRepo,
            {
              ...repository,
              per_page: limit,
              headers: GITHUB_API_HEADERS
            }
          ),
          "workflow_runs",
          limit,
          false
        );
        return result.items
          .map((item, index) => parseWorkflowRun(item, index))
          .slice(0, limit);
      });
    });
  }

  async fetchRuntimeSnapshot(
    owner: string,
    repo: string,
    token?: string,
    options: { limit?: number } = {}
  ): Promise<GithubActionsRuntimeSnapshot> {
    const [workflows, rawRuns] = await Promise.all([
      this.listWorkflows(owner, repo, token),
      this.listRecentRuns(owner, repo, token, options)
    ]);

    // Correlate workflowPath if the run object didn't have path explicitly.
    const workflowPathById = new Map<number, string>();
    for (const w of workflows) {
      workflowPathById.set(w.id, w.path);
    }

    const runs: GithubWorkflowRun[] = rawRuns.map((r) => {
      if (!r.workflowPath && workflowPathById.has(r.workflowId)) {
        return {
          ...r,
          workflowPath: workflowPathById.get(r.workflowId)!
        };
      }
      return r;
    });

    const stats = computeRunStats(runs);

    return {
      workflows,
      runs,
      stats
    };
  }
}
