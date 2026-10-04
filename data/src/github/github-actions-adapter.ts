import type {
  GithubActionsRunStats,
  GithubWorkflowRun
} from "@simulatorlife/autodev-core";

const GITHUB_API_ORIGIN = "https://api.github.com";
const GITHUB_API_VERSION = "2026-03-10";
const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BYTES = 1_048_576;
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

async function readBoundedJson(
  response: Response,
  token: string,
  controller: AbortController,
  startedAt: number,
  timeoutMs: number
): Promise<unknown> {
  const contentLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > MAX_RESPONSE_BYTES) {
    void response.body?.cancel().catch(() => {});
    throw new GithubActionsApiError(
      `GitHub Actions API response exceeded the ${MAX_RESPONSE_BYTES}-byte limit`,
      502,
      "response_too_large"
    );
  }

  if (!response.body) {
    throw new GithubActionsApiError(
      "GitHub Actions API returned an empty response body",
      502,
      "invalid_json"
    );
  }

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
        throw new GithubActionsApiError(
          `GitHub Actions API response exceeded the ${MAX_RESPONSE_BYTES}-byte limit`,
          502,
          "response_too_large"
        );
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

  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    assertRequestWithinTimeout(controller, startedAt, timeoutMs);
    const data: unknown = JSON.parse(text);
    assertRequestWithinTimeout(controller, startedAt, timeoutMs);
    return data;
  } catch (error: unknown) {
    if (error instanceof GithubActionsApiError) throw error;
    const raw = error instanceof Error ? error.message : String(error);
    throw new GithubActionsApiError(
      `GitHub Actions API returned invalid JSON: ${sanitizeErrorMessage(raw, token)}`,
      502,
      "invalid_json"
    );
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
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
  response: Response,
  data: unknown,
  token: string
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
  const known = knownErrors[response.status];
  throw new GithubActionsApiError(
    known
      ? `${known.message}${errorDetail}`
      : `GitHub Actions API request failed with status ${response.status}${errorDetail}`,
    response.status,
    known?.code ?? "api_error"
  );
}

function rethrowRequestError(
  error: unknown,
  controller: AbortController,
  timedOut: boolean,
  timeoutMs: number,
  token: string
): never {
  if (error instanceof GithubActionsApiError) throw error;
  const errorName =
    error && typeof error === "object" && "name" in error
      ? (error as { name: string }).name
      : "";
  if (
    timedOut ||
    controller.signal.aborted ||
    errorName === "AbortError" ||
    errorName === "TimeoutError"
  ) {
    throw requestTimeoutError(timeoutMs);
  }
  const rawMessage = error instanceof Error ? error.message : String(error);
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

function sanitizeErrorMessage(message: string, token: string): string {
  if (!token || token.trim().length === 0) return message;
  return message.replaceAll(token, "[REDACTED]");
}

/**
 * Compute run statistics precisely scoped to the returned/time-filtered set.
 * Success rate is successful conclusions divided by completed sampled runs;
 * non-success or missing conclusions remain in the denominator.
 * Returns non-null stats only over actual observed runs; callers must NOT
 * synthesize 0/healthy when runtime data is absent or unavailable.
 */
export function computeRunStats(
  runs: readonly GithubWorkflowRun[]
): GithubActionsRunStats {
  const totalRuns = runs.length;
  let completedRuns = 0;
  let successfulRuns = 0;
  let failedRuns = 0;
  let inProgressRuns = 0;
  let cancelledRuns = 0;

  for (const run of runs) {
    const isProgress =
      run.status === "in_progress" ||
      run.status === "queued" ||
      run.status === "waiting" ||
      run.status === "requested" ||
      run.status === "pending";

    if (isProgress) {
      inProgressRuns++;
    }

    if (run.status !== "completed") continue;
    completedRuns++;

    if (run.conclusion === "success") {
      successfulRuns++;
    } else if (
      run.conclusion === "failure" ||
      run.conclusion === "timed_out" ||
      run.conclusion === "action_required" ||
      run.conclusion === "startup_failure"
    ) {
      failedRuns++;
    } else if (run.conclusion === "cancelled") {
      cancelledRuns++;
    }
  }

  const successRate =
    completedRuns > 0
      ? Math.round((successfulRuns / completedRuns) * 1000) / 1000
      : null;

  return {
    totalRuns,
    successfulRuns,
    failedRuns,
    inProgressRuns,
    cancelledRuns,
    successRate
  };
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

  private async request(
    endpoint: string,
    token: string
  ): Promise<Record<string, unknown>> {
    if (!token || typeof token !== "string" || token.trim().length === 0) {
      throw new GithubActionsApiError(
        "GitHub Actions API token is missing or empty",
        401,
        "token_missing"
      );
    }

    // Origin is fixed to GITHUB_API_ORIGIN; caller-supplied hosts are forbidden.
    const url = `${GITHUB_API_ORIGIN}${endpoint}`;
    const controller = new AbortController();
    const startedAt = performance.now();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.timeoutMs);
    timer.unref();

    try {
      const headers: Record<string, string> = {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "X-GitHub-Api-Version": GITHUB_API_VERSION,
        "User-Agent": "AutoDev-Control-API"
      };
      const response = await this.fetchFn(url, {
        method: "GET",
        headers,
        signal: controller.signal,
        redirect: "error"
      });

      if (!response.ok) {
        let errorBody: unknown = null;
        try {
          errorBody = await readBoundedJson(
            response,
            token,
            controller,
            startedAt,
            this.timeoutMs
          );
        } catch {
          // The HTTP status remains authoritative if its optional body is
          // malformed, too large, or otherwise unreadable.
        }
        throwHttpError(response, errorBody, token);
      }

      const data: unknown = await readBoundedJson(
        response,
        token,
        controller,
        startedAt,
        this.timeoutMs
      );
      assertRequestWithinTimeout(controller, startedAt, this.timeoutMs);

      if (!isRecord(data)) {
        throw new GithubActionsApiError(
          "GitHub Actions API returned an invalid JSON object",
          502,
          "invalid_payload"
        );
      }
      return data;
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

  async listWorkflows(
    owner: string,
    repo: string,
    token: string
  ): Promise<readonly GithubApiWorkflow[]> {
    this.validateRepository(owner, repo);
    const endpoint = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/actions/workflows?per_page=100`;
    const data = await this.request(endpoint, token);
    if (!Array.isArray(data.workflows)) {
      throw new GithubActionsApiError(
        "GitHub Actions API returned an invalid workflows array",
        502,
        "invalid_payload"
      );
    }
    validateWorkflowCount(data.total_count, data.workflows.length);
    return data.workflows.map(parseApiWorkflow);
  }

  async listRecentRuns(
    owner: string,
    repo: string,
    token: string,
    options: { limit?: number } = {}
  ): Promise<readonly GithubWorkflowRun[]> {
    this.validateRepository(owner, repo);
    const limit = boundedRunsLimit(options.limit);
    const endpoint = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/actions/runs?per_page=${limit}`;
    const data = await this.request(endpoint, token);
    if (!Array.isArray(data.workflow_runs)) {
      throw new GithubActionsApiError(
        "GitHub Actions API returned an invalid workflow_runs array",
        502,
        "invalid_payload"
      );
    }
    const runs = data.workflow_runs.map(parseWorkflowRun);
    return runs.slice(0, limit);
  }

  async fetchRuntimeSnapshot(
    owner: string,
    repo: string,
    token: string,
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
