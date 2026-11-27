export interface LimitHeaders {
  [name: string]: string | string[] | undefined;
}

export const LIMIT_HEADER_RESETS_AT = "x-autodev-limit-resets-at";

const DIGITS_ONLY_PATTERN = /^\d+$/;
const RESETS_IN_DURATION_PATTERN = /reset(?:s|ting)?\s+in\s+([0-9hms]+)/i;
const DURATION_COMPONENT_PATTERN = /(\d+)\s*([hms])/g;

const MS_PER_SECOND = 1000;
const MS_PER_MINUTE = 60 * MS_PER_SECOND;
const MS_PER_HOUR = 60 * MS_PER_MINUTE;

function epochToMs(epoch: number): number {
  return epoch > 1e11 ? epoch : epoch * 1000;
}

function resetTimeMs(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value))
    return epochToMs(value);
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (DIGITS_ONLY_PATTERN.test(trimmed)) return epochToMs(Number(trimmed));
  const parsed = Date.parse(trimmed);
  return Number.isNaN(parsed) ? null : parsed;
}

/**
Normalize a provider-supplied reset time to an ISO-8601 UTC string. Providers
state it as epoch seconds, epoch milliseconds, or an ISO string depending on
which CLI produced it. Anything unparseable is dropped rather than guessed:
a wrong reset time is worse than none, because the router trusts it.
*/
export function normalizeResetsAt(value: unknown): string | null {
  const ms = resetTimeMs(value);
  if (ms === null || !Number.isFinite(ms)) return null;
  const date = new Date(ms);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/**
Milliseconds in a stated window such as `24m43s` or `14h23m32s`, or null when
it names no window.
*/
function durationMsFromWindow(window: string): number | null {
  let total = 0;
  let components = 0;
  for (const [, digits, unit] of window.matchAll(DURATION_COMPONENT_PATTERN)) {
    const amount = Number(digits);
    if (!Number.isFinite(amount)) return null;
    const multiplier =
      unit === "h" ? MS_PER_HOUR : unit === "m" ? MS_PER_MINUTE : MS_PER_SECOND;
    total += amount * multiplier;
    components += 1;
  }
  return components > 0 && total > 0 ? total : null;
}

/**
The absolute reset time a stated duration lands on, or null when none is stated.
*/
export function resetsAtFromDuration(text: string, now: number): string | null {
  const window = RESETS_IN_DURATION_PATTERN.exec(text)?.[1];
  if (!window) return null;
  const durationMs = durationMsFromWindow(window);
  if (durationMs === null) return null;
  return new Date(now + durationMs).toISOString();
}

function headerReader(headers: unknown): ((name: string) => unknown) | null {
  if (!headers || typeof headers !== "object") return null;
  const get = (headers as { get?: unknown }).get;
  if (typeof get === "function")
    return (name) => (get as (key: string) => unknown).call(headers, name);
  const record = headers as LimitHeaders;
  return (name) => {
    const key = Object.keys(record).find(
      (candidate: string) => candidate.toLowerCase() === name
    );
    return key === undefined ? undefined : record[key];
  };
}

/**
Case-insensitive reader for a single trimmed header value.
*/
export function headerValue(headers: unknown, name: string): string | null {
  const read = headerReader(headers);
  if (!read) return null;
  const raw = read(name);
  const single = Array.isArray(raw) ? raw[0] : raw;
  return typeof single === "string" && single.trim() ? single.trim() : null;
}

function parseRelativeSecondsReset(
  raw: string | null,
  now: number
): string | null {
  if (!raw) return null;
  const seconds = Number(raw);
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  return new Date(now + Math.ceil(seconds * MS_PER_SECOND)).toISOString();
}

function parseRetryAfter(raw: string | null, now: number): string | null {
  if (!raw) return null;
  const relative = parseRelativeSecondsReset(raw, now);
  if (relative) return relative;
  const parsed = Date.parse(raw);
  return Number.isNaN(parsed) ? null : new Date(parsed).toISOString();
}

function resetFromRateLimitHeader(
  raw: string | null,
  now: number
): string | null {
  if (!raw) return null;
  const lower = raw.toLowerCase();
  if (lower.endsWith("ms")) {
    const ms = Number(lower.slice(0, -2));
    return Number.isFinite(ms) && ms > 0
      ? new Date(now + Math.ceil(ms)).toISOString()
      : null;
  }
  const durationMs = durationMsFromWindow(lower);
  if (durationMs !== null) return new Date(now + durationMs).toISOString();
  return normalizeResetsAt(raw);
}

function codexWindowReset(
  headers: unknown,
  window: "primary" | "secondary",
  now: number
): string | null {
  return (
    normalizeResetsAt(headerValue(headers, `x-codex-${window}-reset-at`)) ??
    parseRelativeSecondsReset(
      headerValue(headers, `x-codex-${window}-reset-after-seconds`),
      now
    )
  );
}

/**
Extract the earliest actionable reset timestamp from AutoDev, Codex/ChatGPT,
OpenAI, or standard HTTP `Retry-After` response headers.
*/
export function readResetAtFromHeaders(
  headers: unknown,
  now = Date.now()
): string | null {
  const explicit = normalizeResetsAt(
    headerValue(headers, LIMIT_HEADER_RESETS_AT)
  );
  if (explicit) return explicit;
  const secondaryPct = Number(
    headerValue(headers, "x-codex-secondary-used-percent") ?? 0
  );
  const primaryPct = Number(
    headerValue(headers, "x-codex-primary-used-percent") ?? 0
  );
  const windows: readonly ("primary" | "secondary")[] =
    secondaryPct >= 100 && primaryPct < 100
      ? ["secondary", "primary"]
      : ["primary", "secondary"];
  for (const window of windows) {
    const reset = codexWindowReset(headers, window, now);
    if (reset) return reset;
  }
  return (
    parseRetryAfter(headerValue(headers, "retry-after"), now) ??
    resetFromRateLimitHeader(
      headerValue(headers, "x-ratelimit-reset-requests"),
      now
    ) ??
    resetFromRateLimitHeader(
      headerValue(headers, "x-ratelimit-reset-tokens"),
      now
    )
  );
}
