/**
 * Server-only typed fetcher for the AutoDev Control API.
 *
 * This module is the single owner of the service credential and the canonical
 * local actor identity used by the Console. It MUST only be imported by
 * Server Components, Server Actions, or other server-only code paths.
 *
 * - The service token is read from `process.env.AUTODEV_CONTROL_API_TOKEN`.
 *   It is never serialized to a client payload, log line, or error message.
 * - The actor header is the canonical `LOCAL_CONTROL_API_ACTOR` exported by
 *   `@simulatorlife/autodev-core`. It is never read from any browser-supplied
 *   header or query parameter.
 *
 * If the upstream Control API is unavailable, this module returns a
 * discriminated `ControlApiResult` so the UI can render a clear unavailable
 * state instead of fabricating values.
 */

import nodePath from "node:path";

import {
  assertWorkspacePlaytestApproval,
  assertWorkspaceVisualPlaytestTargetApproval,
  type ControlApiAgentDetailResponse,
  type ControlApiAgentEnablementPatchRequest,
  type ControlApiAgentEnablementPatchResponse,
  type ControlApiAgentsResponse,
  type ControlApiConcurrencyPatchRequest,
  type ControlApiConcurrencyPatchResponse,
  type ControlApiConcurrencyStatus,
  type ControlApiError,
  type ControlApiEvaluationsResponse,
  type ControlApiGithubResponse,
  type ControlApiHookDeclaration,
  type ControlApiHookEvent,
  type ControlApiHookEventPatchRequest,
  type ControlApiHookEventPatchResponse,
  type ControlApiHooksAppliedResponse,
  type ControlApiHooksResponse,
  type ControlApiMcpAppliedResponse,
  type ControlApiMcpRuntimeResponse,
  type ControlApiMcpServerPatchRequest,
  type ControlApiMcpServerPatchResponse,
  type ControlApiMcpsResponse,
  type ControlApiMemoryCohortsResponse,
  type ControlApiMemoryExperienceDetailResponse,
  type ControlApiMemoryExperiencesResponse,
  type ControlApiMemoryHistoryResponse,
  type ControlApiMemoryInjectionOutcomeJoin,
  type ControlApiMemoryInjectionOutcomesResponse,
  type ControlApiMemoryInjectionUseAssessment,
  type ControlApiMemoryInjectionUseAssessmentsResponse,
  type ControlApiMemoryRecordActionPayload,
  type ControlApiMemoryRecordDetailResponse,
  type ControlApiMemoryRecordsResponse,
  type ControlApiMemoryRecordTransitionAction,
  type ControlApiMemorySessionOutcomeReportResponse,
  type ControlApiMemoryStatusResponse,
  type ControlApiMemoryUseCohortsResponse,
  type ControlApiMemoryWhyResponse,
  type ControlApiModelPatchResponse,
  type ControlApiModelsResponse,
  type ControlApiPermissionsPatchRequest,
  type ControlApiPermissionsPatchResponse,
  type ControlApiPermissionsResponse,
  type ControlApiPromptCommandPatchRequest,
  type ControlApiPromptCommandPatchResponse,
  type ControlApiPromptDetailResponse,
  type ControlApiPromptsResponse,
  type ControlApiPromptVersionResponse,
  type ControlApiPromptVersionsResponse,
  type ControlApiProviderAgentLimits,
  type ControlApiProviderEnabledPatchResponse,
  type ControlApiProviderLimitsPatchResponse,
  type ControlApiProviderModelDiscovery,
  type ControlApiProviderModelsResponse,
  type ControlApiProviderRolePatchResponse,
  type ControlApiProvidersResetRequest,
  type ControlApiProvidersResetResponse,
  type ControlApiProvidersResponse,
  type ControlApiRuntimeResponse,
  type ControlApiSkillContentPatchRequest,
  type ControlApiSkillContentPatchResponse,
  type ControlApiSkillContentResponse,
  type ControlApiSkillRolesPatchRequest,
  type ControlApiSkillRolesPatchResponse,
  type ControlApiSkillsResponse,
  type ControlApiToolsResponse,
  type ControlApiWorkspacePatchRequest,
  type ControlApiWorkspacePatchResponse,
  type ControlApiWorkspacePlaytestApprovalResponse,
  type ControlApiWorkspacesResponse,
  type ControlApiWorkspaceVisualPlaytestTargetsResponse,
  type ConvergenceStatus,
  isExperienceOutcome,
  isMemoryAuthority,
  isMemoryExecutionMode,
  isMemoryInjectionResult,
  isMemoryOutcomeReportKind,
  isMemoryOutcomeReportReasonCode,
  isMemoryUseKind,
  isSandboxMode,
  LOCAL_CONTROL_API_ACTOR,
  MEMORY_STATUSES,
  type MemoryExperiencePurgeReason,
  type MemoryStatus,
  PROVIDER_ROLES,
  type ProviderRole,
  type ProviderRolePriority,
  type ReconciliationDiff,
  type ReconciliationStatus,
  type WorkspaceConfigurationHealth,
  type WorkspaceRuntimeAvailability
} from "@simulatorlife/autodev-core";

import { readSecretFromFile } from "./secret-file.ts";

export type ControlApiResult<T> =
  | { readonly kind: "ok"; readonly data: T }
  | {
      readonly kind: "unauthorized";
      readonly status: number;
      readonly code: string;
      readonly message: string;
    }
  | {
      readonly kind: "http-error";
      readonly status: number;
      readonly code: string;
      readonly message: string;
    }
  | {
      readonly kind: "unreachable";
      readonly message: string;
      /**
       * The read was abandoned at the Console's own deadline rather than refused
       * by the service.
       *
       * Additive and optional, so every consumer that branches on
       * `kind === "unreachable"` is unaffected -- but it is the difference
       * between two materially different facts. Measured in Chromium against a
       * Control API fixture that accepts the request and never answers: the page
       * settled on `autodev_unreachable` carrying the browser's own `AbortError`
       * text, "This operation was aborted", followed by the advice to configure
       * the server-side integration. None of which is true. The service was
       * reachable -- it is holding the connection open -- and the operator's
       * next move is to look at why the query is slow, not to reconfigure a
       * credential that is working.
       */
      readonly timedOut?: boolean;
    }
  | {
      readonly kind: typeof INVALID_RESPONSE_KIND;
      readonly code: string;
      readonly message: string;
    };

const DEFAULT_CONTROL_API_BASE_URL = "http://127.0.0.1:4101";
const CONTROL_API_TIMEOUT_MS = 5000;
const GITHUB_CONTROL_API_TIMEOUT_MS = 20_000;
/**
 * Playtesting reads and writes are answered by the Control API's
 * ClickHouse-backed store. Measured against the live Control API, one
 * playtesting read takes 1-3 seconds on its own, and the playtesting page
 * fans five of them out in parallel, so the generic 5-second Control API
 * deadline expires against a service that is answering normally. The
 * GitHub projection already carries its own budget for the same reason.
 */
export const PLAYTESTING_CONTROL_API_TIMEOUT_MS = 20_000;
const INVALID_RESPONSE_KIND = "invalid-response" as const;
const PROMPT_VERSION_TIMEOUT_MS = 12_000;
const CONTROL_API_REVISION_PATTERN = /^[a-f0-9]{64}$/u;
const CONTROL_API_GIT_REVISION_PATTERN = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;
const TRAILING_SLASHES = /\/+$/u;

export interface ControlApiConfig {
  readonly baseUrl: string;
  readonly serviceToken: string;
}

export function readControlApiConfig(
  env: NodeJS.ProcessEnv = process.env
): ControlApiConfig | null {
  let serviceToken = env.AUTODEV_CONTROL_API_TOKEN?.trim() ?? "";
  if (!serviceToken) {
    const home = env.HOME?.trim();
    const codexHome =
      env.CODEX_HOME?.trim() || (home ? nodePath.join(home, ".codex") : null);
    if (codexHome) {
      const secretFile =
        env.AUTODEV_OPENLIT_SECRET_FILE?.trim() ||
        nodePath.join(codexHome, "openlit-secrets.env");
      serviceToken =
        readSecretFromFile(secretFile, "AUTODEV_CONTROL_API_TOKEN") ?? "";
    }
  }
  if (!serviceToken) return null;
  const baseUrl =
    env.AUTODEV_CONTROL_API_BASE_URL?.trim() || DEFAULT_CONTROL_API_BASE_URL;
  return { baseUrl: baseUrl.replace(TRAILING_SLASHES, ""), serviceToken };
}

export interface FetchControlApiOptions {
  readonly fetchImpl?: typeof fetch;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  readonly maxRetries?: number;
  readonly retryDelayMs?: number;
}

/**
 * Issues an authenticated GET against the AutoDev Control API.
 *
 * Never accepts a `headers` argument; the only headers sent are the canonical
 * service credential and the canonical local actor identity. No browser header
 * is ever forwarded.
 */
/**
 * Transport failures as a sentence an operator can act on, keyed by the standard
 * cause code the platform reports.
 *
 * `fetch` itself is no use as a diagnostic: every one of these arrives as
 * `TypeError: fetch failed`, which says that something failed and nothing about
 * what. What separates them is `error.cause.code` -- `ECONNREFUSED` against a
 * Control API that is not running, `ENOTFOUND` against a host that does not
 * resolve, `ECONNRESET` against one that accepted the connection and dropped it
 * -- and each points at a different thing to check.
 *
 * `cause.message` is deliberately not forwarded. It reads
 * "connect ECONNREFUSED 127.0.0.1:4101", which puts the configured Control API
 * address into a browser-rendered panel. The errno name is a stable standard
 * identifier and carries the same diagnostic value without the address.
 *
 * An unrecognised code is still named rather than dropped: a cause the Console
 * has not seen before is more informative than a sentence that claims to be the
 * whole story.
 */
const TRANSPORT_FAILURE_MESSAGES: Readonly<Record<string, string>> = {
  ECONNREFUSED:
    "Nothing is listening at the configured AutoDev Control API address.",
  ENOTFOUND: "The configured AutoDev Control API host could not be resolved.",
  EAI_AGAIN:
    "The configured AutoDev Control API host could not be resolved right now.",
  ECONNRESET: "The AutoDev Control API closed the connection before answering.",
  EHOSTUNREACH:
    "The configured AutoDev Control API address could not be reached.",
  ETIMEDOUT: "The connection to the AutoDev Control API did not open in time."
};

function describeTransportFailure(error: unknown): string {
  const cause = (error as { readonly cause?: unknown } | null | undefined)
    ?.cause;
  const code = (cause as { readonly code?: unknown } | null | undefined)?.code;
  if (typeof code !== "string") {
    return "The Console could not open a connection to the AutoDev Control API.";
  }
  return (
    TRANSPORT_FAILURE_MESSAGES[code] ??
    `The Console could not reach the AutoDev Control API (${code}).`
  );
}

/**
 * The one place a read or a write that never completed is turned into a result.
 *
 * Two functions catch here and they used to answer differently -- the GET grew a
 * deadline branch and the POST kept forwarding `error.message` -- which is the
 * drift this removes. One classifier, so a timeout reads the same whichever
 * request it was.
 */
function transportFailure(
  error: unknown,
  abortedByDeadline: boolean,
  timeoutMs: number
): {
  readonly kind: "unreachable";
  readonly message: string;
  readonly timedOut?: boolean;
} {
  if (abortedByDeadline) {
    return {
      kind: "unreachable",
      timedOut: true,
      message: `The AutoDev Control API did not answer within ${Math.round(timeoutMs / 1000)}s.`
    };
  }
  return { kind: "unreachable", message: describeTransportFailure(error) };
}

const RETRYABLE_NETWORK_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ETIMEDOUT"
]);

/**
 * The Console's own deadline and a caller's abort, combined.
 *
 * A caller-supplied signal used to *replace* the deadline, which quietly
 * removed the Console's promise that a service it cannot read becomes an
 * explicit state: the read then waited for the caller instead, and a caller
 * that waits for the read waits forever -- a page that never renders. The
 * deadline belongs to the Console, so it has to hold whatever the caller
 * asked for; the caller's abort only ever ends the read sooner.
 */
function deadlineSignal(
  controller: AbortController,
  callerSignal: AbortSignal | undefined
): AbortSignal {
  if (!callerSignal) return controller.signal;
  return AbortSignal.any([controller.signal, callerSignal]);
}

function isRetryableNetworkError(error: unknown): boolean {
  const cause = (error as { readonly cause?: unknown } | null | undefined)
    ?.cause;
  const code = (cause as { readonly code?: unknown } | null | undefined)?.code;
  return typeof code === "string" && RETRYABLE_NETWORK_CODES.has(code);
}

/** Resolve after `milliseconds`, without handing back the timer handle. */
function waitBeforeRetry(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

/**
 * The one retry policy for the Control API reads.
 *
 * The JSON read and the binary read each used to carry their own copy of this
 * loop, and the copies had already drifted apart. The policy lives here so
 * both reads stop for the same reasons -- the Console's own deadline, a
 * caller-supplied abort, or a failure that is not worth retrying -- and so a
 * retry never outlives the request that asked for it.
 */
interface ControlApiRetryOptions {
  readonly maxRetries: number;
  readonly baseRetryDelayMs: number;
  readonly controller: AbortController;
  readonly callerSignal: AbortSignal | undefined;
  readonly timeoutMs: number;
}

async function withControlApiRetry<T>(
  attempt: (attemptIndex: number) => Promise<ControlApiResult<T>>,
  options: ControlApiRetryOptions
): Promise<ControlApiResult<T>> {
  const { maxRetries, baseRetryDelayMs, controller, callerSignal, timeoutMs } =
    options;
  /* eslint-disable no-await-in-loop -- each attempt must settle before the next request starts */
  for (let attemptIndex = 0; attemptIndex <= maxRetries; attemptIndex++) {
    try {
      return await attempt(attemptIndex);
    } catch (error) {
      const isLastAttempt = attemptIndex >= maxRetries;
      const canRetry =
        !isLastAttempt &&
        !controller.signal.aborted &&
        !callerSignal?.aborted &&
        isRetryableNetworkError(error);

      if (canRetry) {
        await waitBeforeRetry(baseRetryDelayMs * (attemptIndex + 1));
        continue;
      }

      // Our own deadline, read off the controller rather than off the error: the
      // abort surfaces as a `DOMException` whose message is a browser
      // implementation detail ("This operation was aborted"), and forwarding that
      // to an operator says nothing about their system. `controller.signal` rather
      // than the caller's signal because a caller may supply its own, in which
      // case this controller aborting means nothing -- the caller gave up, which
      // is not the Console's deadline.
      return transportFailure(error, controller.signal.aborted, timeoutMs);
    }
  }
  /* eslint-enable no-await-in-loop */
  return {
    kind: "unreachable",
    message: describeTransportFailure(new Error("Connection retries exhausted"))
  };
}

export async function fetchControlApi<T>(
  path: string,
  config: ControlApiConfig,
  options: FetchControlApiOptions = {}
): Promise<ControlApiResult<T>> {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const controller = new AbortController();
  const timeoutMs = options.timeoutMs ?? CONTROL_API_TIMEOUT_MS;
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const signal = deadlineSignal(controller, options.signal);

  try {
    return await withControlApiRetry(
      async () => {
        const response = await fetchImpl(`${config.baseUrl}${path}`, {
          method: "GET",
          headers: {
            Authorization: `Bearer ${config.serviceToken}`,
            "X-AutoDev-Actor": LOCAL_CONTROL_API_ACTOR,
            Accept: "application/json"
          },
          // The Control API reads live runtime state, so a read is never a
          // cached one: a page that re-reads after a write has to see what
          // the write produced.
          cache: "no-store",
          signal
        });

        if (response.ok) {
          try {
            const data = (await response.json()) as T;
            return { kind: "ok", data };
          } catch {
            return {
              kind: "unreachable",
              message: "AutoDev Control API returned a non-JSON body."
            };
          }
        }

        return readControlApiFailure(response);
      },
      {
        maxRetries: options.maxRetries ?? 2,
        baseRetryDelayMs: options.retryDelayMs ?? 100,
        controller,
        callerSignal: options.signal,
        timeoutMs
      }
    );
  } finally {
    clearTimeout(timer);
  }
}

export interface ControlApiBinaryData {
  readonly bytes: Uint8Array;
  readonly mediaType: "image/png" | "image/jpeg" | "image/webp";
}

const BINARY_RESPONSE_MAX_BYTES = 8 * 1024 * 1024;
const CONTENT_LENGTH_PATTERN = /^\d+$/u;
const PLAYTEST_FRAME_ROUTE_PATTERN =
  /^\/control\/playtesting\/episodes\/([^/]+)\/media\/([^/]+)$/u;
const FRAME_ID_PATTERN = /^[A-Za-z0-9._:%-]{1,512}$/u;
const WORKSPACE_ID_PATTERN = /^[^/\s]+\/[^/\s]+$/u;
const DISPLAYABLE_FRAME_TYPES = [
  "image/png",
  "image/jpeg",
  "image/webp"
] as const;

function validPlaytestFramePath(path: string): boolean {
  const url = new URL(path, "http://127.0.0.1");
  const match = url.pathname.match(PLAYTEST_FRAME_ROUTE_PATTERN);
  const workspaceValues = url.searchParams.getAll("workspaceId");
  return (
    url.origin === "http://127.0.0.1" &&
    match !== null &&
    FRAME_ID_PATTERN.test(match[1]!) &&
    FRAME_ID_PATTERN.test(match[2]!) &&
    workspaceValues.length === 1 &&
    WORKSPACE_ID_PATTERN.test(workspaceValues[0]!) &&
    [...url.searchParams.keys()].every((key) => key === "workspaceId")
  );
}

async function readBoundedBinary(
  response: Response,
  maximumBytes: number
): Promise<Uint8Array> {
  const body = response.body;
  if (body === null) {
    throw new TypeError("The Control API returned an empty image body.");
  }
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  const readNextChunk = async (): Promise<void> => {
    const { done, value } = await reader.read();
    if (done) return;
    totalBytes += value.byteLength;
    if (totalBytes > maximumBytes) {
      await reader.cancel();
      throw new RangeError("The Control API image exceeded the display bound.");
    }
    chunks.push(value);
    await readNextChunk();
  };
  await readNextChunk();
  if (totalBytes === 0) {
    throw new TypeError("The Control API returned an empty image body.");
  }
  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

/**
 * Authenticated, bounded image read for an episode-linked Playtesting frame.
 * Only the fixed local Control API route and inert raster image types are
 * accepted; the service credential never reaches the browser.
 */
export async function fetchControlApiBinary(
  path: string,
  config: ControlApiConfig,
  options: FetchControlApiOptions = {}
): Promise<ControlApiResult<ControlApiBinaryData>> {
  if (!validPlaytestFramePath(path)) {
    return {
      kind: INVALID_RESPONSE_KIND,
      code: "autodev_control_api_invalid_playtesting_frame_path",
      message: "The Console refused an invalid Playtesting frame path."
    };
  }
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const controller = new AbortController();
  const timeoutMs = options.timeoutMs ?? CONTROL_API_TIMEOUT_MS;
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await withControlApiRetry(
      () =>
        readControlApiBinaryFrame(
          fetchImpl,
          path,
          config,
          deadlineSignal(controller, options.signal)
        ),
      {
        maxRetries: options.maxRetries ?? 2,
        baseRetryDelayMs: options.retryDelayMs ?? 100,
        controller,
        callerSignal: options.signal,
        timeoutMs
      }
    );
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The media type of a Playtesting frame, or `null` when the Control API
 * returned a type the Console will not display.
 */
function displayableFrameMediaType(contentType: string): string | null {
  const separator = contentType.indexOf(";");
  const mediaType = (
    separator === -1 ? contentType : contentType.slice(0, separator)
  )
    .trim()
    .toLowerCase();
  if (!(DISPLAYABLE_FRAME_TYPES as readonly string[]).includes(mediaType)) {
    return null;
  }
  return mediaType;
}

/** True when the declared content length already exceeds the display bound. */
function exceedsBinaryResponseLimit(contentLength: string | null): boolean {
  return (
    contentLength !== null &&
    CONTENT_LENGTH_PATTERN.test(contentLength) &&
    Number(contentLength) > BINARY_RESPONSE_MAX_BYTES
  );
}

/** The result for a frame body that could not be read within the bound. */
function binaryReadFailure(
  error: unknown
): ControlApiResult<ControlApiBinaryData> {
  if (error instanceof RangeError) {
    return {
      kind: "http-error",
      status: 413,
      code: "autodev_control_api_playtesting_frame_too_large",
      message: "The selected frame exceeds the Console display bound."
    };
  }
  return {
    kind: INVALID_RESPONSE_KIND,
    code: "autodev_control_api_invalid_playtesting_frame_body",
    message: "The Control API returned an unreadable Playtesting frame."
  };
}

/**
 * One attempt at reading a Playtesting frame: the request, the type and size
 * guards, and the bounded body read.
 */
async function readControlApiBinaryFrame(
  fetchImpl: typeof fetch,
  path: string,
  config: ControlApiConfig,
  signal: AbortSignal
): Promise<ControlApiResult<ControlApiBinaryData>> {
  const response = await fetchImpl(`${config.baseUrl}${path}`, {
    method: "GET",
    redirect: "error",
    headers: {
      Authorization: `Bearer ${config.serviceToken}`,
      "X-AutoDev-Actor": LOCAL_CONTROL_API_ACTOR,
      Accept: DISPLAYABLE_FRAME_TYPES.join(", ")
    },
    signal
  });
  if (!response.ok) return readControlApiFailure(response);

  const mediaType = displayableFrameMediaType(
    response.headers.get("content-type") ?? ""
  );
  if (mediaType === null) {
    return {
      kind: INVALID_RESPONSE_KIND,
      code: "autodev_control_api_invalid_playtesting_frame_type",
      message:
        "The Control API returned a non-displayable Playtesting frame type."
    };
  }
  if (exceedsBinaryResponseLimit(response.headers.get("content-length"))) {
    return {
      kind: "http-error",
      status: 413,
      code: "autodev_control_api_playtesting_frame_too_large",
      message: "The selected frame exceeds the Console display bound."
    };
  }
  try {
    const bytes = await readBoundedBinary(response, BINARY_RESPONSE_MAX_BYTES);
    return {
      kind: "ok",
      data: {
        bytes,
        mediaType: mediaType as ControlApiBinaryData["mediaType"]
      }
    };
  } catch (error) {
    return binaryReadFailure(error);
  }
}

async function readControlApiFailure<T>(
  response: Response
): Promise<ControlApiResult<T>> {
  let body: Partial<ControlApiError> = {};
  try {
    const raw = (await response.json()) as
      Partial<ControlApiError> | { readonly error?: Partial<ControlApiError> };
    if (raw && typeof raw === "object") {
      body =
        "error" in raw && raw.error && typeof raw.error === "object"
          ? raw.error
          : (raw as Partial<ControlApiError>);
    }
  } catch {
    // HTTP status is authoritative even when the error body is unreadable.
  }
  return {
    kind:
      response.status === 401 || response.status === 403
        ? "unauthorized"
        : "http-error",
    status: response.status,
    code: body.code ?? `autodev_control_api_${response.status}`,
    message:
      body.message ??
      `AutoDev Control API rejected the request with status ${response.status}.`
  };
}

/**
 * Sends a typed server-side Control API mutation using the shared credential,
 * actor, timeout, and error-envelope handling.
 */
async function mutateControlApi<T>(
  method: "POST" | "PATCH",
  path: string,
  payload: unknown,
  config: ControlApiConfig,
  options: FetchControlApiOptions = {}
): Promise<ControlApiResult<T>> {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const controller = new AbortController();
  const timeoutMs = options.timeoutMs ?? CONTROL_API_TIMEOUT_MS;
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const signal = deadlineSignal(controller, options.signal);

  let response: Response;
  try {
    response = await fetchImpl(config.baseUrl + path, {
      method,
      headers: {
        Authorization: "Bearer " + config.serviceToken,
        "X-AutoDev-Actor": LOCAL_CONTROL_API_ACTOR,
        Accept: "application/json",
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload),
      signal
    });
  } catch (error) {
    // The same classifier as the read, because this used to answer differently:
    // it forwarded `error.message`, so a write abandoned at the deadline reported
    // "This operation was aborted" where a read reported a timeout. Two answers to
    // one question, decided by which verb the request used.
    return transportFailure(error, controller.signal.aborted, timeoutMs);
  } finally {
    clearTimeout(timer);
  }

  if (response.ok) {
    try {
      const data = (await response.json()) as T;
      return { kind: "ok", data };
    } catch {
      return {
        kind: "unreachable",
        message: "AutoDev Control API returned a non-JSON body."
      };
    }
  }

  return readControlApiFailure(response);
}

/**
 * Issues an authenticated POST against the AutoDev Control API.
 */
export function postControlApi<T>(
  path: string,
  payload: unknown,
  config: ControlApiConfig,
  options: FetchControlApiOptions = {}
): Promise<ControlApiResult<T>> {
  return mutateControlApi("POST", path, payload, config, options);
}

export const CONTROL_API_PATHS = {
  agents: "/control/agents",
  providers: "/control/providers",
  providerModels: "/control/provider-models",
  models: "/control/models",
  mcps: "/control/mcps",
  mcpRuntime: "/control/mcp-runtime",
  mcpApplied: "/control/mcp-applied",
  tools: "/control/tools",
  skills: "/control/skills",
  hooks: "/control/hooks",
  hooksApplied: "/control/hooks-applied",
  permissions: "/control/permissions",
  prompts: "/control/prompts",
  workspaces: "/control/workspaces",
  routing: "/control/routing",
  runtime: "/control/runtime",
  concurrency: "/control/runtime/concurrency",
  evaluations: "/control/evaluations",
  github: "/control/github",
  playtesting: "/control/playtesting",
  playtestingReadiness: "/control/playtesting/readiness",
  playtestingInitialization: "/control/playtesting/initialize",
  memoryRecords: "/control/memory/records",
  memoryExperiences: "/control/memory/experiences",
  memoryCohorts: "/control/memory/cohorts",
  memorySessionCohorts: "/control/memory/session-cohorts",
  memoryUseCohorts: "/control/memory/use-cohorts",
  memoryStatus: "/control/memory/status",
  memoryPromoteSkill: "/control/memory/promote-skill"
} as const;

export function controlApiFailureCode(
  result: Exclude<ControlApiResult<unknown>, { readonly kind: "ok" }>
): string {
  if (result.kind !== "unreachable") return result.code;
  // A read abandoned at the Console's own deadline is not the service being
  // unreachable -- the service is holding the connection open and not
  // answering. Reporting it under `autodev_unreachable` tells an operator their
  // Control API is down when it is merely slow, and every dashboard that reads
  // this code would file the two together.
  return result.timedOut === true
    ? "autodev_control_api_timeout"
    : "autodev_unreachable";
}

export async function fetchAgents(
  config: ControlApiConfig,
  options: FetchControlApiOptions = {}
): Promise<ControlApiResult<ControlApiAgentsResponse>> {
  const result = await fetchControlApi<unknown>(
    CONTROL_API_PATHS.agents,
    config,
    options
  );
  if (result.kind !== "ok") return result;
  // An unreadable agents payload would render an empty Configure surface, which
  // reads as "no agents are configured" rather than "we could not read the list".
  if (isControlApiAgentsResponse(result.data)) {
    return { kind: "ok", data: result.data };
  }
  return {
    kind: INVALID_RESPONSE_KIND,
    code: "autodev_control_api_invalid_agents_response",
    message:
      "AutoDev Control API returned an incompatible Agents response; the Console requires the v2 agents contract."
  };
}

export async function fetchAgentDetail(
  role: string,
  config: ControlApiConfig,
  options: FetchControlApiOptions = {}
): Promise<ControlApiResult<ControlApiAgentDetailResponse>> {
  const path = `${CONTROL_API_PATHS.agents}/${encodeURIComponent(role)}`;
  const result = await fetchControlApi<unknown>(path, config, options);
  if (result.kind !== "ok") return result;
  if (isControlApiAgentDetailResponse(result.data)) {
    return { kind: "ok", data: result.data };
  }
  return {
    kind: INVALID_RESPONSE_KIND,
    code: "autodev_control_api_invalid_agent_detail_response",
    message:
      "AutoDev Control API returned an incompatible Agent detail response; the Console requires the v3 agent detail contract."
  };
}

/**
 * Narrows one agent record. Agents drive the whole Configure surface, and an
 * unreadable record used to reach the table as `undefined` fields rather than
 * as an explicit failure, so the guard checks the fields the views actually
 * read rather than only the identifier.
 *
 * `status` is accepted as a string rather than as one of the states the
 * contract names, while `convergence` is narrowed to the four the Runtime
 * computes. The difference is deliberate. A convergence is a verdict the Runtime
 * reaches, and the Console must not guess at one it does not recognise, so an
 * unrecognised convergence fails the response closed. A status is a state the
 * service reports, and a service that has grown a state is still evidence of
 * that state: the Console carries it and names it, because the alternative -- a
 * badge with no word, or a whole page refused over one field -- tells the
 * operator nothing about what the service actually said.
 */
function isAgentRecord(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.role === "string" &&
    (value.kind === "orchestrator" || value.kind === "leaf") &&
    typeof value.readOnly === "boolean" &&
    typeof value.configured === "boolean" &&
    (value.valid === null || typeof value.valid === "boolean") &&
    typeof value.status === "string" &&
    isConvergenceStatus(value.convergence) &&
    isAgentEnablementState(value.enablement) &&
    typeof value.primaryModel === "string" &&
    isStringList(value.allowedProviders) &&
    isStringList(value.mcps) &&
    isStringList(value.skills)
  );
}

function isAgentEnablementState(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (value.kind === "observed") {
    return (
      typeof value.enabled === "boolean" &&
      value.mutable === true &&
      typeof value.revision === "string" &&
      CONTROL_API_REVISION_PATTERN.test(value.revision)
    );
  }
  return (
    value.kind === "unavailable" &&
    value.enabled === null &&
    value.mutable === false &&
    typeof value.reason === "string" &&
    value.reason.trim().length > 0
  );
}

/** Narrows the agents collection, including every record it carries. */
function isControlApiAgentsResponse(
  value: unknown
): value is ControlApiAgentsResponse {
  return (
    isRecord(value) &&
    value.schema === "autodev-control-agents-v2" &&
    typeof value.source === "string" &&
    value.readOnly === false &&
    // The catalogue is the execution contract's roles. A payload that does not
    // say whether the contract was read cannot support a count over it: the
    // accessor that reads the contract falls back to an empty contract when
    // the read fails, so the roles alone cannot tell an empty contract from a
    // contract nobody read.
    typeof value.executionContractObserved === "boolean" &&
    isNullableNumber(value.totalAgents) &&
    Array.isArray(value.agents) &&
    value.agents.every(
      (agent) => isAgentRecord(agent) && typeof agent.hasPrompt === "boolean"
    )
  );
}

/**
 * Narrows one agent detail record. The detail view composes configuration,
 * actual runtime state, and reconciliation onto one page, so all three have to
 * be present and well-formed before any of them is rendered.
 */
function isControlApiAgentDetailResponse(
  value: unknown
): value is ControlApiAgentDetailResponse {
  return (
    isRecord(value) &&
    value.schema === "autodev-control-agent-detail-v3" &&
    isAgentRecord(value) &&
    (value.promptPath === null || typeof value.promptPath === "string") &&
    (value.systemPrompt === null || typeof value.systemPrompt === "string") &&
    isReconciliationBundle(value.reconciliation)
  );
}

function isControlApiAgentEnablementPatchResponse(
  value: unknown,
  role: string
): value is ControlApiAgentEnablementPatchResponse {
  return (
    isRecord(value) &&
    value.schema === "autodev-control-agent-enablement-v1" &&
    value.role === role &&
    typeof value.enabled === "boolean" &&
    typeof value.previous === "boolean" &&
    typeof value.revision === "string" &&
    CONTROL_API_REVISION_PATTERN.test(value.revision) &&
    typeof value.actor === "string" &&
    value.actor.length > 0 &&
    isReconciliationBundle(value.reconciliation)
  );
}

/** Server-only typed mutation for Runtime-owned Agent role enablement. */
export async function patchAgentEnablement(
  role: string,
  request: ControlApiAgentEnablementPatchRequest,
  config: ControlApiConfig,
  options: FetchControlApiOptions = {}
): Promise<ControlApiResult<ControlApiAgentEnablementPatchResponse>> {
  const canonicalRole = role.trim().toLowerCase();
  const result = await mutateControlApi<unknown>(
    "PATCH",
    `${CONTROL_API_PATHS.agents}/${encodeURIComponent(canonicalRole)}`,
    { enabled: request.enabled, expectedRevision: request.expectedRevision },
    config,
    options
  );
  if (result.kind !== "ok") return result;
  if (isControlApiAgentEnablementPatchResponse(result.data, canonicalRole)) {
    return { kind: "ok", data: result.data };
  }
  return {
    kind: INVALID_RESPONSE_KIND,
    code: "autodev_control_api_invalid_agent_enablement_response",
    message:
      "AutoDev Control API returned an incompatible Agent enablement response; the Console requires the v1 Agent enablement contract."
  };
}

function isEnablement(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.enabled === "boolean" &&
    typeof value.mutable === "boolean"
  );
}

/**
 * Narrows one canonical reconciliation status: the verdict plus the generations,
 * timestamps, last error, and operator-facing explanation. Every surface that
 * claims convergence validates through this one check so the wording and the
 * "never synthesize a verdict" rule stay identical across resources.
 */
function isReconciliationStatus(value: unknown): value is ReconciliationStatus {
  return (
    isRecord(value) &&
    isConvergenceStatus(value.convergence) &&
    isNullableString(value.desiredGeneration) &&
    isNullableString(value.observedGeneration) &&
    isNullableString(value.lastApplyAt) &&
    isNullableString(value.lastObservationAt) &&
    isNullableString(value.lastError) &&
    typeof value.explanation === "string"
  );
}

/** Narrows the `{ status, history }` bundle the mutation and detail routes carry. */
function isReconciliationBundle(value: unknown): boolean {
  return (
    isRecord(value) &&
    isReconciliationStatus(value.status) &&
    Array.isArray(value.history)
  );
}

/**
 * Narrows one enablement entry to the canonical
 * `ControlApiEnablement & { convergence: ReconciliationStatus }` shape.
 *
 * `convergence` is the nested reconciliation status the Control API derives
 * from desired/observed evidence, not a bare string: it carries the convergence
 * verdict plus the generations, timestamps, last error, and operator-facing
 * explanation that Console renders next to the toggle. Every mutable routing
 * toggle — provider role and model alike — carries it, so the check is named
 * for the contract rather than for one resource that happens to use it.
 */
/**
 * Narrows one provider role assignment. `disabled` is a member of the priority
 * enum rather than a separate flag, so an assignment cannot claim both a
 * priority and an enabled state, and `model` may only be null or a string.
 */
function isProviderRoleAssignment(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const effortOk =
    value.reasoningEffort === undefined ||
    value.reasoningEffort === null ||
    typeof value.reasoningEffort === "string";
  const effectiveEffortOk =
    value.effectiveReasoningEffort === undefined ||
    value.effectiveReasoningEffort === null ||
    typeof value.effectiveReasoningEffort === "string";
  const inForceOk =
    value.reasoningEffortInForce === undefined ||
    typeof value.reasoningEffortInForce === "boolean";
  const supportedOk =
    value.supportedReasoningLevels === undefined ||
    (Array.isArray(value.supportedReasoningLevels) &&
      value.supportedReasoningLevels.every((lvl) => typeof lvl === "string"));

  return (
    (value.priority === 1 ||
      value.priority === 2 ||
      value.priority === 3 ||
      value.priority === "disabled") &&
    (value.model === null || typeof value.model === "string") &&
    typeof value.mutable === "boolean" &&
    isReconciliationStatus(value.convergence) &&
    effortOk &&
    effectiveEffortOk &&
    inForceOk &&
    supportedOk
  );
}

/**
 * Narrows the role map of one provider. Every role Core declares must be
 * present: a role missing from the response is unobserved, and rendering the
 * control for it would let an operator pick a priority for a role the Runtime
 * never reported.
 */
function isProviderRoles(value: unknown): boolean {
  return (
    isRecord(value) &&
    PROVIDER_ROLES.every((role) => isProviderRoleAssignment(value[role]))
  );
}

/**
 * Narrows a provider's agent limits. `null` means Unlimited and is a decision
 * the operator made, so it is distinguished from an absent key: a payload that
 * omits `agentLimits` must not validate as "unlimited".
 */
function isProviderAgentLimits(value: unknown): boolean {
  if (value === null) return true;
  return (
    isRecord(value) &&
    (value.perSession === null || typeof value.perSession === "number") &&
    (value.acrossSessions === null || typeof value.acrossSessions === "number")
  );
}

function isEnablementWithConvergence(value: unknown): boolean {
  return (
    isRecord(value) &&
    isReconciliationStatus(value.convergence) &&
    typeof value.enabled === "boolean" &&
    typeof value.mutable === "boolean"
  );
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/** Health is a complete Runtime observation, not a partially present record. */
function isProviderHealth(value: unknown): boolean {
  return (
    isRecord(value) &&
    (value.cooldown === null ||
      (isRecord(value.cooldown) &&
        typeof value.cooldown.kind === "string" &&
        value.cooldown.kind.length > 0 &&
        (value.cooldown.failureClass === null ||
          (typeof value.cooldown.failureClass === "string" &&
            value.cooldown.failureClass.length <= 128)) &&
        isCanonicalTimestamp(value.cooldown.until) &&
        (value.cooldown.resetsAt === null ||
          isCanonicalTimestamp(value.cooldown.resetsAt)) &&
        typeof value.cooldown.lastResortEligible === "boolean")) &&
    isNonNegativeInteger(value.failureStreak) &&
    isNonNegativeInteger(value.probeFailureStreak) &&
    isNonNegativeInteger(value.inFlightRequests) &&
    isNonNegativeInteger(value.activeAgents) &&
    isNonNegativeInteger(value.attempts) &&
    isNonNegativeInteger(value.successes) &&
    isNonNegativeInteger(value.failures) &&
    (value.lastSuccessAt === null ||
      isCanonicalTimestamp(value.lastSuccessAt)) &&
    (value.lastFailure === null ||
      (isRecord(value.lastFailure) &&
        isCanonicalTimestamp(value.lastFailure.at) &&
        (value.lastFailure.failureClass === null ||
          (typeof value.lastFailure.failureClass === "string" &&
            value.lastFailure.failureClass.length <= 128)) &&
        (value.lastFailure.status === null ||
          (isNonNegativeInteger(value.lastFailure.status) &&
            value.lastFailure.status <= 999))))
  );
}

function isProviderLinks(value: unknown): boolean {
  return (
    isRecord(value) &&
    (value.usage === null || typeof value.usage === "string") &&
    (value.documentation === null || typeof value.documentation === "string")
  );
}

function isControlApiProvidersResponse(
  value: unknown
): value is ControlApiProvidersResponse {
  return (
    isRecord(value) &&
    value.schema === "autodev-control-providers-v3" &&
    typeof value.orchestratorTier === "string" &&
    Array.isArray(value.tiers) &&
    value.tiers.every(
      (tier) =>
        isRecord(tier) &&
        typeof tier.tier === "string" &&
        Array.isArray(tier.groups) &&
        tier.groups.every(isStringList)
    ) &&
    Array.isArray(value.providers) &&
    value.providers.every(
      (provider) =>
        isRecord(provider) &&
        typeof provider.id === "string" &&
        isProviderLinks(provider.links) &&
        isRecord(provider.roles) &&
        isProviderRoles(provider.roles) &&
        typeof provider.disabled === "boolean" &&
        isProviderAgentLimits(provider.agentLimits) &&
        isRecord(provider.credential) &&
        typeof provider.credential.configured === "boolean" &&
        Array.isArray(provider.models) &&
        Array.isArray(provider.priorities) &&
        // The provider's own reconciliation view is required, not optional: a
        // provider row that arrives without it cannot say whether its routing
        // configuration has been observed, and the page would have to invent
        // that answer.
        isReconciliationBundle(provider.reconciliation) &&
        // Health drives the readiness badge, which reads `cooldown.failureClass`
        // and `lastFailure.failureClass`.
        (provider.health === null || isProviderHealth(provider.health))
    )
  );
}

export async function fetchProviders(
  config: ControlApiConfig,
  options: FetchControlApiOptions = {}
): Promise<ControlApiResult<ControlApiProvidersResponse>> {
  const result = await fetchControlApi<unknown>(
    CONTROL_API_PATHS.providers,
    config,
    options
  );
  if (result.kind !== "ok") return result;
  if (isControlApiProvidersResponse(result.data)) {
    return { kind: "ok", data: result.data };
  }
  return {
    kind: INVALID_RESPONSE_KIND,
    code: "autodev_control_api_invalid_providers_response",
    message:
      "AutoDev Control API returned an incompatible Providers response; the Console requires the v3 provider contract."
  };
}

/**
 * Builds the canonical provider-role PATCH path with an encoded provider
 * segment. This remains private to the typed server mutation below.
 */
function providerRoleControlPath(provider: string, role: ProviderRole): string {
  return `${CONTROL_API_PATHS.providers}/${encodeURIComponent(
    provider
  )}/roles/${encodeURIComponent(role)}`;
}

/**
 * Server-only typed PATCH against the canonical provider-role route. The
 * Console never sends provider-role mutations directly from the browser; the
 * provider-role route handler invokes this helper with the server-side
 * Control API credential and the canonical local actor header.
 */
export function patchProviderRole(
  provider: string,
  role: ProviderRole,
  assignment: {
    priority: ProviderRolePriority;
    model: string | null;
    reasoningEffort?: string | null;
  },
  config: ControlApiConfig,
  options: FetchControlApiOptions = {}
): Promise<ControlApiResult<ControlApiProviderRolePatchResponse>> {
  return mutateControlApi<ControlApiProviderRolePatchResponse>(
    "PATCH",
    providerRoleControlPath(provider, role),
    {
      priority: assignment.priority,
      model: assignment.model,
      ...(assignment.reasoningEffort === undefined
        ? {}
        : { reasoningEffort: assignment.reasoningEffort })
    },
    config,
    options
  );
}

/**
 * Server-only typed reset of Runtime-owned provider overrides. The Console
 * sends no routing configuration or credential data; Runtime clears only its
 * operator overlay and reads the static routing source as the default.
 */
export function resetProviderSettings(
  config: ControlApiConfig,
  options: FetchControlApiOptions = {}
): Promise<ControlApiResult<ControlApiProvidersResetResponse>> {
  const body: ControlApiProvidersResetRequest = { confirm: true };
  return mutateControlApi<ControlApiProvidersResetResponse>(
    "POST",
    `${CONTROL_API_PATHS.providers}/reset`,
    body,
    config,
    options
  );
}

/**
 * Server-only typed PATCH for a provider's agent limits. `null` on either axis
 * means Unlimited, which is a decision the operator made, so the Console sends
 * both keys on every change rather than omitting an axis it is not touching.
 */
export function patchProviderLimits(
  provider: string,
  agentLimits: ControlApiProviderAgentLimits,
  config: ControlApiConfig,
  options: FetchControlApiOptions = {}
): Promise<ControlApiResult<ControlApiProviderLimitsPatchResponse>> {
  return mutateControlApi<ControlApiProviderLimitsPatchResponse>(
    "PATCH",
    providerControlPath(provider, "limits"),
    {
      perSession: agentLimits.perSession,
      acrossSessions: agentLimits.acrossSessions
    },
    config,
    options
  );
}

/**
 * Server-only typed PATCH enabling or disabling a provider globally. Runtime
 * preserves the provider's roles and limits across the change, so the Console
 * sends only the flag.
 */
export function patchProviderEnabled(
  provider: string,
  disabled: boolean,
  config: ControlApiConfig,
  options: FetchControlApiOptions = {}
): Promise<ControlApiResult<ControlApiProviderEnabledPatchResponse>> {
  return mutateControlApi<ControlApiProviderEnabledPatchResponse>(
    "PATCH",
    providerControlPath(provider),
    { disabled },
    config,
    options
  );
}

/**
 * Builds the canonical provider-scoped PATCH path with an encoded provider
 * segment. This remains private to the typed server mutations below.
 *
 * Sub-segments are joined here rather than by the caller. Passing `"limits"`
 * produced `/control/providers/claudelimits`, which still matched the
 * single-provider route — `claudelimits` is a legal provider id — so the
 * request came back as an unknown-provider 404 instead of a routing error, and
 * every agent-limits mutation failed while the controls looked correct. The
 * separator belongs to whoever assembles the path.
 */
function providerControlPath(
  provider: string,
  ...segments: readonly string[]
): string {
  const base = `${CONTROL_API_PATHS.providers}/${encodeURIComponent(provider)}`;
  const suffixes = segments
    .filter((segment) => segment.length > 0)
    .map((segment) => encodeURIComponent(segment));
  return suffixes.length === 0 ? base : `${base}/${suffixes.join("/")}`;
}

function isControlApiModelsResponse(
  value: unknown
): value is ControlApiModelsResponse {
  return (
    isRecord(value) &&
    value.schema === "autodev-control-models-v2" &&
    typeof value.source === "string" &&
    Array.isArray(value.models) &&
    value.models.every(
      (model) =>
        isRecord(model) &&
        typeof model.id === "string" &&
        typeof model.provider === "string" &&
        isStringList(model.tiers) &&
        (model.displayName === null || typeof model.displayName === "string") &&
        isEnablement(model.enablement) &&
        isEnablementWithConvergence(model.enablement)
    )
  );
}

export async function fetchModels(
  config: ControlApiConfig,
  options: FetchControlApiOptions = {}
): Promise<ControlApiResult<ControlApiModelsResponse>> {
  const result = await fetchControlApi<unknown>(
    CONTROL_API_PATHS.models,
    config,
    options
  );
  if (result.kind !== "ok") return result;
  if (isControlApiModelsResponse(result.data)) {
    return { kind: "ok", data: result.data };
  }
  return {
    kind: INVALID_RESPONSE_KIND,
    code: "autodev_control_api_invalid_models_response",
    message:
      "AutoDev Control API returned an incompatible Models response; the Console requires the v2 model contract."
  };
}

const PROVIDER_MODEL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/u;

function isCanonicalTimestamp(value: unknown): value is string {
  return (
    typeof value === "string" &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString() === value
  );
}

function isDiscoveredProviderModel(value: unknown): boolean {
  if (
    !isRecord(value) ||
    typeof value.id !== "string" ||
    !PROVIDER_MODEL_ID_PATTERN.test(value.id) ||
    value.id.trim() !== value.id ||
    (value.displayName !== null && typeof value.displayName !== "string") ||
    !isRecord(value.routeability)
  ) {
    return false;
  }
  return (
    value.routeability.status === "supported" ||
    (value.routeability.status === "unsupported" &&
      typeof value.routeability.reason === "string" &&
      value.routeability.reason.trim().length > 0)
  );
}

function isProviderModelDiscovery(
  value: unknown
): value is ControlApiProviderModelDiscovery {
  if (!isRecord(value)) return false;
  if (value.status === "unavailable") {
    return (
      (value.source === null ||
        (typeof value.source === "string" && value.source.trim().length > 0)) &&
      (value.lastAttemptAt === null ||
        isCanonicalTimestamp(value.lastAttemptAt)) &&
      typeof value.reason === "string" &&
      value.reason.trim().length > 0
    );
  }
  if (
    (value.status !== "observed" && value.status !== "stale") ||
    typeof value.source !== "string" ||
    value.source.trim().length === 0 ||
    !isCanonicalTimestamp(value.observedAt) ||
    !isCanonicalTimestamp(value.lastAttemptAt) ||
    !Array.isArray(value.models)
  ) {
    return false;
  }
  if (
    value.status === "stale" &&
    (typeof value.reason !== "string" || value.reason.trim().length === 0)
  ) {
    return false;
  }
  const ids = new Set<string>();
  for (const model of value.models) {
    if (!isDiscoveredProviderModel(model) || ids.has(model.id)) return false;
    ids.add(model.id);
  }
  return true;
}

function isControlApiProviderModelsResponse(
  value: unknown
): value is ControlApiProviderModelsResponse {
  if (
    !isRecord(value) ||
    value.schema !== "autodev-control-provider-model-discovery-v1" ||
    value.source !== "runtime-provider-discovery" ||
    !Array.isArray(value.providers)
  ) {
    return false;
  }
  const providerIds = new Set<string>();
  for (const entry of value.providers) {
    if (
      !isRecord(entry) ||
      typeof entry.provider !== "string" ||
      entry.provider.trim() !== entry.provider ||
      entry.provider.length === 0 ||
      entry.provider.length > 128 ||
      providerIds.has(entry.provider) ||
      !isProviderModelDiscovery(entry.discovery)
    ) {
      return false;
    }
    providerIds.add(entry.provider);
  }
  return true;
}

/** Reads Runtime-owned provider availability without inventing a catalog. */
export async function fetchProviderModelDiscovery(
  config: ControlApiConfig,
  options: FetchControlApiOptions = {}
): Promise<ControlApiResult<ControlApiProviderModelsResponse>> {
  const result = await fetchControlApi<unknown>(
    CONTROL_API_PATHS.providerModels,
    config,
    options
  );
  if (result.kind !== "ok") return result;
  if (isControlApiProviderModelsResponse(result.data)) {
    return { kind: "ok", data: result.data };
  }
  return {
    kind: INVALID_RESPONSE_KIND,
    code: "autodev_control_api_invalid_provider_model_discovery_response",
    message:
      "AutoDev Control API returned an incompatible provider-model discovery response; the Console requires the v1 observed/stale/unavailable contract."
  };
}

/**
 * Server-only typed PATCH against the canonical model enablement route,
 * invoked by the Console model route handler with the server credential.
 */
export function patchModel(
  model: string,
  enabled: boolean,
  config: ControlApiConfig,
  options: FetchControlApiOptions = {}
): Promise<ControlApiResult<ControlApiModelPatchResponse>> {
  return mutateControlApi<ControlApiModelPatchResponse>(
    "PATCH",
    `${CONTROL_API_PATHS.models}/${encodeURIComponent(model)}`,
    { enabled },
    config,
    options
  );
}

/**
 * Narrows the paged Memory envelope every collection tab reads.
 *
 * These responses were returned unvalidated, so a Runtime whose page shape
 * drifted produced `items: undefined`, and the tab rendered an empty list.
 * An empty list is a claim — "there is no memory" — so a response the Console
 * cannot read has to fail closed into an explicit unavailable state instead.
 */
/**
 * Narrows one memory scope.
 *
 * `MemoryScope` is a union discriminated on `kind`, and `formatScopeString`
 * switches on it and then reads that variant's own field -- so checking only
 * that `kind` is a string would let `kind: "workspace"` with no `workspaceId`
 * reach the switch and render `undefined` as a scope. Each arm is checked
 * against the members its own arm declares, and an unknown `kind` fails rather
 * than falling through to the view's `default`.
 */
function isMemoryScope(value: unknown): boolean {
  if (!isRecord(value)) return false;
  switch (value.kind) {
    case "global": {
      return true;
    }
    case "workspace": {
      return typeof value.workspaceId === "string";
    }
    case "repository": {
      return (
        typeof value.workspaceId === "string" &&
        typeof value.repositoryId === "string"
      );
    }
    case "role": {
      return (
        typeof value.workspaceId === "string" && typeof value.role === "string"
      );
    }
    case "task": {
      return (
        typeof value.workspaceId === "string" &&
        typeof value.taskId === "string" &&
        typeof value.runId === "string"
      );
    }
    case "agent": {
      return (
        typeof value.workspaceId === "string" &&
        typeof value.taskId === "string" &&
        typeof value.runId === "string" &&
        typeof value.agentId === "string"
      );
    }
    default: {
      return false;
    }
  }
}

/**
 * Narrows one durable record's provenance block.
 *
 * `isMemoryRecordRow` checked `isRecord(value.provenance)` and nothing else,
 * which is the same mistake as checking only a row's identifier: the view reads
 * `provenance.experienceIds.length` and calls `.map` over `provenance.evidence`,
 * so a record carrying `provenance: {}` passed the guard and threw during
 * render -- an HTTP 500 with no `<h1>` at all, which is strictly worse than the
 * visible failure shell the guards exist to produce. Core declares
 * `experienceIds` and `evidence` required and `lastVerifiedAt` optional, which
 * is exactly the boundary this draws.
 */
function isMemoryProvenance(value: unknown): boolean {
  return (
    isRecord(value) &&
    Array.isArray(value.experienceIds) &&
    value.experienceIds.every((id) => typeof id === "string") &&
    Array.isArray(value.evidence)
  );
}

/**
 * Narrows one durable record's validity block.
 *
 * Same reasoning as the provenance block: `isRecord(value.validity)` let a
 * record through whose `validity` had no `state`, and the record detail renders
 * `validity.state` three times -- including a three-way colour choice between
 * "verified", "contradicted" and everything else. An absent state compares as
 * none of them, so it would also have been coloured as a warning about a claim
 * whose validity was never checked.
 */
function isMemoryValidity(value: unknown): boolean {
  return isRecord(value) && typeof value.state === "string";
}

/**
 * Narrows one raw experience envelope's trajectory block.
 *
 * This one was live, not theoretical: `MemoryExperiencesView` reads
 * `experience.trajectory.format` unguarded, Core declares `trajectory` required
 * and the guard never mentioned it, so an envelope without one arrived as `ok`
 * and threw `Cannot read properties of undefined (reading 'format')` -- a 500
 * with no `<h1>`, on the experience detail route. Every other member the view
 * reads is optional in Core and already read with `?.`: `validation?.state`,
 * `agentRole ?? "unknown"`, `trajectory.digest?.`, `diagnosticCodes?.`. Only
 * `format` and `uri` are read as though present, so only they are required here.
 */
function isMemoryTrajectory(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.format === "string" &&
    typeof value.uri === "string"
  );
}

/**
 * Narrows one durable record.
 *
 * The paged guard checked the envelope and never the items, so a record missing
 * `scope` arrived as `ok` and `formatScopeString` threw on `scope.kind` --
 * a 500 with no `<h1>`. `claim` and `validity.state` are checked for the same
 * reason: both are rendered, and a missing `claim` would render as an empty
 * durable claim, which is the synthesis the target state forbids.
 */
function isMemoryRecordRow(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.kind === "string" &&
    isMemoryScope(value.scope) &&
    typeof value.claim === "string" &&
    typeof value.status === "string" &&
    isMemoryProvenance(value.provenance) &&
    isMemoryValidity(value.validity) &&
    typeof value.createdAt === "string" &&
    typeof value.updatedAt === "string"
  );
}

/**
 * Narrows one raw experience envelope. Same reasoning as the record: the view
 * reads `scope`, `agentRole` and the evidence lists off every row, and each is
 * an object read rather than a scalar comparison.
 */
function isMemoryExperienceRow(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.workspaceId === "string" &&
    isMemoryScope(value.scope) &&
    typeof value.taskId === "string" &&
    typeof value.runId === "string" &&
    typeof value.agentId === "string" &&
    Array.isArray(value.evidence) &&
    isMemoryTrajectory(value.trajectory)
  );
}

/**
 * Narrows one session-outcome cohort cell.
 *
 * `isSessionOutcomeCohortPage` checked `Array.isArray(value.cells)` and never a
 * single cell, so the same hole reached the cohort table: the view calls
 * `.toLocaleString()` on `sessionCount` and `exposureCount` and reads five other
 * members off every cell, so one malformed cell turned the tab into a 500 with
 * no `<h1>`. `outcomeKind` and `useKind` are null by design -- Core says a null
 * outcomeKind means no outcome report exists for that cell, which the view
 * renders as unobserved rather than as a failure -- so they are checked as
 * "string or null" rather than required.
 */
function isSessionOutcomeCohortCell(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.memoryMode === "string" &&
    typeof value.sessionCount === "number" &&
    (value.outcomeKind === null || typeof value.outcomeKind === "string")
  );
}

/**
 * Narrows one injection-use cohort cell.
 *
 * A different cell shape from the session cohort's: it is keyed on how many
 * injections the session captured and what the curator concluded about them,
 * and Core says an absent `useKind` means "eligible but unassessed" rather than
 * "not used" -- so it is checked as "string or null" for the same reason the
 * session cell's `outcomeKind` is.
 */
function isInjectionUseCohortCell(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.memoryMode === "string" &&
    typeof value.sessionCardinality === "string" &&
    typeof value.exposureCount === "number" &&
    (value.useKind === null || typeof value.useKind === "string")
  );
}

/**
 * Narrows the injection-use cohort page.
 *
 * This fetch had no response guard at all, which is how nineteen other fetches
 * were hardened earlier and this one was missed: the response went straight to
 * the view, where a malformed cell makes the view call `.toLocaleString()` on
 * `undefined`. The session cohort page beside it has had a guard since it was
 * added; this one never did.
 */
function isInjectionUseCohortPage(
  value: unknown
): value is ControlApiMemoryUseCohortsResponse {
  return (
    isRecord(value) &&
    value.schema === "autodev-memory-injection-use-cohorts-v1" &&
    Array.isArray(value.cells) &&
    value.cells.every(isInjectionUseCohortCell) &&
    typeof value.exposureCount === "number"
  );
}

/**
 * Narrows the lifecycle breakdown a records page is published with.
 *
 * Required, not optional. Every status must be present, because the Console
 * reads this to replace a count it used to take from the rows on the page — and
 * a Runtime that omitted the breakdown, or left a status out, would have the
 * Console render zeros for claims it never observed, which is the one number on
 * this page nobody can check.
 */
function isMemoryStatusCounts(value: unknown): boolean {
  return (
    isRecord(value) &&
    MEMORY_STATUSES.every(
      (status) => typeof (value as Record<string, unknown>)[status] === "number"
    )
  );
}

function isMemoryPageResponse<TResponse extends { readonly schema: string }>(
  value: unknown,
  schema: TResponse["schema"],
  isItem: (item: unknown) => boolean = () => true
): value is TResponse {
  return (
    isRecord(value) &&
    value.schema === schema &&
    Array.isArray(value.items) &&
    typeof value.total === "number" &&
    typeof value.limit === "number" &&
    typeof value.offset === "number" &&
    // Every item is checked, not just the envelope. A paged collection whose
    // rows are unreadable is not an empty collection; it is an unreadable
    // response, and rendering it as "no records in scope" would be a claim.
    value.items.every(isItem)
  );
}

/**
 * Narrows the Memory detail responses. These are single-record reads whose
 * payload *is* the page: an unreadable one has nothing to render, and letting
 * it through produced a detail page with blank fields and an empty history
 * that read as a real claim with none of either.
 */
function isMemoryRecordDetailResponse(
  value: unknown
): value is ControlApiMemoryRecordDetailResponse {
  return (
    isRecord(value) &&
    value.schema === "autodev-memory-record-v1" &&
    // The record row guard, not `isRecord`: the detail view renders the same
    // provenance and validity blocks the list view does, so a record that
    // would fail closed on the list must not pass here and 500 on the detail
    // page. Reusing the predicate is also what keeps the two from drifting.
    isMemoryRecordRow(value.memory)
  );
}

/**
 * One rendered transition row.
 *
 * The panel reads all six of these, so the guard requires all six. Checking
 * only that `transitions` is an array let a row missing `action` reach the
 * renderer and throw, turning one malformed transition into a failed page.
 *
 * Both statuses are checked against the vocabulary rather than merely for being
 * strings: the row renders its status names verbatim in the transition badge,
 * so a status the Runtime never defined would be shown as though it were one.
 */
function isMemoryTransitionRow(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const { fromStatus, toStatus } = value;
  return (
    MEMORY_STATUSES.includes(toStatus as MemoryStatus) &&
    (fromStatus === undefined ||
      MEMORY_STATUSES.includes(fromStatus as MemoryStatus)) &&
    typeof value.action === "string" &&
    typeof value.actorId === "string" &&
    typeof value.reasonCode === "string" &&
    typeof value.occurredAt === "string"
  );
}

function isMemoryHistoryResponse(
  value: unknown
): value is ControlApiMemoryHistoryResponse {
  return (
    isRecord(value) &&
    value.schema === "autodev-memory-history-v1" &&
    // `transitions` is the evidence the history panel is entirely made of; a
    // missing list is not an empty history, and a list the panel cannot render
    // is not a history at all.
    Array.isArray(value.transitions) &&
    value.transitions.every(isMemoryTransitionRow) &&
    isMemoryRecordRow(value.memory)
  );
}

/**
 * The eligibility-bounded explanation of one record.
 *
 * Both lists are required to be arrays rather than merely tolerated: this
 * panel exists to answer "why does this record exist, and what can I still see
 * of it", and a response missing `sourceExperiences` would render as a record
 * with no sources — the same false absence an unreadable catalog produces.
 */
function isMemoryWhyResponse(
  value: unknown
): value is ControlApiMemoryWhyResponse {
  return (
    isRecord(value) &&
    value.schema === "autodev-memory-why-v1" &&
    isMemoryRecordRow(value.memory) &&
    Array.isArray(value.relatedMemories) &&
    value.relatedMemories.every(isMemoryRecordRow) &&
    Array.isArray(value.sourceExperiences) &&
    value.sourceExperiences.every(isMemoryExperienceRow)
  );
}

function isMemoryExperienceDetailResponse(
  value: unknown
): value is ControlApiMemoryExperienceDetailResponse {
  return (
    isRecord(value) &&
    value.schema === "autodev-memory-experience-v1" &&
    // This is the guard whose absence produced a live 500: the detail view
    // renders `experience.trajectory.format`, and `isRecord(value.experience)`
    // let an envelope without one through. The row guard requires it.
    isMemoryExperienceRow(value.experience)
  );
}

/**
 * Narrows the session outcome cohort page. It is not a paged envelope: it
 * reports cells plus explicit reported/unreported counts, and an unreadable
 * response must not collapse into an empty cohort table that reads as
 * "no outcomes observed".
 */
function isSessionOutcomeCohortPage(
  value: unknown
): value is ControlApiMemoryCohortsResponse {
  return (
    isRecord(value) &&
    value.schema === "autodev-memory-session-outcome-cohorts-v1" &&
    Array.isArray(value.cells) &&
    value.cells.every(isSessionOutcomeCohortCell) &&
    typeof value.sessionCount === "number" &&
    typeof value.reportedSessionCount === "number" &&
    typeof value.unreportedSessionCount === "number" &&
    // The two diagnostic counts are part of the contract the page reads, so
    // they are required here too. The guard used to check three of the five
    // counts the contract declares, so a response missing the other two passed
    // validation and then reached the view as `undefined` -- and the view's
    // stat card read it as a number, which is not a number at all. The page
    // did not say the count was unavailable; it failed to render.
    //
    // A guard that narrows to a type it has not checked is a guard that lets
    // the wire lie. This one checks every count the type declares.
    typeof value.mixedModeSessionCount === "number" &&
    typeof value.conflictingOutcomeSessionCount === "number"
  );
}

/**
 * Narrows one observed-injection summary.
 *
 * `outcome`/`use` are the nullable half of the join, so their absence is a
 * legitimate state with a distinct meaning: not reported. The guard therefore
 * requires the key to be *either* null or a well-formed report, and refuses a
 * response that is missing it entirely -- because a dropped field would render
 * as "unreported", turning an unreadable response into a claim that nobody
 * reported anything.
 */
/**
 * An injection as the *outcome join* reports it.
 *
 * `correlationToken` is required here, though the evidence panel does not render
 * it: an outcome report for this injection carries it, so a projection without
 * it cannot be reported against and must not be mistaken for one that can.
 *
 * Deliberately not shared with the use-assessment projection below. That route
 * withholds the token on purpose, and when both rows were checked by this one
 * guard every real use-assessment response was refused as unreadable.
 */
function isObservedInjection(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    isMemoryExecutionMode(value.memoryMode) &&
    isMemoryInjectionResult(value.injectionResult) &&
    typeof value.packetCharacterCount === "number" &&
    Array.isArray(value.memoryIds) &&
    value.memoryIds.every((id) => typeof id === "string") &&
    typeof value.occurredAt === "string" &&
    typeof value.correlationToken === "string" &&
    value.correlationToken !== ""
  );
}

/**
 * An injection as the *use-assessment* projection reports it: the same observed
 * injection without the correlation token.
 *
 * There is no caller that needs to bind a new report to an injection from this
 * read — it answers "was this packet used?" — and withholding the token keeps it
 * from doubling as a way to address any injection in the workspace. Its absence
 * is the design, so this guard must not require it.
 */
function isAssessedInjection(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    isMemoryExecutionMode(value.memoryMode) &&
    isMemoryInjectionResult(value.injectionResult) &&
    typeof value.packetCharacterCount === "number" &&
    Array.isArray(value.memoryIds) &&
    value.memoryIds.every((id) => typeof id === "string") &&
    typeof value.occurredAt === "string"
  );
}

function isInjectionOutcomeJoin(
  value: unknown
): value is ControlApiMemoryInjectionOutcomeJoin {
  return (
    isRecord(value) &&
    isObservedInjection(value.injection) &&
    (value.outcome === null ||
      (isRecord(value.outcome) &&
        // Each of these is a vocabulary the Runtime validates, and each one
        // has a word the Console owns. A guard that accepted any string here
        // would let a value the Runtime cannot produce reach the view, where
        // it would be looked up in a table of words and found missing -- which
        // is a blank cell rather than an unreadable response.
        isExperienceOutcome(value.outcome.outcomeKind) &&
        isMemoryOutcomeReportKind(value.outcome.reportKind) &&
        typeof value.outcome.reportedAt === "string" &&
        typeof value.outcome.reporterId === "string" &&
        isMemoryAuthority(value.outcome.reporterAuthority) &&
        isMemoryOutcomeReportReasonCode(value.outcome.reasonCode))) &&
    typeof value.sessionInjectionCount === "number"
  );
}

function isInjectionUseAssessment(
  value: unknown
): value is ControlApiMemoryInjectionUseAssessment {
  return (
    isRecord(value) &&
    isAssessedInjection(value.injection) &&
    (value.use === null ||
      (isRecord(value.use) &&
        isMemoryUseKind(value.use.useKind) &&
        Array.isArray(value.use.usedMemoryIds) &&
        value.use.usedMemoryIds.every((id) => typeof id === "string") &&
        typeof value.use.reportedAt === "string" &&
        // The Runtime sends it, so the type predicate is only telling the truth
        // if it is checked. A curator's assessment is a claim about what was
        // observed, and the evidence is the observation.
        Array.isArray(value.use.evidence))) &&
    typeof value.sessionInjectionCount === "number"
  );
}

/**
 * The shared shape of both evidence pages.
 *
 * `experienceId` is compared, not merely type-checked: the Console renders
 * these under a selected experience, so a response naming a *different*
 * experience is not an empty list for this one, it is the wrong answer -- and
 * it would otherwise be drawn as evidence for the experience the operator has
 * open.
 */
function isExperienceEvidencePage(
  value: unknown,
  schema: string,
  experienceId: string,
  row: (row: unknown) => boolean
): boolean {
  return (
    isRecord(value) &&
    value.schema === schema &&
    value.experienceId === experienceId &&
    Array.isArray(value.items) &&
    value.items.every(row) &&
    typeof value.total === "number" &&
    typeof value.limit === "number" &&
    typeof value.offset === "number"
  );
}

function isInjectionOutcomesResponse(
  value: unknown,
  experienceId: string
): value is ControlApiMemoryInjectionOutcomesResponse {
  return (
    isExperienceEvidencePage(
      value,
      "autodev-memory-injection-outcomes-v1",
      experienceId,
      isInjectionOutcomeJoin
    ) && isRecord(value)
  );
}

function isInjectionUseAssessmentsResponse(
  value: unknown,
  experienceId: string
): value is ControlApiMemoryInjectionUseAssessmentsResponse {
  return (
    isExperienceEvidencePage(
      value,
      "autodev-memory-injection-use-assessments-v1",
      experienceId,
      isInjectionUseAssessment
    ) && isRecord(value)
  );
}

/**
 * One failure shape for every unreadable catalog, so the Console reports a
 * drifted Runtime the same way whichever collection it was reading.
 */
/**
 * A read whose payload does not satisfy the Console's validator.
 *
 * The code names the resource that failed, because it is the only thing an
 * operator has to search with: `autodev_control_api_invalid_evaluations_response`
 * says which read broke, and a shared `..._catalog_response` does not -- the
 * Evaluations read was reporting a code for a resource it is not. Eight of the
 * fourteen reads already name themselves this way; Evaluations now does too.
 *
 * Five reads -- MCPs, Tools, Hooks, GitHub and Routing -- still share the older
 * code, and keep it by default rather than being re-coded from a change to this
 * resource: their failure contracts are not Evaluations' to rewrite here, and
 * changing an identifier five other pages display is a larger decision than the
 * one this file's own comment is making.
 */
function invalidResponse(
  what: string,
  schema: string,
  code = "autodev_control_api_invalid_catalog_response"
): ControlApiResult<never> {
  return {
    kind: INVALID_RESPONSE_KIND,
    code,
    message: `AutoDev Control API returned an incompatible ${what} response; the Console requires the ${schema} contract.`
  };
}

function invalidMemoryPageResponse(
  what: string,
  schema: string
): ControlApiResult<never> {
  return {
    kind: INVALID_RESPONSE_KIND,
    code: "autodev_control_api_invalid_memory_response",
    message: `AutoDev Control API returned an incompatible ${what} response; the Console requires the ${schema} contract.`
  };
}

/**
 * Narrows the remaining catalog collections.
 *
 * These all share one failure mode: an unreadable response reached the view as
 * an empty collection, and an empty collection is a claim — "no MCP servers are
 * configured", "no tools are exposed" — that a shape the Console cannot read
 * does not support. Each predicate checks the envelope the view actually
 * renders rather than restating every nested Core type.
 */
/**
 * Narrows one target override. Overrides are a list of records, not a string
 * list: each entry names a target and carries its own enablement. Checking them
 * with `isStringList` rejects every well-formed catalog, which is how this
 * route spent a while failing closed against correct data.
 */
function isMcpTargetOverride(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.target === "string" &&
    typeof value.enabled === "boolean"
  );
}

/**
 * Narrows the Runtime's health verdict for a server.
 *
 * The verdict is the Runtime's own vocabulary, and the Console publishes the
 * five words it uses. A verdict outside them is not a readiness claim, and
 * letting it through would render a status the Console cannot interpret.
 */
function isMcpHealthVerdict(value: unknown): boolean {
  return (
    value === "configured" ||
    value === "ready" ||
    value === "error" ||
    value === "observed" ||
    value === "stale"
  );
}

/**
 * Narrows one MCP server row. The catalog row is the join of the canonical
 * declaration and the generated role projection, and the view reads every
 * required member of that join: `transport.toUpperCase()` and
 * `targetOverrides.length` throw outright when absent, while a missing
 * `enabled` or `declared` compares unequal to `null`/`false` and so renders a
 * confident "Canonical" / "Configured" claim out of unreadable evidence.
 * Checking the identifier alone let an incomplete payload reach the view and
 * throw instead of failing closed.
 */
function isMcpServerRow(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.name === "string" &&
    (value.enabled === null || typeof value.enabled === "boolean") &&
    typeof value.transport === "string" &&
    Array.isArray(value.targetOverrides) &&
    value.targetOverrides.every(isMcpTargetOverride) &&
    typeof value.declared === "boolean" &&
    isStringList(value.roles)
  );
}

function isControlApiMcpsResponse(
  value: unknown
): value is ControlApiMcpsResponse {
  return (
    isRecord(value) &&
    value.schema === "autodev-control-mcps-v2" &&
    typeof value.source === "string" &&
    // The revision is the handle a write is compared against, so the Console
    // refuses a catalog it cannot name rather than sending a write that has
    // nothing to compare.
    (value.revision === null || typeof value.revision === "string") &&
    typeof value.readOnly === "boolean" &&
    (value.valid === null || typeof value.valid === "boolean") &&
    // Required, not optional. `valid: false` with no issues renders as "the
    // source is invalid" and nothing else, which is the state this field exists
    // to end: the Runtime has already located the fault and thrown the location
    // and the reason away.
    isValidationIssueList(value.issues) &&
    Array.isArray(value.servers) &&
    value.servers.every(isMcpServerRow)
  );
}

/**
 * Narrows one observed MCP server.
 *
 * The observation is what the page's Connection/Health, Tools, and Activity
 * panels render, so every field they read has to be present and typed. A
 * missing `health` or `lastSeenAt` would render a confident verdict out of
 * unreadable evidence -- the same failure the server-row guard describes.
 */
function isMcpRuntimeServer(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.name === "string" &&
    isMcpHealthVerdict(value.health) &&
    (value.lastSeenAt === null || typeof value.lastSeenAt === "string") &&
    typeof value.lastStatus === "string" &&
    isNumber(value.initAttempts) &&
    isNumber(value.toolDiscoveryAttempts) &&
    isNumber(value.failures) &&
    isNumber(value.toolCalls) &&
    isNumber(value.averageDurationMs) &&
    Array.isArray(value.roles) &&
    value.roles.every(
      (role) =>
        isRecord(role) &&
        typeof role.role === "string" &&
        isMcpHealthVerdict(role.health) &&
        (role.lastSeenAt === null || typeof role.lastSeenAt === "string") &&
        typeof role.lastStatus === "string"
    ) &&
    Array.isArray(value.tools) &&
    value.tools.every(
      (tool) =>
        isRecord(tool) &&
        typeof tool.name === "string" &&
        isNumber(tool.count) &&
        isNumber(tool.errors)
    )
  );
}

/**
 * Narrows the health counts the Runtime publishes.
 *
 * The counts are what the list page's summary reads, so they are checked
 * rather than assumed: a summary that rendered "0 ready" from a payload the
 * Console could not read would be a claim the evidence does not support.
 *
 * `null` is the Runtime's own word for "the division is unknown" -- a Control
 * API with no router attached has not been asked -- and it is kept apart from
 * a set of zero counts, which says the Runtime looked and saw nothing ready.
 */
function isMcpRuntimeHealthCounts(value: unknown): boolean {
  return (
    value === null ||
    (isRecord(value) &&
      isNumber(value.ready) &&
      isNumber(value.error) &&
      isNumber(value.stale) &&
      isNumber(value.configured) &&
      isNumber(value.observed))
  );
}

function isControlApiMcpRuntimeResponse(
  value: unknown
): value is ControlApiMcpRuntimeResponse {
  return (
    isRecord(value) &&
    value.schema === "autodev-control-mcp-runtime-v1" &&
    typeof value.source === "string" &&
    isNullableNumber(value.observedServers) &&
    isMcpRuntimeHealthCounts(value.health) &&
    Array.isArray(value.servers) &&
    value.servers.every(isMcpRuntimeServer)
  );
}

/**
 * Narrows one applied MCP server.
 *
 * The applied configuration is what the page compares the declaration
 * against, so every launch key it renders has to be present and typed. A
 * launch key that is not a string would render as a configuration the
 * Runtime never published.
 */
function isMcpAppliedServer(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.name === "string" &&
    (value.command === null || typeof value.command === "string") &&
    Array.isArray(value.args) &&
    value.args.every((arg) => typeof arg === "string") &&
    (value.cwd === null || typeof value.cwd === "string") &&
    (value.url === null || typeof value.url === "string") &&
    (value.bearerTokenEnvVar === null ||
      typeof value.bearerTokenEnvVar === "string") &&
    isStringRecord(value.httpHeaders)
  );
}

function isControlApiMcpAppliedResponse(
  value: unknown
): value is ControlApiMcpAppliedResponse {
  return (
    isRecord(value) &&
    value.schema === "autodev-control-mcp-applied-v2" &&
    typeof value.source === "string" &&
    value.declarationSource === ".rulesync/mcp.jsonc" &&
    typeof value.target === "string" &&
    typeof value.available === "boolean" &&
    // The declared side of the comparison is what the page edits, so it is
    // checked rather than assumed: an edit form filled from an unreadable
    // declaration would write a configuration nobody declared.
    Array.isArray(value.declaredServers) &&
    value.declaredServers.every(isMcpAppliedServer) &&
    Array.isArray(value.servers) &&
    value.servers.every(isMcpAppliedServer) &&
    isReconciliationBundle(value.reconciliation)
  );
}

/**
 * Narrows one tool catalog row. Tools is the one catalog whose views read
 * several fields off every row -- role exposure drives both the role filter
 * (`exposedRoles.includes`) and the role chips (`exposedRoles.length`), and the
 * availability verdict is what separates "configured" from "Not observed" --
 * so the guard checks those fields rather than only the identifier. Checking
 * the identifier alone let an incomplete payload through to the view, where it
 * threw instead of failing closed.
 */
function isToolCatalogRow(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.name === "string" &&
    typeof value.source === "string" &&
    typeof value.sourceAuthority === "string" &&
    isStringList(value.exposedRoles) &&
    typeof value.availability === "string"
  );
}

function isControlApiToolsResponse(
  value: unknown
): value is ControlApiToolsResponse {
  return (
    isRecord(value) &&
    value.schema === "autodev-control-tools-v2" &&
    typeof value.source === "string" &&
    typeof value.readOnly === "boolean" &&
    (value.coverage === "complete" ||
      value.coverage === "partial" ||
      value.coverage === "unavailable" ||
      value.coverage === "unknown") &&
    (value.validity === "valid" ||
      value.validity === "invalid" ||
      value.validity === "not-observed") &&
    // The contract's read is a fact the catalogue's counts and role exposure
    // depend on. A payload that does not carry it is a payload that cannot say
    // whether the contract was read, so the Console refuses it rather than
    // counting a catalogue whose second half nobody looked at.
    typeof value.executionContractObserved === "boolean" &&
    isNullableNumber(value.totalTools) &&
    typeof value.usageLink === "string" &&
    Array.isArray(value.tools) &&
    value.tools.every(isToolCatalogRow)
  );
}

/**
 * Canonical-source validation issues.
 *
 * Shared by every RuleSync catalog so one malformed reason cannot pass the guard
 * on one page and fail another -- the fields are identical because the loader
 * that produces them is identical.
 */
function isValidationIssueList(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.every(
      (issue) =>
        isRecord(issue) &&
        typeof issue.location === "string" &&
        typeof issue.message === "string"
    )
  );
}

/**
 * One hook event, as the contract publishes it.
 *
 * The action list is checked rather than trusted: an event whose actions could
 * not be read is dropped, because an event with an unreadable action list is
 * not an event the operator can act on and rendering it as one would invite a
 * write that drops what it could not read.
 *
 * This is the applied side's shape: the projection the Runtime published says
 * what runs and nothing about where it was declared.
 */
function isControlApiHookEvent(value: unknown): value is ControlApiHookEvent {
  return (
    isRecord(value) &&
    typeof value.event === "string" &&
    Array.isArray(value.actions) &&
    value.actions.every(
      (action) =>
        isRecord(action) &&
        action.type === "command" &&
        typeof action.command === "string" &&
        (action.matcher === undefined || typeof action.matcher === "string") &&
        (action.statusMessage === undefined ||
          typeof action.statusMessage === "string")
    )
  );
}

/**
 * One hook event, as the *declaration* publishes it.
 *
 * The declared side carries where the event's declaration lives, because that is
 * what decides who else an edit reaches. The applied projection has no such
 * place, so the two sides are checked differently: requiring an origin of an
 * applied event would refuse it for the one thing it cannot say, and the applied
 * read would then never be readable at all -- which would look exactly like a
 * Runtime that published nothing.
 */
function isControlApiHookDeclaration(
  value: unknown
): value is ControlApiHookDeclaration {
  return (
    isControlApiHookEvent(value) &&
    // The origin is read through the record, not through the event type: the
    // event type is the applied side's shape and carries no origin at all.
    isRecord(value) &&
    (value.origin === "shared" || value.origin === "target")
  );
}

function isControlApiHooksResponse(
  value: unknown
): value is ControlApiHooksResponse {
  return (
    isRecord(value) &&
    value.schema === "autodev-control-hooks-v2" &&
    typeof value.source === "string" &&
    typeof value.readOnly === "boolean" &&
    (value.valid === null || typeof value.valid === "boolean") &&
    // Required, not optional. `valid: false` with no issues renders as "the
    // source is invalid" and nothing else, which is the state this field exists
    // to end: the Runtime has already located the fault and thrown the location
    // and the reason away.
    isValidationIssueList(value.issues) &&
    (value.revision === null || typeof value.revision === "string") &&
    typeof value.target === "string" &&
    Array.isArray(value.events) &&
    value.events.every(isControlApiHookDeclaration)
  );
}

/**
 * The applied hook projection, as the Runtime publishes it.
 *
 * The applied side is checked as strictly as the declared one about the things
 * the two sides have in common -- the event's name and the whole action list --
 * because an applied event that could not be read would make the comparison say
 * nothing. The one thing they do not have in common is the origin: a
 * projection carries no declaration site, so requiring one would refuse the
 * applied read on every Runtime, including one that had published a
 * projection.
 */
function isControlApiHooksAppliedResponse(
  value: unknown
): value is ControlApiHooksAppliedResponse {
  return (
    isRecord(value) &&
    value.schema === "autodev-control-hooks-applied-v1" &&
    typeof value.source === "string" &&
    typeof value.declarationSource === "string" &&
    typeof value.target === "string" &&
    typeof value.available === "boolean" &&
    Array.isArray(value.declaredEvents) &&
    value.declaredEvents.every(isControlApiHookDeclaration) &&
    Array.isArray(value.events) &&
    value.events.every(isControlApiHookEvent) &&
    // The same check every surface that renders a convergence verdict uses, so
    // the applied side's verdict is held to the same shape as the declared
    // side's and the wording cannot differ between them.
    isControlApiReconciliation(value.reconciliation)
  );
}

/**
 * Narrows one metric, which nothing narrowed before.
 *
 * `isEvaluationRow` checked that `metrics` was an array and stopped there, so a
 * read whose measurements were unreadable passed the whole envelope's validation
 * and reached the view. Measured against the six shapes that produces, on one
 * read each:
 *
 * - `metrics: [null]` returned **HTTP 500**. The table's `keyExtractor` reads
 *   `metric.name` on every element, so a null threw inside the server render and
 *   took the resource down with no failure shell, no table and no sentence. The
 *   named code for exactly this, `autodev_control_api_invalid_evaluations_response`,
 *   never ran -- and every well-formed run in the same read went with it.
 * - `metrics: [{}]` rendered the chip `undefined: undefined · Not observed` and
 *   the drawer's Metric cell as an *empty* box, so one unreadable measurement
 *   said two different things depending on which panel the operator opened.
 * - `metrics: [{ name, value: null, pass: true }]` rendered
 *   `latency_ms: null · Passed`: a verdict attached to a measurement that does
 *   not exist, on a run whose own `passed` agreed with it, so the row looked
 *   healthy end to end. JSON is also where a `NaN` or an `Infinity` arrives, so
 *   this is the shape a non-finite measurement takes on the wire.
 * - `metrics: [{ name, value: "12" }]` rendered `tool_calls: 12 · Passed`, so a
 *   quoted number was read as a measurement.
 *
 * `Number.isFinite` rather than `typeof === "number"` because a float beyond the
 * double range parses from JSON to `Infinity` -- a number by every other test.
 *
 * The rule cannot reject a response this Runtime produced, which is the same
 * standard the envelope's `truncated` check is held to. `parseEvaluationRow`
 * already throws `EvaluationSourceUnavailableError` for a score that is not a
 * finite number, `verdictPass` returns `boolean | null` and nothing else, and the
 * metrics are built from `Object.entries(scores)`, so a name is a string and
 * names are unique by construction.
 */
function isEvaluationMetric(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.name === "string" &&
    typeof value.value === "number" &&
    Number.isFinite(value.value) &&
    (value.pass === null || typeof value.pass === "boolean") &&
    // Optional and never sent by this Runtime, so it is checked only when
    // present -- but present-and-wrong is the same unreadable evidence.
    (value.threshold === undefined ||
      (typeof value.threshold === "number" && Number.isFinite(value.threshold)))
  );
}

/**
 * Narrows one evaluation row. `passed` is the verdict the table renders, and
 * `boolean | null` is three states: a missing `passed` reads as `undefined`,
 * which every verdict comparison in the view treats as a failure. A row without
 * it would therefore synthesize "did not pass" out of unreadable evidence, so
 * the check requires it alongside the rest of the required record.
 *
 * The metrics are checked with `isEvaluationMetric` for the same reason as the
 * fields above it: an unreadable measurement invalidates its sample, exactly as
 * an unreadable `passed` does, and the two rules must not disagree inside one row.
 */
function isEvaluationRow(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.agentRole === "string" &&
    typeof value.model === "string" &&
    Array.isArray(value.metrics) &&
    value.metrics.every(isEvaluationMetric) &&
    (value.passed === null || typeof value.passed === "boolean") &&
    typeof value.timestamp === "string"
  );
}

function isControlApiEvaluationsResponse(
  value: unknown
): value is ControlApiEvaluationsResponse {
  return (
    isRecord(value) &&
    value.schema === "autodev-control-evaluations-v1" &&
    typeof value.source === "string" &&
    typeof value.readOnly === "boolean" &&
    typeof value.totalEvaluations === "number" &&
    // Required, not optional. Without it a consumer has to compare
    // `totalEvaluations` against `evaluations.length` to learn that the array
    // is a bounded window, and a consumer that forgets renders the cap as the
    // whole history.
    typeof value.truncated === "boolean" &&
    Array.isArray(value.evaluations) &&
    value.evaluations.every(isEvaluationRow) &&
    // The envelope's two size claims must agree with the rows it carries, in
    // both directions, because the view renders each one as a different fact.
    //
    // A `totalEvaluations` below `evaluations.length` is a total that cannot
    // contain what it totals. Nothing produces one -- the Runtime computes
    // `totalEvaluations` as the table's own size -- so it is unreadable evidence,
    // not a surprising store. It was accepted, and the card then rendered the
    // store as "1" with the subtitle "the most recent 120 in this view": a
    // denominator smaller than its own numerator, on the page the target state
    // requires never to bias displayed totals.
    //
    // The other direction is the same lie told quietly: `truncated: false` over
    // a total larger than the rows is a capped window describing itself as the
    // whole history, which is exactly what `truncated` exists to prevent. The
    // Runtime derives the flag with this precise comparison
    // (`truncated: page.total > page.results.length`), so enforcing the same
    // comparison here cannot reject a response this Runtime produced.
    value.totalEvaluations >= value.evaluations.length &&
    value.truncated === value.totalEvaluations > value.evaluations.length
  );
}

/**
 * Narrows the bounded run statistics.
 *
 * `(stats === null || isRecord(stats))` let an *empty* record through, and an
 * empty record is not a neutral reading -- the view does
 * `Math.round(stats.successRate * 100)`, so a missing rate renders `NaN%`, and
 * `stats.totalRuns` draws an empty stat card. Both closed-number members and
 * the nullable rate are checked, so a drifted projection fails closed instead
 * of publishing arithmetic on `undefined`.
 */
function isGithubRunStats(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.totalRuns === "number" &&
    typeof value.successfulRuns === "number" &&
    typeof value.failedRuns === "number" &&
    typeof value.inProgressRuns === "number" &&
    typeof value.cancelledRuns === "number" &&
    (value.successRate === null || typeof value.successRate === "number")
  );
}

/**
 * Narrows one workflow definition row. The catalog column and the scheduled
 * count are both derived from these lists, so a row without them is not a row
 * the view can render -- `workflows.filter((w) => w.schedules.length > 0)`
 * would throw rather than fail closed.
 */
function isGithubWorkflowRow(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    (value.name === null || typeof value.name === "string") &&
    typeof value.path === "string" &&
    isStringList(value.events) &&
    isStringList(value.schedules)
  );
}

function isControlApiGithubResponse(
  value: unknown
): value is ControlApiGithubResponse {
  return (
    isRecord(value) &&
    value.schema === "autodev-control-github-v1" &&
    typeof value.source === "string" &&
    typeof value.readOnly === "boolean" &&
    (value.catalogStatus === "valid" ||
      value.catalogStatus === "invalid" ||
      value.catalogStatus === "unavailable") &&
    isNullableNumber(value.totalWorkflows) &&
    typeof value.runtimeFactsAvailable === "boolean" &&
    (value.runtimeStatus === "available" ||
      value.runtimeStatus === "unavailable" ||
      value.runtimeStatus === "invalid") &&
    isNullableString(value.runtimeMessage) &&
    isNullableString(value.repository) &&
    (value.stats === null || isGithubRunStats(value.stats)) &&
    Array.isArray(value.workflows) &&
    value.workflows.every(isGithubWorkflowRow) &&
    // The runs are null when the Actions read did not happen, and an empty
    // list when it happened and the workflows had never run. The Console
    // renders the page on the strength of `runtimeFactsAvailable`, so both
    // shapes are answered the same way.
    (value.recentRuns === null || Array.isArray(value.recentRuns))
  );
}

export async function fetchMcps(
  config: ControlApiConfig,
  options: FetchControlApiOptions = {}
): Promise<ControlApiResult<ControlApiMcpsResponse>> {
  const result = await fetchControlApi<unknown>(
    CONTROL_API_PATHS.mcps,
    config,
    options
  );
  if (result.kind !== "ok") return result;
  return isControlApiMcpsResponse(result.data)
    ? { kind: "ok", data: result.data }
    : invalidResponse("Mcps", "autodev-control-mcps-v2");
}

/**
 * Reads the Runtime's observation of the MCP servers it has seen.
 *
 * This is a second read, not a wider one: the catalog stays the configuration
 * read, and the observation arrives on its own path so that a page can compose
 * the two without the contract claiming that a declared server was reached.
 */
export async function fetchMcpRuntime(
  config: ControlApiConfig,
  options: FetchControlApiOptions = {}
): Promise<ControlApiResult<ControlApiMcpRuntimeResponse>> {
  const result = await fetchControlApi<unknown>(
    CONTROL_API_PATHS.mcpRuntime,
    config,
    options
  );
  if (result.kind !== "ok") return result;
  return isControlApiMcpRuntimeResponse(result.data)
    ? { kind: "ok", data: result.data }
    : invalidResponse("McpRuntime", "autodev-control-mcp-runtime-v1");
}

/**
 * Reads the MCP configuration the Runtime applied, against the canonical
 * declaration.
 *
 * The third MCP read, and the third question: the catalog says what is
 * declared, the runtime read says what the Runtime has reached, and this one
 * says what the Runtime actually applied. The page composes them; the
 * contract keeps them apart.
 */
export async function fetchMcpApplied(
  config: ControlApiConfig,
  options: FetchControlApiOptions = {}
): Promise<ControlApiResult<ControlApiMcpAppliedResponse>> {
  const result = await fetchControlApi<unknown>(
    CONTROL_API_PATHS.mcpApplied,
    config,
    options
  );
  if (result.kind !== "ok") return result;
  return isControlApiMcpAppliedResponse(result.data)
    ? { kind: "ok", data: result.data }
    : invalidResponse("McpApplied", "autodev-control-mcp-applied-v2");
}

export async function fetchTools(
  config: ControlApiConfig,
  options: FetchControlApiOptions = {}
): Promise<ControlApiResult<ControlApiToolsResponse>> {
  const result = await fetchControlApi<unknown>(
    CONTROL_API_PATHS.tools,
    config,
    options
  );
  if (result.kind !== "ok") return result;
  return isControlApiToolsResponse(result.data)
    ? { kind: "ok", data: result.data }
    : invalidResponse("Tools", "autodev-control-tools-v2");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

/** A count the Runtime may legitimately not know, as opposed to counting zero. */
function isNullableNumber(value: unknown): value is number | null {
  return value === null || typeof value === "number";
}

/**
 * Narrows a finite number. A `NaN` or an infinite value would render as a
 * measurement the Runtime never made.
 */
function isNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/**
 * Narrows the four reconciliation verdicts the shared contract defines.
 * Anything else is not a convergence status and must fail closed rather than
 * be coerced into a healthy-looking badge.
 */
function isConvergenceStatus(value: unknown): value is ConvergenceStatus {
  return (
    value === "converged" ||
    value === "pending" ||
    value === "error" ||
    value === "not-observed"
  );
}

function isStringList(value: unknown): value is readonly string[] {
  return (
    Array.isArray(value) && value.every((entry) => typeof entry === "string")
  );
}

/**
 * Narrows a record whose every value is a string.
 *
 * The applied MCP catalogue's HTTP headers are the one free-form map the
 * contract carries, so they are checked rather than trusted: a header value
 * that is not a string would render as a configuration the Runtime never
 * published.
 */
function isStringRecord(
  value: unknown
): value is Readonly<Record<string, string>> {
  return (
    isRecord(value) &&
    Object.values(value).every((entry) => typeof entry === "string")
  );
}

/** Optional numeric counter the concurrency projection publishes. */
function isOptionalNumber(value: unknown): value is number | undefined {
  return value === undefined || typeof value === "number";
}

/**
 * A limit that may legitimately be `null`.
 *
 * `null` here is the Runtime's word for "no limit configured", which is the
 * default for per-session concurrency. Treating it as unreadable made the whole
 * Runtime response fail closed on an ordinary deployment: `/control/runtime`
 * answers `maxConcurrentThreadsPerSession: null` unless an operator configured a
 * limit, and this guard rejected it, so the Runtime page reported an incompatible
 * contract precisely when nothing was wrong.
 */
function isOptionalNullableNumber(
  value: unknown
): value is number | null | undefined {
  return value === undefined || value === null || typeof value === "number";
}

/**
 * The router's lifecycle states, mirroring `RouterLifecycleState`.
 *
 * A membership check rather than `typeof === "string"`, because the Console
 * renders this value as a status word: accepting any string would let a state
 * this build has no word for reach an operator unread, and — worse — would let
 * the compiler keep believing the field is one of the two it knows.
 */
function isRouterLifecycleState(value: unknown): boolean {
  return value === "ready" || value === "draining";
}

function isConcurrencyStatus(
  value: unknown
): value is ControlApiConcurrencyStatus {
  if (!isRecord(value)) return false;
  return (
    (value.scope === undefined || typeof value.scope === "string") &&
    (value.configSource === undefined ||
      typeof value.configSource === "string") &&
    (value.configFileExists === undefined ||
      typeof value.configFileExists === "boolean") &&
    (value.revision === undefined ||
      (typeof value.revision === "number" &&
        Number.isInteger(value.revision) &&
        value.revision >= 1)) &&
    isOptionalNullableNumber(value.maxConcurrentThreadsPerSession) &&
    isOptionalNullableNumber(value.effectivePerSessionLimit) &&
    isOptionalNumber(value.activeSubagentThreads) &&
    isOptionalNumber(value.activeSessions) &&
    isOptionalNumber(value.denials) &&
    (value.denialsByReason === undefined ||
      (isRecord(value.denialsByReason) &&
        Object.values(value.denialsByReason).every(
          (count) => typeof count === "number"
        ))) &&
    (value.lastDenial === undefined ||
      value.lastDenial === null ||
      isRecord(value.lastDenial))
  );
}

function isControlApiConcurrencyPatchResponse(
  value: unknown
): value is ControlApiConcurrencyPatchResponse {
  return (
    isRecord(value) &&
    value.schema === "autodev-control-concurrency-v1" &&
    isConcurrencyStatus(value.concurrency)
  );
}

/** Server-only typed mutation for orchestrator concurrency limit. */
export async function patchConcurrencyLimit(
  request: ControlApiConcurrencyPatchRequest,
  config: ControlApiConfig,
  options: FetchControlApiOptions = {}
): Promise<ControlApiResult<ControlApiConcurrencyPatchResponse>> {
  const result = await mutateControlApi<unknown>(
    "PATCH",
    CONTROL_API_PATHS.concurrency,
    request,
    config,
    options
  );
  if (result.kind !== "ok") return result;
  if (isControlApiConcurrencyPatchResponse(result.data)) {
    return { kind: "ok", data: result.data };
  }
  return {
    kind: INVALID_RESPONSE_KIND,
    code: "autodev_control_api_invalid_concurrency_response",
    message:
      "AutoDev Control API returned an incompatible concurrency response; the Console requires the v1 concurrency contract."
  };
}

function isCountMap(value: unknown): value is Readonly<Record<string, number>> {
  return (
    isRecord(value) &&
    Object.values(value).every(
      (count) =>
        typeof count === "number" && Number.isInteger(count) && count >= 0
    )
  );
}

function isControlApiLiveAgentCounts(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.count === "number" &&
    Number.isInteger(value.count) &&
    value.count >= 0 &&
    isCountMap(value.byRole) &&
    isCountMap(value.byProvider) &&
    isCountMap(value.byModel) &&
    isCountMap(value.byWorkspace) &&
    typeof value.missingProvider === "number" &&
    Number.isInteger(value.missingProvider) &&
    value.missingProvider >= 0 &&
    typeof value.missingModel === "number" &&
    Number.isInteger(value.missingModel) &&
    value.missingModel >= 0
  );
}

/**
 * Narrows the runtime response the Console composes onto the Agents page.
 *
 * Runtime state had no guard at all, so any shape the router happened to
 * return was typed as a healthy runtime and rendered. Lifecycle and concurrency
 * are validated here so a stale or incompatible Runtime fails closed into an
 * explicit unavailable state instead of quietly reporting zeros.
 */
function isControlApiRuntimeResponse(
  value: unknown
): value is ControlApiRuntimeResponse {
  return (
    isRecord(value) &&
    value.schema === "autodev-control-runtime-v2" &&
    typeof value.routerInstanceId === "string" &&
    isRecord(value.lifecycle) &&
    isRouterLifecycleState(value.lifecycle.state) &&
    typeof value.lifecycle.draining === "boolean" &&
    typeof value.lifecycle.changedAt === "string" &&
    typeof value.lifecycle.activeResponseRequests === "number" &&
    isConcurrencyStatus(value.concurrency) &&
    typeof value.inFlightRequestCount === "number" &&
    (value.liveAgents === null || isControlApiLiveAgentCounts(value.liveAgents))
  );
}

function isControlApiSkillsResponse(
  value: unknown
): value is ControlApiSkillsResponse {
  return (
    isRecord(value) &&
    value.schema === "autodev-control-skills-v2" &&
    typeof value.source === "string" &&
    // The skills collection has canonical write paths -- role assignment and
    // the canonical source -- so the Runtime says it is writable. A response
    // that claims the opposite is refused rather than rendered: the page
    // offers an assignment form and a source editor, and both post to the
    // write paths this flag names.
    value.readOnly === false &&
    (value.valid === true || value.valid === false || value.valid === null) &&
    // Every catalog carries the reasons it located, so one flag cannot stand in
    // for six faults that need six different repairs.
    isValidationIssueList(value.issues) &&
    // The role assignments come from the execution contract, and the accessor
    // that reads it falls back to an empty contract when the read fails. A
    // payload that cannot say whether the contract was read cannot support the
    // eligibility a card counts.
    typeof value.executionContractObserved === "boolean" &&
    // Required, and pattern-checked rather than merely typed, because a form
    // built from it is the only thing standing between two concurrent operators
    // and a silently discarded assignment. A malformed revision would post as a
    // conflict on every submission and read as "the Console is broken".
    (value.executionContractRevision === null ||
      (typeof value.executionContractRevision === "string" &&
        CONTROL_API_REVISION_PATTERN.test(value.executionContractRevision))) &&
    isStringList(value.assignmentRoles) &&
    Array.isArray(value.skills) &&
    value.skills.every(
      (skill) =>
        isRecord(skill) &&
        typeof skill.name === "string" &&
        typeof skill.description === "string" &&
        typeof skill.path === "string" &&
        isStringList(skill.roles)
    ) &&
    (value.unresolvedAssignments === null ||
      Array.isArray(value.unresolvedAssignments)) &&
    (value.unresolvedAssignments ?? []).every(
      (assignment) =>
        isRecord(assignment) &&
        typeof assignment.name === "string" &&
        isStringList(assignment.roles)
    )
  );
}

export async function fetchSkills(
  config: ControlApiConfig,
  options: FetchControlApiOptions = {}
): Promise<ControlApiResult<ControlApiSkillsResponse>> {
  const result = await fetchControlApi<unknown>(
    CONTROL_API_PATHS.skills,
    config,
    options
  );
  if (result.kind !== "ok") return result;
  if (isControlApiSkillsResponse(result.data)) {
    return { kind: "ok", data: result.data };
  }
  return {
    kind: INVALID_RESPONSE_KIND,
    code: "autodev_control_api_invalid_skills_response",
    message:
      "AutoDev Control API returned an incompatible Skills response; the Console requires the v2 canonical catalog contract."
  };
}

function isControlApiSkillContentResponse(
  value: unknown,
  name: string
): value is ControlApiSkillContentResponse {
  return (
    isRecord(value) &&
    value.schema === "autodev-control-skill-content-v2" &&
    value.name === name &&
    value.path === `.rulesync/skills/${name}/SKILL.md` &&
    typeof value.content === "string" &&
    typeof value.revision === "string" &&
    CONTROL_API_REVISION_PATTERN.test(value.revision) &&
    isReconciliationBundle(value.reconciliation)
  );
}

/** Server-only read of one existing canonical RuleSync skill source. */
export async function fetchSkillContent(
  name: string,
  config: ControlApiConfig,
  options: FetchControlApiOptions = {}
): Promise<ControlApiResult<ControlApiSkillContentResponse>> {
  const result = await fetchControlApi<unknown>(
    `${CONTROL_API_PATHS.skills}/${encodeURIComponent(name)}/content`,
    config,
    options
  );
  if (result.kind !== "ok") return result;
  if (isControlApiSkillContentResponse(result.data, name)) {
    return { kind: "ok", data: result.data };
  }
  return {
    kind: INVALID_RESPONSE_KIND,
    code: "autodev_control_api_invalid_skill_content_response",
    message:
      "AutoDev Control API returned an incompatible canonical skill source; the Console requires the v2 reconciliation contract and cannot safely edit it."
  };
}

/**
 * Validates the desired set against the request and preserves missing actual
 * role evidence as `null`. A response is converged only when the Runtime's
 * observed set and generations confirm the requested assignment.
 */
function sameStringSet(
  left: readonly string[],
  right: readonly string[]
): boolean {
  if (left.length !== right.length) return false;
  const sortedLeft = [...left].sort();
  const sortedRight = [...right].sort();
  return sortedLeft.every((value, index) => value === sortedRight[index]);
}

function isControlApiSkillRolesPatchResponse(
  value: unknown,
  skillName: string,
  requestedRoles: readonly string[]
): value is ControlApiSkillRolesPatchResponse {
  if (
    !isRecord(value) ||
    value.schema !== "autodev-control-skill-assignment-v2" ||
    value.skill !== skillName ||
    !isStringList(value.desiredRoles) ||
    !sameStringSet(value.desiredRoles, requestedRoles) ||
    (value.actualRoles !== null && !isStringList(value.actualRoles)) ||
    typeof value.revision !== "string" ||
    !CONTROL_API_REVISION_PATTERN.test(value.revision) ||
    !isReconciliationBundle(value.reconciliation) ||
    !isReconciliationDiff(value.diff)
  ) {
    return false;
  }

  const reconciliation = value.reconciliation as {
    readonly status: ReconciliationStatus;
  };
  const status = reconciliation.status;
  const actualRoles = value.actualRoles as readonly string[] | null;
  const diff = value.diff as ReconciliationDiff;
  if (
    status.desiredGeneration === null ||
    diff.identifier !== status.desiredGeneration ||
    (actualRoles === null && status.convergence === "converged") ||
    (actualRoles !== null && status.convergence === "not-observed")
  ) {
    return false;
  }

  return (
    status.convergence !== "converged" ||
    (actualRoles !== null &&
      sameStringSet(actualRoles, value.desiredRoles) &&
      status.observedGeneration === status.desiredGeneration)
  );
}

/**
 * Assigns a skill to exactly the roles named, or to none when the list is empty.
 *
 * The whole desired set travels rather than an addition, so an operator who
 * unchecks a role is not silently appending to what is already there. That is
 * also why there is no separate unassign verb to get wrong.
 */
export async function patchSkillRoles(
  name: string,
  payload: ControlApiSkillRolesPatchRequest,
  config: ControlApiConfig,
  options: FetchControlApiOptions = {}
): Promise<ControlApiResult<ControlApiSkillRolesPatchResponse>> {
  const result = await mutateControlApi<unknown>(
    "PATCH",
    `${CONTROL_API_PATHS.skills}/${encodeURIComponent(name)}`,
    payload,
    config,
    options
  );
  if (result.kind !== "ok") return result;
  if (isControlApiSkillRolesPatchResponse(result.data, name, payload.roles)) {
    return { kind: "ok", data: result.data };
  }
  return {
    kind: INVALID_RESPONSE_KIND,
    code: "autodev_control_api_invalid_skill_assignment_response",
    message:
      "AutoDev Control API returned an incompatible skill assignment response; the Console cannot tell which roles were written."
  };
}

function isControlApiSkillContentPatchResponse(
  value: unknown,
  name: string
): value is ControlApiSkillContentPatchResponse {
  return (
    isRecord(value) &&
    value.schema === "autodev-control-skill-content-patch-v1" &&
    value.name === name &&
    typeof value.revision === "string" &&
    CONTROL_API_REVISION_PATTERN.test(value.revision) &&
    typeof value.changed === "boolean" &&
    value.projectionApplied === true &&
    isReconciliationBundle(value.reconciliation)
  );
}

/** Server-only revision-checked update of an existing canonical skill. */
export async function patchSkillContent(
  name: string,
  payload: ControlApiSkillContentPatchRequest,
  config: ControlApiConfig,
  options: FetchControlApiOptions = {}
): Promise<ControlApiResult<ControlApiSkillContentPatchResponse>> {
  const result = await mutateControlApi<unknown>(
    "PATCH",
    `${CONTROL_API_PATHS.skills}/${encodeURIComponent(name)}/content`,
    payload,
    config,
    options
  );
  if (result.kind !== "ok") return result;
  if (isControlApiSkillContentPatchResponse(result.data, name)) {
    return { kind: "ok", data: result.data };
  }
  return {
    kind: INVALID_RESPONSE_KIND,
    code: "autodev_control_api_invalid_skill_content_patch_response",
    message:
      "AutoDev Control API returned an incompatible skill update response; the Console cannot confirm that the projections were applied."
  };
}

export async function fetchHooks(
  config: ControlApiConfig,
  options: FetchControlApiOptions = {}
): Promise<ControlApiResult<ControlApiHooksResponse>> {
  const result = await fetchControlApi<unknown>(
    CONTROL_API_PATHS.hooks,
    config,
    options
  );
  if (result.kind !== "ok") return result;
  return isControlApiHooksResponse(result.data)
    ? { kind: "ok", data: result.data }
    : invalidResponse("Hooks", "autodev-control-hooks-v2");
}

/**
 * The hook projection the Runtime published.
 *
 * It is read on its own path rather than folded into the declaration, because
 * the two answer different questions: the declaration says what is configured
 * and the applied read says what the Runtime installed.
 */
export async function fetchHooksApplied(
  config: ControlApiConfig,
  options: FetchControlApiOptions = {}
): Promise<ControlApiResult<ControlApiHooksAppliedResponse>> {
  const result = await fetchControlApi<unknown>(
    CONTROL_API_PATHS.hooksApplied,
    config,
    options
  );
  if (result.kind !== "ok") return result;
  return isControlApiHooksAppliedResponse(result.data)
    ? { kind: "ok", data: result.data }
    : invalidResponse("Hooks", "autodev-control-hooks-applied-v1");
}

/**
 * Write one hook event's action list to the canonical declaration.
 *
 * The write is the Runtime's: the Console forwards the operator's edit and
 * never touches the declaration itself.
 */
export function patchHookEvent(
  event: string,
  payload: ControlApiHookEventPatchRequest,
  config: ControlApiConfig,
  options: FetchControlApiOptions = {}
): Promise<ControlApiResult<ControlApiHookEventPatchResponse>> {
  return mutateControlApi<ControlApiHookEventPatchResponse>(
    "PATCH",
    `${CONTROL_API_PATHS.hooks}/${encodeURIComponent(event)}`,
    payload,
    config,
    options
  );
}

/**
 * Narrows the permissions policy.
 *
 * `isRecord(value.policy)` was the whole check, and a policy with no members at
 * all passed it. That produced four wrong cards on one row: `approvalPolicy`
 * rendered as an empty box -- React draws nothing for `undefined`, so the card
 * was simply blank -- while `networkAccess ? "Allowed" : "Blocked"` and
 * `webSearch ? "Enabled" : "Disabled"` read `undefined` as `false` and stated
 * two confident claims, and `sandboxLabel(undefined)` produced a third. An
 * unreadable policy must not be able to say "Blocked".
 *
 * Both closed vocabularies are checked exactly rather than as plain strings,
 * because a drifted value has to fail closed rather than render as a novel
 * policy name. `sandboxMode` is checked with Core's `isSandboxMode`, so the
 * accepted set is the one the type is derived from and the two cannot drift.
 *
 * The policy carries no `defaultToolsApprovalMode`: no canonical source
 * declared one, so the field was a value the product invented, and the
 * Console rendered it beside a policy that was not the policy the product ran.
 */
function isPermissionsPolicy(value: unknown): boolean {
  return (
    isRecord(value) &&
    (value.approvalPolicy === "never" ||
      value.approvalPolicy === "always" ||
      value.approvalPolicy === "on-demand") &&
    isSandboxMode(value.sandboxMode) &&
    typeof value.approvalsReviewer === "string" &&
    typeof value.networkAccess === "boolean" &&
    typeof value.webSearch === "boolean"
  );
}

/**
 * Narrows the permissions response.
 *
 * The policy may be absent: a canonical source that could not be read is
 * reported as not observed, which is a state the page renders, rather than a
 * response the whole page refuses to show. The same is true of the applied
 * policy -- a composed configuration that could not be read says so instead of
 * being replaced by the policy the source states.
 */
function isControlApiPermissionsResponse(
  value: unknown
): value is ControlApiPermissionsResponse {
  if (
    !isRecord(value) ||
    value.schema !== "autodev-control-permissions-v2" ||
    typeof value.source !== "string" ||
    value.readOnly !== false ||
    // The role matrices are the execution contract's roles, and the matrices
    // cannot say whether the contract was read. The response has to say it, or
    // an empty matrix set is indistinguishable from a contract nobody read.
    typeof value.executionContractObserved !== "boolean" ||
    (value.revision !== null && typeof value.revision !== "string") ||
    (value.policy !== null && !isPermissionsPolicy(value.policy)) ||
    (value.applied !== null && !isPermissionsPolicy(value.applied)) ||
    typeof value.appliedSource !== "string" ||
    (value.policyStatus !== "valid" &&
      value.policyStatus !== "invalid" &&
      value.policyStatus !== "unavailable") ||
    (value.policyReason !== null && typeof value.policyReason !== "string") ||
    !isRecord(value.rolePermissions)
  ) {
    return false;
  }
  return Object.values(value.rolePermissions).every(
    (entry) =>
      isRecord(entry) &&
      // A role's sandbox is what its own declaration states, and a role whose
      // declaration could not be read has no observed sandbox. The check is
      // exact so a drifted mode fails closed instead of being rendered as the
      // nearest mode the Console knows.
      (entry.sandboxMode === null || isSandboxMode(entry.sandboxMode)) &&
      // The capability matrix must be a real projection. An absent list is
      // missing evidence, not "no MCP servers", so it fails closed instead of
      // letting the Console print a fabricated `None`.
      isStringList(entry.mcp) &&
      isStringList(entry.skills) &&
      // Same reasoning for the tool grants, one level down: a role's reach into
      // an MCP server is not permission to call everything on it, so the page
      // needs the per-server lists and cannot infer them from the server names.
      isMcpToolGrants(entry.mcpTools)
  );
}

/**
 * Per-server tool allowlists: an object whose values are all string lists.
 *
 * An empty object is valid and means the role reaches no MCP tools. It is not
 * the same as a missing field, which fails closed, because a role with no tool
 * grants and a role whose grants the Runtime could not report are different
 * states and only one of them is a permission claim.
 */
function isMcpToolGrants(value: unknown): boolean {
  return (
    isRecord(value) &&
    Object.values(value).every((names) => isStringList(names))
  );
}

export async function fetchPermissions(
  config: ControlApiConfig,
  options: FetchControlApiOptions = {}
): Promise<ControlApiResult<ControlApiPermissionsResponse>> {
  const result = await fetchControlApi<unknown>(
    CONTROL_API_PATHS.permissions,
    config,
    options
  );
  if (result.kind !== "ok") return result;
  if (isControlApiPermissionsResponse(result.data)) {
    return { kind: "ok", data: result.data };
  }
  return {
    kind: INVALID_RESPONSE_KIND,
    code: "autodev_control_api_invalid_permissions_response",
    message:
      "AutoDev Control API returned an incompatible Permissions response; the Console requires the effective capability-matrix contract."
  };
}

/**
 * Change one setting of the canonical permission policy.
 *
 * The write names the setting it changes and the revision it decided on, so
 * the Runtime can refuse a change made against a policy that has since moved
 * instead of applying it over the newer one.
 */
export function patchPermissions(
  payload: ControlApiPermissionsPatchRequest,
  config: ControlApiConfig,
  options: FetchControlApiOptions = {}
): Promise<ControlApiResult<ControlApiPermissionsPatchResponse>> {
  return mutateControlApi<ControlApiPermissionsPatchResponse>(
    "PATCH",
    CONTROL_API_PATHS.permissions,
    payload,
    config,
    options
  );
}

function isControlApiPromptsResponse(
  value: unknown
): value is ControlApiPromptsResponse {
  return (
    isRecord(value) &&
    value.schema === "autodev-control-prompts-v2" &&
    typeof value.source === "string" &&
    // The prompts collection has a canonical write path -- the command's own
    // source -- so the Runtime says it is writable. A response that claims the
    // opposite is refused rather than rendered: the page offers a source
    // editor that posts to the write path this flag names.
    value.readOnly === false &&
    (value.valid === true || value.valid === false || value.valid === null) &&
    isValidationIssueList(value.issues) &&
    (value.totalCommands === null ||
      (Number.isSafeInteger(value.totalCommands) &&
        (value.totalCommands as number) >= 0)) &&
    Array.isArray(value.commands) &&
    value.commands.every(
      (command) =>
        isRecord(command) &&
        typeof command.name === "string" &&
        typeof command.path === "string" &&
        (command.description === undefined ||
          typeof command.description === "string")
    ) &&
    // The role prompts are their own read. Null says that read did not happen,
    // which is what a count over the catalogue needs to know; a list says it
    // did, and an empty list is then a measured zero.
    (value.rolePrompts === null ||
      (Array.isArray(value.rolePrompts) &&
        value.rolePrompts.every(
          (prompt) =>
            isRecord(prompt) &&
            typeof prompt.role === "string" &&
            typeof prompt.path === "string"
        )))
  );
}

export async function fetchPrompts(
  config: ControlApiConfig,
  options: FetchControlApiOptions = {}
): Promise<ControlApiResult<ControlApiPromptsResponse>> {
  const result = await fetchControlApi<unknown>(
    CONTROL_API_PATHS.prompts,
    config,
    options
  );
  if (result.kind !== "ok") return result;
  if (isControlApiPromptsResponse(result.data)) {
    return { kind: "ok", data: result.data };
  }
  return {
    kind: INVALID_RESPONSE_KIND,
    code: "autodev_control_api_invalid_prompts_response",
    message:
      "AutoDev Control API returned an incompatible Prompts response; the Console requires the v2 source-validity contract."
  };
}

function isControlApiReconciliation(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const status = value.status;
  if (!isRecord(status)) return false;
  if (
    typeof status.convergence !== "string" ||
    (status.desiredGeneration !== null &&
      typeof status.desiredGeneration !== "string") ||
    (status.observedGeneration !== null &&
      typeof status.observedGeneration !== "string") ||
    (status.lastApplyAt !== null && typeof status.lastApplyAt !== "string") ||
    (status.lastObservationAt !== null &&
      typeof status.lastObservationAt !== "string") ||
    (status.lastError !== null && typeof status.lastError !== "string") ||
    typeof status.explanation !== "string"
  ) {
    return false;
  }
  if (!Array.isArray(value.history)) return false;
  return value.history.every((entry) => {
    if (!isRecord(entry)) return false;
    return (
      typeof entry.action === "string" &&
      typeof entry.resource === "string" &&
      typeof entry.timestamp === "string" &&
      (entry.actor === null || typeof entry.actor === "string") &&
      (entry.outcome === "ok" ||
        entry.outcome === "denied" ||
        entry.outcome === "error") &&
      (entry.reason === null || typeof entry.reason === "string") &&
      isRecord(entry.changes) &&
      typeof entry.changes.restartRequired === "boolean"
    );
  });
}

function isReconciliationDiff(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.summary === "string" &&
    typeof value.identifier === "string"
  );
}

function isControlApiPromptDetailResponse(
  value: unknown
): value is ControlApiPromptDetailResponse {
  return (
    isRecord(value) &&
    value.schema === "autodev-control-prompt-detail-v4" &&
    typeof value.name === "string" &&
    (value.type === "command" || value.type === "role") &&
    typeof value.source === "string" &&
    typeof value.content === "string" &&
    typeof value.preview === "string" &&
    typeof value.revision === "string" &&
    CONTROL_API_REVISION_PATTERN.test(value.revision) &&
    isReconciliationDiff(value.diff) &&
    isControlApiReconciliation(value.reconciliation)
  );
}

export async function fetchPromptDetail(
  name: string,
  config: ControlApiConfig,
  options: FetchControlApiOptions = {}
): Promise<ControlApiResult<ControlApiPromptDetailResponse>> {
  const path = `${CONTROL_API_PATHS.prompts}/${encodeURIComponent(name)}`;
  const result = await fetchControlApi<unknown>(path, config, options);
  if (result.kind !== "ok") return result;
  if (isControlApiPromptDetailResponse(result.data)) {
    return { kind: "ok", data: result.data };
  }
  return {
    kind: INVALID_RESPONSE_KIND,
    code: "autodev_control_api_invalid_prompt_detail_response",
    message:
      "AutoDev Control API returned an incompatible Prompt detail response; the Console requires the v4 reconciliation contract."
  };
}

function isControlApiPromptVersionsResponse(
  value: unknown
): value is ControlApiPromptVersionsResponse {
  if (
    !isRecord(value) ||
    value.schema !== "autodev-control-prompt-versions-v2" ||
    typeof value.name !== "string" ||
    (value.status !== "available" && value.status !== "unavailable") ||
    typeof value.hasMore !== "boolean" ||
    !Number.isInteger(value.offset) ||
    (value.offset as number) < 0 ||
    !Number.isInteger(value.limit) ||
    (value.limit as number) < 1 ||
    !Array.isArray(value.versions) ||
    !value.versions.every(
      (version) =>
        isRecord(version) &&
        typeof version.versionHash === "string" &&
        CONTROL_API_GIT_REVISION_PATTERN.test(version.versionHash) &&
        typeof version.updatedAt === "string" &&
        Number.isFinite(Date.parse(version.updatedAt))
    )
  ) {
    return false;
  }
  return (
    value.status !== "unavailable" ||
    (value.versions.length === 0 && value.hasMore === false)
  );
}

/**
 * Reads one page of a prompt's committed history.
 *
 * The page size is the Control API's to choose, so the Console asks for an
 * offset and reads the size back from the answer. Asking for a size here
 * would put two places in charge of how much history a page carries.
 */
export async function fetchPromptVersions(
  name: string,
  config: ControlApiConfig,
  options: FetchControlApiOptions = {},
  offset = 0
): Promise<ControlApiResult<ControlApiPromptVersionsResponse>> {
  const path = `${CONTROL_API_PATHS.prompts}/${encodeURIComponent(name)}/versions?offset=${offset}`;
  const result = await fetchControlApi<unknown>(path, config, options);
  if (result.kind !== "ok") return result;
  if (
    isControlApiPromptVersionsResponse(result.data) &&
    result.data.name === name
  ) {
    return { kind: "ok", data: result.data };
  }
  return {
    kind: INVALID_RESPONSE_KIND,
    code: "autodev_control_api_invalid_prompt_versions_response",
    message:
      "AutoDev Control API returned an incompatible Prompt version-history response."
  };
}

function isControlApiPromptVersionResponse(
  value: unknown
): value is ControlApiPromptVersionResponse {
  return (
    isRecord(value) &&
    value.schema === "autodev-control-prompt-version-v1" &&
    typeof value.name === "string" &&
    typeof value.versionHash === "string" &&
    CONTROL_API_GIT_REVISION_PATTERN.test(value.versionHash) &&
    typeof value.updatedAt === "string" &&
    Number.isFinite(Date.parse(value.updatedAt)) &&
    typeof value.content === "string" &&
    typeof value.diff === "string"
  );
}

export async function fetchPromptVersion(
  name: string,
  versionHash: string,
  config: ControlApiConfig,
  options: FetchControlApiOptions = {}
): Promise<ControlApiResult<ControlApiPromptVersionResponse>> {
  const path = `${CONTROL_API_PATHS.prompts}/${encodeURIComponent(name)}/versions/${encodeURIComponent(versionHash)}`;
  const result = await fetchControlApi<unknown>(path, config, {
    ...options,
    timeoutMs: options.timeoutMs ?? PROMPT_VERSION_TIMEOUT_MS
  });
  if (result.kind !== "ok") return result;
  if (
    isControlApiPromptVersionResponse(result.data) &&
    result.data.name === name &&
    result.data.versionHash === versionHash
  ) {
    return { kind: "ok", data: result.data };
  }
  return {
    kind: INVALID_RESPONSE_KIND,
    code: "autodev_control_api_invalid_prompt_version_response",
    message:
      "AutoDev Control API returned an incompatible Prompt version response."
  };
}

export function patchPromptCommand(
  name: string,
  payload: ControlApiPromptCommandPatchRequest,
  config: ControlApiConfig,
  options: FetchControlApiOptions = {}
): Promise<ControlApiResult<ControlApiPromptCommandPatchResponse>> {
  return mutateControlApi<ControlApiPromptCommandPatchResponse>(
    "PATCH",
    `${CONTROL_API_PATHS.prompts}/${encodeURIComponent(name)}`,
    payload,
    config,
    options
  );
}

/**
 * Server-only typed PATCH writing one MCP server's launch configuration to
 * the canonical declaration.
 *
 * The write is a compare-and-swap on the declaration's revision, so the
 * Console sends the revision it read and the Runtime refuses a write decided
 * on an older declaration.
 */
export function patchMcpServer(
  name: string,
  payload: ControlApiMcpServerPatchRequest,
  config: ControlApiConfig,
  options: FetchControlApiOptions = {}
): Promise<ControlApiResult<ControlApiMcpServerPatchResponse>> {
  return mutateControlApi<ControlApiMcpServerPatchResponse>(
    "PATCH",
    `${CONTROL_API_PATHS.mcps}/${encodeURIComponent(name)}`,
    payload,
    config,
    options
  );
}

/**
 * Narrows the workspace catalog. The catalog scopes every Memory read, so an
 * unreadable one must not reach the selector as an empty list: an operator
 * would see "no workspaces" rather than "the catalog could not be read".
 */
/**
 * Narrow one workspace's configuration health.
 *
 * The two states are different claims -- "this entry is usable" and "this
 * scope names roles nothing answers to" -- and the second names the roles it
 * could not place, so a fault can be shown rather than only counted.
 */
function isWorkspaceConfigurationHealth(
  value: unknown
): value is WorkspaceConfigurationHealth {
  if (!isRecord(value)) return false;
  if (value.status === "configured") return true;
  return (
    value.status === "invalid-role-scope" && isStringList(value.unknownRoles)
  );
}

/**
 * Narrow one workspace's runtime availability.
 *
 * `not-observed` and `observed` are different claims, and only the observed
 * one carries a count: a workspace the source did not list has zero live
 * agents, which is a measurement rather than an absence of evidence.
 *
 * The status key itself is not spelled here. The Console's server layer may
 * not import the component that owns it, and a second spelling of the key
 * would put the two out of step, so the no-evidence case is recognised by
 * its shape instead: the contract's other status carries no payload at all.
 * A response that carries a payload this contract does not define fails
 * closed rather than being read as evidence.
 */
function isWorkspaceRuntimeAvailability(
  value: unknown
): value is WorkspaceRuntimeAvailability {
  if (!isRecord(value)) return false;
  if (value.status === "observed") {
    return (
      typeof value.liveAgents === "number" &&
      Number.isInteger(value.liveAgents) &&
      value.liveAgents >= 0
    );
  }
  return Object.keys(value).length === 1 && typeof value.status === "string";
}

function isControlApiWorkspacesResponse(
  value: unknown
): value is ControlApiWorkspacesResponse {
  return (
    isRecord(value) &&
    value.schema === "autodev-control-workspaces-v3" &&
    typeof value.source === "string" &&
    typeof value.readOnly === "boolean" &&
    (value.catalogStatus === "valid" ||
      value.catalogStatus === "invalid" ||
      value.catalogStatus === "unavailable") &&
    // The revision is the handle a write is compared against, so a read that
    // cannot name it is saying that there is nothing to write against.
    (value.revision === null || typeof value.revision === "string") &&
    isNullableNumber(value.totalWorkspaces) &&
    // The reconciliation is required, not optional: the Workspaces surface
    // says converged, pending or not observed from it, and a response without
    // it would leave the page to infer convergence from the catalog's
    // contents.
    isReconciliationBundle(value.reconciliation) &&
    Array.isArray(value.workspaces) &&
    value.workspaces.every(
      (workspace) =>
        isRecord(workspace) &&
        typeof workspace.id === "string" &&
        typeof workspace.baseBranch === "string" &&
        typeof workspace.enabled === "boolean" &&
        (workspace.agentRoles === null || isStringList(workspace.agentRoles)) &&
        isWorkspaceConfigurationHealth(workspace.configuration) &&
        isWorkspaceRuntimeAvailability(workspace.runtime)
    )
  );
}

export async function fetchWorkspaces(
  config: ControlApiConfig,
  options: FetchControlApiOptions = {}
): Promise<ControlApiResult<ControlApiWorkspacesResponse>> {
  const result = await fetchControlApi<unknown>(
    CONTROL_API_PATHS.workspaces,
    config,
    options
  );
  if (result.kind !== "ok") return result;
  if (isControlApiWorkspacesResponse(result.data)) {
    return { kind: "ok", data: result.data };
  }
  return {
    kind: INVALID_RESPONSE_KIND,
    code: "autodev_control_api_invalid_workspaces_response",
    message:
      "AutoDev Control API returned an incompatible Workspaces response; the Console requires the v2 workspace catalog contract."
  };
}

/**
 * Write one workspace's configuration to the canonical catalog.
 *
 * The write is the Runtime's: the Console forwards the operator's edit and
 * never touches the catalog itself. The owner and the repository are separate
 * path segments because a workspace is an `owner/repository` pair, and the
 * Runtime names it the way the catalog is indexed.
 */
export function patchWorkspace(
  owner: string,
  repository: string,
  payload: ControlApiWorkspacePatchRequest,
  config: ControlApiConfig,
  options: FetchControlApiOptions = {}
): Promise<ControlApiResult<ControlApiWorkspacePatchResponse>> {
  return mutateControlApi<ControlApiWorkspacePatchResponse>(
    "PATCH",
    `${CONTROL_API_PATHS.workspaces}/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}`,
    payload,
    config,
    options
  );
}

function isWorkspacePlaytestApprovalResponse(
  value: unknown,
  workspaceId: string
): value is ControlApiWorkspacePlaytestApprovalResponse {
  if (
    !isRecord(value) ||
    value.schema !== "autodev-control-workspace-playtest-approval-v1" ||
    value.workspaceId !== workspaceId ||
    typeof value.workspaceEnabled !== "boolean"
  ) {
    return false;
  }
  if (value.approval === null) return true;
  try {
    assertWorkspacePlaytestApproval(value.approval);
  } catch {
    return false;
  }
  return value.approval.workspaceId === workspaceId;
}

function workspacePlaytestApprovalPath(workspaceId: string): string {
  return `${CONTROL_API_PATHS.workspaces}/${encodeURIComponent(workspaceId)}/playtesting-approval`;
}

export async function fetchWorkspacePlaytestApproval(
  workspaceId: string,
  config: ControlApiConfig,
  options: FetchControlApiOptions = {}
): Promise<ControlApiResult<ControlApiWorkspacePlaytestApprovalResponse>> {
  const result = await fetchControlApi<unknown>(
    workspacePlaytestApprovalPath(workspaceId),
    config,
    options
  );
  if (result.kind !== "ok") return result;
  return isWorkspacePlaytestApprovalResponse(result.data, workspaceId)
    ? { kind: "ok", data: result.data }
    : {
        kind: INVALID_RESPONSE_KIND,
        code: "autodev_control_api_invalid_workspace_playtest_approval",
        message:
          "AutoDev Control API returned an incompatible Workspace Playtesting approval response."
      };
}

export function postWorkspacePlaytestApproval(
  workspaceId: string,
  payload: unknown,
  config: ControlApiConfig,
  options: FetchControlApiOptions = {}
): Promise<ControlApiResult<ControlApiWorkspacePlaytestApprovalResponse>> {
  return postControlApi(
    workspacePlaytestApprovalPath(workspaceId),
    payload,
    config,
    options
  );
}

export function postWorkspacePlaytestRevocation(
  workspaceId: string,
  payload: unknown,
  config: ControlApiConfig,
  options: FetchControlApiOptions = {}
): Promise<ControlApiResult<ControlApiWorkspacePlaytestApprovalResponse>> {
  return postControlApi(
    workspacePlaytestApprovalPath(workspaceId) + "/revoke",
    payload,
    config,
    options
  );
}

function workspaceVisualPlaytestTargetsPath(workspaceId: string): string {
  return `${CONTROL_API_PATHS.workspaces}/${encodeURIComponent(workspaceId)}/playtesting-visual-targets`;
}

function isWorkspaceVisualPlaytestTargetsResponse(
  value: unknown,
  workspaceId: string
): value is ControlApiWorkspaceVisualPlaytestTargetsResponse {
  if (
    !isRecord(value) ||
    value.schema !== "autodev-control-workspace-visual-playtest-targets-v1" ||
    value.workspaceId !== workspaceId ||
    typeof value.workspaceEnabled !== "boolean" ||
    !Array.isArray(value.targets)
  ) {
    return false;
  }
  try {
    for (const target of value.targets) {
      assertWorkspaceVisualPlaytestTargetApproval(target);
      if (target.workspaceId !== workspaceId) return false;
    }
  } catch {
    return false;
  }
  return true;
}

export async function fetchWorkspaceVisualPlaytestTargets(
  workspaceId: string,
  config: ControlApiConfig,
  options: FetchControlApiOptions = {}
): Promise<ControlApiResult<ControlApiWorkspaceVisualPlaytestTargetsResponse>> {
  const result = await fetchControlApi<unknown>(
    workspaceVisualPlaytestTargetsPath(workspaceId),
    config,
    options
  );
  if (result.kind !== "ok") return result;
  return isWorkspaceVisualPlaytestTargetsResponse(result.data, workspaceId)
    ? { kind: "ok", data: result.data }
    : {
        kind: INVALID_RESPONSE_KIND,
        code: "autodev_control_api_invalid_workspace_visual_targets",
        message:
          "AutoDev Control API returned an incompatible Workspace visual targets response."
      };
}

async function postWorkspaceVisualTargetMutation(
  workspaceId: string,
  path: string,
  payload: unknown,
  config: ControlApiConfig,
  options: FetchControlApiOptions = {}
): Promise<ControlApiResult<ControlApiWorkspaceVisualPlaytestTargetsResponse>> {
  const result = await postControlApi<unknown>(path, payload, config, options);
  if (result.kind !== "ok") return result;
  return isWorkspaceVisualPlaytestTargetsResponse(result.data, workspaceId)
    ? { kind: "ok", data: result.data }
    : {
        kind: INVALID_RESPONSE_KIND,
        code: "autodev_control_api_invalid_workspace_visual_targets",
        message:
          "AutoDev Control API returned an incompatible Workspace visual targets response."
      };
}

export function postWorkspaceVisualPlaytestTarget(
  workspaceId: string,
  payload: unknown,
  config: ControlApiConfig,
  options: FetchControlApiOptions = {}
): Promise<ControlApiResult<ControlApiWorkspaceVisualPlaytestTargetsResponse>> {
  return postWorkspaceVisualTargetMutation(
    workspaceId,
    workspaceVisualPlaytestTargetsPath(workspaceId),
    payload,
    config,
    options
  );
}

export function postWorkspaceVisualPlaytestTargetRevocation(
  workspaceId: string,
  targetId: string,
  payload: unknown,
  config: ControlApiConfig,
  options: FetchControlApiOptions = {}
): Promise<ControlApiResult<ControlApiWorkspaceVisualPlaytestTargetsResponse>> {
  return postWorkspaceVisualTargetMutation(
    workspaceId,
    `${workspaceVisualPlaytestTargetsPath(workspaceId)}/${encodeURIComponent(targetId)}/revoke`,
    payload,
    config,
    options
  );
}

export async function fetchGithubWorkflows(
  config: ControlApiConfig,
  options: FetchControlApiOptions = {}
): Promise<ControlApiResult<ControlApiGithubResponse>> {
  // Runtime's GitHub projection performs bounded external Actions API reads
  // (each with its own 10-second deadline). The generic 5-second Control API
  // deadline expired first on a cold snapshot, so the Console mislabeled an
  // in-progress read as a Control API timeout. Allow the server-side GitHub
  // budget to finish, while retaining a strict 20-second outer bound.
  const result = await fetchControlApi<unknown>(
    CONTROL_API_PATHS.github,
    config,
    {
      ...options,
      timeoutMs: options.timeoutMs ?? GITHUB_CONTROL_API_TIMEOUT_MS
    }
  );
  if (result.kind !== "ok") return result;
  // GitHub's page is explicitly about unobserved state: a catalog that cannot be
  // read must report that rather than present an empty workflow list as "this
  // repository has no workflows".
  return isControlApiGithubResponse(result.data)
    ? { kind: "ok", data: result.data }
    : invalidResponse("GitHub", "autodev-control-github-v1");
}

export async function fetchRuntime(
  config: ControlApiConfig,
  options: FetchControlApiOptions = {}
): Promise<ControlApiResult<ControlApiRuntimeResponse>> {
  const result = await fetchControlApi<unknown>(
    CONTROL_API_PATHS.runtime,
    config,
    options
  );
  if (result.kind !== "ok") return result;
  if (isControlApiRuntimeResponse(result.data)) {
    return { kind: "ok", data: result.data };
  }
  return {
    kind: INVALID_RESPONSE_KIND,
    code: "autodev_control_api_invalid_runtime_response",
    message:
      "AutoDev Control API returned an incompatible Runtime response; the Console requires the v2 runtime contract."
  };
}

export async function fetchEvaluations(
  config: ControlApiConfig,
  options: FetchControlApiOptions = {}
): Promise<ControlApiResult<ControlApiEvaluationsResponse>> {
  const result = await fetchControlApi<unknown>(
    CONTROL_API_PATHS.evaluations,
    config,
    options
  );
  if (result.kind !== "ok") return result;
  return isControlApiEvaluationsResponse(result.data)
    ? { kind: "ok", data: result.data }
    : invalidResponse(
        "Evaluations",
        "autodev-control-evaluations-v1",
        "autodev_control_api_invalid_evaluations_response"
      );
}

/**
 * Narrows a storage-status response.
 *
 * The three states are checked against the contract's own list rather than
 * treated as any string, because the whole point of this read is telling three
 * apart. A validator that accepted an unrecognised state would let a Runtime
 * that changed its vocabulary render as `unavailable` -- the one answer this
 * read exists to avoid, arriving through the read meant to prevent it.
 */
function isMemoryStatusResponse(
  value: unknown
): value is ControlApiMemoryStatusResponse {
  if (!isRecord(value) || value.schema !== "autodev-memory-status-v1") {
    return false;
  }
  const storage = value.storage;
  return (
    isRecord(storage) &&
    (storage.state === "not_configured" ||
      storage.state === "unreachable" ||
      storage.state === "reachable") &&
    storage.backend === "postgresql" &&
    (storage.embeddings === "not_configured" ||
      storage.embeddings === "configured") &&
    typeof storage.probeTimeoutMs === "number"
  );
}

/**
 * Whether durable memory storage is connected on the Runtime behind it.
 *
 * Deliberately unscoped: this describes the Runtime's own storage rather than
 * any workspace's memory, so it carries no `workspaceId` and is the one memory
 * read an operator can make without task-history access. Every other memory read
 * answers `503` when storage is down, which is why an operator reading them
 * alone cannot tell "not configured" from "unreachable" from "nothing stored
 * yet" -- and why this one exists.
 */
export async function fetchMemoryStatus(
  config: ControlApiConfig,
  options: FetchControlApiOptions = {}
): Promise<ControlApiResult<ControlApiMemoryStatusResponse>> {
  const result = await fetchControlApi<unknown>(
    CONTROL_API_PATHS.memoryStatus,
    config,
    options
  );
  if (result.kind !== "ok") return result;
  return isMemoryStatusResponse(result.data)
    ? { kind: "ok", data: result.data }
    : invalidMemoryPageResponse("Storage status", "autodev-memory-status-v1");
}

export async function fetchMemoryRecords(
  params: {
    readonly workspaceId: string;
    readonly repositoryId?: string;
    readonly query?: string;
    readonly kind?: string;
    readonly status?: string;
    readonly occurredFrom?: string;
    readonly occurredUntil?: string;
    readonly limit?: number;
    readonly offset?: number;
  },
  config: ControlApiConfig,
  options: FetchControlApiOptions = {}
): Promise<ControlApiResult<ControlApiMemoryRecordsResponse>> {
  const search = new URLSearchParams();
  search.set("workspaceId", params.workspaceId);
  if (params.repositoryId) search.set("repositoryId", params.repositoryId);
  if (params.query) search.set("query", params.query);
  if (params.kind) search.set("kind", params.kind);
  if (params.status) search.set("status", params.status);
  if (params.occurredFrom) search.set("occurredFrom", params.occurredFrom);
  if (params.occurredUntil) search.set("occurredUntil", params.occurredUntil);
  if (params.limit !== undefined) search.set("limit", String(params.limit));
  if (params.offset !== undefined) search.set("offset", String(params.offset));
  const path = `${CONTROL_API_PATHS.memoryRecords}?${search.toString()}`;
  const result = await fetchControlApi<unknown>(path, config, options);
  if (result.kind !== "ok") return result;
  return isMemoryPageResponse<ControlApiMemoryRecordsResponse>(
    result.data,
    "autodev-memory-records-v1",
    isMemoryRecordRow
  ) &&
    isMemoryStatusCounts(
      (result.data as { statusCounts?: unknown }).statusCounts
    )
    ? { kind: "ok", data: result.data }
    : invalidMemoryPageResponse("Records", "autodev-memory-records-v1");
}

export async function fetchMemoryRecord(
  id: string,
  workspaceId: string,
  config: ControlApiConfig,
  options: FetchControlApiOptions = {}
): Promise<ControlApiResult<ControlApiMemoryRecordDetailResponse>> {
  const search = new URLSearchParams({ workspaceId });
  const path = `${CONTROL_API_PATHS.memoryRecords}/${encodeURIComponent(id)}?${search.toString()}`;
  const result = await fetchControlApi<unknown>(path, config, options);
  if (result.kind !== "ok") return result;
  // A detail read that cannot be parsed must not reach the page as an empty
  // record: the view would render blank fields and an empty history as though
  // the durable claim had none of either.
  const detail: unknown = result.data;
  if (isMemoryRecordDetailResponse(detail)) {
    return { kind: "ok", data: detail };
  }
  return invalidMemoryPageResponse("record detail", "autodev-memory-record-v1");
}

export async function fetchMemoryWhy(
  id: string,
  workspaceId: string,
  config: ControlApiConfig,
  options: FetchControlApiOptions = {}
): Promise<ControlApiResult<ControlApiMemoryWhyResponse>> {
  const search = new URLSearchParams({ workspaceId });
  const path = `${CONTROL_API_PATHS.memoryRecords}/${encodeURIComponent(id)}/why?${search.toString()}`;
  const result = await fetchControlApi<unknown>(path, config, options);
  if (result.kind !== "ok") return result;
  const why: unknown = result.data;
  if (isMemoryWhyResponse(why)) {
    return { kind: "ok", data: why };
  }
  return invalidMemoryPageResponse(
    "record explanation",
    "autodev-memory-why-v1"
  );
}

export async function fetchMemoryHistory(
  id: string,
  workspaceId: string,
  config: ControlApiConfig,
  options: FetchControlApiOptions = {}
): Promise<ControlApiResult<ControlApiMemoryHistoryResponse>> {
  const search = new URLSearchParams({ workspaceId });
  const path = `${CONTROL_API_PATHS.memoryRecords}/${encodeURIComponent(id)}/history?${search.toString()}`;
  const result = await fetchControlApi<unknown>(path, config, options);
  if (result.kind !== "ok") return result;
  // `transitions` is the evidence the history panel is entirely made of. A
  // missing list is not an empty history; it is an unreadable response.
  const history: unknown = result.data;
  if (isMemoryHistoryResponse(history)) {
    return { kind: "ok", data: history };
  }
  return invalidMemoryPageResponse(
    "record history",
    "autodev-memory-history-v1"
  );
}

export async function fetchMemoryExperiences(
  params: {
    readonly workspaceId: string;
    readonly repositoryId?: string;
    readonly query?: string;
    readonly memoryMode?: string;
    readonly outcome?: string;
    readonly occurredFrom?: string;
    readonly occurredUntil?: string;
    readonly limit?: number;
    readonly offset?: number;
    readonly includeTaskHistory?: boolean;
  },
  config: ControlApiConfig,
  options: FetchControlApiOptions = {}
): Promise<ControlApiResult<ControlApiMemoryExperiencesResponse>> {
  const search = new URLSearchParams();
  search.set("workspaceId", params.workspaceId);
  if (params.repositoryId) search.set("repositoryId", params.repositoryId);
  if (params.query) search.set("query", params.query);
  if (params.memoryMode) search.set("memoryMode", params.memoryMode);
  if (params.outcome) search.set("outcome", params.outcome);
  if (params.occurredFrom) search.set("occurredFrom", params.occurredFrom);
  if (params.occurredUntil) search.set("occurredUntil", params.occurredUntil);
  if (params.limit !== undefined) search.set("limit", String(params.limit));
  if (params.offset !== undefined) search.set("offset", String(params.offset));
  if (params.includeTaskHistory) search.set("includeTaskHistory", "true");
  const path = `${CONTROL_API_PATHS.memoryExperiences}?${search.toString()}`;
  const result = await fetchControlApi<unknown>(path, config, options);
  if (result.kind !== "ok") return result;
  return isMemoryPageResponse<ControlApiMemoryExperiencesResponse>(
    result.data,
    "autodev-memory-experiences-v1",
    isMemoryExperienceRow
  )
    ? { kind: "ok", data: result.data }
    : invalidMemoryPageResponse("Experiences", "autodev-memory-experiences-v1");
}

export async function fetchMemoryExperienceDetail(
  id: string,
  workspaceId: string,
  config: ControlApiConfig,
  options: FetchControlApiOptions = {}
): Promise<ControlApiResult<ControlApiMemoryExperienceDetailResponse>> {
  const search = new URLSearchParams({
    workspaceId,
    includeTaskHistory: "true"
  });
  const path = `${CONTROL_API_PATHS.memoryExperiences}/${encodeURIComponent(id)}?${search.toString()}`;
  const result = await fetchControlApi<unknown>(path, config, options);
  if (result.kind !== "ok") return result;
  const detail: unknown = result.data;
  if (isMemoryExperienceDetailResponse(detail)) {
    return { kind: "ok", data: detail };
  }
  return invalidMemoryPageResponse(
    "experience detail",
    "autodev-memory-experience-v1"
  );
}

/**
 * The packets actually attached to one experience, and the outcomes separately
 * reported for them.
 *
 * Read-only here on purpose. The Runtime accepts reporter-supplied outcome
 * writes, but an operator interface that let anyone assert a task succeeded is
 * a claim with no evidence behind it; the reporting path stays on the reporter
 * side until the Console can present the injection evidence and the reported
 * outcome as visibly separate things.
 */
export async function fetchMemoryExperienceOutcomes(
  id: string,
  workspaceId: string,
  config: ControlApiConfig,
  options: FetchControlApiOptions = {}
): Promise<ControlApiResult<ControlApiMemoryInjectionOutcomesResponse>> {
  const search = new URLSearchParams({ workspaceId });
  const path = `${CONTROL_API_PATHS.memoryExperiences}/${encodeURIComponent(id)}/outcomes?${search.toString()}`;
  const result = await fetchControlApi<unknown>(path, config, options);
  if (result.kind !== "ok") return result;
  const outcomes: unknown = result.data;
  if (isInjectionOutcomesResponse(outcomes, id)) {
    return { kind: "ok", data: outcomes };
  }
  return invalidMemoryPageResponse(
    "injection outcomes",
    "autodev-memory-injection-outcomes-v1"
  );
}

/** A curator's assessment of whether an injected packet was used. */
export async function fetchMemoryExperienceUseAssessments(
  id: string,
  workspaceId: string,
  config: ControlApiConfig,
  options: FetchControlApiOptions = {}
): Promise<ControlApiResult<ControlApiMemoryInjectionUseAssessmentsResponse>> {
  const search = new URLSearchParams({ workspaceId });
  const path = `${CONTROL_API_PATHS.memoryExperiences}/${encodeURIComponent(id)}/use-assessments?${search.toString()}`;
  const result = await fetchControlApi<unknown>(path, config, options);
  if (result.kind !== "ok") return result;
  const assessments: unknown = result.data;
  if (isInjectionUseAssessmentsResponse(assessments, id)) {
    return { kind: "ok", data: assessments };
  }
  return invalidMemoryPageResponse(
    "injection use assessments",
    "autodev-memory-injection-use-assessments-v1"
  );
}

function isMemorySessionOutcomeResponse(
  value: unknown,
  experienceId: string
): value is ControlApiMemorySessionOutcomeReportResponse {
  if (
    !isRecord(value) ||
    value.schema !== "autodev-memory-session-outcome-report-v1" ||
    // Compared, not merely present: a response naming a different experience is
    // not "no outcome yet" for this one, it is the wrong answer.
    value.experienceId !== experienceId ||
    !isRecord(value.report)
  ) {
    return false;
  }
  const report = value.report;
  return (
    typeof report.outcomeKind === "string" &&
    typeof report.reportKind === "string" &&
    typeof report.reporterId === "string" &&
    typeof report.reportedAt === "string" &&
    typeof report.reasonCode === "string" &&
    Array.isArray(report.evidence) &&
    report.evidence.every(
      (entry) =>
        isRecord(entry) &&
        typeof entry.kind === "string" &&
        typeof entry.uri === "string"
    )
  );
}

export async function fetchMemoryExperienceSessionOutcome(
  id: string,
  workspaceId: string,
  config: ControlApiConfig,
  options: FetchControlApiOptions = {}
): Promise<ControlApiResult<ControlApiMemorySessionOutcomeReportResponse>> {
  const search = new URLSearchParams({
    workspaceId,
    includeTaskHistory: "true"
  });
  const path = `${CONTROL_API_PATHS.memoryExperiences}/${encodeURIComponent(id)}/session-outcomes?${search.toString()}`;
  const result = await fetchControlApi<unknown>(path, config, options);
  if (result.kind !== "ok") return result;
  if (isMemorySessionOutcomeResponse(result.data, id)) {
    return { kind: "ok", data: result.data };
  }
  return invalidMemoryPageResponse(
    "session outcome report",
    "autodev-memory-session-outcome-report-v1"
  );
}

export async function fetchMemoryCohorts(
  params: {
    readonly workspaceId: string;
    readonly repositoryId: string;
    readonly occurredFrom: string;
    readonly occurredUntil: string;
    readonly memoryModes?: readonly string[];
    readonly injectionResults?: readonly string[];
    readonly reportKinds?: readonly string[];
    readonly outcomeKinds?: readonly string[];
  },
  config: ControlApiConfig,
  options: FetchControlApiOptions = {}
): Promise<ControlApiResult<ControlApiMemoryCohortsResponse>> {
  const search = new URLSearchParams();
  search.set("workspaceId", params.workspaceId);
  search.set("repositoryId", params.repositoryId);
  search.set("includeTaskHistory", "true");
  search.set("occurredFrom", params.occurredFrom);
  search.set("occurredUntil", params.occurredUntil);
  if (params.memoryModes)
    params.memoryModes.forEach((m) => search.append("memoryMode", m));
  if (params.injectionResults)
    params.injectionResults.forEach((r) => search.append("injectionResult", r));
  if (params.reportKinds)
    params.reportKinds.forEach((k) => search.append("reportKind", k));
  if (params.outcomeKinds)
    params.outcomeKinds.forEach((k) => search.append("outcomeKind", k));
  const path = `${CONTROL_API_PATHS.memorySessionCohorts}?${search.toString()}`;
  const result = await fetchControlApi<unknown>(path, config, options);
  if (result.kind !== "ok") return result;
  return isSessionOutcomeCohortPage(result.data)
    ? { kind: "ok", data: result.data }
    : invalidMemoryPageResponse(
        "Outcome Cohorts",
        "autodev-memory-session-outcome-cohorts-v1"
      );
}

export async function fetchMemoryUseCohorts(
  params: {
    readonly workspaceId: string;
    readonly repositoryId: string;
    readonly occurredFrom: string;
    readonly occurredUntil: string;
    /**
     * The use-cohort reads accept a narrower vocabulary than the outcome
     * cohorts do: only the modes a cohort can actually be assigned are
     * eligible, so a mode the outcome cohorts allow (`invalid`, `unknown`) is
     * refused here rather than silently ignored.
     */
    readonly memoryModes?: readonly string[];
    readonly useKinds?: readonly string[];
  },
  config: ControlApiConfig,
  options: FetchControlApiOptions = {}
): Promise<ControlApiResult<ControlApiMemoryUseCohortsResponse>> {
  const search = new URLSearchParams();
  search.set("workspaceId", params.workspaceId);
  search.set("repositoryId", params.repositoryId);
  search.set("includeTaskHistory", "true");
  search.set("occurredFrom", params.occurredFrom);
  search.set("occurredUntil", params.occurredUntil);
  if (params.memoryModes)
    params.memoryModes.forEach((m) => search.append("memoryMode", m));
  if (params.useKinds)
    params.useKinds.forEach((k) => search.append("useKind", k));
  const path = `${CONTROL_API_PATHS.memoryUseCohorts}?${search.toString()}`;
  const result = await fetchControlApi<unknown>(path, config, options);
  if (result.kind !== "ok") return result;
  return isInjectionUseCohortPage(result.data)
    ? { kind: "ok", data: result.data }
    : invalidMemoryPageResponse(
        "injection-use cohorts",
        "autodev-memory-injection-use-cohorts-v1"
      );
}

/**
 * Apply one lifecycle transition to a durable record.
 *
 * Each action has its *own* body, and the Runtime rejects the whole request if
 * it carries a key that action does not read (`exactKeys` on the way in). The
 * body this used to forward was the caller's payload verbatim — including
 * `workspaceId`, which already travels in the query string, and a free-text
 * `reason` that none of these actions read. Every record transition therefore
 * came back `400 autodev_memory_invalid_request`, so verify, invalidate and
 * revise were unreachable from the Console.
 *
 * The shapes below are the Runtime's, not this file's: research-backed actions
 * take `task` and `query`, invalidation takes a bounded `reasonCode` plus
 * evidence, and a revision takes the replacement `claim`, the experiences it
 * derives from, and evidence. The names are per-action so a caller cannot
 * assemble a body that is valid for a different one.
 */
export function transitionMemoryRecord<
  Action extends ControlApiMemoryRecordTransitionAction
>(
  id: string,
  action: Action,
  payload: ControlApiMemoryRecordActionPayload<Action>,
  config: ControlApiConfig,
  options: FetchControlApiOptions = {}
): Promise<ControlApiResult<{ readonly memory: unknown }>> {
  const search = new URLSearchParams({ workspaceId: payload.workspaceId });
  const path = `${CONTROL_API_PATHS.memoryRecords}/${encodeURIComponent(id)}/${action}?${search.toString()}`;
  // `workspaceId` is scope, not body: it is already in the query, and the
  // Runtime treats an unexpected body key as a malformed request.
  const { workspaceId: _scope, ...body } = payload;
  return postControlApi<{ readonly memory: unknown }>(
    path,
    body,
    config,
    options
  );
}

/**
 * Erase a raw experience envelope.
 *
 * Purge is irreversible and narrow: the Runtime erases only the raw envelope
 * and refuses while any durable memory cites it (conflict), so the caller must
 * be ready to surface that refusal rather than retry. The reason is not free-form
 * — the Runtime accepts exactly these two codes and rejects anything else.
 */
export type ControlApiMemoryPurgeReason = MemoryExperiencePurgeReason;

export function purgeMemoryExperience(
  id: string,
  reason: ControlApiMemoryPurgeReason,
  payload: {
    readonly workspaceId: string;
  },
  config: ControlApiConfig,
  options: FetchControlApiOptions = {}
): Promise<ControlApiResult<unknown>> {
  const search = new URLSearchParams({ workspaceId: payload.workspaceId });
  const path = `${CONTROL_API_PATHS.memoryExperiences}/${encodeURIComponent(id)}/purge?${search.toString()}`;
  return postControlApi<unknown>(path, { reason }, config, options);
}

/**
 * Report an outcome against one observed injection.
 *
 * The Runtime takes `exactKeys` on this body, so the Console sends exactly
 * `{correlationToken, outcomeKind, reportKind, evidence}` and nothing else --
 * not the operator, not a timestamp, not a verdict. `reporterId` and
 * `reporterAuthority` come from the authenticated session, because a report
 * that names its own author is not evidence of anything.
 */
export function reportMemoryExperienceOutcome(
  id: string,
  payload: {
    readonly workspaceId: string;
    readonly correlationToken: string;
    readonly outcomeKind: string;
    readonly reportKind: string;
    readonly evidence: readonly {
      readonly kind: string;
      readonly uri: string;
      readonly revision?: string;
    }[];
  },
  config: ControlApiConfig,
  options: FetchControlApiOptions = {}
): Promise<ControlApiResult<unknown>> {
  const search = new URLSearchParams({ workspaceId: payload.workspaceId });
  const path = `${CONTROL_API_PATHS.memoryExperiences}/${encodeURIComponent(id)}/outcomes?${search.toString()}`;
  return postControlApi<unknown>(
    path,
    {
      correlationToken: payload.correlationToken,
      outcomeKind: payload.outcomeKind,
      reportKind: payload.reportKind,
      evidence: payload.evidence
    },
    config,
    options
  );
}

/**
 * Report how one session as a whole went.
 *
 * A different claim from the injection outcome above, with a different body: the
 * Runtime binds a session outcome to the session rather than to one injected
 * packet, so there is no correlation token to name, and it takes `exactKeys` on
 * `{outcomeKind, reportKind, evidence}`. The session identity comes from the
 * captured experience, never from the request, so a caller cannot report an
 * outcome against a session it did not run.
 *
 * Exactly one report may exist per session, and filing a *different* one for a
 * session that already has an outcome is a conflict rather than a replacement:
 * the Runtime treats the first report as the record and refuses the second. The
 * Console therefore does not offer this form for a session that already has an
 * outcome, rather than inviting a submission that will come back 409.
 */
export function reportMemoryExperienceSessionOutcome(
  id: string,
  payload: {
    readonly workspaceId: string;
    readonly outcomeKind: string;
    readonly reportKind: string;
    readonly evidence: readonly {
      readonly kind: string;
      readonly uri: string;
      readonly revision?: string;
    }[];
  },
  config: ControlApiConfig,
  options: FetchControlApiOptions = {}
): Promise<ControlApiResult<unknown>> {
  const query = new URLSearchParams({
    workspaceId: payload.workspaceId,
    includeTaskHistory: "true"
  });
  const path = `${CONTROL_API_PATHS.memoryExperiences}/${encodeURIComponent(id)}/session-outcome?${query.toString()}`;
  return postControlApi<unknown>(
    path,
    {
      outcomeKind: payload.outcomeKind,
      reportKind: payload.reportKind,
      evidence: payload.evidence
    },
    config,
    options
  );
}

/**
 * A curator's assessment of whether an injected packet was used.
 *
 * `useKind` and `usedMemoryIds` are the whole claim, and the Runtime holds them
 * to their own rules: a `used` verdict must cite every injected id, a
 * `partially_used` a strict non-empty subset, and `not_used`/`unobservable`
 * none. A curator cannot simply assert "not used" over memories it never cites.
 */
export function reportMemoryInjectionUse(
  id: string,
  payload: {
    readonly workspaceId: string;
    readonly injectionEventId: string;
    readonly useKind: string;
    readonly usedMemoryIds: readonly string[];
    readonly evidence: readonly {
      readonly kind: string;
      readonly uri: string;
      readonly revision?: string;
    }[];
  },
  config: ControlApiConfig,
  options: FetchControlApiOptions = {}
): Promise<ControlApiResult<unknown>> {
  const search = new URLSearchParams({ workspaceId: payload.workspaceId });
  const path = `${CONTROL_API_PATHS.memoryExperiences}/${encodeURIComponent(id)}/use-assessments?${search.toString()}`;
  return postControlApi<unknown>(
    path,
    {
      injectionEventId: payload.injectionEventId,
      useKind: payload.useKind,
      usedMemoryIds: payload.usedMemoryIds,
      evidence: payload.evidence
    },
    config,
    options
  );
}

export function promoteMemoryProcedureToSkill(
  payload: ControlApiMemoryRecordActionPayload<"promote-skill">,
  config: ControlApiConfig,
  options: FetchControlApiOptions = {}
): Promise<ControlApiResult<{ readonly skill: unknown }>> {
  const search = new URLSearchParams({ workspaceId: payload.workspaceId });
  const path = `${CONTROL_API_PATHS.memoryPromoteSkill}?${search.toString()}`;
  // `workspaceId` is scope, not body: the Runtime rejects an unexpected key.
  const { workspaceId: _scope, ...body } = payload;
  return postControlApi<{ readonly skill: unknown }>(
    path,
    body,
    config,
    options
  );
}
