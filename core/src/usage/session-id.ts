/**
 * Validate the exact opaque session identity the Router may attach to OTel spans.
 *
 * A session ID is trace context, not a metric dimension. It is bounded and
 * rejects path/URL content and the Router's anonymous buckets so callers can
 * safely use the result only for exact-session investigation.
 */
const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const RESERVED_SESSION_IDS = new Set([
  "unknown",
  "unattributed",
  "process-fallback",
  "process-scope"
]);

export function safeAutoDevSessionId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const sessionId = value.trim();
  if (
    !sessionId ||
    !SESSION_ID_PATTERN.test(sessionId) ||
    RESERVED_SESSION_IDS.has(sessionId.toLowerCase())
  ) {
    return null;
  }
  return sessionId;
}
