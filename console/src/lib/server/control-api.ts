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
  isSandboxMode,
  LOCAL_CONTROL_API_ACTOR,
  PROVIDER_ROLES,
  type ProviderRole,
  type ProviderRolePriority,
  type ReconciliationStatus
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
      "AutoDev Control API returned an incompatible Agents response; the Console requires the v1 agents contract."
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
      "AutoDev Control API returned an incompatible Agent detail response; the Console requires the v2 agent detail contract."
  };
}

/**
 * Narrows one agent record. Agents drive the whole Configure surface, and an
 * unreadable record used to reach the table as `undefined` fields rather than
 * as an explicit failure, so the guard checks the fields the views actually
 * read rather than only the identifier.
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
    typeof value.primaryModel === "string" &&
    isStringList(value.allowedProviders) &&
    isStringList(value.mcps) &&
    isStringList(value.skills)
  );
}

/** Narrows the agents collection, including every record it carries. */
function isControlApiAgentsResponse(
  value: unknown
): value is ControlApiAgentsResponse {
  return (
    isRecord(value) &&
    value.schema === "autodev-control-agents-v1" &&
    typeof value.source === "string" &&
    Array.isArray(value.agents) &&
    typeof value.totalAgents === "number" &&
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
    value.schema === "autodev-control-agent-detail-v2" &&
    isAgentRecord(value) &&
    (value.promptPath === null || typeof value.promptPath === "string") &&
    typeof value.systemPrompt === "string" &&
    isReconciliationBundle(value.reconciliation)
  );
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
  return (
    isRecord(value) &&
    (value.priority === 1 ||
      value.priority === 2 ||
      value.priority === 3 ||
      value.priority === "disabled") &&
    (value.model === null || typeof value.model === "string") &&
    typeof value.mutable === "boolean" &&
    isReconciliationStatus(value.convergence)
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

/**
 * Narrows one provider health projection. Both nested records are nullable, but
 * "nullable" means the Runtime sent `null` -- a payload that omits the key
 * entirely arrives as `undefined`, which is not `null`, so `health.cooldown !==
 * null` would be true and the badge would read `.failureClass` off undefined
 * and throw. The check distinguishes absent from observed.
 */
function isProviderHealth(value: unknown): boolean {
  return (
    isRecord(value) &&
    (value.cooldown === null ||
      (isRecord(value.cooldown) &&
        typeof value.cooldown.kind === "string" &&
        (value.cooldown.failureClass === null ||
          typeof value.cooldown.failureClass === "string") &&
        typeof value.cooldown.until === "string")) &&
    (value.lastFailure === null ||
      (isRecord(value.lastFailure) &&
        typeof value.lastFailure.at === "string" &&
        (value.lastFailure.failureClass === null ||
          typeof value.lastFailure.failureClass === "string")))
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
        isProviderRoles(provider.roles) &&
        typeof provider.disabled === "boolean" &&
        isProviderAgentLimits(provider.agentLimits) &&
        isRecord(provider.credential) &&
        typeof provider.credential.configured === "boolean" &&
        Array.isArray(provider.models) &&
        Array.isArray(provider.priorities) &&
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
  assignment: { priority: ProviderRolePriority; model: string | null },
  config: ControlApiConfig,
  options: FetchControlApiOptions = {}
): Promise<ControlApiResult<ControlApiProviderRolePatchResponse>> {
  return mutateControlApi<ControlApiProviderRolePatchResponse>(
    "PATCH",
    providerRoleControlPath(provider, role),
    { priority: assignment.priority, model: assignment.model },
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

function isMemoryHistoryResponse(
  value: unknown
): value is ControlApiMemoryHistoryResponse {
  return (
    isRecord(value) &&
    value.schema === "autodev-memory-history-v1" &&
    // `transitions` is the evidence the history panel is entirely made of; a
    // missing list is not an empty history.
    Array.isArray(value.transitions) &&
    isMemoryRecordRow(value.memory)
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
    typeof value.unreportedSessionCount === "number"
  );
}

/**
 * One failure shape for every unreadable catalog, so the Console reports a
 * drifted Runtime the same way whichever collection it was reading.
 */
function invalidCatalogResponse(
  what: string,
  schema: string
): ControlApiResult<never> {
  return {
    kind: INVALID_RESPONSE_KIND,
    code: "autodev_control_api_invalid_catalog_response",
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
    value.schema === "autodev-control-mcps-v1" &&
    typeof value.source === "string" &&
    typeof value.readOnly === "boolean" &&
    (value.valid === null || typeof value.valid === "boolean") &&
    Array.isArray(value.servers) &&
    value.servers.every(isMcpServerRow)
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
    isNullableNumber(value.totalTools) &&
    typeof value.usageLink === "string" &&
    Array.isArray(value.tools) &&
    value.tools.every(isToolCatalogRow)
  );
}

function isControlApiHooksResponse(
  value: unknown
): value is ControlApiHooksResponse {
  return (
    isRecord(value) &&
    value.schema === "autodev-control-hooks-v1" &&
    typeof value.source === "string" &&
    typeof value.readOnly === "boolean" &&
    (value.valid === null || typeof value.valid === "boolean") &&
    isRecord(value.hooks)
  );
}

/**
 * Narrows one evaluation row. `passed` is the verdict the table renders, and
 * `boolean | null` is three states: a missing `passed` reads as `undefined`,
 * which every verdict comparison in the view treats as a failure. A row without
 * it would therefore synthesize "did not pass" out of unreadable evidence, so
 * the check requires it alongside the rest of the required record.
 */
function isEvaluationRow(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.agentRole === "string" &&
    typeof value.model === "string" &&
    Array.isArray(value.metrics) &&
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
    Array.isArray(value.evaluations) &&
    value.evaluations.every(isEvaluationRow)
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
    Array.isArray(value.recentRuns)
  );
}

function isControlApiRoutingResponse(
  value: unknown
): value is ControlApiRoutingResponse {
  return (
    isRecord(value) &&
    value.schema === "autodev-control-routing-v1" &&
    isRecord(value.runtime) &&
    Array.isArray(value.routes) &&
    isRecord(value.cooldowns)
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
    : invalidCatalogResponse("Mcps", "autodev-control-mcps-v1");
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
    : invalidCatalogResponse("Tools", "autodev-control-tools-v2");
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
    : invalidCatalogResponse("Hooks", "autodev-control-hooks-v1");
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
    typeof value.webSearch === "boolean" &&
    typeof value.defaultToolsApprovalMode === "string"
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
    !isPermissionsPolicy(value.policy) ||
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

/**
 * Narrows the workspace catalog. The catalog scopes every Memory read, so an
 * unreadable one must not reach the selector as an empty list: an operator
 * would see "no workspaces" rather than "the catalog could not be read".
 */
function isControlApiWorkspacesResponse(
  value: unknown
): value is ControlApiWorkspacesResponse {
  return (
    isRecord(value) &&
    value.schema === "autodev-control-workspaces-v1" &&
    typeof value.source === "string" &&
    typeof value.readOnly === "boolean" &&
    (value.catalogStatus === "valid" ||
      value.catalogStatus === "invalid" ||
      value.catalogStatus === "unavailable") &&
    isNullableNumber(value.totalWorkspaces) &&
    Array.isArray(value.workspaces) &&
    value.workspaces.every(
      (workspace) =>
        isRecord(workspace) &&
        typeof workspace.id === "string" &&
        typeof workspace.baseBranch === "string" &&
        typeof workspace.enabled === "boolean" &&
        (workspace.agentRoles === null || isStringList(workspace.agentRoles))
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
      "AutoDev Control API returned an incompatible Workspaces response; the Console requires the v1 workspace catalog contract."
  };
}

export async function fetchGithubWorkflows(
  config: ControlApiConfig,
  options: FetchControlApiOptions = {}
): Promise<ControlApiResult<ControlApiGithubResponse>> {
  const result = await fetchControlApi<unknown>(
    CONTROL_API_PATHS.github,
    config,
    options
  );
  if (result.kind !== "ok") return result;
  // GitHub's page is explicitly about unobserved state: a catalog that cannot be
  // read must report that rather than present an empty workflow list as "this
  // repository has no workflows".
  return isControlApiGithubResponse(result.data)
    ? { kind: "ok", data: result.data }
    : invalidCatalogResponse("GitHub", "autodev-control-github-v1");
}

export async function fetchRouting(
  config: ControlApiConfig,
  options: FetchControlApiOptions = {}
): Promise<ControlApiResult<ControlApiRoutingResponse>> {
  const result = await fetchControlApi<unknown>(
    CONTROL_API_PATHS.routing,
    config,
    options
  );
  if (result.kind !== "ok") return result;
  return isControlApiRoutingResponse(result.data)
    ? { kind: "ok", data: result.data }
    : invalidCatalogResponse("Routing", "autodev-control-routing-v1");
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
    : invalidCatalogResponse("Evaluations", "autodev-control-evaluations-v1");
}

export async function fetchMemoryRecords(
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
  const result = await fetchControlApi<unknown>(path, config, options);
  if (result.kind !== "ok") return result;
  return isMemoryPageResponse<ControlApiMemoryRecordsResponse>(
    result.data,
    "autodev-memory-records-v1",
    isMemoryRecordRow
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

export async function fetchMemoryCohorts(
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
  const result = await fetchControlApi<unknown>(path, config, options);
  if (result.kind !== "ok") return result;
  return isInjectionUseCohortPage(result.data)
    ? { kind: "ok", data: result.data }
    : invalidMemoryPageResponse(
        "injection-use cohorts",
        "autodev-memory-injection-use-cohorts-v1"
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
