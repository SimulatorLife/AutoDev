/**
The Commands MCP server: one independently admitted role/workspace/session
scope, exposed through the SDK's native task primitives.

The gateway owner allocates a distinct instance per admitted scope and
supplies the trusted grant. This module never derives authority from MCP
input, from the process environment, or from the catalogue it is given: the
effective tool set is the intersection of the operator-approved catalogue
and the canonical role contract, and every lifecycle operation is
re-authorized before it acts.

The tools are registered as **optional** task tools. The SDK refuses an
ordinary `tools/call` for a tool declared `required` unless the client
augments the request, which would make the surface unreachable to every
client that does not speak the tasks extension. Declared `optional`, an
ordinary call creates the native task and polls it to its terminal state,
while an augmented call receives the task immediately and drives the native
lifecycle -- creation, status, result and cancellation -- itself.
*/
import { InMemoryTaskStore } from "@modelcontextprotocol/sdk/experimental/tasks/stores/in-memory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type {
  CallToolResult,
  Request,
  RequestId,
  Result,
  Task
} from "@modelcontextprotocol/sdk/types.js";

import { roleContract } from "../shared/execution-contract.ts";
import {
  type CommandCatalogue,
  type CommandDefinition,
  type CommandResult,
  commandInputSchema,
  commandResultSchema,
  parseCommandCatalogue,
  resolveCommandArguments
} from "./commands-catalogue.ts";
import {
  type ApprovedCommandScope,
  prepareCommand,
  runApprovedCommand
} from "./commands-execution.ts";
import { recordCommandExecutionSpan } from "./mcp-telemetry.ts";

/**
How long a finished task's result is kept before the store drops it.
*/
const RETENTION_MS = 120_000;
/**
The most tasks this scope may hold at once.
*/
const MAX_RETAINED_TASKS = 32;
/** Bound the active revocation detection interval without another protocol. */
const REVOCATION_CHECK_MS = 250;

interface ActiveCommand {
  readonly controller: AbortController;
  done: Promise<void>;
  cancelling: boolean;
}

export interface CommandsServerGrant {
  readonly role: string;
  /**
  The canonical workspace id (`owner/repository`), when the caller has one.
  */
  readonly workspaceId: string | null;
  readonly catalogue: CommandCatalogue;
  readonly scope: ApprovedCommandScope;
  /**
  Recheck the operator-approved revision and trusted session grant.
  */
  readonly isAuthorized: () => boolean;
  /**
  Existing Runtime admission owner must serialize across workspace sessions.
  */
  readonly tryAcquireWorkspace: () => (() => void) | null;
}

/**
Whether a command may run in one workspace.

A definition that names its workspaces runs only in those; one that does
not runs wherever the role holds the grant. The role grant is already
intersected before this is consulted, so an unlisted workspace can only ever
narrow the surface further.
*/
export function isCommandEligibleInWorkspace(
  definition: CommandDefinition,
  workspaceId: string | null
): boolean {
  if (!definition.workspaces) return true;
  if (!workspaceId) return false;
  return definition.workspaces.includes(workspaceId);
}

/**
The command ids one role may run, and the definitions behind them.
*/
export function effectiveCommands(
  grant: Pick<CommandsServerGrant, "role" | "workspaceId" | "catalogue">
): Map<string, CommandDefinition> {
  const contract = roleContract(grant.role, grant.workspaceId);
  if (contract.readOnly === true || !contract.mcp.includes("commands")) {
    throw new Error("Role is not authorized for command execution.");
  }
  const allowed = new Set(contract.mcpTools?.commands);
  const catalogue = parseCommandCatalogue(grant.catalogue);
  const effective = new Map<string, CommandDefinition>();
  for (const [commandId, definition] of Object.entries(catalogue.commands)) {
    if (!allowed.has(commandId) || !isCommandEligibleInWorkspace(definition, grant.workspaceId)) continue;
    effective.set(commandId, definition);
  }
  return effective;
}

function resultPayload(result: CommandResult) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(result)
      }
    ],
    structuredContent: result
  };
}

/**
Only a tool result may be returned as a task result.

The SDK's task store is typed as returning any protocol `Result`, so the
narrowing is done here rather than asserted: a task result that is not a
tool result is a fault in the store, not a result to hand a client.
*/
function asToolResult(value: Result): CallToolResult {
  const content = value.content;
  if (!Array.isArray(content)) {
    throw new TypeError("Command task result is not a tool result.");
  }
  const payload: CallToolResult = {
    content: content as CallToolResult["content"]
  };
  if (value.structuredContent !== undefined) {
    payload.structuredContent =
      value.structuredContent as CallToolResult["structuredContent"];
  }
  if (value.isError === true) payload.isError = true;
  return payload;
}

/**
The SDK's store, with the bounds and the revocation checks the generic
store cannot own.

The store's own session binding is preserved: every method keeps the
`sessionId` it was given, so a task created in one session is not found by
another. The checks this class adds are the ones the SDK has no notion of
-- the operator's approval, and the retention bound.
*/
class CommandTaskStore extends InMemoryTaskStore {
  readonly authorize: () => void;
  readonly active: Map<string, ActiveCommand>;

  constructor(authorize: () => void, active: Map<string, ActiveCommand>) {
    super();
    this.authorize = authorize;
    this.active = active;
  }

  override createTask(
    parameters: Parameters<InMemoryTaskStore["createTask"]>[0],
    requestId: RequestId,
    request: Request,
    sessionId?: string
  ): Promise<Task> {
    this.authorize();
    if (this.getAllTasks().length >= MAX_RETAINED_TASKS) {
      throw new Error("Command task retention limit reached.");
    }
    return super.createTask(parameters, requestId, request, sessionId);
  }

  override getTask(taskId: string, sessionId?: string): Promise<Task | null> {
    this.authorize();
    return super.getTask(taskId, sessionId);
  }

  override getTaskResult(taskId: string, sessionId?: string): Promise<Result> {
    this.authorize();
    return super.getTaskResult(taskId, sessionId);
  }

  override listTasks(
    cursor?: string,
    sessionId?: string
  ): ReturnType<InMemoryTaskStore["listTasks"]> {
    this.authorize();
    return super.listTasks(cursor, sessionId);
  }

  override async updateTaskStatus(
    taskId: string,
    status: Task["status"],
    statusMessage?: string,
    sessionId?: string
  ) {
    this.authorize();
    if (status === "cancelled" && (await super.getTask(taskId, sessionId))) {
      const execution = this.active.get(taskId);
      if (execution) {
        execution.cancelling = true;
        execution.controller.abort();
        // Do not release the lease or acknowledge cancellation before the
        // subprocess invocation has settled. A cancelled command may still
        // have descendants running, and reporting it as finished early would
        // let a second command start against the same workspace.
        await execution.done;
      }
    }
    await super.updateTaskStatus(taskId, status, statusMessage, sessionId);
  }
}

export interface CommandsServer {
  readonly server: McpServer;
  /**
  The command ids this scope exposes, for health and diagnostics.
  */
  readonly commandIds: readonly string[];
  close(): Promise<void>;
}

export function createCommandsMcpServer(grant: CommandsServerGrant): CommandsServer {
  let isClosed = false;
  let revoked = false;
  const active = new Map<string, ActiveCommand>();
  const isAuthorized = (): boolean => {
    if (!revoked) {
      try {
        revoked = !grant.isAuthorized();
      } catch {
        revoked = true;
      }
      if (revoked) {
        for (const execution of active.values()) execution.controller.abort();
      }
    }
    return !isClosed && !revoked;
  };
  const authorize = (): void => {
    if (!isAuthorized()) {
      throw new Error("Command execution grant is unavailable or revoked.");
    }
  };
  authorize();
  const effective = effectiveCommands(grant);
  const commandIds: string[] = [];
  const store = new CommandTaskStore(authorize, active);
  const server = new McpServer(
    { name: "commands", version: "1.0.0" },
    {
      taskStore: store,
      capabilities: {
        tasks: { list: {}, cancel: {}, requests: { tools: { call: {} } } }
      },
      maxTaskQueueSize: 16,
      maxToolInputElements: 16
    }
  );
  for (const [commandId, definition] of effective) {
    const inputSchema = commandInputSchema(definition);
    // Do not advertise a tool the scope cannot actually launch.
    try {
      prepareCommand(grant.scope, definition);
    } catch {
      continue;
    }
    server.experimental.tasks.registerToolTask(
      commandId,
      {
        description: definition.description,
        inputSchema,
        outputSchema: commandResultSchema,
        annotations: {
          // Even validation scripts may execute arbitrary project code and
          // write within the workspace. These are conservative MCP hints.
          readOnlyHint: false,
          destructiveHint: true,
          idempotentHint: false,
          openWorldHint: definition.executionClass === "dependency_install"
        },
        execution: { taskSupport: "optional" }
      },
      {
        createTask: async (arguments_, extra) => {
          authorize();
          const argv = resolveCommandArguments(
            definition,
            arguments_ as Record<string, unknown>
          );
          const release = grant.tryAcquireWorkspace();
          if (!release) throw new Error("Workspace already has an active command.");
          try {
            authorize();
            const task = await extra.taskStore.createTask({
              ttl: definition.timeoutMs + RETENTION_MS,
              pollInterval: 1000
            });
            const execution: ActiveCommand = {
              controller: new AbortController(),
              cancelling: false,
              done: Promise.resolve()
            };
            active.set(task.taskId, execution);
            // The SDK keeps the initiating request's signal alive for an
            // ordinary call, but releases it after a native task-creation
            // response. Cancel the former without making the latter depend
            // on later status/result requests.
            const abortRequest = (): void => execution.controller.abort();
            extra.signal.addEventListener("abort", abortRequest, { once: true });
            if (extra.signal.aborted) abortRequest();
            const revocationCheck = setInterval(() => {
              if (!isAuthorized()) execution.controller.abort();
            }, REVOCATION_CHECK_MS);
            revocationCheck.unref();
            execution.done = (async () => {
              try {
                const started = performance.now();
                let result: CommandResult;
                try {
                  authorize();
                  result = await recordCommandExecutionSpan(
                    commandId,
                    definition.executionClass,
                    () => runApprovedCommand(
                      commandId,
                      definition,
                      argv,
                      grant.scope,
                      execution.controller.signal
                    ),
                    extra._meta
                  );
                } catch {
                  result = {
                    commandId,
                    status: "infrastructure_error",
                    exitCode: null,
                    durationMs: Math.round(performance.now() - started),
                    stdout: "",
                    // An exception from a process runner can include argv,
                    // paths and environment values. Do not return it verbatim.
                    stderr: "Command could not be executed within the approved scope.",
                    outputTruncated: false
                  };
                }
                if (isAuthorized() && !execution.cancelling) {
                  await extra.taskStore.storeTaskResult(
                    task.taskId,
                    result.status === "infrastructure_error" ? "failed" : "completed",
                    resultPayload(result)
                  );
                }
              } catch {
                // A lost or revoked task cannot be replayed.
              } finally {
                clearInterval(revocationCheck);
                extra.signal.removeEventListener("abort", abortRequest);
                active.delete(task.taskId);
                release();
              }
            })();
            return { task };
          } catch (error) {
            release();
            throw error;
          }
        },
        getTask: (_arguments, extra) => {
          authorize();
          return extra.taskStore.getTask(extra.taskId);
        },
        getTaskResult: async (_arguments, extra) => {
          authorize();
          return asToolResult(await extra.taskStore.getTaskResult(extra.taskId));
        }
      }
    );
    commandIds.push(commandId);
  }
  return {
    server,
    commandIds,
    async close() {
      if (isClosed) return;
      isClosed = true;
      const executions = active.values().toArray();
      for (const execution of executions) {
        execution.cancelling = true;
        execution.controller.abort();
      }
      await Promise.all(executions.map((execution) => execution.done));
      store.cleanup();
      await server.close();
    }
  };
}
