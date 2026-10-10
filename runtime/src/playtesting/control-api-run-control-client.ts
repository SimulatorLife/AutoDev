/** MCP-side client for the single Runtime Control API run owner. */
import type {
  ControlApiPlaytestingActiveRunsResponse,
  ControlApiPlaytestingCapabilitiesResponse,
  ControlApiPlaytestingRunCancellationResponse,
  ControlApiPlaytestingRunStartedResponse,
  ControlApiPlaytestingRunStatusResponse
} from "@simulatorlife/autodev-core";

import { PlaytestSandboxApprovalError } from "./docker-sandbox.ts";
import {
  PlaytestMcpAuthorizationError,
  type PlaytestMcpSession,
  PlaytestMcpUnavailableError,
  PlaytestMcpValidationError,
  type PlaytestRunCapabilities,
  type PlaytestRunControl,
  type PlaytestRunStatus
} from "./mcp.ts";

const RUNS_PATH = "/control/playtesting/runs";
const CAPABILITIES_PATH = "/control/playtesting/capabilities";
const SESSION_HEADER = "x-autodev-playtest-session";
const ACTOR_PATTERN = /^[A-Za-z0-9@._:+-]{1,128}$/u;
const PLAYTEST_CONTROL_ROLES = new Set([
  "playtester",
  "playtest-analyst",
  "validator"
]);
const MAX_RESPONSE_BYTES = 1_000_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;

export interface PlaytestControlApiRunClientOptions {
  readonly baseUrl: string;
  readonly serviceToken: string;
  readonly actor: string;
  readonly sessionRole: "playtester" | "playtest-analyst" | "validator";
  readonly fetcher?: typeof fetch;
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function loopbackBaseUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new TypeError("Playtesting Control API URL is invalid.");
  }
  const host = url.hostname.toLowerCase();
  if (
    !["http:", "https:"].includes(url.protocol) ||
    !["127.0.0.1", "localhost", "[::1]", "::1"].includes(host) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.pathname !== "/" && url.pathname !== "")
  ) {
    throw new TypeError("Playtesting Control API must use a loopback URL.");
  }
  return url.origin;
}

async function boundedJson(response: Response): Promise<unknown> {
  if (!response.body)
    throw new TypeError("Control API returned an empty response.");
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.byteLength;
    if (size > MAX_RESPONSE_BYTES) {
      throw new TypeError("Control API run response exceeded its size bound.");
    }
    chunks.push(chunk);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
}

function errorForResponse(status: number, value: unknown): Error {
  const details = record(record(value)?.error);
  const code = typeof details?.code === "string" ? details.code : "";
  const message =
    typeof details?.message === "string"
      ? details.message
      : "The Runtime Control API request failed.";
  if (
    status === 403 ||
    code.includes("forbidden") ||
    code.includes("operator_required")
  ) {
    return new PlaytestMcpAuthorizationError(message);
  }
  if (status === 400 || status === 404 || code.includes("invalid_request")) {
    return new PlaytestMcpValidationError(message);
  }
  if (status === 409 || code.includes("approval_changed")) {
    return new PlaytestSandboxApprovalError(message);
  }
  return new PlaytestMcpUnavailableError(message);
}

function assertResponse<T>(
  value: unknown,
  expectedSchema: string,
  workspaceId: string
): T {
  const payload = record(value);
  if (
    !payload ||
    payload.schema !== expectedSchema ||
    payload.workspaceId !== workspaceId
  ) {
    throw new PlaytestMcpUnavailableError(
      "The Runtime Control API returned an incompatible playtest response."
    );
  }
  return payload as T;
}

function sessionHeader(session: PlaytestMcpSession): string {
  return Buffer.from(JSON.stringify(session), "utf8").toString("base64url");
}

/**
 * All run state lives in Runtime's authenticated Control API process. The MCP
 * server forwards only typed operations and its trusted host-bound session;
 * it does not create a second runner, scheduler, budget map, or cancellation
 * registry.
 */
export function createPlaytestControlApiRunClient(
  options: PlaytestControlApiRunClientOptions
): PlaytestRunControl {
  const baseUrl = loopbackBaseUrl(options.baseUrl);
  const token = options.serviceToken.trim();
  const actor = options.actor.trim();
  const sessionRole = options.sessionRole;
  if (
    !token ||
    token.length > 4096 ||
    !ACTOR_PATTERN.test(actor) ||
    !PLAYTEST_CONTROL_ROLES.has(sessionRole)
  ) {
    throw new TypeError("Playtesting Control API credentials are invalid.");
  }
  const fetcher = options.fetcher ?? fetch;

  async function request(
    method: "GET" | "POST",
    path: string,
    session: PlaytestMcpSession,
    body?: unknown,
    waitMs = 0
  ): Promise<unknown> {
    if (session.role !== sessionRole) {
      throw new PlaytestMcpAuthorizationError(
        "The MCP role does not match the scoped Playtesting Control API credential."
      );
    }
    let response: Response;
    try {
      response = await fetcher(new URL(path, baseUrl), {
        method,
        headers: {
          authorization: "Bearer " + token,
          "x-autodev-actor": actor,
          [SESSION_HEADER]: sessionHeader(session),
          ...(body === undefined ? {} : { "content-type": "application/json" })
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(
          Math.max(DEFAULT_REQUEST_TIMEOUT_MS, waitMs + 5000)
        ),
        cache: "no-store"
      });
    } catch {
      throw new PlaytestMcpUnavailableError(
        "The Runtime Playtesting Control API is unavailable."
      );
    }
    let payload: unknown;
    try {
      payload = await boundedJson(response);
    } catch {
      throw new PlaytestMcpUnavailableError(
        "The Runtime Control API response is malformed or oversized."
      );
    }
    if (!response.ok) throw errorForResponse(response.status, payload);
    return payload;
  }

  return {
    async getCapabilities(
      session,
      workspaceId
    ): Promise<PlaytestRunCapabilities> {
      const query = new URLSearchParams({ workspaceId });
      const response =
        assertResponse<ControlApiPlaytestingCapabilitiesResponse>(
          await request("GET", CAPABILITIES_PATH + "?" + query, session),
          "autodev-control-playtesting-capabilities-v1",
          workspaceId
        );
      return response;
    },
    async startRun(session, requestBody) {
      const workspaceId = requestBody.workspaceId ?? session.workspaceId;
      const response = assertResponse<ControlApiPlaytestingRunStartedResponse>(
        await request("POST", RUNS_PATH, session, {
          ...requestBody,
          workspaceId
        }),
        "autodev-control-playtesting-run-started-v1",
        workspaceId
      );
      if (
        response.status !== "running" ||
        typeof response.batchId !== "string"
      ) {
        throw new PlaytestMcpUnavailableError(
          "The Runtime Control API returned an invalid run acknowledgement."
        );
      }
      return { batchId: response.batchId, status: "running" };
    },
    async listActiveRuns(session, workspaceId) {
      const query = new URLSearchParams({ workspaceId });
      const response = assertResponse<ControlApiPlaytestingActiveRunsResponse>(
        await request("GET", RUNS_PATH + "?" + query.toString(), session),
        "autodev-control-playtesting-runs-v1",
        workspaceId
      );
      if (!Array.isArray(response.runs)) {
        throw new PlaytestMcpUnavailableError(
          "The Runtime Control API returned invalid active-run data."
        );
      }
      return response.runs;
    },
    async cancelRun(session, workspaceId, batchId) {
      const query = new URLSearchParams({ workspaceId });
      const response =
        assertResponse<ControlApiPlaytestingRunCancellationResponse>(
          await request(
            "POST",
            RUNS_PATH + "/" + encodeURIComponent(batchId) + "/cancel?" + query,
            session
          ),
          "autodev-control-playtesting-run-cancellation-v1",
          workspaceId
        );
      if (
        response.batchId !== batchId ||
        typeof response.cancellationRequested !== "boolean"
      ) {
        throw new PlaytestMcpUnavailableError(
          "The Runtime Control API returned an invalid cancellation acknowledgement."
        );
      }
      return {
        batchId: response.batchId,
        cancellationRequested: response.cancellationRequested
      };
    },
    async waitForRun(
      session,
      workspaceId,
      batchId,
      waitMs
    ): Promise<PlaytestRunStatus> {
      const query = new URLSearchParams({
        workspaceId,
        waitMs: String(waitMs)
      });
      const response = assertResponse<ControlApiPlaytestingRunStatusResponse>(
        await request(
          "GET",
          RUNS_PATH + "/" + encodeURIComponent(batchId) + "?" + query,
          session,
          undefined,
          waitMs
        ),
        "autodev-control-playtesting-run-status-v1",
        workspaceId
      );
      if (
        response.run.batchId !== batchId ||
        !["running", "persisting", "completed", "failed", "cancelled"].includes(
          response.run.status
        )
      ) {
        throw new PlaytestMcpUnavailableError(
          "The Runtime Control API returned a mismatched run identifier."
        );
      }
      return response.run;
    }
  };
}

/** Build the process client only when the secured local Control API is configured. */
export function playtestControlApiRunClientFromEnvironment(
  env: NodeJS.ProcessEnv = process.env,
  fetcher?: typeof fetch
): PlaytestRunControl {
  const configuredUrl = env.AUTODEV_CONTROL_API_BASE_URL?.trim();
  const host = env.AUTODEV_CONTROL_API_LISTEN_HOST?.trim();
  const port = env.AUTODEV_CONTROL_API_LISTEN_PORT?.trim() || "4101";
  const baseUrl = configuredUrl || (host ? `http://${host}:${port}` : "");
  if (!baseUrl) {
    throw new PlaytestMcpUnavailableError(
      "Configure the private Runtime Control API URL before enabling Playtesting MCP."
    );
  }
  const serviceToken = env.AUTODEV_PLAYTEST_CONTROL_API_TOKEN?.trim() ?? "";
  const actor = env.AUTODEV_PLAYTEST_CONTROL_API_ACTOR?.trim() ?? "";
  const sessionRole = env.AUTODEV_PLAYTEST_CONTROL_API_ROLE?.trim() ?? "";
  const configuredMcpRole = env.AUTODEV_PLAYTEST_ROLE?.trim() ?? "";
  if (
    !serviceToken ||
    !actor ||
    !PLAYTEST_CONTROL_ROLES.has(sessionRole) ||
    configuredMcpRole !== sessionRole
  ) {
    throw new PlaytestMcpUnavailableError(
      "Configure the trusted Playtesting Control API credentials and actor."
    );
  }
  return createPlaytestControlApiRunClient({
    baseUrl,
    serviceToken,
    actor,
    sessionRole:
      sessionRole as PlaytestControlApiRunClientOptions["sessionRole"],
    ...(fetcher === undefined ? {} : { fetcher })
  });
}
