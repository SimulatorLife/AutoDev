import assert from "node:assert/strict";
import test from "node:test";

import { MEMORY_POOL_CONNECT_TIMEOUT_MS } from "@simulatorlife/autodev-data";

import { MEMORY_STORAGE_PROBE_TIMEOUT_MS } from "../src/memory/postgres.ts";

/**
 * The pool's connect bound lives in the Data package now, because the two
 * entry points that build memory pools disagreed about it and the migration CLI
 * lost the connect deadline entirely. This pins the one relationship that
 * still spans the two: the health probe's own deadline has to be the thing that
 * decides `unreachable`.
 *
 * If the connect bound were the shorter of the two, a database that is merely
 * slow to accept a connection would be reported unreachable by the driver
 * rather than by the probe, and the probe's deadline would stop meaning
 * anything -- a database that answers at 2s would be called down purely
 * because the bound was set below the time the probe was willing to wait.
 */
test("the pool connect bound outlasts the health probe's own deadline", () => {
  assert.ok(
    MEMORY_POOL_CONNECT_TIMEOUT_MS > MEMORY_STORAGE_PROBE_TIMEOUT_MS,
    `the probe decides \`unreachable\` only while it is still waiting: connect bound ${MEMORY_POOL_CONNECT_TIMEOUT_MS}ms must exceed probe deadline ${MEMORY_STORAGE_PROBE_TIMEOUT_MS}ms`
  );
});
