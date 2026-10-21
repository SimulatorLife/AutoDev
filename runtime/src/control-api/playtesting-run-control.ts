import { createHash } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

import {
  canonicalPlaytestJson,
  CONTROL_API_PLAYTESTING_RUN_STATES,
  type ControlApiPlaytestingActiveRunsResponse,
  type ControlApiPlaytestingAnalysesResponse,
  type ControlApiPlaytestingCancellationReason,
  type ControlApiPlaytestingCapabilitiesResponse,
  type ControlApiPlaytestingCapabilityReason,
  type ControlApiPlaytestingPolicyReadiness,
  type ControlApiPlaytestingComparisonDecisionRequest,
  type ControlApiPlaytestingComparisonDecisionResponse,
  type ControlApiPlaytestingModeReadiness,
  type ControlApiPlaytestingRunCancellationResponse,
  type ControlApiPlaytestingRunRecord,
  type ControlApiPlaytestingRunRequestLookupResponse,
  type ControlApiPlaytestingRunStartedResponse,
  type ControlApiPlaytestingRunStatusResponse,
  type PlaytestVisualPolicyId,
  type ControlApiPlaytestingVisualTargetReadiness,
  type PlaytestJsonValue,
  PLAYTESTS_MAX_ANALYSIS_SESSIONS,
  PLAYTESTS_MAX_CROSS_SESSION_PACKET_SESSIONS
} from "@simulatorlife/autodev-core";
import { ConfigRepository } from "@simulatorlife/autodev-data";
import { PlaytestSourceUnavailableError } from "@simulatorlife/autodev-data/playtesting";
import { WorkspaceVisualPlaytestTargetRepository } from "@simulatorlife/autodev-data/workspaces";
import { z } from "zod/v4";

import {
  PlaytestSandboxApprovalError,
  PlaytestSandboxUnavailableError
} from "../playtesting/docker-sandbox.ts";
import { playtestLaunchRequestSchema } from "../playtesting/launch-request-schema.ts";
import { isOneJevLocalVisualPolicyAvailable } from "../playtesting/onejev-local-policy.ts";
import { isSmartDirectVisualPolicyAvailable } from "../playtesting/smart-direct-policy.ts";
import { isPlaytestVisualBrowserDriverAvailable } from "../playtesting/visual-browser-driver.ts";
import {
  type PlaytestAnalystReviewDispatch,
  PlaytestMcpAuthorizationError,
  PlaytestMcpConflictError,
  type PlaytestMcpSession,
  PlaytestMcpUnavailableError,
  PlaytestMcpValidationError,
  type PlaytestRunControl
} from "../playtesting/mcp.ts";
import { errorBody, sendJson } from "../router/proxy.ts";
import { writeErrorLine } from "../shared/output.ts";
import { readControlApiJsonObject } from "./body.ts";

const RUNS_PATH = "/control/playtesting/runs";
const REQUEST_LOOKUP_PATH = RUNS_PATH + "/by-request";
const ANALYSES_PATH = "/control/playtesting/analyses";

/**
 * Bounded, explicit selection. The workspace is not in the body: the query
 * string is its single authority, so the two can never disagree.
 */
const analysisRequestSchema = z
  .strictObject({
    episodeIds: z
      .array(z.string().min(1).max(256))
      .min(1)
      .max(PLAYTESTS_MAX_ANALYSIS_SESSIONS),
    operation: z.enum(["prepare", "dispatch"]).optional()
  })
  .superRefine((value, context) => {
    const selectionLimit =
      value.operation === "dispatch"
        ? PLAYTESTS_MAX_ANALYSIS_SESSIONS
        : PLAYTESTS_MAX_CROSS_SESSION_PACKET_SESSIONS;
    if (value.episodeIds.length > selectionLimit) {
      context.addIssue({
        code: "custom",
        message: `This operation accepts at most ${String(selectionLimit)} selected sessions.`,
        path: ["episodeIds"]
      });
    }
    if (new Set(value.episodeIds).size !== value.episodeIds.length) {
      context.addIssue({
        code: "custom",
        message: "Selected sessions must be distinct.",
        path: ["episodeIds"]
      });
    }
  });
const CAPABILITIES_PATH = "/control/playtesting/capabilities";
const WAIT_MILLISECONDS_PATTERN = /^(0|[1-9][0-9]{0,4})$/u;
const RUN_ROUTE = /^\/control\/playtesting\/runs\/([^/]+)$/u;
const CANCEL_ROUTE = /^\/control\/playtesting\/runs\/([^/]+)\/cancel$/u;
const COMPARISON_DECISION_ROUTE =
  /^\/control\/playtesting\/comparisons\/([^/]+)\/decision$/u;
const WORKSPACE_ID_PATTERN = /^[^/\\\s]+\/[^/\\\s]+$/u;
const BATCH_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/u;
const REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/u;
const RUN_STATES = new Set<string>(CONTROL_API_PLAYTESTING_RUN_STATES);
const CANCELLATION_REASONS = new Set<ControlApiPlaytestingCancellationReason>([
  "cancelled",
  "approval-revoked",
  "workspace-disabled"
]);

const cancellationRequestSchema = z.strictObject({
  expectedStatus: z.literal("running")
});
const comparisonDecisionRequestSchema = z.strictObject({
  workspaceId: z.string().regex(WORKSPACE_ID_PATTERN),
  comparisonId: z.string().regex(BATCH_ID_PATTERN),
  expectedVersion: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  disposition: z.enum(["promote", "hold"]),
  reason: z.string().min(1).max(4000)
});
const PROCESS_SESSION_HEADER = "x-autodev-playtest-session";
const BASE64URL_HEADER_PATTERN = /^[A-Za-z0-9_-]+$/u;
const processSessionSchema = z.strictObject({
  workspaceId: z.string().regex(WORKSPACE_ID_PATTERN),
  role: z.enum([
    "playtester",
    "validator",
    "root",
    "orchestrator",
    "operator",
    "control-viewer"
  ]),
  actor: z.string().regex(/^[A-Za-z0-9@._:-]{1,256}$/u),
  taskId: z
    .string()
    .regex(/^[A-Za-z0-9@._:-]{1,256}$/u)
    .optional(),
  runId: z
    .string()
    .regex(/^[A-Za-z0-9@._:-]{1,256}$/u)
    .optional()
});

export interface PlaytestingRunControlActor {
  readonly actor: string;
  readonly role: "viewer" | "operator";
}

export interface PlaytestingRunControlApiOptions {
  readonly repositoryRoot?: string;
  readonly visualTargetRepository?: Pick<
    WorkspaceVisualPlaytestTargetRepository,
    "list"
  >;
  /**
   * The probes that decide whether the visual browser driver and the
   * Smart-direct route are reachable. They read the machine by default; a
   * caller that owns its own environment pins them so the mode's readiness
   * is a property of the caller rather than of the host it runs on.
   */
  readonly visualReadinessProbes?: {
    readonly visualDriverAvailable?: () => boolean;
    readonly smartDirectPolicyAvailable?: () => Promise<boolean>;
    /** Whether the operator's own local OneJev server is reachable. */
    readonly oneJevLocalPolicyAvailable?: () => Promise<boolean>;
  };
  readonly readWorkspaceCatalog?: () => ReturnType<
    ConfigRepository["readWorkspaceCatalog"]
  >;
  /** The same Runtime run owner used by MCP; this route owns no scheduler. */
  readonly runControl?: PlaytestRunControl &
    Partial<PlaytestAnalystReviewDispatch>;
  readonly requireSessionHeader?: boolean;
  readonly trustedSessionRole?: string;
  readonly audit?: (event: {
    readonly actor: string;
    readonly action:
      | "start_playtest_run"
      | "cancel_playtest_run"
      | "record_playtest_comparison_decision"
      | "request_playtest_analysis";
    readonly workspaceId: string;
    readonly outcome: "ok" | "denied" | "error";
    readonly changes: Readonly<Record<string, unknown>> | null;
    readonly reason?: string;
  }) => void;
}

function sendError(
  response: ServerResponse,
  status: number,
  code: string,
  message: string
): void {
  sendJson(
    response,
    status,
    errorBody(message, "autodev_control_playtesting_run_error", { code }),
    { "cache-control": "no-store" }
  );
}

function queryValues(
  request: IncomingMessage,
  pathname: string,
  permitted: readonly string[]
): URLSearchParams | null {
  const params = new URL(request.url ?? pathname, "http://127.0.0.1")
    .searchParams;
  for (const key of params.keys()) {
    if (!permitted.includes(key)) return null;
  }
  for (const key of permitted) {
    const values = params.getAll(key);
    if (values.length > 1) return null;
    const value = values[0];
    if (
      value !== undefined &&
      (value.length === 0 || value.length > 256 || hasControlCharacters(value))
    )
      return null;
  }
  return params;
}

function sessionFor(
  request: IncomingMessage,
  actor: PlaytestingRunControlActor,
  workspaceId: string,
  response: ServerResponse,
  requireSessionHeader: boolean,
  trustedSessionRole: string | undefined
): PlaytestMcpSession | null {
  const rawHeader = request.headers[PROCESS_SESSION_HEADER];
  if (rawHeader === undefined) {
    if (requireSessionHeader) {
      sendError(
        response,
        401,
        "autodev_control_playtesting_session_required",
        "The scoped Playtesting credential requires its bound Runtime session."
      );
      return null;
    }
    const identity = createHash("sha256").update(actor.actor).digest("hex");
    return {
      workspaceId,
      role: actor.role === "operator" ? "operator" : "control-viewer",
      actor: "control-api:" + identity
    };
  }
  if (
    Array.isArray(rawHeader) ||
    rawHeader.length === 0 ||
    rawHeader.length > 2048 ||
    !BASE64URL_HEADER_PATTERN.test(rawHeader)
  ) {
    sendError(
      response,
      400,
      "autodev_control_playtesting_invalid_session",
      "The trusted playtest session context is malformed."
    );
    return null;
  }
  let parsedJson: unknown;
  try {
    const bytes = Buffer.from(rawHeader, "base64url");
    if (bytes.toString("base64url") !== rawHeader)
      throw new TypeError("non-canonical session");
    parsedJson = JSON.parse(bytes.toString("utf8"));
  } catch {
    sendError(
      response,
      400,
      "autodev_control_playtesting_invalid_session",
      "The trusted playtest session context is malformed."
    );
    return null;
  }
  const parsed = processSessionSchema.safeParse(parsedJson);
  if (!parsed.success) {
    sendError(
      response,
      400,
      "autodev_control_playtesting_invalid_session",
      "The trusted playtest session context is invalid."
    );
    return null;
  }
  const session = parsed.data;
  if (requireSessionHeader && session.role !== trustedSessionRole) {
    sendError(
      response,
      403,
      "autodev_control_playtesting_forbidden",
      "The Runtime session role does not match the scoped Playtesting credential."
    );
    return null;
  }
  if (actor.role === "viewer" && session.actor !== actor.actor) {
    sendError(
      response,
      403,
      "autodev_control_playtesting_forbidden",
      "The trusted playtest session actor does not match the authenticated Control API actor."
    );
    return null;
  }
  if (
    (session.workspaceId !== workspaceId &&
      session.role !== "root" &&
      session.role !== "orchestrator" &&
      session.role !== "operator") ||
    (actor.role === "viewer" && session.role !== "control-viewer")
  ) {
    sendError(
      response,
      403,
      "autodev_control_playtesting_forbidden",
      "The trusted playtest session is not authorized for this workspace."
    );
    return null;
  }
  return {
    workspaceId: session.workspaceId,
    role: session.role,
    actor: session.actor,
    ...(session.taskId === undefined ? {} : { taskId: session.taskId }),
    ...(session.runId === undefined ? {} : { runId: session.runId })
  };
}

function catalogRead(
  options: PlaytestingRunControlApiOptions
): ReturnType<ConfigRepository["readWorkspaceCatalog"]> {
  return (
    options.readWorkspaceCatalog ??
    (() => new ConfigRepository(options.repositoryRoot).readWorkspaceCatalog())
  )();
}

function workspaceError(
  workspaceId: string,
  options: PlaytestingRunControlApiOptions
): {
  readonly status: number;
  readonly code: string;
  readonly message: string;
} | null {
  const catalog = catalogRead(options);
  if (catalog.status !== "valid") {
    return {
      status: 503,
      code: "autodev_control_playtesting_workspace_catalog_unavailable",
      message: "The canonical workspace catalog is unavailable."
    };
  }
  if (!catalog.workspaces.some((workspace) => workspace.id === workspaceId)) {
    return {
      status: 404,
      code: "autodev_control_playtesting_workspace_not_found",
      message: "The requested workspace is not registered."
    };
  }
  return null;
}

function serializeJsonValue(value: unknown): PlaytestJsonValue {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new TypeError("Run result is not JSON.");
  return JSON.parse(serialized) as PlaytestJsonValue;
}

function statusRecord(
  status: Awaited<ReturnType<PlaytestRunControl["waitForRun"]>>
): ControlApiPlaytestingRunRecord {
  if (!RUN_STATES.has(status.status)) {
    throw new TypeError("Run owner returned an unsupported state.");
  }
  const cancellationReason = status.cancellationReason;
  if (
    cancellationReason !== null &&
    !CANCELLATION_REASONS.has(cancellationReason)
  ) {
    throw new TypeError(
      "Run owner returned an unsupported cancellation reason."
    );
  }
  return {
    batchId: status.batchId,
    status: status.status,
    cancellationReason,
    result: status.result === null ? null : serializeJsonValue(status.result),
    error: status.error
  };
}

function pathId(pathname: string, pattern: RegExp): string | null {
  const match = pathname.match(pattern);
  if (!match) return null;
  let value: string;
  try {
    value = decodeURIComponent(match[1]!);
  } catch {
    return null;
  }
  return BATCH_ID_PATTERN.test(value) ? value : null;
}

/**
 * Cross-session packet preparation over an explicit selection. Every rule —
 * eligibility, the per-batch critique cap, and which selected sessions
 * produced no packet — belongs to the Runtime owner; this route only
 * authorizes and forwards.
 */
async function listAnalystReviewRuns(
  request: IncomingMessage,
  response: ServerResponse,
  pathname: string,
  actor: PlaytestingRunControlActor,
  options: PlaytestingRunControlApiOptions,
  runControl: PlaytestRunControl & Partial<PlaytestAnalystReviewDispatch>
): Promise<void> {
  const query = workspaceQuery(
    request,
    pathname,
    ["workspaceId"],
    options,
    response
  );
  if (!query) return;
  const session = sessionFor(
    request,
    actor,
    query.workspaceId,
    response,
    options.requireSessionHeader ?? false,
    options.trustedSessionRole
  );
  if (!session) return;
  if (!runControl.listAnalystReviewRuns) {
    sendError(
      response,
      503,
      "autodev_control_playtesting_unavailable",
      "Runtime analyst review status is not available."
    );
    return;
  }
  try {
    const status = await runControl.listAnalystReviewRuns(
      session,
      query.workspaceId
    );
    sendJson(
      response,
      200,
      {
        schema: "autodev-control-playtesting-analyses-v1",
        workspaceId: query.workspaceId,
        runs: status.runs,
        syntheses: status.syntheses
      } satisfies ControlApiPlaytestingAnalysesResponse,
      { "cache-control": "no-store" }
    );
  } catch (error) {
    recordRunError(
      response,
      error,
      options,
      actor,
      "request_playtest_analysis",
      query.workspaceId
    );
  }
}

async function requestCrossSessionReview(
  request: IncomingMessage,
  response: ServerResponse,
  pathname: string,
  actor: PlaytestingRunControlActor,
  options: PlaytestingRunControlApiOptions,
  runControl: PlaytestRunControl & Partial<PlaytestAnalystReviewDispatch>
): Promise<void> {
  const query = workspaceQuery(
    request,
    pathname,
    ["workspaceId"],
    options,
    response
  );
  if (!query) return;
  const session = sessionFor(
    request,
    actor,
    query.workspaceId,
    response,
    options.requireSessionHeader ?? false,
    options.trustedSessionRole
  );
  if (!session) return;
  const parsedBody = await readControlApiJsonObject(request);
  if (!parsedBody.ok) {
    sendError(
      response,
      parsedBody.status,
      "autodev_control_playtesting_invalid_request",
      parsedBody.message
    );
    return;
  }
  const parsed = analysisRequestSchema.safeParse(parsedBody.body);
  if (!parsed.success) {
    sendError(
      response,
      400,
      "autodev_control_playtesting_invalid_request",
      `${parsedBody.body.operation === "dispatch" ? "Analyst dispatch" : "Packet preparation"} requires 1-${String(
        parsedBody.body.operation === "dispatch"
          ? PLAYTESTS_MAX_ANALYSIS_SESSIONS
          : PLAYTESTS_MAX_CROSS_SESSION_PACKET_SESSIONS
      )} distinct sessions.`
    );
    return;
  }
  try {
    const dispatch = parsed.data.operation === "dispatch";
    if (dispatch) {
      if (actor.role !== "operator") {
        sendError(
          response,
          403,
          "autodev_control_playtesting_operator_required",
          "Dispatching a playtest analyst requires an authorized operator."
        );
        return;
      }
      if (!runControl.dispatchCrossSessionReview) {
        sendError(
          response,
          503,
          "autodev_control_playtesting_unavailable",
          "Runtime analyst dispatch is not available."
        );
        return;
      }
      const result = await runControl.dispatchCrossSessionReview(
        session,
        query.workspaceId,
        parsed.data.episodeIds
      );
      sendJson(
        response,
        202,
        {
          schema: "autodev-control-playtesting-analysis-v1",
          operation: "dispatch",
          workspaceId: query.workspaceId,
          requested: parsed.data.episodeIds.length,
          packets: result.packets.map((packet) => ({
            episodeId: packet.episodeId,
            batchId: packet.batchId,
            packetId: packet.packet.packetId
          })),
          receipts: result.receipts,
          budget: result.budget,
          analysis: result.run
        },
        { "cache-control": "no-store" }
      );
      return;
    }
    const result = await runControl.prepareCrossSessionReview(
      session,
      query.workspaceId,
      parsed.data.episodeIds
    );
    sendJson(
      response,
      200,
      {
        schema: "autodev-control-playtesting-analysis-v1",
        operation: "prepare",
        workspaceId: query.workspaceId,
        requested: parsed.data.episodeIds.length,
        packets: result.packets,
        receipts: result.receipts,
        budget: result.budget,
        analysis: null
      },
      { "cache-control": "no-store" }
    );
  } catch (error) {
    recordRunError(
      response,
      error,
      options,
      actor,
      "request_playtest_analysis",
      query.workspaceId
    );
  }
}

async function handleAnalystReviewMethod(
  method: string,
  request: IncomingMessage,
  response: ServerResponse,
  pathname: string,
  actor: PlaytestingRunControlActor,
  options: PlaytestingRunControlApiOptions,
  runControl: PlaytestRunControl & Partial<PlaytestAnalystReviewDispatch>
): Promise<void> {
  if (method === "POST") {
    await requestCrossSessionReview(
      request,
      response,
      pathname,
      actor,
      options,
      runControl
    );
    return;
  }
  if (method === "GET") {
    await listAnalystReviewRuns(
      request,
      response,
      pathname,
      actor,
      options,
      runControl
    );
    return;
  }
  sendMethodNotAllowed(response, "GET, POST");
}

function sendMethodNotAllowed(response: ServerResponse, allow: string): void {
  response.setHeader("allow", allow);
  sendError(
    response,
    405,
    "autodev_control_playtesting_method_not_allowed",
    "The requested playtest run operation does not support this method."
  );
}

function hasControlCharacters(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code <= 31 || code === 127) return true;
  }
  return false;
}

function workspaceQuery(
  request: IncomingMessage,
  pathname: string,
  permitted: readonly string[],
  options: PlaytestingRunControlApiOptions,
  response: ServerResponse
): { readonly workspaceId: string; readonly params: URLSearchParams } | null {
  const params = queryValues(request, pathname, permitted);
  const workspaceId = params?.get("workspaceId") ?? "";
  if (!params || !WORKSPACE_ID_PATTERN.test(workspaceId)) {
    sendError(
      response,
      400,
      "autodev_control_playtesting_invalid_request",
      "A single valid workspaceId is required."
    );
    return null;
  }
  const unavailable = workspaceError(workspaceId, options);
  if (unavailable) {
    sendError(
      response,
      unavailable.status,
      unavailable.code,
      unavailable.message
    );
    return null;
  }
  return { workspaceId, params };
}

function recordAudit(
  options: PlaytestingRunControlApiOptions,
  actor: PlaytestingRunControlActor,
  action:
    | "start_playtest_run"
    | "cancel_playtest_run"
    | "record_playtest_comparison_decision"
    | "request_playtest_analysis"
    | undefined,
  workspaceId: string,
  outcome: "ok" | "denied" | "error",
  changes: Readonly<Record<string, unknown>> | null,
  reason?: string
): void {
  if (!action) return;
  options.audit?.({
    actor: actor.actor,
    action,
    workspaceId,
    outcome,
    changes,
    ...(reason ? { reason } : {})
  });
}

function sendStartedRunReceipt(
  response: ServerResponse,
  options: PlaytestingRunControlApiOptions,
  actor: PlaytestingRunControlActor,
  workspaceId: string,
  started: Awaited<ReturnType<PlaytestRunControl["startRun"]>>
): void {
  const body: ControlApiPlaytestingRunStartedResponse = {
    schema: "autodev-control-playtesting-run-started-v3",
    workspaceId,
    ...started
  };
  recordAudit(options, actor, "start_playtest_run", workspaceId, "ok", {
    batchId: started.batchId,
    assignmentCount: started.assignmentCount,
    createdAt: started.createdAt
  });
  sendJson(response, 202, body, { "cache-control": "no-store" });
}

async function startRun(
  request: IncomingMessage,
  response: ServerResponse,
  actor: PlaytestingRunControlActor,
  options: PlaytestingRunControlApiOptions,
  runControl: PlaytestRunControl
): Promise<void> {
  if (actor.role !== "operator") {
    sendError(
      response,
      403,
      "autodev_control_playtesting_operator_required",
      "Starting a playtest requires an authorized operator."
    );
    return;
  }
  const parsedBody = await readControlApiJsonObject(request);
  if (!parsedBody.ok) {
    sendError(response, parsedBody.status, parsedBody.code, parsedBody.message);
    return;
  }
  const parsed = playtestLaunchRequestSchema.safeParse(parsedBody.body);
  if (!parsed.success) {
    sendError(
      response,
      400,
      "autodev_control_playtesting_invalid_request",
      "The typed playtest run request is invalid."
    );
    return;
  }
  const workspaceId = parsed.data.workspaceId;
  const unavailable = workspaceError(workspaceId, options);
  if (unavailable) {
    sendError(
      response,
      unavailable.status,
      unavailable.code,
      unavailable.message
    );
    return;
  }
  const session = sessionFor(
    request,
    actor,
    workspaceId,
    response,
    options.requireSessionHeader ?? false,
    options.trustedSessionRole
  );
  if (!session) return;
  try {
    const priorRequest = await runControl.lookupRunByRequest(
      session,
      workspaceId,
      parsed.data.requestId
    );
    if (priorRequest.state === "accepted" || priorRequest.state === "expired") {
      const priorReceipt = await runControl.startRun(session, parsed.data);
      sendStartedRunReceipt(
        response,
        options,
        actor,
        workspaceId,
        priorReceipt
      );
      return;
    }
    const preflight = await capabilitiesForLaunchRequest({
      session,
      actor,
      workspaceId,
      options,
      runControl
    });
    if (parsed.data.capabilityRevision !== preflight.capabilityRevision) {
      recordAudit(
        options,
        actor,
        "start_playtest_run",
        workspaceId,
        "denied",
        { mode: parsed.data.mode },
        "capability-revision-changed"
      );
      sendError(
        response,
        409,
        "autodev_control_playtesting_capability_revision_changed",
        "Playtesting readiness changed after preflight. Refresh capabilities and review the updated run options before starting."
      );
      return;
    }
    const modeReadiness = preflight.modeReadiness[parsed.data.mode];
    if (modeReadiness.status !== "ready") {
      const firstReason = modeReadiness.reasons[0];
      const message = modeReadiness.reasons
        .map((reason) => reason.message)
        .join(" ");
      recordAudit(
        options,
        actor,
        "start_playtest_run",
        workspaceId,
        "denied",
        { mode: parsed.data.mode, readiness: modeReadiness.status },
        firstReason?.code ?? "mode-not-ready"
      );
      sendError(
        response,
        modeReadiness.status === "unavailable" ? 503 : 409,
        "autodev_control_playtesting_preflight_not_ready",
        message
      );
      return;
    }
    const started = await runControl.startRun(session, parsed.data);
    sendStartedRunReceipt(response, options, actor, workspaceId, started);
  } catch (error) {
    recordRunError(
      response,
      error,
      options,
      actor,
      "start_playtest_run",
      workspaceId
    );
  }
}

async function comparisonDecisionRequest(
  request: IncomingMessage,
  response: ServerResponse,
  comparisonId: string
): Promise<ControlApiPlaytestingComparisonDecisionRequest | null> {
  const body = await readControlApiJsonObject(request);
  if (!body.ok) {
    sendError(response, body.status, body.code, body.message);
    return null;
  }
  const parsed = comparisonDecisionRequestSchema.safeParse(body.body);
  if (!parsed.success || parsed.data.comparisonId !== comparisonId) {
    sendError(
      response,
      400,
      "autodev_control_playtesting_invalid_request",
      "The typed comparison decision request is invalid or does not match its path."
    );
    return null;
  }
  return parsed.data;
}

async function decideComparison(
  request: IncomingMessage,
  response: ServerResponse,
  comparisonId: string,
  actor: PlaytestingRunControlActor,
  options: PlaytestingRunControlApiOptions,
  runControl: PlaytestRunControl
): Promise<void> {
  if (actor.role !== "operator") {
    recordAudit(
      options,
      actor,
      "record_playtest_comparison_decision",
      "unknown/unknown",
      "denied",
      null,
      "operator_required"
    );
    sendError(
      response,
      403,
      "autodev_control_playtesting_operator_required",
      "Recording a comparison owner decision requires an authorized operator."
    );
    return;
  }
  const decision = await comparisonDecisionRequest(
    request,
    response,
    comparisonId
  );
  if (!decision) return;
  const { workspaceId, expectedVersion, disposition, reason } = decision;
  const unavailable = workspaceError(workspaceId, options);
  if (unavailable) {
    sendError(
      response,
      unavailable.status,
      unavailable.code,
      unavailable.message
    );
    return;
  }
  const session = sessionFor(
    request,
    actor,
    workspaceId,
    response,
    options.requireSessionHeader ?? false,
    options.trustedSessionRole
  );
  if (!session) return;
  try {
    const comparison = await runControl.recordComparisonDecision(
      session,
      workspaceId,
      comparisonId,
      expectedVersion,
      disposition,
      reason
    );
    const body: ControlApiPlaytestingComparisonDecisionResponse = {
      schema: "autodev-control-playtesting-comparison-decision-v1",
      workspaceId,
      comparison
    };
    recordAudit(
      options,
      actor,
      "record_playtest_comparison_decision",
      workspaceId,
      "ok",
      {
        comparisonId,
        version: comparison.version,
        disposition: comparison.ownerDisposition,
        decisionBy: comparison.ownerDecisionBy
      }
    );
    sendJson(response, 200, body, { "cache-control": "no-store" });
  } catch (error) {
    recordRunError(
      response,
      error,
      options,
      actor,
      "record_playtest_comparison_decision",
      workspaceId
    );
  }
}

type CapabilityReasonSeverity = "check-required" | "unavailable";
const CHECK_REQUIRED_STATUS = "check-required" as const;
const UNAVAILABLE_STATUS = "unavailable" as const;
const READY_STATUS = "ready" as const;
const OPERATOR_REQUIRED_REASON: ControlApiPlaytestingCapabilityReason = {
  code: "operator-required",
  label: "Operator required",
  message: "An authorized operator can start or cancel playtest runs.",
  severity: CHECK_REQUIRED_STATUS
};
type VisualTargetApproval = ReturnType<
  WorkspaceVisualPlaytestTargetRepository["list"]
>[number];

function readinessFromReasons(
  reasons: readonly ControlApiPlaytestingCapabilityReason[]
): ControlApiPlaytestingModeReadiness {
  const status = reasons.some(
    (reason) => reason.severity === UNAVAILABLE_STATUS
  )
    ? UNAVAILABLE_STATUS
    : reasons.length > 0
      ? CHECK_REQUIRED_STATUS
      : READY_STATUS;
  return { status, reasons };
}

function addCapabilityReason(
  reasons: ControlApiPlaytestingCapabilityReason[],
  input: {
    readonly code: string;
    readonly label: string;
    readonly message: string;
    readonly severity: CapabilityReasonSeverity;
  }
): void {
  if (!reasons.some((reason) => reason.code === input.code)) {
    reasons.push(input);
  }
}

function adapterModeReadiness(
  capabilities: Awaited<ReturnType<PlaytestRunControl["getCapabilities"]>>,
  operatorActionsAvailable: boolean
): ControlApiPlaytestingModeReadiness {
  const reasons: ControlApiPlaytestingCapabilityReason[] = [];
  if (!operatorActionsAvailable) {
    addCapabilityReason(reasons, OPERATOR_REQUIRED_REASON);
  }
  if (capabilities.workspaceCatalog !== "valid") {
    addCapabilityReason(reasons, {
      code: "workspace-catalog-unavailable",
      label: "Workspace catalog unavailable",
      message: "Runtime could not verify the canonical workspace catalog.",
      severity: UNAVAILABLE_STATUS
    });
  }
  if (!capabilities.workspaceEnabled) {
    addCapabilityReason(reasons, {
      code: "workspace-disabled",
      label: "Workspace disabled",
      message: "Enable this workspace before starting an adapter run.",
      severity: UNAVAILABLE_STATUS
    });
  }
  if (!capabilities.approved) {
    addCapabilityReason(reasons, {
      code: "adapter-approval-required",
      label: "Approval required",
      message:
        "Workspaces must approve the checkout and adapter before an adapter run can start.",
      severity: CHECK_REQUIRED_STATUS
    });
  }
  if (capabilities.limits === null) {
    addCapabilityReason(reasons, {
      code: "adapter-budget-unavailable",
      label: "Budget unavailable",
      message: "The active adapter approval has no readable resource budget.",
      severity: UNAVAILABLE_STATUS
    });
  }
  if (capabilities.maxBatchAssignments < 1) {
    addCapabilityReason(reasons, {
      code: "adapter-batch-budget-unavailable",
      label: "Batch budget unavailable",
      message: "The approved target budget does not permit a batch assignment.",
      severity: UNAVAILABLE_STATUS
    });
  }
  if (capabilities.configurationStatus !== "validated") {
    addCapabilityReason(reasons, {
      code: "adapter-preflight-required",
      label:
        capabilities.configurationStatus === "invalid"
          ? "Target configuration invalid"
          : "Preflight required",
      message:
        "The latest committed target configuration must pass Runtime preflight before it can run.",
      severity:
        capabilities.configurationStatus === "invalid"
          ? UNAVAILABLE_STATUS
          : CHECK_REQUIRED_STATUS
    });
  }
  if (capabilities.runnableAssignments.length === 0) {
    addCapabilityReason(reasons, {
      code: "adapter-policy-unavailable",
      label: "No runnable policy",
      message:
        "No approved policy is currently supported by Runtime; no baseline is substituted silently.",
      severity: UNAVAILABLE_STATUS
    });
  }
  return readinessFromReasons(reasons);
}

function visualModeReadiness(input: {
  readonly workspaceEnabled: boolean;
  readonly operatorActionsAvailable: boolean;
  readonly targetStore: "available" | "unavailable";
  readonly targets: readonly VisualTargetApproval[];
  readonly visualDriverAvailable: boolean;
  readonly policies: readonly ControlApiPlaytestingPolicyReadiness[];
}): ControlApiPlaytestingCapabilitiesResponse["modeReadiness"]["autonomous-visual"] {
  const reasons: ControlApiPlaytestingCapabilityReason[] = [];
  if (!input.visualDriverAvailable) {
    addCapabilityReason(reasons, {
      code: "visual-driver-unavailable",
      label: "Visual browser driver unavailable",
      message:
        "Runtime could not resolve a Playwright Chromium executable for the visual browser driver.",
      severity: UNAVAILABLE_STATUS
    });
  }
  if (!input.workspaceEnabled) {
    addCapabilityReason(reasons, {
      code: "workspace-disabled",
      label: "Workspace disabled",
      message: "Enable this workspace before starting a visual playtest.",
      severity: UNAVAILABLE_STATUS
    });
  }
  if (!input.operatorActionsAvailable) {
    addCapabilityReason(reasons, OPERATOR_REQUIRED_REASON);
  }
  if (input.targetStore === "unavailable") {
    addCapabilityReason(reasons, {
      code: "visual-target-store-unavailable",
      label: "Visual target approvals unavailable",
      message:
        "Runtime could not read the approved visual targets for this workspace.",
      severity: UNAVAILABLE_STATUS
    });
  } else if (input.targets.length === 0) {
    addCapabilityReason(reasons, {
      code: "visual-target-required",
      label: "No visual target approved",
      message:
        "Approve an already-running browser game URL in Workspaces before visual play can be considered.",
      severity: CHECK_REQUIRED_STATUS
    });
  }
  const targets: ControlApiPlaytestingVisualTargetReadiness[] =
    input.targets.map((target) => {
      const targetReasons: ControlApiPlaytestingCapabilityReason[] = [];
      if (target.entryRequirements !== "none") {
        addCapabilityReason(targetReasons, {
          code: "visual-target-setup-required",
          label: "Operator-assisted setup unsupported",
          message: `Target ${target.name} requires ${target.entryRequirements}; this runtime only supports ungated entry.`,
          severity: UNAVAILABLE_STATUS
        });
      }
      if (target.controlTimingClass === "continuous") {
        addCapabilityReason(targetReasons, {
          code: "visual-control-timing-unsupported",
          label: "Continuous control unsupported",
          message: `Target ${target.name} requires continuous control, which is not supported by the visual turn-based driver.`,
          severity: UNAVAILABLE_STATUS
        });
      }
      return {
        target,
        eligibility: targetReasons.length === 0 ? "supported" : "unsupported",
        reasons: targetReasons
      };
    });
  if (
    input.targetStore === "available" &&
    targets.length > 0 &&
    targets.every((target) => target.eligibility !== "supported")
  ) {
    addCapabilityReason(reasons, {
      code: "visual-targets-unsupported",
      label: "No supported visual target",
      message:
        "Every approved visual target requires unsupported setup or continuous control.",
      severity: UNAVAILABLE_STATUS
    });
  }
  // The mode can run when at least one decision backend can be reached.
  // A backend that is down is a fact about that backend, and it is reported
  // on the backend's own readiness rather than as a reason against the mode.
  const availablePolicies = input.policies.filter(
    (policy) => policy.status === "ready"
  );
  if (input.policies.length > 0 && availablePolicies.length === 0) {
    addCapabilityReason(reasons, {
      code: "visual-policy-unavailable",
      label: "No decision backend available",
      message:
        "None of the decision backends this mode offers can be reached: the local model router and the local OneJev server are both unavailable.",
      severity: UNAVAILABLE_STATUS
    });
  }
  return {
    ...readinessFromReasons(reasons),
    targetStore: input.targetStore,
    targets,
    policies: input.policies
  };
}

/**
 * One decision backend's readiness.
 *
 * The Smart-directed route needs the authenticated local model router; the
 * local OneJev route needs the operator's own model server. They are
 * different services with different reasons to be down, and a reader
 * choosing a backend needs to know which one is missing.
 */
function visualPolicyReadiness(input: {
  readonly policyId: PlaytestVisualPolicyId;
  readonly available: boolean;
  readonly unavailableReason: ControlApiPlaytestingCapabilityReason;
}): ControlApiPlaytestingPolicyReadiness {
  if (input.available) {
    return { policyId: input.policyId, status: "ready", reasons: [] };
  }
  return {
    policyId: input.policyId,
    status: "unavailable",
    reasons: [input.unavailableReason]
  };
}

function scriptedModeReadiness(
  operatorActionsAvailable: boolean
): ControlApiPlaytestingModeReadiness {
  const reasons: ControlApiPlaytestingCapabilityReason[] = [];
  if (!operatorActionsAvailable) {
    addCapabilityReason(reasons, OPERATOR_REQUIRED_REASON);
  }
  addCapabilityReason(reasons, {
    code: "scripted-regression-unavailable",
    label: "Scripted regression unavailable",
    message:
      "Runtime does not yet have the approved scripted-regression launch path.",
    severity: UNAVAILABLE_STATUS
  });
  return readinessFromReasons(reasons);
}

function visualTargetsForWorkspace(
  workspaceId: string,
  options: PlaytestingRunControlApiOptions
): {
  readonly targetStore: "available" | "unavailable";
  readonly targets: readonly VisualTargetApproval[];
} {
  try {
    const repository =
      options.visualTargetRepository ??
      new WorkspaceVisualPlaytestTargetRepository();
    return {
      targetStore: "available",
      targets: repository
        .list(workspaceId)
        .filter((target) => target.revokedAt === null)
    };
  } catch {
    return { targetStore: "unavailable", targets: [] };
  }
}

async function capabilitiesForLaunchRequest(input: {
  readonly session: PlaytestMcpSession;
  readonly actor: PlaytestingRunControlActor;
  readonly workspaceId: string;
  readonly options: PlaytestingRunControlApiOptions;
  readonly runControl: PlaytestRunControl;
}): Promise<ControlApiPlaytestingCapabilitiesResponse> {
  const [runCapabilities, visualTargets] = await Promise.all([
    input.runControl.getCapabilities(input.session, input.workspaceId),
    visualTargetsForWorkspace(input.workspaceId, input.options)
  ]);
  const operatorActionsAvailable = input.actor.role === "operator";
  const probes = input.options.visualReadinessProbes;
  const capabilities: Omit<
    ControlApiPlaytestingCapabilitiesResponse,
    "capabilityRevision"
  > = {
    schema: "autodev-control-playtesting-capabilities-v3",
    ...runCapabilities,
    operatorActionsAvailable,
    modeReadiness: {
      "adapter-accelerated": adapterModeReadiness(
        runCapabilities,
        operatorActionsAvailable
      ),
      "autonomous-visual": visualModeReadiness({
        workspaceEnabled: runCapabilities.workspaceEnabled,
        operatorActionsAvailable,
        visualDriverAvailable:
          probes?.visualDriverAvailable?.() ??
          isPlaytestVisualBrowserDriverAvailable(),
        policies: [
          visualPolicyReadiness({
            policyId: "smart-direct",
            available:
              (await (probes?.smartDirectPolicyAvailable?.() ??
                isSmartDirectVisualPolicyAvailable())) === true,
            unavailableReason: {
              code: "smart-direct-policy-unavailable",
              label: "Smart-direct route unavailable",
              message:
                "The authenticated local AutoDev model router Smart-direct requires is not reachable.",
              severity: UNAVAILABLE_STATUS
            }
          }),
          visualPolicyReadiness({
            policyId: "onejev-local",
            available:
              (await (probes?.oneJevLocalPolicyAvailable?.() ??
                isOneJevLocalVisualPolicyAvailable())) === true,
            unavailableReason: {
              code: "onejev-local-policy-unavailable",
              label: "Local OneJev server unavailable",
              message:
                "The local OneJev model server is not reachable. Start it with `qev serve` on the approved local endpoint, or choose the Smart-directed route.",
              severity: UNAVAILABLE_STATUS
            }
          })
        ],
        ...visualTargets
      }),
      "scripted-regression": scriptedModeReadiness(operatorActionsAvailable)
    }
  };
  const capabilityRevision = createHash("sha256")
    .update(
      canonicalPlaytestJson({
        actor: input.actor.actor,
        role: input.actor.role,
        capabilities
      })
    )
    .digest("hex");
  return { ...capabilities, capabilityRevision };
}

async function getCapabilities(
  request: IncomingMessage,
  response: ServerResponse,
  pathname: string,
  actor: PlaytestingRunControlActor,
  options: PlaytestingRunControlApiOptions,
  runControl: PlaytestRunControl
): Promise<void> {
  const query = workspaceQuery(
    request,
    pathname,
    ["workspaceId"],
    options,
    response
  );
  if (!query) return;
  const session = sessionFor(
    request,
    actor,
    query.workspaceId,
    response,
    options.requireSessionHeader ?? false,
    options.trustedSessionRole
  );
  if (!session) return;
  try {
    const body = await capabilitiesForLaunchRequest({
      session,
      actor,
      workspaceId: query.workspaceId,
      options,
      runControl
    });
    sendJson(response, 200, body, { "cache-control": "no-store" });
  } catch (error) {
    recordRunError(
      response,
      error,
      options,
      actor,
      undefined,
      query.workspaceId
    );
  }
}

async function listRuns(
  request: IncomingMessage,
  response: ServerResponse,
  pathname: string,
  actor: PlaytestingRunControlActor,
  options: PlaytestingRunControlApiOptions,
  runControl: PlaytestRunControl
): Promise<void> {
  const query = workspaceQuery(
    request,
    pathname,
    ["workspaceId"],
    options,
    response
  );
  if (!query) return;
  const session = sessionFor(
    request,
    actor,
    query.workspaceId,
    response,
    options.requireSessionHeader ?? false,
    options.trustedSessionRole
  );
  if (!session) return;
  try {
    const activeRuns = await runControl.listActiveRuns(
      session,
      query.workspaceId
    );
    const body: ControlApiPlaytestingActiveRunsResponse = {
      schema: "autodev-control-playtesting-runs-v2",
      workspaceId: query.workspaceId,
      // The owner already read each live run; project that same record rather
      // than re-reading it, so the list cannot disagree with the status route.
      runs: activeRuns.map((run) => ({
        batchId: run.batchId,
        assignmentCount: run.assignmentCount,
        createdAt: run.createdAt,
        sessions: run.sessions,
        status: statusRecord(run.status)
      }))
    };
    sendJson(response, 200, body, { "cache-control": "no-store" });
  } catch (error) {
    recordRunError(
      response,
      error,
      options,
      actor,
      undefined,
      query.workspaceId
    );
  }
}

async function lookupRunByRequest(
  request: IncomingMessage,
  response: ServerResponse,
  pathname: string,
  actor: PlaytestingRunControlActor,
  options: PlaytestingRunControlApiOptions,
  runControl: PlaytestRunControl
): Promise<void> {
  const query = workspaceQuery(
    request,
    pathname,
    ["workspaceId", "requestId"],
    options,
    response
  );
  if (!query) return;
  const requestId = query.params.get("requestId") ?? "";
  if (!REQUEST_ID_PATTERN.test(requestId)) {
    sendError(
      response,
      400,
      "autodev_control_playtesting_invalid_request",
      "A valid requestId is required to recover an uncertain launch."
    );
    return;
  }
  const session = sessionFor(
    request,
    actor,
    query.workspaceId,
    response,
    options.requireSessionHeader ?? false,
    options.trustedSessionRole
  );
  if (!session) return;
  try {
    const lookup = await runControl.lookupRunByRequest(
      session,
      query.workspaceId,
      requestId
    );
    const body: ControlApiPlaytestingRunRequestLookupResponse = {
      schema: "autodev-control-playtesting-run-request-v2",
      workspaceId: query.workspaceId,
      ...lookup
    };
    sendJson(response, 200, body, { "cache-control": "no-store" });
  } catch (error) {
    recordRunError(
      response,
      error,
      options,
      actor,
      undefined,
      query.workspaceId
    );
  }
}

async function readRunStatus(
  request: IncomingMessage,
  response: ServerResponse,
  pathname: string,
  batchId: string,
  actor: PlaytestingRunControlActor,
  options: PlaytestingRunControlApiOptions,
  runControl: PlaytestRunControl
): Promise<void> {
  const query = workspaceQuery(
    request,
    pathname,
    ["workspaceId", "waitMs"],
    options,
    response
  );
  if (!query) return;
  const session = sessionFor(
    request,
    actor,
    query.workspaceId,
    response,
    options.requireSessionHeader ?? false,
    options.trustedSessionRole
  );
  if (!session) return;
  const waitText = query.params.get("waitMs") ?? "0";
  const waitMs = Number(waitText);
  if (
    !WAIT_MILLISECONDS_PATTERN.test(waitText) ||
    !Number.isSafeInteger(waitMs) ||
    waitMs > 30_000
  ) {
    sendError(
      response,
      400,
      "autodev_control_playtesting_invalid_request",
      "waitMs must be between 0 and 30000 milliseconds."
    );
    return;
  }
  try {
    const run = statusRecord(
      await runControl.waitForRun(session, query.workspaceId, batchId, waitMs)
    );
    const body: ControlApiPlaytestingRunStatusResponse = {
      schema: "autodev-control-playtesting-run-status-v1",
      workspaceId: query.workspaceId,
      run
    };
    sendJson(response, 200, body, { "cache-control": "no-store" });
  } catch (error) {
    recordRunError(
      response,
      error,
      options,
      actor,
      undefined,
      query.workspaceId
    );
  }
}

async function cancelRun(
  request: IncomingMessage,
  response: ServerResponse,
  pathname: string,
  batchId: string,
  actor: PlaytestingRunControlActor,
  options: PlaytestingRunControlApiOptions,
  runControl: PlaytestRunControl
): Promise<void> {
  if (actor.role !== "operator") {
    sendError(
      response,
      403,
      "autodev_control_playtesting_operator_required",
      "Cancelling a playtest requires an authorized operator."
    );
    return;
  }
  const query = workspaceQuery(
    request,
    pathname,
    ["workspaceId"],
    options,
    response
  );
  if (!query) return;
  const session = sessionFor(
    request,
    actor,
    query.workspaceId,
    response,
    options.requireSessionHeader ?? false,
    options.trustedSessionRole
  );
  if (!session) return;
  const parsedBody = await readControlApiJsonObject(request);
  if (!parsedBody.ok) {
    sendError(response, parsedBody.status, parsedBody.code, parsedBody.message);
    return;
  }
  if (!cancellationRequestSchema.safeParse(parsedBody.body).success) {
    sendError(
      response,
      400,
      "autodev_control_playtesting_invalid_request",
      "A typed expectedStatus of 'running' is required to request cancellation."
    );
    return;
  }
  try {
    const cancellation = await runControl.cancelRun(
      session,
      query.workspaceId,
      batchId
    );
    const body: ControlApiPlaytestingRunCancellationResponse = {
      schema: "autodev-control-playtesting-run-cancellation-v1",
      workspaceId: query.workspaceId,
      batchId: cancellation.batchId,
      cancellationRequested: cancellation.cancellationRequested
    };
    recordAudit(
      options,
      actor,
      "cancel_playtest_run",
      query.workspaceId,
      "ok",
      {
        batchId: cancellation.batchId,
        cancellationRequested: cancellation.cancellationRequested
      }
    );
    sendJson(response, 202, body, { "cache-control": "no-store" });
  } catch (error) {
    recordRunError(
      response,
      error,
      options,
      actor,
      "cancel_playtest_run",
      query.workspaceId
    );
  }
}

const INTERNAL_ERROR_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_]{0,63}$/u;
const INTERNAL_ERROR_CODE_PATTERN = /^[A-Za-z0-9_:-]{1,64}$/u;

/**
 * Keep internal failure logs useful without serializing exception messages,
 * which can contain Data/backend text or user-controlled values. Stack frames
 * are bounded and omit the message line.
 */
export function formatControlApiInternalErrorDiagnostic(
  error: unknown
): string {
  const name =
    error instanceof Error && INTERNAL_ERROR_NAME_PATTERN.test(error.name)
      ? error.name
      : "UnknownError";
  const rawCode =
    typeof error === "object" && error !== null && "code" in error
      ? (error as { readonly code?: unknown }).code
      : null;
  const code =
    typeof rawCode === "string" && INTERNAL_ERROR_CODE_PATTERN.test(rawCode)
      ? rawCode
      : null;
  const frames =
    error instanceof Error && typeof error.stack === "string"
      ? error.stack
          .split("\n")
          .slice(1)
          .filter((line) => /^\s*at\s/u.test(line))
          .slice(0, 3)
          .map((line) =>
            line
              .trim()
              .replace(/[\r\n?][^\s)]*/gu, "")
              .slice(0, 192)
          )
      : [];
  return [
    `type=${name}`,
    ...(code === null ? [] : [`code=${code}`]),
    ...(frames.length === 0 ? [] : [`frames=${frames.join(" | ")}`])
  ].join(" ");
}

function recordRunError(
  response: ServerResponse,
  error: unknown,
  options: PlaytestingRunControlApiOptions,
  actor: PlaytestingRunControlActor,
  action:
    | "start_playtest_run"
    | "cancel_playtest_run"
    | "record_playtest_comparison_decision"
    | "request_playtest_analysis"
    | undefined,
  workspaceId: string
): void {
  if (error instanceof PlaytestMcpAuthorizationError) {
    recordAudit(
      options,
      actor,
      action,
      workspaceId,
      "denied",
      null,
      "forbidden"
    );
    sendError(
      response,
      403,
      "autodev_control_playtesting_forbidden",
      error.message
    );
  } else if (error instanceof PlaytestMcpConflictError) {
    recordAudit(
      options,
      actor,
      action,
      workspaceId,
      "denied",
      null,
      "idempotency-conflict"
    );
    sendError(
      response,
      409,
      "autodev_control_playtesting_request_id_conflict",
      error.message
    );
  } else if (error instanceof PlaytestMcpValidationError) {
    recordAudit(
      options,
      actor,
      action,
      workspaceId,
      "denied",
      null,
      "invalid_request"
    );
    sendError(
      response,
      400,
      "autodev_control_playtesting_invalid_request",
      error.message
    );
  } else if (error instanceof PlaytestSourceUnavailableError) {
    recordAudit(
      options,
      actor,
      action,
      workspaceId,
      "error",
      null,
      "data_source_unavailable"
    );
    sendError(
      response,
      503,
      "autodev_control_playtesting_source_unavailable",
      "Playtest Data is temporarily unavailable."
    );
  } else if (error instanceof PlaytestSandboxUnavailableError) {
    recordAudit(
      options,
      actor,
      action,
      workspaceId,
      "error",
      null,
      "sandbox_unavailable"
    );
    sendError(
      response,
      503,
      "autodev_control_playtesting_sandbox_unavailable",
      "The approved playtesting sandbox is unavailable."
    );
  } else if (error instanceof PlaytestSandboxApprovalError) {
    recordAudit(
      options,
      actor,
      action,
      workspaceId,
      "denied",
      null,
      "approval_changed"
    );
    sendError(
      response,
      409,
      "autodev_control_playtesting_approval_changed",
      error.message
    );
  } else if (error instanceof PlaytestMcpUnavailableError) {
    recordAudit(
      options,
      actor,
      action,
      workspaceId,
      "error",
      null,
      "runtime_unavailable"
    );
    sendError(
      response,
      503,
      "autodev_control_playtesting_unavailable",
      error.message
    );
  } else {
    writeErrorLine(
      "control-playtesting-run: internal operation failure " +
        formatControlApiInternalErrorDiagnostic(error)
    );
    recordAudit(
      options,
      actor,
      action,
      workspaceId,
      "error",
      null,
      "internal_error"
    );
    sendError(
      response,
      500,
      "autodev_control_playtesting_internal_error",
      "The playtest run operation failed."
    );
  }
}

type RunControlRoute =
  | { readonly kind: "capabilities" }
  | { readonly kind: "collection" }
  | { readonly kind: "request-lookup" }
  | { readonly kind: "analyses" }
  | { readonly kind: "status"; readonly batchId: string }
  | { readonly kind: "cancel"; readonly batchId: string }
  | { readonly kind: "comparison-decision"; readonly comparisonId: string };

function runControlRoute(pathname: string): RunControlRoute | null {
  if (pathname === CAPABILITIES_PATH) return { kind: "capabilities" };
  if (pathname === REQUEST_LOOKUP_PATH) return { kind: "request-lookup" };
  if (pathname === RUNS_PATH) return { kind: "collection" };
  if (pathname === ANALYSES_PATH) return { kind: "analyses" };
  const batchId = pathId(pathname, RUN_ROUTE);
  if (batchId !== null) return { kind: "status", batchId };
  const cancelBatchId = pathId(pathname, CANCEL_ROUTE);
  if (cancelBatchId !== null) return { kind: "cancel", batchId: cancelBatchId };
  const comparisonId = pathId(pathname, COMPARISON_DECISION_ROUTE);
  return comparisonId === null
    ? null
    : { kind: "comparison-decision", comparisonId };
}

async function dispatchRunControlRoute(input: {
  readonly route: RunControlRoute;
  readonly request: IncomingMessage;
  readonly response: ServerResponse;
  readonly pathname: string;
  readonly actor: PlaytestingRunControlActor;
  readonly options: PlaytestingRunControlApiOptions;
  readonly runControl: PlaytestRunControl &
    Partial<PlaytestAnalystReviewDispatch>;
}): Promise<void> {
  const { route, request, response, pathname, actor, options, runControl } =
    input;
  const method = request.method ?? "GET";
  switch (route.kind) {
    case "request-lookup": {
      if (method === "GET") {
        await lookupRunByRequest(
          request,
          response,
          pathname,
          actor,
          options,
          runControl
        );
      } else {
        sendMethodNotAllowed(response, "GET");
      }
      return;
    }
    case "capabilities": {
      if (method === "GET") {
        await getCapabilities(
          request,
          response,
          pathname,
          actor,
          options,
          runControl
        );
      } else {
        sendMethodNotAllowed(response, "GET");
      }
      return;
    }
    case "collection": {
      if (method === "POST") {
        await startRun(request, response, actor, options, runControl);
      } else if (method === "GET") {
        await listRuns(request, response, pathname, actor, options, runControl);
      } else {
        sendMethodNotAllowed(response, "GET, POST");
      }
      return;
    }
    case "analyses": {
      await handleAnalystReviewMethod(
        method,
        request,
        response,
        pathname,
        actor,
        options,
        runControl
      );
      return;
    }
    case "status": {
      if (method === "GET") {
        await readRunStatus(
          request,
          response,
          pathname,
          route.batchId,
          actor,
          options,
          runControl
        );
      } else {
        sendMethodNotAllowed(response, "GET");
      }
      return;
    }
    case "cancel": {
      if (method === "POST") {
        await cancelRun(
          request,
          response,
          pathname,
          route.batchId,
          actor,
          options,
          runControl
        );
      } else {
        sendMethodNotAllowed(response, "POST");
      }
      return;
    }
    case "comparison-decision": {
      if (method === "POST") {
        await decideComparison(
          request,
          response,
          route.comparisonId,
          actor,
          options,
          runControl
        );
      } else {
        sendMethodNotAllowed(response, "POST");
      }
    }
  }
}

/** Typed Control API entry points delegate to the exact MCP run-control owner. */
export async function handlePlaytestingRunControlRequest(
  request: IncomingMessage,
  response: ServerResponse,
  pathname: string,
  actor: PlaytestingRunControlActor,
  options: PlaytestingRunControlApiOptions = {}
): Promise<boolean> {
  const route = runControlRoute(pathname);
  if (route === null) return false;
  const runControl = options.runControl;
  if (!runControl) {
    sendError(
      response,
      503,
      "autodev_control_playtesting_unavailable",
      "The Runtime playtest run owner is not available."
    );
    return true;
  }
  await dispatchRunControlRoute({
    route,
    request,
    response,
    pathname,
    actor,
    options,
    runControl
  });
  return true;
}
