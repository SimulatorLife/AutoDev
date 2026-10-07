import { pathToFileURL } from "node:url";

import { createPgMemoryPool } from "./pg-pool.ts";
import { applyMemoryMigrations } from "./schema.ts";

export async function migrateMemoryDatabase(
  databaseUrl: string | undefined
): Promise<void> {
  if (!databaseUrl?.trim()) {
    throw new Error(
      "AUTODEV_MEMORY_DATABASE_URL is required to migrate memory storage."
    );
  }
  const pool = createPgMemoryPool({ connectionString: databaseUrl });
  try {
    await applyMemoryMigrations(pool);
  } finally {
    await pool.end();
  }
}

const entryPoint = process.argv[1];
if (entryPoint && import.meta.url === pathToFileURL(entryPoint).href) {
  try {
    await migrateMemoryDatabase(process.env.AUTODEV_MEMORY_DATABASE_URL);
  } catch (error) {
    // A migration is the command most likely to be run against an environment
    // that is not configured yet, so the message it produces for a missing
    // database URL is one an operator will actually read. Reported the way the
    // runtime's memory entry points report, rather than letting a rejected
    // top-level await print this file's internals instead.
    const message =
      error instanceof Error
        ? error.message
        : "Memory storage migration failed.";
    process.stderr.write(`memory-migrate: ${message}\n`);
    process.exitCode = 1;
  }
}
