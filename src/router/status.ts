export interface RouterProviderRuntimeStatus {
  orchestratorEnabled?: boolean;
  subagentEnabled?: boolean;
  status?: string;
  orchestratorStatus?: string;
  subagentStatus?: string;
  routingPriority?: string;
  active?: number;
  inFlightRequests?: number;
  failureStreak?: number;
  probeFailureStreak?: number;
  lastFailure?: { class?: string; status?: number } | null;
  cooldownRemainingMs?: number;
  cooldownResetsAt?: string | null;
  cooldownKind?: string | null;
  cooldownFailureClass?: string | null;
  cooldownUntil?: string | null;
  lastResortEligible?: boolean;
  limits?: Record<string, unknown>;
  effectiveLimits?: unknown;
  effectiveLimit?: unknown;
  liveLimits?: unknown;
  liveLimit?: unknown;
  rateLimit?: unknown;
  configuredModels?: unknown;
  capabilities?: unknown;
}

export interface RouterRuntimeStatus {
  schema?: string;
  router?: string;
  pid?: number;
  routerInstanceId?: string;
  startedAt?: string;
  authentication?: { responseRequests?: boolean };
  routing?: {
    enabledOrchestratorProviders?: string[];
    enabledSubagentProviders?: string[];
    disabledOrchestratorProviders?: string[];
    disabledSubagentProviders?: string[];
    providerGroups?: Record<string, unknown[]>;
    priorities?: Record<string, Record<string, unknown>>;
  };
  providers?: Record<string, RouterProviderRuntimeStatus>;
  limits?: Record<string, unknown>;
  concurrency?: Record<string, unknown>;
  inFlightRequests?: Record<string, number>;
  liveActivity?: number;
  agents?: Record<string, unknown>;
  error?: unknown;
}

const RUNTIME_STATUS_KEYS = [
  "schema",
  "router",
  "pid",
  "routerInstanceId",
  "startedAt"
] as const;

const ROUTING_KEYS = [
  "enabledOrchestratorProviders",
  "enabledSubagentProviders",
  "disabledOrchestratorProviders",
  "disabledSubagentProviders",
  "providerGroups",
  "priorities"
] as const;

const PROVIDER_RUNTIME_KEYS = [
  "orchestratorEnabled",
  "subagentEnabled",
  "status",
  "orchestratorStatus",
  "subagentStatus",
  "routingPriority",
  "active",
  "inFlightRequests",
  "failureStreak",
  "probeFailureStreak",
  "lastFailure",
  "cooldownRemainingMs",
  "cooldownResetsAt",
  "cooldownKind",
  "cooldownFailureClass",
  "cooldownUntil",
  "lastResortEligible",
  "limits",
  "effectiveLimits",
  "effectiveLimit",
  "liveLimits",
  "liveLimit",
  "rateLimit",
  "configuredModels",
  "capabilities"
] as const;

const CONCURRENCY_KEYS = [
  "effectivePerSessionLimit",
  "activeSessions",
  "activeSubagentThreads",
  "denials",
  "denialsByReason",
  "lastDenial",
  "processFallbackEnforcement",
  "processFallbackActiveThreads"
] as const;

const AGENT_RUNTIME_KEYS = [
  "schema",
  "canonicalLiveCount",
  "byState",
  "liveByKind",
  "liveByRole",
  "liveByOrigin",
  "liveByProvider",
  "liveByModel",
  "liveByWorkspace",
  "missingProvider",
  "missingModel",
  "slotVsAgent",
  "reconciledWithConcurrency"
] as const;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function selectKeys(
  source: Record<string, unknown>,
  keys: readonly string[]
): Record<string, unknown> {
  return Object.fromEntries(
    keys
      .filter((key) => Object.hasOwn(source, key))
      .map((key) => [key, source[key]])
  );
}

function selectObject(
  value: unknown,
  keys: readonly string[]
): Record<string, unknown> | undefined {
  const source = asRecord(value);
  return source ? selectKeys(source, keys) : undefined;
}

function selectProviders(
  value: unknown
): Record<string, RouterProviderRuntimeStatus> | undefined {
  const source = asRecord(value);
  return source
    ? Object.fromEntries(
        Object.entries(source).map(([name, provider]) => {
          const selected = selectObject(provider, PROVIDER_RUNTIME_KEYS) ?? {};
          const providerRecord = asRecord(provider);
          const lastFailure = asRecord(providerRecord?.lastFailure);
          if (lastFailure) {
            selected.lastFailure = selectKeys(lastFailure, ["class", "status"]);
          } else if (providerRecord?.lastFailure === null) {
            selected.lastFailure = null;
          } else {
            delete selected.lastFailure;
          }
          return [name, selected as RouterProviderRuntimeStatus];
        })
      )
    : undefined;
}

/**
 * Select the operational router contract used by CLI consumers.
 * Historical usage, telemetry, and event data stays in the incumbent dashboard
 * response until that dashboard is retired; it is never part of this contract.
 */
export function parseRouterRuntimeStatus(value: unknown): RouterRuntimeStatus {
  const source = asRecord(value);
  if (!source) {
    throw new TypeError("Router status response must be a JSON object");
  }

  const status: RouterRuntimeStatus = selectKeys(
    source,
    RUNTIME_STATUS_KEYS
  ) as RouterRuntimeStatus;
  const routing = selectObject(source.routing, ROUTING_KEYS);
  const concurrency = selectObject(source.concurrency, CONCURRENCY_KEYS);
  const agents = selectObject(source.agents, AGENT_RUNTIME_KEYS);
  const error = asRecord(source.error);

  if (source.authentication && typeof source.authentication === "object") {
    const authentication = asRecord(source.authentication);
    if (
      authentication &&
      typeof authentication.responseRequests === "boolean"
    ) {
      status.authentication = {
        responseRequests: authentication.responseRequests
      };
    }
  }
  if (routing) {
    status.routing = routing as NonNullable<RouterRuntimeStatus["routing"]>;
  }
  const providers = selectProviders(source.providers);
  if (providers) status.providers = providers;
  const limits = asRecord(source.limits);
  if (limits) status.limits = { ...limits };
  if (concurrency) status.concurrency = concurrency;
  const inFlightRequests = asRecord(source.inFlightRequests);
  if (inFlightRequests) {
    status.inFlightRequests = Object.fromEntries(
      Object.entries(inFlightRequests).filter(
        (entry): entry is [string, number] => typeof entry[1] === "number"
      )
    );
  }
  if (typeof source.liveActivity === "number") {
    status.liveActivity = source.liveActivity;
  }
  if (agents) status.agents = agents;
  if (error) status.error = selectKeys(error, ["message", "code"]);

  return status;
}
