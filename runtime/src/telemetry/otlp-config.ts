/**
 * The one owner of AutoDev's OTLP exporter configuration.
 *
 * Two producers install the official OTLP HTTP exporter: the Router
 * (`runtime/src/router/telemetry.ts`) and the MCP tool filter
 * (`runtime/src/mcp/mcp-telemetry.ts`). They are separate
 * processes with separate span sets, but they read the same operator-facing
 * environment: a base endpoint or a signal-specific endpoint, plus the
 * credential-bearing headers that authenticate the export.
 *
 * Each producer used to parse that environment for itself. A copy that
 * disagreed with the other -- one resolving `/v1/traces` and the other not,
 * one accepting a header and the other dropping it -- would have surfaced
 * only as a signal that reached the collector from one producer and never
 * from the other, with nothing in either process able to explain why.
 *
 * This module owns the reading and nothing else: it resolves endpoints and
 * parses headers. What a producer does with the result -- which resource it
 * attaches, which spans it emits, how it degrades when the exporter cannot be
 * built -- stays with that producer.
 */

const TRAILING_SLASH_PATTERN = /\/$/u;
const SIGNAL_ENDPOINT_SUFFIX_PATTERN = /\/v1\/(?:traces|metrics|logs)$/u;

/** The OTLP signals AutoDev exports. */
export type OtlpSignal = "traces" | "metrics";

/**
 * Resolve the OTLP endpoint for one signal from a base collector URL.
 *
 * A base URL that already names a signal path (`/v1/logs`) is rewritten to
 * the requested signal; anything else gets `/v1/<signal>` appended. A value
 * that is not a URL at all has no endpoint, so the caller exports nothing
 * rather than exporting to a broken destination.
 */
export function resolveOtlpSignalEndpoint(
  base: string,
  signal: OtlpSignal
): string | null {
  try {
    const endpoint = new URL(base);
    const path = endpoint.pathname.replace(TRAILING_SLASH_PATTERN, "");
    endpoint.pathname = SIGNAL_ENDPOINT_SUFFIX_PATTERN.test(path)
      ? path.replace(SIGNAL_ENDPOINT_SUFFIX_PATTERN, `/v1/${signal}`)
      : `${path}/v1/${signal}`;
    return endpoint.toString();
  } catch {
    return null;
  }
}

/**
 * The endpoint traces are exported to: the signal-specific variable when it
 * is set, otherwise the base endpoint resolved for traces.
 */
export function readOtlpTraceEndpoint(
  env: NodeJS.ProcessEnv = process.env
): string | null {
  const specific = env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT?.trim();
  if (specific) return specific;
  const base = env.OTEL_EXPORTER_OTLP_ENDPOINT?.trim();
  return base ? resolveOtlpSignalEndpoint(base, "traces") : null;
}

/**
 * The endpoint metrics are exported to: the signal-specific variable when it
 * is set, otherwise the base endpoint resolved for metrics.
 */
export function readOtlpMetricEndpoint(
  env: NodeJS.ProcessEnv = process.env
): string | null {
  const specific = env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT?.trim();
  if (specific) return specific;
  const base = env.OTEL_EXPORTER_OTLP_ENDPOINT?.trim();
  return base ? resolveOtlpSignalEndpoint(base, "metrics") : null;
}

/**
 * Parse the `key=value` header lists the OTLP exporter reads.
 *
 * Values are percent-decoded when they decode cleanly and kept verbatim when
 * they do not, so a header whose value contains a stray `%` still reaches the
 * collector rather than being dropped.
 */
export function parseOtlpHeaders(
  ...sources: Array<string | undefined>
): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const source of sources) {
    if (!source) continue;
    for (const item of source.split(",")) {
      const separator = item.indexOf("=");
      if (separator <= 0) continue;
      const key = item.slice(0, separator).trim();
      const encodedValue = item.slice(separator + 1).trim();
      if (!key || !encodedValue) continue;
      try {
        headers[key] = decodeURIComponent(encodedValue);
      } catch {
        headers[key] = encodedValue;
      }
    }
  }
  return headers;
}

/**
 * The headers one signal is exported with: the shared OTLP headers plus the
 * headers that name that signal specifically. The signal-specific list wins
 * on a key both of them carry.
 */
export function readOtlpHeaders(
  signal: OtlpSignal,
  env: NodeJS.ProcessEnv = process.env
): Record<string, string> {
  return parseOtlpHeaders(
    env.OTEL_EXPORTER_OTLP_HEADERS,
    signal === "traces"
      ? env.OTEL_EXPORTER_OTLP_TRACES_HEADERS
      : env.OTEL_EXPORTER_OTLP_METRICS_HEADERS
  );
}
