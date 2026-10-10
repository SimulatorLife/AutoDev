import { createHash } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

import {
  type ControlApiPlaytestingActiveRunsResponse,
  type ControlApiPlaytestingCapabilitiesResponse,
  type ControlApiPlaytestingCancellationReason,
  type ControlApiPlaytestingRunCancellationResponse,
  type ControlApiPlaytestingRunRecord,
  type ControlApiPlaytestingRunStartedResponse,
  type ControlApiPlaytestingRunStatusResponse,
  type PlaytestJsonValue
} from "@simulatorlife/autodev-core";
import { ConfigRepository } from "@simulatorlife/autodev-data";
import { PlaytestSourceUnavailableError } from "@simulatorlife/autodev-data/playtesting";
import { z } from "zod/v4";

import {
  PlaytestSandboxApprovalError,
  PlaytestSandboxUnavailableError
} from "../playtesting/docker-sandbox.ts";
import {
  PlaytestMcpAuthorizationError,
  type PlaytestMcpSession,
  PlaytestMcpUnavailableError,
  PlaytestMcpValidationError,
  type PlaytestRunControl
} from "../playtesting/mcp.ts";
import { errorBody, sendJson } from "../router/proxy.ts";
import { writeErrorLine } from "../shared/output.ts";
import { readControlApiJsonObject } from "./body.ts";

const RUNS_PATH = "/control/playtesting/runs";
const CAPABILITIES_PATH = "/control/playtesting/capabilities";
const WAIT_MILLISECONDS_PATTERN = /^(0|[1-9][0-9]{0,4})$/u;
const RUN_ROUTE = /^\/control\/playtesting\/runs\/([^/]+)$/u;
const CANCEL_ROUTE = /^\/control\/playtesting\/runs\/([^/]+)\/cancel$/u;
const WORKSPACE_ID_PATTERN = /^[^/\\\s]+\/[^/\\\s]+$/u;
const BATCH_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/u;
const RUN_STATES = new Set([
  "running",
  "persisting",
  "completed",
  "failed",
  "cancelled"
]);
const CANCELLATION_REASONS = new Set<ControlApiPlaytestingCancellationReason>([
  "cancelled",
  "approval-revoked",
  "workspace-disabled"
]);

const cancellationRequestSchema = z.strictObject({
  expectedStatus: z.literal("running")
});
const runRequestSchema = z.strictObject({
  workspaceId: z.string().regex(WORKSPACE_ID_PATTERN),
  scenario: z.string().min(1).max(256),
  policy: z.string().min(1).max(256),
  seed: z.string().min(1).max(256),
  goal: z.string().max(1000).optional(),
  maxSteps: z.number().int().min(1).max(100_000).optional()
});
const PROCESS_SESSION_HEADER = "x-autodev-playtest-session";
const BASE64URL_HEADER_PATTERN = /^[A-Za-z0-9_-]+$/u;
const processSessionSchema = z.strictObject({
  workspaceId: z.string().regex(WORKSPACE_ID_PATTERN),
  role: z.enum([
    "playtester",
    "playtest-analyst",
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
  readonly readWorkspaceCatalog?: () => ReturnType<
    ConfigRepository["readWorkspaceCatalog"]
  >;
  /** The same Runtime run owner used by MCP; this route owns no scheduler. */
  readonly runControl?: PlaytestRunControl;
  readonly requireSessionHeader?: boolean;
  readonly trustedSessionRole?: string;
  readonly audit?: (event: {
    readonly actor: string;
    readonly action: "start_playtest_run" | "cancel_playtest_run";
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
  action: "start_playtest_run" | "cancel_playtest_run" | undefined,
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
  const parsed = runRequestSchema.safeParse(parsedBody.body);
  if (!parsed.success) {
    sendError(
      response,
      400,
      "autodev_control_playtesting_invalid_request",
      "The typed playtest run request is invalid."
    );
    return;
  }
  const { workspaceId, ...runRequest } = parsed.data;
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
    const started = await runControl.startRun(session, {
      workspaceId,
      ...runRequest
    });
    const body: ControlApiPlaytestingRunStartedResponse = {
      schema: "autodev-control-playtesting-run-started-v1",
      workspaceId,
      ...started
    };
    recordAudit(options, actor, "start_playtest_run", workspaceId, "ok", {
      batchId: started.batchId,
      scenario: runRequest.scenario,
      policy: runRequest.policy
    });
    sendJson(response, 202, body, { "cache-control": "no-store" });
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
    const capabilities = await runControl.getCapabilities(
      session,
      query.workspaceId
    );
    const body: ControlApiPlaytestingCapabilitiesResponse = {
      schema: "autodev-control-playtesting-capabilities-v1",
      ...capabilities,
      operatorActionsAvailable: actor.role === "operator"
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
    const body: ControlApiPlaytestingActiveRunsResponse = {
      schema: "autodev-control-playtesting-runs-v1",
      workspaceId: query.workspaceId,
      runs: await runControl.listActiveRuns(session, query.workspaceId)
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

function recordRunError(
  response: ServerResponse,
  error: unknown,
  options: PlaytestingRunControlApiOptions,
  actor: PlaytestingRunControlActor,
  action: "start_playtest_run" | "cancel_playtest_run" | undefined,
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
    writeErrorLine("control-playtesting-run: internal operation failure.");
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

/** Typed Control API entry points delegate to the exact MCP run-control owner. */
export async function handlePlaytestingRunControlRequest(
  request: IncomingMessage,
  response: ServerResponse,
  pathname: string,
  actor: PlaytestingRunControlActor,
  options: PlaytestingRunControlApiOptions = {}
): Promise<boolean> {
  const batchId = pathId(pathname, RUN_ROUTE);
  const cancelBatchId = pathId(pathname, CANCEL_ROUTE);
  const isCollection = pathname === RUNS_PATH;
  const isCapabilities = pathname === CAPABILITIES_PATH;
  if (
    !isCollection &&
    !isCapabilities &&
    batchId === null &&
    cancelBatchId === null
  )
    return false;
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

  const method = request.method ?? "GET";
  if (isCapabilities) {
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
    return true;
  }
  if (isCollection) {
    if (method === "POST") {
      await startRun(request, response, actor, options, runControl);
    } else if (method === "GET") {
      await listRuns(request, response, pathname, actor, options, runControl);
    } else {
      sendMethodNotAllowed(response, "GET, POST");
    }
    return true;
  }
  if (batchId !== null) {
    if (method === "GET") {
      await readRunStatus(
        request,
        response,
        pathname,
        batchId,
        actor,
        options,
        runControl
      );
    } else {
      sendMethodNotAllowed(response, "GET");
    }
    return true;
  }
  if (cancelBatchId !== null) {
    if (method === "POST") {
      await cancelRun(
        request,
        response,
        pathname,
        cancelBatchId,
        actor,
        options,
        runControl
      );
    } else {
      sendMethodNotAllowed(response, "POST");
    }
    return true;
  }
  return false;
}
