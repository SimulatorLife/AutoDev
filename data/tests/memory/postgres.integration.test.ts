import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import {
  type EvidenceReference,
  type ExperienceEnvelope,
  type MemoryLifecycleEvent,
  type MemoryReadContext,
  type MemoryRecord
} from "@simulatorlife/autodev-core";

import { createPgMemoryPool } from "../../src/memory/pg-pool.ts";
import { PostgresMemoryRepository } from "../../src/memory/postgres-memory-repository.ts";
import {
  applyMemoryMigrations,
  MEMORY_EMBEDDING_DIMENSIONS
} from "../../src/memory/schema.ts";

const databaseUrl = process.env.AUTODEV_MEMORY_TEST_DATABASE_URL;

test(
  "live PostgreSQL/pgvector migration, governed persistence, hard filters, and append-only history",
  { skip: !databaseUrl },
  async () => {
    const pool = createPgMemoryPool({ connectionString: databaseUrl });
    const identity = randomUUID();
    const workspaceId = `memory-test-${identity}`;
    const repositoryId = `repo-${identity}`;
    const taskId = `task-${identity}`;
    const runId = `run-${identity}`;
    const now = new Date().toISOString();
    const evidence: EvidenceReference = {
      kind: "file",
      uri: `file:///workspace/${repositoryId}/src/memory/service.ts`,
      revision: "commit-a"
    };
    const context: MemoryReadContext = {
      workspaceId,
      repositoryId,
      taskId,
      runId,
      role: "worker",
      agentId: "integration-test",
      canReadGlobal: false
    };
    const experience: ExperienceEnvelope = {
      id: `exp-${identity}`,
      workspaceId,
      repositoryId,
      scope: { kind: "repository", workspaceId, repositoryId },
      taskId,
      runId,
      agentId: "integration-test",
      agentRole: "worker",
      startedAt: now,
      outcome: "success",
      trajectory: {
        format: "test-normalized-trajectory",
        uri: `file:///workspace/${repositoryId}/trajectory.jsonl`,
        recordCount: 3
      },
      evidence: [evidence]
    };
    const record: MemoryRecord = {
      id: `mem-${identity}`,
      kind: "procedural",
      scope: { kind: "repository", workspaceId, repositoryId },
      claim:
        "Use the memory research service before applying historical guidance.",
      status: "proposed",
      provenance: {
        experienceIds: [experience.id],
        evidence: [evidence],
        createdBy: "integration-test",
        createdAt: now
      },
      validity: { state: "unverified", evidence: [] },
      createdAt: now,
      updatedAt: now
    };
    const event: MemoryLifecycleEvent = {
      id: `evt-proposed-${identity}`,
      memoryId: record.id,
      action: "proposed",
      actorId: "integration-test",
      occurredAt: now,
      toStatus: "proposed",
      reasonCode: "candidate_submitted",
      evidence: [evidence],
      relatedMemoryIds: []
    };
    const embedding = Array.from(
      { length: MEMORY_EMBEDDING_DIMENSIONS },
      (_, index) => (index === 0 ? 1 : 0)
    );

    try {
      await applyMemoryMigrations(pool);
      await applyMemoryMigrations(pool);
      const repository = new PostgresMemoryRepository({
        pool,
        vectorSupport: { dimensions: MEMORY_EMBEDDING_DIMENSIONS }
      });
      await repository.appendExperience(experience);
      await repository.proposeMemory(record, event, embedding);

      const referencedPurge = await repository.purgeExperience({
        experienceId: experience.id,
        context,
        eventId: `privacy-referenced-${identity}`,
        actorId: "integration-curator",
        reason: "privacy_request",
        occurredAt: now
      });
      assert.equal(referencedPurge, "referenced_by_memory");
      assert.ok(await repository.getExperience(experience.id, context));
      await assert.rejects(
        pool.query("DELETE FROM memory_experiences WHERE id = $1", [
          experience.id
        ]),
        /append-only/
      );

      await assert.rejects(
        pool.query(
          "UPDATE memory_experiences SET outcome = 'failure' WHERE id = $1",
          [experience.id]
        ),
        /append-only/
      );

      const active: MemoryRecord = {
        ...record,
        status: "active",
        validity: {
          state: "verified",
          checkedAt: now,
          verificationSource: "live-integration-test",
          evidence: [evidence]
        },
        updatedAt: new Date(Date.now() + 1).toISOString()
      };
      assert.equal(
        await repository.transitionMemories(
          [{ expectedUpdatedAt: record.updatedAt, next: active }],
          [
            {
              id: `evt-active-${identity}`,
              memoryId: active.id,
              action: "promoted",
              actorId: "integration-test",
              occurredAt: active.updatedAt,
              fromStatus: "proposed",
              toStatus: "active",
              reasonCode: "verified_current_state",
              evidence: [evidence],
              relatedMemoryIds: []
            }
          ]
        ),
        true
      );

      const hits = await repository.searchMemories({
        query: "memory research service historical guidance",
        context,
        asOf: active.updatedAt,
        relevantPaths: [evidence.uri],
        queryEmbedding: embedding
      });
      assert.equal(hits.length, 1);
      assert.equal(hits[0]?.memory.id, active.id);
      assert.deepEqual(hits[0]?.matchedSignals, [
        "lexical",
        "semantic",
        "path"
      ]);

      const history = await repository.getMemoryHistory(active.id, context);
      assert.equal(history?.events.length, 2);
      assert.equal(history?.memory.status, "active");

      const unreferenced = {
        ...experience,
        id: `exp-unreferenced-${identity}`,
        taskId: `task-unreferenced-${identity}`,
        runId: `run-unreferenced-${identity}`
      };
      await repository.appendExperience(unreferenced);
      const purgeEventId = `privacy-purged-${identity}`;
      assert.equal(
        await repository.purgeExperience({
          experienceId: unreferenced.id,
          context,
          eventId: purgeEventId,
          actorId: "integration-curator",
          reason: "retention_expired",
          occurredAt: now
        }),
        "purged"
      );
      assert.equal(
        await repository.getExperience(unreferenced.id, context),
        null
      );
      const tombstone = await pool.query<{
        experience_fingerprint: string;
        actor_id: string;
        reason: string;
      }>(
        "SELECT experience_fingerprint, actor_id, reason FROM memory_experience_privacy_events WHERE id = $1",
        [purgeEventId]
      );
      assert.equal(tombstone.rows.length, 1);
      assert.equal(tombstone.rows[0]?.actor_id, "integration-curator");
      assert.equal(tombstone.rows[0]?.reason, "retention_expired");
      assert.equal(tombstone.rows[0]?.experience_fingerprint.length, 64);
      assert.notEqual(
        tombstone.rows[0]?.experience_fingerprint,
        unreferenced.id
      );
      await assert.rejects(
        pool.query(
          "DELETE FROM memory_experience_privacy_events WHERE id = $1",
          [purgeEventId]
        ),
        /append-only/
      );
    } finally {
      await pool.end();
    }
  }
);
