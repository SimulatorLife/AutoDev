import assert from "node:assert/strict";
import test from "node:test";

import {
  closeOrchestratorMemoryHost,
  createOrchestratorMemoryService,
  observeMemoryStorageStatus
} from "../src/router/memory-injection.ts";

/**
 * The answers memory storage can give an operator, and the mistakes behind them.
 *
 * `/status` and the capture routes all read this, so a distinction lost here is
 * a distinction an operator cannot make: "not configured", "configured but
 * down", and "configured and answering" are three different repairs.
 *
 * I expected four states and found three. There is a `catch` around building
 * the host for a database URL that cannot be parsed, and I could not reach it:
 * `pg` does not validate the connection string when the pool is constructed, it
 * defers every failure to connect time. `"this is not a connection string"`,
 * `"postgres://"`, `"://bad"`, `"postgres://h:p@host:notaport/db"` and an
 * out-of-range port all build a host and fail at the probe instead. So a typo
 * reads as *unreachable*, not as *not configured* — which is the right answer
 * for the person debugging it, since the pool exists and the connection is what
 * failed. The catch stays as defence in depth against a driver that might throw
 * in a future version, and nothing here claims to have exercised it.
 *
 * These run in one file and in order, because the host is cached for the life of
 * the process: the host built by the second case is what the third and fourth
 * cases are about. Each case is separated by a configuration change rather than
 * by a reset, which does not exist.
 *
 * What this file cannot do: distinguish "the probe ran and said unreachable"
 * from "the state is hardcoded to unreachable". Replacing the probe call with
 * the literal leaves all four cases green, because the one database this
 * environment can offer is one that is down, and a probe is only distinguishable
 * from a constant by a probe that succeeds. The deadline is pinned separately
 * and does bind. A reachable database would close this, and it needs the
 * PostgreSQL the integration suite is already waiting on.
 */

const KEYS = [
  "AUTODEV_MEMORY_DATABASE_URL",
  "AUTODEV_MEMORY_RECONSTRUCTION",
  "AUTODEV_MEMORY_EMBEDDING_MODEL"
] as const;

function setDatabaseUrl(url: string | undefined): void {
  for (const key of KEYS) delete process.env[key];
  if (url !== undefined) process.env.AUTODEV_MEMORY_DATABASE_URL = url;
}

test("with no database URL, storage is not configured and nothing is built", async () => {
  setDatabaseUrl(undefined);

  const status = await observeMemoryStorageStatus();

  assert.equal(status.state, "not_configured");
  assert.equal(
    createOrchestratorMemoryService(),
    null,
    "a service was built with no database URL"
  );
});

test("a configured database that is not answering reads as unreachable", async () => {
  // The distinction the malformed case cannot make, and the one that costs an
  // operator the most when it is lost: the configuration is right and the
  // database is not. Nothing is listening on this port, so the probe's own
  // deadline is what decides, which is why it is given a short one — and why
  // the caller's deadline is asserted back rather than assumed.
  setDatabaseUrl("postgres://memory:memory@127.0.0.1:1/memory?connect_timeout=1");

  const status = await observeMemoryStorageStatus(250);

  assert.equal(
    status.state,
    "unreachable",
    "a database that is configured but not answering was reported as unconfigured"
  );
  assert.equal(
    status.probeTimeoutMs,
    250,
    "the caller's deadline was not the one the probe used"
  );
  // Built, not refused: a host exists even though nothing answered, which is
  // what lets the capture routes say "unavailable" rather than "not configured".
  assert.notEqual(
    createOrchestratorMemoryService(),
    null,
    "no host was built for a database that is configured and merely down"
  );
});

test("reconfiguring the database URL does not silently reuse the old pool", async () => {
  // The host is cached against the URL that built it. Pointing the variable
  // somewhere else mid-process must not keep serving the old database, and it
  // must not silently open the new one either — the cached pool was never built
  // for it. Failing closed leaves the operator to restart, which is the only
  // point at which a new URL can be honoured honestly.
  setDatabaseUrl("postgres://memory:memory@127.0.0.1:2/other?connect_timeout=1");

  assert.equal(
    createOrchestratorMemoryService(),
    null,
    "a service was served from the pool built for a different database URL"
  );
  assert.equal(
    (await observeMemoryStorageStatus(100)).state,
    "not_configured",
    "storage reported a state for a URL whose pool was never built"
  );
});

test("a close in flight suppresses every later construction", async () => {
  // Shutdown races the requests still draining. While the close is outstanding
  // the shared marker suppresses construction, so a request arriving in that
  // window cannot start opening a pool that the shutdown is in the middle of
  // releasing — which would leave two pools for one pool slot and the second
  // one with nothing left to close it.
  //
  // Scoped deliberately to the window. Once the close settles the marker is
  // cleared and a configured URL can build a fresh pool again, so this does not
  // claim shutdown is permanent — only that nothing is opened underneath it.
  // That residue is real but harmless here: the pool is idle and built with
  // `allowExitOnIdle`, so it does not hold the process open.
  setDatabaseUrl("postgres://memory:memory@127.0.0.1:1/memory?connect_timeout=1");

  const closing = closeOrchestratorMemoryHost();

  assert.equal(
    createOrchestratorMemoryService(),
    null,
    "a service was built while the shared pool was being released"
  );
  assert.equal(
    (await observeMemoryStorageStatus(100)).state,
    "not_configured",
    "storage reported a state while the shared pool was being released"
  );

  await closing;
  setDatabaseUrl(undefined);
});