/**
The Commands backend's durable MCP task store.

The SDK's in-memory store documents itself as unsuitable for production: it
loses every task when the process dies. The Commands backend is a child
process of the gateway, so a Runtime restart -- or a killed backend -- takes
every running command with it, and an in-memory store answers the next
question with "not found". "Not found" is not an answer: it leaves the
caller unable to tell a lost task from a task that never existed.

This store keeps the task lifecycle in the Runtime's own private run
directory, per role and workspace, and answers a restart honestly:

- a task that was still running when its backend ended is reconciled as
  **failed**, with the reason. It is never reported as completed, and its
  command is never replayed;
- a task that had already finished keeps its result, so a client that
  reconnects can still collect it;
- a task is visible only to the session that created it, so one session can
  neither read nor cancel another session's command.

Records are written one file per task and replaced atomically, so a reader
never observes a half-written record, and every record is dropped once its
retention window passes.
*/
import { randomBytes } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";

import {
  type CreateTaskOptions,
  isTerminal,
  type TaskStore
} from "@modelcontextprotocol/sdk/experimental/tasks/interfaces.js";
import type {
  Request,
  RequestId,
  Result,
  Task
} from "@modelcontextprotocol/sdk/types.js";
import { atomicWriteSync } from "@simulatorlife/autodev-data/files";

/**
The most tasks one scope may hold at once.
*/
const MAX_RETAINED_TASKS = 32;
/**
How many tasks one listing page returns.
*/
const PAGE_SIZE = 10;
/**
The status a task that outlived its backend is reconciled to.
*/
const INTERRUPTED_TASK_STATUS_MESSAGE =
  "The command's backend process ended before the task completed.";

/**
One task's durable record.
*/
interface TaskRecord {
  readonly task: Task;
  /**
  The session that owns the task. A record is never visible to another
  session, not even one serving the same scope.
  */
  readonly sessionKey: string;
  /**
  The process that created the task. A record whose owner is gone was
  interrupted, and is reconciled as failed rather than left running.
  */
  readonly ownerPid: number;
  readonly result?: Result;
  /**
  When the record may be dropped, or null when it never expires.
  */
  readonly expiresAt: number | null;
}

export interface DurableCommandTaskStoreOptions {
  /**
  The private directory this scope's records live in. It is created when
  missing and is never shared with another role or workspace.
  */
  readonly directory: string;
  /**
  Re-check the operator's approval and the session's grant before every
  lifecycle operation.
  */
  readonly authorize: () => void;
  /**
  Abort a running command and wait for it to settle. A cancelled task must
  not be reported as finished while its process is still running, or a
  second command could start against the same workspace.
  */
  readonly cancel?: (taskId: string) => Promise<void>;
  /**
  The most tasks this scope may hold at once.
  */
  readonly maxTasks?: number;
}

/**
Whether a process is still running.

A record's owner is judged by its process, so a live sibling backend keeps
its tasks and only a genuinely abandoned record is reconciled.
*/
function isProcessAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but belongs to another user.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function readRecord(value: unknown): TaskRecord | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Partial<TaskRecord>;
  if (
    typeof record.sessionKey !== "string" ||
    typeof record.ownerPid !== "number"
  )
    return null;
  const task = record.task;
  if (
    !task ||
    typeof task !== "object" ||
    typeof task.taskId !== "string" ||
    typeof task.status !== "string"
  )
    return null;
  return {
    task,
    sessionKey: record.sessionKey,
    ownerPid: record.ownerPid,
    ...(record.result !== undefined && { result: record.result }),
    expiresAt: typeof record.expiresAt === "number" ? record.expiresAt : null
  };
}

/**
The order records are listed in: oldest first.
*/
const TASK_ORDER = new Intl.Collator();

/**
The result an interrupted task reports.

It is an ordinary tool result that says what happened. The command's own
output is not reconstructed: the outcome of an interrupted command is
unknown, and is reported as unknown.
*/
function interruptedResult(taskId: string): Result {
  return {
    content: [
      {
        type: "text",
        text: `Command task ${taskId} was interrupted before it produced a result; its outcome is unknown and the command was not replayed.`
      }
    ],
    isError: true
  };
}

/**
Run a store operation and report its failure as a rejection.

The store is synchronous on disk. The SDK's contract is a promise, and a
refused or missing task must reject rather than throw at the call site.
*/
function asPromise<T>(operation: () => T): Promise<T> {
  try {
    return Promise.resolve(operation());
  } catch (error) {
    return Promise.reject(error);
  }
}

export class DurableCommandTaskStore implements TaskStore {
  private readonly directory: string;
  private readonly authorize: () => void;
  private readonly cancel: ((taskId: string) => Promise<void>) | undefined;
  private readonly maxTasks: number;

  constructor(options: DurableCommandTaskStoreOptions) {
    this.directory = path.resolve(options.directory);
    this.authorize = options.authorize;
    this.cancel = options.cancel;
    this.maxTasks = options.maxTasks ?? MAX_RETAINED_TASKS;
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    this.reconcile();
  }

  /**
  The key one session's tasks are bound to.

  A session that presents no identifier gets its own key, so the sole stdio
  session is never confused with a session that happens to be named
  "stdio".
  */
  private sessionKey(sessionId?: string): string {
    return sessionId === undefined ? "stdio" : `session:${sessionId}`;
  }

  private recordPath(taskId: string): string {
    return path.join(this.directory, `${taskId}.json`);
  }

  private read(file: string): TaskRecord | null {
    let raw: string;
    try {
      raw = readFileSync(file, "utf8");
    } catch {
      return null;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return null;
    }
    return readRecord(parsed);
  }

  /**
  Replace a record in one atomic step via the shared Data helper, so a
  concurrent reader sees either the previous record or the new one, never a
  partial write.
  */
  private write(record: TaskRecord): void {
    const file = this.recordPath(record.task.taskId);
    atomicWriteSync(file, JSON.stringify(record), { mode: 0o600 });
  }

  /**
  Every live record of this scope, oldest first.

  Expired records are dropped as they are found, so the directory stays
  bounded by the retention limit without a separate sweeper.
  */
  private records(): TaskRecord[] {
    let entries: string[];
    try {
      entries = readdirSync(this.directory);
    } catch {
      return [];
    }
    const records: TaskRecord[] = [];
    for (const entry of entries) {
      if (!entry.endsWith(".json")) continue;
      const file = path.join(this.directory, entry);
      const record = this.read(file);
      if (!record) {
        // A record that cannot be read is not trustworthy. Drop it rather
        // than serve a task whose state is unknown.
        rmSync(file, { force: true });
        continue;
      }
      if (record.expiresAt !== null && record.expiresAt <= Date.now()) {
        rmSync(file, { force: true });
        continue;
      }
      records.push(record);
    }
    return records.sort(
      (left, right) =>
        TASK_ORDER.compare(left.task.createdAt, right.task.createdAt) ||
        TASK_ORDER.compare(left.task.taskId, right.task.taskId)
    );
  }

  /**
  The record one session may act on.

  A task belongs to the session that created it. Another session does not
  see it at all, which is what makes a task id a handle rather than a
  credential.
  */
  private find(taskId: string, sessionId?: string): TaskRecord | null {
    const file = this.recordPath(taskId);
    const record = this.read(file);
    if (!record) return null;
    if (record.expiresAt !== null && record.expiresAt <= Date.now()) {
      rmSync(file, { force: true });
      return null;
    }
    if (record.sessionKey !== this.sessionKey(sessionId)) return null;
    return record;
  }

  /**
  Reconcile the records a backend that is gone left behind.

  A record whose owner is still running belongs to a live sibling process
  and is left alone. A record whose owner is gone was interrupted: it is
  reported as failed, with the reason, and never as completed.
  */
  private reconcile(): void {
    // A backend that died between writing a record's replacement and
    // renaming it leaves the temporary file behind. It holds a result body,
    // so it is removed once its writer is gone rather than kept forever.
    try {
      for (const entry of readdirSync(this.directory)) {
        const writer = /\.json\.(\d+)\.\d+\.tmp$/u.exec(entry);
        if (writer && !isProcessAlive(Number(writer[1]))) {
          rmSync(path.join(this.directory, entry), { force: true });
        }
      }
    } catch {
      // An unreadable directory has no records to reconcile either.
    }
    for (const record of this.records()) {
      if (isTerminal(record.task.status) || isProcessAlive(record.ownerPid))
        continue;
      const task: Task = {
        ...record.task,
        status: "failed",
        statusMessage: INTERRUPTED_TASK_STATUS_MESSAGE,
        lastUpdatedAt: new Date().toISOString()
      };
      this.write({
        ...record,
        task,
        result: interruptedResult(record.task.taskId),
        expiresAt: task.ttl === null ? null : Date.now() + task.ttl
      });
    }
  }

  createTask(
    taskParameters: CreateTaskOptions,
    _requestId: RequestId,
    _request: Request,
    sessionId?: string
  ): Promise<Task> {
    return asPromise(() => {
      this.authorize();
      if (this.records().length >= this.maxTasks) {
        throw new Error("Command task retention limit reached.");
      }
      const createdAt = new Date().toISOString();
      const ttl = taskParameters.ttl ?? null;
      const task: Task = {
        taskId: randomBytes(16).toString("hex"),
        status: "working",
        ttl,
        createdAt,
        lastUpdatedAt: createdAt,
        pollInterval: taskParameters.pollInterval ?? 1000
      };
      this.write({
        task,
        sessionKey: this.sessionKey(sessionId),
        ownerPid: process.pid,
        expiresAt: ttl === null ? null : Date.now() + ttl
      });
      return task;
    });
  }

  getTask(taskId: string, sessionId?: string): Promise<Task | null> {
    return asPromise(() => {
      this.authorize();
      const record = this.find(taskId, sessionId);
      return record ? { ...record.task } : null;
    });
  }

  getTaskResult(taskId: string, sessionId?: string): Promise<Result> {
    return asPromise(() => {
      this.authorize();
      const record = this.find(taskId, sessionId);
      if (!record) throw new Error(`Task ${taskId} not found`);
      if (!record.result)
        throw new Error(`Task ${taskId} has no result stored`);
      return record.result;
    });
  }

  storeTaskResult(
    taskId: string,
    status: "completed" | "failed",
    result: Result,
    sessionId?: string
  ): Promise<void> {
    return asPromise(() => {
      this.authorize();
      const record = this.find(taskId, sessionId);
      if (!record) throw new Error(`Task ${taskId} not found`);
      if (isTerminal(record.task.status)) {
        throw new Error(
          `Cannot store result for task ${taskId} in terminal status '${record.task.status}'. Task results can only be stored once.`
        );
      }
      const task: Task = {
        ...record.task,
        status,
        lastUpdatedAt: new Date().toISOString()
      };
      this.write({
        ...record,
        task,
        result,
        expiresAt: task.ttl === null ? null : Date.now() + task.ttl
      });
    });
  }

  async updateTaskStatus(
    taskId: string,
    status: Task["status"],
    statusMessage?: string,
    sessionId?: string
  ): Promise<void> {
    this.authorize();
    const record = this.find(taskId, sessionId);
    if (!record) throw new Error(`Task ${taskId} not found`);
    if (isTerminal(record.task.status)) {
      throw new Error(
        `Cannot update task ${taskId} from terminal status '${record.task.status}' to '${status}'. Terminal states (completed, failed, cancelled) cannot transition to other states.`
      );
    }
    if (status === "cancelled" && this.cancel) {
      await this.cancel(taskId);
    }
    // The grant may have ended while the command was settling.
    this.authorize();
    const task: Task = {
      ...record.task,
      status,
      ...(statusMessage && { statusMessage }),
      lastUpdatedAt: new Date().toISOString()
    };
    this.write({
      ...record,
      task,
      expiresAt: task.ttl === null ? null : Date.now() + task.ttl
    });
  }

  /**
  Record that a task's command was interrupted by the backend itself.

  This is the server's own bookkeeping, not a request: it states what the
  server did to the command, so it is not subject to the grant check that
  guards client requests. The task is failed, never completed, and its
  result says the outcome is unknown.
  */
  interrupt(taskId: string, statusMessage: string): void {
    const record = this.read(this.recordPath(taskId));
    if (!record || isTerminal(record.task.status)) return;
    const task: Task = {
      ...record.task,
      status: "failed",
      statusMessage,
      lastUpdatedAt: new Date().toISOString()
    };
    this.write({
      ...record,
      task,
      result: interruptedResult(taskId),
      expiresAt: task.ttl === null ? null : Date.now() + task.ttl
    });
  }

  listTasks(
    cursor?: string,
    sessionId?: string
  ): Promise<{ tasks: Task[]; nextCursor?: string }> {
    return asPromise(() => {
      this.authorize();
      const owned = this.records().filter(
        (record) => record.sessionKey === this.sessionKey(sessionId)
      );
      let startIndex = 0;
      if (cursor) {
        const cursorIndex = owned.findIndex(
          (record) => record.task.taskId === cursor
        );
        if (cursorIndex === -1) {
          throw new Error(`Invalid cursor: ${cursor}`);
        }
        startIndex = cursorIndex + 1;
      }
      const page = owned.slice(startIndex, startIndex + PAGE_SIZE);
      const last = page.at(-1);
      const nextCursor =
        last && startIndex + PAGE_SIZE < owned.length
          ? last.task.taskId
          : undefined;
      return {
        tasks: page.map((record) => ({ ...record.task })),
        ...(nextCursor !== undefined && { nextCursor })
      };
    });
  }
}
