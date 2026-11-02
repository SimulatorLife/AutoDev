/**
 * The one owner of how Data speaks to ClickHouse.
 *
 * A caller binds its values into the statement and hands it over; this module
 * builds the request -- the URL, the content type, the ceiling on how long the
 * request may wait, and the error raised when ClickHouse says no. Nobody
 * assembles a URL, picks a content type, or words an error of their own.
 *
 * The earlier shape of this module was a second owner as much as a first one.
 * The OpenLIT projection adapters each wanted to read a table, index or group
 * what came back, append rows, and delete the rows that fell out of the
 * catalog, so each one grew its own private copies of those four operations
 * -- and the two copies of the same read ended up reporting a failed read with
 * two different sentences. Those helpers are gone with the adapters that were
 * the last thing to use them.
 *
 * What remains is the statement runner, and the two things that both halves of
 * Data need to know: the default endpoint, and the ceiling. The provider and
 * model catalog projection is the one caller with a protocol of its own: it
 * reads `FORMAT JSONEachRow` and writes `application/x-ndjson` without a
 * trailing newline, because those are the tables' own shapes. It still comes
 * through here for the request itself, so there is exactly one place that
 * knows how a ClickHouse request is made.
 *
 * `ClickHouseTelemetryClient` stays here too: it builds trace queries against
 * the same server, and the default endpoint is knowledge both halves need.
 */

import { withClickHouseConnectionRetry } from "./retry.ts";

/** The ClickHouse endpoint used when nothing else names one. */
export const DEFAULT_CLICKHOUSE_URL = "http://127.0.0.1:8123";

/**
 * Ceiling for one ClickHouse request.
 *
 * ClickHouse answers on the loopback interface, so a request that has not
 * come back within this window is not a slow query: the server is wedged or
 * the host is too loaded to schedule it. Without a ceiling the request waits
 * forever, and the caller waits with it -- which is how a `pnpm run dev` that
 * has an unresponsive ClickHouse hangs on a catalog sync instead of failing
 * with the reason.
 */
export const DEFAULT_CLICKHOUSE_REQUEST_TIMEOUT_MS = 30_000;

/**
 * A request signal that aborts after `timeoutMs`.
 *
 * `null` rather than `undefined` because `exactOptionalPropertyTypes` treats
 * an explicit `undefined` as incompatible with `signal?: AbortSignal | null`,
 * and `null` is what `fetch` reads as "no signal".
 */
function requestSignal(timeoutMs: number): AbortSignal | null {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return null;
  return AbortSignal.timeout(timeoutMs);
}

/** Options every ClickHouse request accepts. */
export interface ClickHouseRequestOptions {
  /**
   * Ceiling for the request in milliseconds. Defaults to
   * `DEFAULT_CLICKHOUSE_REQUEST_TIMEOUT_MS`; a non-positive value disables
   * the ceiling.
   */
  readonly timeoutMs?: number;
}

export interface ParameterizedQuery {
  readonly query: string;
  readonly params: Record<string, string | number | boolean>;
}

export class ClickHouseTelemetryClient {
  readonly endpoint: string;

  constructor(endpoint = DEFAULT_CLICKHOUSE_URL) {
    this.endpoint = endpoint;
  }

  buildTraceQuery(options: {
    serviceName: string;
    startTime: string;
    endTime: string;
    limit?: number;
    filters?: Record<string, string>;
  }): ParameterizedQuery {
    const params: Record<string, string | number | boolean> = {
      service: options.serviceName,
      start: options.startTime,
      end: options.endTime,
      limit: options.limit ?? 100
    };

    let query =
      "SELECT TraceId, SpanId, SpanName, Duration, StatusCode, ServiceName " +
      "FROM otel_traces WHERE ServiceName = {service:String} " +
      "AND Timestamp >= {start:DateTime64} AND Timestamp <= {end:DateTime64}";

    if (options.filters) {
      let filterIndex = 0;
      for (const [key, value] of Object.entries(options.filters)) {
        const paramKey = `f_${filterIndex}`;
        params[paramKey] = value;
        query += ` AND SpanAttributes['${key}'] = {${paramKey}:String}`;
        filterIndex += 1;
      }
    }

    query += " ORDER BY Timestamp DESC LIMIT {limit:UInt32}";

    return { query, params };
  }
}

/**
 * A single bound ClickHouse query parameter value.
 *
 * Every caller that needs a user-, filter- or cursor-derived value inside a
 * SQL statement binds it through `param_<name>` on the request and
 * `{<name>:<Type>}` inside the query text instead of splicing the value into
 * the query string. That is the one path "no user values in SQL text" can be
 * verified against; a second ad hoc interpolation site would reopen the gap
 * this helper exists to close.
 */
export type ClickHouseParamValue = string | number | boolean;

function clickHouseParamLiteral(value: ClickHouseParamValue): string {
  if (typeof value === "boolean") return value ? "1" : "0";
  return String(value);
}

/** Raised when a parameterized ClickHouse statement itself fails. */
export class ClickHouseStatementError extends Error {
  readonly status: number;

  constructor(status: number, body: string) {
    super(`ClickHouse statement failed (${status}): ${body}`);
    this.name = "ClickHouseStatementError";
    this.status = status;
  }
}

/**
 * Run one parameterized ClickHouse statement (DDL, SELECT, INSERT or ALTER)
 * and return the raw response body.
 *
 * `query` must be a fixed string built only from this module's own table and
 * column identifiers; every value that varies by caller or request travels as
 * a named `params` entry bound through ClickHouse's native `{name:Type}`
 * placeholder syntax, never through string interpolation into `query`.
 *
 * `contentType` names the media type of `body`. It defaults to
 * `application/json` because that is what a JSON body is, but a caller whose
 * table expects newline-delimited JSON says `application/x-ndjson` instead --
 * the catalog projection writes the provider and model tables that way. The
 * content type belongs here rather than in the caller: it is part of how the
 * request is made, and a second place that decides it is a second way for the
 * request to be wrong.
 */
export function runParameterizedClickHouseStatement(
  endpoint: string,
  query: string,
  params: Readonly<Record<string, ClickHouseParamValue>> = {},
  options: {
    readonly fetchImpl?: typeof fetch;
    readonly body?: string;
    readonly contentType?: string;
    readonly timeoutMs?: number;
  } = {}
): Promise<string> {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const url = new URL(endpoint);
  url.searchParams.set("query", query);
  for (const [name, value] of Object.entries(params)) {
    url.searchParams.set(`param_${name}`, clickHouseParamLiteral(value));
  }
  const maxRetries = 2;
  return withClickHouseConnectionRetry(
    async () => {
      const res = await fetchImpl(url.toString(), {
        method: "POST",
        ...(options.body === undefined
          ? {}
          : {
              headers: {
                "Content-Type": options.contentType ?? "application/json"
              },
              body: options.body
            }),
        signal: requestSignal(
          options.timeoutMs ?? DEFAULT_CLICKHOUSE_REQUEST_TIMEOUT_MS
        )
      });
      if (!res.ok) {
        const failureBody = await res.text();
        throw new ClickHouseStatementError(res.status, failureBody);
      }
      // The body is read inside the attempt so a truncated response is
      // retried with the request rather than surfaced as a partial result.
      // The promise is returned rather than awaited: the retry helper awaits
      // the attempt itself, so a truncated read still fails the attempt.
      return res.text();
    },
    { maxRetries }
  );
}
