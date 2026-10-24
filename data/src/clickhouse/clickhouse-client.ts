/**
 * The one owner of how Data speaks to ClickHouse.
 *
 * Every OpenLIT projection adapter needs the same four things: read the rows a
 * table already holds, index or group them, append new ones, and delete the ones
 * that fell out of the catalog. Each of those was written out again inside the
 * second adapter that needed it, which is how the agents and prompts adapters
 * ended up with five near-identical private functions each -- and how the two
 * copies of `fetchExistingVersions` came to report a failed read with two
 * different sentences.
 *
 * These helpers own the request instead. An adapter supplies the table names,
 * the columns it cares about, and the rows it computed; it never assembles a
 * URL, chooses a content type, or formats an error.
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

/** Run a `SELECT … FORMAT JSON` and return the rows ClickHouse sent back. */
export async function selectRows<Row>(
  endpoint: string,
  table: string,
  columns: readonly string[],
  options: ClickHouseRequestOptions = {}
): Promise<Row[]> {
  const query = `SELECT ${columns.join(", ")} FROM ${table} FORMAT JSON`;
  const res = await fetch(`${endpoint}&query=${encodeURIComponent(query)}`, {
    method: "GET",
    signal: requestSignal(
      options.timeoutMs ?? DEFAULT_CLICKHOUSE_REQUEST_TIMEOUT_MS
    )
  });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(
      `Failed to query ${table} from ClickHouse (${res.status}): ${errText}`
    );
  }
  const json = (await res.json()) as { data?: Row[] };
  return json.data || [];
}

/** Index rows by a key, so the last row ClickHouse returned for a key wins. */
export function indexRowsBy<Row>(
  rows: readonly Row[],
  keyOf: (row: Row) => string
): Map<string, Row> {
  const map = new Map<string, Row>();
  for (const row of rows) map.set(keyOf(row), row);
  return map;
}

/** Group rows by a key, keeping them in the order ClickHouse returned them. */
export function groupRowsBy<Row>(
  rows: readonly Row[],
  keyOf: (row: Row) => string
): Map<string, Row[]> {
  const map = new Map<string, Row[]>();
  for (const row of rows) {
    const key = keyOf(row);
    const list = map.get(key) || [];
    list.push(row);
    map.set(key, list);
  }
  return map;
}

/**
 * Append rows to a table as newline-delimited JSON.
 *
 * The trailing newline is load-bearing rather than tidy: `JSONEachRow` reads one
 * line per row, and the final terminator is what tells it the last row is
 * complete.
 */
export async function insertRows<Row>(
  endpoint: string,
  table: string,
  rows: readonly Row[],
  options: ClickHouseRequestOptions = {}
): Promise<void> {
  if (rows.length === 0) return;
  const body = rows.map((row) => JSON.stringify(row)).join("\n") + "\n";
  const res = await fetch(
    `${endpoint}&query=${encodeURIComponent(
      `INSERT INTO ${table} FORMAT JSONEachRow`
    )}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
      signal: requestSignal(
        options.timeoutMs ?? DEFAULT_CLICKHOUSE_REQUEST_TIMEOUT_MS
      )
    }
  );
  if (!res.ok) {
    throw new Error(`Failed to bulk insert into ${table}: ${await res.text()}`);
  }
}

/**
 * Where a projection's stale rows live, and what to report as removed.
 *
 * Versions go first because the summary row is the one that names them, and the
 * key column is spelled out per table because an adapter is free to name the
 * same row differently in its child and parent tables.
 */
export interface StaleRowProjection<Row> {
  readonly versionsTable: string;
  readonly versionsKeyColumn: string;
  readonly summaryTable: string;
  readonly summaryKeyColumn: string;
  readonly keyOf: (row: Row) => string;
  readonly labelOf: (row: Row) => string;
}

async function deleteWhereKeyIn(
  endpoint: string,
  table: string,
  keyColumn: string,
  keys: string,
  options: ClickHouseRequestOptions = {}
): Promise<void> {
  await fetch(
    `${endpoint}&query=${encodeURIComponent(
      `ALTER TABLE ${table} DELETE WHERE ${keyColumn} IN (${keys})`
    )}`,
    {
      method: "POST",
      signal: requestSignal(
        options.timeoutMs ?? DEFAULT_CLICKHOUSE_REQUEST_TIMEOUT_MS
      )
    }
  );
}

/** Delete rows that fell out of the catalog, and report what went. */
export async function removeStaleRows<Row>(
  endpoint: string,
  staleRows: readonly Row[],
  projection: StaleRowProjection<Row>,
  options: ClickHouseRequestOptions = {}
): Promise<string[]> {
  if (staleRows.length === 0) return [];
  const keys = staleRows.map((row) => `'${projection.keyOf(row)}'`).join(", ");
  // Versions first, deliberately in sequence: the summary row is the one that
  // names them, so ClickHouse must not be asked to delete it before they go.
  await deleteWhereKeyIn(
    endpoint,
    projection.versionsTable,
    projection.versionsKeyColumn,
    keys,
    options
  );
  await deleteWhereKeyIn(
    endpoint,
    projection.summaryTable,
    projection.summaryKeyColumn,
    keys,
    options
  );
  return staleRows.map(projection.labelOf);
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
 */
export function runParameterizedClickHouseStatement(
  endpoint: string,
  query: string,
  params: Readonly<Record<string, ClickHouseParamValue>> = {},
  options: {
    readonly fetchImpl?: typeof fetch;
    readonly body?: string;
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
              headers: { "Content-Type": "application/json" },
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
