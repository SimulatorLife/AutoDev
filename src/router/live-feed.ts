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

export interface LiveFeedEvent {
  timestamp: string;
  category: LiveFeedCategory;
  type: string;
  summary: string;
  requestId?: string | null | undefined;
  provider?: string | null | undefined;
  model?: string | null | undefined;
  role?: string | null | undefined;
  workspace?: string | null | undefined;
  [key: string]: unknown;
}

export interface LiveFeedRecordInput {
  category: LiveFeedCategory;
  type: string;
  summary: string;
  timestamp?: string | null | undefined;
  requestId?: string | null | undefined;
  provider?: string | null | undefined;
  model?: string | null | undefined;
  role?: string | null | undefined;
  workspace?: string | null | undefined;
  [key: string]: unknown;
}

function safeText(value: unknown, fallback: string): string {
  if (typeof value !== "string" || !value.trim()) return fallback;
  return value.trim().slice(0, 240);
}

function optionalText(value: unknown): string | null {
  return typeof value === "string" && value.trim()
    ? value.trim().slice(0, 240)
    : null;
}

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
    this.events.push(event);
    while (this.events.length > this.maxEvents) this.events.shift();
    return event;
  }

  getRecentEvents(reversed = true): LiveFeedEvent[] {
    return reversed ? [...this.events].reverse() : [...this.events];
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
