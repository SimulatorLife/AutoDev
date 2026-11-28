import {
  CONTROL_API_CONTRACT,
  controlApiContractResponseSchema,
  controlApiEvaluationsResponseSchema,
  controlApiPlaytestingCapabilitiesPreflightSchema,
  controlApiPlaytestingReadinessResponseSchema,
  controlApiProviderModelsResponseSchema,
  controlApiProvidersResponseSchema,
  type ControlApiProvidersResponse,
  isRecord,
  LOCAL_CONTROL_API_ACTOR
} from "@simulatorlife/autodev-core";

const CONTROL_API_PROBE_TIMEOUT_MS = 10_000;
const DEV_PROBE_WORKSPACE_ID = "autodev-dev-probe/not-configured";

export interface ControlApiCompatibilityConfig {
  readonly baseUrl: string;
  readonly serviceToken: string;
}

export interface ControlApiWaitOptions {
  readonly timeoutMs?: number;
  readonly retryDelayMs?: number;
  readonly sleep?: (ms: number) => Promise<void>;
}

/**
The Control API did not answer.

This is the "not now" class: the endpoint could not be reached, or it
answered with a server-side failure. A stale contract and a rejected
credential are different classes again, and they are not temporary.
*/
export class ControlApiUnavailableError extends Error {
  constructor(reason: string) {
    super(
      `The configured AutoDev Control API could not be reached (${reason}). Verify AUTODEV_CONTROL_API_BASE_URL and that the Model Router's private Control API listener is running. The Console was not started.`
    );
    this.name = "ControlApiUnavailableError";
  }
}

function isControlApiContractResponse(value: unknown): boolean {
  return controlApiContractResponseSchema.safeParse(value).success;
}

function isPlaytestingCapabilitiesResponse(
  value: unknown,
  workspaceId: string
): boolean {
  const parsed =
    controlApiPlaytestingCapabilitiesPreflightSchema.safeParse(value);
  return parsed.success && parsed.data.workspaceId === workspaceId;
}

/**
The discovery response, as the shared schema states it, and the providers this
Console checkout expects to find in it.

The shape is the Core schema's, because the Console reads the same response
and the two must not read it differently. Which providers must answer is this
checkout's own question: a Runtime that serves a different set of providers is
not the Runtime this Console was written for.
*/
function isControlApiProviderModelsResponse(
  value: unknown,
  expectedProviders: ReadonlySet<string>
): boolean {
  const parsed = controlApiProviderModelsResponseSchema.safeParse(value);
  if (!parsed.success) return false;
  const providers = new Set(
    parsed.data.providers.map((entry) => entry.provider)
  );
  return (
    providers.size === expectedProviders.size &&
    expectedProviders.isSubsetOf(providers)
  );
}

function startupError(reason: string): Error {
  return new Error(
    `The configured AutoDev Control API is not compatible with this Console checkout (${reason}). The Console was not started. Refresh the Runtime with \`pnpm run install:autodev\` when no active task depends on the Model Router. For a live session, use \`bash scripts/install.sh --materialize-only\` and restart the Router later.`
  );
}

function unavailableError(reason: string): Error {
  return new ControlApiUnavailableError(reason);
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
  const isCurrentPlaytestingCapabilities = isPlaytestingCapabilitiesResponse(
    playtesting.body,
    DEV_PROBE_WORKSPACE_ID
  );
  const currentPlaytestingError =
    code.startsWith("autodev_control_playtesting_") &&
    code !== "autodev_control_playtesting_unknown_path";
  if (!isCurrentPlaytestingCapabilities && !currentPlaytestingError) {
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
  const parsedReadiness =
    controlApiPlaytestingReadinessResponseSchema.safeParse(readiness.body);
  const currentReadinessResponse =
    parsedReadiness.success &&
    parsedReadiness.data.workspaceId === DEV_PROBE_WORKSPACE_ID;
  const currentReadinessError =
    readinessCode.startsWith("autodev_control_playtesting_") &&
    readinessCode !== "autodev_control_playtesting_unknown_path";
  if (!currentReadinessResponse && !currentReadinessError) {
    throw startupError("the Playtesting readiness endpoint is missing");
  }
}

async function verifyControlApiCompatibilityOnce(
  config: ControlApiCompatibilityConfig,
  fetchImpl: typeof fetch,
  probeTimeoutMs = CONTROL_API_PROBE_TIMEOUT_MS
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
      signal: AbortSignal.timeout(Math.max(1, probeTimeoutMs))
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
  const parsedProviders = controlApiProvidersResponseSchema.safeParse(
    providers.body
  );
  if (!providers.response.ok || !parsedProviders.success) {
    throw startupError("the current Providers v5 response contract is missing");
  }
  const providerData: ControlApiProvidersResponse = parsedProviders.data;

  const providerIds = new Set(providerData.providers.map(({ id }) => id));
  await verifyProviderModelDiscovery(request, providerIds);

  await verifyPlaytestingRoutes(request);

  await verifyEvaluationsRoute(request);
}

async function verifyEvaluationsRoute(request: ControlApiProbe): Promise<void> {
  let evaluations: Awaited<ReturnType<typeof request>>;
  try {
    evaluations = await request("/control/evaluations");
  } catch {
    throw unavailableError("the Evaluations endpoint did not respond");
  }
  if (
    evaluations.response.status === 401 ||
    evaluations.response.status === 403
  ) {
    throw authorizationError();
  }
  if (evaluations.response.status >= 500) {
    throw unavailableError(
      `the Evaluations endpoint returned HTTP ${evaluations.response.status}`
    );
  }
  if (
    !evaluations.response.ok ||
    !controlApiEvaluationsResponseSchema.safeParse(evaluations.body).success
  ) {
    throw startupError(
      "the current Evaluations v1 response contract is missing"
    );
  }
}

async function verifyWithDeadline(
  config: ControlApiCompatibilityConfig,
  fetchImpl: typeof fetch,
  timeoutMs: number,
  deadline: number,
  retryDelayMs: number,
  sleepImpl: (ms: number) => Promise<void>
): Promise<void> {
  const probeTimeoutMs =
    timeoutMs > 0
      ? Math.min(
          CONTROL_API_PROBE_TIMEOUT_MS,
          Math.max(1, deadline - Date.now())
        )
      : CONTROL_API_PROBE_TIMEOUT_MS;
  try {
    await verifyControlApiCompatibilityOnce(config, fetchImpl, probeTimeoutMs);
  } catch (error) {
    if (
      !(error instanceof ControlApiUnavailableError) ||
      Date.now() >= deadline
    ) {
      throw error;
    }
    await sleepImpl(Math.min(retryDelayMs, Math.max(1, deadline - Date.now())));
    await verifyWithDeadline(
      config,
      fetchImpl,
      timeoutMs,
      deadline,
      retryDelayMs,
      sleepImpl
    );
  }
}

/**
Verify the Runtime's compatibility generation before any Console process
serves pages. The manifest is cheap and catches stale installations whose
individual endpoint schemas happen to overlap the current Console.
*/
export async function verifyControlApiCompatibility(
  config: ControlApiCompatibilityConfig,
  fetchImpl: typeof fetch = fetch,
  waitOptions: ControlApiWaitOptions = {}
): Promise<void> {
  const timeoutMs = Math.max(0, waitOptions.timeoutMs ?? 0);
  const retryDelayMs = Math.max(1, waitOptions.retryDelayMs ?? 250);
  const sleepImpl =
    waitOptions.sleep ??
    ((ms: number) =>
      new Promise<void>((resolve) => {
        setTimeout(resolve, ms);
      }));
  await verifyWithDeadline(
    config,
    fetchImpl,
    timeoutMs,
    Date.now() + timeoutMs,
    retryDelayMs,
    sleepImpl
  );
}
