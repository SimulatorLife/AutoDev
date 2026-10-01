import { pathToFileURL } from "node:url";

import type {
  MemoryActor,
  MemoryReadContext
} from "@simulatorlife/autodev-core";

import {
  createPostgresMemoryHost,
  type PostgresMemoryHost
} from "./postgres.ts";
import type { MemoryExperienceRetentionReport } from "./service.ts";

const ACTOR_ID_PATTERN = /^[A-Za-z0-9@._:+-]{1,128}$/u;
const DAY_MILLISECONDS = 24 * 60 * 60 * 1000;
const DEFAULT_RETENTION_BATCH_SIZE = 100;
const MAX_RETENTION_DAYS = 36_500;
const INTEGER_PATTERN = /^\d+$/u;

export interface MemoryRetentionConfiguration {
  readonly databaseUrl: string;
  readonly workspaceId: string;
  readonly repositoryId: string;
  readonly actor: MemoryActor;
  readonly context: MemoryReadContext;
  readonly completedBefore: string;
  readonly limit: number;
}

/** Parse an explicitly configured one-shot retention policy; there is no implicit age. */
export function memoryRetentionConfiguration(
  env: NodeJS.ProcessEnv,
  now: Date = new Date()
): MemoryRetentionConfiguration {
  if (env.AUTODEV_MEMORY_RETENTION_ENABLED !== "1") {
    throw new Error("Set AUTODEV_MEMORY_RETENTION_ENABLED=1 to run retention.");
  }
  if (env.AUTODEV_MEMORY_READ_TASK_HISTORY !== "1") {
    throw new Error(
      "Retention requires the workspace/repository task-history grant."
    );
  }
  const databaseUrl = required(env.AUTODEV_MEMORY_DATABASE_URL, "database URL");
  const workspaceId = required(env.AUTODEV_MEMORY_WORKSPACE_ID, "workspace id");
  const repositoryId = required(
    env.AUTODEV_MEMORY_REPOSITORY_ID,
    "repository id"
  );
  const actorId =
    env.AUTODEV_MEMORY_RETENTION_ACTOR_ID?.trim() || "autodev-memory-retention";
  if (!ACTOR_ID_PATTERN.test(actorId)) {
    throw new Error("Memory retention actor id is invalid.");
  }

  const retentionDays = positiveInteger(
    env.AUTODEV_MEMORY_EXPERIENCE_RETENTION_DAYS,
    "experience retention days",
    MAX_RETENTION_DAYS
  );
  const limit = env.AUTODEV_MEMORY_RETENTION_BATCH_SIZE
    ? positiveInteger(
        env.AUTODEV_MEMORY_RETENTION_BATCH_SIZE,
        "retention batch size",
        DEFAULT_RETENTION_BATCH_SIZE
      )
    : DEFAULT_RETENTION_BATCH_SIZE;
  if (!Number.isFinite(now.valueOf())) {
    throw new TypeError("Memory retention clock is invalid.");
  }

  return {
    databaseUrl,
    workspaceId,
    repositoryId,
    actor: { id: actorId, authority: "curator", role: "memory-retention" },
    context: {
      workspaceId,
      repositoryId,
      role: "memory-retention",
      canReadGlobal: false,
      canReadTaskHistory: true
    },
    completedBefore: new Date(
      now.valueOf() - retentionDays * DAY_MILLISECONDS
    ).toISOString(),
    limit
  };
}

/** Execute one bounded retention batch in a process trusted by its operator. */
export function runMemoryRetention(
  host: PostgresMemoryHost,
  configuration: MemoryRetentionConfiguration
): Promise<MemoryExperienceRetentionReport> {
  const service = host.createService({ resolve: () => Promise.resolve(null) });
  return service.purgeExpiredExperiences({
    completedBefore: configuration.completedBefore,
    limit: configuration.limit,
    actor: configuration.actor,
    context: configuration.context
  });
}

export async function runMemoryRetentionFromEnvironment(
  env: NodeJS.ProcessEnv = process.env,
  now: Date = new Date()
): Promise<
  { readonly completedBefore: string } & MemoryExperienceRetentionReport
> {
  const configuration = memoryRetentionConfiguration(env, now);
  const host = createPostgresMemoryHost({
    databaseUrl: configuration.databaseUrl
  });
  try {
    const report = await runMemoryRetention(host, configuration);
    return { completedBefore: configuration.completedBefore, ...report };
  } finally {
    await host.close();
  }
}

function required(value: string | undefined, name: string): string {
  const normalized = value?.trim();
  if (!normalized)
    throw new Error(`Memory retention requires a configured ${name}.`);
  return normalized;
}

function positiveInteger(
  raw: string | undefined,
  name: string,
  maximum: number
): number {
  if (!raw || !INTEGER_PATTERN.test(raw)) {
    throw new Error(`Memory retention ${name} must be a positive integer.`);
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new Error(`Memory retention ${name} is outside its allowed bound.`);
  }
  return value;
}

const entryPoint = process.argv[1];
if (entryPoint && import.meta.url === pathToFileURL(entryPoint).href) {
  try {
    const result = await runMemoryRetentionFromEnvironment();
    process.stdout.write(
      `${JSON.stringify({ schema: "autodev-memory-retention-v1", ...result })}\n`
    );
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Retention failed.";
    process.stderr.write(`memory-retention: ${message}\n`);
    process.exitCode = 1;
  }
}
