import path from "node:path";
import { pathToFileURL } from "node:url";

import type {
  MemoryActor,
  MemoryAuthority,
  MemoryReadContext
} from "@simulatorlife/autodev-core";

import type { MemoryMcpSessionProvider } from "./mcp.ts";
import { createPostgresMemoryHost } from "./postgres.ts";
import { serveMemoryMcpStdio } from "./stdio.ts";

export interface MemoryStdioConfiguration {
  readonly databaseUrl: string;
  readonly workspaceId: string;
  readonly repositoryId: string;
  readonly repositoryRoot: string | null;
  readonly role: string;
  readonly actor: MemoryActor;
  readonly taskId: string;
  readonly runId: string;
  readonly task: string;
  readonly canReadGlobal: boolean;
  readonly canReadTaskHistory: boolean;
}

/** Build a trusted, process-bound MCP context; no value comes from tool arguments. */
export function memoryStdioConfiguration(
  env: NodeJS.ProcessEnv,
  processId: number
): MemoryStdioConfiguration {
  const databaseUrl = required(env.AUTODEV_MEMORY_DATABASE_URL, "database URL");
  const workspaceId = required(env.AUTODEV_MEMORY_WORKSPACE_ID, "workspace id");
  const repositoryId = required(
    env.AUTODEV_MEMORY_REPOSITORY_ID,
    "repository id"
  );
  const actorId =
    env.AUTODEV_MEMORY_ACTOR_ID?.trim() || `memory-mcp-${processId}`;
  const role = env.AUTODEV_MEMORY_ROLE?.trim() || "worker";
  const authority = memoryAuthority(env.AUTODEV_MEMORY_AUTHORITY);
  const repositoryRoot = env.AUTODEV_MEMORY_REPOSITORY_ROOT?.trim() || null;
  const taskId = env.AUTODEV_MEMORY_TASK_ID?.trim() || `mcp-task-${processId}`;
  const runId = env.AUTODEV_MEMORY_RUN_ID?.trim() || `mcp-run-${processId}`;
  const task =
    env.AUTODEV_MEMORY_TASK_TEXT?.trim() || "External MCP memory follow-up";
  return {
    databaseUrl,
    workspaceId,
    repositoryId,
    repositoryRoot:
      repositoryRoot && path.isAbsolute(repositoryRoot) ? repositoryRoot : null,
    role,
    actor: { id: actorId, authority, role },
    taskId,
    runId,
    task,
    canReadGlobal:
      (authority === "root" || authority === "curator") &&
      env.AUTODEV_MEMORY_READ_GLOBAL === "1",
    canReadTaskHistory:
      (authority === "root" || authority === "curator") &&
      env.AUTODEV_MEMORY_READ_TASK_HISTORY === "1"
  };
}

export function memoryMcpSessionProvider(
  configuration: MemoryStdioConfiguration
): MemoryMcpSessionProvider {
  const context: MemoryReadContext = {
    workspaceId: configuration.workspaceId,
    repositoryId: configuration.repositoryId,
    role: configuration.role,
    taskId: configuration.taskId,
    runId: configuration.runId,
    agentId: configuration.actor.id,
    canReadGlobal: configuration.canReadGlobal,
    canReadTaskHistory: configuration.canReadTaskHistory
  };
  return {
    current: (researchQuery) => ({
      actor: configuration.actor,
      context,
      taskId: configuration.taskId,
      task: researchQuery?.trim() || configuration.task
    })
  };
}

export async function startMemoryMcpFromEnvironment(): Promise<void> {
  const configuration = memoryStdioConfiguration(process.env, process.pid);
  const host = createPostgresMemoryHost({
    databaseUrl: configuration.databaseUrl
  });
  const service = host.createService({
    resolve: (context) =>
      configuration.repositoryRoot &&
      context.workspaceId === configuration.workspaceId &&
      context.repositoryId === configuration.repositoryId
        ? configuration.repositoryRoot
        : null
  });
  let server: Awaited<ReturnType<typeof serveMemoryMcpStdio>>;
  try {
    server = await serveMemoryMcpStdio(
      service,
      memoryMcpSessionProvider(configuration)
    );
  } catch (error) {
    await host.close();
    throw error;
  }

  let closePromise: Promise<void> | null = null;
  const close = () => {
    closePromise ??= server
      .close()
      .catch(() => {})
      .then(() => host.close());
    return closePromise;
  };
  process.once("SIGINT", () => void close());
  process.once("SIGTERM", () => void close());
  process.stdin.once("end", () => void close());
  process.stdin.once("error", () => void close());
}

function required(value: string | undefined, name: string): string {
  const normalized = value?.trim();
  if (!normalized) throw new Error(`Memory MCP requires a configured ${name}.`);
  return normalized;
}

function memoryAuthority(value: string | undefined): MemoryAuthority {
  if (value === "root" || value === "curator" || value === "system")
    return value;
  return "worker";
}

const entryPoint = process.argv[1];
if (entryPoint && import.meta.url === pathToFileURL(entryPoint).href) {
  await startMemoryMcpFromEnvironment();
}
