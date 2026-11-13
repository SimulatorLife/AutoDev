import { randomUUID } from "node:crypto";
import type { ServerResponse } from "node:http";

import type { Span } from "@opentelemetry/api";
import { SIGN_IN_REQUIRED_FAILURE_CLASS } from "@simulatorlife/autodev-core";
import { isLoopbackAddress } from "@simulatorlife/autodev-runtime/router/auth";
import { getDefaultConcurrencyManager } from "@simulatorlife/autodev-runtime/router/concurrency";
import {
  COOLDOWN_CONFIG,
  type CooldownEntry,
  type CooldownOptions,
  COOLDOWNS,
  type CooldownSummary,
  PROBE_FAILURE_CLASS
} from "@simulatorlife/autodev-runtime/router/cooldown";
import {
  classifyProviderFailure,
  INVALID_MODEL_PATTERN,
  isRequestRefusalClass,
  type ProviderFailureClass,
  recordRouterEvent
} from "@simulatorlife/autodev-runtime/router/events";
import { scheduleRouterStatePersist } from "@simulatorlife/autodev-runtime/router/persistence";
import {
  type Candidate,
  type OrchestratorCandidate,
  type ProviderRoute,
  type RouteDisabledReason,
  ROUTING_CONFIG,
  ROUTING_POLICY
} from "@simulatorlife/autodev-runtime/router/routing";
import { TOOL_CALL_OWNERSHIP } from "@simulatorlife/autodev-runtime/router/tool-call-ownership";
import {
  AGENT_ROLE_HEADER,
  CODEX_SESSION_HEADER,
  SANDBOX_MODE_HEADER,
  SKILL_CONTEXT_HEADER
} from "@simulatorlife/autodev-runtime/shared/agent-context-headers";
import { errorMessage } from "@simulatorlife/autodev-runtime/shared/error-message";
import { resolveSandboxMode } from "@simulatorlife/autodev-runtime/shared/execution-contract";
import { writeErrorLine } from "@simulatorlife/autodev-runtime/shared/output";
import {
  providerRequestUnsupported,
  providerSignInRequiredMessage
} from "@simulatorlife/autodev-runtime/shared/provider-http";
import {
  INCOMPLETE_REASON_INTERRUPTED,
  INCOMPLETE_REASON_TIMEOUT,
  isHardLimitClass,
  LIMIT_HEADER_CLASS,
  LIMIT_HEADER_RESETS_AT,
  LIMIT_SOURCE_REPORTED,
  normalizeResetsAt,
  type ProviderLimit,
  readLimitHeaders,
  terminalIncompleteEvents
} from "@simulatorlife/autodev-runtime/shared/provider-limits";
import { awaitedToolResults } from "@simulatorlife/autodev-runtime/shared/responses-continuation";
import {
  providerPhasesFromResponse,
  type ProviderPhaseTiming
} from "@simulatorlife/autodev-runtime/telemetry/provider-phases";
import {
  AUTODEV_WORKSPACE_KEY_HEADER,
  safeAutoDevWorkspaceKey
} from "@simulatorlife/autodev-runtime/telemetry/resource-context";

import { loadCodexAuth } from "../providers/codex-auth.ts";
import {
  parseCodexResponseRateLimitHeaders,
  setCachedProviderQuota
} from "../providers/quota-discovery.ts";
import { recordMcpExposure } from "./correlation.ts";
import {
  currentRouterMemoryMode,
  injectOrchestratorMemory
} from "./memory-injection.ts";
import {
  observeProviderServed,
  type ProviderHopOutcome
} from "./provider-hops.ts";
import {
  bufferedEnvelope,
  collectToolCallIds,
  countToolCallsInResponse,
  estimatePayloadInputTokens,
  processSseEvent,
  rewriteResponseValue,
  type RouterProviderRouteLike,
  summarizeBufferedSse,
  upstreamPayload
} from "./responses.ts";
import {
  AGENT_EVENTS_PATH,
  bridgeTelemetryHeaders,
  closeBridgeSubagentsForRequest,
  FORWARDED_REQUEST_HEADERS,
  hasActiveBridgeSubagentsForSession,
  mcpContractForRole,
  noteBridgeRequest,
  noteBridgeSession,
  noteOrchestratorSession,
  noteSubagentSession,
  ORCHESTRATOR_AGENT_ROLE,
  orchestratorProviderForSession,
  providerCapabilities,
  recordSpawnFailure,
  SESSION_ID_HEADER,
  SESSION_SCOPE_HEADER,
  subagentProviderForSession
} from "./subagents.ts";
import {
  endAttemptSpan,
  endLogicalRequestSpan,
  publishProviderHop,
  startAttemptSpan,
  startLogicalRequestSpan,
  withLogicalSpan
} from "./telemetry.ts";
import {
  getDefaultUsageTracker,
  UNATTRIBUTED_DIMENSION,
  usageOrigin
} from "./usage.ts";

/**
 * Pull the `<skill>...</skill>` body the orchestrator received from its
 * host's skills.instructions input item. The router forwards it to bridge
 * role-routed requests so children inherit the same selected-skill context
 * the orchestrator paid the prompt cost for, rather than re-catting the
 * SKILL.md from cwd and risking a wrong file. Returns null when nothing
 * is selected or the selection cannot be parsed.
 */
const SELECTED_SKILL_INSTRUCTIONS_KIND = "skills.selected_skill_instructions";

function selectedSkillContent(entry: Record<string, unknown>): string | null {
  const kinds = Array.isArray(entry.content_item_kinds)
    ? entry.content_item_kinds
    : [];
  if (!kinds.includes(SELECTED_SKILL_INSTRUCTIONS_KIND)) return null;
  const content = entry.content;
  if (typeof content === "string") return content.trim() ? content : null;
  if (!Array.isArray(content)) return null;
  for (const part of content) {
    if (!part || typeof part !== "object") continue;
    const text = (part as Record<string, unknown>).text;
    if (typeof text === "string" && text.trim()) return text;
  }
  return null;
}

export function extractSelectedSkillContext(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;
  const root = payload as Record<string, unknown>;
  for (const collection of [root.input, root.messages]) {
    if (!Array.isArray(collection)) continue;
    for (const item of collection) {
      if (!item || typeof item !== "object") continue;
      const selected = selectedSkillContent(item as Record<string, unknown>);
      if (selected) return selected;
    }
  }
  return null;
}

/** How an upstream timeout words itself when its error is not a named one. */
const TIMEOUT_MESSAGE_PATTERN = /timeout|timed out/iu;

const ROUTER_LISTENER_HOST = process.env.CODEX_MODEL_ROUTER_HOST ?? "127.0.0.1";
const ROUTER_LISTENER_PORT = Number.parseInt(
  process.env.CODEX_MODEL_ROUTER_PORT ?? "4100"
);

export const ROUTER_INSTANCE_ID = randomUUID();

export const CLIENT_DISCONNECT_CODES = Object.freeze(
  new Set([
    "EPIPE",
    "ECONNRESET",
    "ERR_STREAM_DESTROYED",
    "ERR_STREAM_WRITE_AFTER_END"
  ])
);

const NOOP = () => {};
const FALLBACKABLE_BODY_REGEX =
  /quota|rate.?limit|weekly.?limit|usage.?limit|usage exhausted|session|high.?demand|credit|timeout|timed.?out|overloaded|temporarily unavailable|unavailable/i;
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

export function nonNegativeDuration(
  value: string | undefined,
  fallback: number
): number {
  const parsed = Number.parseInt(value ?? "");
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
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
export const STREAM_IDLE_TIMEOUT_MS = positiveDuration(
  process.env.CODEX_ROUTER_STREAM_IDLE_TIMEOUT_MS,
  900_000
);
export const UPSTREAM_TIMEOUT_MS = nonNegativeDuration(
  process.env.CODEX_ROUTER_UPSTREAM_TIMEOUT_MS,
  7_200_000
);
export const UPSTREAM_RETRY_BASE_MS = positiveDuration(
  process.env.CODEX_ROUTER_UPSTREAM_RETRY_MS,
  200
);
export const UPSTREAM_RETRY_MAX_MS = Math.max(
  UPSTREAM_RETRY_BASE_MS,
  positiveDuration(process.env.CODEX_ROUTER_UPSTREAM_RETRY_MAX_MS, 2000)
);
export const CONCRETE_STATUS_MAX_ATTEMPTS = 2;
/**
 * Attempts per candidate when the connection fails before any response
 * (reset, broken pipe, connect timeout). Shared by concrete requests and every
 * candidate of a fallback chain: a severed connection says nothing about the
 * provider, so it is retried in place before the provider is cooled down.
 */
export const UPSTREAM_TRANSPORT_MAX_ATTEMPTS = positiveDuration(
  process.env.CODEX_ROUTER_UPSTREAM_TRANSPORT_RETRY_LIMIT,
  3
);

export const activeProviderRequests = new Map<string, number>();

/** Admission for limited upstream providers, independent of live agent activity. */
interface ProviderCapacityWaiter {
  limit: number;
  admit: () => void;
}
const providerCapacityWaiters = new Map<string, ProviderCapacityWaiter[]>();

function wakeProviderCapacityWaiters(provider: string): void {
  const waiters = providerCapacityWaiters.get(provider);
  if (!waiters) return;
  while (
    waiters.length > 0 &&
    getActiveRequests(provider) < waiters[0]!.limit
  ) {
    waiters.shift()!.admit();
  }
  if (waiters.length === 0) providerCapacityWaiters.delete(provider);
}

function providerAtCapacity(route: ProviderRoute): boolean {
  return (
    route.maxConcurrentRequests !== undefined &&
    getActiveRequests(route.provider) >= route.maxConcurrentRequests
  );
}

/** Reserve capacity before dispatch; cancellable FIFO waiting when all slots are held. */
function acquireProviderCapacity(
  route: ProviderRoute,
  signal: AbortSignal | null
): Promise<(() => void) | null> {
  if (signal?.aborted) return Promise.resolve(null);
  const release = (): (() => void) => {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      decrementActiveRequests(route.provider);
    };
  };
  const limit = route.maxConcurrentRequests;
  if (
    limit === undefined ||
    (!providerCapacityWaiters.has(route.provider) && !providerAtCapacity(route))
  ) {
    incrementActiveRequests(route.provider);
    return Promise.resolve(release());
  }
  return new Promise((resolve) => {
    const waiters = providerCapacityWaiters.get(route.provider) ?? [];
    const onAbort = (): void => {
      const index = waiters.indexOf(waiter);
      if (index === -1) return;
      waiters.splice(index, 1);
      if (waiters.length === 0) providerCapacityWaiters.delete(route.provider);
      signal?.removeEventListener("abort", onAbort);
      resolve(null);
      wakeProviderCapacityWaiters(route.provider);
    };
    const waiter: ProviderCapacityWaiter = {
      limit,
      admit: () => {
        signal?.removeEventListener("abort", onAbort);
        incrementActiveRequests(route.provider);
        resolve(release());
      }
    };
    waiters.push(waiter);
    providerCapacityWaiters.set(route.provider, waiters);
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
}

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
  wakeProviderCapacityWaiters(provider);
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
  const floor = Math.min(UPSTREAM_RETRY_BASE_MS, UPSTREAM_RETRY_MAX_MS);
  const ceiling = Math.max(
    floor,
    Math.min(UPSTREAM_RETRY_MAX_MS, UPSTREAM_RETRY_BASE_MS * 2)
  );
  const delayMs = floor + Math.floor(Math.random() * (ceiling - floor + 1));
  await new Promise((resolve) => {
    setTimeout(resolve, delayMs);
  });
  return delayMs;
}

/** A request's identity, as `requestSession` resolves it. */
export interface RouterSession {
  key: string;
  scope: string;
  thread?: string | null;
  /** The exact caller-supplied session ID; absent when only a thread ID exists. */
  sessionId?: string;
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

/** Who a concrete provider/model request runs as, from its thread identity. */
export interface ConcreteRequestAttribution {
  role: typeof ORCHESTRATOR_AGENT_ROLE | null;
  origin: "orchestrator" | "subagent" | "direct";
}

/**
 * A concrete model names no `autodev/<role>` alias, so its Agent role comes
 * from where it sits in the Codex agent tree. The root thread of an
 * identified session (its thread id equals the session key) is the session's
 * root agent -- the orchestrator -- whichever model the operator picked for
 * it. A child thread is a subagent whose named role a concrete model does not
 * carry, so its role stays unattributed. Without a thread id the request has
 * no place in an agent tree and is a direct request. The provider never
 * decides: a Codex model picked for a child is not the orchestrator, and a
 * MiniMax model picked for the root is.
 */
export function concreteRequestAttribution(
  session: RouterSession | null
): ConcreteRequestAttribution {
  const thread = session?.thread ?? null;
  if (!session || session.scope !== "identified" || !thread)
    return { role: null, origin: "direct" };
  return thread === session.key
    ? { role: ORCHESTRATOR_AGENT_ROLE, origin: "orchestrator" }
    : { role: null, origin: "subagent" };
}

export function carriesPendingToolResult(payload: unknown): boolean {
  const input =
    payload && typeof payload === "object" && "input" in payload
      ? (payload as { input?: unknown }).input
      : undefined;
  return awaitedToolResults(input).outputs.size > 0;
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
    ...bridgeTelemetryHeaders(route, requestId, {
      agentEventsUrl: `http://${ROUTER_LISTENER_HOST}:${ROUTER_LISTENER_PORT}${AGENT_EVENTS_PATH}`
    })
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
  options: {
    skillContext?: string | null;
    codexSessionId?: string | null;
    workspace?: { key?: string | null } | null;
  } = {}
): Record<string, string> {
  const headers = downstreamHeaders(
    route,
    auth,
    turnMetadataHeader,
    agentRole,
    requestId,
    session
  );
  if (
    options.skillContext &&
    options.skillContext.trim() &&
    route.provider !== "codex"
  ) {
    headers[SKILL_CONTEXT_HEADER] = options.skillContext;
  }
  if (options.codexSessionId && options.codexSessionId.trim()) {
    headers[CODEX_SESSION_HEADER] = options.codexSessionId;
  }
  const workspaceKey = safeAutoDevWorkspaceKey(options.workspace?.key);
  // This identity is for local provider bridges, not a header to disclose to
  // external provider endpoints.
  let loopbackTarget: boolean;
  try {
    const rawHostname = new URL(route.baseUrl).hostname;
    const hostname =
      rawHostname.startsWith("[") && rawHostname.endsWith("]")
        ? rawHostname.slice(1, -1)
        : rawHostname;
    loopbackTarget = isLoopbackAddress(hostname);
  } catch {
    loopbackTarget = false;
  }
  if (loopbackTarget && workspaceKey) {
    headers[AUTODEV_WORKSPACE_KEY_HEADER] = workspaceKey;
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
  const fromHeaders = readLimitHeaders(headers);
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
  limit: ProviderLimit | null = null,
  model: string | null = null,
  body: string | null = null
): CooldownOptions {
  return {
    failureClass: limit?.limitClass ?? failureClass,
    resetsAt: limit?.resetsAt ?? null,
    structured: limit?.source === LIMIT_SOURCE_REPORTED,
    model,
    detail: body === null ? null : providerErrorDetail(body)
  };
}

/**
 * Cool a failed route down. A provider that refused the route's model as
 * unknown also clears the operator choice that named it (see
 * `forgetRejectedModel`), so the next request takes the tier's configured
 * model instead of the same refusal after every cooldown.
 */
function coolDownRoute(provider: string, options: CooldownOptions): void {
  COOLDOWNS.cooldownProvider(provider, options);
  if (
    options.failureClass === "invalid_model" &&
    ROUTING_POLICY.forgetRejectedModel(provider, options.model)
  ) {
    writeErrorLine(
      `${provider} does not have model ${options.model}; cleared the operator choice that named it`
    );
    scheduleRouterStatePersist();
  }
}

const MAX_UPSTREAM_DETAIL_CHARS = 300;

/** The provider's own `error.message`, kept for failures only the user can fix. */
function providerErrorDetail(body: string): string | null {
  try {
    const message = (JSON.parse(body) as { error?: { message?: unknown } })
      ?.error?.message;
    return typeof message === "string" && message.trim()
      ? message.trim().slice(0, MAX_UPSTREAM_DETAIL_CHARS)
      : null;
  } catch {
    return null;
  }
}

export function fallbackable(status: number, body: unknown): boolean {
  if ([401, 408, 429, 500, 502, 503, 504].includes(status)) return true;
  if (status === 400 && INVALID_MODEL_PATTERN.test(String(body ?? "")))
    return true;
  // A route that says it cannot serve this request is not a broken provider:
  // the next candidate may serve it, so the chain moves on.
  if (providerRequestUnsupported(body)) return true;
  return FALLBACKABLE_BODY_REGEX.test(String(body ?? ""));
}

export interface CandidateFailureDecision {
  /** Whether the chain moves on to the next candidate or answers the client. */
  readonly outcome: "terminal" | "fallback";
  /**
   * Whether the provider is cooled down. A provider that cannot serve this
   * request is healthy: cooling it would push unrelated traffic away from a
   * working route.
   */
  readonly coolDown: boolean;
}

/**
 * What a candidate's failure means for the request.
 *
 * A route that refuses with the typed "cannot serve this request" refusal has
 * not failed: the next candidate may serve the request, so the chain moves on
 * and the provider stays available.
 */
export function decideCandidateFailure(
  status: number,
  body: string | null
): CandidateFailureDecision {
  if (!fallbackable(status, body))
    return { outcome: "terminal", coolDown: false };
  return {
    outcome: "fallback",
    coolDown: !providerRequestUnsupported(body)
  };
}

export interface ProviderProbeResult {
  ok: boolean;
  failureClass: string | null;
  detail?: string;
}

export const PROBE_RETRY_TIMEOUT_MS = Math.max(1500, PROBE_TIMEOUT_MS * 2);

export async function probeProvider(
  route: ProviderRoute
): Promise<ProviderProbeResult> {
  if (!ROUTING_POLICY.routeCredentialAvailable(route)) {
    return {
      ok: false,
      failureClass: "missing_credential",
      detail: `Missing credential: ${route.envKey ?? "required environment variable"}.`
    };
  }
  if (route.provider === "codex") {
    try {
      await loadCodexAuth();
      return { ok: true, failureClass: null };
    } catch (error) {
      return {
        ok: false,
        failureClass: "missing_credential",
        detail: `Codex authentication unavailable: ${errorMessage(error)}`
      };
    }
  }
  if (!route.healthUrl) return { ok: true, failureClass: null };

  const attemptProbe = async (
    timeoutMs: number
  ): Promise<{
    ok: boolean;
    status?: number;
    body?: string;
    error?: unknown;
  }> => {
    try {
      const response = await fetch(route.healthUrl!, {
        signal: AbortSignal.timeout(timeoutMs)
      });
      if (response.ok) return { ok: true, status: response.status };
      const body = await response.text().catch(() => "");
      return { ok: false, status: response.status, body };
    } catch (error) {
      return { ok: false, error };
    }
  };

  let first = await attemptProbe(PROBE_TIMEOUT_MS);
  if (first.ok) return { ok: true, failureClass: null };

  const isTimeout =
    first.error instanceof Error &&
    (first.error.name === "TimeoutError" ||
      first.error.name === "AbortError" ||
      TIMEOUT_MESSAGE_PATTERN.test(first.error.message));

  if (isTimeout) {
    const second = await attemptProbe(PROBE_RETRY_TIMEOUT_MS);
    if (second.ok) return { ok: true, failureClass: null };
    first = second;
  }

  // A bridge whose provider account must be signed in again answers its
  // health check with that: the provider is waiting for the operator, which
  // is a different thing from a bridge that did not answer.
  const signIn = providerSignInRequiredMessage(first.body);
  if (signIn !== null) {
    return {
      ok: false,
      failureClass: SIGN_IN_REQUIRED_FAILURE_CLASS,
      detail: signIn
    };
  }

  const detail = first.error
    ? `Probe failed: ${errorMessage(first.error)}`
    : `Probe returned HTTP ${first.status}`;

  return {
    ok: false,
    failureClass: PROBE_FAILURE_CLASS,
    detail
  };
}

export async function providerAvailable(
  route: ProviderRoute
): Promise<boolean> {
  const probe = await probeProvider(route);
  return probe.ok;
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

/**
 * The error a provider reported with a failed response.
 *
 * A bridge answers 200 and then fails when the failure happens after the
 * response's head has gone out, so the failure can only be read from the
 * body of the stream. What the error carries is what tells the router what
 * happened: a request the route cannot serve, a timeout, a limit the site
 * named, or a provider failure.
 */
export interface ProviderReportedError {
  readonly type: string | null;
  readonly code: string | null;
  readonly message: string | null;
}

/** The error of a failed response, as the provider reported it. */
export function reportedError(value: unknown): ProviderReportedError | null {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return null;
  const error = value as Record<string, unknown>;
  const type = typeof error.type === "string" ? error.type : null;
  const code =
    typeof error.code === "string"
      ? error.code
      : typeof error.code === "number"
        ? String(error.code)
        : null;
  const message = typeof error.message === "string" ? error.message : null;
  if (!type && !code && !message) return null;
  return { type, code, message };
}

/**
 * The error a `response.failed` event carries, when it carries one.
 *
 * The event's own error is what the provider said went wrong; an event
 * without one says only that the turn failed.
 */
function failedEventError(parsed: {
  type?: string;
  [key: string]: unknown;
}): ProviderReportedError | null {
  const response = parsed.response as Record<string, unknown> | undefined;
  return reportedError(response?.error);
}

/**
 * Keep the error a failed turn reported.
 *
 * The error is what says whether the provider is broken or the route cannot
 * serve this request; without it every failure of a streamed turn read
 * alike, and a route that never received the prompt was cooled down like a
 * provider that had.
 */
function captureFailedEvent(
  parsed: { type?: string; [key: string]: unknown },
  setReportedError: (value: ProviderReportedError) => void
): void {
  const error = failedEventError(parsed);
  if (error) setReportedError(error);
}

/**
 * The failure class a failed response's own error names.
 *
 * A response that failed without saying why is an upstream error. One that
 * says the route cannot serve this request is a refusal: the provider is
 * healthy, so the router leaves it serving instead of cooling it down.
 */
export function classifyReportedFailure(
  error: ProviderReportedError | null
): ProviderFailureClass {
  if (!error) return "upstream_error";
  const body = JSON.stringify({ error });
  if (providerRequestUnsupported(body)) return "unsupported_request";
  const classified = classifyProviderFailure(200, body);
  return classified === "request_error" ? "upstream_error" : classified;
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

interface ProviderUsage {
  input: number | null;
  output: number | null;
  cacheRead: number | null;
}

function providerTokenCount(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : null;
}

/**
 * The cached input tokens a provider reported, in every shape any provider uses.
 *
 * The three shapes are different names for one number:
 *
 * - Anthropic's Messages API reports `cache_read_input_tokens` beside the
 *   input count.
 * - OpenAI's Chat Completions API reports `prompt_tokens_details.cached_tokens`.
 * - OpenAI's Responses API -- the endpoint every AutoDev provider route
 *   actually calls (`${baseUrl}/responses`) -- reports
 *   `input_tokens_details.cached_tokens`.
 *
 * Reading only one of them silently drops the cache count for the providers
 * that use the others, and the Usage cache-rate panel then selects no row at
 * all, so the Console reads the rate as never observed.
 * The first shape that carries a usable count wins; they never disagree in
 * practice because a provider reports one shape.
 */
function providerCacheReadTokens(
  usage: Record<string, unknown>
): number | null {
  const detailCache = (detail: unknown): number | null =>
    detail && typeof detail === "object"
      ? providerTokenCount((detail as Record<string, unknown>).cached_tokens)
      : null;
  return (
    providerTokenCount(usage.cache_read_input_tokens) ??
    detailCache(usage.input_tokens_details) ??
    detailCache(usage.prompt_tokens_details)
  );
}

function usageFromResponse(value: unknown): ProviderUsage | null {
  if (!value || typeof value !== "object") return null;
  const response = value as Record<string, unknown>;
  const rawUsage = response.usage;
  if (!rawUsage || typeof rawUsage !== "object") return null;
  const usage = rawUsage as Record<string, unknown>;
  const result = {
    input: providerTokenCount(usage.input_tokens),
    output: providerTokenCount(usage.output_tokens),
    cacheRead: providerCacheReadTokens(usage)
  };
  return result.input === null &&
    result.output === null &&
    result.cacheRead === null
    ? null
    : result;
}

/**
 * What a provider's final response says about its attempt: the tokens it
 * used, the model that answered, and -- from a bridge that measures them --
 * where the turn's time went. Each is null when the response does not say.
 */
interface AttemptObservation {
  readonly usage: ProviderUsage | null;
  readonly responseModel: string | null;
  readonly phases: ProviderPhaseTiming | null;
}

const NO_ATTEMPT_OBSERVATION: AttemptObservation = {
  usage: null,
  responseModel: null,
  phases: null
};

function observeResponse(value: unknown): AttemptObservation {
  return {
    usage: usageFromResponse(value),
    responseModel: providerResponseModel(value),
    phases: providerPhasesFromResponse(value)
  };
}

function endStreamAttempt(
  span: Span | undefined,
  statusCode: number | undefined,
  result: StreamWriteResult,
  observation: AttemptObservation
): void {
  if (!span) return;
  endAttemptSpan(span, {
    status: result.failed && !result.clientDisconnected ? "error" : "ok",
    ...(statusCode === undefined ? {} : { statusCode }),
    errorType:
      result.failed && !result.clientDisconnected
        ? (result.incompleteReason ?? "incomplete_response")
        : null,
    errorMessage:
      result.failed && !result.clientDisconnected
        ? "provider stream did not complete successfully"
        : null,
    ...observation
  });
}

export interface StreamWriteResult {
  toolCalls: number;
  /** Call ids of the tool calls the provider emitted, for result affinity. */
  toolCallIds: Set<string>;
  failed: boolean;
  /**
   * The client went away before the response finished. The provider did
   * nothing wrong, so this must never count against it.
   */
  clientDisconnected: boolean;
  incompleteReason: string | null;
  limit: ProviderLimit | null;
  inputRequired: boolean;
  /** The error the provider reported with the failure, when it reported one. */
  error: ProviderReportedError | null;
  /**
   * The attempt failed before the provider sent any output, and the failure
   * was not written to the client: the client's stream is still open and has
   * been told nothing, so the next candidate can answer on it.
   */
  beforeOutput: boolean;
}

/** What the router has learned from one provider's stream so far. */
interface SseStreamState {
  sawCreated: boolean;
  responseId: string | null;
  itemId: string | null;
  reasoningId: string | null;
  text: string;
  reasoning: string;
  /** The provider has sent an event that carries, or opens, output. */
  outputStarted: boolean;
  /** Whether a failure before any output is kept from the client. */
  readonly holdFailureBeforeOutput: boolean;
  /**
   * The stream ended in failure before any output and the failure was kept
   * from the client: the client has been told nothing it cannot be un-told,
   * so another provider can still answer on the same stream.
   */
  withheld: boolean;
}

/**
 * The events a provider sends before it has anything to say, and the ones
 * that end a response. Everything else a response stream carries is output.
 */
const NON_OUTPUT_EVENTS = new Set([
  "response.created",
  "response.queued",
  "response.in_progress",
  "response.completed",
  "response.incomplete",
  "response.failed"
]);

function isOutputEvent(type: unknown): boolean {
  return (
    typeof type === "string" &&
    type.startsWith("response.") &&
    !NON_OUTPUT_EVENTS.has(type)
  );
}

/** A declared limit as the bridges write it into a response or an error. */
function limitFromDeclared(declared: unknown): ProviderLimit | null {
  if (!declared || typeof declared !== "object") return null;
  const limit = declared as Record<string, unknown>;
  if (!limit.class) return null;
  return {
    limitClass: String(
      limit.class
    ).toLowerCase() as ProviderLimit["limitClass"],
    limitType: limit.type ? String(limit.type).toLowerCase() : null,
    resetsAt: normalizeResetsAt(limit.resets_at),
    source:
      limit.source === LIMIT_SOURCE_REPORTED
        ? LIMIT_SOURCE_REPORTED
        : "inferred"
  };
}

function applyParsedSseEvent(
  parsed: { type?: string; [key: string]: unknown },
  streamState: SseStreamState,
  toolCallIds: Set<string>,
  setTerminal: (value: "completed" | "failed") => void,
  setIncompleteReason: (value: string) => void,
  setReportedLimit: (value: ProviderLimit) => void,
  setReportedError: (value: ProviderReportedError) => void,
  onResponseCompleted?: (response: Record<string, unknown>) => void
): void {
  if (isOutputEvent(parsed.type)) streamState.outputStarted = true;
  // A response that ends in failure before any output has told the client
  // nothing: it is kept back, so the chain can ask the next provider.
  const withholdFailure = (): void => {
    if (streamState.holdFailureBeforeOutput && !streamState.outputStarted)
      streamState.withheld = true;
  };
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
      captureFailedEvent(parsed, setReportedError);
      // A bridge that could not start the turn for a limit says so in the
      // failure, with the limit it would otherwise put in an incomplete
      // response: the provider is cooled down for as long as it declared.
      const failed = parsed.response as Record<string, unknown> | undefined;
      const declared = limitFromDeclared(
        (failed?.error as Record<string, unknown> | undefined)?.limit
      );
      if (declared) setReportedLimit(declared);
      setTerminal("failed");
      withholdFailure();
      break;
    }
    case "response.completed": {
      const response = parsed.response as Record<string, unknown> | undefined;
      collectToolCallIds(response, toolCallIds);
      if (response) onResponseCompleted?.(response);
      const notCompleted = responseWasNotCompleted(response);
      setTerminal(notCompleted ? "failed" : "completed");
      const details = response?.incomplete_details as
        Record<string, unknown> | undefined;
      if (details?.reason) setIncompleteReason(String(details.reason));
      const declared = limitFromDeclared(details?.provider_limit);
      if (declared) setReportedLimit(declared);
      if (notCompleted) withholdFailure();
      break;
    }
    default: {
      break;
    }
  }
}

function flushSseBuffer(args: {
  buffer: string;
  flush: boolean;
  isWritable: () => boolean;
  safeWrite: (chunk: string | Uint8Array) => boolean;
  publicModel: string;
  minimumInputTokens?: number;
  seenToolCalls: Set<string>;
  toolCallIds: Set<string>;
  streamState: SseStreamState;
  setTerminal: (value: "completed" | "failed") => void;
  setIncompleteReason: (value: string) => void;
  setReportedLimit: (value: ProviderLimit) => void;
  setReportedError: (value: ProviderReportedError) => void;
  onResponseCompleted?: (response: Record<string, unknown>) => void;
  onConsumed: (toolCallDelta: number) => void;
  onBufferUpdated: (next: string) => void;
}): void {
  let working = args.buffer;
  while (args.isWritable()) {
    const boundary = working.match(SSE_EVENT_BOUNDARY);
    if (!boundary) break;
    const end = boundary.index! + boundary[0]!.length;
    const event = working.slice(0, end);
    // One pass: the frame is split and parsed once, and that single parse feeds
    // stream inspection, tool-call counting, and the rewrite. It used to be
    // three passes over the same bytes -- see processSseEvent.
    const processed = processSseEvent(event, {
      publicModel: args.publicModel,
      ...(args.minimumInputTokens === undefined
        ? {}
        : { minimumInputTokens: args.minimumInputTokens }),
      seenToolCalls: args.seenToolCalls,
      onParsed: (parsed) =>
        applyParsedSseEvent(
          parsed,
          args.streamState,
          args.toolCallIds,
          args.setTerminal,
          args.setIncompleteReason,
          args.setReportedLimit,
          args.setReportedError,
          args.onResponseCompleted
        )
    });
    args.onConsumed(processed.toolCalls);
    if (!args.streamState.withheld) args.safeWrite(processed.output);
    working = working.slice(end);
  }
  if (args.flush && working && args.isWritable()) {
    const processed = processSseEvent(working, {
      publicModel: args.publicModel,
      ...(args.minimumInputTokens === undefined
        ? {}
        : { minimumInputTokens: args.minimumInputTokens }),
      seenToolCalls: args.seenToolCalls,
      onParsed: (parsed) =>
        applyParsedSseEvent(
          parsed,
          args.streamState,
          args.toolCallIds,
          args.setTerminal,
          args.setIncompleteReason,
          args.setReportedLimit,
          args.setReportedError,
          args.onResponseCompleted
        )
    });
    args.onConsumed(processed.toolCalls);
    if (!args.streamState.withheld) args.safeWrite(processed.output);
    working = "";
  }
  args.onBufferUpdated(working);
}

function closeSseStream(args: {
  streamState: SseStreamState;
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
    if (signal?.reason instanceof Error && signal.reason.message) {
      return signal.reason.message;
    }
    return `Upstream provider exceeded response timeout.`;
  }
  return errorMessage(error);
}

async function drainSseBody(args: {
  body: AsyncIterable<Uint8Array>;
  decoder: TextDecoder;
  isWritable: () => boolean;
  append: (chunk: string) => void;
  flushEvents: (flush: boolean) => void;
  onActivity?: () => void;
  signal?: AbortSignal | null;
}): Promise<void> {
  for await (const chunk of args.body) {
    if (!args.isWritable() || args.signal?.aborted) break;
    args.onActivity?.();
    args.append(args.decoder.decode(chunk, { stream: true }));
    args.flushEvents(false);
  }
  if (args.signal?.aborted) {
    throw args.signal.reason instanceof Error
      ? args.signal.reason
      : new Error(String(args.signal.reason));
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
  onHeartbeat: (() => void) | null = null,
  clientSignal: AbortSignal | null = null,
  replayable = false,
  attemptTelemetry?: { span?: Span; statusCode?: number },
  minimumInputTokens?: number,
  holdFailureBeforeOutput = false
): Promise<StreamWriteResult> {
  const decoder = new TextDecoder();
  const seenToolCalls = new Set<string>();
  const toolCallIds = new Set<string>();
  let toolCalls = 0;
  let buffer = "";
  let terminal: "completed" | "failed" | null = null;
  const streamState: SseStreamState & { model: string } = {
    sawCreated: false,
    responseId: null,
    model: publicModel,
    itemId: null,
    reasoningId: null,
    text: "",
    reasoning: "",
    outputStarted: false,
    holdFailureBeforeOutput,
    withheld: false
  };
  let incompleteReason: string | null = null;
  let reportedLimit: ProviderLimit | null = null;
  let streamError: ProviderReportedError | null = null;
  let attemptObservation = NO_ATTEMPT_OBSERVATION;
  const captureCompletedResponse = (
    completed: Record<string, unknown>
  ): void => {
    attemptObservation = observeResponse(completed);
  };
  const finalizeAttempt = (result: StreamWriteResult): StreamWriteResult => {
    endStreamAttempt(
      attemptTelemetry?.span,
      attemptTelemetry?.statusCode,
      result,
      attemptObservation
    );
    return result;
  };

  response.on("error", NOOP);

  const isWritable = (): boolean =>
    !response.writableEnded &&
    !response.destroyed &&
    !response.closed &&
    !clientSignal?.aborted;
  // A real disconnect closes the socket before the request's close handler
  // aborts clientSignal, so the signal alone can still read "connected" here.
  const clientGone = (): boolean =>
    Boolean(clientSignal?.aborted) ||
    (!response.writableEnded && (response.destroyed || response.closed));
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
  const captureReportedError = (value: ProviderReportedError): void => {
    streamError = value;
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
      ...(minimumInputTokens === undefined ? {} : { minimumInputTokens }),
      seenToolCalls,
      toolCallIds,
      streamState,
      setTerminal: captureTerminal,
      setIncompleteReason: captureIncompleteReason,
      setReportedLimit: captureReportedLimit,
      setReportedError: captureReportedError,
      onResponseCompleted: captureCompletedResponse,
      onConsumed: captureToolCalls,
      onBufferUpdated: captureBuffer
    });
  };
  const closeIncomplete = (reason: string, message: string): void => {
    // A stream that broke off before any output is the same to the client as
    // one that failed before any: nothing was said, so nothing is written,
    // and the next candidate may answer. A client that left is not waiting.
    if (
      holdFailureBeforeOutput &&
      !streamState.outputStarted &&
      !clientGone()
    ) {
      captureIncompleteReason(reason);
      streamState.withheld = true;
      return;
    }
    // A stateless upstream can be replayed by the client, which is what
    // native Codex does when its stream drops: close with a retryable
    // response.failed rather than a finished turn that stops the agent.
    if (replayable) {
      captureIncompleteReason(reason);
      safeWrite(responseFailureEvent(message));
      return;
    }
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
    // The drain stops reading once the client is gone, so the stream ends with
    // no terminal event: that is the client leaving, not the provider failing.
    clientDisconnected: terminal !== "completed" && clientGone(),
    incompleteReason,
    limit: reportedLimit,
    error: streamError,
    inputRequired:
      incompleteReason === "input_required" ||
      incompleteReason === "requires_action",
    beforeOutput: terminal !== "completed" && streamState.withheld
  });

  const keepAlive = setInterval(() => {
    safeWrite(": codex-router keep-alive\n\n");
    onHeartbeat?.();
  }, 2000);

  if (!upstream.body) {
    clearInterval(keepAlive);
    if (holdFailureBeforeOutput) streamState.withheld = true;
    else
      safeWrite(
        responseFailureEvent("Upstream provider returned no response body.")
      );
    response.removeListener("error", NOOP);
    return finalizeAttempt(streamResult());
  }

  const idleController = new AbortController();
  let idleTimer: NodeJS.Timeout | null = null;
  const resetIdleTimer = (): void => {
    if (STREAM_IDLE_TIMEOUT_MS <= 0) return;
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      idleController.abort(
        new DOMException(
          `Upstream provider went idle for ${Math.ceil(
            STREAM_IDLE_TIMEOUT_MS / 1000
          )}s without sending any data.`,
          "TimeoutError"
        )
      );
    }, STREAM_IDLE_TIMEOUT_MS);
  };
  resetIdleTimer();

  const combinedSignal = signal
    ? AbortSignal.any([signal, idleController.signal])
    : idleController.signal;

  try {
    await drainSseBody({
      body: upstream.body as AsyncIterable<Uint8Array>,
      decoder,
      isWritable,
      append(chunk) {
        buffer += chunk;
      },
      flushEvents,
      onActivity: resetIdleTimer,
      signal: combinedSignal
    });
  } catch (error) {
    closeIncomplete(
      isTimeoutAbort(combinedSignal)
        ? INCOMPLETE_REASON_TIMEOUT
        : INCOMPLETE_REASON_INTERRUPTED,
      upstreamErrorMessage(error, combinedSignal)
    );
    return finalizeAttempt(streamResult());
  } finally {
    if (idleTimer) clearTimeout(idleTimer);
    clearInterval(keepAlive);
    response.removeListener("error", NOOP);
  }

  if (terminal === null) {
    closeIncomplete(
      INCOMPLETE_REASON_INTERRUPTED,
      "Upstream provider closed the stream before response.completed."
    );
  }

  return finalizeAttempt(streamResult());
}
export type FetchUpstreamResult =
  | {
      ok: true;
      upstream: Response;
      signal: AbortSignal;
      attemptSpan?: Span;
      attemptStatusCode?: number;
    }
  | {
      ok: false;
      status: number;
      body: string;
      limit: ProviderLimit | null;
      retryable: boolean;
    };

export interface AttemptTelemetryOptions {
  /** Routing selection that triggered this physical attempt. */
  selection: string;
  /** 1-based attempt counter for the same provider/model target. */
  attemptNumber: number;
  /** Concrete model id used for this attempt (candidate model or payload model). */
  model: string | null;
  /** Original logical model requested from AutoDev before routing/fallback. */
  requestedModel?: string | null;
  role?: string | null;
  workspace?: { key: string; cwd?: string | null } | null;
  /**
   * The source-confirmed session this attempt serves.
   *
   * It is copied onto the attempt the same way the workspace and the role
   * are, so a per-session view can read an attempt without joining across
   * spans.
   */
  sessionId?: string | null;
}

async function authForRoute(
  route: ProviderRoute
): Promise<Awaited<ReturnType<typeof loadCodexAuth>> | null> {
  if (route.provider !== "codex") return null;
  try {
    return await loadCodexAuth();
  } catch (error) {
    const authError = new Error("Codex authentication is unavailable.");
    (authError as { code?: string }).code = "router_auth_unavailable";
    (authError as { cause?: unknown }).cause = error;
    throw authError;
  }
}

function upstreamSignals(clientSignal: AbortSignal | null): AbortSignal {
  const signals: AbortSignal[] = [];
  if (clientSignal) signals.push(clientSignal);
  if (UPSTREAM_TIMEOUT_MS > 0)
    signals.push(AbortSignal.timeout(UPSTREAM_TIMEOUT_MS));
  if (signals.length > 1) return AbortSignal.any(signals);
  return signals[0] ?? new AbortController().signal;
}

async function failedUpstreamResponse(
  upstream: Response,
  span: Span | null
): Promise<Extract<FetchUpstreamResult, { ok: false }>> {
  let body: string;
  try {
    body = await upstream.text();
  } catch (error) {
    if (span) {
      const info = transportErrorInfo(error);
      endAttemptSpan(span, {
        status: "error",
        statusCode: upstream.status,
        errorType: info.code ?? info.name,
        errorMessage: "provider error response body could not be read"
      });
    }
    throw error;
  }
  if (span) {
    endAttemptSpan(span, {
      status: "error",
      statusCode: upstream.status,
      errorType: classifyProviderFailure(upstream.status, body),
      errorMessage: `provider returned HTTP ${upstream.status}`
    });
  }
  return {
    ok: false,
    status: upstream.status,
    body,
    limit: declaredLimit(upstream.headers, body),
    retryable: [502, 503, 504].includes(upstream.status)
  };
}

function providerResponseModel(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  const model = (value as Record<string, unknown>).model;
  return typeof model === "string" && model.trim() ? model : null;
}

async function bufferNonStreamingJsonResponse(
  upstream: Response,
  signal: AbortSignal,
  attemptSpan: Span | null
): Promise<Extract<FetchUpstreamResult, { ok: true }> | null> {
  const contentType = upstream.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().includes("json")) return null;
  let text: string;
  try {
    text = await upstream.text();
  } catch (error) {
    if (attemptSpan) {
      const info = transportErrorInfo(error);
      endAttemptSpan(attemptSpan, {
        status: "error",
        statusCode: upstream.status,
        errorType: info.code ?? info.name,
        errorMessage: "provider response body could not be read"
      });
    }
    throw error;
  }
  let observation = NO_ATTEMPT_OBSERVATION;
  try {
    observation = observeResponse(JSON.parse(text));
  } catch {
    /* Preserve malformed JSON as pass-through without trusting its usage. */
  }
  if (attemptSpan) {
    endAttemptSpan(attemptSpan, {
      status: "ok",
      statusCode: upstream.status,
      ...observation
    });
  }
  return {
    ok: true,
    upstream: new Response(text, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: upstream.headers
    }),
    signal
  };
}

export async function fetchUpstream(
  route: ProviderRoute,
  payload: Record<string, unknown>,
  wantsStream: boolean,
  turnMetadataHeader: string | null,
  clientSignal: AbortSignal | null = null,
  agentRole: string | null = null,
  requestId: string | null = null,
  session: RouterSession | null = null,
  attemptTelemetry: AttemptTelemetryOptions | null = null
): Promise<FetchUpstreamResult> {
  const auth = await authForRoute(route);
  const requestPayload = upstreamPayload(
    route as unknown as RouterProviderRouteLike,
    payload,
    wantsStream,
    requestId,
    undefined,
    { normalizeItemIds: providerCapabilities(route.provider).normalizeItemIds }
  );
  const signal = upstreamSignals(clientSignal);
  const attemptSpan = attemptTelemetry
    ? startAttemptSpan({
        provider: route.provider,
        model: attemptTelemetry.model,
        ...(attemptTelemetry.requestedModel === undefined
          ? {}
          : { requestedModel: attemptTelemetry.requestedModel }),
        selection: attemptTelemetry.selection,
        attemptNumber: attemptTelemetry.attemptNumber,
        role: attemptTelemetry.role ?? null,
        workspace: attemptTelemetry.workspace ?? null,
        sessionId: attemptTelemetry.sessionId ?? null
      })
    : null;
  let upstream: Response;
  try {
    upstream = await fetch(`${route.baseUrl}/responses`, {
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
          codexSessionId: codexSessionIdFromPayload(payload),
          workspace: attemptTelemetry?.workspace ?? null
        }
      ),
      signal,
      body: JSON.stringify(requestPayload)
    });
  } catch (error) {
    if (attemptSpan) {
      const info = transportErrorInfo(error);
      endAttemptSpan(attemptSpan, {
        status: "error",
        errorType: info.code ?? info.name,
        errorMessage: "provider transport failure"
      });
    }
    throw error;
  }
  if (route.provider === "codex" && upstream.headers) {
    const codexQuota = parseCodexResponseRateLimitHeaders(upstream.headers);
    if (codexQuota) {
      setCachedProviderQuota("codex", codexQuota, { syncCooldowns: true });
    }
  }
  if (!upstream.ok) return failedUpstreamResponse(upstream, attemptSpan);
  if (!wantsStream) {
    const buffered = await bufferNonStreamingJsonResponse(
      upstream,
      signal,
      attemptSpan
    );
    if (buffered) return buffered;
  }
  return {
    ok: true,
    upstream,
    signal,
    ...(attemptSpan ? { attemptSpan, attemptStatusCode: upstream.status } : {})
  };
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

function bridgeMinimumInputTokens(
  provider: string,
  payload: Record<string, unknown>
): number {
  if (provider === "codex" || provider === "minimax") return 0;
  return estimatePayloadInputTokens(payload);
}

export async function writeSuccessfulResponse(
  response: ServerResponse,
  route: ProviderRoute,
  result: SuccessfulFetch,
  wantsStream: boolean,
  publicModel: string,
  requestId: string,
  resolvedModel: string,
  onHeartbeat: (() => void) | null = null,
  clientSignal: AbortSignal | null = null,
  minimumInputTokens?: number,
  holdFailureBeforeOutput = false
): Promise<StreamWriteResult> {
  const written = await writeProviderResponse(
    response,
    route,
    result,
    wantsStream,
    publicModel,
    requestId,
    resolvedModel,
    onHeartbeat,
    clientSignal,
    minimumInputTokens,
    holdFailureBeforeOutput
  );
  // Whoever asked for these calls gets their results: see tool-call-ownership.ts.
  TOOL_CALL_OWNERSHIP.record(written.toolCallIds, route.provider);
  return written;
}

type SuccessfulFetch = Extract<FetchUpstreamResult, { ok: true }>;

interface ProviderResponseContext {
  response: ServerResponse;
  route: ProviderRoute;
  result: SuccessfulFetch;
  publicModel: string;
  requestId: string;
  resolvedModel: string;
  responseHeaders: Record<string, string>;
  minimumInputTokens?: number;
}

function emptyBufferedResult(failed = false): StreamWriteResult {
  return {
    toolCalls: 0,
    toolCallIds: new Set(),
    failed,
    clientDisconnected: false,
    incompleteReason: null,
    limit: null,
    error: null,
    inputRequired: false,
    beforeOutput: false
  };
}

function finishBufferedAttempt(
  result: SuccessfulFetch,
  completed: Record<string, unknown> | null,
  failed: boolean
): void {
  endStreamAttempt(
    result.attemptSpan,
    result.attemptStatusCode,
    emptyBufferedResult(failed),
    observeResponse(completed)
  );
}

async function writeStreamedProviderResponse(
  context: ProviderResponseContext,
  onHeartbeat: (() => void) | null,
  clientSignal: AbortSignal | null,
  holdFailureBeforeOutput: boolean
): Promise<StreamWriteResult> {
  const {
    response,
    route,
    result,
    publicModel,
    responseHeaders,
    minimumInputTokens
  } = context;
  const upstream = result.upstream;
  // A candidate that answers on a stream an earlier one left open (it failed
  // before any output) finds the headers already sent. They name the first
  // candidate asked; the router's events name the one that answered.
  if (!response.headersSent)
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
    onHeartbeat,
    clientSignal,
    route.provider === "codex",
    {
      ...(result.attemptSpan ? { span: result.attemptSpan } : {}),
      ...(result.attemptStatusCode === undefined
        ? {}
        : { statusCode: result.attemptStatusCode })
    },
    minimumInputTokens,
    holdFailureBeforeOutput
  );
  // A stream whose failure was kept back stays open for the next candidate.
  if (streamResult.beforeOutput) return streamResult;
  if (!response.writableEnded && !response.destroyed && !response.closed) {
    try {
      response.end();
    } catch {
      NOOP();
    }
  }
  return streamResult;
}

function writeCodexBufferedResponse(
  context: ProviderResponseContext,
  body: string
): StreamWriteResult {
  const { response, result, publicModel, responseHeaders, minimumInputTokens } =
    context;
  // One pass over the body answers all three questions the buffered path used to
  // ask with three separate parses.
  const summary = summarizeBufferedSse(body);
  const completed = summary.firstCompleted;
  finishBufferedAttempt(
    result,
    completed,
    completed ? responseWasNotCompleted(completed) : false
  );
  const toolCalls = summary.toolCalls;
  const parsed = rewriteResponseValue(
    bufferedEnvelope(summary),
    publicModel,
    minimumInputTokens
  ) as Record<string, unknown>;
  sendJson(response, result.upstream.status, parsed, responseHeaders);
  const incomplete = incompleteFromResponse(parsed);
  const toolCallIds = new Set<string>();
  collectToolCallIds(parsed, toolCallIds);
  return {
    toolCalls,
    toolCallIds,
    failed: responseWasNotCompleted(parsed),
    clientDisconnected: false,
    ...incomplete,
    error: reportedError(parsed.error),
    inputRequired: hasInputRequired(parsed, incomplete),
    beforeOutput: false
  };
}

function writeRawBufferedResponse(
  context: ProviderResponseContext,
  body: string
): StreamWriteResult {
  const { response, result, responseHeaders } = context;
  finishBufferedAttempt(result, null, false);
  response.writeHead(result.upstream.status, {
    ...responseHeaders,
    "content-type":
      result.upstream.headers.get("content-type") ?? "application/json"
  });
  response.end(body);
  return emptyBufferedResult();
}

function writeJsonBufferedResponse(
  context: ProviderResponseContext,
  body: string
): StreamWriteResult {
  const { response, result, publicModel, responseHeaders, minimumInputTokens } =
    context;
  try {
    const parsed: unknown = JSON.parse(body);
    const responseObject =
      parsed && typeof parsed === "object"
        ? (parsed as Record<string, unknown>)
        : null;
    finishBufferedAttempt(
      result,
      responseObject,
      responseWasNotCompleted(responseObject)
    );
    const toolCalls = countToolCallsInResponse(parsed);
    const rewritten = rewriteResponseValue(
      parsed,
      publicModel,
      minimumInputTokens
    ) as Record<string, unknown>;
    sendJson(response, result.upstream.status, rewritten, responseHeaders);
    const incomplete = incompleteFromResponse(rewritten);
    const toolCallIds = new Set<string>();
    collectToolCallIds(rewritten, toolCallIds);
    return {
      toolCalls,
      toolCallIds,
      failed: responseWasNotCompleted(rewritten),
      clientDisconnected: false,
      error: reportedError(rewritten.error),
      ...incomplete,
      inputRequired: hasInputRequired(rewritten, incomplete),
      beforeOutput: false
    };
  } catch {
    return writeRawBufferedResponse(context, body);
  }
}

async function writeProviderResponse(
  response: ServerResponse,
  route: ProviderRoute,
  result: SuccessfulFetch,
  wantsStream: boolean,
  publicModel: string,
  requestId: string,
  resolvedModel: string,
  onHeartbeat: (() => void) | null,
  clientSignal: AbortSignal | null = null,
  minimumInputTokens?: number,
  holdFailureBeforeOutput = false
): Promise<StreamWriteResult> {
  const context: ProviderResponseContext = {
    response,
    route,
    result,
    publicModel,
    requestId,
    resolvedModel,
    ...(minimumInputTokens === undefined ? {} : { minimumInputTokens }),
    responseHeaders: {
      "x-autodev-provider": route.provider,
      "x-autodev-model": resolvedModel,
      "x-autodev-request-id": requestId,
      "x-autodev-router-instance-id": ROUTER_INSTANCE_ID
    }
  };
  if (wantsStream) {
    return writeStreamedProviderResponse(
      context,
      onHeartbeat,
      clientSignal,
      holdFailureBeforeOutput
    );
  }
  let body: string;
  try {
    body = await result.upstream.text();
  } catch (error) {
    if (result.attemptSpan) {
      const info = transportErrorInfo(error);
      endAttemptSpan(result.attemptSpan, {
        status: "error",
        statusCode: result.upstream.status,
        errorType: info.code ?? info.name,
        errorMessage: "provider response body could not be read"
      });
    }
    throw error;
  }
  return route.provider === "codex"
    ? writeCodexBufferedResponse(context, body)
    : writeJsonBufferedResponse(context, body);
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

/**
 * How long the reader waits, when the provider named a reset and the router
 * will not actually sleep until it.
 *
 * An inferred limit keeps its transient ladder rather than being trusted with a
 * long sleep, so the two times routinely differ -- a quota that says "resets in
 * 24m43s" against a 10-minute transient cooldown. Reporting only the provider's
 * reset would overstate the wait; reporting only the ladder would hide the
 * window the provider actually gave. Both are stated when they disagree, and the
 * single time is enough when the retry lands on it.
 */
function cooldownWindow(entry: CooldownSummary, now: number): string {
  const resetsAt = entry.resetsAt!;
  const retrySeconds = Math.max(0, Math.ceil(entry.retryAfterMs / 1000));
  const resetSeconds = Math.ceil((Date.parse(resetsAt) - now) / 1000);
  if (Math.abs(resetSeconds - retrySeconds) <= 60)
    return `resets at ${resetsAt}`;
  const resetIn = resetSeconds > 0 ? `${Math.ceil(resetSeconds / 60)}m` : "now";
  return `provider reports usage resets in ${resetIn} (${resetsAt}); retrying in ${retrySeconds}s`;
}

/**
 * How one candidate ended, in the words the reader needs.
 *
 * A route that refused the request did not fail: it cannot serve *this*
 * request, and saying it "did not complete the turn" sends the reader looking
 * for an outage that is not there.
 */
function describeCandidate(
  entry: CooldownSummary,
  observedClass: string | undefined,
  now: number
): string {
  if (observedClass === "unsupported_request")
    return `${entry.provider}: cannot serve this request`;
  if (entry.state === "available")
    return `${entry.provider}: available but did not complete the turn`;
  if (entry.state === "config")
    return `${entry.provider}: ${entry.failureClass ?? "configuration error"} for ${entry.model ?? "its model"}${entry.detail ? ` (${entry.detail})` : ""}`;
  if (entry.resetsAt)
    return `${entry.provider}: ${entry.failureClass ?? entry.state}, ${cooldownWindow(entry, now)}`;
  return `${entry.provider}: ${entry.failureClass ?? entry.state}, retry in ${Math.ceil(entry.retryAfterMs / 1000)}s`;
}

/**
 * What the reader should do next, which follows from why the chain came up
 * empty: a misconfigured route needs a correction, a route that refused needs
 * a different one, and a route that is merely out of usage needs patience.
 */
function exhaustionGuidance({
  everyCandidateMisconfigured,
  noneCanServe,
  outOfUsage,
  reset,
  retryAfterMs
}: {
  everyCandidateMisconfigured: boolean;
  noneCanServe: boolean;
  outOfUsage: boolean;
  reset: { resetsAt: string | null } | null;
  retryAfterMs: number;
}): string {
  if (everyCandidateMisconfigured)
    return "Retrying will not help: correct the provider configuration, then start a new turn.";
  if (noneCanServe)
    return "Retrying will not help: every candidate refused this request. Serve it on a route that can carry its content, or start a new turn without it.";
  if (outOfUsage)
    return `Every provider is out of usage${reset ? ` until at least ${reset.resetsAt}` : ""}. Retrying will not help before then; start a new turn once the usage window has reset.`;
  return `Retry after approximately ${Math.max(1, Math.ceil(retryAfterMs / 1000))}s.`;
}

export function exhaustionBody({
  subject,
  summary,
  failures,
  observed,
  model,
  requestId,
  lastResortAttempts,
  deadlineReached,
  excluded
}: {
  subject: string;
  summary: CooldownSummary[];
  failures: string[];
  observed?: ReadonlyMap<string, string>;
  model: string;
  requestId: string;
  lastResortAttempts: number;
  deadlineReached: boolean;
  /** The providers that never became candidates, and why. */
  excluded?: ReadonlyArray<{ provider: string; reason: string }>;
}): Record<string, unknown> {
  const now = Date.now();
  const retryAfterMs = summary.reduce(
    (soonest, entry) =>
      entry.retryAfterMs > 0 && (soonest === 0 || entry.retryAfterMs < soonest)
        ? entry.retryAfterMs
        : soonest,
    0
  );
  const firstMisconfigured = summary.find((entry) => entry.state === "config");
  const everyCandidateMisconfigured = exhaustedByConfiguration(summary);
  const seen = observed ?? new Map();
  const outOfUsage = exhaustedByUsage(summary, seen);
  const firstOutOfUsage = summary.find((entry) =>
    isNonRetryableClass(seen.get(entry.provider) ?? entry.failureClass)
  );
  const noneCanServe = noCandidateCanServe(summary, seen);
  const reset = soonestReset(summary);
  const described = summary.map((entry) =>
    describeCandidate(entry, seen.get(entry.provider), now)
  );
  // The providers that never became candidates are named too: a refusal that
  // lists only the providers it tried reads as though the others had never
  // been configured, and an operator who had enabled one for the role could
  // not see why it was never asked.
  const notAsked = (excluded ?? []).map(
    (entry) => `${entry.provider}: ${entry.reason}`
  );
  const action = everyCandidateMisconfigured
    ? "fix_configuration"
    : noneCanServe
      ? "summarize_and_yield"
      : outOfUsage
        ? "summarize_and_yield"
        : "retry_after";
  const guidance = exhaustionGuidance({
    everyCandidateMisconfigured,
    noneCanServe,
    outOfUsage,
    reset,
    retryAfterMs
  });
  const reason = deadlineReached
    ? `No available provider completed ${subject} within the ${Math.ceil(CHAIN_SELECTION_DEADLINE_MS / 1000)}s provider-selection budget.`
    : noneCanServe
      ? `No candidate can serve ${subject}.`
      : `No available provider completed ${subject}.`;
  return errorBody(
    `${reason} ${[...described, ...notAsked].join("; ")}. ${guidance}`,
    "router_provider_exhausted",
    {
      code: "router_provider_exhausted",
      retryable: !outOfUsage && !noneCanServe,
      failureClass: everyCandidateMisconfigured
        ? (firstMisconfigured?.failureClass ?? "invalid_model")
        : noneCanServe
          ? "unsupported_request"
          : outOfUsage
            ? (firstOutOfUsage?.failureClass ?? "quota_exhausted")
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
        excluded: excluded ?? [],
        now: new Date(now).toISOString()
      }
    }
  );
}

/**
 * Every candidate failed for a reason only the user can fix (a model the
 * provider rejects, bad credentials): a retry would fail the same way.
 */
function exhaustedByConfiguration(summary: CooldownSummary[]): boolean {
  return (
    summary.length > 0 && summary.every((entry) => entry.state === "config")
  );
}

/**
 * Failure classes a retry cannot fix: the provider's usage window is closed,
 * or it will not accept this model or these credentials at all.
 */
function isNonRetryableClass(failureClass: string | null | undefined): boolean {
  const value = String(failureClass ?? "");
  return (
    isHardLimitClass(value) ||
    value === "invalid_model" ||
    value === "authentication"
  );
}

/**
 * Every candidate is out of usage, so no retry can serve the request.
 *
 * A provider that reported a usage limit -- its quota exhausted, its session
 * limit reached -- said its window is closed, and that window resets on the
 * provider's clock, not the router's. A provider that is switched off or
 * misconfigured is equally beyond a retry. Only when every candidate is in one
 * of those states is the request genuinely over: the answer has to say so, and
 * the caller has to be told to come back later rather than be sent round the
 * chain again.
 *
 * A candidate that failed for any other reason -- a blip, an unreachable
 * bridge, a turn that did not complete -- is left out of this: a retry can
 * still serve it, and the router must keep the request alive for that.
 *
 * The class is the one this request saw, not the one sitting in the cooldown
 * entry. A usage limit does not always earn a long cooldown -- an inferred
 * limit stays on the transient ladder, so the provider looks briefly
 * unavailable even though its quota is gone for hours -- and a later attempt
 * against the same provider supersedes the entry's class, because the entry
 * only ever moves later.
 */
function exhaustedByUsage(
  summary: CooldownSummary[],
  observed: ReadonlyMap<string, string> = new Map()
): boolean {
  if (summary.length === 0) return false;
  return summary.every((entry) => {
    if (entry.state === "disabled" || entry.state === "config") return true;
    const seen = observed?.get(entry.provider);
    return isNonRetryableClass(seen ?? entry.failureClass);
  });
}

/**
 * No candidate can serve this request, so no retry can serve it either.
 *
 * A route that refuses a request does not fail: it cannot serve *this*
 * request, because the request carries something the route cannot carry. The
 * same request will be refused the same way next time, so a retry buys
 * nothing -- unless some other candidate is merely cooling down, because a
 * cooldown lapses and the route may serve the request then.
 *
 * The class is the one this request saw, not the one sitting in the cooldown
 * entry: a route that refused is healthy, and a later request without the
 * content must still reach it.
 */
function noCandidateCanServe(
  summary: CooldownSummary[],
  observed: ReadonlyMap<string, string> = new Map()
): boolean {
  if (summary.length === 0) return false;
  return summary.every((entry) => {
    if (observed.get(entry.provider) === "unsupported_request") return true;
    if (entry.state === "disabled" || entry.state === "config") return true;
    return false;
  });
}

export function exhaustionHeaders({
  summary,
  observed,
  requestId
}: {
  summary: CooldownSummary[];
  observed?: ReadonlyMap<string, string>;
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
    "x-autodev-request-id": requestId
  };
  // A `retry-after` is an instruction to come back. When nothing a retry can
  // do would serve the request, sending one tells the client to wait out a
  // window it cannot hurry -- and a client that honours it holds the turn open
  // for exactly that long, with nothing to show for it.
  if (
    !exhaustedByUsage(summary, observed) &&
    !noCandidateCanServe(summary, observed)
  )
    headers["retry-after"] = String(
      Math.max(1, Math.ceil(retryAfterMs / 1000))
    );
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
  attribution: ConcreteRequestAttribution;
  modelName: string;
  sessionKey: string | null;
  startedAt: number;
  setLogicalOutcome: (outcome: "ok" | "error") => void;
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
    role: ctx.attribution.role,
    origin: ctx.attribution.origin,
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
    role: ctx.attribution.role,
    origin: ctx.attribution.origin,
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
    role: ctx.attribution.role,
    origin: ctx.attribution.origin,
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
  getDefaultUsageTracker().activityTracker?.endRequest(activitySubject, {
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
  const retryAfterMs = retryable
    ? COOLDOWNS.nextRetryMs([{ provider: route.provider, model: modelName }])
    : 0;
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
  const attribution = concreteRequestAttribution(session);
  const modelName =
    typeof payload.model === "string" ? payload.model : "default";
  const logicalSpan = startLogicalRequestSpan({
    requestId,
    role: attribution.role,
    providerRole: "subagent",
    workspace,
    subject: "concrete request",
    requestedModel: modelName,
    turnMetadataHeader,
    sessionId: session?.sessionId ?? null
  });

  const disabledReason = ROUTING_POLICY.routeDisabledReason(
    { provider: route.provider, model: modelName },
    "subagent"
  );
  if (disabledReason) {
    rejectConcreteRequest(
      response,
      route,
      requestId,
      modelName,
      workspace,
      attribution,
      disabledReason
    );
    endLogicalRequestSpan(logicalSpan, {
      status: "error",
      errorMessage:
        disabledReason === "model_disabled"
          ? "model is disabled for this request"
          : "provider is disabled for this request"
    });
    return;
  }

  const startedAt = Date.now();
  const sessionKey = session?.key ?? null;
  let logicalOutcome: "ok" | "error" = "error";
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
    attribution,
    modelName,
    sessionKey,
    startedAt,
    setLogicalOutcome(outcome) {
      logicalOutcome = outcome;
    }
  };

  recordRouterEvent({
    phase: "selected",
    requestId,
    role: attribution.role,
    origin: attribution.origin,
    requestedModel: modelName,
    provider: route.provider,
    model: modelName,
    workspace
  });
  getDefaultUsageTracker().activityTracker?.beginRequest(activitySubject, {
    requestId,
    provider: route.provider,
    model: modelName,
    role: attribution.role,
    origin: attribution.origin,
    workspace: workspace?.key ?? null,
    sessionId: session?.sessionId ?? null
  });
  const bridgeContext = {
    activitySubject,
    provider: route.provider,
    model: modelName,
    role: attribution.role,
    workspace: workspace?.key ?? null,
    sessionKey,
    sessionId: session?.sessionId ?? null
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
  const releaseProviderCapacity = await acquireProviderCapacity(
    route,
    clientSignal
  );
  if (!releaseProviderCapacity) {
    recordConcreteAbort(ctx);
    endConcreteRequest(activitySubject, requestId, "failure");
    endLogicalRequestSpan(logicalSpan, {
      status: "error",
      errorMessage: "client aborted before provider admission"
    });
    return;
  }
  try {
    await withLogicalSpan(logicalSpan, async () => {
      await runConcreteAttempts(ctx, 0);
    });
  } catch (error) {
    handleConcreteOuterFailure(ctx, error);
  } finally {
    const finalOutcome = logicalOutcome as "ok" | "error";
    endLogicalRequestSpan(logicalSpan, {
      status: finalOutcome,
      errorMessage: finalOutcome === "error" ? "provider request failed" : null,
      provider: finalOutcome === "ok" ? route.provider : null
    });
    releaseProviderCapacity();
  }
}

function rejectConcreteRequest(
  response: ServerResponse,
  route: ProviderRoute,
  requestId: string,
  modelName: string,
  workspace: { key: string; cwd?: string | null } | null,
  attribution: ConcreteRequestAttribution,
  failureClass: RouteDisabledReason
): void {
  recordRouterEvent({
    phase: "skipped",
    requestId,
    role: attribution.role,
    origin: attribution.origin,
    requestedModel: modelName,
    provider: route.provider,
    model: modelName,
    workspace,
    failureClass
  });
  recordRouterEvent({
    phase: "result",
    requestId,
    role: attribution.role,
    origin: attribution.origin,
    requestedModel: modelName,
    provider: route.provider,
    model: modelName,
    workspace,
    outcome: "failure",
    status: 400,
    failureClass
  });
  // A disabled provider or model is not something a retry reaches: the body
  // says so, and a 5xx would have the client retry it anyway.
  sendJson(
    response,
    400,
    errorBody(
      failureClass === "model_disabled"
        ? `Direct concrete request to ${modelName} (${route.provider}) is unavailable because model ${modelName} is disabled.`
        : `Direct concrete request to ${modelName} (${route.provider}) is unavailable because provider ${route.provider} is disabled.`,
      "router_provider_unavailable",
      {
        code: "router_provider_unavailable",
        retryable: false,
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

async function runConcreteAttempts(
  ctx: ConcreteRequestContext,
  attempts: number
): Promise<void> {
  const maxAttempts = Math.max(
    CONCRETE_STATUS_MAX_ATTEMPTS,
    UPSTREAM_TRANSPORT_MAX_ATTEMPTS
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
      session,
      {
        selection: "concrete",
        attemptNumber: attempts + 1,
        model: typeof payload.model === "string" ? payload.model : null,
        requestedModel: ctx.modelName,
        role: ctx.attribution.role,
        workspace: ctx.workspace,
        sessionId: session?.sessionId ?? null
      }
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
  result: Extract<FetchUpstreamResult, { ok: false }>,
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
    coolDownRoute(
      route.provider,
      cooldownFor(failureClass, result.limit, modelName, result.body ?? null)
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
  result: Extract<FetchUpstreamResult, { ok: true }>
): Promise<void> {
  const responseResult = await writeSuccessfulResponse(
    ctx.response,
    ctx.route,
    result,
    ctx.wantsStream,
    ctx.modelName,
    ctx.requestId,
    ctx.modelName,
    () => getDefaultUsageTracker().activityTracker?.touch(ctx.activitySubject),
    ctx.clientSignal,
    bridgeMinimumInputTokens(ctx.route.provider, ctx.payload)
  );
  if (responseResult.clientDisconnected) {
    recordConcreteAbort(ctx);
    endConcreteRequest(ctx.activitySubject, ctx.requestId, "failure");
    return;
  }
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
  ctx.setLogicalOutcome(responseResult.failed ? "error" : "ok");
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
  if (attempts < UPSTREAM_TRANSPORT_MAX_ATTEMPTS - 1 && !response.headersSent) {
    const failureClass = classifyProviderFailure(502, errorMessage(error));
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
  const failureClass = classifyProviderFailure(502, errorMessage(error));
  recordConcreteResult(ctx, "failure", 502, failureClass);
  endConcreteRequest(activitySubject, requestId, "failure");
  coolDownRoute(
    route.provider,
    cooldownFor(failureClass, null, modelName, null)
  );
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
  const failureClass = classifyProviderFailure(502, errorMessage(error));
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
  /**
   * The agent role this request actually runs under.
   *
   * `role` is the role the requested model maps to, which is null for the
   * orchestrator alias; `agentRole` is the role the request is served under.
   * The logical request span carries the effective role, and an attempt is a
   * child of that request, so an attempt that carried only `role` would drop
   * the role of every orchestrator turn -- the largest tier -- and leave the
   * Usage attempt list reading `Not observed` where the request beside it
   * names one.
   */
  effectiveRole: string | null;
  origin: string | null;
  subject: string;
  agentRole: string | null;
  sessionKey: string | null;
  session: RouterSession | null;
  preferredProvider: string | null;
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
  /**
   * The client's stream is open and has been told nothing: a candidate
   * failed before any output and its failure was kept back.
   */
  streamHeld: boolean;
  /** Keeps a held stream alive between candidates. */
  heldStreamKeepAlive: NodeJS.Timeout | null;
};

/**
 * What this request saw of each candidate.
 *
 * The lines are the operator-facing account of the chain, one per candidate.
 * The classes are what the router acts on: whether a retry can help depends on
 * why a candidate failed, and the cooldown summary cannot answer that on its
 * own. A cooldown entry keeps the class of the failure that put it there, and a
 * later attempt against the same provider -- one that reached it and found it
 * briefly unavailable -- does not replace it, because a cooldown only ever
 * moves later. What this request actually saw is the fact.
 */
class CandidateFailures {
  private readonly lines: string[] = [];
  private readonly classes = new Map<string, string>();
  private readonly kinds = new Map<string, "failed" | "skipped">();

  /**
   * Record what a candidate did, and why, in the order it happened.
   *
   * The kind is what separates a provider that was tried and could not serve
   * the request from one that was never tried. The provider-hop tracker needs
   * that difference to say why an agent's provider changed: a failed provider
   * is a fallback, a provider that was passed over is not.
   */
  record(
    provider: string,
    why: string,
    failureClass: string,
    kind: "failed" | "skipped"
  ): void {
    this.lines.push(`${provider}: ${why}`);
    this.classes.set(provider, failureClass);
    this.kinds.set(provider, kind);
  }

  /** The account of the chain, for the error body. */
  get entries(): string[] {
    return [...this.lines];
  }

  /** The failure class this request saw from each provider it reached. */
  get observed(): ReadonlyMap<string, string> {
    return this.classes;
  }

  /**
   * What this request saw of the providers it passed over, in the order it
   * passed them.
   */
  passedOver(): readonly ProviderHopOutcome[] {
    return Array.from(this.kinds, ([provider, kind]) => ({
      provider,
      kind,
      failureClass: this.classes.get(provider) ?? null
    }));
  }
}

/** How often a held stream is told the response is still in progress. */
const HELD_STREAM_KEEP_ALIVE_MS = 15_000;

/**
 * Whether the client has been sent something that cannot be taken back.
 *
 * Headers alone are not that. A streamed candidate that fails before any
 * output leaves the client holding an open stream that has said nothing, and
 * the chain goes on exactly as if nothing had been sent -- the next candidate
 * answers on the same stream.
 */
function clientCommitted(ctx: FallbackContext): boolean {
  return ctx.response.headersSent && !ctx.streamHeld;
}

function stopHeldStreamKeepAlive(ctx: FallbackContext): void {
  if (ctx.heldStreamKeepAlive) clearInterval(ctx.heldStreamKeepAlive);
  ctx.heldStreamKeepAlive = null;
}

function writeToHeldStream(ctx: FallbackContext, chunk: string): void {
  const { response } = ctx;
  if (response.writableEnded || response.destroyed || response.closed) return;
  try {
    response.write(chunk);
  } catch {
    NOOP();
  }
}

/**
 * Keep the client's stream open, and alive, while the chain looks for
 * another candidate.
 *
 * The keep-alive is an event, not an SSE comment: Codex's stream idle timeout
 * (five minutes) counts events and never sees comments, and the next
 * candidate may take that long to send its first one. `response.in_progress`
 * is the Responses event for this state; Codex 0.167 was replayed a stream
 * carrying several, with differing response ids and a second
 * `response.created`, and completed the turn normally.
 */
function holdClientStream(ctx: FallbackContext): void {
  ctx.streamHeld = true;
  if (ctx.heldStreamKeepAlive) return;
  ctx.heldStreamKeepAlive = setInterval(() => {
    writeToHeldStream(
      ctx,
      `event: response.in_progress\ndata: ${JSON.stringify({
        type: "response.in_progress",
        response: {
          id: `router_${ctx.requestId}`,
          object: "response",
          status: "in_progress",
          model: ctx.modelName,
          output: []
        }
      })}\n\n`
    );
  }, HELD_STREAM_KEEP_ALIVE_MS);
  ctx.heldStreamKeepAlive.unref();
}

/** The client has been answered, or has left: the stream is no longer held. */
function commitClientStream(ctx: FallbackContext): void {
  stopHeldStreamKeepAlive(ctx);
  ctx.streamHeld = false;
}

/**
 * End a held stream with the failure the chain ended on.
 *
 * The stream is all the client has, so what would have been the HTTP error
 * is its last event.
 */
function failHeldStream(ctx: FallbackContext, message: string): void {
  stopHeldStreamKeepAlive(ctx);
  if (!ctx.streamHeld) return;
  ctx.streamHeld = false;
  writeToHeldStream(ctx, responseFailureEvent(message));
  if (!ctx.response.writableEnded && !ctx.response.destroyed)
    ctx.response.end();
}

function recordFallbackSkip(
  ctx: FallbackContext,
  route: Candidate,
  why: string,
  failureClass: string,
  failures: CandidateFailures
): void {
  failures.record(route.provider, why, failureClass, "skipped");
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

/**
 * Record the provider hop this request caused, if it caused one.
 *
 * A hop is a property of the agent, not of the request: the tracker knows
 * which provider served the agent last, and this request knows what it saw of
 * the providers it passed over. Together they say whether the agent's provider
 * changed and why. The provider that served the request is not among the
 * providers it passed over, so it never becomes the hop's own origin.
 *
 * The hop is published on the request's own span, because the request is the
 * thing that observed it: the trace of the turn that moved the agent says so,
 * and the Usage evidence can count it.
 */
function observeProviderHopForRequest(
  ctx: FallbackContext,
  route: Candidate,
  failures: CandidateFailures,
  span: Span
): void {
  const hop = observeProviderServed({
    subject: ctx.activitySubject,
    role: ctx.effectiveRole,
    workspace: ctx.workspace?.key ?? null,
    provider: route.provider,
    passedOver: failures
      .passedOver()
      .filter((outcome) => outcome.provider !== route.provider)
  });
  if (!hop) return;
  publishProviderHop(span, hop);
}

function beginCandidateRequest(
  ctx: FallbackContext,
  route: Candidate
): string | null {
  const activityRole =
    ctx.role ??
    ((ctx.origin ?? usageOrigin(ctx.role)) === "orchestrator"
      ? "orchestrator"
      : null);
  getDefaultUsageTracker().activityTracker?.beginRequest(ctx.activitySubject, {
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
          : usageOrigin(ctx.role)),
    workspace: ctx.workspace?.key ?? null,
    sessionId: ctx.session?.sessionId ?? null,
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
  if (ctx.sessionKey)
    getDefaultConcurrencyManager().touchOpenSubagentSlots(ctx.sessionKey);
  const bridgeContext = {
    activitySubject: ctx.activitySubject,
    provider: route.provider,
    model: route.model,
    role: ctx.role ?? (ctx.origin === "orchestrator" ? "orchestrator" : null),
    workspace: ctx.workspace?.key ?? null,
    sessionKey: ctx.sessionKey,
    sessionId: ctx.session?.sessionId ?? null
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
  } else if (ctx.role) {
    noteSubagentSession(ctx.sessionKey, ctx.role, route.provider, {
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
    session = null,
    preferredProvider = null,
    preparePayload
  }: {
    candidates: Candidate[] | OrchestratorCandidate[];
    role?: string | null;
    origin?: string | null;
    subject: string;
    agentRole?: string | null;
    sessionKey?: string | null;
    session?: RouterSession | null;
    preferredProvider?: string | null;
    preparePayload?: (
      payload: Record<string, unknown>
    ) => Promise<Record<string, unknown>>;
  },
  payload: Record<string, unknown>,
  wantsStream: boolean,
  requestId: string,
  turnMetadataHeader: string | null,
  workspace: {
    key: string;
    cwd?: string | null;
    workspace_id?: string;
  } | null,
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
  const logicalSpan = startLogicalRequestSpan({
    requestId,
    role: role ?? agentRole,
    providerRole,
    workspace,
    subject,
    requestedModel: modelName || null,
    turnMetadataHeader,
    sessionId: session?.sessionId ?? null,
    ...(isOrchestratorTurn
      ? {
          memoryMode: currentRouterMemoryMode({
            sessionKey,
            sessionScope: session?.scope ?? null,
            workspace
          })
        }
      : {})
  });
  if (!candidates || candidates.length === 0) {
    const rejection = routingRejection(providerRole, role, subject);
    rejectFallbackChain(
      response,
      requestId,
      role,
      origin,
      modelName,
      subject,
      workspace,
      isOrchestratorTurn,
      rejection
    );
    endLogicalRequestSpan(logicalSpan, {
      status: "error",
      errorMessage: rejection.reason
    });
    return;
  }
  const failures = new CandidateFailures();
  const attempted = new Set<string>();
  const skipped: Candidate[] = [];
  const startedAt = Date.now();
  const selectionDeadline = startedAt + CHAIN_SELECTION_DEADLINE_MS;
  const fbCtx: FallbackContext = {
    response,
    candidates,
    role,
    effectiveRole: role ?? agentRole,
    origin,
    subject,
    agentRole,
    sessionKey,
    session,
    preferredProvider,
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
    startedAt,
    streamHeld: false,
    heldStreamKeepAlive: null
  };
  const state = {
    deadlineReached: false,
    lastResortAttempts: 0,
    fallbackableProviderFailure: false
  };

  let logicalOutcome: "ok" | "error" = "error";
  let logicalErrorMessage: string | null = null;
  let servedProvider: string | null = null;

  const tryCandidate = async (
    route: Candidate,
    selection: string
  ): Promise<"served" | "terminal" | "fallback" | "unavailable"> => {
    const disabledReason = ROUTING_POLICY.routeDisabledReason(
      route,
      fbCtx.providerRole
    );
    if (disabledReason) {
      recordFallbackSkip(fbCtx, route, "disabled", disabledReason, failures);
      skipped.push(route);
      return "unavailable";
    }
    const probe = await probeProvider(route);
    if (!probe.ok) {
      if (probe.failureClass !== "missing_credential") {
        coolDownRoute(route.provider, {
          failureClass: probe.failureClass ?? PROBE_FAILURE_CLASS
        });
      }
      recordFallbackSkip(
        fbCtx,
        route,
        "unavailable",
        probe.failureClass ?? PROBE_FAILURE_CLASS,
        failures
      );
      skipped.push(route);
      return "unavailable";
    }
    COOLDOWNS.clearProbeFailures(route.provider);
    // Contention is neither a provider failure nor a health downgrade. Try a
    // ready peer first, but keep this candidate for the last-resort pass so a
    // sole usable provider can queue behind the tab already using its slot.
    if (
      selection === "primary" &&
      providerAtCapacity(route) &&
      candidates.some(
        (other) =>
          other.provider !== route.provider &&
          !attempted.has(other.provider) &&
          ROUTING_POLICY.routeDisabledReason(other, fbCtx.providerRole) ===
            null &&
          !COOLDOWNS.isCooling(other.provider, Date.now(), other.model) &&
          !providerAtCapacity(other)
      )
    ) {
      skipped.push(route);
      recordRouterEvent({
        phase: "skipped",
        requestId: fbCtx.requestId,
        role: fbCtx.role,
        origin: fbCtx.origin,
        requestedModel: fbCtx.modelName,
        provider: route.provider,
        model: route.model,
        workspace: fbCtx.workspace,
        failureClass: "capacity"
      });
      return "unavailable";
    }
    const outcome = await attemptCandidate(
      fbCtx,
      route,
      selection,
      failures,
      attempted
    );
    if (outcome === "fallback") state.fallbackableProviderFailure = true;
    if (outcome === "served") {
      logicalOutcome = "ok";
      logicalErrorMessage = null;
      servedProvider = route.provider;
      observeProviderHopForRequest(fbCtx, route, failures, logicalSpan);
    } else if (outcome === "terminal") {
      logicalErrorMessage = "provider attempt returned a terminal failure";
    }
    return outcome;
  };

  const served = servedOutcome;

  try {
    await withLogicalSpan(logicalSpan, async () => {
      if (preparePayload) {
        try {
          fbCtx.payload = await preparePayload(payload);
        } catch {
          // Memory is advisory; preparation must never block a routed task.
          fbCtx.payload = payload;
          logicalSpan.setAttribute(
            "autodev.memory.injection.result",
            "unavailable"
          );
        }
      }
      if (
        await runPrimaryPass(
          fbCtx,
          candidates,
          state,
          skipped,
          failures,
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
      if (
        await runExhaustionWait(
          fbCtx,
          candidates,
          state,
          failures,
          tryCandidate,
          served
        )
      )
        return;
      finalizeFallbackFailure(
        response,
        fbCtx,
        failures,
        state.lastResortAttempts,
        state.deadlineReached,
        attempted
      );
      logicalErrorMessage = "no candidate served the request";
    });
  } finally {
    // Whatever ended the chain, a stream still held open is ended with it.
    failHeldStream(
      fbCtx,
      `Router could not complete ${subject}: no provider answered.`
    );
    const finalOutcome = logicalOutcome as "ok" | "error";
    endLogicalRequestSpan(logicalSpan, {
      status: finalOutcome,
      errorMessage: logicalErrorMessage,
      provider: finalOutcome === "ok" ? servedProvider : null
    });
  }
}

/**
 * Why a tier had no candidate to serve a request.
 *
 * An empty candidate list is two different faults. "Every provider is
 * disabled" is fixed by the enable switches. "The enabled provider cannot
 * serve this role" is fixed by nothing the operator can switch: the
 * orchestrator tier admits only providers with a delegation path, because an
 * orchestrator's job is creating child agents. Reporting the first cause for
 * both sent the operator to the enable switches with the provider already
 * enabled -- which is how a session ended with "no enabled providers" while
 * the one provider that was enabled could never have served the role.
 */
interface RoutingRejection {
  readonly failureClass: "provider_disabled" | "provider_cannot_delegate";
  readonly message: string;
  readonly reason: string;
}

function routingRejection(
  providerRole: "orchestrator" | "subagent",
  role: string | null,
  subject: string
): RoutingRejection {
  const tier =
    providerRole === "orchestrator"
      ? ROUTING_CONFIG.orchestrator.tier
      : ROUTING_POLICY.tierForRole(role);
  const blockers = tier
    ? ROUTING_POLICY.tierServingBlockers(tier, providerRole)
    : null;
  const cannotDelegate = blockers?.cannotDelegate ?? [];
  if (cannotDelegate.length > 0) {
    const capable = ROUTING_POLICY.orchestratorCapableProviders();
    const explanations = cannotDelegate
      .map((provider) =>
        ROUTING_POLICY.providerRoleCapabilityExplanation(provider, providerRole)
      )
      .filter((explanation): explanation is string => explanation !== null);
    return {
      failureClass: "provider_cannot_delegate",
      message: `No provider can serve ${subject}: ${explanations.join(" ")} Enable a provider with a delegation path for it${
        capable.length > 0 ? ` (${capable.join(", ")})` : ""
      }.`,
      reason: `no provider with a delegation path can serve ${subject}`
    };
  }
  return {
    failureClass: "provider_disabled",
    message: `No enabled providers or models available for ${subject}.`,
    reason: `no enabled provider can serve ${subject}`
  };
}

function rejectFallbackChain(
  response: ServerResponse,
  requestId: string,
  role: string | null,
  origin: string | null,
  modelName: string,
  subject: string,
  workspace: { key: string; cwd?: string | null } | null,
  isOrchestratorTurn: boolean,
  rejection: RoutingRejection
): void {
  // A root orchestrator turn spawns nothing; only a child request is a spawn.
  if (!isOrchestratorTurn)
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
    status: 400,
    failureClass: rejection.failureClass
  });
  sendJson(
    response,
    400,
    errorBody(rejection.message, "router_provider_exhausted", {
      code: "router_provider_exhausted",
      retryable: false,
      failureClass: rejection.failureClass,
      model: modelName,
      requestId
    }),
    { "x-autodev-request-id": requestId }
  );
}

function triedCandidates(
  attempted: Set<string>
): (provider: string) => boolean {
  return (provider: string) => attempted.has(provider);
}

export function stickyCooldownWaitWindowMs(
  isOrchestratorTurn: boolean
): number {
  const configured = Number.parseInt(
    process.env.CODEX_ROUTER_STICKY_COOLDOWN_WAIT_MS ?? ""
  );
  if (Number.isFinite(configured) && configured >= 0) return configured;
  if (EXHAUSTION_WAIT_MS <= 0) return 0;
  return Math.max(
    exhaustionWaitWindowMs(isOrchestratorTurn),
    COOLDOWN_CONFIG.providerCooldownMs * 2
  );
}

function canWaitOutStickyCooldown(
  ctx: FallbackContext,
  candidates: Candidate[] | OrchestratorCandidate[],
  route: Candidate,
  cooldown: CooldownEntry | null
): number {
  if (
    !cooldown ||
    candidates.length <= 1 ||
    ctx.preferredProvider === null ||
    ctx.preferredProvider !== route.provider
  ) {
    return 0;
  }
  if (ctx.clientSignal?.aborted || clientCommitted(ctx)) return 0;
  if (cooldown.kind === "config") return 0;
  const windowMs = stickyCooldownWaitWindowMs(ctx.isOrchestratorTurn);
  if (windowMs <= 0) return 0;
  const now = Date.now();
  if (isHardLimitClass(cooldown.failureClass ?? "")) {
    const resetsAtMs = cooldown.resetsAt
      ? Date.parse(cooldown.resetsAt)
      : Number.NaN;
    if (!Number.isFinite(resetsAtMs) || resetsAtMs > now + windowMs) {
      return 0;
    }
    return Math.max(0, resetsAtMs - now);
  }
  const remainingMs = cooldown.until - now;
  if (remainingMs <= 0 || remainingMs > windowMs) return 0;
  return remainingMs;
}

async function waitOutStickyCooldown(
  ctx: FallbackContext,
  route: Candidate,
  initialWaitMs: number
): Promise<boolean> {
  const windowMs = stickyCooldownWaitWindowMs(ctx.isOrchestratorTurn);
  if (windowMs <= 0 || initialWaitMs <= 0 || initialWaitMs > windowMs) {
    return false;
  }
  const waitStartedAt = Date.now();
  recordRouterEvent({
    phase: "exhaustion_wait",
    requestId: ctx.requestId,
    role: ctx.role,
    origin: ctx.origin,
    requestedModel: ctx.modelName,
    provider: route.provider,
    model: route.model,
    workspace: ctx.workspace,
    elapsedMs: initialWaitMs
  });
  /* eslint-disable no-await-in-loop -- Sequential recheck of cooldown expiry on the sticky provider. */
  while (!ctx.clientSignal?.aborted && !clientCommitted(ctx)) {
    const now = Date.now();
    const entry = COOLDOWNS.get(route.provider, now, route.model);
    const remainingCooldownMs = entry ? Math.max(0, entry.until - now) : 0;
    if (remainingCooldownMs <= 0) {
      ctx.selectionDeadline += Date.now() - waitStartedAt;
      return true;
    }
    const remainingWindowMs = windowMs - (now - waitStartedAt);
    if (remainingWindowMs <= 0) break;
    await delay(
      Math.min(remainingCooldownMs, remainingWindowMs),
      ctx.clientSignal
    );
  }
  /* eslint-enable no-await-in-loop */
  return false;
}

async function tryPrimaryRoute(
  ctx: FallbackContext,
  candidates: Candidate[] | OrchestratorCandidate[],
  index: number,
  state: {
    deadlineReached: boolean;
    lastResortAttempts: number;
    fallbackableProviderFailure: boolean;
  },
  skipped: Candidate[],
  failures: CandidateFailures,
  tryCandidate: (
    route: Candidate,
    selection: string
  ) => Promise<"served" | "terminal" | "fallback" | "unavailable">,
  served: (outcome: string) => boolean
): Promise<boolean> {
  if (index >= candidates.length) return false;
  const route = candidates[index]!;
  // A slow provider failure leaves the downstream response untouched, so the
  // remaining candidates still deserve a chance even after the search window.
  if (
    Date.now() > ctx.selectionDeadline &&
    !state.fallbackableProviderFailure
  ) {
    state.deadlineReached = true;
    return false;
  }
  const disabledReason = ROUTING_POLICY.routeDisabledReason(
    route,
    ctx.providerRole
  );
  if (disabledReason) {
    recordFallbackSkip(ctx, route, "disabled", disabledReason, failures);
    skipped.push(route);
    return tryPrimaryRoute(
      ctx,
      candidates,
      index + 1,
      state,
      skipped,
      failures,
      tryCandidate,
      served
    );
  }
  let cooldown = COOLDOWNS.get(route.provider, Date.now(), route.model);
  if (cooldown && cooldown.kind !== "config") {
    const stickyWaitMs = canWaitOutStickyCooldown(
      ctx,
      candidates,
      route,
      cooldown
    );
    if (stickyWaitMs > 0) {
      await waitOutStickyCooldown(ctx, route, stickyWaitMs);
      cooldown = COOLDOWNS.get(route.provider, Date.now(), route.model);
    }
  }
  if (cooldown && cooldown.kind !== "probe") {
    recordFallbackSkip(
      ctx,
      route,
      "cooldown active",
      cooldown.failureClass ?? "cooldown",
      failures
    );
    skipped.push(route);
    return tryPrimaryRoute(
      ctx,
      candidates,
      index + 1,
      state,
      skipped,
      failures,
      tryCandidate,
      served
    );
  }
  const firstOutcome = await tryCandidate(route, "primary");
  if (served(firstOutcome)) return true;
  if (
    (firstOutcome === "fallback" || firstOutcome === "unavailable") &&
    ctx.preferredProvider !== null &&
    ctx.preferredProvider === route.provider &&
    !clientCommitted(ctx) &&
    !ctx.clientSignal?.aborted &&
    !isRequestRefusalClass(failures.observed.get(route.provider))
  ) {
    const postCooldown = COOLDOWNS.get(route.provider, Date.now(), route.model);
    const retryWaitMs = canWaitOutStickyCooldown(
      ctx,
      candidates,
      route,
      postCooldown
    );
    if (retryWaitMs > 0) {
      const waited = await waitOutStickyCooldown(ctx, route, retryWaitMs);
      if (
        waited &&
        !ctx.clientSignal?.aborted &&
        !clientCommitted(ctx) &&
        !COOLDOWNS.isCooling(route.provider, Date.now(), route.model) &&
        served(await tryCandidate(route, "primary"))
      )
        return true;
    }
  }
  return tryPrimaryRoute(
    ctx,
    candidates,
    index + 1,
    state,
    skipped,
    failures,
    tryCandidate,
    served
  );
}

function runPrimaryPass(
  ctx: FallbackContext,
  candidates: Candidate[] | OrchestratorCandidate[],
  state: {
    deadlineReached: boolean;
    lastResortAttempts: number;
    fallbackableProviderFailure: boolean;
  },
  skipped: Candidate[],
  failures: CandidateFailures,
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
    failures,
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
  if (state.deadlineReached) return Promise.resolve(false);
  // A provider already serving other agents goes last, so concurrent exhausted
  // requests spread over the skipped providers. It is never excluded: with
  // Codex the orchestrator tier's only provider and always live in some other
  // session, excluding it turned one transient failure into an instant 503
  // for every root turn until the cooldown lapsed (observed 2026-09-24, for up
  // to ten minutes), since nothing could attempt the success that clears it.
  const busy = (route: Candidate): number =>
    getDefaultUsageTracker().countLiveAgentActivity(
      { provider: route.provider },
      Date.now(),
      undefined,
      ctx.activitySubject
    ) > 0
      ? 1
      : 0;
  const eligible = skipped
    .filter(
      (route) =>
        ROUTING_POLICY.routeDisabledReason(route, ctx.providerRole) === null &&
        !isTried(route.provider) &&
        COOLDOWNS.allowsLastResort(
          COOLDOWNS.get(route.provider, Date.now(), route.model)
        )
    )
    .sort(
      (a, b) =>
        busy(a) - busy(b) ||
        (COOLDOWNS.get(a.provider, Date.now(), a.model)?.until ?? 0) -
          (COOLDOWNS.get(b.provider, Date.now(), b.model)?.until ?? 0)
    )
    .slice(0, LAST_RESORT_MAX_ATTEMPTS);
  return tryLastResortRoute(ctx, eligible, 0, state, tryCandidate, served);
}

/**
 * How long a request may wait for a cooldown to lapse. An orchestrator turn
 * holds no subagent slot, and ending it ends every child's work with it, so it
 * may outlast one first-strike transient cooldown; with a shorter window a
 * single-provider orchestrator tier could never be rescued by waiting.
 */
export function exhaustionWaitWindowMs(isOrchestratorTurn: boolean): number {
  if (EXHAUSTION_WAIT_MS <= 0) return 0;
  return isOrchestratorTurn
    ? Math.max(EXHAUSTION_WAIT_MS, COOLDOWN_CONFIG.providerCooldownMs)
    : EXHAUSTION_WAIT_MS;
}

async function runExhaustionWait(
  ctx: FallbackContext,
  candidates: Candidate[] | OrchestratorCandidate[],
  state: { deadlineReached: boolean; lastResortAttempts: number },
  failures: CandidateFailures,
  tryCandidate: (
    route: Candidate,
    selection: string
  ) => Promise<"served" | "terminal" | "fallback" | "unavailable">,
  served: (outcome: string) => boolean
): Promise<boolean> {
  // The wait buys one more attempt, after a cooldown lapses. It is worth
  // spending only when the lapse would let the provider serve: a blip that
  // clears, or a usage window the provider named as ending inside the window.
  // A provider that said it is out of usage will not serve when its cooldown
  // lapses -- its window resets on the provider's clock, not the router's --
  // so waiting for it, and then attempting it, only delays the answer the
  // caller needs now, and re-attempts a provider whose quota is gone for hours
  // on every window. That is the hammering the cooldowns exist to prevent.
  const windowMs = exhaustionWaitWindowMs(ctx.isOrchestratorTurn);
  const waitCandidates = candidates.filter((route) => {
    if (ROUTING_POLICY.routeDisabledReason(route, ctx.providerRole) !== null)
      return false;
    if (isRequestRefusalClass(failures.observed.get(route.provider)))
      return false;
    const cooldown = COOLDOWNS.get(route.provider, Date.now(), route.model);
    if (!cooldown) return true;
    if (cooldown.kind === "config") return false;
    if (!isHardLimitClass(cooldown.failureClass ?? "")) return true;
    const resetsAt = cooldown.resetsAt
      ? Date.parse(cooldown.resetsAt)
      : Number.NaN;
    return Number.isFinite(resetsAt) && resetsAt <= Date.now() + windowMs;
  });
  const cooldownCandidates = waitCandidates.map(({ provider, model }) => ({
    provider,
    model
  }));
  const waitMs = COOLDOWNS.nextRetryMs(cooldownCandidates);
  if (
    !state.deadlineReached &&
    windowMs > 0 &&
    waitMs > 0 &&
    waitMs <= windowMs &&
    !ctx.clientSignal?.aborted &&
    !clientCommitted(ctx)
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
    const waitStartedAt = Date.now();
    // Cooldown state must be re-read after each wake; parallel sleeps can
    // resume before the authoritative reset time and recreate the 503 race.
    /* eslint-disable no-await-in-loop -- This wait is sequential by cooldown state. */
    while (
      !ctx.clientSignal?.aborted &&
      !clientCommitted(ctx) &&
      !state.deadlineReached
    ) {
      const now = Date.now();
      const remainingCooldownMs = COOLDOWNS.nextRetryMs(
        cooldownCandidates,
        now
      );
      if (remainingCooldownMs <= 0)
        return tryExhaustionRoute(waitCandidates, 0, tryCandidate, served);

      const remainingWindowMs = windowMs - (now - waitStartedAt);
      if (remainingWindowMs <= 0) break;
      // Timers can fire before Date.now crosses the provider's absolute reset
      // timestamp. Recheck authoritative cooldown state and wait the remainder
      // instead of abandoning an otherwise recoverable request.
      await delay(
        Math.min(remainingCooldownMs, remainingWindowMs),
        ctx.clientSignal
      );
    }
    /* eslint-enable no-await-in-loop */
  }
  return false;
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
  if (COOLDOWNS.isCooling(route.provider, Date.now(), route.model)) {
    return tryExhaustionRoute(waitCandidates, index + 1, tryCandidate, served);
  }
  const outcome = await tryCandidate(route, "exhaustion_wait");
  if (served(outcome)) return true;
  if (outcome !== "unavailable" && outcome !== "fallback") return false;
  return tryExhaustionRoute(waitCandidates, index + 1, tryCandidate, served);
}

function finalizeFallbackFailure(
  response: ServerResponse,
  ctx: FallbackContext,
  failures: CandidateFailures,
  lastResortAttempts: number,
  deadlineReached: boolean,
  _attempted: Set<string>
): void {
  if (!ctx.isOrchestratorTurn)
    recordSpawnFailure({
      requestId: ctx.requestId,
      role: ctx.role,
      requestedModel: ctx.modelName,
      reason: deadlineReached ? "selection_deadline" : "provider_exhausted"
    });
  closeBridgeSubagentsForRequest(ctx.requestId, "failure");
  getDefaultUsageTracker().activityTracker?.endRequest(ctx.activitySubject, {
    requestId: ctx.requestId,
    outcome: "failure",
    hasToolCalls: false
  });
  const summary = COOLDOWNS.summary(
    ctx.candidates,
    Date.now(),
    ctx.providerRole
  );
  // Codex retries a 5xx; a failure no retry can fix must not be one. A request
  // whose every candidate is out of usage is not fixable by trying again, so it
  // is answered with a status that ends the caller's turn and says when the
  // usage window resets. A 5xx here would leave the client waiting out a
  // `retry-after` measured in hours, with nothing happening in between. The
  // same holds for a request every candidate refused: the same request will
  // be refused again.
  const observed = failures.observed;
  const noneCanServe = noCandidateCanServe(summary, observed);
  // The providers the operator configured that this request never asked: they
  // are named in the refusal, so a provider that was switched off or disabled
  // for the role does not look like one that was never configured.
  const tier =
    ctx.providerRole === "orchestrator"
      ? ROUTING_CONFIG.orchestrator.tier
      : ROUTING_POLICY.tierForRole(ctx.role);
  const excluded = tier
    ? ROUTING_POLICY.excludedProviders(tier, ctx.providerRole)
    : [];
  const body = exhaustionBody({
    subject: ctx.subject,
    summary,
    failures: failures.entries,
    observed,
    model: ctx.modelName,
    requestId: ctx.requestId,
    lastResortAttempts,
    deadlineReached,
    excluded
  });
  // A chain that ran out with the client's stream held open has no status
  // line left to answer with: the account of the chain is the stream's
  // failure.
  if (ctx.streamHeld) {
    failHeldStream(
      ctx,
      String((body.error as { message?: unknown } | undefined)?.message ?? "")
    );
    return;
  }
  sendJson(
    response,
    exhaustedByUsage(summary, observed) || noneCanServe ? 400 : 503,
    body,
    exhaustionHeaders({ summary, observed, requestId: ctx.requestId })
  );
}

async function attemptCandidate(
  ctx: FallbackContext,
  route: Candidate,
  selection: string,
  failures: CandidateFailures,
  _attempted: Set<string>
): Promise<"served" | "terminal" | "fallback"> {
  const attemptStartedAt = Date.now();
  const releaseProviderCapacity = await acquireProviderCapacity(
    route,
    ctx.clientSignal
  );
  if (!releaseProviderCapacity) {
    recordCandidateClientAbort(ctx, route, selection, attemptStartedAt);
    return "terminal";
  }
  _attempted.add(route.provider);
  recordFallbackSelected(ctx, route, selection);
  beginCandidateRequest(ctx, route);
  emitFallbackBridgeContext(ctx, route);

  try {
    const result = await fetchCandidate(ctx, route, selection);
    if (result.ok) {
      return await handleCandidateSuccess(
        ctx,
        route,
        result,
        selection,
        failures,
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
    releaseProviderCapacity();
  }
}

/**
 * One candidate's upstream call, retried in place while the connection fails
 * before any response. Observed 2026-09-24: chatgpt.com connections broke
 * mid-upload (EPIPE/ECONNRESET) or never opened (connect timeout); each one
 * cooled Codex -- the orchestrator tier's only provider -- and failed the
 * root turn outright, where native Codex would simply have reconnected. The
 * last error propagates to the caller, which records it and cools the
 * provider.
 */
async function fetchCandidate(
  ctx: FallbackContext,
  route: Candidate,
  selection: string,
  attempt = 1
): Promise<FetchUpstreamResult> {
  try {
    return await fetchUpstream(
      route,
      payloadForCandidate(ctx.payload, route),
      ctx.wantsStream,
      ctx.turnMetadataHeader,
      ctx.clientSignal,
      ctx.agentRole,
      ctx.requestId,
      ctx.session,
      {
        selection,
        attemptNumber: attempt,
        model: route.model,
        requestedModel: ctx.modelName,
        role: ctx.effectiveRole,
        workspace: ctx.workspace,
        sessionId: ctx.session?.sessionId ?? null
      }
    );
  } catch (error) {
    if (
      attempt >= UPSTREAM_TRANSPORT_MAX_ATTEMPTS ||
      ctx.clientSignal?.aborted ||
      (error as { code?: string } | undefined)?.code ===
        "router_auth_unavailable"
    )
      throw error;
    logTransportError({
      requestId: ctx.requestId,
      role: ctx.role,
      requestedModel: ctx.modelName,
      provider: route.provider,
      model: route.model,
      error,
      workspace: ctx.workspace
    });
    recordRouterEvent({
      phase: "retry",
      requestId: ctx.requestId,
      role: ctx.role,
      origin: ctx.origin,
      requestedModel: ctx.modelName,
      provider: route.provider,
      model: route.model,
      workspace: ctx.workspace,
      status: 502,
      failureClass: classifyProviderFailure(502, errorMessage(error)),
      elapsedMs: Date.now() - ctx.startedAt
    });
    await jitteredBackoff();
    if (ctx.clientSignal?.aborted) throw error;
    return fetchCandidate(ctx, route, selection, attempt + 1);
  }
}

/**
 * The client left mid-request (Codex Desktop archiving a thread with a turn in
 * flight, a cancelled turn): record it as `client_aborted` and leave the
 * provider's standing alone. A provider-wide cooldown here once took Codex
 * away from every other session for 30s because one thread was archived.
 */
function recordCandidateClientAbort(
  ctx: FallbackContext,
  route: Candidate,
  selection: string,
  attemptStartedAt: number
): void {
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
    status: 499,
    failureClass: "client_aborted",
    elapsedMs: Date.now() - attemptStartedAt,
    selection
  });
  endConcreteRequest(ctx.activitySubject, ctx.requestId, "failure");
}

async function handleCandidateSuccess(
  ctx: FallbackContext,
  route: Candidate,
  result: SuccessfulFetch,
  selection: string,
  failures: CandidateFailures,
  attemptStartedAt: number
): Promise<"served" | "terminal" | "fallback"> {
  try {
    // The candidate's own events keep the stream alive from here.
    stopHeldStreamKeepAlive(ctx);
    const responseResult = await writeSuccessfulResponse(
      ctx.response,
      route,
      result,
      ctx.wantsStream,
      ctx.modelName,
      ctx.requestId,
      route.model,
      () => {
        getDefaultUsageTracker().activityTracker?.touch(ctx.activitySubject);
        if (ctx.sessionKey) {
          getDefaultUsageTracker().activityTracker?.touch(ctx.sessionKey);
          getDefaultConcurrencyManager().touchOpenSubagentSlots(ctx.sessionKey);
        }
      },
      ctx.clientSignal,
      bridgeMinimumInputTokens(route.provider, ctx.payload),
      // Only a streamed attempt can be left behind: a buffered one has
      // answered the client by the time its failure is known.
      ctx.wantsStream
    );
    if (responseResult.clientDisconnected) {
      commitClientStream(ctx);
      recordCandidateClientAbort(ctx, route, selection, attemptStartedAt);
      return "terminal";
    }
    // The stream is held open exactly when this attempt said nothing on it.
    if (responseResult.beforeOutput) holdClientStream(ctx);
    else commitClientStream(ctx);
    if (responseResult.failed) {
      const failureClass =
        responseResult.limit?.limitClass ??
        (responseResult.incompleteReason
          ? "unavailable"
          : classifyReportedFailure(responseResult.error));
      // A route that cannot serve this request is not a broken provider: the
      // prompt never reached it, the provider is healthy, and cooling it down
      // pushes every other agent away from a working route. The refusal is
      // reported, and the provider keeps serving the traffic it can serve.
      if (failureClass !== "unsupported_request")
        coolDownRoute(
          route.provider,
          cooldownFor(failureClass, responseResult.limit, route.model, null)
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
      // A streamed attempt that failed before any output told the client
      // nothing, so it is a candidate that could not serve the request, like
      // one that answered with an HTTP error: the next one is asked. Bridges
      // open their stream at once and report every failure inside it, so
      // without this no failure of theirs could ever fall back -- a site that
      // refused a request was handed each of the client's retries again.
      if (responseResult.beforeOutput) {
        const detail = responseResult.error?.message ?? null;
        failures.record(
          route.provider,
          failureClass === "unsupported_request" && detail
            ? `cannot serve this request (${detail})`
            : `failed before any output (${failureClass})`,
          failureClass,
          "failed"
        );
        return "fallback";
      }
      getDefaultUsageTracker().activityTracker?.endRequest(
        ctx.activitySubject,
        {
          requestId: ctx.requestId,
          outcome: "failure",
          hasToolCalls: responseResult.toolCalls > 0,
          inputRequired: Boolean(responseResult.inputRequired)
        }
      );
      return "terminal";
    }
    COOLDOWNS.clearAfterSuccess(route.provider, route.model);
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
    getDefaultUsageTracker().activityTracker?.endRequest(ctx.activitySubject, {
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
    coolDownRoute(
      route.provider,
      cooldownFor("upstream_error", null, route.model, null)
    );
    throw streamError;
  }
  return "served";
}

function handleCandidateUpstreamFailure(
  ctx: FallbackContext,
  route: Candidate,
  result: Extract<FetchUpstreamResult, { ok: false }>,
  selection: string,
  failures: CandidateFailures,
  attemptStartedAt: number
): "served" | "terminal" | "fallback" {
  const failureClass =
    result.limit?.limitClass ??
    classifyProviderFailure(result.status ?? 500, result.body);
  // A refusal carries the reason it cannot serve the request. "HTTP 400" on
  // its own reads like an outage, and sends the reader looking for one.
  const refusal =
    failureClass === "unsupported_request"
      ? providerErrorDetail(result.body ?? "")
      : null;
  failures.record(
    route.provider,
    refusal
      ? `cannot serve this request (${refusal})`
      : `HTTP ${result.status}`,
    failureClass,
    "failed"
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
    status: result.status,
    failureClass,
    elapsedMs: Date.now() - attemptStartedAt,
    selection
  });
  const decision = decideCandidateFailure(result.status ?? 500, result.body);
  if (decision.outcome === "terminal") {
    if (ctx.streamHeld)
      failHeldStream(
        ctx,
        providerErrorDetail(result.body ?? "") ??
          `${route.provider} answered HTTP ${result.status ?? 500}.`
      );
    else {
      ctx.response.writeHead(result.status ?? 500, {
        "content-type": "application/json",
        "x-autodev-provider": route.provider,
        "x-autodev-model": route.model,
        "x-autodev-request-id": ctx.requestId,
        "x-autodev-router-instance-id": ROUTER_INSTANCE_ID
      });
      ctx.response.end(result.body);
    }
    getDefaultUsageTracker().activityTracker?.endRequest(ctx.activitySubject, {
      requestId: ctx.requestId,
      outcome: "failure",
      hasToolCalls: false
    });
    return "terminal";
  }
  if (decision.coolDown) {
    coolDownRoute(
      route.provider,
      cooldownFor(failureClass, result.limit, route.model, result.body ?? null)
    );
  }
  return "fallback";
}

function handleCandidateTransportError(
  ctx: FallbackContext,
  route: Candidate,
  selection: string,
  failures: CandidateFailures,
  attemptStartedAt: number,
  error: unknown
): "served" | "terminal" | "fallback" {
  if (ctx.clientSignal?.aborted) {
    recordCandidateClientAbort(ctx, route, selection, attemptStartedAt);
    return "terminal";
  }
  const isAuthFailure =
    (error as { code?: string } | undefined)?.code ===
    "router_auth_unavailable";
  const failureClass = isAuthFailure
    ? "authentication"
    : classifyProviderFailure(502, errorMessage(error));
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
  failures.record(route.provider, failureClass, failureClass, "failed");
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
  coolDownRoute(
    route.provider,
    cooldownFor(failureClass, null, route.model, null)
  );
  if (clientCommitted(ctx)) {
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
    getDefaultUsageTracker().activityTracker?.endRequest(ctx.activitySubject, {
      requestId: ctx.requestId,
      outcome: "failure",
      hasToolCalls: false
    });
    return "terminal";
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
  const sessionKey = session?.key ?? null;
  const threadId = session?.thread ?? null;
  const threadSubject =
    session?.thread && session.thread !== session.key
      ? `thread:${session.thread}`
      : null;
  const preferred =
    TOOL_CALL_OWNERSHIP.ownerFor(payload) ??
    subagentProviderForSession(sessionKey, role) ??
    (threadId ? subagentProviderForSession(threadId, role) : null) ??
    (threadSubject
      ? (getDefaultUsageTracker().activityTracker?.getRecord(threadSubject)
          ?.provider ?? null)
      : null) ??
    (sessionKey
      ? (getDefaultUsageTracker().activityTracker?.getRecord(sessionKey)
          ?.provider ?? null)
      : null);
  return proxyFallbackChain(
    response,
    {
      candidates: ROUTING_POLICY.roleCandidates(role, Math.random, preferred),
      role,
      agentRole: role,
      subject: `role ${role}`,
      sessionKey: session?.key ?? null,
      session,
      preferredProvider: preferred
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
  workspace: { key: string; cwd?: string | null; workspace_id?: string } | null,
  clientSignal: AbortSignal | null = null,
  session: RouterSession | null = null
): Promise<void> {
  const sessionKey = session?.key ?? null;
  // The provider that issued the calls being answered comes first; otherwise
  // an orchestrator mid-session stays with the provider it started on.
  const preferred =
    TOOL_CALL_OWNERSHIP.ownerFor(payload) ??
    orchestratorProviderForSession(sessionKey);
  return proxyFallbackChain(
    response,
    {
      candidates: ROUTING_POLICY.orchestratorCandidates(Math.random, preferred),
      role: null,
      origin: "orchestrator",
      agentRole: ORCHESTRATOR_AGENT_ROLE,
      subject: "the orchestrator",
      sessionKey,
      session,
      preferredProvider: preferred,
      preparePayload: (requestPayload) =>
        injectOrchestratorMemory({
          payload: requestPayload,
          requestId,
          sessionKey,
          sessionScope: session?.scope ?? null,
          threadId: session?.thread ?? null,
          workspace
        })
    },
    payload,
    wantsStream,
    requestId,
    turnMetadataHeader,
    workspace,
    clientSignal
  );
}
