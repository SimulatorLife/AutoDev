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
import { experienceToRow } from "../../src/memory/serialize.ts";

const databaseUrl = process.env.AUTODEV_MEMORY_TEST_DATABASE_URL;

test(
  "live PostgreSQL/pgvector migration, path/evidence search, governed persistence, and append-only history",
  { skip: !databaseUrl },
  async () => {
    const pool = createPgMemoryPool(databaseUrl!);
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
    const pullRequestEvidence: EvidenceReference = {
      kind: "pull_request",
      uri: `https://github.com/${repositoryId}/pull/731`
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
      taskKind: "bugfix",
      agentId: "integration-test",
      agentRole: "worker",
      startedAt: now,
      outcome: "success",
      trajectory: {
        format: "letta-trajectory-v1",
        uri: `file:///workspace/${repositoryId}/trajectory.jsonl`,
        recordCount: 3,
        sourceAdapter: "codex",
        normalizerId: "@letta-ai/trajectory",
        normalizerVersion: "0.4.3",
        diagnosticCodes: ["injected_context_dropped", "timestamps_synthesized"]
      },
      evidence: [evidence, pullRequestEvidence]
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
      const storedExperience = await repository.getExperience(
        experience.id,
        context
      );
      assert.deepEqual(storedExperience?.trajectory, experience.trajectory);
      const { normalizerVersion: _normalizerVersion, ...incompleteTrajectory } =
        experience.trajectory;
      await assert.rejects(
        repository.appendExperience({
          ...experience,
          id: `exp-partial-provenance-${identity}`,
          trajectory: incompleteTrajectory
        }),
        /Trajectory provenance fields must be populated together/u
      );
      const invalidDatabaseRow = experienceToRow({
        ...experience,
        id: `exp-partial-database-provenance-${identity}`
      });
      invalidDatabaseRow.trajectory_normalizer_version = null;
      const columns = Object.keys(invalidDatabaseRow);
      const placeholders = columns.map((_, index) => `$${index + 1}`);
      await assert.rejects(
        pool.query(
          `INSERT INTO memory_experiences (${columns.join(", ")}) VALUES (${placeholders.join(", ")})`,
          Object.values(invalidDatabaseRow)
        ),
        /memory_experiences_trajectory_provenance_check/u
      );
      const fileReferenceHits = await repository.searchExperiences({
        query: "service",
        context
      });
      assert.deepEqual(
        fileReferenceHits.map(({ id }) => id),
        [experience.id]
      );
      const pullRequestHits = await repository.searchExperiences({
        query: "pull 731",
        context
      });
      assert.deepEqual(
        pullRequestHits.map(({ id }) => id),
        [experience.id]
      );
      await repository.proposeMemory(record, event, embedding);
      const nearbyEvidence: EvidenceReference = {
        kind: "file",
        uri: `file:///workspace/${repositoryId}/src/memory/nearby.ts`,
        revision: "commit-a"
      };
      const nearbyRecord: MemoryRecord = {
        ...record,
        id: `mem-nearby-${identity}`,
        provenance: { ...record.provenance, evidence: [nearbyEvidence] }
      };
      await repository.proposeMemory(nearbyRecord, {
        ...event,
        id: `evt-nearby-proposed-${identity}`,
        memoryId: nearbyRecord.id,
        evidence: [nearbyEvidence]
      });

      const expiredUnreferenced = {
        ...experience,
        id: `exp-retention-${identity}`,
        completedAt: new Date(Date.parse(now) - 60_000).toISOString()
      };
      await repository.appendExperience(expiredUnreferenced);
      const retentionCandidates = await repository.listExpiredExperiences({
        context,
        completedBefore: now,
        limit: 10
      });
      assert.deepEqual(
        retentionCandidates.map(({ id }) => id),
        [expiredUnreferenced.id]
      );

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
      const nearbyActive: MemoryRecord = {
        ...nearbyRecord,
        status: "active",
        validity: {
          state: "verified",
          checkedAt: now,
          verificationSource: "live-integration-test",
          evidence: [nearbyEvidence]
        },
        updatedAt: new Date(Date.now() + 2).toISOString()
      };
      assert.equal(
        await repository.transitionMemories(
          [
            {
              expectedUpdatedAt: nearbyRecord.updatedAt,
              next: nearbyActive
            }
          ],
          [
            {
              id: `evt-nearby-active-${identity}`,
              memoryId: nearbyActive.id,
              action: "promoted",
              actorId: "integration-test",
              occurredAt: nearbyActive.updatedAt,
              fromStatus: "proposed",
              toStatus: "active",
              reasonCode: "verified_current_state",
              evidence: [nearbyEvidence],
              relatedMemoryIds: []
            }
          ]
        ),
        true
      );

      const hits = await repository.searchMemories({
        query: "memory research service historical guidance",
        taskKind: "bugfix",
        context,
        asOf: active.updatedAt,
        relevantPaths: [evidence.uri]
      });
      assert.equal(hits.length, 2);
      assert.equal(hits[0]?.memory.id, active.id);
      assert.equal(hits[1]?.memory.id, nearbyActive.id);
      assert.deepEqual(hits[0]?.matchedSignals, [
        "lexical",
        "path",
        "task_kind"
      ]);
      assert.deepEqual(hits[1]?.matchedSignals, [
        "lexical",
        "path",
        "task_kind"
      ]);

      const vectorHits = await repository.searchMemories({
        query: "memory research service historical guidance",
        context,
        asOf: active.updatedAt,
        queryEmbedding: embedding
      });
      assert.equal(vectorHits.length, 2);
      assert.equal(vectorHits[0]?.memory.id, active.id);
      assert.deepEqual(vectorHits[0]?.matchedSignals, ["lexical", "semantic"]);
      assert.deepEqual(vectorHits[1]?.matchedSignals, ["lexical"]);

      // A shared durable record may cite an older task-scoped episode after a
      // curator review. Its private task kind must not affect a reader who has
      // no task-history grant, even though the durable record itself is visible.
      const privateTaskId = `private-task-${identity}`;
      const privateRunId = `private-run-${identity}`;
      const privateExperience: ExperienceEnvelope = {
        ...experience,
        id: `exp-private-${identity}`,
        scope: {
          kind: "task",
          workspaceId,
          taskId: privateTaskId,
          runId: privateRunId
        },
        taskId: privateTaskId,
        runId: privateRunId,
        taskKind: "private-investigation",
        startedAt: new Date(Date.parse(now) - 86_400_000).toISOString(),
        evidence: [evidence]
      };
      await repository.appendExperience(privateExperience);
      const sharedMemory: MemoryRecord = {
        ...record,
        id: `mem-shared-private-source-${identity}`,
        scope: { kind: "workspace", workspaceId },
        provenance: {
          ...record.provenance,
          experienceIds: [privateExperience.id]
        }
      };
      await repository.proposeMemory(sharedMemory, {
        ...event,
        id: `evt-shared-private-${identity}`,
        memoryId: sharedMemory.id
      });
      const sharedActive: MemoryRecord = {
        ...sharedMemory,
        status: "active",
        validity: {
          state: "verified",
          checkedAt: now,
          verificationSource: "live-integration-test",
          evidence: [evidence]
        },
        updatedAt: new Date(Date.now() + 3).toISOString()
      };
      assert.equal(
        await repository.transitionMemories(
          [{ expectedUpdatedAt: sharedMemory.updatedAt, next: sharedActive }],
          [
            {
              id: `evt-shared-private-active-${identity}`,
              memoryId: sharedActive.id,
              action: "promoted",
              actorId: "integration-curator",
              occurredAt: sharedActive.updatedAt,
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
      const privateKindHits = await repository.searchMemories({
        query: "memory research service historical guidance",
        taskKind: "private-investigation",
        context,
        asOf: active.updatedAt
      });
      const privateSourceHit = privateKindHits.find(
        ({ memory }) => memory.id === sharedActive.id
      );
      assert.ok(privateSourceHit);
      assert.ok(!privateSourceHit.matchedSignals.includes("task_kind"));
      const noTaskKindHits = await repository.searchMemories({
        query: "memory research service historical guidance",
        context,
        asOf: active.updatedAt
      });
      assert.equal(
        privateSourceHit.score,
        noTaskKindHits.find(({ memory }) => memory.id === sharedActive.id)
          ?.score
      );

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
