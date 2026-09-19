export type RouterCountMap = Record<string, number>;

export interface RouterProviderStatus {
  enabled?: boolean;
  status?: string;
  routingPriority?: string;
  active?: number;
  inFlightRequests?: number;
  attempts?: number;
  successes?: number;
  failures?: number;
  failureStreak?: number;
  probeFailureStreak?: number;
  lastFailure?: { class?: string; status?: number };
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
  [key: string]: unknown;
}

export interface RouterStatus {
  schema?: string;
  router?: string;
  pid?: number;
  routerInstanceId?: string;
  startedAt?: string;
  routing?: {
    enabledProviders?: string[];
    disabledProviders?: string[];
    providerGroups?: Record<string, unknown[]>;
    priorities?: Record<string, Record<string, unknown>>;
    [key: string]: unknown;
  };
  providers?: Record<string, RouterProviderStatus>;
  limits?: Record<string, unknown>;
  subagents?: {
    recent?: Array<Record<string, unknown>>;
    total?: number;
    byMechanism?: RouterCountMap;
    byProvider?: RouterCountMap;
    byRole?: RouterCountMap;
    byStatus?: RouterCountMap;
    spawnCapableProviders?: string[];
    codexNativeSpawns?: number;
    [key: string]: unknown;
  };
  spawnFailures?: {
    total?: number;
    byReason?: RouterCountMap;
    [key: string]: unknown;
  };
  usage?: {
    byOrigin?: Record<string, Record<string, unknown>>;
    byRole?: Record<string, Record<string, unknown>>;
    byModel?: Record<string, Record<string, unknown>>;
    [key: string]: unknown;
  };
  concurrency?: Record<string, unknown>;
  inFlightRequests?: Record<string, number>;
  codexTelemetry?: Record<string, unknown>;
  recentEvents?: Array<Record<string, unknown>>;
  [key: string]: unknown;
}

function asStatus(value: unknown): RouterStatus {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Router status response must be a JSON object");
  }
  return value as RouterStatus;
}

/** Establishes the typed boundary at the legacy router's JSON response. */
export function parseRouterStatus(value: unknown): RouterStatus {
  return asStatus(value);
}

/** Serializes a status response without changing the legacy wire shape. */
export function serializeRouterStatus(status: RouterStatus): string {
  return JSON.stringify(status, null, 2);
}
