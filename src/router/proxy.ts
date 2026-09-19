import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { ServerResponse } from 'node:http';
import {
  INCOMPLETE_REASON_INTERRUPTED,
  INCOMPLETE_REASON_TIMEOUT,
  LIMIT_HEADER_CLASS,
  LIMIT_HEADER_RESETS_AT,
  LIMIT_SOURCE_REPORTED,
  normalizeResetsAt,
  readLimitHeaders,
  terminalIncompleteEvents,
  type ProviderLimit,
} from '../shared/provider-limits.ts';
import {
  collectToolCallIds,
  countToolCallsFromSse,
  countToolCallsInResponse,
  responseTextFromSse,
  rewriteResponseValue,
  transformSseEvent,
  upstreamPayload,
  type RouterProviderRouteLike,
} from './responses.ts';
import { TOOL_CALL_OWNERSHIP } from './tool-call-ownership.ts';
import {
  COOLDOWN_CONFIG,
  COOLDOWNS,
  PROBE_FAILURE_CLASS,
  type CooldownSummary,
} from './cooldown.ts';
import {
  ROUTES,
  ROUTING_CONFIG as ROUTING,
  ROUTING_POLICY,
  type Candidate,
  type OrchestratorCandidate,
  type ProviderRoute,
} from './routing.ts';
import {
  touchOpenSubagentSlots as touchManagerOpenSubagentSlots,
  getDefaultConcurrencyManager,
} from './concurrency.ts';
import {
  classifyProviderFailure,
  recordRouterEvent,
} from './events.ts';
import {
  AGENT_ROLE_HEADER,
  FORWARDED_REQUEST_HEADERS,
  ORCHESTRATOR_AGENT_ROLE,
  SESSION_ID_HEADER,
  SESSION_SCOPE_HEADER,
  bridgeTelemetryHeaders as subagentBridgeTelemetryHeaders,
  closeBridgeSubagentsForRequest,
  hasActiveBridgeSubagentsForSession,
  mcpContractForRole as subagentMcpContractForRole,
  noteBridgeRequest,
  noteBridgeSession,
  noteOrchestratorSession,
  orchestratorProviderForSession,
  providerCapabilities,
  recordSpawnFailure,
} from './subagents.ts';
import {
  UNATTRIBUTED_DIMENSION,
  countLiveAgentActivity,
  getDefaultUsageTracker,
  usageOrigin,
} from './usage.ts';
import { recordMcpExposure } from './otel.ts';

const CODEX_HOME = process.env.CODEX_HOME ?? `${process.env.HOME ?? process.cwd()}/.codex`;
const AUTH_FILE = process.env.CODEX_ROUTER_AUTH_FILE ?? `${CODEX_HOME}/auth.json`;
const HOST = process.env.CODEX_MODEL_ROUTER_HOST ?? '127.0.0.1';
const PORT = Number.parseInt(process.env.CODEX_MODEL_ROUTER_PORT ?? '4100', 10);
const AGENT_EVENTS_PATH = '/v1/agent-events';
const AGENT_EVENTS_URL = `http://${HOST}:${PORT}${AGENT_EVENTS_PATH}`;

export const ROUTER_INSTANCE_ID = randomUUID();

export const CLIENT_DISCONNECT_CODES = Object.freeze(new Set([
  'EPIPE',
  'ECONNRESET',
  'ERR_STREAM_DESTROYED',
  'ERR_STREAM_WRITE_AFTER_END',
]));

const defaultContractPath = fileURLToPath(new URL('../../config/execution-contract.json', import.meta.url));
const EXECUTION_CONTRACT_FILE = process.env.CODEX_EXECUTION_CONTRACT_FILE
  ?? (existsSync(defaultContractPath)
    ? defaultContractPath
    : `${CODEX_HOME}/config/execution-contract.json`);

let loadedExecutionContract: Record<string, unknown> = {};
try {
  loadedExecutionContract = JSON.parse(readFileSync(EXECUTION_CONTRACT_FILE, 'utf8'));
} catch {
  loadedExecutionContract = {};
}

export function positiveDuration(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export const PROBE_TIMEOUT_MS = positiveDuration(process.env.CODEX_ROUTER_PROBE_TIMEOUT_MS, 700);
export const LAST_RESORT_MAX_ATTEMPTS = positiveDuration(process.env.CODEX_ROUTER_LAST_RESORT_MAX_ATTEMPTS, 2);
export const EXHAUSTION_WAIT_MS = Number.parseInt(process.env.CODEX_ROUTER_EXHAUSTION_WAIT_MS ?? '', 10) >= 0
  ? Number.parseInt(process.env.CODEX_ROUTER_EXHAUSTION_WAIT_MS!, 10)
  : 20_000;
export const CHAIN_SELECTION_DEADLINE_MS = positiveDuration(process.env.CODEX_ROUTER_CHAIN_SELECTION_DEADLINE_MS, 120_000);
export const UPSTREAM_TIMEOUT_MS = positiveDuration(process.env.CODEX_ROUTER_UPSTREAM_TIMEOUT_MS, 900_000);
export const CONCRETE_RETRY_BASE_MS = positiveDuration(process.env.CODEX_ROUTER_CONCRETE_RETRY_MS, 200);
export const CONCRETE_RETRY_MAX_MS = Math.max(CONCRETE_RETRY_BASE_MS, positiveDuration(process.env.CODEX_ROUTER_CONCRETE_RETRY_MAX_MS, 2_000));
export const CONCRETE_STATUS_MAX_ATTEMPTS = 2;
export const CONCRETE_TRANSPORT_MAX_ATTEMPTS = Math.max(
  CONCRETE_STATUS_MAX_ATTEMPTS,
  positiveDuration(process.env.CODEX_ROUTER_CONCRETE_TRANSPORT_RETRY_LIMIT, 3),
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
  if (!error || typeof error !== 'object') return false;
  const code = (error as { code?: string }).code;
  if (typeof code === 'string' && CLIENT_DISCONNECT_CODES.has(code)) return true;
  const cause = (error as { cause?: { code?: string } }).cause;
  if (cause && typeof cause === 'object' && typeof cause.code === 'string' && CLIENT_DISCONNECT_CODES.has(cause.code)) {
    return true;
  }
  return false;
}

export function transportErrorInfo(error: unknown): { name: string; code: string | null; syscall: string | null } {
  const err = error && typeof error === 'object' ? (error as { name?: string; code?: string; cause?: { code?: string; syscall?: string } }) : null;
  const cause = err?.cause ?? null;
  return {
    name: err && typeof err.name === 'string' ? err.name : 'Error',
    code: err && typeof err.code === 'string'
      ? err.code
      : cause && typeof cause.code === 'string' ? cause.code : null,
    syscall: cause && typeof cause.syscall === 'string' ? cause.syscall : null,
  };
}

export function logTransportError({
  requestId,
  role = null,
  provider,
  model,
  requestedModel = model,
  error,
  workspace,
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
    phase: 'transport_error',
    requestId,
    role,
    requestedModel,
    provider,
    model,
    workspace,
    errorName: info.name,
    errorCode: info.code,
    syscall: info.syscall,
  });
}

export async function jitteredBackoff(): Promise<number> {
  const floor = Math.min(CONCRETE_RETRY_BASE_MS, CONCRETE_RETRY_MAX_MS);
  const ceiling = Math.max(floor, Math.min(CONCRETE_RETRY_MAX_MS, CONCRETE_RETRY_BASE_MS * 2));
  const delayMs = floor + Math.floor(Math.random() * (ceiling - floor + 1));
  await new Promise((resolve) => setTimeout(resolve, delayMs));
  return delayMs;
}

export async function loadCodexAuth(): Promise<{ token: string; accountId: string }> {
  const auth = JSON.parse(await readFile(AUTH_FILE, 'utf8'));
  const token = auth.tokens?.access_token;
  const accountId = auth.tokens?.account_id;
  if (!token || !accountId) throw new Error(`Codex auth is missing access_token or account_id in ${AUTH_FILE}`);
  return { token, accountId };
}

export function carriesPendingToolResult(payload: unknown): boolean {
  const input = payload && typeof payload === 'object' && 'input' in payload && Array.isArray((payload as { input: unknown[] }).input)
    ? (payload as { input: Array<Record<string, unknown>> }).input
    : [];
  for (const item of input) {
    if (item?.type === 'custom_tool_call_output' || item?.type === 'function_call_output') return true;
  }
  return false;
}

export function mcpContractForRole(agentRole: string | null, contract = loadedExecutionContract): string[] {
  return subagentMcpContractForRole(agentRole, contract);
}

export function bridgeTelemetryHeaders(
  route: ProviderRoute,
  requestId: string | null,
  options: { executionContract?: unknown; agentEventsUrl?: string } = {},
): Record<string, string> {
  return subagentBridgeTelemetryHeaders(route, requestId, {
    executionContract: options.executionContract ?? loadedExecutionContract,
    agentEventsUrl: options.agentEventsUrl ?? AGENT_EVENTS_URL,
  });
}

export function recordNativeMcpExposure({
  route,
  agentRole,
  workspace,
  requestId,
  sessionKey,
}: {
  route: ProviderRoute | Candidate | null;
  agentRole: string | null;
  workspace?: { key: string; cwd?: string | null } | null;
  requestId: string | null;
  sessionKey: string | null;
}): void {
  if (route?.provider !== 'codex') return;
  const model = 'model' in (route ?? {}) && typeof (route as Candidate).model === 'string' ? (route as Candidate).model : 'codex';
  const context = {
    provider: route.provider,
    model,
    role: agentRole === ORCHESTRATOR_AGENT_ROLE ? 'orchestrator' : (agentRole ?? 'default'),
    workspace: workspace?.key ?? UNATTRIBUTED_DIMENSION,
    agent: sessionKey ?? UNATTRIBUTED_DIMENSION,
    sessionKey,
  };
  for (const server of mcpContractForRole(agentRole)) {
    recordMcpExposure({ server, source: 'role_contract', context, requestId });
  }
}

export function downstreamHeaders(
  route: ProviderRoute,
  auth: { token: string; accountId: string } | null,
  turnMetadataHeader: string | null,
  agentRole: string | null = null,
  requestId: string | null = null,
  session: { key: string; scope: string } | null = null,
): Record<string, string> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    accept: 'text/event-stream',
    ...bridgeTelemetryHeaders(route, requestId),
  };
  if (route.envKey) {
    const key = process.env[route.envKey];
    if (key) headers.authorization = `Bearer ${key}`;
  } else if (auth) {
    headers.authorization = `Bearer ${auth.token}`;
    headers['chatgpt-account-id'] = auth.accountId;
  }
  if (route.provider === 'codex') headers.connection = 'close';
  if (turnMetadataHeader) headers[FORWARDED_REQUEST_HEADERS[0]!] = turnMetadataHeader;
  if (agentRole) headers[AGENT_ROLE_HEADER] = agentRole;
  if (session?.key && route.provider !== 'codex') {
    headers[SESSION_ID_HEADER] = session.key;
    headers[SESSION_SCOPE_HEADER] = session.scope ?? 'identified';
  }
  return headers;
}

export function declaredLimit(headers: unknown, body: unknown): ProviderLimit | null {
  const fromHeaders = readLimitHeaders(headers as Parameters<typeof readLimitHeaders>[0]);
  if (fromHeaders) {
    return {
      limitClass: fromHeaders.limitClass,
      limitType: fromHeaders.limitType ?? null,
      resetsAt: fromHeaders.resetsAt ?? null,
      source: fromHeaders.source ?? LIMIT_SOURCE_REPORTED,
    };
  }
  try {
    const declared = JSON.parse(String(body ?? ''))?.error?.limit;
    if (!declared?.class) return null;
    return {
      limitClass: String(declared.class).toLowerCase(),
      limitType: declared.type ? String(declared.type).toLowerCase() : null,
      resetsAt: normalizeResetsAt(declared.resets_at),
      source: declared.source === LIMIT_SOURCE_REPORTED ? LIMIT_SOURCE_REPORTED : 'inferred',
    };
  } catch {
    return null;
  }
}

export function cooldownFor(failureClass: string, limit: ProviderLimit | null = null): {
  failureClass: string;
  resetsAt: string | null;
  structured: boolean;
} {
  return {
    failureClass: limit?.limitClass ?? failureClass,
    resetsAt: limit?.resetsAt ?? null,
    structured: limit?.source === LIMIT_SOURCE_REPORTED,
  };
}

export function fallbackable(status: number, body: unknown): boolean {
  if ([401, 408, 429, 500, 502, 503, 504].includes(status)) return true;
  if (status === 400 && /invalid model|model name.*(invalid|not found)|unknown model/i.test(String(body ?? ''))) return true;
  return /(quota|rate.?limit|weekly.?limit|usage.?limit|usage exhausted|session|high.?demand|credit|timeout|timed.?out|overloaded|temporarily unavailable|unavailable)/i.test(String(body ?? ''));
}

export async function providerAvailable(route: ProviderRoute): Promise<boolean> {
  if (!ROUTING_POLICY.routeCredentialAvailable(route)) return false;
  if (route.provider === 'codex') {
    try { await loadCodexAuth(); return true; } catch { return false; }
  }
  if (!route.healthUrl) return true;
  try {
    const result = await fetch(route.healthUrl, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
    return result.ok;
  } catch {
    return false;
  }
}

export function payloadForCandidate(
  payload: Record<string, unknown>,
  candidate: { model: string; reasoningEffort?: string | null },
): Record<string, unknown> {
  const next: Record<string, unknown> = { ...payload, model: candidate.model };
  if (candidate.reasoningEffort) {
    const base = payload.reasoning && typeof payload.reasoning === 'object' && !Array.isArray(payload.reasoning)
      ? (payload.reasoning as Record<string, unknown>)
      : {};
    next.reasoning = { ...base, effort: candidate.reasoningEffort };
  }
  return next;
}

export function responseWasNotCompleted(response: Record<string, unknown> | null | undefined): boolean {
  return response?.status != null && response.status !== 'completed';
}

export function incompleteFromResponse(parsed: Record<string, unknown> | null | undefined): {
  incompleteReason: string | null;
  limit: ProviderLimit | null;
} {
  const details = parsed?.incomplete_details as Record<string, unknown> | undefined;
  const declared = details?.provider_limit as Record<string, unknown> | undefined;
  return {
    incompleteReason: (details?.reason as string | undefined) ?? null,
    limit: declared?.class
      ? {
        limitClass: String(declared.class).toLowerCase(),
        limitType: declared.type ? String(declared.type).toLowerCase() : null,
        resetsAt: normalizeResetsAt(declared.resets_at),
        source: declared.source === LIMIT_SOURCE_REPORTED ? LIMIT_SOURCE_REPORTED : 'inferred',
      }
      : null,
  };
}

export function responseFailureEvent(message: string): string {
  return `event: response.failed\ndata: ${JSON.stringify({
    type: 'response.failed',
    response: {
      id: `router_${Date.now()}`,
      object: 'response',
      status: 'failed',
      error: { type: 'upstream_error', message },
    },
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

export async function writeResponseStream(
  response: ServerResponse,
  upstream: Response,
  publicModel: string,
  signal: AbortSignal | null = null,
  onHeartbeat: (() => void) | null = null,
): Promise<StreamWriteResult> {
  const decoder = new TextDecoder();
  const seenToolCalls = new Set<string>();
  const toolCallIds = new Set<string>();
  let toolCalls = 0;
  let buffer = '';
  let terminal: 'completed' | 'failed' | null = null;
  const streamState = {
    sawCreated: false,
    responseId: null as string | null,
    model: publicModel,
    itemId: null as string | null,
    reasoningId: null as string | null,
    text: '',
    reasoning: '',
  };
  let incompleteReason: string | null = null;
  let reportedLimit: ProviderLimit | null = null;

  const onResponseError = () => {};
  response.on('error', onResponseError);

  const isWritable = () => !response.writableEnded && !response.destroyed && !response.closed && !signal?.aborted;
  const safeWrite = (chunk: string | Uint8Array) => {
    if (!isWritable()) return false;
    try {
      return response.write(chunk);
    } catch {
      return false;
    }
  };

  const keepAlive = setInterval(() => {
    safeWrite(': codex-router keep-alive\n\n');
    onHeartbeat?.();
  }, 2000);

  const inspectEvent = (event: string) => {
    for (const line of event.split(/\r?\n/)) {
      if (!line.startsWith('data: ') || line.slice(6) === '[DONE]') continue;
      try {
        const parsed = JSON.parse(line.slice(6));
        if (parsed.type === 'response.created') {
          streamState.sawCreated = true;
          streamState.responseId = parsed.response?.id ?? streamState.responseId;
        } else if (parsed.type === 'response.output_item.added') {
          if (parsed.item?.type === 'reasoning') streamState.reasoningId = parsed.item.id ?? streamState.reasoningId;
          if (parsed.item?.type === 'message') streamState.itemId = parsed.item.id ?? streamState.itemId;
          collectToolCallIds(parsed.item, toolCallIds);
        } else if (parsed.type === 'response.output_item.done') {
          collectToolCallIds(parsed.item, toolCallIds);
        } else if (parsed.type === 'response.output_text.delta') {
          streamState.text += String(parsed.delta ?? '');
          streamState.itemId = parsed.item_id ?? streamState.itemId;
        } else if (parsed.type === 'response.reasoning_summary_text.delta') {
          streamState.reasoning += String(parsed.delta ?? '');
          streamState.reasoningId = parsed.item_id ?? streamState.reasoningId;
        } else if (parsed.type === 'response.failed') {
          terminal = 'failed';
        } else if (parsed.type === 'response.completed') {
          collectToolCallIds(parsed.response, toolCallIds);
          terminal = responseWasNotCompleted(parsed.response) ? 'failed' : 'completed';
          const details = parsed.response?.incomplete_details;
          if (details?.reason) incompleteReason = details.reason;
          const declared = details?.provider_limit;
          if (declared?.class) {
            reportedLimit = {
              limitClass: String(declared.class).toLowerCase(),
              limitType: declared.type ? String(declared.type).toLowerCase() : null,
              resetsAt: normalizeResetsAt(declared.resets_at),
              source: declared.source === LIMIT_SOURCE_REPORTED ? LIMIT_SOURCE_REPORTED : 'inferred',
            };
          }
        }
      } catch {
        /* tolerant parsing */
      }
    }
  };

  const flushEvents = (flush = false) => {
    while (isWritable()) {
      const boundary = buffer.match(/\r?\n\r?\n/);
      if (!boundary) break;
      const end = boundary.index! + boundary[0]!.length;
      const event = buffer.slice(0, end);
      inspectEvent(event);
      toolCalls += countToolCallsFromSse(event, seenToolCalls);
      safeWrite(transformSseEvent(event, publicModel));
      buffer = buffer.slice(end);
    }
    if (flush && buffer && isWritable()) {
      inspectEvent(buffer);
      toolCalls += countToolCallsFromSse(buffer, seenToolCalls);
      safeWrite(transformSseEvent(buffer, publicModel));
      buffer = '';
    }
  };

  const closeIncomplete = (reason: string, message: string) => {
    if (!isWritable()) return;
    if (!streamState.sawCreated) {
      safeWrite(responseFailureEvent(message));
      return;
    }
    incompleteReason = incompleteReason ?? reason;
    for (const [eventName, body] of terminalIncompleteEvents({
      responseId: streamState.responseId ?? `router_${Date.now()}`,
      itemId: streamState.itemId ?? `msg_${Date.now()}`,
      reasoningId: streamState.reasoningId ?? `rs_${Date.now()}`,
      text: streamState.text,
      reasoningText: streamState.reasoning,
      reason,
      limit: reportedLimit,
      response: { id: streamState.responseId, object: 'response', created_at: Math.floor(Date.now() / 1000), model: publicModel },
    })) {
      safeWrite(`event: ${eventName}\ndata: ${JSON.stringify(body)}\n\n`);
    }
  };

  const streamResult = (): StreamWriteResult => ({
    toolCalls,
    toolCallIds,
    failed: terminal !== 'completed',
    incompleteReason,
    limit: reportedLimit,
    inputRequired: incompleteReason === 'input_required' || incompleteReason === 'requires_action',
  });

  if (!upstream.body) {
    clearInterval(keepAlive);
    safeWrite(responseFailureEvent('Upstream provider returned no response body.'));
    response.removeListener('error', onResponseError);
    return streamResult();
  }

  try {
    for await (const chunk of upstream.body as AsyncIterable<Uint8Array>) {
      if (!isWritable()) break;
      buffer += decoder.decode(chunk, { stream: true });
      flushEvents();
    }
    if (isWritable()) {
      buffer += decoder.decode();
      flushEvents(true);
    }
  } catch (error) {
    if (isWritable()) {
      const timedOut = signal?.aborted && (signal.reason as { name?: string } | undefined)?.name === 'TimeoutError';
      const message = timedOut
        ? `Upstream provider exceeded the ${Math.ceil(UPSTREAM_TIMEOUT_MS / 1000)}s response timeout.`
        : error instanceof Error ? error.message : String(error);
      closeIncomplete(timedOut ? INCOMPLETE_REASON_TIMEOUT : INCOMPLETE_REASON_INTERRUPTED, message);
    }
    return streamResult();
  } finally {
    clearInterval(keepAlive);
    response.removeListener('error', onResponseError);
  }

  if (terminal === null) {
    closeIncomplete(INCOMPLETE_REASON_INTERRUPTED, 'Upstream provider closed the stream before response.completed.');
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
  session: { key: string; scope: string } | null = null,
): Promise<FetchUpstreamResult> {
  let auth = null;
  if (route.provider === 'codex') {
    try {
      auth = await loadCodexAuth();
    } catch (error) {
      const authError = new Error('Codex authentication is unavailable.');
      (authError as { code?: string }).code = 'router_auth_unavailable';
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
    { normalizeItemIds: providerCapabilities(route.provider).normalizeItemIds },
  );
  const timeoutSignal = AbortSignal.timeout(UPSTREAM_TIMEOUT_MS);
  const signal = clientSignal ? AbortSignal.any([clientSignal, timeoutSignal]) : timeoutSignal;
  const upstream = await fetch(`${route.baseUrl}/responses`, {
    method: 'POST',
    headers: downstreamHeaders(route, auth, turnMetadataHeader, agentRole, requestId, session),
    signal,
    body: JSON.stringify(requestPayload),
  });
  if (!upstream.ok) {
    const body = await upstream.text();
    return {
      ok: false,
      status: upstream.status,
      body,
      limit: declaredLimit(upstream.headers, body),
      retryable: [502, 503, 504].includes(upstream.status),
    };
  }
  return { ok: true, upstream, signal };
}

export function sendJson(
  response: ServerResponse,
  status: number,
  body: unknown,
  extraHeaders: Record<string, string> = {},
): void {
  const encoded = Buffer.from(JSON.stringify(body));
  response.writeHead(status, {
    'content-type': 'application/json',
    'content-length': encoded.length,
    connection: 'close',
    'x-autodev-router-instance-id': ROUTER_INSTANCE_ID,
    ...extraHeaders,
  });
  response.end(encoded);
}

export function errorBody(
  message: string,
  type = 'invalid_request_error',
  context: {
    code?: string | null;
    retryable?: boolean | null;
    failureClass?: string | null;
    provider?: string | null;
    model?: string | null;
    requestId?: string | null;
    details?: Record<string, unknown> | null;
  } = {},
): Record<string, unknown> {
  const pickString = (value: unknown) => typeof value === 'string' && value ? value : null;
  const pickBool = (value: unknown) => typeof value === 'boolean' ? value : null;
  return {
    error: {
      message,
      type,
      code: pickString(context.code) ?? (typeof type === 'string' && type ? type : null),
      retryable: pickBool(context.retryable),
      failureClass: pickString(context.failureClass),
      provider: pickString(context.provider),
      model: pickString(context.model),
      requestId: pickString(context.requestId),
      routerInstanceId: ROUTER_INSTANCE_ID,
      details: context.details && typeof context.details === 'object' && !Array.isArray(context.details) ? context.details : null,
    },
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
  onHeartbeat: (() => void) | null = null,
): Promise<StreamWriteResult> {
  const written = await writeProviderResponse(response, route, result, wantsStream, publicModel, requestId, resolvedModel, onHeartbeat);
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
  onHeartbeat: (() => void) | null,
): Promise<StreamWriteResult> {
  const responseHeaders = {
    'x-autodev-provider': route.provider,
    'x-autodev-model': resolvedModel,
    'x-autodev-request-id': requestId,
    'x-autodev-router-instance-id': ROUTER_INSTANCE_ID,
  };
  const upstream = result.upstream;
  if (wantsStream) {
    response.writeHead(upstream.status, {
      ...responseHeaders,
      'content-type': upstream.headers.get('content-type') ?? 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'close',
    });
    const streamResult = await writeResponseStream(response, upstream, publicModel, result.signal, onHeartbeat);
    if (!response.writableEnded && !response.destroyed && !response.closed) {
      try { response.end(); } catch {}
    }
    return streamResult;
  }
  const body = await upstream.text();
  const hasInputRequired = (parsed: Record<string, unknown> | null, incomplete: { incompleteReason: string | null } | null) =>
    parsed?.status === 'requires_action'
    || parsed?.status === 'input_required'
    || incomplete?.incompleteReason === 'input_required'
    || incomplete?.incompleteReason === 'requires_action';

  if (route.provider === 'codex') {
    const toolCalls = countToolCallsFromSse(body);
    const parsed = rewriteResponseValue(responseTextFromSse(body), publicModel) as Record<string, unknown>;
    sendJson(response, upstream.status, parsed, responseHeaders);
    const incomplete = incompleteFromResponse(parsed);
    const toolCallIds = new Set<string>();
    collectToolCallIds(parsed, toolCallIds);
    return { toolCalls, toolCallIds, failed: responseWasNotCompleted(parsed), ...incomplete, inputRequired: hasInputRequired(parsed, incomplete) };
  }
  try {
    const parsed = JSON.parse(body);
    const toolCalls = countToolCallsInResponse(parsed);
    const rewritten = rewriteResponseValue(parsed, publicModel) as Record<string, unknown>;
    sendJson(response, upstream.status, rewritten, responseHeaders);
    const incomplete = incompleteFromResponse(rewritten);
    const toolCallIds = new Set<string>();
    collectToolCallIds(rewritten, toolCallIds);
    return { toolCalls, toolCallIds, failed: responseWasNotCompleted(rewritten), ...incomplete, inputRequired: hasInputRequired(rewritten, incomplete) };
  } catch {
    response.writeHead(upstream.status, { ...responseHeaders, 'content-type': upstream.headers.get('content-type') ?? 'application/json' });
    response.end(body);
    return { toolCalls: 0, toolCallIds: new Set(), failed: false, incompleteReason: null, limit: null, inputRequired: false };
  }
}

export function soonestReset(summary: CooldownSummary[]): CooldownSummary | null {
  return summary
    .filter((entry) => entry.resetsAt)
    .sort((a, b) => Date.parse(a.resetsAt!) - Date.parse(b.resetsAt!))[0] ?? null;
}

export function delay(ms: number, signal: AbortSignal | null = null): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(finish, ms);
    function finish() {
      clearTimeout(timer);
      signal?.removeEventListener?.('abort', finish);
      resolve();
    }
    signal?.addEventListener?.('abort', finish, { once: true });
  });
}

export function exhaustionBody({
  subject,
  summary,
  failures,
  model,
  requestId,
  lastResortAttempts,
  deadlineReached,
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
    (soonest, entry) => (entry.retryAfterMs > 0 && (soonest === 0 || entry.retryAfterMs < soonest) ? entry.retryAfterMs : soonest),
    0,
  );
  const hard = summary.filter((entry) => entry.state === 'hard');
  const everyCandidateHardLimited = hard.length > 0 && hard.length === summary.length;
  const reset = soonestReset(summary);
  const described = summary.map((entry) => {
    if (entry.state === 'available') return `${entry.provider}: available but did not complete the turn`;
    if (entry.resetsAt) return `${entry.provider}: ${entry.failureClass ?? entry.state}, resets at ${entry.resetsAt}`;
    return `${entry.provider}: ${entry.failureClass ?? entry.state}, retry in ${Math.ceil(entry.retryAfterMs / 1000)}s`;
  });
  const action = everyCandidateHardLimited ? 'summarize_and_yield' : 'retry_after';
  const guidance = everyCandidateHardLimited
    ? `Every provider is out of usage${reset ? ` until at least ${reset.resetsAt}` : ''}. Return a summary of the work completed so far rather than retrying.`
    : `Retry after approximately ${Math.max(1, Math.ceil(retryAfterMs / 1000))}s.`;
  const reason = deadlineReached
    ? `No available provider completed ${subject} within the ${Math.ceil(CHAIN_SELECTION_DEADLINE_MS / 1000)}s provider-selection budget.`
    : `No available provider completed ${subject}.`;
  return errorBody(`${reason} ${described.join('; ')}. ${guidance}`, 'router_provider_exhausted', {
    code: 'router_provider_exhausted',
    retryable: true,
    failureClass: everyCandidateHardLimited ? (hard[0]?.failureClass ?? 'quota_exhausted') : 'unavailable',
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
      now: new Date(now).toISOString(),
    },
  });
}

export function exhaustionHeaders({
  summary,
  requestId,
}: {
  summary: CooldownSummary[];
  requestId: string;
}): Record<string, string> {
  const retryAfterMs = summary.reduce(
    (soonest, entry) => (entry.retryAfterMs > 0 && (soonest === 0 || entry.retryAfterMs < soonest) ? entry.retryAfterMs : soonest),
    0,
  );
  const headers: Record<string, string> = {
    'x-autodev-request-id': requestId,
    'retry-after': String(Math.max(1, Math.ceil(retryAfterMs / 1000))),
  };
  const reset = soonestReset(summary);
  if (reset) {
    headers[LIMIT_HEADER_RESETS_AT] = reset.resetsAt!;
    if (reset.failureClass) headers[LIMIT_HEADER_CLASS] = reset.failureClass;
  }
  return headers;
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
  session: { key: string; scope: string } | null = null,
): Promise<void> {
  const activitySubject = `req:${requestId}`;
  const modelName = typeof payload.model === 'string' ? payload.model : 'default';
  if (!ROUTING_POLICY.isProviderEnabled(route.provider)) {
    recordRouterEvent({ phase: 'skipped', requestId, requestedModel: modelName, provider: route.provider, model: modelName, workspace, failureClass: 'provider_disabled' });
    recordRouterEvent({ phase: 'result', requestId, requestedModel: modelName, provider: route.provider, model: modelName, workspace, outcome: 'failure', status: 503, failureClass: 'provider_disabled' });
    sendJson(
      response,
      503,
      errorBody(
        `Direct concrete request to ${modelName} (${route.provider}) is unavailable because provider ${route.provider} is disabled.`,
        'router_provider_unavailable',
        { code: 'router_provider_unavailable', retryable: false, failureClass: 'provider_disabled', provider: route.provider, model: modelName, requestId },
      ),
      {
        'x-autodev-provider': route.provider,
        'x-autodev-model': modelName,
        'x-autodev-request-id': requestId,
      },
    );
    return;
  }
  const startedAt = Date.now();
  recordRouterEvent({ phase: 'selected', requestId, requestedModel: modelName, provider: route.provider, model: modelName, workspace });
  getDefaultUsageTracker().activityTracker.beginRequest(activitySubject, {
    requestId,
    provider: route.provider,
    model: modelName,
    role: usageOrigin(null, route.provider) === 'orchestrator' ? 'orchestrator' : null,
    origin: usageOrigin(null, route.provider),
    workspace: workspace?.key ?? null,
  });
  incrementActiveRequests(route.provider);

  let attempts = 0;
  const maxAttempts = Math.max(CONCRETE_STATUS_MAX_ATTEMPTS, CONCRETE_TRANSPORT_MAX_ATTEMPTS);
  const sendFailureResponse = (status: number, failureClass: string) => {
    if (response.writableEnded) return;
    if (response.headersSent) {
      try { response.write(responseFailureEvent(`Direct request to ${modelName} failed with HTTP ${status}.`)); } catch {}
      response.end();
      return;
    }
    const errorType = status === 401
      ? 'router_authentication_error'
      : status === 502 || status === 503 || status === 504 ? 'router_provider_unavailable' : 'router_upstream_error';
    const retryable = status === 502 || status === 503 || status === 504;
    const retryAfterMs = retryable ? COOLDOWNS.nextRetryMs([route.provider]) : 0;
    const retryAfterSeconds = retryAfterMs > 0 ? Math.max(1, Math.ceil(retryAfterMs / 1000)) : null;
    sendJson(
      response,
      status,
      errorBody(
        status === 401
          ? `Direct concrete request to ${modelName} (${route.provider}) could not authenticate.`
          : `Direct concrete request to ${modelName} (${route.provider}) failed with HTTP ${status}.`,
        errorType,
        { code: errorType, retryable, failureClass, provider: route.provider, model: modelName, requestId },
      ),
      {
        'x-autodev-provider': route.provider,
        'x-autodev-model': modelName,
        'x-autodev-request-id': requestId,
        ...(retryAfterSeconds ? { 'retry-after': String(retryAfterSeconds) } : {}),
      },
    );
  };

  const sessionKey = session?.key ?? null;
  const bridgeContext = { provider: route.provider, model: modelName, role: null, workspace: workspace?.key ?? null, sessionKey };
  noteBridgeRequest(requestId, bridgeContext);
  noteBridgeSession(sessionKey, { ...bridgeContext, requestId });
  recordNativeMcpExposure({ route, agentRole: null, workspace, requestId, sessionKey });

  try {
    while (attempts < maxAttempts) {
      try {
        const result = await fetchUpstream(route, payload, wantsStream, turnMetadataHeader, clientSignal, null, requestId, session);
        if (!result.ok) {
          const failureClass = classifyProviderFailure(result.status ?? 500, result.body);
          const canRetry = result.retryable && attempts < CONCRETE_STATUS_MAX_ATTEMPTS - 1 && !clientSignal?.aborted && !response.headersSent;
          if (canRetry) {
            recordRouterEvent({ phase: 'retry', requestId, requestedModel: modelName, provider: route.provider, model: modelName, workspace, status: result.status, failureClass, elapsedMs: Date.now() - startedAt });
            attempts += 1;
            await jitteredBackoff();
            if (clientSignal?.aborted) {
              recordRouterEvent({ phase: 'result', requestId, requestedModel: modelName, provider: route.provider, model: modelName, workspace, outcome: 'failure', status: 499, failureClass: 'client_aborted', elapsedMs: Date.now() - startedAt });
              getDefaultUsageTracker().activityTracker.endRequest(activitySubject, { requestId, outcome: 'failure', hasToolCalls: false });
              return;
            }
            continue;
          }
          recordRouterEvent({ phase: 'result', requestId, requestedModel: modelName, provider: route.provider, model: modelName, workspace, outcome: 'failure', status: result.status, failureClass, elapsedMs: Date.now() - startedAt });
          getDefaultUsageTracker().activityTracker.endRequest(activitySubject, { requestId, outcome: 'failure', hasToolCalls: false });
          if (result.retryable) COOLDOWNS.cooldownProvider(route.provider, cooldownFor(failureClass, result.limit));
          sendFailureResponse(result.status ?? 500, failureClass);
          return;
        }
        const responseResult = await writeSuccessfulResponse(
          response,
          route,
          { upstream: result.upstream!, signal: result.signal! },
          wantsStream,
          modelName,
          requestId,
          modelName,
          () => getDefaultUsageTracker().activityTracker.touch(activitySubject),
        );
        recordRouterEvent({
          phase: 'result',
          requestId,
          requestedModel: modelName,
          provider: route.provider,
          model: modelName,
          workspace,
          outcome: responseResult.failed ? 'failure' : 'success',
          status: result.upstream!.status,
          failureClass: responseResult.failed ? 'upstream_error' : null,
          elapsedMs: Date.now() - startedAt,
          toolCalls: responseResult.toolCalls,
        });
        getDefaultUsageTracker().activityTracker.endRequest(activitySubject, {
          requestId,
          outcome: responseResult.failed ? 'failure' : 'success',
          hasToolCalls: responseResult.toolCalls > 0,
          inputRequired: Boolean(responseResult.inputRequired),
        });
        return;
      } catch (error) {
        logTransportError({ requestId, provider: route.provider, model: modelName, error, workspace });
        if (error && typeof error === 'object' && (error as { code?: string }).code === 'router_auth_unavailable') {
          recordRouterEvent({ phase: 'result', requestId, requestedModel: modelName, provider: route.provider, model: modelName, workspace, outcome: 'failure', status: 401, failureClass: 'authentication', elapsedMs: Date.now() - startedAt });
          getDefaultUsageTracker().activityTracker.endRequest(activitySubject, { requestId, outcome: 'failure', hasToolCalls: false });
          sendFailureResponse(401, 'authentication');
          return;
        }
        if (clientSignal?.aborted) {
          recordRouterEvent({ phase: 'result', requestId, requestedModel: modelName, provider: route.provider, model: modelName, workspace, outcome: 'failure', status: 499, failureClass: 'client_aborted', elapsedMs: Date.now() - startedAt });
          getDefaultUsageTracker().activityTracker.endRequest(activitySubject, { requestId, outcome: 'failure', hasToolCalls: false });
          return;
        }
        if (attempts < CONCRETE_TRANSPORT_MAX_ATTEMPTS - 1 && !response.headersSent) {
          const failureClass = classifyProviderFailure(502, error instanceof Error ? error.message : String(error));
          recordRouterEvent({ phase: 'retry', requestId, requestedModel: modelName, provider: route.provider, model: modelName, workspace, status: 502, failureClass, elapsedMs: Date.now() - startedAt });
          attempts += 1;
          await jitteredBackoff();
          if (clientSignal?.aborted) {
            recordRouterEvent({ phase: 'result', requestId, requestedModel: modelName, provider: route.provider, model: modelName, workspace, outcome: 'failure', status: 499, failureClass: 'client_aborted', elapsedMs: Date.now() - startedAt });
            getDefaultUsageTracker().activityTracker.endRequest(activitySubject, { requestId, outcome: 'failure', hasToolCalls: false });
            return;
          }
          continue;
        }
        const failureClass = classifyProviderFailure(502, error instanceof Error ? error.message : String(error));
        recordRouterEvent({ phase: 'result', requestId, requestedModel: modelName, provider: route.provider, model: modelName, workspace, outcome: 'failure', status: 502, failureClass, elapsedMs: Date.now() - startedAt });
        getDefaultUsageTracker().activityTracker.endRequest(activitySubject, { requestId, outcome: 'failure', hasToolCalls: false });
        COOLDOWNS.cooldownProvider(route.provider, cooldownFor(failureClass));
        sendFailureResponse(502, failureClass);
        return;
      }
    }
  } catch (error) {
    const failureClass = classifyProviderFailure(502, error instanceof Error ? error.message : String(error));
    recordRouterEvent({ phase: 'result', requestId, requestedModel: modelName, provider: route.provider, model: modelName, workspace, outcome: 'failure', status: 502, failureClass, elapsedMs: Date.now() - startedAt });
    getDefaultUsageTracker().activityTracker.endRequest(activitySubject, { requestId, outcome: 'failure', hasToolCalls: false });
    if (!response.writableEnded) {
      if (response.headersSent) {
        try { response.write(responseFailureEvent(`Direct request to ${modelName} could not be completed.`)); } catch {}
        response.end();
      } else {
        sendJson(
          response,
          502,
          errorBody(`Direct concrete request to ${modelName} (${route.provider}) could not be completed.`, 'router_upstream_error', {
            code: 'router_upstream_error',
            retryable: true,
            failureClass,
            provider: route.provider,
            model: modelName,
            requestId,
          }),
          { 'x-autodev-provider': route.provider, 'x-autodev-model': modelName, 'x-autodev-request-id': requestId },
        );
      }
    }
  } finally {
    decrementActiveRequests(route.provider);
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
    session = null,
  }: {
    candidates: Candidate[] | OrchestratorCandidate[];
    role?: string | null;
    origin?: string | null;
    subject: string;
    agentRole?: string | null;
    sessionKey?: string | null;
    session?: { key: string; scope: string } | null;
  },
  payload: Record<string, unknown>,
  wantsStream: boolean,
  requestId: string,
  turnMetadataHeader: string | null,
  workspace: { key: string; cwd?: string | null } | null,
  clientSignal: AbortSignal | null = null,
): Promise<void> {
  const isOrchestratorTurn = agentRole === ORCHESTRATOR_AGENT_ROLE;
  const isKnownOrchestratorSession = Boolean(sessionKey && orchestratorProviderForSession(sessionKey));
  const activitySubject = (!isOrchestratorTurn && isKnownOrchestratorSession)
    ? `req:${requestId}`
    : (sessionKey || `req:${requestId}`);
  const modelName = String(payload.model ?? '');
  if (!candidates || candidates.length === 0) {
    recordSpawnFailure({ requestId, role, requestedModel: modelName, reason: 'provider_exhausted' });
    closeBridgeSubagentsForRequest(requestId, 'failure');
    recordRouterEvent({ phase: 'result', requestId, role, origin, requestedModel: modelName, provider: null, model: null, workspace, outcome: 'failure', status: 503, failureClass: 'provider_disabled' });
    sendJson(
      response,
      503,
      errorBody(
        `No enabled providers available for ${subject}.`,
        'router_provider_exhausted',
        { code: 'router_provider_exhausted', retryable: false, failureClass: 'provider_disabled', model: modelName, requestId },
      ),
      { 'x-autodev-request-id': requestId },
    );
    return;
  }
  const failures: string[] = [];
  const attempted = new Set<string>();
  const skipped: Candidate[] = [];
  const startedAt = Date.now();
  const selectionDeadline = startedAt + CHAIN_SELECTION_DEADLINE_MS;
  let deadlineReached = false;
  let lastResortAttempts = 0;

  const noteSkip = (route: Candidate, why: string, failureClass: string) => {
    failures.push(`${route.provider}: ${why}`);
    skipped.push(route);
    recordRouterEvent({ phase: 'skipped', requestId, role, origin, requestedModel: modelName, provider: route.provider, model: route.model, workspace, failureClass });
  };

  const attemptCandidate = async (route: Candidate, selection: string): Promise<'served' | 'terminal' | 'fallback'> => {
    const attemptStartedAt = Date.now();
    attempted.add(route.provider);
    recordRouterEvent({ phase: 'selected', requestId, role, origin, requestedModel: modelName, provider: route.provider, model: route.model, workspace, selection });
    const activityRole = role ?? ((origin ?? usageOrigin(role, route.provider)) === 'orchestrator' ? 'orchestrator' : null);
    getDefaultUsageTracker().activityTracker.beginRequest(activitySubject, {
      requestId,
      provider: route.provider,
      model: route.model,
      role: activityRole,
      origin: origin ?? (isOrchestratorTurn ? 'orchestrator' : isKnownOrchestratorSession ? 'subagent' : usageOrigin(role, route.provider)),
      workspace: workspace?.key ?? null,
      tag: (isKnownOrchestratorSession && !isOrchestratorTurn) ? sessionKey : null,
    });
    if (sessionKey) touchManagerOpenSubagentSlots(sessionKey);
    const bridgeContext = { provider: route.provider, model: route.model, role: role ?? (origin === 'orchestrator' ? 'orchestrator' : null), workspace: workspace?.key ?? null, sessionKey };
    noteBridgeRequest(requestId, bridgeContext);
    noteBridgeSession(sessionKey, { ...bridgeContext, requestId });
    recordNativeMcpExposure({ route, agentRole, workspace, requestId, sessionKey });
    if (agentRole === ORCHESTRATOR_AGENT_ROLE) {
      noteOrchestratorSession(sessionKey, route.provider, { model: route.model, workspace: workspace?.key ?? null, requestId });
    }
    incrementActiveRequests(route.provider);

    try {
      const result = await fetchUpstream(route, payloadForCandidate(payload, route), wantsStream, turnMetadataHeader, clientSignal, agentRole, requestId, session);
      if (result.ok) {
        try {
          const responseResult = await writeSuccessfulResponse(
            response,
            route,
            { upstream: result.upstream!, signal: result.signal! },
            wantsStream,
            modelName,
            requestId,
            route.model,
            () => {
              getDefaultUsageTracker().activityTracker.touch(activitySubject);
              if (sessionKey) {
                getDefaultUsageTracker().activityTracker.touch(sessionKey);
                touchManagerOpenSubagentSlots(sessionKey);
              }
            },
          );
          if (responseResult.failed) {
            const failureClass = responseResult.limit?.limitClass ?? (responseResult.incompleteReason ? 'unavailable' : 'upstream_error');
            COOLDOWNS.cooldownProvider(route.provider, cooldownFor(failureClass, responseResult.limit));
            recordRouterEvent({ phase: 'result', requestId, role, origin, requestedModel: modelName, provider: route.provider, model: route.model, workspace, outcome: 'failure', status: result.upstream!.status, failureClass, elapsedMs: Date.now() - attemptStartedAt, toolCalls: responseResult.toolCalls, selection });
            getDefaultUsageTracker().activityTracker.endRequest(activitySubject, { requestId, outcome: 'failure', hasToolCalls: responseResult.toolCalls > 0, inputRequired: Boolean(responseResult.inputRequired) });
            return 'served';
          }
          COOLDOWNS.clear(route.provider);
          recordRouterEvent({ phase: 'result', requestId, role, origin, requestedModel: modelName, provider: route.provider, model: route.model, workspace, outcome: 'success', status: result.upstream!.status, elapsedMs: Date.now() - attemptStartedAt, toolCalls: responseResult.toolCalls, selection });
          getDefaultUsageTracker().activityTracker.endRequest(activitySubject, {
            requestId,
            outcome: 'success',
            hasToolCalls: responseResult.toolCalls > 0,
            inputRequired: Boolean(responseResult.inputRequired),
            hasActiveSubagents: isOrchestratorTurn && sessionKey
              ? (hasActiveBridgeSubagentsForSession(sessionKey) || getDefaultConcurrencyManager().activeSubagentThreads() > 0)
              : false,
          });
        } catch (streamError) {
          COOLDOWNS.cooldownProvider(route.provider, cooldownFor('upstream_error'));
          throw streamError;
        }
        return 'served';
      }
      const failureClass = result.limit?.limitClass ?? classifyProviderFailure(result.status ?? 500, result.body);
      failures.push(`${route.provider}: HTTP ${result.status}`);
      recordRouterEvent({ phase: 'result', requestId, role, origin, requestedModel: modelName, provider: route.provider, model: route.model, workspace, outcome: 'failure', status: result.status, failureClass, elapsedMs: Date.now() - attemptStartedAt, selection });
      if (!fallbackable(result.status ?? 500, result.body)) {
        response.writeHead(result.status ?? 500, {
          'content-type': 'application/json',
          'x-autodev-provider': route.provider,
          'x-autodev-model': route.model,
          'x-autodev-request-id': requestId,
          'x-autodev-router-instance-id': ROUTER_INSTANCE_ID,
        });
        response.end(result.body);
        getDefaultUsageTracker().activityTracker.endRequest(activitySubject, { requestId, outcome: 'failure', hasToolCalls: false });
        return 'terminal';
      }
      COOLDOWNS.cooldownProvider(route.provider, cooldownFor(failureClass, result.limit));
      return 'fallback';
    } catch (error) {
      const isAuthFailure = (error as { code?: string } | undefined)?.code === 'router_auth_unavailable';
      const failureClass = isAuthFailure ? 'authentication' : classifyProviderFailure(502, error instanceof Error ? error.message : String(error));
      if (!isAuthFailure) logTransportError({ requestId, role, requestedModel: modelName, provider: route.provider, model: route.model, error, workspace });
      failures.push(`${route.provider}: ${failureClass}`);
      recordRouterEvent({ phase: 'result', requestId, role, origin, requestedModel: modelName, provider: route.provider, model: route.model, workspace, outcome: 'failure', status: 502, failureClass, elapsedMs: Date.now() - attemptStartedAt, selection });
      COOLDOWNS.cooldownProvider(route.provider, cooldownFor(failureClass));
      if (response.headersSent) {
        if (!response.writableEnded) {
          try { response.write(responseFailureEvent(`Router could not complete ${subject}: ${failureClass}.`)); } catch {}
          response.end();
        }
        getDefaultUsageTracker().activityTracker.endRequest(activitySubject, { requestId, outcome: 'failure', hasToolCalls: false });
        return 'served';
      }
      return 'fallback';
    } finally {
      decrementActiveRequests(route.provider);
    }
  };

  const tryCandidate = async (route: Candidate, selection: string): Promise<'served' | 'terminal' | 'fallback' | 'unavailable'> => {
    if (!ROUTING_POLICY.isProviderEnabled(route.provider)) {
      noteSkip(route, 'disabled', 'provider_disabled');
      return 'unavailable';
    }
    if (!(await providerAvailable(route))) {
      COOLDOWNS.cooldownProvider(route.provider, { failureClass: PROBE_FAILURE_CLASS });
      noteSkip(route, 'unavailable', PROBE_FAILURE_CLASS);
      return 'unavailable';
    }
    return attemptCandidate(route, selection);
  };
  const served = (outcome: string) => outcome === 'served' || outcome === 'terminal';

  // Pass 1: candidates that are not cooling
  for (const route of candidates) {
    if (Date.now() > selectionDeadline) { deadlineReached = true; break; }
    if (!ROUTING_POLICY.isProviderEnabled(route.provider)) {
      noteSkip(route, 'disabled', 'provider_disabled');
      continue;
    }
    if (COOLDOWNS.isCooling(route.provider)) {
      noteSkip(route, 'cooldown active', COOLDOWNS.get(route.provider)?.failureClass ?? 'cooldown');
      continue;
    }
    if (served(await tryCandidate(route, 'primary'))) return;
  }

  // Pass 2: last resort pass
  if (!deadlineReached) {
    const eligible = skipped
      .filter((route) => ROUTING_POLICY.isProviderEnabled(route.provider) && !attempted.has(route.provider) && COOLDOWNS.allowsLastResort(COOLDOWNS.get(route.provider)) && countLiveAgentActivity({ provider: route.provider }) === 0)
      .sort((a, b) => (COOLDOWNS.get(a.provider)?.until ?? 0) - (COOLDOWNS.get(b.provider)?.until ?? 0))
      .slice(0, LAST_RESORT_MAX_ATTEMPTS);
    for (const route of eligible) {
      if (Date.now() > selectionDeadline) { deadlineReached = true; break; }
      lastResortAttempts += 1;
      if (served(await tryCandidate(route, 'last_resort'))) return;
    }
  }

  // Pass 3: exhaustion wait
  const waitCandidates = candidates.filter((route) => ROUTING_POLICY.isProviderEnabled(route.provider) && !attempted.has(route.provider));
  const waitMs = COOLDOWNS.nextRetryMs(waitCandidates.map(({ provider }) => provider));
  if (!deadlineReached && EXHAUSTION_WAIT_MS > 0 && waitMs > 0 && waitMs <= EXHAUSTION_WAIT_MS && !clientSignal?.aborted && !response.headersSent) {
    recordRouterEvent({ phase: 'exhaustion_wait', requestId, role, origin, requestedModel: modelName, provider: null, model: null, workspace, elapsedMs: waitMs });
    await delay(waitMs, clientSignal);
    if (!clientSignal?.aborted) {
      for (const route of waitCandidates) {
        if (COOLDOWNS.isCooling(route.provider)) continue;
        const outcome = await tryCandidate(route, 'exhaustion_wait');
        if (served(outcome)) return;
        if (outcome !== 'unavailable') break;
      }
    }
  }

  recordSpawnFailure({ requestId, role, requestedModel: modelName, reason: deadlineReached ? 'selection_deadline' : 'provider_exhausted' });
  closeBridgeSubagentsForRequest(requestId, 'failure');
  getDefaultUsageTracker().activityTracker.endRequest(activitySubject, { requestId, outcome: 'failure', hasToolCalls: false });
  const summary = COOLDOWNS.summary(candidates.map(({ provider }) => provider));
  sendJson(
    response,
    503,
    exhaustionBody({ subject, summary, failures, model: modelName, requestId, lastResortAttempts, deadlineReached }),
    exhaustionHeaders({ summary, requestId }),
  );
}

export async function proxyRoleResponse(
  response: ServerResponse,
  role: string,
  payload: Record<string, unknown>,
  wantsStream: boolean,
  requestId: string,
  turnMetadataHeader: string | null,
  workspace: { key: string; cwd?: string | null } | null,
  clientSignal: AbortSignal | null = null,
  session: { key: string; scope: string } | null = null,
): Promise<void> {
  return proxyFallbackChain(
    response,
    {
      candidates: ROUTING_POLICY.roleCandidates(role, Math.random, TOOL_CALL_OWNERSHIP.ownerFor(payload)),
      role,
      agentRole: role,
      subject: `role ${role}`,
      sessionKey: session?.key ?? null,
      session,
    },
    payload,
    wantsStream,
    requestId,
    turnMetadataHeader,
    workspace,
    clientSignal,
  );
}

export async function proxyOrchestratorResponse(
  response: ServerResponse,
  payload: Record<string, unknown>,
  wantsStream: boolean,
  requestId: string,
  turnMetadataHeader: string | null,
  workspace: { key: string; cwd?: string | null } | null,
  clientSignal: AbortSignal | null = null,
  session: { key: string; scope: string } | null = null,
): Promise<void> {
  const sessionKey = session?.key ?? null;
  // The provider that issued the calls being answered comes first; otherwise
  // an orchestrator mid-session stays with the provider it started on.
  const preferred = TOOL_CALL_OWNERSHIP.ownerFor(payload)
    ?? (carriesPendingToolResult(payload) ? orchestratorProviderForSession(sessionKey) : null);
  return proxyFallbackChain(
    response,
    {
      candidates: ROUTING_POLICY.orchestratorCandidates(Math.random, preferred),
      role: null,
      origin: 'orchestrator',
      agentRole: ORCHESTRATOR_AGENT_ROLE,
      subject: 'the orchestrator',
      sessionKey,
      session,
    },
    payload,
    wantsStream,
    requestId,
    turnMetadataHeader,
    workspace,
    clientSignal,
  );
}
