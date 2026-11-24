/**
 * Shared Router HTTP response helpers, probe logic, cooldown helpers, and
 * transport error classification.
 */

import { randomUUID } from "node:crypto";
import type { ServerResponse } from "node:http";

import {
  type ClientSurface,
  SIGN_IN_REQUIRED_FAILURE_CLASS
} from "@simulatorlife/autodev-core";
import { PROBE_FAILURE_CLASS } from "@simulatorlife/autodev-runtime/router/cooldown";
import {
  INVALID_MODEL_PATTERN,
  recordRouterEvent
} from "@simulatorlife/autodev-runtime/router/events";
import type { ProviderRoute } from "@simulatorlife/autodev-runtime/router/routing";
import { errorMessage } from "@simulatorlife/autodev-runtime/shared/error-message";
import {
  providerRequestUnsupported,
  providerSignInRequiredMessage,
  providerToolChannelUnavailable
} from "@simulatorlife/autodev-runtime/shared/provider-http";
import {
  LIMIT_SOURCE_REPORTED,
  normalizeResetsAt,
  type ProviderLimit,
  readLimitHeaders,
  readResetAtFromHeaders
} from "@simulatorlife/autodev-runtime/shared/provider-limits";
import {
  ConstantBackoff,
  handleWhen,
  retry,
  timeout,
  TimeoutStrategy
} from "cockatiel";

import { loadCodexAuth } from "../providers/codex-auth.ts";
import { ROUTING_POLICY } from "./routing.ts";

export const ROUTER_INSTANCE_ID = randomUUID();

export const CLIENT_DISCONNECT_CODES = Object.freeze(
  new Set([
    "EPIPE",
    "ECONNRESET",
    "ERR_STREAM_DESTROYED",
    "ERR_STREAM_WRITE_AFTER_END"
  ])
);

const FALLBACKABLE_BODY_REGEX =
  /quota|rate.?limit|weekly.?limit|usage.?limit|usage exhausted|session|high.?demand|credit|timeout|timed.?out|overloaded|temporarily unavailable|unavailable/i;
const TIMEOUT_MESSAGE_PATTERN = /timeout|timed out|aborted/i;
const MAX_UPSTREAM_DETAIL_CHARS = 300;

function pickString(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}

function pickBool(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
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
export const UPSTREAM_TRANSPORT_MAX_ATTEMPTS = positiveDuration(
  process.env.CODEX_ROUTER_UPSTREAM_TRANSPORT_RETRY_LIMIT,
  3
);
export const PROBE_RETRY_TIMEOUT_MS = Math.max(1500, PROBE_TIMEOUT_MS * 2);

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
  if (typeof code === "string" && CLIENT_DISCONNECT_CODES.has(code)) {
    return true;
  }
  const cause = (error as { cause?: { code?: string } }).cause;
  return Boolean(
    cause &&
      typeof cause === "object" &&
      typeof cause.code === "string" &&
      CLIENT_DISCONNECT_CODES.has(cause.code)
  );
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
  origin = null,
  provider,
  model,
  requestedModel = model,
  error,
  workspace
}: {
  requestId: string | null;
  role?: string | null;
  origin?: string | null;
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
    origin,
    requestedModel,
    provider,
    model,
    outcome: "error",
    failureClass: "transport",
    errorName: info.name,
    errorCode: info.code,
    syscall: info.syscall,
    workspace
  });
}

export interface RouterSession {
  key: string;
  scope: string;
  thread?: string | null;
  sessionId?: string;
  clientSurface?: ClientSurface | null;
}

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

const OPENAI_LIMIT_CODE_MAP: Record<
  string,
  { limitClass: ProviderLimit["limitClass"]; limitType: string }
> = {
  usage_limit_reached: { limitClass: "quota_exhausted", limitType: "quota" },
  insufficient_quota: { limitClass: "quota_exhausted", limitType: "quota" },
  billing_hard_limit_reached: {
    limitClass: "quota_exhausted",
    limitType: "quota"
  },
  quota_exceeded: { limitClass: "quota_exhausted", limitType: "quota" },
  rate_limit_exceeded: { limitClass: "throttled", limitType: "rate" },
  too_many_requests: { limitClass: "throttled", limitType: "rate" },
  session_limit_reached: { limitClass: "session_limit", limitType: "session" }
};

function bodyLimitResetAt(
  errorObj: Record<string, unknown>,
  headers: unknown,
  now: number
): string | null {
  const absolute = normalizeResetsAt(errorObj.resets_at);
  if (absolute) return absolute;
  const resetsInSeconds = Number(errorObj.resets_in_seconds);
  if (Number.isFinite(resetsInSeconds) && resetsInSeconds > 0) {
    return new Date(now + Math.ceil(resetsInSeconds * 1000)).toISOString();
  }
  return readResetAtFromHeaders(headers, now);
}

export function declaredLimit(
  headers: unknown,
  body: unknown,
  now = Date.now()
): ProviderLimit | null {
  const fromHeaders = readLimitHeaders(headers);
  if (fromHeaders) {
    return {
      limitClass: fromHeaders.limitClass,
      limitType: fromHeaders.limitType ?? null,
      resetsAt: fromHeaders.resetsAt ?? readResetAtFromHeaders(headers, now),
      source: fromHeaders.source ?? LIMIT_SOURCE_REPORTED
    };
  }
  try {
    const parsed = JSON.parse(String(body ?? "")) as Record<string, unknown>;
    const err =
      (parsed?.error as Record<string, unknown> | undefined) ??
      (parsed?.detail as Record<string, unknown> | undefined) ??
      parsed;
    const declared = err?.limit as Record<string, unknown> | undefined;
    if (declared?.class) {
      return {
        limitClass: String(declared.class).toLowerCase(),
        limitType: declared.type ? String(declared.type).toLowerCase() : null,
        resetsAt:
          normalizeResetsAt(declared.resets_at) ??
          readResetAtFromHeaders(headers, now),
        source:
          declared.source === LIMIT_SOURCE_REPORTED
            ? LIMIT_SOURCE_REPORTED
            : "inferred"
      };
    }
    const code = String(err?.type ?? err?.code ?? "").toLowerCase();
    const mapped = OPENAI_LIMIT_CODE_MAP[code];
    if (!mapped) return null;
    return {
      limitClass: mapped.limitClass,
      limitType: mapped.limitType,
      resetsAt: bodyLimitResetAt(err, headers, now),
      source: LIMIT_SOURCE_REPORTED
    };
  } catch {
    return null;
  }
}

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

export function cooldownFor(
  failureClass: string,
  limit: ProviderLimit | null = null,
  model: string | null = null,
  body: string | null = null
) {
  return {
    failureClass: limit?.limitClass ?? failureClass,
    resetsAt: limit?.resetsAt ?? null,
    structured: limit?.source === LIMIT_SOURCE_REPORTED,
    model,
    detail: body === null ? null : providerErrorDetail(body)
  };
}

export function fallbackable(status: number, body: unknown): boolean {
  if ([401, 408, 429, 500, 502, 503, 504].includes(status)) return true;
  if (status === 400 && INVALID_MODEL_PATTERN.test(String(body ?? ""))) {
    return true;
  }
  if (providerRequestUnsupported(body)) return true;
  if (providerToolChannelUnavailable(body)) return true;
  return FALLBACKABLE_BODY_REGEX.test(String(body ?? ""));
}

export interface CandidateFailureDecision {
  readonly outcome: "terminal" | "fallback";
  readonly coolDown: boolean;
}

export function decideCandidateFailure(
  status: number,
  body: string | null
): CandidateFailureDecision {
  if (!fallbackable(status, body)) {
    return { outcome: "terminal", coolDown: false };
  }
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

function isProbeTimeout(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === "TimeoutError" ||
      error.name === "AbortError" ||
      error.name === "TaskCancelledError" ||
      TIMEOUT_MESSAGE_PATTERN.test(error.message))
  );
}

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

  const probeRetryPolicy = retry(handleWhen(isProbeTimeout), {
    maxAttempts: 1,
    backoff: new ConstantBackoff(0)
  });

  let probeResult: {
    ok: boolean;
    status?: number;
    body?: string;
    error?: unknown;
  };

  try {
    probeResult = await probeRetryPolicy.execute(({ attempt }) => {
      const timeoutMs =
        attempt === 0 ? PROBE_TIMEOUT_MS : PROBE_RETRY_TIMEOUT_MS;
      const probeTimeout = timeout(timeoutMs, TimeoutStrategy.Cooperative);
      return probeTimeout.execute(async ({ signal }) => {
        try {
          const response = await fetch(route.healthUrl!, { signal });
          if (response.ok) return { ok: true, status: response.status };
          const body = await response.text().catch(() => "");
          return { ok: false, status: response.status, body };
        } catch (error) {
          if (isProbeTimeout(error)) throw error;
          return { ok: false, error };
        }
      });
    });
  } catch (error) {
    probeResult = { ok: false, error };
  }

  if (probeResult.ok) return { ok: true, failureClass: null };

  const signIn = providerSignInRequiredMessage(probeResult.body);
  if (signIn !== null) {
    return {
      ok: false,
      failureClass: SIGN_IN_REQUIRED_FAILURE_CLASS,
      detail: signIn
    };
  }

  const detail = probeResult.error
    ? `Probe failed: ${errorMessage(probeResult.error)}`
    : `Probe returned HTTP ${probeResult.status}`;

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
