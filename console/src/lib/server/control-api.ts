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

import { readFileSync } from "node:fs";
import nodePath from "node:path";

import {
  type ControlApiAgentDetailResponse,
  type ControlApiAgentsResponse,
  type ControlApiConcurrencyStatus,
  type ControlApiError,
  type ControlApiEvaluationsResponse,
  type ControlApiGithubResponse,
  type ControlApiHooksResponse,
  type ControlApiMcpsResponse,
  type ControlApiMemoryCohortsResponse,
  type ControlApiMemoryExperienceDetailResponse,
  type ControlApiMemoryExperiencesResponse,
  type ControlApiMemoryHistoryResponse,
  type ControlApiMemoryRecordDetailResponse,
  type ControlApiMemoryRecordsResponse,
  type ControlApiMemoryUseCohortsResponse,
  type ControlApiModelPatchResponse,
  type ControlApiModelsResponse,
  type ControlApiPermissionsResponse,
  type ControlApiPromptCommandPatchRequest,
  type ControlApiPromptCommandPatchResponse,
  type ControlApiPromptDetailResponse,
  type ControlApiPromptsResponse,
  type ControlApiPromptVersionResponse,
  type ControlApiPromptVersionsResponse,
  type ControlApiProviderRolePatchResponse,
  type ControlApiProvidersResponse,
  type ControlApiRoutingResponse,
  type ControlApiRuntimeResponse,
  type ControlApiSkillsResponse,
  type ControlApiToolsResponse,
  type ControlApiWorkspacesResponse,
  type ConvergenceStatus,
  LOCAL_CONTROL_API_ACTOR,
  type ProviderRole
} from "@simulatorlife/autodev-core";

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
  | { readonly kind: "unreachable"; readonly message: string }
  | {
      readonly kind: typeof INVALID_RESPONSE_KIND;
      readonly code: string;
      readonly message: string;
    };

const DEFAULT_CONTROL_API_BASE_URL = "http://127.0.0.1:4101";
const CONTROL_API_TIMEOUT_MS = 5000;
const INVALID_RESPONSE_KIND = "invalid-response" as const;
const PROMPT_VERSION_TIMEOUT_MS = 12_000;
const CONTROL_API_REVISION_PATTERN = /^[a-f0-9]{64}$/u;
const CONTROL_API_GIT_REVISION_PATTERN = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;
const TRAILING_SLASHES = /\/+$/u;
const LINE_SPLIT_PATTERN = /\r?\n/u;

export interface ControlApiConfig {
  readonly baseUrl: string;
  readonly serviceToken: string;
}

function readSecretFromFile(filePath: string, key: string): string | null {
  try {
    const content = readFileSync(filePath, "utf8");
    for (const line of content.split(LINE_SPLIT_PATTERN)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const stripped = trimmed.startsWith("export ")
        ? trimmed.slice(7).trim()
        : trimmed;
      if (!stripped.startsWith(`${key}=`)) continue;
      const rawValue = stripped.slice(key.length + 1).trim();
      const first = rawValue[0];
      const last = rawValue.at(-1);
      const quoted =
        rawValue.length >= 2 &&
        ((first === '"' && last === '"') || (first === "'" && last === "'"));
      const value = quoted ? rawValue.slice(1, -1) : rawValue;
      return value || null;
    }
  } catch {
    return null;
  }
  return null;
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
}

/**
 * Issues an authenticated GET against the AutoDev Control API.
 *
 * Never accepts a `headers` argument; the only headers sent are the canonical
 * service credential and the canonical local actor identity. No browser header
 * is ever forwarded.
 */
export async function fetchControlApi<T>(
  path: string,
  config: ControlApiConfig,
  options: FetchControlApiOptions = {}
): Promise<ControlApiResult<T>> {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    options.timeoutMs ?? CONTROL_API_TIMEOUT_MS
  );
  const signal = options.signal ?? controller.signal;
  let response: Response;
  try {
    response = await fetchImpl(`${config.baseUrl}${path}`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${config.serviceToken}`,
        "X-AutoDev-Actor": LOCAL_CONTROL_API_ACTOR,
        Accept: "application/json"
      },
      signal
    });
  } catch (error) {
    clearTimeout(timer);
    return {
      kind: "unreachable",
      message:
        error instanceof Error
          ? error.message
          : "AutoDev Control API is unreachable."
    };
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

  let body: Partial<ControlApiError> = {};
  try {
    const raw = (await response.json()) as
      Partial<ControlApiError> | { readonly error?: Partial<ControlApiError> };
    if (raw && typeof raw === "object") {
      if ("error" in raw && raw.error && typeof raw.error === "object") {
        body = raw.error;
      } else {
        body = raw as Partial<ControlApiError>;
      }
    }
  } catch {
    // Non-JSON error body; fall through with empty error.
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
  const timer = setTimeout(
    () => controller.abort(),
    options.timeoutMs ?? CONTROL_API_TIMEOUT_MS
  );
  const signal = options.signal ?? controller.signal;

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
    return {
      kind: "unreachable",
      message:
        error instanceof Error
          ? error.message
          : "AutoDev Control API is unreachable."
    };
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

  let body: Partial<ControlApiError> = {};
  try {
    const raw = (await response.json()) as
      Partial<ControlApiError> | { readonly error?: Partial<ControlApiError> };
    if (raw && typeof raw === "object") {
      if ("error" in raw && raw.error && typeof raw.error === "object") {
        body = raw.error;
      } else {
        body = raw as Partial<ControlApiError>;
      }
    }
  } catch {
    // Non-JSON error body
  }
  return {
    kind:
      response.status === 401 || response.status === 403
        ? "unauthorized"
        : "http-error",
    status: response.status,
    code: body.code ?? "autodev_control_api_" + response.status,
    message:
      body.message ??
      "AutoDev Control API rejected the request with status " +
        response.status +
        "."
  };
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
  models: "/control/models",
  mcps: "/control/mcps",
  tools: "/control/tools",
  skills: "/control/skills",
  hooks: "/control/hooks",
  permissions: "/control/permissions",
  prompts: "/control/prompts",
  workspaces: "/control/workspaces",
  routing: "/control/routing",
  runtime: "/control/runtime",
  evaluations: "/control/evaluations",
  github: "/control/github",
  memoryRecords: "/control/memory/records",
  memoryExperiences: "/control/memory/experiences",
  memoryCohorts: "/control/memory/cohorts",
  memorySessionCohorts: "/control/memory/session-cohorts",
  memoryUseCohorts: "/control/memory/use-cohorts",
  memoryPromoteSkill: "/control/memory/promote-skill"
} as const;

export function controlApiFailureCode(
  result: Exclude<ControlApiResult<unknown>, { readonly kind: "ok" }>
): string {
  return result.kind === "unreachable" ? "autodev_unreachable" : result.code;
}

export function fetchAgents(
  config: ControlApiConfig,
  options: FetchControlApiOptions = {}
): Promise<ControlApiResult<ControlApiAgentsResponse>> {
  return fetchControlApi<ControlApiAgentsResponse>(
    CONTROL_API_PATHS.agents,
    config,
    options
  );
}

export function fetchAgentDetail(
  role: string,
  config: ControlApiConfig,
  options: FetchControlApiOptions = {}
): Promise<ControlApiResult<ControlApiAgentDetailResponse>> {
  const path = `${CONTROL_API_PATHS.agents}/${encodeURIComponent(role)}`;
  return fetchControlApi<ControlApiAgentDetailResponse>(path, config, options);
}

function isEnablement(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.enabled === "boolean" &&
    typeof value.mutable === "boolean"
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
function isEnablementWithConvergence(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const convergence = value.convergence;
  return (
    isRecord(convergence) &&
    isConvergenceStatus(convergence.convergence) &&
    isNullableString(convergence.desiredGeneration) &&
    isNullableString(convergence.observedGeneration) &&
    isNullableString(convergence.lastApplyAt) &&
    isNullableString(convergence.lastObservationAt) &&
    isNullableString(convergence.lastError) &&
    typeof convergence.explanation === "string"
  );
}

function isControlApiProvidersResponse(
  value: unknown
): value is ControlApiProvidersResponse {
  return (
    isRecord(value) &&
    value.schema === "autodev-control-providers-v2" &&
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
        isRecord(provider.roles) &&
        isEnablement(provider.roles.orchestrator) &&
        isEnablementWithConvergence(provider.roles.orchestrator) &&
        isEnablement(provider.roles.subagent) &&
        isEnablementWithConvergence(provider.roles.subagent) &&
        isRecord(provider.credential) &&
        typeof provider.credential.configured === "boolean" &&
        Array.isArray(provider.models) &&
        Array.isArray(provider.priorities)
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
      "AutoDev Control API returned an incompatible Providers response; the Console requires the v2 provider contract."
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
  enabled: boolean,
  config: ControlApiConfig,
  options: FetchControlApiOptions = {}
): Promise<ControlApiResult<ControlApiProviderRolePatchResponse>> {
  return mutateControlApi<ControlApiProviderRolePatchResponse>(
    "PATCH",
    providerRoleControlPath(provider, role),
    { enabled },
    config,
    options
  );
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

export function fetchMcps(
  config: ControlApiConfig,
  options: FetchControlApiOptions = {}
): Promise<ControlApiResult<ControlApiMcpsResponse>> {
  return fetchControlApi<ControlApiMcpsResponse>(
    CONTROL_API_PATHS.mcps,
    config,
    options
  );
}

export function fetchTools(
  config: ControlApiConfig,
  options: FetchControlApiOptions = {}
): Promise<ControlApiResult<ControlApiToolsResponse>> {
  return fetchControlApi<ControlApiToolsResponse>(
    CONTROL_API_PATHS.tools,
    config,
    options
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
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

/** Optional numeric counter the concurrency projection publishes. */
function isOptionalNumber(value: unknown): value is number | undefined {
  return value === undefined || typeof value === "number";
}

function isConcurrencyStatus(
  value: unknown
): value is ControlApiConcurrencyStatus {
  if (!isRecord(value)) return false;
  return (
    (value.scope === undefined || typeof value.scope === "string") &&
    isOptionalNumber(value.maxConcurrentThreadsPerSession) &&
    isOptionalNumber(value.effectivePerSessionLimit) &&
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
    value.schema === "autodev-control-runtime-v1" &&
    typeof value.routerInstanceId === "string" &&
    isRecord(value.lifecycle) &&
    typeof value.lifecycle.state === "string" &&
    typeof value.lifecycle.draining === "boolean" &&
    typeof value.lifecycle.changedAt === "string" &&
    typeof value.lifecycle.activeResponseRequests === "number" &&
    isConcurrencyStatus(value.concurrency) &&
    typeof value.inFlightRequestCount === "number"
  );
}

function isControlApiSkillsResponse(
  value: unknown
): value is ControlApiSkillsResponse {
  return (
    isRecord(value) &&
    value.schema === "autodev-control-skills-v2" &&
    typeof value.source === "string" &&
    value.readOnly === true &&
    (value.valid === true || value.valid === false || value.valid === null) &&
    Array.isArray(value.skills) &&
    value.skills.every(
      (skill) =>
        isRecord(skill) &&
        typeof skill.name === "string" &&
        typeof skill.description === "string" &&
        typeof skill.path === "string" &&
        isStringList(skill.roles)
    ) &&
    Array.isArray(value.unresolvedAssignments) &&
    value.unresolvedAssignments.every(
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

export function fetchHooks(
  config: ControlApiConfig,
  options: FetchControlApiOptions = {}
): Promise<ControlApiResult<ControlApiHooksResponse>> {
  return fetchControlApi<ControlApiHooksResponse>(
    CONTROL_API_PATHS.hooks,
    config,
    options
  );
}

function isControlApiPermissionsResponse(
  value: unknown
): value is ControlApiPermissionsResponse {
  if (
    !isRecord(value) ||
    value.schema !== "autodev-control-permissions-v1" ||
    typeof value.source !== "string" ||
    value.readOnly !== true ||
    !isRecord(value.policy) ||
    !isRecord(value.rolePermissions)
  ) {
    return false;
  }
  return Object.values(value.rolePermissions).every(
    (entry) =>
      isRecord(entry) &&
      typeof entry.readOnly === "boolean" &&
      typeof entry.sandbox === "string" &&
      typeof entry.networkAccess === "boolean" &&
      typeof entry.approvals === "string" &&
      // The capability matrix must be a real projection. An absent list is
      // missing evidence, not "no MCP servers", so it fails closed instead of
      // letting the Console print a fabricated `None`.
      isStringList(entry.mcp) &&
      isStringList(entry.skills)
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

function isControlApiPromptsResponse(
  value: unknown
): value is ControlApiPromptsResponse {
  return (
    isRecord(value) &&
    value.schema === "autodev-control-prompts-v2" &&
    typeof value.source === "string" &&
    value.readOnly === true &&
    (value.valid === true || value.valid === false || value.valid === null) &&
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
    Array.isArray(value.rolePrompts) &&
    value.rolePrompts.every(
      (prompt) =>
        isRecord(prompt) &&
        typeof prompt.role === "string" &&
        typeof prompt.path === "string"
    )
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
    value.schema !== "autodev-control-prompt-versions-v1" ||
    typeof value.name !== "string" ||
    (value.status !== "available" && value.status !== "unavailable") ||
    typeof value.hasMore !== "boolean" ||
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

export async function fetchPromptVersions(
  name: string,
  config: ControlApiConfig,
  options: FetchControlApiOptions = {}
): Promise<ControlApiResult<ControlApiPromptVersionsResponse>> {
  const path = `${CONTROL_API_PATHS.prompts}/${encodeURIComponent(name)}/versions`;
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

export function fetchWorkspaces(
  config: ControlApiConfig,
  options: FetchControlApiOptions = {}
): Promise<ControlApiResult<ControlApiWorkspacesResponse>> {
  return fetchControlApi<ControlApiWorkspacesResponse>(
    CONTROL_API_PATHS.workspaces,
    config,
    options
  );
}

export function fetchGithubWorkflows(
  config: ControlApiConfig,
  options: FetchControlApiOptions = {}
): Promise<ControlApiResult<ControlApiGithubResponse>> {
  return fetchControlApi<ControlApiGithubResponse>(
    CONTROL_API_PATHS.github,
    config,
    options
  );
}

export function fetchRouting(
  config: ControlApiConfig,
  options: FetchControlApiOptions = {}
): Promise<ControlApiResult<ControlApiRoutingResponse>> {
  return fetchControlApi<ControlApiRoutingResponse>(
    CONTROL_API_PATHS.routing,
    config,
    options
  );
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
      "AutoDev Control API returned an incompatible Runtime response; the Console requires the v1 runtime contract."
  };
}

export function fetchEvaluations(
  config: ControlApiConfig,
  options: FetchControlApiOptions = {}
): Promise<ControlApiResult<ControlApiEvaluationsResponse>> {
  return fetchControlApi<ControlApiEvaluationsResponse>(
    CONTROL_API_PATHS.evaluations,
    config,
    options
  );
}

export function fetchMemoryRecords(
  params: {
    readonly workspaceId: string;
    readonly repositoryId?: string;
    readonly query?: string;
    readonly kind?: string;
    readonly status?: string;
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
  if (params.limit !== undefined) search.set("limit", String(params.limit));
  if (params.offset !== undefined) search.set("offset", String(params.offset));
  const path = `${CONTROL_API_PATHS.memoryRecords}?${search.toString()}`;
  return fetchControlApi<ControlApiMemoryRecordsResponse>(
    path,
    config,
    options
  );
}

export function fetchMemoryRecord(
  id: string,
  workspaceId: string,
  config: ControlApiConfig,
  options: FetchControlApiOptions = {}
): Promise<ControlApiResult<ControlApiMemoryRecordDetailResponse>> {
  const search = new URLSearchParams({ workspaceId });
  const path = `${CONTROL_API_PATHS.memoryRecords}/${encodeURIComponent(id)}?${search.toString()}`;
  return fetchControlApi<ControlApiMemoryRecordDetailResponse>(
    path,
    config,
    options
  );
}

export function fetchMemoryHistory(
  id: string,
  workspaceId: string,
  config: ControlApiConfig,
  options: FetchControlApiOptions = {}
): Promise<ControlApiResult<ControlApiMemoryHistoryResponse>> {
  const search = new URLSearchParams({ workspaceId });
  const path = `${CONTROL_API_PATHS.memoryRecords}/${encodeURIComponent(id)}/history?${search.toString()}`;
  return fetchControlApi<ControlApiMemoryHistoryResponse>(
    path,
    config,
    options
  );
}

export function fetchMemoryExperiences(
  params: {
    readonly workspaceId: string;
    readonly repositoryId?: string;
    readonly query?: string;
    readonly memoryMode?: string;
    readonly outcome?: string;
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
  if (params.limit !== undefined) search.set("limit", String(params.limit));
  if (params.offset !== undefined) search.set("offset", String(params.offset));
  if (params.includeTaskHistory) search.set("includeTaskHistory", "true");
  const path = `${CONTROL_API_PATHS.memoryExperiences}?${search.toString()}`;
  return fetchControlApi<ControlApiMemoryExperiencesResponse>(
    path,
    config,
    options
  );
}

export function fetchMemoryExperienceDetail(
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
  return fetchControlApi<ControlApiMemoryExperienceDetailResponse>(
    path,
    config,
    options
  );
}

export function fetchMemoryCohorts(
  params: {
    readonly workspaceId: string;
    readonly repositoryId: string;
    readonly occurredFrom: string;
    readonly occurredUntil: string;
    readonly memoryModes?: readonly string[];
    readonly injectionResults?: readonly string[];
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
  const path = `${CONTROL_API_PATHS.memorySessionCohorts}?${search.toString()}`;
  return fetchControlApi<ControlApiMemoryCohortsResponse>(
    path,
    config,
    options
  );
}

export function fetchMemoryUseCohorts(
  params: {
    readonly workspaceId: string;
    readonly repositoryId: string;
    readonly occurredFrom: string;
    readonly occurredUntil: string;
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
  const path = `${CONTROL_API_PATHS.memoryUseCohorts}?${search.toString()}`;
  return fetchControlApi<ControlApiMemoryUseCohortsResponse>(
    path,
    config,
    options
  );
}

export function proposeMemoryRecord(
  payload: {
    readonly workspaceId: string;
    readonly proposal: {
      readonly kind: string;
      readonly claim: string;
      readonly scope: Record<string, unknown>;
      readonly evidence?: readonly Record<string, unknown>[];
      readonly sourceExperienceIds?: readonly string[];
      readonly reasonCode?: string;
    };
  },
  config: ControlApiConfig,
  options: FetchControlApiOptions = {}
): Promise<ControlApiResult<{ readonly memory: unknown }>> {
  const search = new URLSearchParams({ workspaceId: payload.workspaceId });
  const path = `${CONTROL_API_PATHS.memoryRecords}?${search.toString()}`;
  return postControlApi<{ readonly memory: unknown }>(
    path,
    payload.proposal,
    config,
    options
  );
}

export function transitionMemoryRecord(
  id: string,
  action: "verify" | "revise" | "invalidate" | "supersede",
  payload: {
    readonly workspaceId: string;
    readonly reason?: string;
    readonly claim?: string;
    readonly supersededBy?: string;
  },
  config: ControlApiConfig,
  options: FetchControlApiOptions = {}
): Promise<ControlApiResult<{ readonly memory: unknown }>> {
  const search = new URLSearchParams({ workspaceId: payload.workspaceId });
  const path = `${CONTROL_API_PATHS.memoryRecords}/${encodeURIComponent(id)}/${action}?${search.toString()}`;
  return postControlApi<{ readonly memory: unknown }>(
    path,
    payload,
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
export type ControlApiMemoryPurgeReason =
  "privacy_request" | "retention_expired";

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

export function promoteMemoryProcedureToSkill(
  payload: {
    readonly workspaceId: string;
    readonly memoryId: string;
    readonly skillName: string;
    readonly description?: string;
  },
  config: ControlApiConfig,
  options: FetchControlApiOptions = {}
): Promise<ControlApiResult<{ readonly skill: unknown }>> {
  const search = new URLSearchParams({ workspaceId: payload.workspaceId });
  const path = `${CONTROL_API_PATHS.memoryPromoteSkill}?${search.toString()}`;
  return postControlApi<{ readonly skill: unknown }>(
    path,
    payload,
    config,
    options
  );
}
