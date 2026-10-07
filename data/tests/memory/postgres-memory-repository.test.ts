import assert from "node:assert/strict";
import test from "node:test";

import {
  MemoryConflictError,
  MemoryLifecycleError,
  MemoryProvenanceError,
  MemoryVectorError
} from "../../src/memory/errors.ts";
import { PostgresMemoryRepository } from "../../src/memory/postgres-memory-repository.ts";
import type { MemoryConnectionPool } from "../../src/memory/query-client.ts";
import { MEMORY_EMBEDDING_DIMENSIONS } from "../../src/memory/schema.ts";
import {
  makeContext,
  makeExperience,
  makeLifecycleEvent,
  makeMemoryRecord
} from "./fixtures/builders.ts";
import { FakeMemoryPool } from "./fixtures/fake-memory-pool.ts";

function repoWith(pool: FakeMemoryPool): PostgresMemoryRepository {
  return new PostgresMemoryRepository({ pool });
}

/**
 * A pool whose `memory_records` compare-and-set update fails outright.
 *
 * `transitionMemories` runs inside `withMemoryTransaction`, so the update goes
 * through the connection the pool hands out rather than the pool's own `query`.
 * Wrapping only `query` would let the update succeed, and the test below would
 * then assert a throw that never happened.
 */
function failingUpdatePool(
  base: FakeMemoryPool,
  failure: Error
): MemoryConnectionPool {
  const shouldFail = (text: string) => text.includes("UPDATE memory_records");
  return {
    query: (text, params) =>
      shouldFail(text) ? Promise.reject(failure) : base.query(text, params),
    connect: async () => {
      const connection = await base.connect();
      return {
        query: (text, params) =>
          shouldFail(text)
            ? Promise.reject(failure)
            : connection.query(text, params),
        release: () => connection.release()
      };
    },
    end: () => base.end()
  };
}

test("appendExperience persists and getExperience enforces scope visibility", async () => {
  const pool = new FakeMemoryPool();
  const repo = repoWith(pool);
  const experience = makeExperience({
    scope: {
      kind: "task",
      workspaceId: "ws-1",
      taskId: "task-1",
      runId: "run-1"
    }
  });
  await repo.appendExperience(experience);

  const sameTask = await repo.getExperience(
    experience.id,
    makeContext({ workspaceId: "ws-1", taskId: "task-1", runId: "run-1" })
  );
  assert.deepEqual(sameTask, experience);

  const otherTask = await repo.getExperience(
    experience.id,
    makeContext({ workspaceId: "ws-1", taskId: "task-2", runId: "run-2" })
  );
  assert.equal(otherTask, null);

  // canReadGlobal only grants access to globally-scoped memories, never to another
  // task/run's private experiences, so it must not unlock this task-scoped row.
  const elevatedButWrongTask = await repo.getExperience(
    experience.id,
    makeContext({ workspaceId: "ws-1", canReadGlobal: true })
  );
  assert.equal(elevatedButWrongTask, null);
});

test("appendExperience rejects a duplicate id instead of silently overwriting history", async () => {
  const pool = new FakeMemoryPool();
  const repo = repoWith(pool);
  const experience = makeExperience();
  await repo.appendExperience(experience);

  await assert.rejects(
    () => repo.appendExperience(experience),
    MemoryConflictError
  );
  assert.equal(pool.tables.memory_experiences.size, 1);
});

test("proposeMemory rejects a candidate whose provenance references an unknown experience, atomically", async () => {
  const pool = new FakeMemoryPool();
  const repo = repoWith(pool);
  const candidate = makeMemoryRecord({
    provenance: {
      experienceIds: ["exp-does-not-exist"],
      evidence: [],
      createdBy: "agent-1",
      createdAt: "2026-01-01T00:00:00.000Z"
    }
  });

  await assert.rejects(
    () => repo.proposeMemory(candidate, makeLifecycleEvent()),
    MemoryProvenanceError
  );
  assert.equal(
    pool.tables.memory_records.size,
    0,
    "no record row should be left behind"
  );
  assert.equal(
    pool.tables.memory_lifecycle_events.length,
    0,
    "no lifecycle event should be left behind"
  );
});

test("proposeMemory rejects a lifecycle event that does not describe the same proposal", async () => {
  const pool = new FakeMemoryPool();
  const repo = repoWith(pool);
  await repo.appendExperience(makeExperience());
  const candidate = makeMemoryRecord();

  await assert.rejects(
    () =>
      repo.proposeMemory(
        candidate,
        makeLifecycleEvent({ memoryId: "some-other-memory" })
      ),
    MemoryLifecycleError
  );
  await assert.rejects(
    () =>
      repo.proposeMemory(
        candidate,
        makeLifecycleEvent({ action: "verified", toStatus: "active" })
      ),
    MemoryLifecycleError
  );
  await assert.rejects(
    () =>
      repo.proposeMemory(candidate, makeLifecycleEvent({ toStatus: "active" })),
    MemoryLifecycleError
  );
  assert.equal(pool.tables.memory_records.size, 0);
});

test("proposeMemory inserts the record and its lifecycle event together", async () => {
  const pool = new FakeMemoryPool();
  const repo = repoWith(pool);
  await repo.appendExperience(makeExperience());
  const candidate = makeMemoryRecord();
  const event = makeLifecycleEvent();

  await repo.proposeMemory(candidate, event);

  const stored = await repo.getMemory(
    candidate.id,
    makeContext({ workspaceId: "ws-1", canReadGlobal: true })
  );
  assert.deepEqual(stored, candidate);
  assert.equal(pool.tables.memory_lifecycle_events.length, 1);
  assert.equal(pool.tables.memory_lifecycle_events[0]?.id, event.id);
});

test("proposeMemory locks cited experiences in stable order until provenance commits", async () => {
  const pool = new FakeMemoryPool();
  const repo = repoWith(pool);
  await repo.appendExperience(makeExperience({ id: "exp-z" }));
  await repo.appendExperience(makeExperience({ id: "exp-a" }));
  const candidate = makeMemoryRecord({
    provenance: {
      experienceIds: ["exp-z", "exp-a", "exp-z"],
      evidence: [{ kind: "commit", uri: "git://ws-1/repo/commit/abc" }],
      createdBy: "agent-1",
      createdAt: "2026-01-01T00:00:00.000Z"
    }
  });

  await repo.proposeMemory(candidate, makeLifecycleEvent());

  const lockCall = pool.calls.find((call) =>
    call.sql.includes("ORDER BY id FOR KEY SHARE")
  );
  const lockIndex = pool.executed.findIndex((sql) =>
    sql.includes("ORDER BY id FOR KEY SHARE")
  );
  const insertIndex = pool.executed.findIndex((sql) =>
    sql.startsWith("INSERT INTO memory_records")
  );
  assert.notEqual(lockIndex, -1);
  assert.ok(lockIndex < insertIndex);
  assert.deepEqual(lockCall?.params[0], ["exp-a", "exp-z"]);
});

test("proposeMemory accepts an evidence-backed revision without mutating its active predecessor", async () => {
  const pool = new FakeMemoryPool();
  const repo = repoWith(pool);
  await repo.appendExperience(makeExperience());
  const prior = makeMemoryRecord();
  await repo.proposeMemory(prior, makeLifecycleEvent());
  await repo.transitionMemories(
    [
      {
        expectedUpdatedAt: prior.updatedAt,
        next: {
          ...prior,
          status: "active",
          validity: { state: "verified", evidence: prior.provenance.evidence },
          updatedAt: "2026-01-02T00:00:00.000Z"
        }
      }
    ],
    [
      makeLifecycleEvent({
        id: "evt-activate",
        action: "verified",
        fromStatus: "proposed",
        toStatus: "active",
        reasonCode: "verified_current_state"
      })
    ]
  );

  const revision = makeMemoryRecord({
    id: "mem-revision",
    claim: "The current config loader uses typed filters.",
    updatedAt: "2026-01-03T00:00:00.000Z"
  });
  const event = makeLifecycleEvent({
    id: "evt-revision",
    memoryId: revision.id,
    action: "revised",
    reasonCode: "revised_after_review",
    relatedMemoryIds: [prior.id]
  });
  await repo.proposeMemory(revision, event);

  assert.equal(
    (await repo.getMemory(prior.id, makeContext({ workspaceId: "ws-1" })))
      ?.status,
    "active"
  );
  assert.equal(
    (await repo.getMemory(revision.id, makeContext({ workspaceId: "ws-1" })))
      ?.status,
    "proposed"
  );
  assert.equal(pool.tables.memory_lifecycle_events.at(-1)?.action, "revised");
  const priorHistory = await repo.getMemoryHistory(
    prior.id,
    makeContext({ workspaceId: "ws-1" })
  );
  assert.ok(priorHistory?.events.some((entry) => entry.id === event.id));
  assert.ok(
    priorHistory?.relatedMemories.some((entry) => entry.id === revision.id)
  );
});

test("proposeMemory rejects a duplicate memory id", async () => {
  const pool = new FakeMemoryPool();
  const repo = repoWith(pool);
  await repo.appendExperience(makeExperience());
  const candidate = makeMemoryRecord();
  await repo.proposeMemory(candidate, makeLifecycleEvent());

  await assert.rejects(
    () => repo.proposeMemory(candidate, makeLifecycleEvent({ id: "evt-2" })),
    MemoryConflictError
  );
});

test("getMemory enforces scope visibility before returning a record", async () => {
  const pool = new FakeMemoryPool();
  const repo = repoWith(pool);
  await repo.appendExperience(makeExperience());
  const candidate = makeMemoryRecord({
    scope: { kind: "repository", workspaceId: "ws-1", repositoryId: "repo-1" }
  });
  await repo.proposeMemory(candidate, makeLifecycleEvent());

  const visible = await repo.getMemory(
    candidate.id,
    makeContext({ workspaceId: "ws-1", repositoryId: "repo-1" })
  );
  assert.deepEqual(visible, candidate);

  const invisible = await repo.getMemory(
    candidate.id,
    makeContext({ workspaceId: "ws-1", repositoryId: "repo-2" })
  );
  assert.equal(invisible, null);

  const wrongWorkspace = await repo.getMemory(
    candidate.id,
    makeContext({ workspaceId: "ws-2", canReadGlobal: true })
  );
  assert.equal(
    wrongWorkspace,
    null,
    "repository scope must not leak via a global grant from another workspace"
  );
});

test("transitionMemories applies a compare-and-set update together with its lifecycle event", async () => {
  const pool = new FakeMemoryPool();
  const repo = repoWith(pool);
  await repo.appendExperience(makeExperience());
  const candidate = makeMemoryRecord();
  await repo.proposeMemory(candidate, makeLifecycleEvent());

  const activated = {
    ...candidate,
    status: "active" as const,
    validity: { state: "verified" as const, evidence: [] },
    updatedAt: "2026-01-02T00:00:00.000Z"
  };
  const ok = await repo.transitionMemories(
    [{ expectedUpdatedAt: candidate.updatedAt, next: activated }],
    [
      makeLifecycleEvent({
        id: "evt-verify",
        action: "verified",
        fromStatus: "proposed",
        toStatus: "active",
        reasonCode: "verified_current_state"
      })
    ]
  );

  assert.equal(ok, true);
  const stored = await repo.getMemory(
    candidate.id,
    makeContext({ workspaceId: "ws-1", canReadGlobal: true })
  );
  assert.equal(stored?.status, "active");
  assert.equal(pool.tables.memory_lifecycle_events.length, 2);
});

test("transitionMemories rejects status changes without an append-only audit event", async () => {
  const pool = new FakeMemoryPool();
  const repo = repoWith(pool);
  await repo.appendExperience(makeExperience());
  const candidate = makeMemoryRecord();
  await repo.proposeMemory(candidate, makeLifecycleEvent());

  await assert.rejects(
    () =>
      repo.transitionMemories(
        [
          {
            expectedUpdatedAt: candidate.updatedAt,
            next: { ...candidate, status: "invalidated" }
          }
        ],
        []
      ),
    /append-only lifecycle event/
  );
  assert.equal(
    (await repo.getMemory(candidate.id, makeContext({ workspaceId: "ws-1" })))
      ?.status,
    "proposed"
  );
});

test("transitionMemories rejects a stale compare-and-set update atomically, applying none of the batch", async () => {
  const pool = new FakeMemoryPool();
  const repo = repoWith(pool);
  await repo.appendExperience(makeExperience());
  const candidate = makeMemoryRecord();
  await repo.proposeMemory(candidate, makeLifecycleEvent());

  const otherCandidate = makeMemoryRecord({ id: "mem-2" });
  await repo.proposeMemory(
    otherCandidate,
    makeLifecycleEvent({ id: "evt-2", memoryId: "mem-2" })
  );

  const staleUpdate = {
    ...candidate,
    status: "active" as const,
    validity: { state: "verified" as const, evidence: [] },
    updatedAt: "2026-01-02T00:00:00.000Z"
  };
  const validUpdate = {
    ...otherCandidate,
    status: "active" as const,
    validity: { state: "verified" as const, evidence: [] },
    updatedAt: "2026-01-02T00:00:00.000Z"
  };

  const ok = await repo.transitionMemories(
    [
      { expectedUpdatedAt: "2099-01-01T00:00:00.000Z", next: staleUpdate },
      { expectedUpdatedAt: otherCandidate.updatedAt, next: validUpdate }
    ],
    [
      makeLifecycleEvent({
        id: "evt-stale",
        memoryId: candidate.id,
        action: "verified",
        fromStatus: "proposed",
        toStatus: "active",
        reasonCode: "verified_current_state"
      }),
      makeLifecycleEvent({
        id: "evt-valid",
        memoryId: otherCandidate.id,
        action: "verified",
        fromStatus: "proposed",
        toStatus: "active",
        reasonCode: "verified_current_state"
      })
    ]
  );

  assert.equal(ok, false);
  const first = await repo.getMemory(
    candidate.id,
    makeContext({ workspaceId: "ws-1", canReadGlobal: true })
  );
  const second = await repo.getMemory(
    otherCandidate.id,
    makeContext({ workspaceId: "ws-1", canReadGlobal: true })
  );
  assert.equal(first?.status, "proposed", "the stale change must not apply");
  assert.equal(
    second?.status,
    "proposed",
    "a valid change in the same batch must also roll back"
  );
});

test("transitionMemories surfaces an unreachable database as an error, not as a rejected change", async () => {
  const pool = new FakeMemoryPool();
  await repoWith(pool).appendExperience(makeExperience());
  const candidate = makeMemoryRecord();
  await repoWith(pool).proposeMemory(candidate, makeLifecycleEvent());

  // A real pg `connection_failure`, so `code` is present and the catch's
  // `instanceof` discrimination is exercised rather than bypassed.
  const failure = Object.assign(
    new Error("connection terminated unexpectedly"),
    { code: "08006" }
  );
  const repo = new PostgresMemoryRepository({
    pool: failingUpdatePool(pool, failure)
  });

  // `false` is this method's answer to exactly one situation: the record
  // changed under us, so the compare-and-set was rejected and nothing was
  // written. Returning it for an unreachable database tells the caller its
  // verification lost a race with another writer -- so it re-reads, or reports
  // a conflict, over a record whose state nobody can vouch for.
  //
  // The assertion is identity rather than "it threw": a stale rejection and an
  // unreachable database are both "did not apply", so only the thrown value
  // distinguishes the two.
  await assert.rejects(
    repo.transitionMemories(
      [
        {
          expectedUpdatedAt: candidate.updatedAt,
          next: {
            ...candidate,
            status: "active" as const,
            validity: { state: "verified" as const, evidence: [] },
            updatedAt: "2026-01-02T00:00:00.000Z"
          }
        }
      ],
      [
        makeLifecycleEvent({
          id: "evt-verify",
          action: "verified",
          fromStatus: "proposed",
          toStatus: "active",
          reasonCode: "verified_current_state"
        })
      ]
    ),
    (error: unknown) => error === failure
  );

  // The transaction rolled back, so the record is untouched rather than half
  // transitioned. Asserting the stored state as well as the thrown error pins
  // both halves of the promise: the caller learns why, and nothing was written.
  const stored = await repoWith(pool).getMemory(
    candidate.id,
    makeContext({ workspaceId: "ws-1", canReadGlobal: true })
  );
  assert.equal(stored?.status, "proposed");
});

test("getMemoryHistory returns the current record, lineage, and ordered governance events", async () => {
  const pool = new FakeMemoryPool();
  const repo = repoWith(pool);
  await repo.appendExperience(makeExperience());

  const predecessor = makeMemoryRecord({
    id: "mem-old",
    status: "superseded",
    supersededBy: ["mem-1"]
  });
  await repo.proposeMemory(
    (() => {
      const { supersededBy: _omit, ...rest } = predecessor;
      return { ...rest, status: "proposed" as const };
    })(),
    makeLifecycleEvent({ id: "evt-old", memoryId: "mem-old" })
  );
  await repo.transitionMemories(
    [{ expectedUpdatedAt: predecessor.updatedAt, next: predecessor }],
    [
      makeLifecycleEvent({
        id: "evt-supersede-old",
        memoryId: "mem-old",
        action: "superseded",
        fromStatus: "proposed",
        toStatus: "superseded",
        reasonCode: "superseded_by_newer_evidence",
        relatedMemoryIds: ["mem-1"]
      })
    ]
  );

  const current = makeMemoryRecord({ supersedes: ["mem-old"] });
  await repo.proposeMemory(
    current,
    makeLifecycleEvent({ occurredAt: "2026-01-01T00:06:00.000Z" })
  );

  const context = makeContext({ workspaceId: "ws-1", canReadGlobal: true });
  const history = await repo.getMemoryHistory(current.id, context);

  assert.ok(history);
  assert.deepEqual(history?.memory, current);
  assert.equal(history?.relatedMemories.length, 1);
  assert.equal(history?.relatedMemories[0]?.id, "mem-old");
  assert.equal(history?.events.length, 2);
  assert.deepEqual(history?.events.map((event) => event.id).sort(), [
    "evt-1",
    "evt-supersede-old"
  ]);
});

test("getMemoryHistory returns null when the memory itself is not visible", async () => {
  const pool = new FakeMemoryPool();
  const repo = repoWith(pool);
  await repo.appendExperience(makeExperience());
  const candidate = makeMemoryRecord({
    scope: { kind: "repository", workspaceId: "ws-1", repositoryId: "repo-1" }
  });
  await repo.proposeMemory(candidate, makeLifecycleEvent());

  const history = await repo.getMemoryHistory(
    candidate.id,
    makeContext({ workspaceId: "ws-1", repositoryId: "repo-2" })
  );
  assert.equal(history, null);
});

test("searchMemories excludes memories outside the caller's scope before any item is ranked", async () => {
  const pool = new FakeMemoryPool();
  const repo = repoWith(pool);
  await repo.appendExperience(makeExperience());

  const visible = makeMemoryRecord({ id: "mem-visible", status: "proposed" });
  await repo.proposeMemory(
    visible,
    makeLifecycleEvent({ memoryId: "mem-visible" })
  );
  await repo.transitionMemories(
    [
      {
        expectedUpdatedAt: visible.updatedAt,
        next: {
          ...visible,
          status: "active",
          validity: { state: "verified", evidence: [] },
          updatedAt: "2026-01-02T00:00:00.000Z"
        }
      }
    ],
    [
      makeLifecycleEvent({
        id: "evt-visible",
        memoryId: visible.id,
        action: "verified",
        fromStatus: "proposed",
        toStatus: "active",
        reasonCode: "verified_current_state"
      })
    ]
  );

  const otherWorkspace = makeMemoryRecord({
    id: "mem-other-ws",
    scope: { kind: "workspace", workspaceId: "ws-2" }
  });
  await repo.proposeMemory(
    otherWorkspace,
    makeLifecycleEvent({ memoryId: "mem-other-ws" })
  );
  await repo.transitionMemories(
    [
      {
        expectedUpdatedAt: otherWorkspace.updatedAt,
        next: {
          ...otherWorkspace,
          status: "active",
          validity: { state: "verified", evidence: [] },
          updatedAt: "2026-01-02T00:00:00.000Z"
        }
      }
    ],
    [
      makeLifecycleEvent({
        id: "evt-other-ws",
        memoryId: otherWorkspace.id,
        action: "verified",
        fromStatus: "proposed",
        toStatus: "active",
        reasonCode: "verified_current_state"
      })
    ]
  );

  const hits = await repo.searchMemories({
    query: "config loader",
    context: makeContext({ workspaceId: "ws-1" }),
    limit: 10
  });

  assert.equal(hits.length, 1);
  assert.equal(hits[0]?.memory.id, "mem-visible");
  assert.deepEqual(hits[0]?.matchedSignals, ["lexical"]);
});

test("searchMemories preserves non-path candidates and reports only observed path matches", async () => {
  const pool = new FakeMemoryPool();
  const repo = repoWith(pool);
  await repo.appendExperience(makeExperience());
  const match = makeMemoryRecord({
    id: "mem-path-match",
    provenance: {
      ...makeMemoryRecord().provenance,
      evidence: [
        {
          kind: "file",
          uri: "file:///workspace/repo/runtime/src/router/proxy.ts"
        }
      ]
    }
  });
  const mismatch = makeMemoryRecord({
    id: "mem-path-mismatch",
    claim: "A fallback routing fact without a file citation."
  });
  const nearby = makeMemoryRecord({
    id: "mem-path-nearby",
    provenance: {
      ...makeMemoryRecord().provenance,
      evidence: [
        {
          kind: "file",
          uri: "file:///workspace/repo/runtime/src/router/responses.ts"
        }
      ]
    }
  });
  await repo.proposeMemory(match, makeLifecycleEvent({ memoryId: match.id }));
  await repo.proposeMemory(nearby, makeLifecycleEvent({ memoryId: nearby.id }));
  await repo.proposeMemory(
    mismatch,
    makeLifecycleEvent({ memoryId: mismatch.id })
  );
  for (const candidate of [match, nearby, mismatch]) {
    await repo.transitionMemories(
      [
        {
          expectedUpdatedAt: candidate.updatedAt,
          next: {
            ...candidate,
            status: "active",
            validity: { state: "verified", evidence: [] },
            updatedAt: "2026-01-02T00:00:00.000Z"
          }
        }
      ],
      [
        makeLifecycleEvent({
          id: `evt-${candidate.id}`,
          memoryId: candidate.id,
          action: "verified",
          fromStatus: "proposed",
          toStatus: "active",
          reasonCode: "verified_current_state"
        })
      ]
    );
  }

  const hits = await repo.searchMemories({
    query: "fallback routing",
    context: makeContext({ workspaceId: "ws-1" }),
    relevantPaths: ["file:///workspace/repo/runtime/src/router/proxy.ts"],
    asOf: "2026-09-30T12:00:00.000Z"
  });
  assert.deepEqual(
    new Set(hits.map((hit) => hit.memory.id)),
    new Set(["mem-path-match", "mem-path-nearby", "mem-path-mismatch"])
  );
  assert.ok(
    hits
      .find((hit) => hit.memory.id === "mem-path-match")
      ?.matchedSignals.includes("path")
  );
  assert.ok(
    hits
      .find((hit) => hit.memory.id === "mem-path-nearby")
      ?.matchedSignals.includes("path")
  );
  assert.ok(
    !hits
      .find((hit) => hit.memory.id === "mem-path-mismatch")
      ?.matchedSignals.includes("path")
  );
  assert.ok(
    hits
      .find((hit) => hit.memory.id === "mem-path-mismatch")
      ?.matchedSignals.includes("lexical")
  );
});

test("searchMemories ranks and reports task-kind matches from cited experience metadata", async () => {
  const pool = new FakeMemoryPool();
  const repo = repoWith(pool);
  await repo.appendExperience(makeExperience({ taskKind: "bugfix" }));
  const candidate = makeMemoryRecord({
    id: "mem-bugfix-source",
    claim: "The config loader validates repository state."
  });
  await repo.proposeMemory(
    candidate,
    makeLifecycleEvent({ memoryId: candidate.id })
  );
  await repo.transitionMemories(
    [
      {
        expectedUpdatedAt: candidate.updatedAt,
        next: {
          ...candidate,
          status: "active",
          validity: { state: "verified", evidence: [] },
          updatedAt: "2026-01-02T00:00:00.000Z"
        }
      }
    ],
    [
      makeLifecycleEvent({
        id: "evt-bugfix-source-active",
        memoryId: candidate.id,
        action: "verified",
        fromStatus: "proposed",
        toStatus: "active",
        reasonCode: "verified_current_state"
      })
    ]
  );

  const hits = await repo.searchMemories({
    query: "config loader",
    taskKind: "bugfix",
    context: makeContext({ workspaceId: "ws-1" }),
    limit: 5
  });
  assert.deepEqual(hits[0]?.matchedSignals, ["lexical", "task_kind"]);
});

test("searchMemories excludes proposed (unpromoted) memories from results", async () => {
  const pool = new FakeMemoryPool();
  const repo = repoWith(pool);
  await repo.appendExperience(makeExperience());
  const stillProposed = makeMemoryRecord();
  await repo.proposeMemory(stillProposed, makeLifecycleEvent());

  const hits = await repo.searchMemories({
    query: "config loader",
    context: makeContext({ workspaceId: "ws-1", canReadGlobal: false }),
    limit: 10
  });
  assert.equal(hits.length, 0);
});

test("searchMemories does not fill top-k with zero-signal records", async () => {
  const pool = new FakeMemoryPool();
  const repo = repoWith(pool);
  await repo.appendExperience(makeExperience());
  const unrelated = makeMemoryRecord({
    claim: "The configuration loader reads execution contract files."
  });
  await repo.proposeMemory(unrelated, makeLifecycleEvent());
  await repo.transitionMemories(
    [
      {
        expectedUpdatedAt: unrelated.updatedAt,
        next: {
          ...unrelated,
          status: "active",
          validity: { state: "verified", evidence: [] },
          updatedAt: "2026-01-02T00:00:00.000Z"
        }
      }
    ],
    [
      makeLifecycleEvent({
        id: "evt-unrelated-active",
        memoryId: unrelated.id,
        action: "verified",
        fromStatus: "proposed",
        toStatus: "active",
        reasonCode: "verified_current_state"
      })
    ]
  );

  const hits = await repo.searchMemories({
    query: "randomized networking behavior",
    context: makeContext({ workspaceId: "ws-1" }),
    limit: 10
  });

  assert.deepEqual(hits, []);
});

test("proposeMemory rejects an embedding when no pgvector support is configured", async () => {
  const pool = new FakeMemoryPool();
  const repo = repoWith(pool);
  await repo.appendExperience(makeExperience());
  const candidate = makeMemoryRecord();

  await assert.rejects(
    () => repo.proposeMemory(candidate, makeLifecycleEvent(), [0.1, 0.2, 0.3]),
    /pgvector support/
  );
  assert.equal(
    pool.tables.memory_records.size,
    0,
    "the record must not be left behind"
  );
});

test("proposeMemory rejects a non-finite or empty embedding instead of silently coercing it", async () => {
  const pool = new FakeMemoryPool();
  const repo = new PostgresMemoryRepository({
    pool,
    vectorSupport: { dimensions: MEMORY_EMBEDDING_DIMENSIONS }
  });
  await repo.appendExperience(makeExperience());
  const candidate = makeMemoryRecord();

  await assert.rejects(
    () => repo.proposeMemory(candidate, makeLifecycleEvent(), []),
    /empty/
  );
  await assert.rejects(
    () => repo.proposeMemory(candidate, makeLifecycleEvent(), [Number.NaN]),
    /finite/
  );
  await assert.rejects(
    () => repo.proposeMemory(candidate, makeLifecycleEvent(), [0.1, 0.2]),
    /dimensions/
  );
  assert.equal(pool.tables.memory_records.size, 0);
});

test("proposeMemory stores a valid embedding, and searchMemories uses it as an additional ranking signal", async () => {
  const pool = new FakeMemoryPool();
  const repo = new PostgresMemoryRepository({
    pool,
    vectorSupport: { dimensions: MEMORY_EMBEDDING_DIMENSIONS }
  });
  await repo.appendExperience(makeExperience());
  const candidate = makeMemoryRecord();
  const embedding = Array.from(
    { length: MEMORY_EMBEDDING_DIMENSIONS },
    (_, index) => (index === 0 ? 0.1 : 0)
  );
  await repo.proposeMemory(candidate, makeLifecycleEvent(), embedding);
  await repo.transitionMemories(
    [
      {
        expectedUpdatedAt: candidate.updatedAt,
        next: {
          ...candidate,
          status: "active",
          validity: { state: "verified", evidence: [] },
          updatedAt: "2026-01-02T00:00:00.000Z"
        }
      }
    ],
    [
      makeLifecycleEvent({
        id: "evt-verify",
        action: "verified",
        fromStatus: "proposed",
        toStatus: "active",
        reasonCode: "verified_current_state"
      })
    ]
  );

  const stored = pool.tables.memory_records.get(candidate.id);
  assert.equal(stored?.embedding, `[${embedding.join(",")}]`);

  const hits = await repo.searchMemories({
    query: "config loader",
    context: makeContext({ workspaceId: "ws-1" }),
    queryEmbedding: embedding,
    limit: 5
  });
  assert.equal(hits.length, 1);
  assert.deepEqual(hits[0]?.matchedSignals, ["lexical", "semantic"]);
});

test("searchMemories rejects query embeddings when vector ranking is not configured", async () => {
  const pool = new FakeMemoryPool();
  const repo = repoWith(pool);

  await assert.rejects(
    () =>
      repo.searchMemories({
        query: "config loader",
        context: makeContext({ workspaceId: "ws-1" }),
        queryEmbedding: [0.1, 0.2, 0.3],
        limit: 5
      }),
    MemoryVectorError
  );
});

test("searchMemories rejects a non-finite queryEmbedding instead of silently coercing it", async () => {
  const pool = new FakeMemoryPool();
  const repo = new PostgresMemoryRepository({
    pool,
    vectorSupport: { dimensions: MEMORY_EMBEDDING_DIMENSIONS }
  });
  await assert.rejects(
    () =>
      repo.searchMemories({
        query: "x",
        context: makeContext(),
        queryEmbedding: [Number.POSITIVE_INFINITY]
      }),
    /finite/
  );
});

test("listMemories returns scoped lifecycle pages and an exact total beyond the last row", async () => {
  const pool = new FakeMemoryPool();
  const repo = repoWith(pool);
  await repo.appendExperience(makeExperience());
  const visible = makeMemoryRecord({ id: "visible-memory" });
  const hidden = makeMemoryRecord({
    id: "hidden-memory",
    scope: { kind: "workspace", workspaceId: "ws-other" }
  });
  await repo.proposeMemory(
    visible,
    makeLifecycleEvent({ memoryId: visible.id })
  );
  await repo.proposeMemory(hidden, makeLifecycleEvent({ memoryId: hidden.id }));

  const firstPage = await repo.listMemories({
    context: makeContext({ workspaceId: "ws-1" }),
    statuses: ["proposed"],
    limit: 1,
    offset: 0
  });
  assert.deepEqual(
    firstPage.items.map(({ id }) => id),
    [visible.id]
  );
  assert.equal(firstPage.total, 1);
  assert.equal(firstPage.limit, 1);
  assert.equal(firstPage.offset, 0);

  const pastEnd = await repo.listMemories({
    context: makeContext({ workspaceId: "ws-1" }),
    statuses: ["proposed"],
    limit: 1,
    offset: 1
  });
  assert.deepEqual(pastEnd.items, []);
  assert.equal(pastEnd.total, 1);
});

test("a row whose status is outside the vocabulary leaves the rollup rather than inventing a bucket", async () => {
  // `isMemoryStatus` has exactly one caller -- the rollup loop in
  // `listMemories` -- and rewriting it to accept everything left every suite
  // green. Every row a test creates goes through `proposeMemory`, which only
  // ever writes a status from the vocabulary, so the guard's rejection had
  // nothing to act on.
  //
  // Reachable only when the unknown-status row is *not* on the page being
  // returned. `hydrateMemoryRecordRow` fails loudly on an unrecognised status,
  // so a bad row that is on the page takes the whole read down before the
  // rollup could matter -- which is also why this was not obvious: the two
  // behaviours are the same policy applied at different moments.
  const pool = new FakeMemoryPool();
  const repo = repoWith(pool);
  await repo.appendExperience(makeExperience());
  const onPage = makeMemoryRecord({ id: "on-page" });
  const offPage = makeMemoryRecord({ id: "off-page" });
  for (const record of [onPage, offPage]) {
    await repo.proposeMemory(record, makeLifecycleEvent({ memoryId: record.id }));
  }
  const stored = pool.tables.memory_records.get(offPage.id);
  assert.ok(stored, "the second record should be stored");
  // A status no Runtime in this tree declares -- as an older build, or a
  // direct write, could leave behind.
  pool.tables.memory_records.set(offPage.id, {
    ...stored,
    status: "archived"
  });

  const page = await repo.listMemories({
    context: makeContext({ workspaceId: "ws-1" }),
    limit: 1,
    offset: 0
  });

  assert.deepEqual(
    page.items.map(({ id }) => id),
    [onPage.id],
    "the page itself is unaffected"
  );
  assert.deepEqual(
    page.statusCounts,
    { proposed: 1, active: 0, uncertain: 0, superseded: 0, invalidated: 0 },
    "the breakdown must carry only declared statuses"
  );
  assert.equal(
    Object.keys(page.statusCounts).length,
    5,
    "no key may be invented for a status the vocabulary does not declare"
  );
  // Deliberate, and worth stating: the unknown-status row is left out of the
  // total rather than counted somewhere. A record the Console cannot render
  // is not counted in a page whose every row it does render.
  assert.equal(page.total, 1);
});

test("listExperiences can read prior task history only in a workspace-bounded curator context", async () => {
  const pool = new FakeMemoryPool();
  const repo = repoWith(pool);
  const visible = makeExperience({
    id: "visible-experience",
    memoryMode: "jit"
  });
  const hidden = makeExperience({
    id: "hidden-experience",
    memoryMode: "retrieval-only",
    outcome: "failure",
    taskId: "task-other",
    runId: "run-other",
    repositoryId: "repo-1",
    scope: {
      kind: "task",
      workspaceId: "ws-1",
      taskId: "task-other",
      runId: "run-other"
    }
  });
  const foreignRepository = makeExperience({
    id: "foreign-repository-experience",
    memoryMode: "retrieval-only",
    taskId: "task-foreign",
    runId: "run-foreign",
    repositoryId: "repo-2",
    scope: {
      kind: "task",
      workspaceId: "ws-1",
      taskId: "task-foreign",
      runId: "run-foreign"
    }
  });
  await repo.appendExperience(visible);
  await repo.appendExperience(hidden);
  await repo.appendExperience(foreignRepository);
  const exactContext = makeContext({
    workspaceId: "ws-1",
    repositoryId: "repo-1",
    taskId: "task-1",
    runId: "run-1"
  });

  const privatePage = await repo.listExperiences({
    context: exactContext,
    limit: 10,
    offset: 0
  });
  assert.deepEqual(
    privatePage.items.map(({ id }) => id),
    [visible.id]
  );
  assert.equal(privatePage.total, 1);

  const curatorPage = await repo.listExperiences({
    context: { ...exactContext, canReadTaskHistory: true },
    limit: 10,
    offset: 0
  });
  assert.deepEqual(
    curatorPage.items.map(({ id }) => id).sort(),
    [visible.id, hidden.id].sort()
  );
  assert.equal(curatorPage.total, 2);

  const retrievalOnlyPage = await repo.listExperiences({
    context: { ...exactContext, canReadTaskHistory: true },
    memoryModes: ["retrieval-only"],
    outcomes: ["failure"],
    limit: 10,
    offset: 0
  });
  assert.deepEqual(
    retrievalOnlyPage.items.map(({ id }) => id),
    [hidden.id]
  );
  assert.equal(retrievalOnlyPage.total, 1);
});

test("unknown-mode experience reads include explicit and legacy unknown rows only", async () => {
  const pool = new FakeMemoryPool();
  const repo = repoWith(pool);
  const legacy = makeExperience({ id: "legacy-experience-mode" });
  const explicitUnknown = makeExperience({
    id: "explicit-unknown-experience-mode",
    memoryMode: "unknown"
  });
  const disabled = makeExperience({
    id: "disabled-experience-mode",
    memoryMode: "disabled"
  });
  await repo.appendExperience(legacy);
  await repo.appendExperience(explicitUnknown);
  await repo.appendExperience(disabled);

  const page = await repo.listExperiences({
    context: makeContext({ workspaceId: "ws-1", canReadTaskHistory: true }),
    memoryModes: ["unknown"],
    limit: 10,
    offset: 0
  });

  assert.deepEqual(
    page.items.map(({ id }) => id).sort(),
    [legacy.id, explicitUnknown.id].sort()
  );
  assert.equal(page.total, 2);
});

test("listExpiredExperiences selects only completed, scoped, unreferenced rows", async () => {
  const pool = new FakeMemoryPool();
  const repo = repoWith(pool);
  const scope = {
    kind: "task" as const,
    workspaceId: "ws-1",
    taskId: "task-retention",
    runId: "run-retention"
  };
  const makeTaskExperience = (
    id: string,
    completedAt?: string,
    repositoryId = "owner/repo"
  ) =>
    makeExperience({
      id,
      workspaceId: "ws-1",
      repositoryId,
      scope: { ...scope, runId: id },
      taskId: "task-retention",
      runId: id,
      ...(completedAt ? { completedAt } : {})
    });
  await repo.appendExperience(
    makeTaskExperience("exp-referenced", "2025-01-01T00:00:00.000Z")
  );
  await repo.appendExperience(
    makeTaskExperience("exp-expired", "2025-02-01T00:00:00.000Z")
  );
  await repo.appendExperience(
    makeTaskExperience("exp-recent", "2026-02-01T00:00:00.000Z")
  );
  await repo.appendExperience(makeTaskExperience("exp-incomplete"));
  await repo.appendExperience(
    makeTaskExperience(
      "exp-other-repository",
      "2025-03-01T00:00:00.000Z",
      "owner/other"
    )
  );
  const memory = makeMemoryRecord({
    provenance: {
      experienceIds: ["exp-referenced"],
      evidence: [{ kind: "commit", uri: "git://owner/repo/commit/abc" }],
      createdBy: "curator",
      createdAt: "2025-01-01T00:00:00.000Z"
    }
  });
  await repo.proposeMemory(memory, makeLifecycleEvent({ memoryId: memory.id }));

  const candidates = await repo.listExpiredExperiences({
    context: makeContext({
      workspaceId: "ws-1",
      repositoryId: "owner/repo",
      canReadTaskHistory: true
    }),
    completedBefore: "2026-01-01T00:00:00.000Z",
    limit: 10
  });

  assert.deepEqual(
    candidates.map(({ id }) => id),
    ["exp-expired"]
  );
});

test("purgeExperience erases only unreferenced runs and writes a fingerprinted privacy event", async () => {
  const pool = new FakeMemoryPool();
  const repo = repoWith(pool);
  const experience = makeExperience({ id: "exp-privacy-1" });
  await repo.appendExperience(experience);
  const result = await repo.purgeExperience({
    experienceId: experience.id,
    context: makeContext({
      workspaceId: "ws-1",
      taskId: "task-1",
      runId: "run-1"
    }),
    eventId: "privacy-event-1",
    actorId: "curator-1",
    reason: "privacy_request",
    occurredAt: "2026-10-01T12:00:00.000Z"
  });

  assert.equal(result, "purged");
  assert.equal(
    await repo.getExperience(
      experience.id,
      makeContext({ workspaceId: "ws-1", taskId: "task-1", runId: "run-1" })
    ),
    null
  );
  const event = pool.tables.memory_experience_privacy_events[0];
  assert.ok(event);
  assert.equal(event.actor_id, "curator-1");
  assert.equal(event.reason, "privacy_request");
  assert.notEqual(event.experience_fingerprint, experience.id);
  assert.equal(String(event.experience_fingerprint).length, 64);
});

test("purgeExperience refuses to break memory provenance and denies invisible runs", async () => {
  const pool = new FakeMemoryPool();
  const repo = repoWith(pool);
  await repo.appendExperience(makeExperience());
  const memory = makeMemoryRecord();
  await repo.proposeMemory(memory, makeLifecycleEvent({ memoryId: memory.id }));
  const request = {
    experienceId: "exp-1",
    context: makeContext({
      workspaceId: "ws-1",
      taskId: "task-1",
      runId: "run-1"
    }),
    eventId: "privacy-event-2",
    actorId: "curator-1",
    reason: "retention_expired" as const,
    occurredAt: "2026-10-01T12:00:00.000Z"
  };

  assert.equal(await repo.purgeExperience(request), "referenced_by_memory");
  assert.equal(pool.tables.memory_experiences.has("exp-1"), true);
  assert.equal(pool.tables.memory_experience_privacy_events.length, 0);
  assert.equal(
    await repo.purgeExperience({
      ...request,
      experienceId: "not-visible",
      context: makeContext({ workspaceId: "ws-other" })
    }),
    "not_visible"
  );
});
