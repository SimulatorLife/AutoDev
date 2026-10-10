import assert from "node:assert/strict";
import test from "node:test";

import {
  createPostgresMemoryHost,
  createPostgresMemoryRuntime
} from "../src/memory/postgres.ts";

/**
 * The memory Postgres host, without a database.
 *
 * The only tests this module had were integration tests, so everything here was
 * untested in an ordinary run. That is not because it needs a server: `pg.Pool`
 * is lazy, so building the host opens no connection, and the two things this
 * module is responsible for -- refusing a URL it cannot use, and closing the
 * pool it owns -- are both observable without one.
 *
 * `close()` matters more than it looks. Both capture and retention entry points
 * build their runtime through `createPostgresMemoryRuntime` and finish in a
 * `finally` that closes it; if that close stopped propagating, every capture
 * process would keep its pool's sockets open and the process would hang on
 * exit instead of finishing. Nothing else in the suite would notice.
 */

/** A URL that parses but is never dialled; the pool opens nothing until asked. */
const UNUSED_DATABASE_URL = "postgresql://memory.invalid/autodev";

test("a memory host refuses a database URL it cannot use", () => {
  for (const blank of ["", "   "]) {
    assert.throws(
      () => createPostgresMemoryHost({ databaseUrl: blank }),
      TypeError,
      `a blank database URL must be refused rather than built with`
    );
  }
});

test("the one-service runtime closes the pool it was given", async () => {
  const runtime = createPostgresMemoryRuntime({
    databaseUrl: UNUSED_DATABASE_URL,
    repositories: { resolve: () => Promise.resolve(null) }
  });

  // The service is wired to the repository rather than stubbed, so it carries
  // the real read surface. Asserted by shape: a wrapper that handed back
  // something else would still satisfy a truthiness check.
  assert.equal(typeof runtime.service.search, "function");
  assert.equal(typeof runtime.service.searchExperiences, "function");
  assert.equal(typeof runtime.service.why, "function");

  // The actual contract. A no-op close, or one that swallows the host's close,
  // leaves a capture process holding its pool sockets and never exiting.
  await runtime.close();

  // ...and it is observable. `pg.Pool.end()` marks the pool unusable, so a read
  // afterwards fails on the pool rather than dialling the database. An unclosed
  // pool would instead attempt a connection and fail on that, so the two are
  // distinguishable even with zero clients ever checked out -- which is all a
  // unit test can have.
  //
  // Only the closed case is asserted: it never touches the network, so the test
  // does not depend on how `memory.invalid` resolves.
  await assert.rejects(
    runtime.service.searchExperiences({
      query: "anything",
      context: { workspaceId: "workspace-a", canReadGlobal: false }
    }),
    /Cannot use a pool after calling end/u,
    "the close must have reached the pool this service reads through"
  );
});
