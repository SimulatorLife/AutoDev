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
  type ControlApiError,
  type ControlApiEvaluationsResponse,
  type ControlApiGithubResponse,
  type ControlApiGithubMutationResponse,
  type GithubWorkflowMutationRequest,
  type ControlApiHooksResponse,
  type ControlApiMcpsResponse,
  type ControlApiMemoryCohortsResponse,
  type ControlApiMemoryExperienceDetailResponse,
  type ControlApiMemoryExperiencesResponse,
  type ControlApiMemoryHistoryResponse,
  type ControlApiMemoryRecordDetailResponse,
  type ControlApiMemoryRecordsResponse,
  type ControlApiMemoryUseCohortsResponse,
  type ControlApiModelsResponse,
  type ControlApiPermissionsResponse,
  type ControlApiPromptDetailResponse,
  type ControlApiPromptsResponse,
  type ControlApiProvidersResponse,
  type ControlApiRoutingResponse,
  type ControlApiRuntimeResponse,
  type ControlApiSkillsResponse,
  type ControlApiToolsResponse,
  type ControlApiWorkspacesResponse,
  LOCAL_CONTROL_API_ACTOR
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
  | { readonly kind: "unreachable"; readonly message: string };

const DEFAULT_CONTROL_API_BASE_URL = "http://127.0.0.1:4101";
const CONTROL_API_TIMEOUT_MS = 5000;
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
  const timer = setTimeout(() => controller.abort(), CONTROL_API_TIMEOUT_MS);
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
 * Issues an authenticated POST against the AutoDev Control API.
 */
export async function postControlApi<T>(
  path: string,
  payload: unknown,
  config: ControlApiConfig,
  options: FetchControlApiOptions = {}
): Promise<ControlApiResult<T>> {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CONTROL_API_TIMEOUT_MS);
  const signal = options.signal ?? controller.signal;

  let response: Response;
  try {
    response = await fetchImpl(`${config.baseUrl}${path}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.serviceToken}`,
        "X-AutoDev-Actor": LOCAL_CONTROL_API_ACTOR,
        Accept: "application/json",
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload),
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
    // Non-JSON error body
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
  githubMutations: "/control/github/mutations",
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

export function fetchProviders(
  config: ControlApiConfig,
  options: FetchControlApiOptions = {}
): Promise<ControlApiResult<ControlApiProvidersResponse>> {
  return fetchControlApi<ControlApiProvidersResponse>(
    CONTROL_API_PATHS.providers,
    config,
    options
  );
}

export function fetchModels(
  config: ControlApiConfig,
  options: FetchControlApiOptions = {}
): Promise<ControlApiResult<ControlApiModelsResponse>> {
  return fetchControlApi<ControlApiModelsResponse>(
    CONTROL_API_PATHS.models,
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

export function fetchSkills(
  config: ControlApiConfig,
  options: FetchControlApiOptions = {}
): Promise<ControlApiResult<ControlApiSkillsResponse>> {
  return fetchControlApi<ControlApiSkillsResponse>(
    CONTROL_API_PATHS.skills,
    config,
    options
  );
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

export function fetchPermissions(
  config: ControlApiConfig,
  options: FetchControlApiOptions = {}
): Promise<ControlApiResult<ControlApiPermissionsResponse>> {
  return fetchControlApi<ControlApiPermissionsResponse>(
    CONTROL_API_PATHS.permissions,
    config,
    options
  );
}

export function fetchPrompts(
  config: ControlApiConfig,
  options: FetchControlApiOptions = {}
): Promise<ControlApiResult<ControlApiPromptsResponse>> {
  return fetchControlApi<ControlApiPromptsResponse>(
    CONTROL_API_PATHS.prompts,
    config,
    options
  );
}

export function fetchPromptDetail(
  name: string,
  config: ControlApiConfig,
  options: FetchControlApiOptions = {}
): Promise<ControlApiResult<ControlApiPromptDetailResponse>> {
  const path = `${CONTROL_API_PATHS.prompts}/${encodeURIComponent(name)}`;
  return fetchControlApi<ControlApiPromptDetailResponse>(path, config, options);
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

export function mutateGithubWorkflow(
  payload: GithubWorkflowMutationRequest,
  config: ControlApiConfig,
  options: FetchControlApiOptions = {}
): Promise<ControlApiResult<ControlApiGithubMutationResponse>> {
  const body: GithubWorkflowMutationRequest = {
    operation: payload.operation,
    workflow: payload.workflow,
    idempotencyKey: payload.idempotencyKey,
    ...(payload.expectedState
      ? { expectedState: payload.expectedState }
      : {})
  };
  return postControlApi<ControlApiGithubMutationResponse>(
    CONTROL_API_PATHS.githubMutations,
    body,
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

export function fetchRuntime(
  config: ControlApiConfig,
  options: FetchControlApiOptions = {}
): Promise<ControlApiResult<ControlApiRuntimeResponse>> {
  return fetchControlApi<ControlApiRuntimeResponse>(
    CONTROL_API_PATHS.runtime,
    config,
    options
  );
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
