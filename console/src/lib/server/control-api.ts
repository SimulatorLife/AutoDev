/**
Server-only typed fetcher for the AutoDev Control API.

This module is the single owner of the service credential and the canonical
local actor identity used by the Console. It MUST only be imported by
Server Components, Server Actions, or other server-only code paths.

- The service token is read from `process.env.AUTODEV_CONTROL_API_TOKEN`.
  It is never serialized to a client payload, log line, or error message.
- The actor header is the canonical `LOCAL_CONTROL_API_ACTOR` exported by
  `@simulatorlife/autodev-core`. It is never read from any browser-supplied
  header or query parameter.

If the upstream Control API is unavailable, this module returns a
discriminated `ControlApiResult` so the UI can render a clear unavailable
state instead of fabricating values.
*/
import nodePath from "node:path";

import {
  CHATGPT_TUNNEL_CONTROL_PATH,
  type ChatgptTunnelStatus,
  chatgptTunnelStatusSchema
} from "@simulatorlife/autodev-core";
import {
  CONTROL_API_REVISION_PATTERN,
  type ControlApiAgentDetailResponse,
  controlApiAgentDetailResponseSchema,
  type ControlApiAgentEnablementPatchRequest,
  type ControlApiAgentEnablementPatchResponse,
  controlApiAgentEnablementPatchResponseSchema,
  type ControlApiAgentsResponse,
  controlApiAgentsResponseSchema,
  type ControlApiConcurrencyPatchRequest,
  type ControlApiConcurrencyPatchResponse,
  controlApiConcurrencyPatchResponseSchema,
  type ControlApiError,
  type ControlApiEvaluationsResponse,
  CONTROL_API_GITHUB_SCHEMA_ID,
  type ControlApiGithubResponse,
  controlApiGithubResponseSchema,
  type ControlApiHooksAppliedResponse,
  type ControlApiHooksResponse,
  type ControlApiMcpAppliedResponse,
  controlApiMcpAppliedResponseSchema,
  type ControlApiMcpRuntimeResponse,
  controlApiMcpRuntimeResponseSchema,
  type ControlApiMcpServerPatchRequest,
  type ControlApiMcpServerPatchResponse,
  controlApiMcpServerPatchResponseSchema,
  type ControlApiMcpsResponse,
  controlApiMcpsResponseSchema,
  type ControlApiModelPatchResponse,
  controlApiModelPatchResponseSchema,
  type ControlApiModelsResponse,
  controlApiModelsResponseSchema,
  type ControlApiPermissionsResponse,
  type ControlApiPromptDetailResponse,
  type ControlApiPromptsResponse,
  type ControlApiPromptVersionResponse,
  type ControlApiPromptVersionsResponse,
  type ControlApiProviderAgentLimits,
  type ControlApiProviderAgentModelPatchResponse,
  controlApiProviderAgentModelPatchResponseSchema,
  type ControlApiProviderCheckResponse,
  controlApiProviderCheckResponseSchema,
  type ControlApiProviderEnabledPatchResponse,
  controlApiProviderEnabledPatchResponseSchema,
  type ControlApiProviderLimitsPatchResponse,
  controlApiProviderLimitsPatchResponseSchema,
  type ControlApiProviderModelsResponse,
  CONTROL_API_EVALUATIONS_SCHEMA_ID,
  controlApiEvaluationsResponseSchema,
  controlApiHooksAppliedResponseSchema,
  controlApiHooksResponseSchema,
  controlApiPermissionsResponseSchema,
  controlApiPromptDetailResponseSchema,
  controlApiPromptsResponseSchema,
  controlApiPromptVersionResponseSchema,
  controlApiPromptVersionsResponseSchema,
  controlApiProviderModelsResponseSchema,
  type ControlApiProviderRolePatchResponse,
  controlApiProviderRolePatchResponseSchema,
  type ControlApiProvidersResetRequest,
  type ControlApiProvidersResetResponse,
  controlApiProvidersResetResponseSchema,
  type ControlApiProvidersResponse,
  controlApiProvidersResponseSchema,
  type ControlApiProviderVersionsResponse,
  controlApiProviderVersionsResponseSchema,
  type ControlApiRuntimeResponse,
  controlApiRuntimeResponseSchema,
  type ControlApiSkillContentResponse,
  controlApiSkillContentResponseSchema,
  type ControlApiSkillsResponse,
  controlApiSkillsResponseSchema,
  CONTROL_API_TOOLS_SCHEMA_ID,
  type ControlApiToolsResponse,
  type ControlApiWorkspacePatchRequest,
  type ControlApiWorkspacePatchResponse,
  controlApiWorkspacePatchResponseSchema,
  type ControlApiWorkspacePlaytestApprovalResponse,
  controlApiWorkspacePlaytestApprovalResponseSchema,
  type ControlApiWorkspacesResponse,
  controlApiWorkspacesResponseSchema,
  type ControlApiWorkspaceVisualPlaytestTargetsResponse,
  controlApiWorkspaceVisualPlaytestTargetsResponseSchema,
  isControlApiToolsResponse,
  isRecord,
  isSessionDiagnosticsReport,
  isSessionFleetScanResponse,
  isSessionHookDenialsResponse,
  LOCAL_CONTROL_API_ACTOR,
  type ProviderRole,
  type ProviderRolePriority,
  type SessionDiagnosticsReport,
  type SessionFleetScanResponse,
  type SessionHookDenialsResponse
} from "@simulatorlife/autodev-core";
import {
  DelegateBackoff,
  handleWhen,
  retry,
  TaskCancelledError,
  timeout,
  TimeoutStrategy,
  wrap
} from "cockatiel";

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
      The read was abandoned at the Console's own deadline rather than refused
      by the service.
      
      Additive and optional, so every consumer that branches on
      `kind === "unreachable"` is unaffected -- but it is the difference
      between two materially different facts. Measured in Chromium against a
      Control API fixture that accepts the request and never answers: the page
      settled on `autodev_unreachable` carrying the browser's own `AbortError`
      text, "This operation was aborted", followed by the advice to configure
      the server-side integration. None of which is true. The service was
      reachable -- it is holding the connection open -- and the operator's
      next move is to look at why the query is slow, not to reconfigure a
      credential that is working.
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
Playtesting reads and writes are answered by the Control API's
ClickHouse-backed store. Measured against the live Control API, one
playtesting read takes 1-3 seconds on its own, and the playtesting page
fans five of them out in parallel, so the generic 5-second Control API
deadline expires against a service that is answering normally. The
GitHub projection already carries its own budget for the same reason.
*/
export const PLAYTESTING_CONTROL_API_TIMEOUT_MS = 20_000;
const INVALID_RESPONSE_KIND = "invalid-response" as const;
const PROMPT_VERSION_TIMEOUT_MS = 12_000;
const TRAILING_SLASHES = /\/+$/u;

export interface ControlApiConfig {
  readonly baseUrl: string;
  readonly serviceToken: string;
}

export function readControlApiConfig(
  environment: NodeJS.ProcessEnv = process.env
): ControlApiConfig | null {
  let serviceToken = environment.AUTODEV_CONTROL_API_TOKEN?.trim() ?? "";
  if (!serviceToken) {
    const home = environment.HOME?.trim();
    const codexHome =
      environment.CODEX_HOME?.trim() ||
      (home ? nodePath.join(home, ".codex") : null);
    if (codexHome) {
      const secretFile =
        environment.AUTODEV_OPENLIT_SECRET_FILE?.trim() ||
        nodePath.join(codexHome, "openlit-secrets.env");
      serviceToken =
        readSecretFromFile(secretFile, "AUTODEV_CONTROL_API_TOKEN") ?? "";
    }
  }
  if (!serviceToken) return null;
  const baseUrl =
    environment.AUTODEV_CONTROL_API_BASE_URL?.trim() ||
    DEFAULT_CONTROL_API_BASE_URL;
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
Issues an authenticated GET against the AutoDev Control API.

Never accepts a `headers` argument; the only headers sent are the canonical
service credential and the canonical local actor identity. No browser header
is ever forwarded.
*/
/**
Transport failures as a sentence an operator can act on, keyed by the standard
cause code the platform reports.

`fetch` itself is no use as a diagnostic: every one of these arrives as
`TypeError: fetch failed`, which says that something failed and nothing about
what. What separates them is `error.cause.code` -- `ECONNREFUSED` against a
Control API that is not running, `ENOTFOUND` against a host that does not
resolve, `ECONNRESET` against one that accepted the connection and dropped it
-- and each points at a different thing to check.

`cause.message` is deliberately not forwarded. It reads
"connect ECONNREFUSED 127.0.0.1:4101", which puts the configured Control API
address into a browser-rendered panel. The errno name is a stable standard
identifier and carries the same diagnostic value without the address.

An unrecognised code is still named rather than dropped: a cause the Console
has not seen before is more informative than a sentence that claims to be the
whole story.
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
The one place a request that never completed is turned into a result.

Reads and writes share this classifier, so a timeout or transport error is
reported the same way whichever request failed.
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

function isRetryableNetworkError(error: unknown): boolean {
  const cause = (error as { readonly cause?: unknown } | null | undefined)
    ?.cause;
  const code = (cause as { readonly code?: unknown } | null | undefined)?.code;
  return typeof code === "string" && RETRYABLE_NETWORK_CODES.has(code);
}

/**
The one deadline-and-retry policy for Control API requests.

The Console's own deadline wraps the whole request, retries included, and
its signal -- which also follows a caller-supplied abort -- is the one every
attempt hands to `fetch`. A caller's signal therefore only ever ends a
request sooner: it can never replace the deadline, so a page waiting on the
read always gets an explicit result.

`maxRetries` counts retries after the first attempt. Only transport codes in
`RETRYABLE_NETWORK_CODES` are retried (never an abort, never a service
answer), waiting `retryDelayMs` times the retry number between attempts.
Mutations pass no retries and so run under the deadline alone.
*/
async function executeControlApiRequest<T>(
  attempt: (signal: AbortSignal) => Promise<ControlApiResult<T>>,
  options: FetchControlApiOptions,
  maxRetries: number
): Promise<ControlApiResult<T>> {
  const timeoutMs = options.timeoutMs ?? CONTROL_API_TIMEOUT_MS;
  const deadline = timeout(timeoutMs, TimeoutStrategy.Aggressive);
  const policy =
    maxRetries > 0
      ? wrap(
          deadline,
          retry(handleWhen(isRetryableNetworkError), {
            maxAttempts: maxRetries,
            backoff: new DelegateBackoff(
              ({ attempt: retryNumber }) =>
                (options.retryDelayMs ?? 100) * retryNumber
            )
          })
        )
      : deadline;
  try {
    return await policy.execute(
      ({ signal }) => attempt(signal),
      options.signal
    );
  } catch (error) {
    // The deadline is read off the policy's own error rather than off the
    // transport error: an abort surfaces as a `DOMException` whose message is a
    // browser implementation detail ("This operation was aborted"), and
    // forwarding that says nothing about the operator's system. A caller that
    // gave up is not the Console's deadline.
    const isAbortedByDeadline =
      error instanceof TaskCancelledError && !options.signal?.aborted;
    return transportFailure(error, isAbortedByDeadline, timeoutMs);
  }
}

/**
A Control API response as a result: the parsed body, or the service's refusal.
*/
async function readControlApiJsonResponse<T>(
  response: Response
): Promise<ControlApiResult<T>> {
  if (!response.ok) return readControlApiFailure(response);
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

export function fetchControlApi<T>(
  path: string,
  config: ControlApiConfig,
  options: FetchControlApiOptions = {}
): Promise<ControlApiResult<T>> {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  return executeControlApiRequest<T>(
    async (signal) => {
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

      return readControlApiJsonResponse<T>(response);
    },
    options,
    options.maxRetries ?? 2
  );
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
Authenticated, bounded image read for an episode-linked Playtesting frame.
Only the fixed local Control API route and inert raster image types are
accepted; the service credential never reaches the browser.
*/
export function fetchControlApiBinary(
  path: string,
  config: ControlApiConfig,
  options: FetchControlApiOptions = {}
): Promise<ControlApiResult<ControlApiBinaryData>> {
  if (!validPlaytestFramePath(path)) {
    return Promise.resolve({
      kind: INVALID_RESPONSE_KIND,
      code: "autodev_control_api_invalid_playtesting_frame_path",
      message: "The Console refused an invalid Playtesting frame path."
    });
  }
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  return executeControlApiRequest(
    (signal) => readControlApiBinaryFrame(fetchImpl, path, config, signal),
    options,
    options.maxRetries ?? 2
  );
}

/**
The media type of a Playtesting frame, or `null` when the Control API
returned a type the Console will not display.
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

/**
True when the declared content length already exceeds the display bound.
*/
function exceedsBinaryResponseLimit(contentLength: string | null): boolean {
  return (
    contentLength !== null &&
    CONTENT_LENGTH_PATTERN.test(contentLength) &&
    Number(contentLength) > BINARY_RESPONSE_MAX_BYTES
  );
}

/**
The result for a frame body that could not be read within the bound.
*/
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
One attempt at reading a Playtesting frame: the request, the type and size
guards, and the bounded body read.
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
Sends a typed server-side Control API mutation using the shared credential,
actor, timeout, and error-envelope handling.
*/
function mutateControlApi<T>(
  method: "POST" | "PATCH",
  path: string,
  payload: unknown,
  config: ControlApiConfig,
  options: FetchControlApiOptions = {}
): Promise<ControlApiResult<T>> {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  // A write is never retried: it runs under the Console's deadline alone.
  return executeControlApiRequest<T>(
    async (signal) => {
      const response = await fetchImpl(config.baseUrl + path, {
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
      return readControlApiJsonResponse<T>(response);
    },
    options,
    0
  );
}

interface ControlApiSchemaParser<T> {
  safeParse(
    value: unknown
  ): { readonly success: true; readonly data: T } | { readonly success: false };
}

/**
Executes a Control API mutation and validates the response against the owning
Core Zod schema before returning `kind: "ok"`, failing closed if the payload
does not match.
*/
async function mutateValidatedControlApi<T>(
  method: "POST" | "PATCH",
  path: string,
  payload: unknown,
  schema: ControlApiSchemaParser<T>,
  invalid: {
    readonly what: string;
    readonly contract: string;
    readonly code: string;
  },
  config: ControlApiConfig,
  options: FetchControlApiOptions = {}
): Promise<ControlApiResult<T>> {
  const result = await mutateControlApi<unknown>(
    method,
    path,
    payload,
    config,
    options
  );
  if (result.kind !== "ok") return result;
  const parsed = schema.safeParse(result.data);
  return parsed.success
    ? { kind: "ok", data: parsed.data }
    : invalidResponse(invalid.what, invalid.contract, invalid.code);
}

/**
Issues an authenticated POST against the AutoDev Control API.
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
  providerVersions: "/control/provider-versions",
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
  diagnostics: "/control/diagnostics"
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
  const parsed = controlApiAgentsResponseSchema.safeParse(result.data);
  if (parsed.success) {
    return { kind: "ok", data: parsed.data };
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
  const parsed = controlApiAgentDetailResponseSchema.safeParse(result.data);
  if (parsed.success) {
    return { kind: "ok", data: parsed.data };
  }
  return {
    kind: INVALID_RESPONSE_KIND,
    code: "autodev_control_api_invalid_agent_detail_response",
    message:
      "AutoDev Control API returned an incompatible Agent detail response; the Console requires the v3 agent detail contract."
  };
}

/**
Server-only typed mutation for Runtime-owned Agent role enablement.
*/
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
  const parsed = controlApiAgentEnablementPatchResponseSchema.safeParse(
    result.data
  );
  if (parsed.success && parsed.data.role === canonicalRole) {
    return { kind: "ok", data: parsed.data };
  }
  return {
    kind: INVALID_RESPONSE_KIND,
    code: "autodev_control_api_invalid_agent_enablement_response",
    message:
      "AutoDev Control API returned an incompatible Agent enablement response; the Console requires the v1 Agent enablement contract."
  };
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
  const parsed = controlApiProvidersResponseSchema.safeParse(result.data);
  if (parsed.success) {
    return { kind: "ok", data: parsed.data };
  }
  return {
    kind: INVALID_RESPONSE_KIND,
    code: "autodev_control_api_invalid_providers_response",
    message:
      "AutoDev Control API returned an incompatible Providers response; the Console requires the v5 provider contract."
  };
}

/**
Builds the canonical provider-role PATCH path with an encoded provider
segment. This remains private to the typed server mutation below.
*/
function providerRoleControlPath(provider: string, role: ProviderRole): string {
  return `${CONTROL_API_PATHS.providers}/${encodeURIComponent(
    provider
  )}/roles/${encodeURIComponent(role)}`;
}

/**
Server-only typed PATCH against the canonical provider-role route. The
Console never sends provider-role mutations directly from the browser; the
provider-role route handler invokes this helper with the server-side
Control API credential and the canonical local actor header.
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
  return mutateValidatedControlApi(
    "PATCH",
    providerRoleControlPath(provider, role),
    {
      priority: assignment.priority,
      model: assignment.model,
      ...(assignment.reasoningEffort !== undefined && {
        reasoningEffort: assignment.reasoningEffort
      })
    },
    controlApiProviderRolePatchResponseSchema,
    {
      what: "provider role mutation",
      contract: "autodev-control-provider-role-v3",
      code: "autodev_control_api_invalid_provider_role_response"
    },
    config,
    options
  );
}

/**
Server-only typed PATCH of one agent role's model preference on a provider;
`null` returns the role to its tier's model.
*/
export function patchAgentModel(
  provider: string,
  role: string,
  model: string | null,
  config: ControlApiConfig,
  options: FetchControlApiOptions = {}
): Promise<ControlApiResult<ControlApiProviderAgentModelPatchResponse>> {
  return mutateValidatedControlApi(
    "PATCH",
    `${CONTROL_API_PATHS.providers}/${encodeURIComponent(
      provider
    )}/agents/${encodeURIComponent(role)}`,
    { model },
    controlApiProviderAgentModelPatchResponseSchema,
    {
      what: "provider agent-model mutation",
      contract: "autodev-control-provider-agent-model-v1",
      code: "autodev_control_api_invalid_provider_agent_model_response"
    },
    config,
    options
  );
}

/**
Server-only typed reset of Runtime-owned provider overrides. The Console
sends no routing configuration or credential data; Runtime clears only its
operator overlay and reads the static routing source as the default.
*/
export function resetProviderSettings(
  config: ControlApiConfig,
  options: FetchControlApiOptions = {}
): Promise<ControlApiResult<ControlApiProvidersResetResponse>> {
  const body: ControlApiProvidersResetRequest = { confirm: true };
  return mutateValidatedControlApi(
    "POST",
    `${CONTROL_API_PATHS.providers}/reset`,
    body,
    controlApiProvidersResetResponseSchema,
    {
      what: "provider settings reset",
      contract: "autodev-control-providers-reset-v1",
      code: "autodev_control_api_invalid_providers_reset_response"
    },
    config,
    options
  );
}

/**
Server-only typed PATCH for a provider's agent limits. `null` on either axis
means Unlimited, which is a decision the operator made, so the Console sends
both keys on every change rather than omitting an axis it is not touching.
*/
export function patchProviderLimits(
  provider: string,
  agentLimits: ControlApiProviderAgentLimits,
  config: ControlApiConfig,
  options: FetchControlApiOptions = {}
): Promise<ControlApiResult<ControlApiProviderLimitsPatchResponse>> {
  return mutateValidatedControlApi(
    "PATCH",
    providerControlPath(provider, "limits"),
    {
      perSession: agentLimits.perSession,
      acrossSessions: agentLimits.acrossSessions
    },
    controlApiProviderLimitsPatchResponseSchema,
    {
      what: "provider limits mutation",
      contract: "autodev-control-provider-limits-v1",
      code: "autodev_control_api_invalid_provider_limits_response"
    },
    config,
    options
  );
}

/**
Server-only typed PATCH enabling or disabling a provider globally. Runtime
preserves the provider's roles and limits across the change, so the Console
sends only the flag.
*/
export function patchProviderEnabled(
  provider: string,
  disabled: boolean,
  config: ControlApiConfig,
  options: FetchControlApiOptions = {}
): Promise<ControlApiResult<ControlApiProviderEnabledPatchResponse>> {
  return mutateValidatedControlApi(
    "PATCH",
    providerControlPath(provider),
    { disabled },
    controlApiProviderEnabledPatchResponseSchema,
    {
      what: "provider enablement mutation",
      contract: "autodev-control-provider-enabled-v1",
      code: "autodev_control_api_invalid_provider_enabled_response"
    },
    config,
    options
  );
}

/**
Server-only typed POST re-checking one provider: Runtime runs its live probe
and model listing and answers with the check and the provider's health after
it. The request carries no settings.
*/
export function checkProvider(
  provider: string,
  config: ControlApiConfig,
  options: FetchControlApiOptions = {}
): Promise<ControlApiResult<ControlApiProviderCheckResponse>> {
  return mutateValidatedControlApi(
    "POST",
    providerControlPath(provider, "check"),
    {},
    controlApiProviderCheckResponseSchema,
    {
      what: "provider check",
      contract: "autodev-control-provider-check-v1",
      code: "autodev_control_api_invalid_provider_check_response"
    },
    config,
    options
  );
}

/**
Builds the canonical provider-scoped PATCH path with an encoded provider
segment. This remains private to the typed server mutations below.

Sub-segments are joined here rather than by the caller. Passing `"limits"`
produced `/control/providers/claudelimits`, which still matched the
single-provider route — `claudelimits` is a legal provider id — so the
request came back as an unknown-provider 404 instead of a routing error, and
every agent-limits mutation failed while the controls looked correct. The
separator belongs to whoever assembles the path.
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
  const parsed = controlApiModelsResponseSchema.safeParse(result.data);
  if (parsed.success) {
    return { kind: "ok", data: parsed.data };
  }
  return {
    kind: INVALID_RESPONSE_KIND,
    code: "autodev_control_api_invalid_models_response",
    message:
      "AutoDev Control API returned an incompatible Models response; the Console requires the v2 model contract."
  };
}

/**
Reads the versions of the CLIs the Runtime found on this machine.

The versions are their own response rather than a field on the provider
record, so a Runtime that does not publish them still answers the providers
contract, and the page reports the version as not observed instead of
failing over a missing release number.
*/
export async function fetchProviderVersions(
  config: ControlApiConfig,
  options: FetchControlApiOptions = {}
): Promise<ControlApiResult<ControlApiProviderVersionsResponse>> {
  const result = await fetchControlApi<unknown>(
    CONTROL_API_PATHS.providerVersions,
    config,
    options
  );
  if (result.kind !== "ok") return result;
  const parsed = controlApiProviderVersionsResponseSchema.safeParse(
    result.data
  );
  if (parsed.success) {
    return { kind: "ok", data: parsed.data };
  }
  return {
    kind: INVALID_RESPONSE_KIND,
    code: "autodev_control_api_invalid_provider_versions_response",
    message:
      "AutoDev Control API returned an incompatible provider-versions response; the Console requires the v1 observed/unavailable contract."
  };
}

/**
Reads Runtime-owned provider availability without inventing a catalog.
*/
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
  const parsed = controlApiProviderModelsResponseSchema.safeParse(result.data);
  if (parsed.success) {
    return { kind: "ok", data: parsed.data };
  }
  return {
    kind: INVALID_RESPONSE_KIND,
    code: "autodev_control_api_invalid_provider_model_discovery_response",
    message:
      "AutoDev Control API returned an incompatible provider-model discovery response; the Console requires the v1 observed/stale/unavailable contract."
  };
}

/**
Server-only typed PATCH against the canonical model enablement route,
invoked by the Console model route handler with the server credential.
*/
export function patchModel(
  model: string,
  enabled: boolean,
  config: ControlApiConfig,
  options: FetchControlApiOptions = {}
): Promise<ControlApiResult<ControlApiModelPatchResponse>> {
  return mutateValidatedControlApi(
    "PATCH",
    `${CONTROL_API_PATHS.models}/${encodeURIComponent(model)}`,
    { enabled },
    controlApiModelPatchResponseSchema,
    {
      what: "model enablement mutation",
      contract: "autodev-control-model-v1",
      code: "autodev_control_api_invalid_model_response"
    },
    config,
    options
  );
}

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

/**
Narrows the remaining catalog collections.

These all share one failure mode: an unreadable response reached the view as
an empty collection, and an empty collection is a claim — "no MCP servers are
configured", "no tools are exposed" — that a shape the Console cannot read
does not support. Each predicate checks the envelope the view actually
renders rather than restating every nested Core type.
*/
/**
Narrows one target override. Overrides are a list of records, not a string
list: each entry names a target and carries its own enablement. Checking them
with `isStringList` rejects every well-formed catalog, which is how this
route spent a while failing closed against correct data.
*/
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
  const parsed = controlApiMcpsResponseSchema.safeParse(result.data);
  return parsed.success
    ? { kind: "ok", data: parsed.data }
    : invalidResponse("Mcps", "autodev-control-mcps-v3");
}

/**
Reads the Runtime's observation of the MCP servers it has seen.

This is a second read, not a wider one: the catalog stays the configuration
read, and the observation arrives on its own path so that a page can compose
the two without the contract claiming that a declared server was reached.
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
  const parsed = controlApiMcpRuntimeResponseSchema.safeParse(result.data);
  return parsed.success
    ? { kind: "ok", data: parsed.data }
    : invalidResponse("McpRuntime", "autodev-control-mcp-runtime-v1");
}

/**
Reads the MCP configuration the Runtime applied, against the canonical
declaration.

The third MCP read, and the third question: the catalog says what is
declared, the runtime read says what the Runtime has reached, and this one
says what the Runtime actually applied. The page composes them; the
contract keeps them apart.
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
  const parsed = controlApiMcpAppliedResponseSchema.safeParse(result.data);
  return parsed.success
    ? { kind: "ok", data: parsed.data }
    : invalidResponse("McpApplied", "autodev-control-mcp-applied-v3");
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
    : invalidResponse("Tools", CONTROL_API_TOOLS_SCHEMA_ID);
}

/**
Server-only typed mutation for orchestrator concurrency limit.
*/
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
  const parsed = controlApiConcurrencyPatchResponseSchema.safeParse(
    result.data
  );
  if (parsed.success) {
    return { kind: "ok", data: parsed.data };
  }
  return {
    kind: INVALID_RESPONSE_KIND,
    code: "autodev_control_api_invalid_concurrency_response",
    message:
      "AutoDev Control API returned an incompatible concurrency response; the Console requires the v1 concurrency contract."
  };
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
  const parsed = controlApiSkillsResponseSchema.safeParse(result.data);
  if (parsed.success) {
    return { kind: "ok", data: parsed.data };
  }
  return {
    kind: INVALID_RESPONSE_KIND,
    code: "autodev_control_api_invalid_skills_response",
    message:
      "AutoDev Control API returned an incompatible Skills response; the Console requires the v2 canonical catalog contract."
  };
}

/**
Server-only read of one existing canonical RuleSync skill source.
*/
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
  const parsed = controlApiSkillContentResponseSchema.safeParse(result.data);
  if (
    parsed.success &&
    parsed.data.name === name &&
    parsed.data.path === `.rulesync/skills/${name}/SKILL.md`
  ) {
    return { kind: "ok", data: parsed.data };
  }
  return {
    kind: INVALID_RESPONSE_KIND,
    code: "autodev_control_api_invalid_skill_content_response",
    message:
      "AutoDev Control API returned an incompatible canonical skill source; the Console requires the v2 reconciliation contract and cannot safely display it."
  };
}

/**
Validates the desired set against the request and preserves missing actual
role evidence as `null`. A response is converged only when the Runtime's
observed set and generations confirm the requested assignment.
*/
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
  const parsed = controlApiHooksResponseSchema.safeParse(result.data);
  return parsed.success
    ? { kind: "ok", data: parsed.data }
    : invalidResponse("Hooks", "autodev-control-hooks-v2");
}

/**
The hook projection the Runtime published.

It is read on its own path rather than folded into the declaration, because
the two answer different questions: the declaration says what is configured
and the applied read says what the Runtime installed.
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
  const parsed = controlApiHooksAppliedResponseSchema.safeParse(result.data);
  return parsed.success
    ? { kind: "ok", data: parsed.data }
    : invalidResponse("Hooks", "autodev-control-hooks-applied-v1");
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
  const parsed = controlApiPermissionsResponseSchema.safeParse(result.data);
  if (parsed.success) {
    return { kind: "ok", data: parsed.data };
  }
  return {
    kind: INVALID_RESPONSE_KIND,
    code: "autodev_control_api_invalid_permissions_response",
    message:
      "AutoDev Control API returned an incompatible Permissions response; the Console requires the read-only effective capability-matrix contract."
  };
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
  const parsed = controlApiPromptsResponseSchema.safeParse(result.data);
  if (parsed.success) {
    return { kind: "ok", data: parsed.data };
  }
  return {
    kind: INVALID_RESPONSE_KIND,
    code: "autodev_control_api_invalid_prompts_response",
    message:
      "AutoDev Control API returned an incompatible Prompts response; the Console requires the v2 source-validity contract."
  };
}

export async function fetchPromptDetail(
  name: string,
  config: ControlApiConfig,
  options: FetchControlApiOptions = {}
): Promise<ControlApiResult<ControlApiPromptDetailResponse>> {
  const path = `${CONTROL_API_PATHS.prompts}/${encodeURIComponent(name)}`;
  const result = await fetchControlApi<unknown>(path, config, options);
  if (result.kind !== "ok") return result;
  const parsed = controlApiPromptDetailResponseSchema.safeParse(result.data);
  if (parsed.success) {
    return { kind: "ok", data: parsed.data };
  }
  return {
    kind: INVALID_RESPONSE_KIND,
    code: "autodev_control_api_invalid_prompt_detail_response",
    message:
      "AutoDev Control API returned an incompatible Prompt detail response; the Console requires the v4 reconciliation contract."
  };
}

/**
Reads one page of a prompt's committed history.

The page size is the Control API's to choose, so the Console asks for an
offset and reads the size back from the answer. Asking for a size here
would put two places in charge of how much history a page carries.
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
  const parsed = controlApiPromptVersionsResponseSchema.safeParse(result.data);
  if (parsed.success && parsed.data.name === name) {
    return { kind: "ok", data: parsed.data };
  }
  return {
    kind: INVALID_RESPONSE_KIND,
    code: "autodev_control_api_invalid_prompt_versions_response",
    message:
      "AutoDev Control API returned an incompatible Prompt version-history response."
  };
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
  const parsed = controlApiPromptVersionResponseSchema.safeParse(result.data);
  if (
    parsed.success &&
    parsed.data.name === name &&
    parsed.data.versionHash === versionHash
  ) {
    return { kind: "ok", data: parsed.data };
  }
  return {
    kind: INVALID_RESPONSE_KIND,
    code: "autodev_control_api_invalid_prompt_version_response",
    message:
      "AutoDev Control API returned an incompatible Prompt version response."
  };
}

/**
Server-only typed PATCH writing one MCP server's launch configuration to
the canonical declaration.

The write is a compare-and-swap on the declaration's revision, so the
Console sends the revision it read and the Runtime refuses a write decided
on an older declaration.
*/
export function patchMcpServer(
  name: string,
  payload: ControlApiMcpServerPatchRequest,
  config: ControlApiConfig,
  options: FetchControlApiOptions = {}
): Promise<ControlApiResult<ControlApiMcpServerPatchResponse>> {
  return mutateValidatedControlApi(
    "PATCH",
    `${CONTROL_API_PATHS.mcps}/${encodeURIComponent(name)}`,
    payload,
    controlApiMcpServerPatchResponseSchema,
    {
      what: "MCP server mutation",
      contract: "autodev-control-mcp-server-patch-v2",
      code: "autodev_control_api_invalid_mcp_patch_response"
    },
    config,
    options
  );
}

/**
Narrows the workspace catalog. The catalog scopes every Memory read, so an
unreadable one must not reach the selector as an empty list: an operator
would see "no workspaces" rather than "the catalog could not be read".
*/
/**
Narrow one workspace's configuration health.

The two states are different claims -- "this entry is usable" and "this
scope names roles nothing answers to" -- and the second names the roles it
could not place, so a fault can be shown rather than only counted.
*/
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
  const parsed = controlApiWorkspacesResponseSchema.safeParse(result.data);
  if (parsed.success) {
    return { kind: "ok", data: parsed.data };
  }
  return {
    kind: INVALID_RESPONSE_KIND,
    code: "autodev_control_api_invalid_workspaces_response",
    message:
      "AutoDev Control API returned an incompatible Workspaces response; the Console requires the v2 workspace catalog contract."
  };
}

/**
Write one workspace's configuration to the canonical catalog.

The write is the Runtime's: the Console forwards the operator's edit and
never touches the catalog itself. The owner and the repository are separate
path segments because a workspace is an `owner/repository` pair, and the
Runtime names it the way the catalog is indexed.
*/
export function patchWorkspace(
  owner: string,
  repository: string,
  payload: ControlApiWorkspacePatchRequest,
  config: ControlApiConfig,
  options: FetchControlApiOptions = {}
): Promise<ControlApiResult<ControlApiWorkspacePatchResponse>> {
  return mutateValidatedControlApi(
    "PATCH",
    `${CONTROL_API_PATHS.workspaces}/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}`,
    payload,
    controlApiWorkspacePatchResponseSchema,
    {
      what: "workspace mutation",
      contract: "autodev-control-workspace-patch-v2",
      code: "autodev_control_api_invalid_workspace_patch_response"
    },
    config,
    options
  );
}

function isWorkspacePlaytestApprovalResponse(
  value: unknown,
  workspaceId: string
): value is ControlApiWorkspacePlaytestApprovalResponse {
  const parsed =
    controlApiWorkspacePlaytestApprovalResponseSchema.safeParse(value);
  return parsed.success && parsed.data.workspaceId === workspaceId;
}

function workspacePlaytestApprovalPath(workspaceId: string): string {
  return `${CONTROL_API_PATHS.workspaces}/${encodeURIComponent(workspaceId)}/playtesting-approval`;
}

/**
One workspace's playtesting approval.

This is a playtesting read: the Control API answers it from the
ClickHouse-backed playtesting store, and the Workspaces page reads one per
workspace as a single fan-out. It therefore carries the playtesting budget
rather than the generic one, for the reason the playtesting page's own
workspace read does: the Control API answers this read set as one fan-out,
and a shorter deadline here fails the whole page while the Control API is
still answering it.
*/
export async function fetchWorkspacePlaytestApproval(
  workspaceId: string,
  config: ControlApiConfig,
  options: FetchControlApiOptions = {}
): Promise<ControlApiResult<ControlApiWorkspacePlaytestApprovalResponse>> {
  const result = await fetchControlApi<unknown>(
    workspacePlaytestApprovalPath(workspaceId),
    config,
    {
      ...options,
      timeoutMs: options.timeoutMs ?? PLAYTESTING_CONTROL_API_TIMEOUT_MS
    }
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

async function postWorkspacePlaytestApprovalMutation(
  workspaceId: string,
  path: string,
  payload: unknown,
  config: ControlApiConfig,
  options: FetchControlApiOptions = {}
): Promise<ControlApiResult<ControlApiWorkspacePlaytestApprovalResponse>> {
  const result = await postControlApi<unknown>(path, payload, config, options);
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
  return postWorkspacePlaytestApprovalMutation(
    workspaceId,
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
  return postWorkspacePlaytestApprovalMutation(
    workspaceId,
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
  const parsed =
    controlApiWorkspaceVisualPlaytestTargetsResponseSchema.safeParse(value);
  return parsed.success && parsed.data.workspaceId === workspaceId;
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
  const parsed = controlApiGithubResponseSchema.safeParse(result.data);
  return parsed.success
    ? { kind: "ok", data: parsed.data }
    : invalidResponse("GitHub", CONTROL_API_GITHUB_SCHEMA_ID);
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
  const parsed = controlApiRuntimeResponseSchema.safeParse(result.data);
  if (parsed.success) {
    return { kind: "ok", data: parsed.data };
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
  const parsed = controlApiEvaluationsResponseSchema.safeParse(result.data);
  return parsed.success
    ? { kind: "ok", data: parsed.data }
    : invalidResponse(
        "Evaluations",
        CONTROL_API_EVALUATIONS_SCHEMA_ID,
        "autodev_control_api_invalid_evaluations_response"
      );
}

/**
The diagnostics routes are read-only and read the whole machine's session
evidence: a session's rollouts, the router's rotated logs, the bridge logs,
the hook log and the live runtime. They are slower than a configuration read
and they are read on every scoped page view, so they carry their own budget
rather than the generic five seconds.
*/
const DIAGNOSTICS_CONTROL_API_TIMEOUT_MS = 20_000;

/**
The bounded query a session's diagnostics read accepts.
*/
export interface SessionDiagnosticsQuery {
  readonly includeEfficiency?: boolean;
  readonly includeFailures?: boolean;
  readonly allFailures?: boolean;
  readonly includeEvents?: boolean;
  readonly eventsLimit?: number;
  readonly eventsOffset?: number;
  readonly includeItems?: boolean;
  readonly itemsLimit?: number;
  readonly itemsOffset?: number;
  readonly threadId?: string | undefined;
  readonly offline?: boolean;
}

function diagnosticsQueryString(query: SessionDiagnosticsQuery): string {
  const parameters = new URLSearchParams();
  const flag = (name: string, value: boolean | undefined): void => {
    if (value === undefined) return;
    parameters.set(name, value ? "1" : "0");
  };
  flag("includeEfficiency", query.includeEfficiency);
  flag("includeFailures", query.includeFailures);
  flag("allFailures", query.allFailures);
  flag("includeEvents", query.includeEvents);
  flag("includeItems", query.includeItems);
  flag("offline", query.offline);
  if (query.eventsLimit !== undefined)
    parameters.set("eventsLimit", String(query.eventsLimit));
  if (query.eventsOffset !== undefined)
    parameters.set("eventsOffset", String(query.eventsOffset));
  if (query.itemsLimit !== undefined)
    parameters.set("itemsLimit", String(query.itemsLimit));
  if (query.itemsOffset !== undefined)
    parameters.set("itemsOffset", String(query.itemsOffset));
  if (query.threadId !== undefined) parameters.set("threadId", query.threadId);
  return parameters.toString();
}

/**
Read one session's unified diagnostics.

The payload is validated against the Core schema before it is handed on: a
malformed report would render as though it were evidence.
*/
export async function fetchSessionDiagnostics(
  sessionId: string,
  query: SessionDiagnosticsQuery,
  config: ControlApiConfig,
  options: FetchControlApiOptions = {}
): Promise<ControlApiResult<SessionDiagnosticsReport>> {
  const parameters = diagnosticsQueryString(query);
  const path = `${CONTROL_API_PATHS.diagnostics}/sessions/${encodeURIComponent(sessionId)}${parameters.length > 0 ? `?${parameters}` : ""}`;
  const result = await fetchControlApi<unknown>(path, config, {
    timeoutMs: DIAGNOSTICS_CONTROL_API_TIMEOUT_MS,
    ...options
  });
  if (result.kind !== "ok") return result;
  if (isSessionDiagnosticsReport(result.data)) {
    return { kind: "ok", data: result.data };
  }
  return {
    kind: INVALID_RESPONSE_KIND,
    code: "autodev_control_api_invalid_diagnostics_response",
    message:
      "AutoDev Control API returned an incompatible session diagnostics response; the Console requires the v1 diagnostics contract."
  };
}

/**
Read the cross-session fleet scan.
*/
export async function fetchFleetSessionScan(
  limit: number,
  config: ControlApiConfig,
  options: FetchControlApiOptions = {}
): Promise<ControlApiResult<SessionFleetScanResponse>> {
  const path = `${CONTROL_API_PATHS.diagnostics}/sessions/scan?limit=${encodeURIComponent(String(limit))}`;
  const result = await fetchControlApi<unknown>(path, config, {
    timeoutMs: DIAGNOSTICS_CONTROL_API_TIMEOUT_MS,
    ...options
  });
  if (result.kind !== "ok") return result;
  if (isSessionFleetScanResponse(result.data)) {
    return { kind: "ok", data: result.data };
  }
  return {
    kind: INVALID_RESPONSE_KIND,
    code: "autodev_control_api_invalid_fleet_scan_response",
    message:
      "AutoDev Control API returned an incompatible fleet-scan response; the Console requires the v1 fleet-scan contract."
  };
}

/**
Read the hook-denial summary.
*/
export async function fetchHookDenials(
  sinceDays: number,
  config: ControlApiConfig,
  options: FetchControlApiOptions = {}
): Promise<ControlApiResult<SessionHookDenialsResponse>> {
  const path = `${CONTROL_API_PATHS.diagnostics}/hooks?sinceDays=${encodeURIComponent(String(sinceDays))}`;
  const result = await fetchControlApi<unknown>(path, config, {
    timeoutMs: DIAGNOSTICS_CONTROL_API_TIMEOUT_MS,
    ...options
  });
  if (result.kind !== "ok") return result;
  if (isSessionHookDenialsResponse(result.data)) {
    return { kind: "ok", data: result.data };
  }
  return {
    kind: INVALID_RESPONSE_KIND,
    code: "autodev_control_api_invalid_hook_denials_response",
    message:
      "AutoDev Control API returned an incompatible hook-denial response; the Console requires the v1 hook-denials contract."
  };
}

export async function fetchChatgptTunnel(
  config: ControlApiConfig
): Promise<ControlApiResult<ChatgptTunnelStatus>> {
  const result = await fetchControlApi<unknown>(
    CHATGPT_TUNNEL_CONTROL_PATH,
    config
  );
  if (result.kind !== "ok") return result;
  const parsed = chatgptTunnelStatusSchema.safeParse(result.data);
  if (!parsed.success) {
    return invalidResponse("ChatgptTunnel", "autodev-chatgpt-tunnel-v2");
  }
  return { kind: "ok", data: parsed.data };
}
