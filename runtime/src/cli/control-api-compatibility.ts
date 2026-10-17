import {
  CONTROL_API_CONTRACT,
  CONTROL_API_PLAYTESTING_READINESS_SCHEMA,
  LOCAL_CONTROL_API_ACTOR
} from "@simulatorlife/autodev-core";

const CONTROL_API_PROBE_TIMEOUT_MS = 5000;
const DEV_PROBE_WORKSPACE_ID = "autodev-dev-probe/not-configured";
const CONTROL_API_PROVIDER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const CONTROL_API_MODEL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/u;

export interface ControlApiCompatibilityConfig {
  readonly baseUrl: string;
  readonly serviceToken: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isControlApiContractResponse(value: unknown): boolean {
  return (
    isRecord(value) &&
    value.schema === CONTROL_API_CONTRACT.schema &&
    value.version === CONTROL_API_CONTRACT.version
  );
}

function isControlApiProvidersResponse(value: unknown): value is {
  readonly schema: "autodev-control-providers-v2";
  readonly providers: readonly {
    readonly id: string;
    readonly links: {
      readonly usage: string | null;
      readonly documentation: string | null;
    };
  }[];
} {
  if (
    !isRecord(value) ||
    value.schema !== "autodev-control-providers-v2" ||
    !Array.isArray(value.providers)
  ) {
    return false;
  }
  const providerIds = new Set<string>();
  for (const provider of value.providers) {
    if (
      !isRecord(provider) ||
      typeof provider.id !== "string" ||
      provider.id.trim() !== provider.id ||
      provider.id.length === 0 ||
      providerIds.has(provider.id) ||
      !isRecord(provider.links) ||
      (provider.links.usage !== null &&
        typeof provider.links.usage !== "string") ||
      (provider.links.documentation !== null &&
        typeof provider.links.documentation !== "string")
    ) {
      return false;
    }
    providerIds.add(provider.id);
  }
  return true;
}

function isPlaytestingCapabilitiesResponse(
  value: unknown,
  workspaceId: string
): boolean {
  if (
    !isRecord(value) ||
    value.schema !== "autodev-control-playtesting-capabilities-v2" ||
    value.workspaceId !== workspaceId ||
    !isRecord(value.modeReadiness)
  ) {
    return false;
  }
  for (const mode of [
    "adapter-accelerated",
    "autonomous-visual",
    "scripted-regression"
  ] as const) {
    const readiness = value.modeReadiness[mode];
    if (
      !isRecord(readiness) ||
      (readiness.status !== "ready" &&
        readiness.status !== "check-required" &&
        readiness.status !== "unavailable") ||
      !Array.isArray(readiness.reasons)
    ) {
      return false;
    }
  }
  const visual = value.modeReadiness["autonomous-visual"];
  return (
    isRecord(visual) &&
    (visual.targetStore === "available" ||
      visual.targetStore === "unavailable") &&
    Array.isArray(visual.targets)
  );
}

function isCanonicalTimestamp(value: unknown): value is string {
  return (
    typeof value === "string" &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString() === value
  );
}

function isDiscoveryModel(value: unknown): boolean {
  if (
    !isRecord(value) ||
    typeof value.id !== "string" ||
    value.id.trim() !== value.id ||
    !CONTROL_API_MODEL_ID_PATTERN.test(value.id) ||
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

function areDiscoveryModels(value: unknown): boolean {
  if (!Array.isArray(value)) return false;
  const modelIds = new Set<string>();
  for (const model of value) {
    if (!isDiscoveryModel(model) || modelIds.has(model.id)) return false;
    modelIds.add(model.id);
  }
  return true;
}

function isProviderDiscovery(value: unknown): boolean {
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
    !areDiscoveryModels(value.models)
  ) {
    return false;
  }
  if (
    value.status === "stale" &&
    (typeof value.reason !== "string" || value.reason.trim().length === 0)
  ) {
    return false;
  }
  return true;
}

function isProviderDiscoveryEntry(value: unknown): value is {
  provider: string;
  discovery: unknown;
} {
  return (
    isRecord(value) &&
    typeof value.provider === "string" &&
    value.provider.trim() === value.provider &&
    value.provider.length > 0 &&
    CONTROL_API_PROVIDER_ID_PATTERN.test(value.provider) &&
    isProviderDiscovery(value.discovery)
  );
}

function isControlApiProviderModelsResponse(
  value: unknown,
  expectedProviders: ReadonlySet<string>
): boolean {
  if (
    !isRecord(value) ||
    value.schema !== "autodev-control-provider-model-discovery-v1" ||
    value.source !== "runtime-provider-discovery" ||
    !Array.isArray(value.providers)
  ) {
    return false;
  }
  const providers = new Set<string>();
  for (const entry of value.providers) {
    if (!isProviderDiscoveryEntry(entry) || providers.has(entry.provider)) {
      return false;
    }
    providers.add(entry.provider);
  }
  return (
    providers.size === expectedProviders.size &&
    [...expectedProviders].every((provider) => providers.has(provider))
  );
}

function startupError(reason: string): Error {
  return new Error(
    `The configured AutoDev Control API is not compatible with this Console checkout (${reason}). The Console was not started. Refresh the Runtime with \`pnpm run install:codex\` when no active task depends on the Model Router. For a live session, use \`bash scripts/install.sh --materialize-only\` and restart the Router later.`
  );
}

function unavailableError(reason: string): Error {
  return new Error(
    `The configured AutoDev Control API could not be reached (${reason}). Verify AUTODEV_CONTROL_API_BASE_URL and that the Model Router's private Control API listener is running. The Console was not started.`
  );
}

function authorizationError(): Error {
  return new Error(
    "The AutoDev Control API rejected the Console service credential or local actor. Verify AUTODEV_CONTROL_API_TOKEN and the Runtime actor allowlists. The Console was not started."
  );
}

interface ControlApiProbeResponse {
  readonly response: Response;
  readonly body: unknown;
}

type ControlApiProbe = (
  pathAndQuery: string
) => Promise<ControlApiProbeResponse>;

async function verifyProviderModelDiscovery(
  request: ControlApiProbe,
  expectedProviders: ReadonlySet<string>
): Promise<void> {
  let result: ControlApiProbeResponse;
  try {
    result = await request("/control/provider-models");
  } catch {
    throw unavailableError(
      "the provider-model discovery endpoint did not respond"
    );
  }
  if (result.response.status === 401 || result.response.status === 403) {
    throw authorizationError();
  }
  if (result.response.status >= 500) {
    throw unavailableError(
      `the provider-model discovery endpoint returned HTTP ${result.response.status}`
    );
  }
  if (
    !result.response.ok ||
    !isControlApiProviderModelsResponse(result.body, expectedProviders)
  ) {
    throw startupError(
      "the provider-model discovery response contract is missing"
    );
  }
}

async function verifyPlaytestingRoutes(
  request: ControlApiProbe
): Promise<void> {
  const playtestingQuery = new URLSearchParams({
    workspaceId: DEV_PROBE_WORKSPACE_ID
  });
  let playtesting: Awaited<ReturnType<typeof request>>;
  try {
    playtesting = await request(
      `/control/playtesting/capabilities?${playtestingQuery.toString()}`
    );
  } catch {
    throw unavailableError(
      "the workspace-scoped Playtesting endpoint did not respond"
    );
  }
  if (
    playtesting.response.status === 401 ||
    playtesting.response.status === 403
  ) {
    throw authorizationError();
  }
  const apiError =
    isRecord(playtesting.body) && isRecord(playtesting.body.error)
      ? playtesting.body.error
      : null;
  const code =
    apiError && typeof apiError.code === "string" ? apiError.code : "";
  const currentPlaytestingCapabilities = isPlaytestingCapabilitiesResponse(
    playtesting.body,
    DEV_PROBE_WORKSPACE_ID
  );
  const currentPlaytestingError =
    code.startsWith("autodev_control_playtesting_") &&
    code !== "autodev_control_playtesting_unknown_path";
  if (!currentPlaytestingCapabilities && !currentPlaytestingError) {
    throw startupError("the workspace-scoped Playtesting routes are missing");
  }

  let readiness: Awaited<ReturnType<typeof request>>;
  try {
    readiness = await request(
      `/control/playtesting/readiness?${playtestingQuery.toString()}`
    );
  } catch {
    throw unavailableError(
      "the Playtesting readiness endpoint did not respond"
    );
  }
  if (readiness.response.status === 401 || readiness.response.status === 403) {
    throw authorizationError();
  }
  const readinessError =
    isRecord(readiness.body) && isRecord(readiness.body.error)
      ? readiness.body.error
      : null;
  const readinessCode =
    readinessError && typeof readinessError.code === "string"
      ? readinessError.code
      : "";
  const currentReadinessResponse =
    isRecord(readiness.body) &&
    readiness.body.schema === CONTROL_API_PLAYTESTING_READINESS_SCHEMA &&
    readiness.body.workspaceId === DEV_PROBE_WORKSPACE_ID &&
    (readiness.body.status === "initializing" ||
      readiness.body.status === "ready");
  const currentReadinessError =
    readinessCode.startsWith("autodev_control_playtesting_") &&
    readinessCode !== "autodev_control_playtesting_unknown_path";
  if (!currentReadinessResponse && !currentReadinessError) {
    throw startupError("the Playtesting readiness endpoint is missing");
  }
}

/**
 * Verify the Runtime's compatibility generation before any Console process
 * serves pages. The manifest is cheap and catches stale installations whose
 * individual endpoint schemas happen to overlap the current Console.
 */
export async function verifyControlApiCompatibility(
  config: ControlApiCompatibilityConfig,
  fetchImpl: typeof fetch = globalThis.fetch
): Promise<void> {
  const headers = {
    Authorization: `Bearer ${config.serviceToken}`,
    "X-AutoDev-Actor": LOCAL_CONTROL_API_ACTOR,
    Accept: "application/json"
  };
  const request: ControlApiProbe = async (pathAndQuery) => {
    const response = await fetchImpl(`${config.baseUrl}${pathAndQuery}`, {
      method: "GET",
      headers,
      signal: AbortSignal.timeout(CONTROL_API_PROBE_TIMEOUT_MS)
    });
    return {
      response,
      body: await response.json().catch(() => null)
    };
  };

  let contract: Awaited<ReturnType<typeof request>>;
  try {
    contract = await request(CONTROL_API_CONTRACT.path);
  } catch {
    throw unavailableError("the Control API contract endpoint did not respond");
  }
  if (contract.response.status === 401 || contract.response.status === 403) {
    throw authorizationError();
  }
  if (contract.response.status >= 500) {
    throw unavailableError(
      `the Control API contract endpoint returned HTTP ${contract.response.status}`
    );
  }
  if (contract.response.status === 404) {
    throw startupError(
      `the Control API contract endpoint returned HTTP 404; expected ${CONTROL_API_CONTRACT.schema} version ${String(CONTROL_API_CONTRACT.version)}`
    );
  }
  if (!contract.response.ok || !isControlApiContractResponse(contract.body)) {
    throw startupError(
      "the current Control API contract revision is missing or stale"
    );
  }

  let providers: Awaited<ReturnType<typeof request>>;
  try {
    providers = await request("/control/providers");
  } catch {
    throw unavailableError("the Providers endpoint did not respond");
  }
  if (providers.response.status === 401 || providers.response.status === 403) {
    throw authorizationError();
  }
  if (providers.response.status >= 500) {
    throw unavailableError(
      `the Providers endpoint returned HTTP ${providers.response.status}`
    );
  }
  const providerData = providers.body;
  if (!providers.response.ok || !isControlApiProvidersResponse(providerData)) {
    throw startupError("the current Providers v2 response contract is missing");
  }

  const providerIds = new Set(providerData.providers.map(({ id }) => id));
  await verifyProviderModelDiscovery(request, providerIds);

  await verifyPlaytestingRoutes(request);
}
