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
import path from "node:path";

import { LOCAL_CONTROL_API_ACTOR } from "@simulatorlife/autodev-core";

import type {
  ControlApiAgentDetailResponse,
  ControlApiAgentsResponse,
  ControlApiError,
  ControlApiEvaluationsResponse,
  ControlApiHooksResponse,
  ControlApiMcpsResponse,
  ControlApiModelsResponse,
  ControlApiPermissionsResponse,
  ControlApiPromptDetailResponse,
  ControlApiPromptsResponse,
  ControlApiProvidersResponse,
  ControlApiResult,
  ControlApiRoutingResponse,
  ControlApiRuntimeResponse,
  ControlApiSkillsResponse,
  ControlApiToolsResponse,
  ControlApiWorkspacesResponse
} from "./types.ts";

const DEFAULT_CONTROL_API_BASE_URL = "http://127.0.0.1:4101";
const CONTROL_API_TIMEOUT_MS = 5000;
const TRAILING_SLASHES = /\/+$/u;

export interface ControlApiConfig {
  readonly baseUrl: string;
  readonly serviceToken: string;
}

function readSecretFromFile(filePath: string, key: string): string | null {
  try {
    const content = readFileSync(filePath, "utf8");
    for (const line of content.split(/\r?\n/u)) {
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
      env.CODEX_HOME?.trim() || (home ? path.join(home, ".codex") : null);
    if (codexHome) {
      const secretFile =
        env.AUTODEV_OPENLIT_SECRET_FILE?.trim() ||
        path.join(codexHome, "openlit-secrets.env");
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
  evaluations: "/control/evaluations"
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

