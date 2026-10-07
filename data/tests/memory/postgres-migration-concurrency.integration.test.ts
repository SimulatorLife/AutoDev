import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import { createPgMemoryPool } from "../../src/memory/pg-pool.ts";
import {
  applyMemoryMigrations,
  MEMORY_MIGRATIONS
} from "../../src/memory/schema.ts";

const databaseUrl = process.env.AUTODEV_MEMORY_TEST_DATABASE_URL;

// How many independent processes race to migrate an empty schema. This
// mirrors the reproduction that originally surfaced the bug: a clean
// database with this many concurrent applyMemoryMigrations(pool) callers
// reproducibly hit "duplicate key value violates unique constraint
// "pg_type_typname_nsp_index"" on concurrent
// CREATE TABLE IF NOT EXISTS memory_schema_migrations, plus the same race
// on each migration's own version check.
const CONCURRENT_POOL_COUNT = 12;

/**
 * Builds a syntactically valid, collision-resistant schema identifier.
 * Postgres identifiers are limited to 63 bytes and must not start with a
 * digit, so the random suffix is prefixed with a letter-leading constant.
 */
function uniqueSchemaName(): string {
  return `memory_migration_race_${randomUUID().replaceAll("-", "_")}`;
}

test(
  "concurrent applyMemoryMigrations callers on an empty schema each migration exactly once",
  { skip: !databaseUrl },
  async () => {
    const schemaName = uniqueSchemaName();
    // A dedicated bootstrap connection owns schema creation/teardown; it
    // never participates in the migration race itself, and it is the only
    // connection that ever issues DROP SCHEMA, scoped to this test's own
    // schema so it never touches the shared public schema other
    // integration tests in this suite depend on.
    const bootstrapPool = createPgMemoryPool(databaseUrl!);
    const racingPools = Array.from({ length: CONCURRENT_POOL_COUNT }, () =>
      createPgMemoryPool(
        databaseUrl!,
        // Each pool is an independent connection-options-level search_path
        // override: every connection it opens starts a session scoped to
        // this test's isolated schema (with public retained afterward so
        // unqualified pgvector/pg_catalog lookups such as the "vector"
        // type and hashtext()/pg_advisory_xact_lock() still resolve).
        // "Independent pools" here means distinct connection pools racing
        // against the same empty schema, exactly like distinct OS
        // processes would.
        `-c search_path=${schemaName},public`
      )
    );
    try {
      await bootstrapPool.query(`CREATE SCHEMA "${schemaName}"`);

      // No retries and no catching here: if the advisory-lock serialization
      // in applyMemoryMigrations has a gap, one of these concurrent calls
      // throws the original duplicate-key error and this test fails loudly
      // rather than masking the race.
      await Promise.all(racingPools.map((pool) => applyMemoryMigrations(pool)));

      const recorded = await bootstrapPool.query<{
        version: number;
        applied_at: string;
      }>(
        `SELECT version, applied_at FROM "${schemaName}".memory_schema_migrations ORDER BY version`
      );

      // Every migration is recorded, in version order, and -- because
      // "version" is the table's primary key -- recorded at most once;
      // this assertion on row count plus the explicit version sequence
      // below is what rules out the duplicate-apply failure mode the
      // original race produced.
      assert.equal(recorded.rows.length, MEMORY_MIGRATIONS.length);
      assert.deepEqual(
        recorded.rows.map((row) => row.version),
        MEMORY_MIGRATIONS.map((migration) => migration.version)
      );

      // applied_at timestamps are non-decreasing by version, confirming
      // migrations committed in version order even though twelve pools
      // raced to apply them.
      const appliedAtMillis = recorded.rows.map((row) =>
        new Date(row.applied_at).getTime()
      );
      for (let index = 1; index < appliedAtMillis.length; index += 1) {
        assert.ok(
          (appliedAtMillis[index] ?? 0) >= (appliedAtMillis[index - 1] ?? 0),
          "migrations must commit in non-decreasing version order"
        );
      }
    } finally {
      await Promise.all(racingPools.map((pool) => pool.end()));
      await bootstrapPool.query(
        `DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`
      );
      await bootstrapPool.end();
    }
  }
);
