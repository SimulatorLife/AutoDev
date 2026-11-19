/**
 * The read-only session diagnostics routes of the Control API.
 *
 * These routes are the single source the Console, the CLI and the
 * `autodev-session-diagnostics` skill read a session's evidence from. They are
 * read-only, so both the `viewer` and the `operator` role may read them, and
 * every route answers `format=json` (the default) or `format=text`.
 *
 * The live router status is injected rather than fetched: the Control API runs
 * inside the router's own process, so asking it to call itself over loopback
 * would be a round trip to answer a question it already holds.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { homedir } from "node:os";
import path from "node:path";

import {
  renderFleetScanReport,
  renderHookDenialsReport,
  renderRecentSessions,
  renderSessionDiagnosticsReport,
  safeAutoDevSessionId,
  SESSION_EVENTS_PAGE_DEFAULT,
  SESSION_EVENTS_PAGE_LIMIT,
  SESSION_FLEET_SCAN_LIMIT,
  SESSION_HOOK_DENIAL_WINDOW_DAYS,
  SESSION_ITEMS_PAGE_DEFAULT,
  SESSION_ITEMS_PAGE_LIMIT,
  SESSION_RECENT_LIMIT
} from "@simulatorlife/autodev-core";
import {
  buildSessionDiagnosticsReport,
  hookDenialsResponse,
  listRecentSessionsResponse,
  rolloutRoots,
  scanRecentSessions
} from "@simulatorlife/autodev-data/diagnostics";

import { errorBody, sendJson } from "../router/proxy.ts";

/** The base path the diagnostics routes are mounted under. */
export const CONTROL_API_DIAGNOSTICS_PATH = "/control/diagnostics";

const RECENT_PATH = `${CONTROL_API_DIAGNOSTICS_PATH}/sessions/recent`;
const SCAN_PATH = `${CONTROL_API_DIAGNOSTICS_PATH}/sessions/scan`;
const HOOKS_PATH = `${CONTROL_API_DIAGNOSTICS_PATH}/hooks`;
const SESSIONS_PATH = `${CONTROL_API_DIAGNOSTICS_PATH}/sessions`;

const CONTROL_VARY_HEADER = "Authorization, X-AutoDev-Actor";
const DEFAULT_ROUTER_LOG = "codex-model-router.launchd.err.log";
const WHOLE_NUMBER_PATTERN = /^\d+$/u;

/**
 * The router's status, read in-process.
 *
 * The Control API runs inside the router, so it can answer the live question
 * without a loopback call. When no provider is registered the live section of
 * a report says the router was unreachable, which is what a separate process
 * would also have found.
 */
export type ControlApiDiagnosticsRouterStatusSource = () => unknown;

let routerStatusSource: ControlApiDiagnosticsRouterStatusSource | null = null;

/** Register the in-process router status the diagnostics read. */
export function setControlApiDiagnosticsRouterStatusSource(
  source: ControlApiDiagnosticsRouterStatusSource | null
): void {
  routerStatusSource = source;
}

/** The registered in-process router status, if any. */
export function controlApiDiagnosticsRouterStatusSource():
  | ControlApiDiagnosticsRouterStatusSource
  | null {
  return routerStatusSource;
}

/** How the diagnostics routes find the machine they are reading. */
export interface ControlApiDiagnosticsOptions {
  readonly codexHome?: string | undefined;
  readonly repositoryRoot?: string | undefined;
}

/** The router log the diagnostics read, under the given `$CODEX_HOME`. */
export function diagnosticsRouterLog(codexHome: string): string {
  return path.join(codexHome, "run", DEFAULT_ROUTER_LOG);
}

function resolvedCodexHome(
  options: ControlApiDiagnosticsOptions
): string {
  const explicit = options.codexHome?.trim();
  if (explicit) return explicit;
  const fromEnv = process.env.CODEX_HOME?.trim();
  if (fromEnv) return fromEnv;
  const home = process.env.HOME?.trim() || homedir();
  return path.join(home, ".codex");
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
    errorBody(message, "autodev_control_api_error", { code }),
    { "cache-control": "no-store", vary: CONTROL_VARY_HEADER }
  );
}

function sendText(response: ServerResponse, text: string): void {
  const encoded = Buffer.from(text, "utf8");
  response.writeHead(200, {
    "content-type": "text/plain; charset=utf-8",
    "content-length": encoded.length,
    connection: "close",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    vary: CONTROL_VARY_HEADER
  });
  response.end(encoded);
}

function sendJsonBody(response: ServerResponse, body: unknown): void {
  sendJson(response, 200, body, {
    "cache-control": "no-store",
    vary: CONTROL_VARY_HEADER
  });
}

class DiagnosticsRequestError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

/** A boolean query flag; anything else is a rejected request. */
function booleanParam(
  params: URLSearchParams,
  name: string,
  fallback: boolean
): boolean {
  const raw = params.get(name);
  if (raw === null) return fallback;
  if (raw === "0") return false;
  if (raw === "1") return true;
  throw new DiagnosticsRequestError(
    "autodev_control_api_invalid_diagnostics_query",
    `The ${name} parameter must be 0 or 1.`
  );
}

function boundedInteger(
  params: URLSearchParams,
  name: string,
  fallback: number,
  minimum: number,
  maximum: number
): number {
  const raw = params.get(name);
  if (raw === null) return fallback;
  if (!WHOLE_NUMBER_PATTERN.test(raw)) {
    throw new DiagnosticsRequestError(
      "autodev_control_api_invalid_diagnostics_query",
      `The ${name} parameter must be a whole number.`
    );
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new DiagnosticsRequestError(
      "autodev_control_api_invalid_diagnostics_query",
      `The ${name} parameter is out of range.`
    );
  }
  return value;
}

function formatParam(params: URLSearchParams): "json" | "text" {
  const raw = params.get("format");
  if (raw === null || raw === "json") return "json";
  if (raw === "text") return "text";
  throw new DiagnosticsRequestError(
    "autodev_control_api_invalid_diagnostics_query",
    "The format parameter must be json or text."
  );
}

/** Reject any parameter the route does not define. */
function rejectUnknownParams(
  params: URLSearchParams,
  allowed: readonly string[]
): void {
  for (const key of params.keys()) {
    if (!allowed.includes(key)) {
      throw new DiagnosticsRequestError(
        "autodev_control_api_invalid_diagnostics_query",
        "The request carries a parameter this route does not accept."
      );
    }
  }
}

/** The `?limit=N` of a fleet route, bounded by that route's own ceiling. */
function limitParam(params: URLSearchParams, maximum: number): number {
  return boundedInteger(params, "limit", maximum, 1, maximum);
}

const SESSION_PARAMS = [
  "format",
  "offline",
  "includeEfficiency",
  "includeFailures",
  "allFailures",
  "includeEvents",
  "eventsLimit",
  "eventsOffset",
  "includeItems",
  "itemsLimit",
  "itemsOffset",
  "threadId"
] as const;

const RECENT_PARAMS = ["format", "limit"] as const;
const SCAN_PARAMS = ["format", "limit"] as const;
const HOOKS_PARAMS = ["format", "sinceDays"] as const;

/**
 * Handle one diagnostics request.
 *
 * Returns false when the path is not a diagnostics path, so the caller can
 * fall through to its own routing.
 */
export async function handleControlApiDiagnosticsRequest(
  request: IncomingMessage,
  response: ServerResponse,
  pathname: string,
  options: ControlApiDiagnosticsOptions = {}
): Promise<boolean> {
  if (!pathname.startsWith(`${CONTROL_API_DIAGNOSTICS_PATH}/`)) return false;
  const method = request.method ?? "GET";
  if (method !== "GET") {
    response.setHeader("allow", "GET");
    sendError(
      response,
      405,
      "autodev_control_api_method_not_allowed",
      "The diagnostics routes are read-only via GET."
    );
    return true;
  }

  let params: URLSearchParams;
  try {
    params = new URL(request.url ?? "/", "http://127.0.0.1").searchParams;
  } catch {
    sendError(
      response,
      400,
      "autodev_control_api_invalid_diagnostics_query",
      "The request's query string could not be read."
    );
    return true;
  }

  const codexHome = resolvedCodexHome(options);
  try {
    if (pathname === RECENT_PATH) {
      rejectUnknownParams(params, RECENT_PARAMS);
      const format = formatParam(params);
      const limit = limitParam(params, SESSION_RECENT_LIMIT);
      const body = listRecentSessionsResponse(rolloutRoots(codexHome), limit);
      if (format === "text") sendText(response, renderRecentSessions(body));
      else sendJsonBody(response, body);
      return true;
    }
    if (pathname === SCAN_PATH) {
      rejectUnknownParams(params, SCAN_PARAMS);
      const format = formatParam(params);
      const limit = limitParam(params, SESSION_FLEET_SCAN_LIMIT);
      const body = await scanRecentSessions({
        codexHome,
        routerLog: diagnosticsRouterLog(codexHome),
        limit
      });
      if (format === "text") sendText(response, renderFleetScanReport(body));
      else sendJsonBody(response, body);
      return true;
    }
    if (pathname === HOOKS_PATH) {
      rejectUnknownParams(params, HOOKS_PARAMS);
      const format = formatParam(params);
      const sinceDays = boundedInteger(
        params,
        "sinceDays",
        7,
        1,
        SESSION_HOOK_DENIAL_WINDOW_DAYS
      );
      const body = hookDenialsResponse(codexHome, sinceDays);
      if (format === "text")
        sendText(response, renderHookDenialsReport(body.summary));
      else sendJsonBody(response, body);
      return true;
    }
    if (pathname.startsWith(`${SESSIONS_PATH}/`)) {
      await handleSessionRoute(
        response,
        pathname.slice(`${SESSIONS_PATH}/`.length),
        params,
        codexHome,
        options
      );
      return true;
    }
  } catch (error) {
    if (error instanceof DiagnosticsRequestError) {
      sendError(response, 400, error.code, error.message);
      return true;
    }
    throw error;
  }

  sendError(
    response,
    404,
    "autodev_control_api_unknown_path",
    "Unknown Control API path."
  );
  return true;
}

async function handleSessionRoute(
  response: ServerResponse,
  rawId: string,
  params: URLSearchParams,
  codexHome: string,
  options: ControlApiDiagnosticsOptions
): Promise<void> {
  rejectUnknownParams(params, SESSION_PARAMS);
  const format = formatParam(params);
  const sessionId = safeAutoDevSessionId(decodeURIComponent(rawId));
  if (!sessionId) {
    sendError(
      response,
      400,
      "autodev_control_api_invalid_session_id",
      "The session id is not a valid AutoDev session identity."
    );
    return;
  }
  const rawThreadId = params.get("threadId");
  const validatedThreadId =
    rawThreadId === null ? null : safeAutoDevSessionId(rawThreadId);
  const threadId = validatedThreadId ?? undefined;
  if (rawThreadId !== null && !validatedThreadId) {
    sendError(
      response,
      400,
      "autodev_control_api_invalid_thread_id",
      "The thread id is not a valid AutoDev session identity."
    );
    return;
  }
  const includeEvents = booleanParam(params, "includeEvents", false);
  const includeItems = booleanParam(params, "includeItems", false);
  const report = await buildSessionDiagnosticsReport({
    id: sessionId,
    codexHome,
    routerLog: diagnosticsRouterLog(codexHome),
    offline: booleanParam(params, "offline", false),
    includeEfficiency: booleanParam(params, "includeEfficiency", true),
    includeEvents,
    eventsLimit: boundedInteger(
      params,
      "eventsLimit",
      SESSION_EVENTS_PAGE_DEFAULT,
      1,
      SESSION_EVENTS_PAGE_LIMIT
    ),
    eventsOffset: boundedInteger(params, "eventsOffset", 0, 0, 100_000),
    includeItems,
    itemsLimit: boundedInteger(
      params,
      "itemsLimit",
      SESSION_ITEMS_PAGE_DEFAULT,
      1,
      SESSION_ITEMS_PAGE_LIMIT
    ),
    itemsOffset: boundedInteger(params, "itemsOffset", 0, 0, 100_000),
    ...(threadId === undefined ? {} : { threadId }),
    ...(options.repositoryRoot === undefined
      ? {}
      : { repoRoot: options.repositoryRoot }),
    ...(routerStatusSource === null ? {} : { routerStatus: routerStatusSource })
  });
  if (format === "text") {
    sendText(
      response,
      renderSessionDiagnosticsReport(report, {
        failures: booleanParam(params, "includeFailures", false),
        allFailures: booleanParam(params, "allFailures", false),
        efficiency: booleanParam(params, "includeEfficiency", true),
        items: includeItems,
        events: includeEvents
      })
    );
    return;
  }
  sendJsonBody(response, report);
}

