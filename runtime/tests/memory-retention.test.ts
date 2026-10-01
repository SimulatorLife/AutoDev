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
