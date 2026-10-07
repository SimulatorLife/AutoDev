import pg from "pg";

import type {
  MemoryConnectionPool,
  MemoryPooledConnection,
  MemoryQueryResult
} from "./query-client.ts";

/**
 * How long a connection attempt may hold a connection open.
 *
 * `pg`'s default is to wait out the operating system's TCP timeout, so a
 * database that black-holes a connection -- a firewall that accepts the
 * socket and then says nothing, or drops the SYN outright -- turns every read
 * and every migration into an operation that never settles. Measured against
 * both shapes: without a bound the connect was still hanging when the probe
 * was killed at 15s, and with this bound it fails at ~5s reporting a
 * connection timeout.
 */
export const MEMORY_POOL_CONNECT_TIMEOUT_MS = 5000;

/**
 * Wraps a real `pg` connection pool behind the narrow `MemoryConnectionPool`
 * surface the repository depends on. This is the only module in this
 * package that imports the `pg` driver directly.
 *
 * The pool policy is fixed here rather than accepted from callers, because the
 * two entry points that build memory pools did not agree on it: the Runtime's
 * host bounded its connects and the migration CLI did not, so a database that
 * black-holed the connection hung the one caller with no deadline of its own to
 * report it. Only `sessionOptions` is caller-supplied -- PostgreSQL's
 * per-connection startup options string, used to scope a session to a schema.
 */
export function createPgMemoryPool(
  databaseUrl: string,
  sessionOptions?: string
): MemoryConnectionPool {
  const pool = new pg.Pool({
    connectionString: databaseUrl,
    max: 2,
    idleTimeoutMillis: 5000,
    allowExitOnIdle: true,
    connectionTimeoutMillis: MEMORY_POOL_CONNECT_TIMEOUT_MS,
    ...(sessionOptions === undefined ? {} : { options: sessionOptions })
  });

  async function runQuery<Row extends Record<string, unknown>>(
    queryable: {
      query: (text: string, params?: unknown[]) => Promise<pg.QueryResult<Row>>;
    },
    text: string,
    params?: readonly unknown[]
  ): Promise<MemoryQueryResult<Row>> {
    const result = await queryable.query(
      text,
      params ? [...params] : undefined
    );
    const rows = result.rows ?? [];
    return { rows, rowCount: result.rowCount ?? rows.length };
  }

  return {
    query: (text, params) => runQuery(pool, text, params),
    connect: async (): Promise<MemoryPooledConnection> => {
      const client = await pool.connect();
      return {
        query: (text, params) => runQuery(client, text, params),
        release: () => client.release()
      };
    },
    end: () => pool.end()
  };
}
