import path from "node:path";

import {
  type MemoryActor,
  type MemoryAuthority,
  type MemoryExecutionMode,
  type MemoryReadContext,
  parseMemoryExecutionMode
} from "@simulatorlife/autodev-core";

import type { MemoryMcpSessionProvider } from "./mcp.ts";
import {
  createPostgresMemoryHost,
  type PostgresMemoryHost,
  type PostgresMemoryHostOptions
} from "./postgres.ts";
import type { MemoryEmbeddingProvider, MemoryService } from "./service.ts";
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
  readonly memoryMode: MemoryExecutionMode;
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
      env.AUTODEV_MEMORY_READ_TASK_HISTORY === "1",
    memoryMode: parseMemoryExecutionMode(
      env.AUTODEV_MEMORY_MODE,
      env.AUTODEV_MEMORY_ABLATION === "1"
    )
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
      task: researchQuery?.trim() || configuration.task,
      memoryMode: configuration.memoryMode
    })
  };
}

/**
 * The process facts startup reads and the shutdown hooks it registers.
 *
 * All of it used to be a direct `process` reach, which is why the only two
 * branches in this file that actually own a resource -- closing the host when
 * the transport fails to serve, and the close-once chain behind a signal --
 * had never run outside a real process. A leaked Postgres pool is exactly the
 * failure that only shows up under load, long after the process that made it
 * is gone.
 *
 * `serve` is typed on what this file calls, not on the SDK's `McpServer`, so a
 * test can substitute a double without reimplementing the SDK surface.
 */
export interface MemoryMcpRuntime {
  readonly env: NodeJS.ProcessEnv;
  readonly pid: number;
  readonly createHost: (
    options: PostgresMemoryHostOptions
  ) => PostgresMemoryHost;
  readonly serve: (
    service: MemoryService,
    sessionProvider: MemoryMcpSessionProvider
  ) => Promise<{ close(): Promise<void> }>;
  readonly onShutdown: (handler: () => void) => void;
}

const nodeRuntime: MemoryMcpRuntime = {
  env: process.env,
  pid: process.pid,
  createHost: createPostgresMemoryHost,
  serve: serveMemoryMcpStdio,
  onShutdown: (handler) => {
    process.once("SIGINT", handler);
    process.once("SIGTERM", handler);
    process.stdin.once("end", handler);
    process.stdin.once("error", handler);
  }
};

export async function startMemoryMcpFromEnvironment(
  embedder?: MemoryEmbeddingProvider,
  runtime: MemoryMcpRuntime = nodeRuntime
): Promise<void> {
  const configuration = memoryStdioConfiguration(runtime.env, runtime.pid);
  const host = runtime.createHost({
    databaseUrl: configuration.databaseUrl,
    ...(embedder ? { embedder } : {})
  });
  const service = host.createService({
    resolve: (context) =>
      configuration.repositoryRoot &&
      context.workspaceId === configuration.workspaceId &&
      context.repositoryId === configuration.repositoryId
        ? configuration.repositoryRoot
        : null
  });
  let server: { close(): Promise<void> };
  try {
    server = await runtime.serve(
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
  runtime.onShutdown(() => void close());
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
