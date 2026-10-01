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
  await migrateMemoryDatabase(process.env.AUTODEV_MEMORY_DATABASE_URL);
}
