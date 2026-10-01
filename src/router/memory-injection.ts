import path from "node:path";

import type { MemoryReadContext } from "@simulatorlife/autodev-core";
import {
  createPostgresMemoryHost,
  injectMemoryContext,
  latestUserTask,
  type MemoryRepositoryRootResolver,
  type PostgresMemoryHost
} from "@simulatorlife/autodev-runtime/memory";
import { awaitedToolResults } from "@simulatorlife/autodev-runtime/shared/responses-continuation";

import { RoutedMemoryReconstructor } from "./memory-reconstruction.ts";
import { routerTelemetryTracer } from "./telemetry.ts";

export interface OrchestratorMemoryRequest {
  readonly payload: Record<string, unknown>;
  readonly requestId: string;
  readonly sessionKey: string | null;
  readonly threadId: string | null;
  readonly workspace: {
    readonly key: string;
    readonly cwd?: string | null;
    readonly workspace_id?: string;
  } | null;
}

let memoryHost: PostgresMemoryHost | null = null;
let memoryDatabaseUrl: string | null = null;
let memoryHostClose: Promise<void> | null = null;
const trustedRepositoryRoots = new Map<string, string>();
const trustedSessionContexts = new Map<
  string,
  { workspaceId: string; repositoryId: string; root: string } | null
>();

/**
 * Automatically add a governed packet to a root user turn before any provider
 * sees it. Tool-result continuations without a new human steer are untouched.
 */
export async function injectOrchestratorMemory(
  request: OrchestratorMemoryRequest,
  hostOverride?: PostgresMemoryHost | null
): Promise<Record<string, unknown>> {
  const workspace = request.workspace;
  if (
    !workspace ||
    !workspace.key.trim() ||
    workspace.key === "unknown" ||
    !workspace.cwd ||
    !path.isAbsolute(workspace.cwd)
  ) {
    return request.payload;
  }
  if (
    request.payload.instructions !== undefined &&
    typeof request.payload.instructions !== "string"
  ) {
    return request.payload;
  }

  const pending = awaitedToolResults(request.payload.input);
  const taskInput =
    pending.outputs.size > 0 ? pending.messages : request.payload.input;
  const task = latestUserTask(taskInput);
  if (!task) return request.payload;

  const host =
    hostOverride === undefined ? configuredMemoryHost() : hostOverride;
  if (!host) return request.payload;

  const workspaceId = workspace.workspace_id?.trim() || workspace.key;
  const taskId = request.sessionKey ?? request.requestId;
  rememberTrustedRepositoryRoot(
    workspaceId,
    workspace.key,
    workspace.cwd,
    [request.sessionKey, request.threadId, taskId].filter(
      (value): value is string => Boolean(value?.trim())
    )
  );
  const context: MemoryReadContext = {
    workspaceId,
    repositoryId: workspace.key,
    role: "orchestrator",
    taskId,
    runId: request.requestId,
    ...(request.threadId ? { agentId: request.threadId } : {}),
    canReadGlobal: process.env.AUTODEV_MEMORY_READ_GLOBAL === "1"
  };
  const service = host.createService({
    resolve: (scope) =>
      scope.workspaceId === workspaceId && scope.repositoryId === workspace.key
        ? (workspace.cwd ?? null)
        : null
  });

  try {
    return await injectMemoryContext(service, request.payload, {
      taskId,
      runId: request.requestId,
      task,
      context
    });
  } catch {
    // Historical memory is advisory; a database/curation failure must not fail the task.
    return request.payload;
  }
}

/** Reuse the router's one process-local PostgreSQL host for operator reads. */
export function createOrchestratorMemoryService(
  repositories: MemoryRepositoryRootResolver = trustedRepositoryResolver
) {
  return configuredMemoryHost()?.createService(repositories) ?? null;
}

function rememberTrustedRepositoryRoot(
  workspaceId: string,
  repositoryId: string,
  root: string,
  sessionIds: readonly string[]
): void {
  const key = `${workspaceId}\u0000${repositoryId}`;
  trustedRepositoryRoots.delete(key);
  trustedRepositoryRoots.set(key, root);
  while (trustedRepositoryRoots.size > 256) {
    const oldest = trustedRepositoryRoots.keys().next().value as
      string | undefined;
    if (oldest === undefined) break;
    trustedRepositoryRoots.delete(oldest);
  }
  for (const sessionId of sessionIds) {
    const existing = trustedSessionContexts.get(sessionId);
    const next = { workspaceId, repositoryId, root };
    trustedSessionContexts.set(
      sessionId,
      existing &&
        (existing.workspaceId !== workspaceId ||
          existing.repositoryId !== repositoryId ||
          existing.root !== root)
        ? null
        : next
    );
    while (trustedSessionContexts.size > 512) {
      const oldest = trustedSessionContexts.keys().next().value as
        string | undefined;
      if (oldest === undefined) break;
      trustedSessionContexts.delete(oldest);
    }
  }
}

/** Resolve only an exact session/repository pairing previously seen by the router. */
export function trustedMemoryContextForSession(
  sessionId: string,
  root: string
): { workspaceId: string; repositoryId: string; root: string } | null {
  const context = trustedSessionContexts.get(sessionId);
  if (!context || path.resolve(context.root) !== path.resolve(root))
    return null;
  return context;
}

const trustedRepositoryResolver: MemoryRepositoryRootResolver = {
  resolve: (scope) =>
    Promise.resolve(
      scope.repositoryId
        ? (trustedRepositoryRoots.get(
            `${scope.workspaceId}\u0000${scope.repositoryId}`
          ) ?? null)
        : null
    )
};

/** Release the shared pool when the router drains. Repeated shutdown paths share one close. */
export function closeOrchestratorMemoryHost(): Promise<void> {
  if (memoryHostClose) return memoryHostClose;
  const current = memoryHost;
  if (!current) return Promise.resolve();
  memoryHostClose = current.close().finally(() => {
    if (memoryHost === current) {
      memoryHost = null;
      memoryDatabaseUrl = null;
    }
    memoryHostClose = null;
  });
  return memoryHostClose;
}

function configuredMemoryHost(): PostgresMemoryHost | null {
  if (memoryHostClose) return null;
  const databaseUrl = process.env.AUTODEV_MEMORY_DATABASE_URL?.trim();
  if (!databaseUrl) return null;
  // Install the configured global MeterProvider before constructing
  // MemoryService instruments; the OTel Metrics API does not proxy meters
  // created before a provider has been registered.
  routerTelemetryTracer();
  if (memoryHost) return memoryDatabaseUrl === databaseUrl ? memoryHost : null;
  try {
    const useExistingOrchestratorModel =
      process.env.AUTODEV_MEMORY_RECONSTRUCTION !== "deterministic";
    memoryHost = createPostgresMemoryHost({
      databaseUrl,
      ...(useExistingOrchestratorModel
        ? {
            reconstructor: new RoutedMemoryReconstructor(),
            maxResearchCandidates: 2
          }
        : {})
    });
    memoryDatabaseUrl = databaseUrl;
    return memoryHost;
  } catch {
    return null;
  }
}
