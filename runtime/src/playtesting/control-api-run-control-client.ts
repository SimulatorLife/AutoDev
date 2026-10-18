/** MCP-side client for the single Runtime Control API run owner. */
import {
  assertWorkspaceVisualPlaytestTargetApproval,
  playtestEpisodeRecordId,
  playtestVisualEpisodeRecordId,
  type ControlApiPlaytestingActiveRunsResponse,
  type ControlApiPlaytestingCapabilitiesResponse,
  type ControlApiPlaytestingComparisonDecisionResponse,
  type ControlApiPlaytestingRunCancellationResponse,
  type ControlApiPlaytestingRunRequestLookupResponse,
  type ControlApiPlaytestingRunStartedResponse,
  type ControlApiPlaytestingRunStatusResponse,
  isControlApiPlaytestingRunState,
  type PlaytestSessionReference,
  PLAYTESTS_MAX_CROSS_SESSION_PACKET_SESSIONS
} from "@simulatorlife/autodev-core";

import { PlaytestSandboxApprovalError } from "./docker-sandbox.ts";
import {
  PlaytestMcpAuthorizationError,
  PlaytestMcpConflictError,
  type PlaytestMcpSession,
  PlaytestMcpUnavailableError,
  PlaytestMcpValidationError,
  type PlaytestRunCapabilities,
  type PlaytestRunControl,
  type PlaytestRunStatus
} from "./mcp.ts";

const RUNS_PATH = "/control/playtesting/runs";
const REQUEST_LOOKUP_PATH = RUNS_PATH + "/by-request";
const CAPABILITIES_PATH = "/control/playtesting/capabilities";
const COMPARISONS_PATH = "/control/playtesting/comparisons";
const ANALYSES_PATH = "/control/playtesting/analyses";
const SESSION_HEADER = "x-autodev-playtest-session";
const ACTOR_PATTERN = /^[A-Za-z0-9@._:+-]{1,128}$/u;
const REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/u;
const CAPABILITY_REVISION_PATTERN = /^[a-f\d]{64}$/u;
const ASSIGNMENT_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/u;
const EPISODE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;
const PLAYTEST_CONTROL_ROLES = new Set([
  "playtester",
  "validator",
  "root",
  "operator"
]);
const MAX_RESPONSE_BYTES = 1_000_000;
const MAX_ACTIVE_RUNS = 64;
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;

export interface PlaytestControlApiRunClientOptions {
  readonly baseUrl: string;
  readonly serviceToken: string;
  readonly actor: string;
  readonly sessionRole: "playtester" | "validator" | "root" | "operator";
  readonly fetcher?: typeof fetch;
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * A session list is a 1:1 cover of its assignmentIds with distinct,
 * well-formed episode IDs, so a Console can link every assignment to exactly
 * one deterministic session without guessing or deduplicating.
 */
function parseSessionReferences(
  sessions: unknown
): readonly PlaytestSessionReference[] | null {
  if (!Array.isArray(sessions)) return null;
  const seenAssignments = new Set<string>();
  const seenEpisodes = new Set<string>();
  const parsed: PlaytestSessionReference[] = [];
  for (const entry of sessions) {
    const value = record(entry);
    if (
      !value ||
      typeof value.assignmentId !== "string" ||
      !ASSIGNMENT_ID_PATTERN.test(value.assignmentId) ||
      typeof value.episodeId !== "string" ||
      !EPISODE_ID_PATTERN.test(value.episodeId) ||
      seenAssignments.has(value.assignmentId) ||
      seenEpisodes.has(value.episodeId)
    ) {
      return null;
    }
    seenAssignments.add(value.assignmentId);
    seenEpisodes.add(value.episodeId);
    parsed.push({
      assignmentId: value.assignmentId,
      episodeId: value.episodeId
    });
  }
  return parsed;
}

function validSessionReferences(
  sessions: unknown,
  assignmentIds: readonly string[]
): sessions is readonly PlaytestSessionReference[] {
  const parsed = parseSessionReferences(sessions);
  if (!parsed || parsed.length !== assignmentIds.length) return false;
  const expected = new Set(assignmentIds);
  return (
    expected.size === assignmentIds.length &&
    parsed.every((entry) => expected.has(entry.assignmentId))
  );
}

function sessionReferencesMatchLaunch(
  sessions: readonly PlaytestSessionReference[],
  mode: "adapter-accelerated" | "autonomous-visual" | "scripted-regression",
  batchId: string
): boolean {
  if (mode === "scripted-regression") return false;
  return sessions.every(
    ({ assignmentId, episodeId }) =>
      episodeId ===
      (mode === "autonomous-visual"
        ? playtestVisualEpisodeRecordId(batchId, assignmentId)
        : playtestEpisodeRecordId(batchId, assignmentId))
  );
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
  if (code.includes("capability_revision_changed")) {
    return new PlaytestMcpValidationError(message);
  }
  if (code.includes("request_id_conflict")) {
    return new PlaytestMcpConflictError(message);
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
    /**
     * Forwarded to the Runtime owner rather than computed here, so a Console
     * reading cross-session analysis and an MCP caller reach the same
     * eligibility, cap and receipt decisions.
     */
    async prepareCrossSessionReview(session, workspaceId, episodeIds) {
      if (
        episodeIds.length === 0 ||
        episodeIds.length > PLAYTESTS_MAX_CROSS_SESSION_PACKET_SESSIONS
      ) {
        throw new PlaytestMcpValidationError(
          `Packet preparation requires 1-${String(PLAYTESTS_MAX_CROSS_SESSION_PACKET_SESSIONS)} distinct sessions.`
        );
      }
      const response = await request(
        "POST",
        `${ANALYSES_PATH}?${new URLSearchParams({ workspaceId }).toString()}`,
        session,
        { episodeIds }
      );
      const data = assertResponse<Record<string, unknown>>(
        response,
        "autodev-control-playtesting-analysis-v1",
        workspaceId
      );
      if (
        data.operation !== "prepare" ||
        !Array.isArray(data.packets) ||
        !Array.isArray(data.receipts)
      ) {
        throw new PlaytestMcpUnavailableError(
          "The Runtime Control API returned an invalid analysis response."
        );
      }
      return {
        packets: data.packets as Awaited<
          ReturnType<PlaytestRunControl["prepareCrossSessionReview"]>
        >["packets"],
        receipts: data.receipts as Awaited<
          ReturnType<PlaytestRunControl["prepareCrossSessionReview"]>
        >["receipts"],
        budget: data.budget as Awaited<
          ReturnType<PlaytestRunControl["prepareCrossSessionReview"]>
        >["budget"]
      };
    },
    async recordComparisonDecision(
      session,
      workspaceId,
      comparisonId,
      expectedVersion,
      disposition,
      reason
    ) {
      const response =
        assertResponse<ControlApiPlaytestingComparisonDecisionResponse>(
          await request(
            "POST",
            COMPARISONS_PATH +
              "/" +
              encodeURIComponent(comparisonId) +
              "/decision",
            session,
            {
              workspaceId,
              comparisonId,
              expectedVersion,
              disposition,
              reason
            }
          ),
          "autodev-control-playtesting-comparison-decision-v1",
          workspaceId
        );
      if (
        response.comparison.comparisonId !== comparisonId ||
        response.comparison.version !== expectedVersion + 1 ||
        response.comparison.ownerDecisionBy !== session.actor ||
        response.comparison.ownerDisposition !== disposition ||
        response.comparison.ownerDecisionReason !== reason
      ) {
        throw new PlaytestMcpUnavailableError(
          "The Runtime Control API returned a mismatched comparison-decision acknowledgement."
        );
      }
      return response.comparison;
    },
    async getCapabilities(
      session,
      workspaceId
    ): Promise<PlaytestRunCapabilities> {
      const query = new URLSearchParams({ workspaceId });
      const response =
        assertResponse<ControlApiPlaytestingCapabilitiesResponse>(
          await request("GET", CAPABILITIES_PATH + "?" + query, session),
          "autodev-control-playtesting-capabilities-v3",
          workspaceId
        );
      const modes = record(response.modeReadiness);
      const requiredModes = [
        "adapter-accelerated",
        "autonomous-visual",
        "scripted-regression"
      ] as const;
      if (
        typeof response.capabilityRevision !== "string" ||
        !CAPABILITY_REVISION_PATTERN.test(response.capabilityRevision) ||
        !modes ||
        requiredModes.some((mode) => {
          const readiness = record(modes[mode]);
          return (
            !readiness ||
            (readiness.status !== "ready" &&
              readiness.status !== "check-required" &&
              readiness.status !== "unavailable") ||
            !Array.isArray(readiness.reasons)
          );
        })
      ) {
        throw new PlaytestMcpUnavailableError(
          "The Runtime Control API returned incomplete playtesting mode readiness."
        );
      }
      const visual = record(modes["autonomous-visual"]);
      if (
        !visual ||
        (visual.targetStore !== "available" &&
          visual.targetStore !== "unavailable") ||
        !Array.isArray(visual.targets)
      ) {
        throw new PlaytestMcpUnavailableError(
          "The Runtime Control API returned incomplete visual target readiness."
        );
      }
      const targetIds = new Set<string>();
      for (const targetReadiness of visual.targets) {
        const entry = record(targetReadiness);
        const target = entry?.target;
        try {
          assertWorkspaceVisualPlaytestTargetApproval(target);
        } catch {
          throw new PlaytestMcpUnavailableError(
            "The Runtime Control API returned malformed visual target readiness."
          );
        }
        if (
          !entry ||
          target.workspaceId !== workspaceId ||
          target.revokedAt !== null ||
          targetIds.has(target.targetId) ||
          (entry.eligibility !== "supported" &&
            entry.eligibility !== "unsupported") ||
          !Array.isArray(entry.reasons)
        ) {
          throw new PlaytestMcpUnavailableError(
            "The Runtime Control API returned mismatched visual target readiness."
          );
        }
        targetIds.add(target.targetId);
      }
      return response;
    },
    async startRun(session, requestBody) {
      const workspaceId = requestBody.workspaceId;
      const response = assertResponse<ControlApiPlaytestingRunStartedResponse>(
        await request("POST", RUNS_PATH, session, requestBody),
        "autodev-control-playtesting-run-started-v3",
        workspaceId
      );
      if (
        ![
          "running",
          "persisting",
          "completed",
          "failed",
          "cancelled",
          "truncated"
        ].includes(response.status) ||
        typeof response.batchId !== "string" ||
        !Number.isSafeInteger(response.assignmentCount) ||
        response.assignmentCount < 1 ||
        !Array.isArray(response.assignmentIds) ||
        response.assignmentIds.length !== response.assignmentCount ||
        new Set(response.assignmentIds).size !==
          response.assignmentIds.length ||
        !response.assignmentIds.every((id) => ASSIGNMENT_ID_PATTERN.test(id)) ||
        !validSessionReferences(response.sessions, response.assignmentIds) ||
        !sessionReferencesMatchLaunch(
          response.sessions,
          requestBody.mode,
          response.batchId
        ) ||
        typeof response.createdAt !== "string" ||
        !Number.isFinite(Date.parse(response.createdAt))
      ) {
        throw new PlaytestMcpUnavailableError(
          "The Runtime Control API returned an invalid batch acknowledgement."
        );
      }
      return {
        batchId: response.batchId,
        assignmentCount: response.assignmentCount,
        assignmentIds: response.assignmentIds,
        sessions: response.sessions,
        createdAt: response.createdAt,
        status: response.status
      };
    },
    async lookupRunByRequest(session, workspaceId, requestId) {
      if (!REQUEST_ID_PATTERN.test(requestId)) {
        throw new PlaytestMcpValidationError("requestId is invalid.");
      }
      const query = new URLSearchParams({ workspaceId, requestId });
      const response =
        assertResponse<ControlApiPlaytestingRunRequestLookupResponse>(
          await request("GET", REQUEST_LOOKUP_PATH + "?" + query, session),
          "autodev-control-playtesting-run-request-v2",
          workspaceId
        );
      if (
        response.requestId !== requestId ||
        !["not-found", "expired", "pending", "accepted"].includes(
          response.state
        ) ||
        !Array.isArray(response.assignmentIds) ||
        response.assignmentIds.some(
          (id) => typeof id !== "string" || !ASSIGNMENT_ID_PATTERN.test(id)
        ) ||
        !validSessionReferences(response.sessions, response.assignmentIds)
      ) {
        throw new PlaytestMcpUnavailableError(
          "The Runtime Control API returned an invalid request-recovery receipt."
        );
      }
      if (response.state === "accepted") {
        if (
          typeof response.batchId !== "string" ||
          !Number.isSafeInteger(response.assignmentCount) ||
          typeof response.assignmentCount !== "number" ||
          response.assignmentCount < 1 ||
          response.assignmentIds.length !== response.assignmentCount ||
          !isControlApiPlaytestingRunState(response.status) ||
          typeof response.createdAt !== "string" ||
          !Number.isFinite(Date.parse(response.createdAt))
        ) {
          throw new PlaytestMcpUnavailableError(
            "The Runtime Control API returned an incomplete accepted request receipt."
          );
        }
      } else if (response.state === "pending") {
        if (
          typeof response.batchId !== "string" ||
          !Number.isSafeInteger(response.assignmentCount) ||
          typeof response.assignmentCount !== "number" ||
          response.assignmentCount < 1 ||
          response.assignmentIds.length > 0 ||
          response.status !== null ||
          typeof response.createdAt !== "string" ||
          !Number.isFinite(Date.parse(response.createdAt))
        ) {
          throw new PlaytestMcpUnavailableError(
            "The Runtime Control API returned an incomplete pending request receipt."
          );
        }
      } else if (
        response.batchId !== null ||
        response.assignmentCount !== null ||
        response.assignmentIds.length > 0 ||
        response.createdAt !== null ||
        response.status !== null
      ) {
        throw new PlaytestMcpUnavailableError(
          "The Runtime Control API returned an inconsistent empty request receipt."
        );
      }
      return response;
    },
    async listActiveRuns(session, workspaceId) {
      const query = new URLSearchParams({ workspaceId });
      const response = assertResponse<ControlApiPlaytestingActiveRunsResponse>(
        await request("GET", RUNS_PATH + "?" + query.toString(), session),
        "autodev-control-playtesting-runs-v2",
        workspaceId
      );
      if (
        !Array.isArray(response.runs) ||
        response.runs.length > MAX_ACTIVE_RUNS ||
        // Every entry now drives live progress rendering, so one malformed
        // status record fails the whole read rather than a partial view.
        !response.runs.every(
          (run) =>
            typeof run.batchId === "string" &&
            run.batchId.length > 0 &&
            typeof run.assignmentCount === "number" &&
            Number.isSafeInteger(run.assignmentCount) &&
            run.assignmentCount > 0 &&
            typeof run.createdAt === "string" &&
            Array.isArray(run.sessions) &&
            run.sessions.length === run.assignmentCount &&
            parseSessionReferences(run.sessions) !== null &&
            record(run.status) !== null &&
            typeof run.status.status === "string"
        )
      ) {
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
            session,
            { expectedStatus: "running" }
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
): PlaytestRunControl | null {
  const sessionRole = env.AUTODEV_PLAYTEST_CONTROL_API_ROLE?.trim() ?? "";
  const configuredMcpRole = env.AUTODEV_PLAYTEST_ROLE?.trim() ?? "";
  if (configuredMcpRole === "playtest-analyst") {
    if (sessionRole && sessionRole !== configuredMcpRole) {
      throw new PlaytestMcpUnavailableError(
        "The configured Playtesting MCP role does not match its Control API session role."
      );
    }
    return null;
  }
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
