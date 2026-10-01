import assert from "node:assert/strict";
import test from "node:test";

import { migrateMemoryDatabase } from "../../src/memory/migrate.ts";

test("memory migration tooling fails closed when the database URL is absent", async () => {
  await assert.rejects(
    migrateMemoryDatabase(undefined),
    /AUTODEV_MEMORY_DATABASE_URL is required/
  );
  await assert.rejects(
    migrateMemoryDatabase("  "),
    /AUTODEV_MEMORY_DATABASE_URL is required/
  );
});
