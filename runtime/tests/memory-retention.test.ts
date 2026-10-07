import assert from "node:assert/strict";
import test from "node:test";

import type { MemoryReadContext } from "@simulatorlife/autodev-core";

import type { PostgresMemoryHost } from "../src/memory/postgres.ts";
import {
  memoryRetentionConfiguration,
  runMemoryRetention
} from "../src/memory/retention-main.ts";
import type {
  MemoryExperienceRetentionReport,
  MemoryService
} from "../src/memory/service.ts";

const now = new Date("2026-10-01T00:00:00.000Z");
const environment = {
  AUTODEV_MEMORY_RETENTION_ENABLED: "1",
  AUTODEV_MEMORY_READ_TASK_HISTORY: "1",
  AUTODEV_MEMORY_DATABASE_URL: "postgresql://memory.invalid/autodev",
  AUTODEV_MEMORY_WORKSPACE_ID: "workspace-a",
  AUTODEV_MEMORY_REPOSITORY_ID: "owner/repo",
  AUTODEV_MEMORY_EXPERIENCE_RETENTION_DAYS: "30",
  AUTODEV_MEMORY_RETENTION_BATCH_SIZE: "25"
};

test("retention configuration is disabled unless an operator opts in", () => {
  assert.throws(
    () => memoryRetentionConfiguration({}, now),
    /AUTODEV_MEMORY_RETENTION_ENABLED=1/
  );
});

test("retention configuration requires a workspace-bound task-history grant and explicit age", () => {
  assert.throws(
    () =>
      memoryRetentionConfiguration(
        { ...environment, AUTODEV_MEMORY_READ_TASK_HISTORY: "0" },
        now
      ),
    /task-history grant/
  );
  assert.throws(
    () =>
      memoryRetentionConfiguration(
        { ...environment, AUTODEV_MEMORY_EXPERIENCE_RETENTION_DAYS: "0" },
        now
      ),
    /outside its allowed bound/
  );
  assert.throws(
    () =>
      memoryRetentionConfiguration(
        { ...environment, AUTODEV_MEMORY_REPOSITORY_ID: undefined },
        now
      ),
    /repository id/
  );
});

test("retention configuration computes a bounded cutoff and repository scope", () => {
  const configuration = memoryRetentionConfiguration(environment, now);
  assert.equal(configuration.completedBefore, "2026-09-01T00:00:00.000Z");
  assert.equal(configuration.limit, 25);
  assert.equal(configuration.actor.authority, "curator");
  assert.deepEqual(configuration.context, {
    workspaceId: "workspace-a",
    repositoryId: "owner/repo",
    role: "memory-retention",
    canReadGlobal: false,
    canReadTaskHistory: true
  });
});

test("retention refuses an actor id that would not survive the audit trail", () => {
  // The actor id is recorded on every purge event, and retention is the one
  // operation whose records cannot be taken back. An id carrying whitespace, a
  // quote, or a newline would land in that record verbatim; an over-long one
  // bloats every event it appears on.
  const accepted = memoryRetentionConfiguration(
    {
      ...environment,
      AUTODEV_MEMORY_RETENTION_ACTOR_ID: "retention@ops:nightly"
    },
    now
  );
  assert.equal(accepted.actor.id, "retention@ops:nightly");

  for (const actorId of [
    // Internal whitespace survives the trim, so the fallback never rescues it.
    "retention bot",
    'retention"; DROP',
    "retention\nforged",
    // Over the 128-character bound the pattern allows.
    "r".repeat(129)
  ]) {
    assert.throws(
      () =>
        memoryRetentionConfiguration(
          { ...environment, AUTODEV_MEMORY_RETENTION_ACTOR_ID: actorId },
          now
        ),
      /actor id is invalid/u,
      `must refuse ${JSON.stringify(actorId)}`
    );
  }
});

test("retention refuses a clock it cannot turn into a cutoff", () => {
  // Without the guard this surfaces later as `RangeError: Invalid time value`
  // from `toISOString`, which names neither the clock nor the fact that the
  // cutoff is what could not be computed. Asserting the type as well as the
  // message is what separates the two: RangeError is not a TypeError.
  assert.throws(
    () => memoryRetentionConfiguration(environment, new Date(Number.NaN)),
    (error: unknown) =>
      error instanceof TypeError &&
      /Memory retention clock is invalid/u.test(error.message)
  );
});

test("retention runner delegates one bounded curator batch to MemoryService", async () => {
  const configuration = memoryRetentionConfiguration(environment, now);
  let observed: {
    completedBefore: string;
    limit: number;
    context: MemoryReadContext;
    actor: { id: string; authority: string };
  } | null = null;
  const report: MemoryExperienceRetentionReport = {
    selected: 2,
    purged: 1,
    referencedByMemory: 1,
    noLongerVisible: 0
  };
  const service = {
    purgeExpiredExperiences: async (input: NonNullable<typeof observed>) => {
      observed = input;
      return report;
    }
  } as unknown as MemoryService;
  const host: PostgresMemoryHost = {
    createService: () => service,
    probe: async () => "reachable",
    close: async () => undefined
  };

  assert.deepEqual(await runMemoryRetention(host, configuration), report);
  assert.deepEqual(observed, {
    completedBefore: configuration.completedBefore,
    limit: configuration.limit,
    context: configuration.context,
    actor: configuration.actor
  });
});
