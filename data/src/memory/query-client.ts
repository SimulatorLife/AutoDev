/**
 * Minimal query surface this repository depends on. It mirrors the shape of
 * `pg`'s `Pool`/`PoolClient` so a real pool and an in-memory fake used by
 * tests can both satisfy it, keeping the repository decoupled from the
 * `pg` driver itself.
 */
export interface MemoryQueryResult<
  Row extends Record<string, unknown> = Record<string, unknown>
> {
  readonly rows: readonly Row[];
  readonly rowCount: number;
}

export interface MemoryQueryable {
  query<Row extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    params?: readonly unknown[]
  ): Promise<MemoryQueryResult<Row>>;
}

export interface MemoryPooledConnection extends MemoryQueryable {
  release(): void;
}

export interface MemoryConnectionPool extends MemoryQueryable {
  connect(): Promise<MemoryPooledConnection>;
  end(): Promise<void>;
}

/** Runs `work` inside a single transaction, rolling back on any thrown error. */
export async function withMemoryTransaction<T>(
  pool: MemoryConnectionPool,
  work: (connection: MemoryPooledConnection) => Promise<T>
): Promise<T> {
  const connection = await pool.connect();
  try {
    await connection.query("BEGIN");
    const result = await work(connection);
    await connection.query("COMMIT");
    return result;
  } catch (error) {
    await connection.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    connection.release();
  }
}
