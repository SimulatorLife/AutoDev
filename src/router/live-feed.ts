export const LIVE_FEED_CATEGORIES = [
  "routing",
  "tools",
  "hooks",
  "skills",
  "mcp",
  "telemetry",
  "runtime"
] as const;

export type LiveFeedCategory = (typeof LIVE_FEED_CATEGORIES)[number];

/**
 * Per-occurrence telemetry event published to `status.liveFeed`.
 *
 * The router records one record per occurrence. Each record carries a
 * `category` and a `type` field, plus an event timestamp and any
 * category-specific detail fields (`status`, `outcome`, `durationMs`,
 * `name`, `server`, `tool`, `skill`, `hook`, `source`, `handlerType`).
 *
 * These records are the sole interval source for tool / hook / skill /
 * MCP and routing activity stats when the dashboard's Lookback selector
 * is anything other than `All`. Lifetime cumulative summaries in
 * `status.usage` and `status.codexTelemetry` are never derived from
 * per-record `lastSeenAt` fields; they remain current-state buckets
 * used unchanged for the `All` view.
 */
export interface LiveFeedEvent {
  timestamp: string;
  category: LiveFeedCategory;
  type: string;
  summary: string;
  requestId?: string | null | undefined;
  /** Internal OTel correlation; local snapshots retain it, status output strips it. */
  agent?: string | null | undefined;
  provider?: string | null | undefined;
  model?: string | null | undefined;
  role?: string | null | undefined;
  workspace?: string | null | undefined;
  phase?: string | null | undefined;
  outcome?: string | null | undefined;
  status?: string | number | null | undefined;
  failureClass?: string | null | undefined;
  denialReason?: string | null | undefined;
  spawnFailureReason?: string | null | undefined;
  durationMs?: number | null | undefined;
  durationSeconds?: number | null | undefined;
  name?: string | null | undefined;
  server?: string | null | undefined;
  source?: string | null | undefined;
  tool?: string | null | undefined;
  skill?: string | null | undefined;
  hook?: string | null | undefined;
  handlerType?: string | null | undefined;
  [key: string]: unknown;
}

export interface LiveFeedRecordInput {
  category: LiveFeedCategory;
  type: string;
  summary: string;
  timestamp?: string | null | undefined;
  requestId?: string | null | undefined;
  agent?: string | null | undefined;
  provider?: string | null | undefined;
  model?: string | null | undefined;
  role?: string | null | undefined;
  workspace?: string | null | undefined;
  phase?: string | null | undefined;
  outcome?: string | null | undefined;
  status?: string | number | null | undefined;
  failureClass?: string | null | undefined;
  denialReason?: string | null | undefined;
  spawnFailureReason?: string | null | undefined;
  durationMs?: number | null | undefined;
  durationSeconds?: number | null | undefined;
  name?: string | null | undefined;
  server?: string | null | undefined;
  source?: string | null | undefined;
  tool?: string | null | undefined;
  skill?: string | null | undefined;
  hook?: string | null | undefined;
  handlerType?: string | null | undefined;
  [key: string]: unknown;
}

const PRESERVED_SCALAR_KEYS = [
  "phase",
  "outcome",
  "status",
  "failureClass",
  "denialReason",
  "spawnFailureReason"
] as const;

const PRESERVED_TEXT_KEYS = [
  "agent",
  "name",
  "server",
  "source",
  "tool",
  "skill",
  "hook",
  "handlerType"
] as const;

function safeText(value: unknown, fallback: string): string {
  if (typeof value !== "string" || !value.trim()) return fallback;
  return value.trim().slice(0, 240);
}

function optionalText(value: unknown): string | null {
  return typeof value === "string" && value.trim()
    ? value.trim().slice(0, 240)
    : null;
}

function optionalScalar(value: unknown): string | number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return optionalText(value);
  if (typeof value === "number" && Number.isFinite(value)) return value;
  return null;
}

function optionalDuration(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  if (value < 0) return null;
  return value;
}

/**
 * Returns the optional numeric detail fields used by the dashboard's
 * Lookback aggregator. The keys are exposed so tests and other
 * producers can iterate without copying the literal list.
 */
export const LIVE_FEED_NUMERIC_KEYS = [
  "durationMs",
  "durationSeconds"
] as const;

export class LiveFeedRecorder {
  private readonly events: LiveFeedEvent[] = [];
  private readonly maxEvents: number;

  constructor(maxEvents = 500) {
    this.maxEvents =
      Number.isFinite(maxEvents) && maxEvents > 0 ? Math.floor(maxEvents) : 500;
  }

  record(input: LiveFeedRecordInput): LiveFeedEvent {
    const event: LiveFeedEvent = {
      timestamp:
        typeof input.timestamp === "string" && input.timestamp
          ? input.timestamp
          : new Date().toISOString(),
      category: input.category,
      type: safeText(input.type, "event"),
      summary: safeText(input.summary, "Live telemetry event")
    };
    for (const key of [
      "requestId",
      "provider",
      "model",
      "role",
      "workspace"
    ] as const) {
      const value = optionalText(input[key]);
      if (value !== null) event[key] = value;
    }
    for (const key of PRESERVED_TEXT_KEYS) {
      const value = optionalText(input[key]);
      if (value !== null) event[key] = value;
    }
    for (const key of PRESERVED_SCALAR_KEYS) {
      const value = optionalScalar(input[key]);
      if (value !== null) (event as Record<string, unknown>)[key] = value;
    }
    for (const key of LIVE_FEED_NUMERIC_KEYS) {
      const value = optionalDuration(input[key]);
      if (value !== null) event[key] = value;
    }
    this.events.push(event);
    while (this.events.length > this.maxEvents) this.events.shift();
    return event;
  }

  getRecentEvents(
    reversed = true,
    includeAgentCorrelation = false
  ): LiveFeedEvent[] {
    const events = reversed ? [...this.events].reverse() : [...this.events];
    if (includeAgentCorrelation) return events.map((event) => ({ ...event }));
    return events.map(({ agent: _agent, ...event }) => event);
  }

  clear(): void {
    this.events.length = 0;
  }

  restore(events: unknown[]): void {
    this.clear();
    if (!Array.isArray(events)) return;
    for (const value of events) {
      if (!value || typeof value !== "object") continue;
      const input = value as Record<string, unknown>;
      if (!LIVE_FEED_CATEGORIES.includes(input.category as LiveFeedCategory))
        continue;
      this.record({
        ...input,
        category: input.category as LiveFeedCategory,
        type: String(input.type ?? "event"),
        summary: String(input.summary ?? "Live telemetry event")
      });
    }
  }
}
