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
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";

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
import { DurableCommandTaskStore } from "./command-task-store.ts";
import { recordCommandExecutionSpan } from "./mcp-telemetry.ts";

/**
How long a finished task's result is kept before the store drops it.
*/
const RETENTION_MS = 120_000;
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
  The private directory this scope's task records live in. It belongs to
  the Runtime's own run directory, never to the workspace.
  */
  readonly taskDirectory: string;
  /**
  Recheck the operator-approved revision and trusted session grant.
  */
  readonly isAuthorized: () => boolean;
  /**
  Existing Runtime admission owner must serialize across workspace sessions.
  */
  readonly tryAcquireWorkspace: () => CommandWorkspaceLease | null;
}

/**
A workspace-wide exclusive lease.

Two sessions in one workspace must not run commands against it at the same
time: an install and a test would race over the same build outputs.

The lease records the command it was taken for, because a lease outlives its
holder whenever that holder dies without releasing it. The record is what
lets a later server tell an abandoned lease from a live one instead of
refusing every command in that workspace forever.
*/
export interface CommandWorkspaceLease {
  /**
  Record the command the lease was taken for.

  A command's process id exists only once it has started, so the lease
  carries it after the fact. A lease whose command was never recorded cannot
  be proven abandoned, and is never reclaimed on a guess.
  */
  noteCommand(pid: number): void;
  /**
  Release the lease.
  */
  release(): void;
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

/**
A command that did not succeed is a tool-level error: the native task that
ran it is `failed`, and its result says so too, so a client that reads only
the result and a client that reads only the task status agree. It is still a
result -- the observed exit status and bounded output -- not a protocol
error.
*/
function resultPayload(result: CommandResult) {
  return {
    isError: result.status !== "succeeded",
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(result)
      }
    ],
    structuredContent: result
  };
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
  let closing: Promise<void> | undefined;
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
  const store = new DurableCommandTaskStore({
    directory: grant.taskDirectory,
    authorize,
    cancel: async (taskId: string): Promise<void> => {
      const execution = active.get(taskId);
      if (!execution) return;
      execution.cancelling = true;
      execution.controller.abort();
      // Do not release the lease or acknowledge cancellation before the
      // subprocess invocation has settled. A cancelled command may still
      // have descendants running, and reporting it as finished early would
      // let a second command start against the same workspace.
      await execution.done;
    }
  });
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
          const lease = grant.tryAcquireWorkspace();
          if (!lease)
            throw new Error("Workspace already has an active command.");
          try {
            authorize();
            const task = await extra.taskStore.createTask({
              ttl: definition.timeoutMs + RETENTION_MS,
              pollInterval: 1000
            });
            // Closing/revocation may have interleaved with task creation.
            // Never start an invocation after its admission has ended.
            authorize();
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
                    () =>
                      runApprovedCommand(
                        commandId,
                        definition,
                        argv,
                        grant.scope,
                        execution.controller.signal,
                        (pid) => lease.noteCommand(pid)
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
                if (execution.cancelling) {
                  // The client cancelled the task, and the SDK's cancel path
                  // owns the terminal state it reports.
                } else if (!isAuthorized()) {
                  // The grant ended while the command ran. Its outcome is
                  // unknown, so the task is failed rather than left running
                  // or reported as completed.
                  store.interrupt(
                    task.taskId,
                    "The command was aborted when the execution grant ended."
                  );
                } else {
                  // Only a command that succeeded is a completed task. Every
                  // other outcome keeps its own reason in the payload, and
                  // the task itself never claims a success it did not have.
                  await extra.taskStore.storeTaskResult(
                    task.taskId,
                    result.status === "succeeded" ? "completed" : "failed",
                    resultPayload(result)
                  );
                }
              } catch {
                // A lost or revoked task cannot be replayed.
              } finally {
                clearInterval(revocationCheck);
                extra.signal.removeEventListener("abort", abortRequest);
                active.delete(task.taskId);
                lease.release();
              }
            })();
            return { task };
          } catch (error) {
            lease.release();
            throw error;
          }
        },
        getTask: (_arguments, extra) => {
          authorize();
          return extra.taskStore.getTask(extra.taskId);
        },
        getTaskResult: async (_arguments, extra) => {
          authorize();
          return CallToolResultSchema.parse(await extra.taskStore.getTaskResult(extra.taskId));
        }
      }
    );
    commandIds.push(commandId);
  }
  return {
    server,
    commandIds,
    close() {
      if (closing) return closing;
      isClosed = true;
      const executions = [...active.values()];
      const outstanding = [...active.keys()];
      for (const execution of executions) {
        execution.cancelling = true;
        execution.controller.abort();
      }
      closing = Promise.allSettled(executions.map((execution) => execution.done))
        .then(async () => {
          // A command that was still running when the backend closed has an
          // unknown outcome. It is recorded as failed, never as completed.
          for (const taskId of outstanding) {
            store.interrupt(
              taskId,
              "The command was interrupted when the backend closed before it produced a result."
            );
          }
          await server.close();
        });
      return closing;
    }
  };
}
