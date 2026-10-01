import pg from "pg";

import type {
  MemoryConnectionPool,
  MemoryPooledConnection,
  MemoryQueryResult
} from "./query-client.ts";

/**
 * Wraps a real `pg` connection pool behind the narrow `MemoryConnectionPool`
 * surface the repository depends on. This is the only module in this
 * package that imports the `pg` driver directly.
 */
export function createPgMemoryPool(
  config: pg.PoolConfig
): MemoryConnectionPool {
  const pool = new pg.Pool(config);

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
