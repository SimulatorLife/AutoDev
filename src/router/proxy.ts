import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import type { ServerResponse } from "node:http";
import { fileURLToPath } from "node:url";

import {
  INCOMPLETE_REASON_INTERRUPTED,
  INCOMPLETE_REASON_TIMEOUT,
  LIMIT_HEADER_CLASS,
  LIMIT_HEADER_RESETS_AT,
  LIMIT_SOURCE_REPORTED,
  normalizeResetsAt,
  type ProviderLimit,
  readLimitHeaders,
  terminalIncompleteEvents
} from "../shared/provider-limits.ts";
import {
  getDefaultConcurrencyManager,
  touchOpenSubagentSlots as touchManagerOpenSubagentSlots
} from "./concurrency.ts";
import {
  COOLDOWNS,
  type CooldownSummary,
  PROBE_FAILURE_CLASS
} from "./cooldown.ts";
import { classifyProviderFailure, recordRouterEvent } from "./events.ts";
import { recordMcpExposure } from "./otel.ts";
import {
  collectToolCallIds,
  countToolCallsFromSse,
  countToolCallsInResponse,
  responseTextFromSse,
  rewriteResponseValue,
  type RouterProviderRouteLike,
  transformSseEvent,
  upstreamPayload
} from "./responses.ts";
import {
  type Candidate,
  type OrchestratorCandidate,
  type ProviderRoute,
  ROUTING_POLICY
} from "./routing.ts";
import {
  AGENT_ROLE_HEADER,
  bridgeTelemetryHeaders as subagentBridgeTelemetryHeaders,
  closeBridgeSubagentsForRequest,
  CODEX_SESSION_HEADER,
  FORWARDED_REQUEST_HEADERS,
  SANDBOX_MODE_HEADER,
  SKILL_CONTEXT_HEADER,
  hasActiveBridgeSubagentsForSession,
  mcpContractForRole as subagentMcpContractForRole,
  noteBridgeRequest,
  noteBridgeSession,
  noteOrchestratorSession,
  ORCHESTRATOR_AGENT_ROLE,
  orchestratorProviderForSession,
  providerCapabilities,
  recordSpawnFailure,
  SESSION_ID_HEADER,
  SESSION_SCOPE_HEADER
} from "./subagents.ts";
import { TOOL_CALL_OWNERSHIP } from "./tool-call-ownership.ts";
import { resolveSandboxMode } from "../shared/execution-contract.ts";
import {
  countLiveAgentActivity,
  getDefaultUsageTracker,
  UNATTRIBUTED_DIMENSION,
  usageOrigin
} from "./usage.ts";

const CODEX_HOME =
  process.env.CODEX_HOME ?? `${process.env.HOME ?? process.cwd()}/.codex`;

/**
 * Pull the `<skill>...</skill>` body the orchestrator received from its
 * host's skills.instructions input item. The router forwards it to bridge
 * role-routed requests so children inherit the same selected-skill context
 * the orchestrator paid the prompt cost for, rather than re-catting the
 * SKILL.md from cwd and risking a wrong file. Returns null when nothing
 * is selected or the selection cannot be parsed.
 */
export function extractSelectedSkillContext(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;
  const root = payload as Record<string, unknown>;
  const candidates: unknown[] = [];
  if (Array.isArray(root.input)) candidates.push(...(root.input as unknown[]));
  if (Array.isArray(root.messages)) candidates.push(...(root.messages as unknown[]));
  for (const item of candidates) {
    if (!item || typeof item !== "object") continue;
    const entry = item as Record<string, unknown>;
    const kinds = Array.isArray(entry.content_item_kinds)
      ? (entry.content_item_kinds as unknown[])
      : [];
    const selected = kinds.some(
      (kind) => typeof kind === "string" && kind === "skills.selected_skill_instructions"
    );
    if (!selected) continue;
    const content = entry.content;
    if (typeof content === "string" && content.trim()) return content;
    if (Array.isArray(content)) {
      for (const part of content) {
        if (!part || typeof part !== "object") continue;
        const piece = part as Record<string, unknown>;
        if (typeof piece.text === "string" && piece.text.trim()) return piece.text;
      }
    }
  }
  return null;
}

const AUTH_FILE =
  process.env.CODEX_ROUTER_AUTH_FILE ?? `${CODEX_HOME}/auth.json`;
const HOST = process.env.CODEX_MODEL_ROUTER_HOST ?? "127.0.0.1";
const PORT = Number.parseInt(process.env.CODEX_MODEL_ROUTER_PORT ?? "4100");
const AGENT_EVENTS_PATH = "/v1/agent-events";
const AGENT_EVENTS_URL = `http://${HOST}:${PORT}${AGENT_EVENTS_PATH}`;

export const ROUTER_INSTANCE_ID = randomUUID();

export const CLIENT_DISCONNECT_CODES = Object.freeze(
  new Set([
    "EPIPE",
    "ECONNRESET",
    "ERR_STREAM_DESTROYED",
    "ERR_STREAM_WRITE_AFTER_END"
  ])
);

const defaultContractPath = fileURLToPath(
  new URL("../../config/execution-contract.json", import.meta.url)
);
const EXECUTION_CONTRACT_FILE =
  process.env.CODEX_EXECUTION_CONTRACT_FILE ??
  (existsSync(defaultContractPath)
    ? defaultContractPath
    : `${CODEX_HOME}/config/execution-contract.json`);

let loadedExecutionContract: Record<string, unknown> = {};
try {
  loadedExecutionContract = JSON.parse(
    readFileSync(EXECUTION_CONTRACT_FILE, "utf8")
  );
} catch {
  loadedExecutionContract = {};
}

const NOOP = () => {};
const INVALID_MODEL_REGEX =
  /invalid model|model name.*(invalid|not found)|unknown model/i;
const FALLBACKABLE_BODY_REGEX =
  /quota|rate.?limit|weekly.?limit|usage.?limit|usage exhausted|session|high.?demand|credit|timeout|timed.?out|overloaded|temporarily unavailable|unavailable/i;
const SSE_LINE_BREAK = /\r?\n/;
const SSE_EVENT_BOUNDARY = /\r?\n\r?\n/;

function pickString(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}

function pickBool(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function hasInputRequired(
  parsed: Record<string, unknown> | null,
  incomplete: { incompleteReason: string | null } | null
): boolean {
  return (
    parsed?.status === "requires_action" ||
    parsed?.status === "input_required" ||
    incomplete?.incompleteReason === "input_required" ||
    incomplete?.incompleteReason === "requires_action"
  );
}

function servedOutcome(outcome: string): boolean {
  return outcome === "served" || outcome === "terminal";
}

export function positiveDuration(
  value: string | undefined,
  fallback: number
): number {
  const parsed = Number.parseInt(value ?? "");
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export const PROBE_TIMEOUT_MS = positiveDuration(
  process.env.CODEX_ROUTER_PROBE_TIMEOUT_MS,
  700
);
export const LAST_RESORT_MAX_ATTEMPTS = positiveDuration(
  process.env.CODEX_ROUTER_LAST_RESORT_MAX_ATTEMPTS,
  2
);
export const EXHAUSTION_WAIT_MS =
  Number.parseInt(process.env.CODEX_ROUTER_EXHAUSTION_WAIT_MS ?? "") >= 0
    ? Number.parseInt(process.env.CODEX_ROUTER_EXHAUSTION_WAIT_MS!)
    : 20_000;
export const CHAIN_SELECTION_DEADLINE_MS = positiveDuration(
  process.env.CODEX_ROUTER_CHAIN_SELECTION_DEADLINE_MS,
  120_000
);
export const UPSTREAM_TIMEOUT_MS = positiveDuration(
  process.env.CODEX_ROUTER_UPSTREAM_TIMEOUT_MS,
  900_000
);
export const CONCRETE_RETRY_BASE_MS = positiveDuration(
  process.env.CODEX_ROUTER_CONCRETE_RETRY_MS,
  200
);
export const CONCRETE_RETRY_MAX_MS = Math.max(
  CONCRETE_RETRY_BASE_MS,
  positiveDuration(process.env.CODEX_ROUTER_CONCRETE_RETRY_MAX_MS, 2000)
);
export const CONCRETE_STATUS_MAX_ATTEMPTS = 2;
export const CONCRETE_TRANSPORT_MAX_ATTEMPTS = Math.max(
  CONCRETE_STATUS_MAX_ATTEMPTS,
  positiveDuration(process.env.CODEX_ROUTER_CONCRETE_TRANSPORT_RETRY_LIMIT, 3)
);

export const activeProviderRequests = new Map<string, number>();

export function getActiveRequests(provider: string): number {
  return activeProviderRequests.get(provider) ?? 0;
}

export function incrementActiveRequests(provider: string): void {
  activeProviderRequests.set(provider, getActiveRequests(provider) + 1);
}

export function decrementActiveRequests(provider: string): void {
  const current = getActiveRequests(provider);
  if (current <= 1) {
    activeProviderRequests.delete(provider);
  } else {
    activeProviderRequests.set(provider, current - 1);
  }
}

export function isClientDisconnectError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const code = (error as { code?: string }).code;
  if (typeof code === "string" && CLIENT_DISCONNECT_CODES.has(code))
    return true;
  const cause = (error as { cause?: { code?: string } }).cause;
  if (
    cause &&
    typeof cause === "object" &&
    typeof cause.code === "string" &&
    CLIENT_DISCONNECT_CODES.has(cause.code)
  ) {
    return true;
  }
  return false;
}

export function transportErrorInfo(error: unknown): {
  name: string;
  code: string | null;
  syscall: string | null;
} {
  const err =
    error && typeof error === "object"
      ? (error as {
          name?: string;
          code?: string;
          cause?: { code?: string; syscall?: string };
        })
      : null;
  const cause = err?.cause ?? null;
  return {
    name: err && typeof err.name === "string" ? err.name : "Error",
    code:
      err && typeof err.code === "string"
        ? err.code
        : cause && typeof cause.code === "string"
          ? cause.code
          : null,
    syscall: cause && typeof cause.syscall === "string" ? cause.syscall : null
  };
}

export function logTransportError({
  requestId,
  role = null,
  provider,
  model,
  requestedModel = model,
  error,
  workspace
}: {
  requestId: string | null;
  role?: string | null;
  provider: string | null;
  model: string | null;
  requestedModel?: string | null;
  error: unknown;
  workspace?: { key: string; cwd?: string | null } | null;
}): void {
  const info = transportErrorInfo(error);
  recordRouterEvent({
    phase: "transport_error",
    requestId,
    role,
    requestedModel,
    provider,
    model,
    workspace,
    errorName: info.name,
    errorCode: info.code,
    syscall: info.syscall
  });
}

export async function jitteredBackoff(): Promise<number> {
  const floor = Math.min(CONCRETE_RETRY_BASE_MS, CONCRETE_RETRY_MAX_MS);
  const ceiling = Math.max(
    floor,
    Math.min(CONCRETE_RETRY_MAX_MS, CONCRETE_RETRY_BASE_MS * 2)
  );
  const delayMs = floor + Math.floor(Math.random() * (ceiling - floor + 1));
  await new Promise((resolve) => {
    setTimeout(resolve, delayMs);
  });
  return delayMs;
}

export async function loadCodexAuth(): Promise<{
  token: string;
  accountId: string;
}> {
  const auth = JSON.parse(await readFile(AUTH_FILE, "utf8"));
  const token = auth.tokens?.access_token;
  const accountId = auth.tokens?.account_id;
  if (!token || !accountId)
    throw new Error(
      `Codex auth is missing access_token or account_id in ${AUTH_FILE}`
    );
  return { token, accountId };
}

/** A request's identity, as `requestSession` resolves it. */
export interface RouterSession {
  key: string;
  scope: string;
  thread?: string | null;
}

/**
 * The live-activity subject for a request: one agent is one Codex thread.
 *
 * A subagent shares its root's session key, so keying by session folded every
 * child into the orchestrator's record; keying each subagent request by its
 * request id instead counted every request as a new live agent -- a child
 * that made 45 tool calls in two minutes showed as dozens of agents, each
 * parked in `tool_wait` until the TTL. The thread id names the agent itself:
 * the root thread's equals its session key, so the root keeps its subject.
 * Without a thread id (a caller that is not Codex) nothing better exists.
 */
export function activitySubjectFor(
  requestId: string,
  session: RouterSession | null,
  { subagentOfKnownSession = false }: { subagentOfKnownSession?: boolean } = {}
): string {
  const thread = session?.thread ?? null;
  if (thread) return thread === session?.key ? thread : `thread:${thread}`;
  if (subagentOfKnownSession) return `req:${requestId}`;
  return session?.key || `req:${requestId}`;
}

export function carriesPendingToolResult(payload: unknown): boolean {
  const input =
    payload &&
    typeof payload === "object" &&
    "input" in payload &&
    Array.isArray((payload as { input: unknown[] }).input)
      ? (payload as { input: Array<Record<string, unknown>> }).input
      : [];
  for (const item of input) {
    if (
      item?.type === "custom_tool_call_output" ||
      item?.type === "function_call_output"
    )
      return true;
  }
  return false;
}

export function mcpContractForRole(
  agentRole: string | null,
  contract = loadedExecutionContract
): string[] {
  return subagentMcpContractForRole(agentRole, contract);
}

export function bridgeTelemetryHeaders(
  route: ProviderRoute,
  requestId: string | null,
  options: { executionContract?: unknown; agentEventsUrl?: string } = {}
): Record<string, string> {
  return subagentBridgeTelemetryHeaders(route, requestId, {
    executionContract: options.executionContract ?? loadedExecutionContract,
    agentEventsUrl: options.agentEventsUrl ?? AGENT_EVENTS_URL
  });
}

export function recordNativeMcpExposure({
  route,
  agentRole,
  workspace,
  requestId,
  sessionKey
}: {
  route: ProviderRoute | Candidate | null;
  agentRole: string | null;
  workspace?: { key: string; cwd?: string | null } | null;
  requestId: string | null;
  sessionKey: string | null;
}): void {
  if (route?.provider !== "codex") return;
  const model =
    "model" in (route ?? {}) && typeof (route as Candidate).model === "string"
      ? (route as Candidate).model
      : "codex";
  const context = {
    provider: route.provider,
    model,
    role:
      agentRole === ORCHESTRATOR_AGENT_ROLE
        ? "orchestrator"
        : (agentRole ?? "default"),
    workspace: workspace?.key ?? UNATTRIBUTED_DIMENSION,
    agent: sessionKey ?? UNATTRIBUTED_DIMENSION,
    sessionKey
  };
  for (const server of mcpContractForRole(agentRole)) {
    recordMcpExposure({ server, source: "role_contract", context, requestId });
  }
}

export function downstreamHeaders(
  route: ProviderRoute,
  auth: { token: string; accountId: string } | null,
  turnMetadataHeader: string | null,
  agentRole: string | null = null,
  requestId: string | null = null,
  session: RouterSession | null = null
): Record<string, string> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "text/event-stream",
    ...bridgeTelemetryHeaders(route, requestId)
  };
  if (route.envKey) {
    const key = process.env[route.envKey];
    if (key) headers.authorization = `Bearer ${key}`;
  } else if (auth) {
    headers.authorization = `Bearer ${auth.token}`;
    headers["chatgpt-account-id"] = auth.accountId;
  }
  if (route.provider === "codex") headers.connection = "close";
  if (turnMetadataHeader)
    headers[FORWARDED_REQUEST_HEADERS[0]!] = turnMetadataHeader;
  if (agentRole) headers[AGENT_ROLE_HEADER] = agentRole;
  if (agentRole && agentRole !== ORCHESTRATOR_AGENT_ROLE) {
    const mode = resolveSandboxMode(agentRole);
    if (mode) headers[SANDBOX_MODE_HEADER] = mode;
  }
  if (session?.key && route.provider !== "codex") {
    headers[SESSION_ID_HEADER] = session.key;
    headers[SESSION_SCOPE_HEADER] = session.scope ?? "identified";
  }
  return headers;
}

/**
 * Variant of {@link downstreamHeaders} that also forwards the orchestrator's
 * selected-skill body and the Codex session id so role-routed requests can
 * propagate selected-skill context to bridge-spawned children.
 */
export function downstreamHeadersWithSkillContext(
  route: ProviderRoute,
  auth: { token: string; accountId: string } | null,
  turnMetadataHeader: string | null,
  agentRole: string | null,
  requestId: string | null,
  session: RouterSession | null,
  options: { skillContext?: string | null; codexSessionId?: string | null } = {}
): Record<string, string> {
  const headers = downstreamHeaders(
    route,
    auth,
    turnMetadataHeader,
    agentRole,
    requestId,
    session
  );
  if (options.skillContext && options.skillContext.trim() && route.provider !== "codex") {
    headers[SKILL_CONTEXT_HEADER] = options.skillContext;
  }
  if (options.codexSessionId && options.codexSessionId.trim()) {
    headers[CODEX_SESSION_HEADER] = options.codexSessionId;
  }
  return headers;
}

/**
 * Resolve the Codex session id from a router request payload. Used as the
 * secondary correlation key for /v1/agent-events ingest when a child thread
 * never travelled through /v1/responses.
 */
export function codexSessionIdFromPayload(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;
  const root = payload as Record<string, unknown>;
  const candidates = [
    root.session_id,
    root.sessionId,
    root.thread_id,
    root.threadId,
    (root.metadata as Record<string, unknown> | undefined)?.session_id,
    (root.metadata as Record<string, unknown> | undefined)?.thread_id
  ];
  for (const value of candidates) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

export function declaredLimit(
  headers: unknown,
  body: unknown
): ProviderLimit | null {
  const fromHeaders = readLimitHeaders(
    headers as Parameters<typeof readLimitHeaders>[0]
  );
  if (fromHeaders) {
    return {
      limitClass: fromHeaders.limitClass,
      limitType: fromHeaders.limitType ?? null,
      resetsAt: fromHeaders.resetsAt ?? null,
      source: fromHeaders.source ?? LIMIT_SOURCE_REPORTED
    };
  }
  try {
    const declared = JSON.parse(String(body ?? ""))?.error?.limit;
    if (!declared?.class) return null;
    return {
      limitClass: String(declared.class).toLowerCase(),
      limitType: declared.type ? String(declared.type).toLowerCase() : null,
      resetsAt: normalizeResetsAt(declared.resets_at),
      source:
        declared.source === LIMIT_SOURCE_REPORTED
          ? LIMIT_SOURCE_REPORTED
          : "inferred"
    };
  } catch {
    return null;
  }
}

export function cooldownFor(
  failureClass: string,
  limit: ProviderLimit | null = null
): {
  failureClass: string;
  resetsAt: string | null;
  structured: boolean;
} {
  return {
    failureClass: limit?.limitClass ?? failureClass,
    resetsAt: limit?.resetsAt ?? null,
    structured: limit?.source === LIMIT_SOURCE_REPORTED
  };
}

export function fallbackable(status: number, body: unknown): boolean {
  if ([401, 408, 429, 500, 502, 503, 504].includes(status)) return true;
  if (status === 400 && INVALID_MODEL_REGEX.test(String(body ?? "")))
    return true;
  return FALLBACKABLE_BODY_REGEX.test(String(body ?? ""));
}

export async function providerAvailable(
  route: ProviderRoute
): Promise<boolean> {
  if (!ROUTING_POLICY.routeCredentialAvailable(route)) return false;
  if (route.provider === "codex") {
    try {
      await loadCodexAuth();
      return true;
    } catch {
      return false;
    }
  }
  if (!route.healthUrl) return true;
  try {
    const result = await fetch(route.healthUrl, {
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS)
    });
    return result.ok;
  } catch {
    return false;
  }
}

export function payloadForCandidate(
  payload: Record<string, unknown>,
  candidate: { model: string; reasoningEffort?: string | null }
): Record<string, unknown> {
  const next: Record<string, unknown> = { ...payload, model: candidate.model };
  if (candidate.reasoningEffort) {
    const base =
      payload.reasoning &&
      typeof payload.reasoning === "object" &&
      !Array.isArray(payload.reasoning)
        ? (payload.reasoning as Record<string, unknown>)
        : {};
    next.reasoning = { ...base, effort: candidate.reasoningEffort };
  }
  return next;
}

export function responseWasNotCompleted(
  response: Record<string, unknown> | null | undefined
): boolean {
  return response?.status != null && response.status !== "completed";
}

export function incompleteFromResponse(
  parsed: Record<string, unknown> | null | undefined
): {
  incompleteReason: string | null;
  limit: ProviderLimit | null;
} {
  const details = parsed?.incomplete_details as
    Record<string, unknown> | undefined;
  const declared = details?.provider_limit as
    Record<string, unknown> | undefined;
  return {
    incompleteReason: (details?.reason as string | undefined) ?? null,
    limit: declared?.class
      ? {
          limitClass: String(declared.class).toLowerCase(),
          limitType: declared.type ? String(declared.type).toLowerCase() : null,
          resetsAt: normalizeResetsAt(declared.resets_at),
          source:
            declared.source === LIMIT_SOURCE_REPORTED
              ? LIMIT_SOURCE_REPORTED
              : "inferred"
        }
      : null
  };
}

export function responseFailureEvent(message: string): string {
  return `event: response.failed\ndata: ${JSON.stringify({
    type: "response.failed",
    response: {
      id: `router_${Date.now()}`,
      object: "response",
      status: "failed",
      error: { type: "upstream_error", message }
    }
  })}\n\n`;
}

export interface StreamWriteResult {
  toolCalls: number;
  /** Call ids of the tool calls the provider emitted, for result affinity. */
  toolCallIds: Set<string>;
  failed: boolean;
  incompleteReason: string | null;
  limit: ProviderLimit | null;
  inputRequired: boolean;
}

function applyParsedSseEvent(
  parsed: { type?: string; [key: string]: unknown },
  streamState: {
    sawCreated: boolean;
    responseId: string | null;
    itemId: string | null;
    reasoningId: string | null;
    text: string;
    reasoning: string;
  },
  toolCallIds: Set<string>,
  setTerminal: (value: "completed" | "failed") => void,
  setIncompleteReason: (value: string) => void,
  setReportedLimit: (value: ProviderLimit) => void
): void {
  switch (parsed.type) {
    case "response.created": {
      streamState.sawCreated = true;
      streamState.responseId =
        (parsed.response as { id?: string } | undefined)?.id ??
        streamState.responseId;
      break;
    }
    case "response.output_item.added": {
      const item = parsed.item as { id?: string; type?: string } | undefined;
      if (item?.type === "reasoning")
        streamState.reasoningId = item.id ?? streamState.reasoningId;
      if (item?.type === "message")
        streamState.itemId = item.id ?? streamState.itemId;
      collectToolCallIds(parsed.item, toolCallIds);
      break;
    }
    case "response.output_item.done": {
      collectToolCallIds(parsed.item, toolCallIds);
      break;
    }
    case "response.output_text.delta": {
      streamState.text += String(parsed.delta ?? "");
      streamState.itemId =
        (parsed.item_id as string | undefined) ?? streamState.itemId;
      break;
    }
    case "response.reasoning_summary_text.delta": {
      streamState.reasoning += String(parsed.delta ?? "");
      streamState.reasoningId =
        (parsed.item_id as string | undefined) ?? streamState.reasoningId;
      break;
    }
    case "response.failed": {
      setTerminal("failed");
      break;
    }
    case "response.completed": {
      const response = parsed.response as Record<string, unknown> | undefined;
      collectToolCallIds(response, toolCallIds);
      setTerminal(responseWasNotCompleted(response) ? "failed" : "completed");
      const details = response?.incomplete_details as
        Record<string, unknown> | undefined;
      if (details?.reason) setIncompleteReason(String(details.reason));
      const declared = details?.provider_limit as
        Record<string, unknown> | undefined;
      if (declared?.class) {
        setReportedLimit({
          limitClass: String(declared.class).toLowerCase(),
          limitType: declared.type ? String(declared.type).toLowerCase() : null,
          resetsAt: normalizeResetsAt(declared.resets_at),
          source:
            declared.source === LIMIT_SOURCE_REPORTED
              ? LIMIT_SOURCE_REPORTED
              : "inferred"
        });
      }
      break;
    }
    default: {
      break;
    }
  }
}

function inspectSseEvent(
  event: string,
  streamState: {
    sawCreated: boolean;
    responseId: string | null;
    itemId: string | null;
    reasoningId: string | null;
    text: string;
    reasoning: string;
  },
  toolCallIds: Set<string>,
  setTerminal: (value: "completed" | "failed") => void,
  setIncompleteReason: (value: string) => void,
  setReportedLimit: (value: ProviderLimit) => void
): void {
  for (const line of event.split(SSE_LINE_BREAK)) {
    if (!line.startsWith("data: ") || line.slice(6) === "[DONE]") continue;
    let parsed: { type?: string; [key: string]: unknown };
    try {
      parsed = JSON.parse(line.slice(6));
    } catch {
      continue;
    }
    applyParsedSseEvent(
      parsed,
      streamState,
      toolCallIds,
      setTerminal,
      setIncompleteReason,
      setReportedLimit
    );
  }
}

function flushSseBuffer(args: {
  buffer: string;
  flush: boolean;
  isWritable: () => boolean;
  safeWrite: (chunk: string | Uint8Array) => boolean;
  publicModel: string;
  seenToolCalls: Set<string>;
  toolCallIds: Set<string>;
  streamState: {
    sawCreated: boolean;
    responseId: string | null;
    itemId: string | null;
    reasoningId: string | null;
    text: string;
    reasoning: string;
  };
  setTerminal: (value: "completed" | "failed") => void;
  setIncompleteReason: (value: string) => void;
  setReportedLimit: (value: ProviderLimit) => void;
  onConsumed: (toolCallDelta: number) => void;
  onBufferUpdated: (next: string) => void;
}): void {
  let working = args.buffer;
  while (args.isWritable()) {
    const boundary = working.match(SSE_EVENT_BOUNDARY);
    if (!boundary) break;
    const end = boundary.index! + boundary[0]!.length;
    const event = working.slice(0, end);
    inspectSseEvent(
      event,
      args.streamState,
      args.toolCallIds,
      args.setTerminal,
      args.setIncompleteReason,
      args.setReportedLimit
    );
    args.onConsumed(countToolCallsFromSse(event, args.seenToolCalls));
    args.safeWrite(transformSseEvent(event, args.publicModel));
    working = working.slice(end);
  }
  if (args.flush && working && args.isWritable()) {
    inspectSseEvent(
      working,
      args.streamState,
      args.toolCallIds,
      args.setTerminal,
      args.setIncompleteReason,
      args.setReportedLimit
    );
    args.onConsumed(countToolCallsFromSse(working, args.seenToolCalls));
    args.safeWrite(transformSseEvent(working, args.publicModel));
    working = "";
  }
  args.onBufferUpdated(working);
}

function closeSseStream(args: {
  streamState: {
    sawCreated: boolean;
    responseId: string | null;
    itemId: string | null;
    reasoningId: string | null;
    text: string;
    reasoning: string;
  };
  reportedLimit: ProviderLimit | null;
  publicModel: string;
  incompleteReason: string | null;
  isWritable: () => boolean;
  safeWrite: (chunk: string | Uint8Array) => boolean;
  reason: string;
  message: string;
  setIncompleteReason: (value: string) => void;
}): void {
  if (!args.isWritable()) return;
  if (!args.streamState.sawCreated) {
    args.safeWrite(responseFailureEvent(args.message));
    return;
  }
  args.setIncompleteReason(args.incompleteReason ?? args.reason);
  for (const [eventName, body] of terminalIncompleteEvents({
    responseId: args.streamState.responseId ?? `router_${Date.now()}`,
    itemId: args.streamState.itemId ?? `msg_${Date.now()}`,
    reasoningId: args.streamState.reasoningId ?? `rs_${Date.now()}`,
    text: args.streamState.text,
    reasoningText: args.streamState.reasoning,
    reason: args.reason,
    limit: args.reportedLimit,
    response: {
      id: args.streamState.responseId,
      object: "response",
      created_at: Math.floor(Date.now() / 1000),
      model: args.publicModel
    }
  })) {
    args.safeWrite(`event: ${eventName}
data: ${JSON.stringify(body)}

`);
  }
}

function isTimeoutAbort(signal: AbortSignal | null): boolean {
  return Boolean(
    signal?.aborted &&
    (signal.reason as { name?: string } | undefined)?.name === "TimeoutError"
  );
}

function upstreamErrorMessage(
  error: unknown,
  signal: AbortSignal | null
): string {
  if (isTimeoutAbort(signal)) {
    return `Upstream provider exceeded the ${Math.ceil(
      UPSTREAM_TIMEOUT_MS / 1000
    )}s response timeout.`;
  }
  return error instanceof Error ? error.message : String(error);
}

async function drainSseBody(args: {
  body: AsyncIterable<Uint8Array>;
  decoder: TextDecoder;
  isWritable: () => boolean;
  append: (chunk: string) => void;
  flushEvents: (flush: boolean) => void;
}): Promise<void> {
  for await (const chunk of args.body) {
    if (!args.isWritable()) break;
    args.append(args.decoder.decode(chunk, { stream: true }));
    args.flushEvents(false);
  }
  if (args.isWritable()) {
    args.append(args.decoder.decode());
    args.flushEvents(true);
  }
}

export async function writeResponseStream(
  response: ServerResponse,
  upstream: Response,
  publicModel: string,
  signal: AbortSignal | null = null,
  onHeartbeat: (() => void) | null = null
): Promise<StreamWriteResult> {
  const decoder = new TextDecoder();
  const seenToolCalls = new Set<string>();
  const toolCallIds = new Set<string>();
  let toolCalls = 0;
  let buffer = "";
  let terminal: "completed" | "failed" | null = null;
  const streamState = {
    sawCreated: false,
    responseId: null as string | null,
    model: publicModel,
    itemId: null as string | null,
    reasoningId: null as string | null,
    text: "",
    reasoning: ""
  };
  let incompleteReason: string | null = null;
  let reportedLimit: ProviderLimit | null = null;

  response.on("error", NOOP);

  const isWritable = (): boolean =>
    !response.writableEnded &&
    !response.destroyed &&
    !response.closed &&
    !signal?.aborted;
  const safeWrite = (chunk: string | Uint8Array): boolean => {
    if (!isWritable()) return false;
    try {
      return response.write(chunk);
    } catch {
      return false;
    }
  };
  const captureTerminal = (value: "completed" | "failed"): void => {
    terminal = value;
  };
  const captureIncompleteReason = (value: string): void => {
    incompleteReason = value;
  };
  const captureReportedLimit = (value: ProviderLimit): void => {
    reportedLimit = value;
  };
  const captureToolCalls = (delta: number): void => {
    toolCalls += delta;
  };
  const captureBuffer = (next: string): void => {
    buffer = next;
  };
  const flushEvents = (flush: boolean): void => {
    flushSseBuffer({
      buffer,
      flush,
      isWritable,
      safeWrite,
      publicModel,
      seenToolCalls,
      toolCallIds,
      streamState,
      setTerminal: captureTerminal,
      setIncompleteReason: captureIncompleteReason,
      setReportedLimit: captureReportedLimit,
      onConsumed: captureToolCalls,
      onBufferUpdated: captureBuffer
    });
  };
  const closeIncomplete = (reason: string, message: string): void => {
    closeSseStream({
      streamState,
      reportedLimit,
      publicModel,
      incompleteReason,
      isWritable,
      safeWrite,
      reason,
      message,
      setIncompleteReason: captureIncompleteReason
    });
  };

  const streamResult = (): StreamWriteResult => ({
    toolCalls,
    toolCallIds,
    failed: terminal !== "completed",
    incompleteReason,
    limit: reportedLimit,
    inputRequired:
      incompleteReason === "input_required" ||
      incompleteReason === "requires_action"
  });

  const keepAlive = setInterval(() => {
    safeWrite(": codex-router keep-alive\n\n");
    onHeartbeat?.();
  }, 2000);

  if (!upstream.body) {
    clearInterval(keepAlive);
    safeWrite(
      responseFailureEvent("Upstream provider returned no response body.")
    );
    response.removeListener("error", NOOP);
    return streamResult();
  }

  try {
    await drainSseBody({
      body: upstream.body as AsyncIterable<Uint8Array>,
      decoder,
      isWritable,
      append(chunk) {
        buffer += chunk;
      },
      flushEvents
    });
  } catch (error) {
    closeIncomplete(
      isTimeoutAbort(signal)
        ? INCOMPLETE_REASON_TIMEOUT
        : INCOMPLETE_REASON_INTERRUPTED,
      upstreamErrorMessage(error, signal)
    );
    return streamResult();
  } finally {
    clearInterval(keepAlive);
    response.removeListener("error", NOOP);
  }

  if (terminal === null) {
    closeIncomplete(
      INCOMPLETE_REASON_INTERRUPTED,
      "Upstream provider closed the stream before response.completed."
    );
  }

  return streamResult();
}
export interface FetchUpstreamResult {
  ok: boolean;
  upstream?: Response;
  signal?: AbortSignal;
  status?: number;
  body?: string;
  limit?: ProviderLimit | null;
  retryable?: boolean;
}

export async function fetchUpstream(
  route: ProviderRoute,
  payload: Record<string, unknown>,
  wantsStream: boolean,
  turnMetadataHeader: string | null,
  clientSignal: AbortSignal | null = null,
  agentRole: string | null = null,
  requestId: string | null = null,
  session: RouterSession | null = null
): Promise<FetchUpstreamResult> {
  let auth = null;
  if (route.provider === "codex") {
    try {
      auth = await loadCodexAuth();
    } catch (error) {
      const authError = new Error("Codex authentication is unavailable.");
      (authError as { code?: string }).code = "router_auth_unavailable";
      (authError as { cause?: unknown }).cause = error;
      throw authError;
    }
  }
  const requestPayload = upstreamPayload(
    route as unknown as RouterProviderRouteLike,
    payload,
    wantsStream,
    requestId,
    undefined,
    { normalizeItemIds: providerCapabilities(route.provider).normalizeItemIds }
  );
  const timeoutSignal = AbortSignal.timeout(UPSTREAM_TIMEOUT_MS);
  const signal = clientSignal
    ? AbortSignal.any([clientSignal, timeoutSignal])
    : timeoutSignal;
  const upstream = await fetch(`${route.baseUrl}/responses`, {
    method: "POST",
    headers: downstreamHeadersWithSkillContext(
      route,
      auth,
      turnMetadataHeader,
      agentRole,
      requestId,
      session,
      {
        skillContext: extractSelectedSkillContext(payload),
        codexSessionId: codexSessionIdFromPayload(payload)
      }
    ),
    signal,
    body: JSON.stringify(requestPayload)
  });
  if (!upstream.ok) {
    const body = await upstream.text();
    return {
      ok: false,
      status: upstream.status,
      body,
      limit: declaredLimit(upstream.headers, body),
      retryable: [502, 503, 504].includes(upstream.status)
    };
  }
  return { ok: true, upstream, signal };
}

export function sendJson(
  response: ServerResponse,
  status: number,
  body: unknown,
  extraHeaders: Record<string, string> = {}
): void {
  const encoded = Buffer.from(JSON.stringify(body));
  response.writeHead(status, {
    "content-type": "application/json",
    "content-length": encoded.length,
    connection: "close",
    "x-autodev-router-instance-id": ROUTER_INSTANCE_ID,
    ...extraHeaders
  });
  response.end(encoded);
}

export function errorBody(
  message: string,
  type = "invalid_request_error",
  context: {
    code?: string | null;
    retryable?: boolean | null;
    failureClass?: string | null;
    provider?: string | null;
    model?: string | null;
    requestId?: string | null;
    details?: Record<string, unknown> | null;
  } = {}
): Record<string, unknown> {
  return {
    error: {
      message,
      type,
      code:
        pickString(context.code) ??
        (typeof type === "string" && type ? type : null),
      retryable: pickBool(context.retryable),
      failureClass: pickString(context.failureClass),
      provider: pickString(context.provider),
      model: pickString(context.model),
      requestId: pickString(context.requestId),
      routerInstanceId: ROUTER_INSTANCE_ID,
      details:
        context.details &&
        typeof context.details === "object" &&
        !Array.isArray(context.details)
          ? context.details
          : null
    }
  };
}

export async function writeSuccessfulResponse(
  response: ServerResponse,
  route: ProviderRoute,
  result: { upstream: Response; signal: AbortSignal },
  wantsStream: boolean,
  publicModel: string,
  requestId: string,
  resolvedModel: string,
  onHeartbeat: (() => void) | null = null
): Promise<StreamWriteResult> {
  const written = await writeProviderResponse(
    response,
    route,
    result,
    wantsStream,
    publicModel,
    requestId,
    resolvedModel,
    onHeartbeat
  );
  // Whoever asked for these calls gets their results: see tool-call-ownership.ts.
  TOOL_CALL_OWNERSHIP.record(written.toolCallIds, route.provider);
  return written;
}

async function writeProviderResponse(
  response: ServerResponse,
  route: ProviderRoute,
  result: { upstream: Response; signal: AbortSignal },
  wantsStream: boolean,
  publicModel: string,
  requestId: string,
  resolvedModel: string,
  onHeartbeat: (() => void) | null
): Promise<StreamWriteResult> {
  const responseHeaders = {
    "x-autodev-provider": route.provider,
    "x-autodev-model": resolvedModel,
    "x-autodev-request-id": requestId,
    "x-autodev-router-instance-id": ROUTER_INSTANCE_ID
  };
  const upstream = result.upstream;
  if (wantsStream) {
    response.writeHead(upstream.status, {
      ...responseHeaders,
      "content-type":
        upstream.headers.get("content-type") ?? "text/event-stream",
      "cache-control": "no-cache",
      connection: "close"
    });
    const streamResult = await writeResponseStream(
      response,
      upstream,
      publicModel,
      result.signal,
      onHeartbeat
    );
    if (!response.writableEnded && !response.destroyed && !response.closed) {
      try {
        response.end();
      } catch {
        NOOP();
      }
    }
    return streamResult;
  }
  const body = await upstream.text();
  if (route.provider === "codex") {
    const toolCalls = countToolCallsFromSse(body);
    const parsed = rewriteResponseValue(
      responseTextFromSse(body),
      publicModel
    ) as Record<string, unknown>;
    sendJson(response, upstream.status, parsed, responseHeaders);
    const incomplete = incompleteFromResponse(parsed);
    const toolCallIds = new Set<string>();
    collectToolCallIds(parsed, toolCallIds);
    return {
      toolCalls,
      toolCallIds,
      failed: responseWasNotCompleted(parsed),
      ...incomplete,
      inputRequired: hasInputRequired(parsed, incomplete)
    };
  }
  try {
    const parsed = JSON.parse(body);
    const toolCalls = countToolCallsInResponse(parsed);
    const rewritten = rewriteResponseValue(parsed, publicModel) as Record<
      string,
      unknown
    >;
    sendJson(response, upstream.status, rewritten, responseHeaders);
    const incomplete = incompleteFromResponse(rewritten);
    const toolCallIds = new Set<string>();
    collectToolCallIds(rewritten, toolCallIds);
    return {
      toolCalls,
      toolCallIds,
      failed: responseWasNotCompleted(rewritten),
      ...incomplete,
      inputRequired: hasInputRequired(rewritten, incomplete)
    };
  } catch {
    response.writeHead(upstream.status, {
      ...responseHeaders,
      "content-type": upstream.headers.get("content-type") ?? "application/json"
    });
    response.end(body);
    return {
      toolCalls: 0,
      toolCallIds: new Set(),
      failed: false,
      incompleteReason: null,
      limit: null,
      inputRequired: false
    };
  }
}

export function soonestReset(
  summary: CooldownSummary[]
): CooldownSummary | null {
  return (
    summary
      .filter((entry) => entry.resetsAt)
      .sort((a, b) => Date.parse(a.resetsAt!) - Date.parse(b.resetsAt!))[0] ??
    null
  );
}

export function delay(
  ms: number,
  signal: AbortSignal | null = null
): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(finish, ms);
    function finish() {
      clearTimeout(timer);
      signal?.removeEventListener?.("abort", finish);
      resolve();
    }
    signal?.addEventListener?.("abort", finish, { once: true });
  });
}

export function exhaustionBody({
  subject,
  summary,
  failures,
  model,
  requestId,
  lastResortAttempts,
  deadlineReached
}: {
  subject: string;
  summary: CooldownSummary[];
  failures: string[];
  model: string;
  requestId: string;
  lastResortAttempts: number;
  deadlineReached: boolean;
}): Record<string, unknown> {
  const now = Date.now();
  const retryAfterMs = summary.reduce(
    (soonest, entry) =>
      entry.retryAfterMs > 0 && (soonest === 0 || entry.retryAfterMs < soonest)
        ? entry.retryAfterMs
        : soonest,
    0
  );
  const hard = summary.filter((entry) => entry.state === "hard");
  const everyCandidateHardLimited =
    hard.length > 0 && hard.length === summary.length;
  const reset = soonestReset(summary);
  const described = summary.map((entry) => {
    if (entry.state === "available")
      return `${entry.provider}: available but did not complete the turn`;
    if (entry.resetsAt)
      return `${entry.provider}: ${entry.failureClass ?? entry.state}, resets at ${entry.resetsAt}`;
    return `${entry.provider}: ${entry.failureClass ?? entry.state}, retry in ${Math.ceil(entry.retryAfterMs / 1000)}s`;
  });
  const action = everyCandidateHardLimited
    ? "summarize_and_yield"
    : "retry_after";
  const guidance = everyCandidateHardLimited
    ? `Every provider is out of usage${reset ? ` until at least ${reset.resetsAt}` : ""}. Return a summary of the work completed so far rather than retrying.`
    : `Retry after approximately ${Math.max(1, Math.ceil(retryAfterMs / 1000))}s.`;
  const reason = deadlineReached
    ? `No available provider completed ${subject} within the ${Math.ceil(CHAIN_SELECTION_DEADLINE_MS / 1000)}s provider-selection budget.`
    : `No available provider completed ${subject}.`;
  return errorBody(
    `${reason} ${described.join("; ")}. ${guidance}`,
    "router_provider_exhausted",
    {
      code: "router_provider_exhausted",
      retryable: true,
      failureClass: everyCandidateHardLimited
        ? (hard[0]?.failureClass ?? "quota_exhausted")
        : "unavailable",
      model,
      requestId,
      details: {
        retryAfterMs,
        resetsAt: reset?.resetsAt ?? null,
        recommendedAction: action,
        lastResortAttempts,
        selectionDeadlineReached: deadlineReached,
        providers: summary,
        failures,
        now: new Date(now).toISOString()
      }
    }
  );
}

export function exhaustionHeaders({
  summary,
  requestId
}: {
  summary: CooldownSummary[];
  requestId: string;
}): Record<string, string> {
  const retryAfterMs = summary.reduce(
    (soonest, entry) =>
      entry.retryAfterMs > 0 && (soonest === 0 || entry.retryAfterMs < soonest)
        ? entry.retryAfterMs
        : soonest,
    0
  );
  const headers: Record<string, string> = {
    "x-autodev-request-id": requestId,
    "retry-after": String(Math.max(1, Math.ceil(retryAfterMs / 1000)))
  };
  const reset = soonestReset(summary);
  if (reset) {
    headers[LIMIT_HEADER_RESETS_AT] = reset.resetsAt!;
    if (reset.failureClass) headers[LIMIT_HEADER_CLASS] = reset.failureClass;
  }
  return headers;
}

type ConcreteRequestContext = {
  response: ServerResponse;
  route: ProviderRoute;
  payload: Record<string, unknown>;
  wantsStream: boolean;
  requestId: string;
  turnMetadataHeader: string | null;
  workspace: { key: string; cwd?: string | null } | null;
  clientSignal: AbortSignal | null;
  session: RouterSession | null;
  activitySubject: string;
  modelName: string;
  sessionKey: string | null;
  startedAt: number;
};

function recordConcreteResult(
  ctx: ConcreteRequestContext,
  outcome: "success" | "failure",
  status: number | null,
  failureClass: string | null,
  toolCalls?: number
): void {
  recordRouterEvent({
    phase: "result",
    requestId: ctx.requestId,
    requestedModel: ctx.modelName,
    provider: ctx.route.provider,
    model: ctx.modelName,
    workspace: ctx.workspace,
    outcome,
    status,
    failureClass,
    elapsedMs: Date.now() - ctx.startedAt,
    ...(toolCalls === undefined ? {} : { toolCalls })
  });
}

function recordConcreteRetry(
  ctx: ConcreteRequestContext,
  status: number,
  failureClass: string
): void {
  recordRouterEvent({
    phase: "retry",
    requestId: ctx.requestId,
    requestedModel: ctx.modelName,
    provider: ctx.route.provider,
    model: ctx.modelName,
    workspace: ctx.workspace,
    status,
    failureClass,
    elapsedMs: Date.now() - ctx.startedAt
  });
}

function recordConcreteAbort(ctx: ConcreteRequestContext): void {
  recordRouterEvent({
    phase: "result",
    requestId: ctx.requestId,
    requestedModel: ctx.modelName,
    provider: ctx.route.provider,
    model: ctx.modelName,
    workspace: ctx.workspace,
    outcome: "failure",
    status: 499,
    failureClass: "client_aborted",
    elapsedMs: Date.now() - ctx.startedAt
  });
}

function endConcreteRequest(
  activitySubject: string,
  requestId: string,
  outcome: "success" | "failure",
  details: {
    hasToolCalls?: boolean;
    inputRequired?: boolean;
    hasActiveSubagents?: boolean;
  } = {}
): void {
  getDefaultUsageTracker().activityTracker.endRequest(activitySubject, {
    requestId,
    outcome,
    ...details
  });
}

function sendConcreteFailureResponse(args: {
  response: ServerResponse;
  route: ProviderRoute;
  requestId: string;
  modelName: string;
  status: number;
  failureClass: string;
}): void {
  const { response, route, requestId, modelName, status, failureClass } = args;
  if (response.writableEnded) return;
  if (response.headersSent) {
    try {
      response.write(
        responseFailureEvent(
          `Direct request to ${modelName} failed with HTTP ${status}.`
        )
      );
    } catch {
      NOOP();
    }
    response.end();
    return;
  }
  const errorType =
    status === 401
      ? "router_authentication_error"
      : status === 502 || status === 503 || status === 504
        ? "router_provider_unavailable"
        : "router_upstream_error";
  const retryable = status === 502 || status === 503 || status === 504;
  const retryAfterMs = retryable ? COOLDOWNS.nextRetryMs([route.provider]) : 0;
  const retryAfterSeconds =
    retryAfterMs > 0 ? Math.max(1, Math.ceil(retryAfterMs / 1000)) : null;
  sendJson(
    response,
    status,
    errorBody(
      status === 401
        ? `Direct concrete request to ${modelName} (${route.provider}) could not authenticate.`
        : `Direct concrete request to ${modelName} (${route.provider}) failed with HTTP ${status}.`,
      errorType,
      {
        code: errorType,
        retryable,
        failureClass,
        provider: route.provider,
        model: modelName,
        requestId
      }
    ),
    {
      "x-autodev-provider": route.provider,
      "x-autodev-model": modelName,
      "x-autodev-request-id": requestId,
      ...(retryAfterSeconds ? { "retry-after": String(retryAfterSeconds) } : {})
    }
  );
}

export async function proxyConcreteResponse(
  response: ServerResponse,
  route: ProviderRoute,
  payload: Record<string, unknown>,
  wantsStream: boolean,
  requestId: string,
  turnMetadataHeader: string | null,
  workspace: { key: string; cwd?: string | null } | null,
  clientSignal: AbortSignal | null = null,
  session: RouterSession | null = null
): Promise<void> {
  const activitySubject = activitySubjectFor(requestId, session);
  const modelName =
    typeof payload.model === "string" ? payload.model : "default";

  if (!ROUTING_POLICY.isProviderEnabledForRole(route.provider, "subagent")) {
    rejectConcreteRequest(response, route, requestId, modelName, workspace);
    return;
  }

  const startedAt = Date.now();
  const sessionKey = session?.key ?? null;
  const ctx: ConcreteRequestContext = {
    response,
    route,
    payload,
    wantsStream,
    requestId,
    turnMetadataHeader,
    workspace,
    clientSignal,
    session,
    activitySubject,
    modelName,
    sessionKey,
    startedAt
  };

  recordRouterEvent({
    phase: "selected",
    requestId,
    requestedModel: modelName,
    provider: route.provider,
    model: modelName,
    workspace
  });
  getDefaultUsageTracker().activityTracker.beginRequest(activitySubject, {
    requestId,
    provider: route.provider,
    model: modelName,
    role:
      usageOrigin(null, route.provider) === "orchestrator"
        ? "orchestrator"
        : null,
    origin: usageOrigin(null, route.provider),
    workspace: workspace?.key ?? null
  });
  const bridgeContext = {
    activitySubject,
    provider: route.provider,
    model: modelName,
    role: null,
    workspace: workspace?.key ?? null,
    sessionKey
  };
  noteBridgeRequest(requestId, bridgeContext);
  noteBridgeSession(sessionKey, { ...bridgeContext, requestId });
  recordNativeMcpExposure({
    route,
    agentRole: null,
    workspace,
    requestId,
    sessionKey
  });
  incrementActiveRequests(route.provider);

  try {
    await runConcreteAttempts(ctx, 0);
  } catch (error) {
    handleConcreteOuterFailure(ctx, error);
  } finally {
    decrementActiveRequests(route.provider);
  }
}

function rejectConcreteRequest(
  response: ServerResponse,
  route: ProviderRoute,
  requestId: string,
  modelName: string,
  workspace: { key: string; cwd?: string | null } | null
): void {
  recordRouterEvent({
    phase: "skipped",
    requestId,
    requestedModel: modelName,
    provider: route.provider,
    model: modelName,
    workspace,
    failureClass: "provider_disabled"
  });
  recordRouterEvent({
    phase: "result",
    requestId,
    requestedModel: modelName,
    provider: route.provider,
    model: modelName,
    workspace,
    outcome: "failure",
    status: 503,
    failureClass: "provider_disabled"
  });
  sendJson(
    response,
    503,
    errorBody(
      `Direct concrete request to ${modelName} (${route.provider}) is unavailable because provider ${route.provider} is disabled.`,
      "router_provider_unavailable",
      {
        code: "router_provider_unavailable",
        retryable: false,
        failureClass: "provider_disabled",
        provider: route.provider,
        model: modelName,
        requestId
      }
    ),
    {
      "x-autodev-provider": route.provider,
      "x-autodev-model": modelName,
      "x-autodev-request-id": requestId
    }
  );
}

async function runConcreteAttempts(
  ctx: ConcreteRequestContext,
  attempts: number
): Promise<void> {
  const maxAttempts = Math.max(
    CONCRETE_STATUS_MAX_ATTEMPTS,
    CONCRETE_TRANSPORT_MAX_ATTEMPTS
  );
  if (attempts >= maxAttempts) return;

  const {
    route,
    payload,
    wantsStream,
    requestId,
    turnMetadataHeader,
    clientSignal,
    session
  } = ctx;

  try {
    const result = await fetchUpstream(
      route,
      payload,
      wantsStream,
      turnMetadataHeader,
      clientSignal,
      null,
      requestId,
      session
    );
    if (!result.ok) {
      await handleConcreteStatusFailure(ctx, result, attempts);
      return;
    }
    await handleConcreteSuccess(ctx, result);
  } catch (error) {
    await handleConcreteTransportError(ctx, error, attempts);
  }
}

async function handleConcreteStatusFailure(
  ctx: ConcreteRequestContext,
  result: FetchUpstreamResult,
  attempts: number
): Promise<void> {
  const {
    response,
    route,
    activitySubject,
    clientSignal,
    requestId,
    modelName
  } = ctx;
  const failureClass = classifyProviderFailure(
    result.status ?? 500,
    result.body
  );
  const canRetry =
    result.retryable &&
    attempts < CONCRETE_STATUS_MAX_ATTEMPTS - 1 &&
    !clientSignal?.aborted &&
    !response.headersSent;
  if (canRetry) {
    recordConcreteRetry(ctx, result.status ?? 500, failureClass);
    await jitteredBackoff();
    if (clientSignal?.aborted) {
      recordConcreteAbort(ctx);
      endConcreteRequest(activitySubject, requestId, "failure");
      return;
    }
    await runConcreteAttempts(ctx, attempts + 1);
    return;
  }
  recordConcreteResult(ctx, "failure", result.status ?? 500, failureClass);
  endConcreteRequest(activitySubject, requestId, "failure");
  if (result.retryable)
    COOLDOWNS.cooldownProvider(
      route.provider,
      cooldownFor(failureClass, result.limit)
    );
  sendConcreteFailureResponse({
    response,
    route,
    requestId,
    modelName,
    status: result.status ?? 500,
    failureClass
  });
}

async function handleConcreteSuccess(
  ctx: ConcreteRequestContext,
  result: { upstream: Response; signal: AbortSignal }
): Promise<void> {
  const responseResult = await writeSuccessfulResponse(
    ctx.response,
    ctx.route,
    { upstream: result.upstream, signal: result.signal },
    ctx.wantsStream,
    ctx.modelName,
    ctx.requestId,
    ctx.modelName,
    () => getDefaultUsageTracker().activityTracker.touch(ctx.activitySubject)
  );
  recordConcreteResult(
    ctx,
    responseResult.failed ? "failure" : "success",
    result.upstream.status,
    responseResult.failed ? "upstream_error" : null,
    responseResult.toolCalls
  );
  endConcreteRequest(
    ctx.activitySubject,
    ctx.requestId,
    responseResult.failed ? "failure" : "success",
    {
      hasToolCalls: responseResult.toolCalls > 0,
      inputRequired: Boolean(responseResult.inputRequired)
    }
  );
}

async function handleConcreteTransportError(
  ctx: ConcreteRequestContext,
  error: unknown,
  attempts: number
): Promise<void> {
  const {
    route,
    activitySubject,
    requestId,
    modelName,
    clientSignal,
    response
  } = ctx;
  logTransportError({
    requestId,
    provider: route.provider,
    model: modelName,
    error,
    workspace: ctx.workspace
  });
  if (
    error &&
    typeof error === "object" &&
    (error as { code?: string }).code === "router_auth_unavailable"
  ) {
    recordConcreteResult(ctx, "failure", 401, "authentication");
    endConcreteRequest(activitySubject, requestId, "failure");
    sendConcreteFailureResponse({
      response,
      route,
      requestId,
      modelName,
      status: 401,
      failureClass: "authentication"
    });
    return;
  }
  if (clientSignal?.aborted) {
    recordConcreteAbort(ctx);
    endConcreteRequest(activitySubject, requestId, "failure");
    return;
  }
  if (attempts < CONCRETE_TRANSPORT_MAX_ATTEMPTS - 1 && !response.headersSent) {
    const failureClass = classifyProviderFailure(
      502,
      error instanceof Error ? error.message : String(error)
    );
    recordConcreteRetry(ctx, 502, failureClass);
    await jitteredBackoff();
    if (clientSignal?.aborted) {
      recordConcreteAbort(ctx);
      endConcreteRequest(activitySubject, requestId, "failure");
      return;
    }
    await runConcreteAttempts(ctx, attempts + 1);
    return;
  }
  const failureClass = classifyProviderFailure(
    502,
    error instanceof Error ? error.message : String(error)
  );
  recordConcreteResult(ctx, "failure", 502, failureClass);
  endConcreteRequest(activitySubject, requestId, "failure");
  COOLDOWNS.cooldownProvider(route.provider, cooldownFor(failureClass));
  sendConcreteFailureResponse({
    response,
    route,
    requestId,
    modelName,
    status: 502,
    failureClass
  });
}

function handleConcreteOuterFailure(
  ctx: ConcreteRequestContext,
  error: unknown
): void {
  const { response, route, activitySubject, requestId, modelName } = ctx;
  const failureClass = classifyProviderFailure(
    502,
    error instanceof Error ? error.message : String(error)
  );
  recordConcreteResult(ctx, "failure", 502, failureClass);
  endConcreteRequest(activitySubject, requestId, "failure");
  if (response.writableEnded) return;
  if (response.headersSent) {
    try {
      response.write(
        responseFailureEvent(
          `Direct request to ${modelName} could not be completed.`
        )
      );
    } catch {
      NOOP();
    }
    response.end();
    return;
  }
  sendJson(
    response,
    502,
    errorBody(
      `Direct concrete request to ${modelName} (${route.provider}) could not be completed.`,
      "router_upstream_error",
      {
        code: "router_upstream_error",
        retryable: true,
        failureClass,
        provider: route.provider,
        model: modelName,
        requestId
      }
    ),
    {
      "x-autodev-provider": route.provider,
      "x-autodev-model": modelName,
      "x-autodev-request-id": requestId
    }
  );
}
type FallbackContext = {
  response: ServerResponse;
  candidates: Candidate[] | OrchestratorCandidate[];
  role: string | null;
  origin: string | null;
  subject: string;
  agentRole: string | null;
  sessionKey: string | null;
  session: RouterSession | null;
  payload: Record<string, unknown>;
  wantsStream: boolean;
  requestId: string;
  turnMetadataHeader: string | null;
  workspace: { key: string; cwd?: string | null } | null;
  clientSignal: AbortSignal | null;
  providerRole: "orchestrator" | "subagent";
  isOrchestratorTurn: boolean;
  isKnownOrchestratorSession: boolean;
  activitySubject: string;
  modelName: string;
  selectionDeadline: number;
  startedAt: number;
};

function recordFallbackSkip(
  ctx: FallbackContext,
  route: Candidate,
  why: string,
  failureClass: string,
  failures: string[]
): void {
  failures.push(`${route.provider}: ${why}`);
  recordRouterEvent({
    phase: "skipped",
    requestId: ctx.requestId,
    role: ctx.role,
    origin: ctx.origin,
    requestedModel: ctx.modelName,
    provider: route.provider,
    model: route.model,
    workspace: ctx.workspace,
    failureClass
  });
}

function recordFallbackSelected(
  ctx: FallbackContext,
  route: Candidate,
  selection: string
): void {
  recordRouterEvent({
    phase: "selected",
    requestId: ctx.requestId,
    role: ctx.role,
    origin: ctx.origin,
    requestedModel: ctx.modelName,
    provider: route.provider,
    model: route.model,
    workspace: ctx.workspace,
    selection
  });
}

function beginCandidateRequest(
  ctx: FallbackContext,
  route: Candidate
): "orchestrator" | null {
  const activityRole =
    ctx.role ??
    ((ctx.origin ?? usageOrigin(ctx.role, route.provider)) === "orchestrator"
      ? "orchestrator"
      : null);
  getDefaultUsageTracker().activityTracker.beginRequest(ctx.activitySubject, {
    requestId: ctx.requestId,
    provider: route.provider,
    model: route.model,
    role: activityRole,
    origin:
      ctx.origin ??
      (ctx.isOrchestratorTurn
        ? "orchestrator"
        : ctx.isKnownOrchestratorSession
          ? "subagent"
          : usageOrigin(ctx.role, route.provider)),
    workspace: ctx.workspace?.key ?? null,
    tag:
      ctx.isKnownOrchestratorSession && !ctx.isOrchestratorTurn
        ? ctx.sessionKey
        : null
  });
  return activityRole;
}

function emitFallbackBridgeContext(
  ctx: FallbackContext,
  route: Candidate
): void {
  if (ctx.sessionKey) touchManagerOpenSubagentSlots(ctx.sessionKey);
  const bridgeContext = {
    activitySubject: ctx.activitySubject,
    provider: route.provider,
    model: route.model,
    role: ctx.role ?? (ctx.origin === "orchestrator" ? "orchestrator" : null),
    workspace: ctx.workspace?.key ?? null,
    sessionKey: ctx.sessionKey
  };
  noteBridgeRequest(ctx.requestId, bridgeContext);
  noteBridgeSession(ctx.sessionKey, {
    ...bridgeContext,
    requestId: ctx.requestId
  });
  recordNativeMcpExposure({
    route,
    agentRole: ctx.agentRole,
    workspace: ctx.workspace,
    requestId: ctx.requestId,
    sessionKey: ctx.sessionKey
  });
  if (ctx.agentRole === ORCHESTRATOR_AGENT_ROLE) {
    noteOrchestratorSession(ctx.sessionKey, route.provider, {
      model: route.model,
      workspace: ctx.workspace?.key ?? null,
      requestId: ctx.requestId
    });
  }
}

export async function proxyFallbackChain(
  response: ServerResponse,
  {
    candidates,
    role = null,
    origin = null,
    subject,
    agentRole = null,
    sessionKey = null,
    session = null
  }: {
    candidates: Candidate[] | OrchestratorCandidate[];
    role?: string | null;
    origin?: string | null;
    subject: string;
    agentRole?: string | null;
    sessionKey?: string | null;
    session?: RouterSession | null;
  },
  payload: Record<string, unknown>,
  wantsStream: boolean,
  requestId: string,
  turnMetadataHeader: string | null,
  workspace: { key: string; cwd?: string | null } | null,
  clientSignal: AbortSignal | null = null
): Promise<void> {
  const isOrchestratorTurn = agentRole === ORCHESTRATOR_AGENT_ROLE;
  const providerRole: "orchestrator" | "subagent" = isOrchestratorTurn
    ? "orchestrator"
    : "subagent";
  const isKnownOrchestratorSession = Boolean(
    sessionKey && orchestratorProviderForSession(sessionKey)
  );
  const activitySubject = activitySubjectFor(
    requestId,
    session ?? (sessionKey ? { key: sessionKey, scope: "identified" } : null),
    {
      subagentOfKnownSession: !isOrchestratorTurn && isKnownOrchestratorSession
    }
  );
  const modelName = String(payload.model ?? "");
  if (!candidates || candidates.length === 0) {
    rejectFallbackChain(
      response,
      requestId,
      role,
      origin,
      modelName,
      subject,
      workspace
    );
    return;
  }
  const failures: string[] = [];
  const attempted = new Set<string>();
  const skipped: Candidate[] = [];
  const startedAt = Date.now();
  const selectionDeadline = startedAt + CHAIN_SELECTION_DEADLINE_MS;
  const fbCtx: FallbackContext = {
    response,
    candidates,
    role,
    origin,
    subject,
    agentRole,
    sessionKey,
    session,
    payload,
    wantsStream,
    requestId,
    turnMetadataHeader,
    workspace,
    clientSignal,
    providerRole,
    isOrchestratorTurn,
    isKnownOrchestratorSession,
    activitySubject,
    modelName,
    selectionDeadline,
    startedAt
  };
  const state = {
    deadlineReached: false,
    lastResortAttempts: 0
  };

  const tryCandidate = async (
    route: Candidate,
    selection: string
  ): Promise<"served" | "terminal" | "fallback" | "unavailable"> => {
    if (
      !ROUTING_POLICY.isProviderEnabledForRole(
        route.provider,
        fbCtx.providerRole
      )
    ) {
      recordFallbackSkip(
        fbCtx,
        route,
        "disabled",
        "provider_disabled",
        failures
      );
      skipped.push(route);
      return "unavailable";
    }
    if (!(await providerAvailable(route))) {
      COOLDOWNS.cooldownProvider(route.provider, {
        failureClass: PROBE_FAILURE_CLASS
      });
      recordFallbackSkip(
        fbCtx,
        route,
        "unavailable",
        PROBE_FAILURE_CLASS,
        failures
      );
      skipped.push(route);
      return "unavailable";
    }
    return attemptCandidate(fbCtx, route, selection, failures, attempted);
  };

  const served = servedOutcome;

  if (
    await runPrimaryPass(
      fbCtx,
      candidates,
      state,
      skipped,
      tryCandidate,
      served
    )
  )
    return;

  if (
    !state.deadlineReached &&
    (await runLastResortPass(
      fbCtx,
      skipped,
      state,
      triedCandidates(attempted),
      tryCandidate,
      served
    ))
  )
    return;

  await runExhaustionWait(fbCtx, candidates, state, tryCandidate, served);

  finalizeFallbackFailure(
    response,
    fbCtx,
    failures,
    state.lastResortAttempts,
    state.deadlineReached,
    attempted
  );
}

function rejectFallbackChain(
  response: ServerResponse,
  requestId: string,
  role: string | null,
  origin: string | null,
  modelName: string,
  subject: string,
  workspace: { key: string; cwd?: string | null } | null
): void {
  recordSpawnFailure({
    requestId,
    role,
    requestedModel: modelName,
    reason: "provider_exhausted"
  });
  closeBridgeSubagentsForRequest(requestId, "failure");
  recordRouterEvent({
    phase: "result",
    requestId,
    role,
    origin,
    requestedModel: modelName,
    provider: null,
    model: null,
    workspace,
    outcome: "failure",
    status: 503,
    failureClass: "provider_disabled"
  });
  sendJson(
    response,
    503,
    errorBody(
      `No enabled providers available for ${subject}.`,
      "router_provider_exhausted",
      {
        code: "router_provider_exhausted",
        retryable: false,
        failureClass: "provider_disabled",
        model: modelName,
        requestId
      }
    ),
    { "x-autodev-request-id": requestId }
  );
}

function triedCandidates(
  attempted: Set<string>
): (provider: string) => boolean {
  return (provider: string) => attempted.has(provider);
}

async function tryPrimaryRoute(
  ctx: FallbackContext,
  candidates: Candidate[] | OrchestratorCandidate[],
  index: number,
  state: { deadlineReached: boolean; lastResortAttempts: number },
  skipped: Candidate[],
  tryCandidate: (
    route: Candidate,
    selection: string
  ) => Promise<"served" | "terminal" | "fallback" | "unavailable">,
  served: (outcome: string) => boolean
): Promise<boolean> {
  if (index >= candidates.length) return false;
  const route = candidates[index]!;
  if (Date.now() > ctx.selectionDeadline) {
    state.deadlineReached = true;
    return false;
  }
  if (
    !ROUTING_POLICY.isProviderEnabledForRole(route.provider, ctx.providerRole)
  ) {
    recordFallbackSkip(ctx, route, "disabled", "provider_disabled", []);
    skipped.push(route);
    return tryPrimaryRoute(
      ctx,
      candidates,
      index + 1,
      state,
      skipped,
      tryCandidate,
      served
    );
  }
  if (COOLDOWNS.isCooling(route.provider)) {
    recordFallbackSkip(
      ctx,
      route,
      "cooldown active",
      COOLDOWNS.get(route.provider)?.failureClass ?? "cooldown",
      []
    );
    skipped.push(route);
    return tryPrimaryRoute(
      ctx,
      candidates,
      index + 1,
      state,
      skipped,
      tryCandidate,
      served
    );
  }
  if (served(await tryCandidate(route, "primary"))) return true;
  return tryPrimaryRoute(
    ctx,
    candidates,
    index + 1,
    state,
    skipped,
    tryCandidate,
    served
  );
}

function runPrimaryPass(
  ctx: FallbackContext,
  candidates: Candidate[] | OrchestratorCandidate[],
  state: { deadlineReached: boolean; lastResortAttempts: number },
  skipped: Candidate[],
  tryCandidate: (
    route: Candidate,
    selection: string
  ) => Promise<"served" | "terminal" | "fallback" | "unavailable">,
  served: (outcome: string) => boolean
): Promise<boolean> {
  return tryPrimaryRoute(
    ctx,
    candidates,
    0,
    state,
    skipped,
    tryCandidate,
    served
  );
}

async function tryLastResortRoute(
  ctx: FallbackContext,
  eligible: Candidate[],
  index: number,
  state: { deadlineReached: boolean; lastResortAttempts: number },
  tryCandidate: (
    route: Candidate,
    selection: string
  ) => Promise<"served" | "terminal" | "fallback" | "unavailable">,
  served: (outcome: string) => boolean
): Promise<boolean> {
  if (index >= eligible.length) return false;
  const route = eligible[index]!;
  if (Date.now() > ctx.selectionDeadline) {
    state.deadlineReached = true;
    return false;
  }
  state.lastResortAttempts += 1;
  if (served(await tryCandidate(route, "last_resort"))) return true;
  return tryLastResortRoute(
    ctx,
    eligible,
    index + 1,
    state,
    tryCandidate,
    served
  );
}

function runLastResortPass(
  ctx: FallbackContext,
  skipped: Candidate[],
  state: { deadlineReached: boolean; lastResortAttempts: number },
  isTried: (provider: string) => boolean,
  tryCandidate: (
    route: Candidate,
    selection: string
  ) => Promise<"served" | "terminal" | "fallback" | "unavailable">,
  served: (outcome: string) => boolean
): Promise<boolean> {
  if (state.deadlineReached) return false;
  const eligible = skipped
    .filter(
      (route) =>
        ROUTING_POLICY.isProviderEnabledForRole(
          route.provider,
          ctx.providerRole
        ) &&
        !isTried(route.provider) &&
        COOLDOWNS.allowsLastResort(COOLDOWNS.get(route.provider)) &&
        countLiveAgentActivity({ provider: route.provider }) === 0
    )
    .sort(
      (a, b) =>
        (COOLDOWNS.get(a.provider)?.until ?? 0) -
        (COOLDOWNS.get(b.provider)?.until ?? 0)
    )
    .slice(0, LAST_RESORT_MAX_ATTEMPTS);
  return tryLastResortRoute(ctx, eligible, 0, state, tryCandidate, served);
}

async function runExhaustionWait(
  ctx: FallbackContext,
  candidates: Candidate[] | OrchestratorCandidate[],
  state: { deadlineReached: boolean; lastResortAttempts: number },
  tryCandidate: (
    route: Candidate,
    selection: string
  ) => Promise<"served" | "terminal" | "fallback" | "unavailable">,
  served: (outcome: string) => boolean
): Promise<void> {
  const attempted = new Set<string>(); // placeholder; actual set tracked elsewhere
  const waitCandidates = candidates.filter(
    (route) =>
      ROUTING_POLICY.isProviderEnabledForRole(
        route.provider,
        ctx.providerRole
      ) && !attempted.has(route.provider)
  );
  const waitMs = COOLDOWNS.nextRetryMs(
    waitCandidates.map(({ provider }) => provider)
  );
  if (
    !state.deadlineReached &&
    EXHAUSTION_WAIT_MS > 0 &&
    waitMs > 0 &&
    waitMs <= EXHAUSTION_WAIT_MS &&
    !ctx.clientSignal?.aborted &&
    !ctx.response.headersSent
  ) {
    recordRouterEvent({
      phase: "exhaustion_wait",
      requestId: ctx.requestId,
      role: ctx.role,
      origin: ctx.origin,
      requestedModel: ctx.modelName,
      provider: null,
      model: null,
      workspace: ctx.workspace,
      elapsedMs: waitMs
    });
    await delay(waitMs, ctx.clientSignal);
    if (!ctx.clientSignal?.aborted) {
      await tryExhaustionRoute(waitCandidates, 0, tryCandidate, served);
    }
  }
}

async function tryExhaustionRoute(
  waitCandidates: Candidate[],
  index: number,
  tryCandidate: (
    route: Candidate,
    selection: string
  ) => Promise<"served" | "terminal" | "fallback" | "unavailable">,
  served: (outcome: string) => boolean
): Promise<boolean> {
  if (index >= waitCandidates.length) return false;
  const route = waitCandidates[index]!;
  if (COOLDOWNS.isCooling(route.provider)) {
    return tryExhaustionRoute(waitCandidates, index + 1, tryCandidate, served);
  }
  const outcome = await tryCandidate(route, "exhaustion_wait");
  if (served(outcome)) return true;
  if (outcome !== "unavailable") return false;
  return tryExhaustionRoute(waitCandidates, index + 1, tryCandidate, served);
}

function finalizeFallbackFailure(
  response: ServerResponse,
  ctx: FallbackContext,
  failures: string[],
  lastResortAttempts: number,
  deadlineReached: boolean,
  _attempted: Set<string>
): void {
  recordSpawnFailure({
    requestId: ctx.requestId,
    role: ctx.role,
    requestedModel: ctx.modelName,
    reason: deadlineReached ? "selection_deadline" : "provider_exhausted"
  });
  closeBridgeSubagentsForRequest(ctx.requestId, "failure");
  getDefaultUsageTracker().activityTracker.endRequest(ctx.activitySubject, {
    requestId: ctx.requestId,
    outcome: "failure",
    hasToolCalls: false
  });
  const summary = COOLDOWNS.summary(
    ctx.candidates.map(({ provider }) => provider),
    Date.now(),
    ctx.providerRole
  );
  sendJson(
    response,
    503,
    exhaustionBody({
      subject: ctx.subject,
      summary,
      failures,
      model: ctx.modelName,
      requestId: ctx.requestId,
      lastResortAttempts,
      deadlineReached
    }),
    exhaustionHeaders({ summary, requestId: ctx.requestId })
  );
}

async function attemptCandidate(
  ctx: FallbackContext,
  route: Candidate,
  selection: string,
  failures: string[],
  _attempted: Set<string>
): Promise<"served" | "terminal" | "fallback"> {
  const attemptStartedAt = Date.now();
  _attempted.add(route.provider);
  recordFallbackSelected(ctx, route, selection);
  beginCandidateRequest(ctx, route);
  emitFallbackBridgeContext(ctx, route);
  incrementActiveRequests(route.provider);

  try {
    const result = await fetchUpstream(
      route,
      payloadForCandidate(ctx.payload, route),
      ctx.wantsStream,
      ctx.turnMetadataHeader,
      ctx.clientSignal,
      ctx.agentRole,
      ctx.requestId,
      ctx.session
    );
    if (result.ok) {
      return await handleCandidateSuccess(
        ctx,
        route,
        result,
        selection,
        attemptStartedAt
      );
    }
    return handleCandidateUpstreamFailure(
      ctx,
      route,
      result,
      selection,
      failures,
      attemptStartedAt
    );
  } catch (error) {
    return handleCandidateTransportError(
      ctx,
      route,
      selection,
      failures,
      attemptStartedAt,
      error
    );
  } finally {
    decrementActiveRequests(route.provider);
  }
}

async function handleCandidateSuccess(
  ctx: FallbackContext,
  route: Candidate,
  result: { upstream: Response; signal: AbortSignal },
  selection: string,
  attemptStartedAt: number
): Promise<"served" | "terminal" | "fallback"> {
  try {
    const responseResult = await writeSuccessfulResponse(
      ctx.response,
      route,
      { upstream: result.upstream, signal: result.signal },
      ctx.wantsStream,
      ctx.modelName,
      ctx.requestId,
      route.model,
      () => {
        getDefaultUsageTracker().activityTracker.touch(ctx.activitySubject);
        if (ctx.sessionKey) {
          getDefaultUsageTracker().activityTracker.touch(ctx.sessionKey);
          touchManagerOpenSubagentSlots(ctx.sessionKey);
        }
      }
    );
    if (responseResult.failed) {
      const failureClass =
        responseResult.limit?.limitClass ??
        (responseResult.incompleteReason ? "unavailable" : "upstream_error");
      COOLDOWNS.cooldownProvider(
        route.provider,
        cooldownFor(failureClass, responseResult.limit)
      );
      recordRouterEvent({
        phase: "result",
        requestId: ctx.requestId,
        role: ctx.role,
        origin: ctx.origin,
        requestedModel: ctx.modelName,
        provider: route.provider,
        model: route.model,
        workspace: ctx.workspace,
        outcome: "failure",
        status: result.upstream.status,
        failureClass,
        elapsedMs: Date.now() - attemptStartedAt,
        toolCalls: responseResult.toolCalls,
        selection
      });
      getDefaultUsageTracker().activityTracker.endRequest(ctx.activitySubject, {
        requestId: ctx.requestId,
        outcome: "failure",
        hasToolCalls: responseResult.toolCalls > 0,
        inputRequired: Boolean(responseResult.inputRequired)
      });
      return "served";
    }
    COOLDOWNS.clear(route.provider);
    recordRouterEvent({
      phase: "result",
      requestId: ctx.requestId,
      role: ctx.role,
      origin: ctx.origin,
      requestedModel: ctx.modelName,
      provider: route.provider,
      model: route.model,
      workspace: ctx.workspace,
      outcome: "success",
      status: result.upstream.status,
      elapsedMs: Date.now() - attemptStartedAt,
      toolCalls: responseResult.toolCalls,
      selection
    });
    getDefaultUsageTracker().activityTracker.endRequest(ctx.activitySubject, {
      requestId: ctx.requestId,
      outcome: "success",
      hasToolCalls: responseResult.toolCalls > 0,
      inputRequired: Boolean(responseResult.inputRequired),
      hasActiveSubagents:
        ctx.isOrchestratorTurn && ctx.sessionKey
          ? hasActiveBridgeSubagentsForSession(ctx.sessionKey) ||
            getDefaultConcurrencyManager().activeSubagentThreads() > 0
          : false
    });
  } catch (streamError) {
    COOLDOWNS.cooldownProvider(route.provider, cooldownFor("upstream_error"));
    throw streamError;
  }
  return "served";
}

function handleCandidateUpstreamFailure(
  ctx: FallbackContext,
  route: Candidate,
  result: FetchUpstreamResult,
  selection: string,
  failures: string[],
  attemptStartedAt: number
): "served" | "terminal" | "fallback" {
  const failureClass =
    result.limit?.limitClass ??
    classifyProviderFailure(result.status ?? 500, result.body);
  failures.push(`${route.provider}: HTTP ${result.status}`);
  recordRouterEvent({
    phase: "result",
    requestId: ctx.requestId,
    role: ctx.role,
    origin: ctx.origin,
    requestedModel: ctx.modelName,
    provider: route.provider,
    model: route.model,
    workspace: ctx.workspace,
    outcome: "failure",
    status: result.status,
    failureClass,
    elapsedMs: Date.now() - attemptStartedAt,
    selection
  });
  if (!fallbackable(result.status ?? 500, result.body)) {
    ctx.response.writeHead(result.status ?? 500, {
      "content-type": "application/json",
      "x-autodev-provider": route.provider,
      "x-autodev-model": route.model,
      "x-autodev-request-id": ctx.requestId,
      "x-autodev-router-instance-id": ROUTER_INSTANCE_ID
    });
    ctx.response.end(result.body);
    getDefaultUsageTracker().activityTracker.endRequest(ctx.activitySubject, {
      requestId: ctx.requestId,
      outcome: "failure",
      hasToolCalls: false
    });
    return "terminal";
  }
  COOLDOWNS.cooldownProvider(
    route.provider,
    cooldownFor(failureClass, result.limit)
  );
  return "fallback";
}

function handleCandidateTransportError(
  ctx: FallbackContext,
  route: Candidate,
  selection: string,
  failures: string[],
  attemptStartedAt: number,
  error: unknown
): "served" | "terminal" | "fallback" {
  const isAuthFailure =
    (error as { code?: string } | undefined)?.code ===
    "router_auth_unavailable";
  const failureClass = isAuthFailure
    ? "authentication"
    : classifyProviderFailure(
        502,
        error instanceof Error ? error.message : String(error)
      );
  if (!isAuthFailure)
    logTransportError({
      requestId: ctx.requestId,
      role: ctx.role,
      requestedModel: ctx.modelName,
      provider: route.provider,
      model: route.model,
      error,
      workspace: ctx.workspace
    });
  failures.push(`${route.provider}: ${failureClass}`);
  recordRouterEvent({
    phase: "result",
    requestId: ctx.requestId,
    role: ctx.role,
    origin: ctx.origin,
    requestedModel: ctx.modelName,
    provider: route.provider,
    model: route.model,
    workspace: ctx.workspace,
    outcome: "failure",
    status: 502,
    failureClass,
    elapsedMs: Date.now() - attemptStartedAt,
    selection
  });
  COOLDOWNS.cooldownProvider(route.provider, cooldownFor(failureClass));
  if (ctx.response.headersSent) {
    if (!ctx.response.writableEnded) {
      try {
        ctx.response.write(
          responseFailureEvent(
            `Router could not complete ${ctx.subject}: ${failureClass}.`
          )
        );
      } catch {
        NOOP();
      }
      ctx.response.end();
    }
    getDefaultUsageTracker().activityTracker.endRequest(ctx.activitySubject, {
      requestId: ctx.requestId,
      outcome: "failure",
      hasToolCalls: false
    });
    return "served";
  }
  return "fallback";
}

export function proxyRoleResponse(
  response: ServerResponse,
  role: string,
  payload: Record<string, unknown>,
  wantsStream: boolean,
  requestId: string,
  turnMetadataHeader: string | null,
  workspace: { key: string; cwd?: string | null } | null,
  clientSignal: AbortSignal | null = null,
  session: RouterSession | null = null
): Promise<void> {
  return proxyFallbackChain(
    response,
    {
      candidates: ROUTING_POLICY.roleCandidates(
        role,
        Math.random,
        TOOL_CALL_OWNERSHIP.ownerFor(payload)
      ),
      role,
      agentRole: role,
      subject: `role ${role}`,
      sessionKey: session?.key ?? null,
      session
    },
    payload,
    wantsStream,
    requestId,
    turnMetadataHeader,
    workspace,
    clientSignal
  );
}

export function proxyOrchestratorResponse(
  response: ServerResponse,
  payload: Record<string, unknown>,
  wantsStream: boolean,
  requestId: string,
  turnMetadataHeader: string | null,
  workspace: { key: string; cwd?: string | null } | null,
  clientSignal: AbortSignal | null = null,
  session: RouterSession | null = null
): Promise<void> {
  const sessionKey = session?.key ?? null;
  // The provider that issued the calls being answered comes first; otherwise
  // an orchestrator mid-session stays with the provider it started on.
  const preferred =
    TOOL_CALL_OWNERSHIP.ownerFor(payload) ??
    (carriesPendingToolResult(payload)
      ? orchestratorProviderForSession(sessionKey)
      : null);
  return proxyFallbackChain(
    response,
    {
      candidates: ROUTING_POLICY.orchestratorCandidates(Math.random, preferred),
      role: null,
      origin: "orchestrator",
      agentRole: ORCHESTRATOR_AGENT_ROLE,
      subject: "the orchestrator",
      sessionKey,
      session
    },
    payload,
    wantsStream,
    requestId,
    turnMetadataHeader,
    workspace,
    clientSignal
  );
}
