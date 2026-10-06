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

/** The ClickHouse endpoint used when nothing else names one. */
export const DEFAULT_CLICKHOUSE_URL = "http://127.0.0.1:8123";

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
  columns: readonly string[]
): Promise<Row[]> {
  const query = `SELECT ${columns.join(", ")} FROM ${table} FORMAT JSON`;
  const res = await fetch(`${endpoint}&query=${encodeURIComponent(query)}`, {
    method: "GET"
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
  rows: readonly Row[]
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
      body
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
  keys: string
): Promise<void> {
  await fetch(
    `${endpoint}&query=${encodeURIComponent(
      `ALTER TABLE ${table} DELETE WHERE ${keyColumn} IN (${keys})`
    )}`,
    { method: "POST" }
  );
}

/** Delete rows that fell out of the catalog, and report what went. */
export async function removeStaleRows<Row>(
  endpoint: string,
  staleRows: readonly Row[],
  projection: StaleRowProjection<Row>
): Promise<string[]> {
  if (staleRows.length === 0) return [];
  const keys = staleRows.map((row) => `'${projection.keyOf(row)}'`).join(", ");
  // Versions first, deliberately in sequence: the summary row is the one that
  // names them, so ClickHouse must not be asked to delete it before they go.
  await deleteWhereKeyIn(
    endpoint,
    projection.versionsTable,
    projection.versionsKeyColumn,
    keys
  );
  await deleteWhereKeyIn(
    endpoint,
    projection.summaryTable,
    projection.summaryKeyColumn,
    keys
  );
  return staleRows.map(projection.labelOf);
}
