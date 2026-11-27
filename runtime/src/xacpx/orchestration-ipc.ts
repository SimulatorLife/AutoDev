/**
Canonical AutoDev XACPX Orchestration IPC server.

Speaks `@ganglion/xacpx`'s Unix-domain-socket JSON-lines RPC protocol so the
official `xacpx mcp-stdio` frontend (reached through Supergateway by ChatGPT,
Codex, Claude, Antigravity, Copilot, and any other authorized orchestrator)
delegates directly through AutoDev's single `XacpxSessionManager` authority.

Security invariants enforced at this boundary:
- Role validation: unknown roles and orchestrator escalation (`role: "orchestrator"`)
  are denied fail-closed.
- Workspace confinement: delegated working directories must reside inside the
  coordinator's authorized workspace (resolved with realpath).
- Child ownership: every coordinator session can inspect, watch, message, approve,
  or cancel only tasks and child sessions it owns.
- Concurrency limits: active child turns per coordinator are bounded without
  leaking slots on rejection, failure, or cancellation.
- Delegated permissions: every child runs with its own canonical role contract,
  role-specific prompt, and ACP permission enforcement.
*/

import { createHash, randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { homedir } from "node:os";
import path from "node:path";

import { isRecord } from "@simulatorlife/autodev-core";
import {
  type AgentLaunchRejection,
  recordAgentLaunchStage
} from "@simulatorlife/autodev-runtime/router/telemetry";
import { errorMessage } from "@simulatorlife/autodev-runtime/shared/error-message";
import { resolveRuntimeSourceRoot } from "@simulatorlife/autodev-runtime/shared/runtime-source-root";

import {
  renderRoleSystemPrompt,
  validateDelegatedRole,
  validateDelegatedWorkspace,
  type XacpxSessionManager
} from "./manager.ts";

export type XacpxTaskStatus =
  | "needs_confirmation"
  | "queued"
  | "running"
  | "blocked"
  | "waiting_for_human"
  | "completed"
  | "failed"
  | "cancelled";

export interface XacpxTaskEventRecord {
  readonly seq: number;
  readonly at: string;
  readonly type:
    | "created"
    | "progress"
    | "status_changed"
    | "attention_required"
    | "cancel_requested";
  readonly status?: XacpxTaskStatus;
  readonly summary?: string;
  readonly message?: string;
}

export interface XacpxTaskRecord {
  taskId: string;
  sourceHandle: string;
  sourceKind: "coordinator";
  coordinatorSession: string;
  workerSession: string;
  workspace: string;
  cwd: string;
  targetAgent: string;
  role: string;
  task: string;
  status: XacpxTaskStatus;
  summary: string;
  resultText: string;
  createdAt: string;
  updatedAt: string;
  cancelRequestedAt?: string;
  cancelCompletedAt?: string;
  groupId?: string;
  ephemeralWorkerSession?: boolean;
  eventSeq: number;
  events: XacpxTaskEventRecord[];
}

interface RegisteredCoordinator {
  readonly coordinatorSession: string;
  readonly workspace?: string;
  readonly workspaceRoot?: string;
  readonly createdAt: string;
  updatedAt: string;
}

interface OrchestrationGroupRecord {
  readonly groupId: string;
  readonly coordinatorSession: string;
  readonly title: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

interface RpcRequest {
  id: string;
  method: string;
  params: Record<string, unknown>;
}

interface RpcSuccess {
  id: string;
  ok: true;
  result: unknown;
}

interface RpcError {
  id: string;
  ok: false;
  error: { code: string; message: string };
}

class OrchestrationRpcError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

export interface XacpxOrchestrationIpcOptions {
  readonly socketPath: string;
  readonly manager: XacpxSessionManager;
  readonly authorizedWorkspaceRoot?: string | null;
  readonly maxConcurrentChildrenPerCoordinator?: number;
  readonly repositoryRoot?: string;
  readonly env?: NodeJS.ProcessEnv;
}

export interface XacpxOrchestrationIpcHandle {
  readonly socketPath: string;
  readonly server: Server;
  close(): Promise<void>;
}

const TERMINAL_STATUSES = new Set<XacpxTaskStatus>([
  "completed",
  "failed",
  "cancelled"
]);
const ACTIVE_STATUSES = new Set<XacpxTaskStatus>([
  "queued",
  "running",
  "blocked",
  "waiting_for_human"
]);
const MAX_WATCH_TIMEOUT_MS = 60_000;
const DEFAULT_WATCH_TIMEOUT_MS = 25_000;
const DEFAULT_MAX_CONCURRENT_CHILDREN = 4;

const UNIX_SOCKET_MAX_BYTES = 96;

export function resolveXacpxOrchestrationSocketPath(
  codexHome?: string,
  environment: NodeJS.ProcessEnv = process.env
): string {
  const explicit =
    environment.XACPX_ORCHESTRATION_SOCKET?.trim() ||
    environment.AUTODEV_XACPX_ORCHESTRATION_SOCKET?.trim();
  if (explicit) return explicit;
  const home = environment.HOME?.trim() || homedir();
  const base =
    codexHome?.trim() || environment.CODEX_HOME?.trim() || path.join(home, ".codex");
  const preferred = path.join(base, "run", "xacpx-orchestration.sock");
  if (Buffer.byteLength(preferred, "utf8") <= UNIX_SOCKET_MAX_BYTES) {
    return preferred;
  }
  // macOS sockaddr_un.sun_path is limited to 104 bytes; fall back to a
  // deterministic short socket path in /tmp so long CODEX_HOME paths work.
  const digest = createHash("sha256")
    .update(preferred)
    .digest("hex")
    .slice(0, 16);
  return path.join("/tmp", `autodev-xacpx-${digest}.sock`);
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

function isTerminal(status: XacpxTaskStatus): boolean {
  return TERMINAL_STATUSES.has(status);
}

/**
Start AutoDev's canonical XACPX orchestration Unix-socket IPC server backed by
`XacpxSessionManager`.
*/
export async function startXacpxOrchestrationIpcServer(
  options: XacpxOrchestrationIpcOptions
): Promise<XacpxOrchestrationIpcHandle> {
  const { socketPath, manager } = options;
  const maxConcurrent =
    options.maxConcurrentChildrenPerCoordinator ??
    DEFAULT_MAX_CONCURRENT_CHILDREN;
  const repositoryRoot =
    options.repositoryRoot ??
    resolveRuntimeSourceRoot(
      import.meta.dirname,
      options.env?.AUTODEV_REPO_ROOT
    );
  const environment = options.env ?? process.env;
  const globalWorkspaceRoot = options.authorizedWorkspaceRoot?.trim() || null;

  const coordinators = new Map<string, RegisteredCoordinator>();
  const tasks = new Map<string, XacpxTaskRecord>();
  const groups = new Map<string, OrchestrationGroupRecord>();
  const abortControllers = new Map<string, AbortController>();
  const waiters = new Map<string, Set<() => void>>();
  const workerBusy = new Set<string>();
  const workerToCoordinator = new Map<string, string>();
  const sockets = new Set<Socket>();

  const notifyWaiters = (taskId: string): void => {
    const set = waiters.get(taskId);
    if (!set) return;
    waiters.delete(taskId);
    for (const wake of set) wake();
  };

  const appendEvent = (
    task: XacpxTaskRecord,
    event: Omit<XacpxTaskEventRecord, "seq" | "at">
  ): void => {
    const at = new Date().toISOString();
    task.eventSeq += 1;
    task.updatedAt = at;
    task.events.push({
      seq: task.eventSeq,
      at,
      ...event
    });
    notifyWaiters(task.taskId);
  };

  const activeChildCount = (coordinatorSession: string): number => {
    let count = 0;
    for (const task of tasks.values()) {
      if (
        task.coordinatorSession === coordinatorSession &&
        ACTIVE_STATUSES.has(task.status)
      ) {
        count += 1;
      }
    }
    return count;
  };

  const resolveBoundWorkspaceRoot = (
    coordinatorSession: string
  ): string | null => {
    const coord = coordinators.get(coordinatorSession);
    if (coord?.workspaceRoot) return coord.workspaceRoot;
    return globalWorkspaceRoot;
  };

  const handleMethod = async (
    method: string,
    parameters: Record<string, unknown>
  ): Promise<unknown> => {
    switch (method) {
      case "coordinator.register_external": {
        const coordinatorSession = nonEmptyString(parameters.coordinatorSession);
        if (!coordinatorSession) {
          throw new OrchestrationRpcError(
            "ORCHESTRATION_INVALID_REQUEST",
            "coordinatorSession is required"
          );
        }
        const rawWorkspace = nonEmptyString(parameters.workspace) ?? undefined;
        let workspaceRoot: string | undefined;
        if (rawWorkspace && path.isAbsolute(rawWorkspace)) {
          workspaceRoot = validateDelegatedWorkspace(
            rawWorkspace,
            globalWorkspaceRoot
          );
        } else if (globalWorkspaceRoot) {
          workspaceRoot = validateDelegatedWorkspace(globalWorkspaceRoot);
        }
        const now = new Date().toISOString();
        const existing = coordinators.get(coordinatorSession);
        const record: RegisteredCoordinator = existing
          ? {
              ...existing,
              ...(rawWorkspace && { workspace: rawWorkspace }),
              ...(workspaceRoot && { workspaceRoot }),
              updatedAt: now
            }
          : {
              coordinatorSession,
              ...(rawWorkspace && { workspace: rawWorkspace }),
              ...(workspaceRoot && { workspaceRoot }),
              createdAt: now,
              updatedAt: now
            };
        coordinators.set(coordinatorSession, record);
        return {
          coordinatorSession: record.coordinatorSession,
          ...(record.workspace && { workspace: record.workspace }),
          createdAt: record.createdAt,
          updatedAt: record.updatedAt
        };
      }

      case "group.new": {
        const coordinatorSession = nonEmptyString(parameters.coordinatorSession);
        const title = nonEmptyString(parameters.title) ?? "Delegated batch";
        if (!coordinatorSession) {
          throw new OrchestrationRpcError(
            "ORCHESTRATION_INVALID_REQUEST",
            "coordinatorSession is required"
          );
        }
        const now = new Date().toISOString();
        const group: OrchestrationGroupRecord = {
          groupId: `grp-${randomUUID().slice(0, 8)}`,
          coordinatorSession,
          title,
          createdAt: now,
          updatedAt: now
        };
        groups.set(group.groupId, group);
        return group;
      }

      case "delegate.request": {
        const sourceHandle = nonEmptyString(parameters.sourceHandle);
        const targetAgent = nonEmptyString(parameters.targetAgent);
        const taskPrompt = nonEmptyString(parameters.task);
        const requestedRole =
          nonEmptyString(parameters.role) ?? targetAgent ?? null;
        // A refused delegation is a child launch attempt that was rejected
        // here, before the session manager ever saw it.
        const refuse = (
          reason: AgentLaunchRejection,
          message: string
        ): OrchestrationRpcError => {
          for (const stage of ["attempted", "rejected"] as const) {
            recordAgentLaunchStage({
              kind: "child",
              stage,
              role: requestedRole,
              ...(stage === "rejected" && { reason })
            });
          }
          return new OrchestrationRpcError(
            "ORCHESTRATION_INVALID_REQUEST",
            message
          );
        };
        if (!sourceHandle || !targetAgent || !taskPrompt || !requestedRole) {
          throw refuse(
            "invalid_request",
            "sourceHandle, targetAgent, and task are required"
          );
        }
        const coordinatorSession = sourceHandle;
        let validatedRole: string;
        try {
          validatedRole = validateDelegatedRole(requestedRole);
        } catch (error) {
          throw refuse("invalid_role", errorMessage(error));
        }

        const boundWorkspaceRoot =
          resolveBoundWorkspaceRoot(coordinatorSession);
        const requestedCwd =
          nonEmptyString(parameters.cwd) ?? boundWorkspaceRoot ?? "";
        let validatedCwd: string;
        try {
          validatedCwd = validateDelegatedWorkspace(
            requestedCwd,
            boundWorkspaceRoot
          );
        } catch (error) {
          throw refuse("workspace_denied", errorMessage(error));
        }

        const groupId = nonEmptyString(parameters.groupId) ?? undefined;
        if (groupId) {
          const group = groups.get(groupId);
          if (!group || group.coordinatorSession !== coordinatorSession) {
            throw refuse(
              "unknown_group",
              `Unknown or unauthorized group '${groupId}'`
            );
          }
        }

        if (activeChildCount(coordinatorSession) >= maxConcurrent) {
          throw refuse(
            "concurrency_limit",
            `Concurrency limit reached (${maxConcurrent} active delegated children for coordinator session)`
          );
        }

        const taskId = `task-${randomUUID().slice(0, 12)}`;
        const isParallel = parameters.parallel === true;
        const workerSession = `child-${validatedRole}-${randomUUID().slice(0, 8)}`;
        const now = new Date().toISOString();
        const workspaceLabel =
          coordinators.get(coordinatorSession)?.workspace ??
          path.basename(validatedCwd);

        const taskRecord: XacpxTaskRecord = {
          taskId,
          sourceHandle,
          sourceKind: "coordinator",
          coordinatorSession,
          workerSession,
          workspace: workspaceLabel,
          cwd: validatedCwd,
          targetAgent,
          role: validatedRole,
          task: taskPrompt,
          status: "running",
          summary: `Delegated ${validatedRole} task running`,
          resultText: "",
          createdAt: now,
          updatedAt: now,
          ...(groupId && { groupId }),
          ...(isParallel && { ephemeralWorkerSession: true }),
          eventSeq: 1,
          events: [
            {
              seq: 1,
              at: now,
              type: "created",
              status: "running",
              summary: `Delegated ${validatedRole} task started`
            }
          ]
        };

        const controller = new AbortController();
        tasks.set(taskId, taskRecord);
        abortControllers.set(taskId, controller);
        workerToCoordinator.set(workerSession, coordinatorSession);
        workerBusy.add(workerSession);

        const systemPrompt = renderRoleSystemPrompt(
          validatedRole,
          repositoryRoot
        );

        void manager
          .executeTurn(
            {
              sessionId: workerSession,
              role: validatedRole,
              cwd: validatedCwd,
              systemPrompt,
              promptOrTask: taskPrompt,
              parentSessionId: coordinatorSession,
              ...(boundWorkspaceRoot && { authorizedWorkspaceRoot: boundWorkspaceRoot })
            },
            environment,
            controller.signal
          )
          .then((result) => {
            if (isTerminal(taskRecord.status)) return;
            taskRecord.status = "completed";
            taskRecord.resultText = result.outputText;
            taskRecord.summary = `${validatedRole} completed (${result.session.provider}/${result.session.model})`;
            appendEvent(taskRecord, {
              type: "status_changed",
              status: "completed",
              summary: taskRecord.summary
            });
          })
          .catch((error: unknown) => {
            if (isTerminal(taskRecord.status)) return;
            const detail = errorMessage(error);
            if (controller.signal.aborted) {
              taskRecord.status = "cancelled";
              taskRecord.cancelCompletedAt = new Date().toISOString();
              taskRecord.summary = "Delegated task cancelled";
              appendEvent(taskRecord, {
                type: "status_changed",
                status: "cancelled",
                summary: taskRecord.summary
              });
              return;
            }
            taskRecord.status = "failed";
            taskRecord.resultText = detail;
            taskRecord.summary = `Delegated ${validatedRole} task failed: ${detail}`;
            appendEvent(taskRecord, {
              type: "status_changed",
              status: "failed",
              summary: taskRecord.summary,
              message: detail
            });
          })
          .finally(() => {
            workerBusy.delete(workerSession);
            abortControllers.delete(taskId);
            if (isParallel) {
              void manager.closeSession(workerSession).catch(() => undefined);
            }
          });

        return {
          taskId,
          status: "running",
          workerSession
        };
      }

      case "task.get": {
        const coordinatorSession = nonEmptyString(parameters.coordinatorSession);
        const taskId = nonEmptyString(parameters.taskId);
        if (!coordinatorSession || !taskId) {
          throw new OrchestrationRpcError(
            "ORCHESTRATION_INVALID_REQUEST",
            "coordinatorSession and taskId are required"
          );
        }
        const task = tasks.get(taskId);
        if (!task || task.coordinatorSession !== coordinatorSession) {
          return null;
        }
        return task;
      }

      case "task.list": {
        const filter = isRecord(parameters.filter) ? parameters.filter : parameters;
        const coordinatorSession = nonEmptyString(filter.coordinatorSession);
        if (!coordinatorSession) {
          throw new OrchestrationRpcError(
            "ORCHESTRATION_INVALID_REQUEST",
            "coordinatorSession filter is required"
          );
        }
        const statusFilter = nonEmptyString(filter.status);
        const sort = filter.sort === "createdAt" ? "createdAt" : "updatedAt";
        const order = filter.order === "asc" ? 1 : -1;
        return [...tasks.values()]
          .filter(
            (task) =>
              task.coordinatorSession === coordinatorSession &&
              (!statusFilter || task.status === statusFilter)
          )
          .sort((a, b) => a[sort].localeCompare(b[sort]) * order);
      }

      case "task.watch": {
        const coordinatorSession = nonEmptyString(parameters.coordinatorSession);
        const taskId = nonEmptyString(parameters.taskId);
        if (!coordinatorSession || !taskId) {
          throw new OrchestrationRpcError(
            "ORCHESTRATION_INVALID_REQUEST",
            "coordinatorSession and taskId are required"
          );
        }
        const task = tasks.get(taskId);
        if (!task || task.coordinatorSession !== coordinatorSession) {
          return {
            status: "not_found",
            task: null,
            events: [],
            nextAfterSeq: 0
          };
        }
        const afterSeq =
          typeof parameters.afterSeq === "number" &&
          Number.isFinite(parameters.afterSeq) &&
          parameters.afterSeq >= 0
            ? Math.floor(parameters.afterSeq)
            : 0;
        const mode =
          parameters.mode === "next_event"
            ? "next_event"
            : "until_attention_or_terminal";
        const rawTimeout =
          typeof parameters.timeoutMs === "number" &&
          Number.isFinite(parameters.timeoutMs)
            ? Math.floor(parameters.timeoutMs)
            : DEFAULT_WATCH_TIMEOUT_MS;
        const timeoutMs = Math.min(
          Math.max(rawTimeout, 0),
          MAX_WATCH_TIMEOUT_MS
        );

        const evaluate = () => {
          const unseen = task.events.filter((event) => event.seq > afterSeq);
          if (isTerminal(task.status)) {
            return {
              status: "terminal" as const,
              task,
              events: unseen,
              nextAfterSeq: task.eventSeq
            };
          }
          if (mode === "next_event" && unseen.length > 0) {
            return {
              status: "event" as const,
              task,
              events: unseen,
              nextAfterSeq: task.eventSeq
            };
          }
          return null;
        };

        const immediate = evaluate();
        if (immediate) return immediate;
        if (timeoutMs === 0) {
          return {
            status: "timeout",
            task,
            events: [],
            nextAfterSeq: task.eventSeq
          };
        }

        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
          const ready = evaluate();
          if (ready) return ready;
          const remaining = Math.max(0, deadline - Date.now());
          if (remaining === 0) break;
          await new Promise<void>((resolve) => {
            const set = waiters.get(taskId) ?? new Set<() => void>();
            const wake = () => {
              clearTimeout(timer);
              set.delete(wake);
              resolve();
            };
            const timer = setTimeout(wake, remaining);
            timer.unref();
            set.add(wake);
            waiters.set(taskId, set);
          });
        }
        return (
          evaluate() ?? {
            status: "timeout",
            task,
            events: task.events.filter((event) => event.seq > afterSeq),
            nextAfterSeq: task.eventSeq
          }
        );
      }

      case "task.approve": {
        const coordinatorSession = nonEmptyString(parameters.coordinatorSession);
        const taskId = nonEmptyString(parameters.taskId);
        if (!coordinatorSession || !taskId) {
          throw new OrchestrationRpcError(
            "ORCHESTRATION_INVALID_REQUEST",
            "coordinatorSession and taskId are required"
          );
        }
        const task = tasks.get(taskId);
        if (!task || task.coordinatorSession !== coordinatorSession) {
          throw new OrchestrationRpcError(
            "ORCHESTRATION_INVALID_REQUEST",
            `Task '${taskId}' not found for coordinator session`
          );
        }
        return task;
      }

      case "task.cancel": {
        const coordinatorSession =
          nonEmptyString(parameters.coordinatorSession) ??
          nonEmptyString(parameters.sourceHandle);
        const taskId = nonEmptyString(parameters.taskId);
        if (!coordinatorSession || !taskId) {
          throw new OrchestrationRpcError(
            "ORCHESTRATION_INVALID_REQUEST",
            "coordinatorSession and taskId are required"
          );
        }
        const task = tasks.get(taskId);
        if (!task || task.coordinatorSession !== coordinatorSession) {
          throw new OrchestrationRpcError(
            "ORCHESTRATION_INVALID_REQUEST",
            `Task '${taskId}' not found for coordinator session`
          );
        }
        if (!isTerminal(task.status)) {
          const now = new Date().toISOString();
          task.cancelRequestedAt = now;
          task.status = "cancelled";
          task.cancelCompletedAt = now;
          task.summary = "Delegated task cancelled by coordinator";
          abortControllers.get(taskId)?.abort();
          abortControllers.delete(taskId);
          await manager
            .cancelSession(task.workerSession)
            .catch(() => undefined);
          await manager.closeSession(task.workerSession).catch(() => undefined);
          workerBusy.delete(task.workerSession);
          appendEvent(task, {
            type: "status_changed",
            status: "cancelled",
            summary: task.summary
          });
        }
        return task;
      }

      case "agent.list": {
        const coordinatorSession = nonEmptyString(parameters.coordinatorSession);
        if (!coordinatorSession) {
          throw new OrchestrationRpcError(
            "ORCHESTRATION_INVALID_REQUEST",
            "coordinatorSession is required"
          );
        }
        const owned = manager
          .listPinnedSessions()
          .filter((session) => session.parentSessionId === coordinatorSession);
        return owned.map((session) => ({
          address: { nodeId: "autodev-local", endpointId: session.sessionId },
          handle: session.sessionId,
          node: "autodev-local",
          agent: session.role,
          workspace: path.basename(session.cwd),
          displayName: `${session.role} (${session.provider}/${session.model})`,
          sessionAlias: session.sessionId,
          state: workerBusy.has(session.sessionId) ? "running" : "idle",
          activity: {
            status: workerBusy.has(session.sessionId) ? "working" : "idle"
          },
          capabilities: {
            receive: true,
            steer: false,
            queue: true,
            interrupt: true,
            conversation: true,
            completion: true
          },
          endpointKind: "worker" as const
        }));
      }

      case "agent.send": {
        const coordinatorSession = nonEmptyString(parameters.coordinatorSession);
        const content =
          nonEmptyString(parameters.message) ?? nonEmptyString(parameters.content);
        if (!coordinatorSession || !content) {
          throw new OrchestrationRpcError(
            "ORCHESTRATION_INVALID_REQUEST",
            "coordinatorSession and message are required"
          );
        }
        const targetHandle = nonEmptyString(parameters.to);
        const selector = isRecord(parameters.selector) ? parameters.selector : null;
        const owned = manager
          .listPinnedSessions()
          .filter((session) => session.parentSessionId === coordinatorSession);
        const target = targetHandle
          ? owned.find((session) => session.sessionId === targetHandle)
          : selector
            ? owned.find((session) => {
                const isAgentMatch =
                  !selector.agent || session.role === selector.agent;
                const isWsMatch =
                  !selector.workspace ||
                  path.basename(session.cwd) === selector.workspace ||
                  session.cwd === selector.workspace;
                return isAgentMatch && isWsMatch;
              })
            : undefined;

        if (!target) {
          const foreign =
            targetHandle && workerToCoordinator.has(targetHandle)
              ? "DELIVERY_DENIED"
              : "TARGET_NOT_FOUND";
          throw new OrchestrationRpcError(
            foreign,
            foreign === "DELIVERY_DENIED"
              ? `Cross-session agent messaging denied for '${targetHandle}'`
              : "Target child agent session not found in coordinator scope"
          );
        }

        const messageId = `msg-${randomUUID().slice(0, 10)}`;
        const mode = nonEmptyString(parameters.mode) ?? "queue";
        if (mode === "interrupt" && workerBusy.has(target.sessionId)) {
          await manager.cancelSession(target.sessionId).catch(() => undefined);
        }
        workerBusy.add(target.sessionId);
        const result = await manager
          .promptSession(target.sessionId, content, environment)
          .finally(() => {
            workerBusy.delete(target.sessionId);
          });
        // Record the latest follow-up output on the matching task if present.
        for (const task of tasks.values()) {
          if (task.workerSession !== target.sessionId) {
            continue;
          }

          task.resultText = result.outputText;
          task.summary = `Follow-up completed (${result.session.provider}/${result.session.model})`;
          appendEvent(task, {
            type: "progress",
            status: task.status,
            summary: task.summary
          });
        }
        return {
          messageId,
          status: "injected",
          modeUsed: "prompt",
          route: "local",
          targetState: "idle",
          resultText: result.outputText
        };
      }

      default: {
        throw new OrchestrationRpcError(
          "ORCHESTRATION_INVALID_REQUEST",
          `Unsupported XACPX orchestration RPC method: ${method}`
        );
      }
    }
  };

  mkdirSync(path.dirname(socketPath), { recursive: true, mode: 0o700 });
  if (existsSync(socketPath)) {
    rmSync(socketPath, { force: true });
  }

  const server = createServer((socket) => {
    sockets.add(socket);
    socket.once("close", () => {
      sockets.delete(socket);
    });
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      let newlineIndex = buffer.indexOf("\n");
      while (newlineIndex >= 0) {
        const line = buffer.slice(0, newlineIndex).trim();
        buffer = buffer.slice(newlineIndex + 1);
        newlineIndex = buffer.indexOf("\n");
        if (!line) continue;
        void (async () => {
          let requestId = "unknown";
          try {
            const parsed: unknown = JSON.parse(line);
            if (
              !isRecord(parsed) ||
              typeof parsed.id !== "string" ||
              typeof parsed.method !== "string"
            ) {
              throw new OrchestrationRpcError(
                "ORCHESTRATION_INVALID_REQUEST",
                "Invalid orchestration RPC request envelope"
              );
            }
            const request: RpcRequest = {
              id: parsed.id,
              method: parsed.method,
              params: isRecord(parsed.params) ? parsed.params : {}
            };
            requestId = request.id;
            const result = await handleMethod(request.method, request.params);
            const response: RpcSuccess = { id: request.id, ok: true, result };
            if (!socket.destroyed) {
              socket.write(`${JSON.stringify(response)}\n`);
            }
          } catch (error) {
            const code =
              error instanceof OrchestrationRpcError
                ? error.code
                : "ORCHESTRATION_INTERNAL_ERROR";
            const response: RpcError = {
              id: requestId,
              ok: false,
              error: { code, message: errorMessage(error) }
            };
            if (!socket.destroyed) {
              socket.write(`${JSON.stringify(response)}\n`);
            }
          }
        })();
      }
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => {
      server.off("error", reject);
      try {
        chmodSync(socketPath, 0o600);
      } catch {
        /*
        ignore chmod failure on platforms that disallow socket chmod
        */
      }
      resolve();
    });
  });

  let isClosed = false;
  return {
    socketPath,
    server,
    async close(): Promise<void> {
      if (isClosed) return;
      isClosed = true;
      for (const controller of abortControllers.values()) {
        controller.abort();
      }
      abortControllers.clear();
      for (const taskId of waiters.keys()) {
        notifyWaiters(taskId);
      }
      for (const socket of sockets) {
        socket.destroy();
      }
      sockets.clear();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(socketPath, { force: true });
    }
  };
}
