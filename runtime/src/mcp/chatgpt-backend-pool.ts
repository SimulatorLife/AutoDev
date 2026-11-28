/**
Loopback pooled MCP backend host for Supergateway Streamable HTTP ingress.

External clients such as ChatGPT often open a fresh Streamable HTTP session
(`initialize` -> `notifications/initialized` -> single `tools/call`) for
every tool invocation without ever reusing `Mcp-Session-Id` or sending
`DELETE`. Letting Supergateway spawn a fresh stdio tree per session × per
backend multiplies Node/Python processes linearly with every tool call and
exhausts host memory.

This host sits strictly on loopback (`127.0.0.1:<ephemeral>`, per-generation
Bearer token) behind Supergateway's native `streamableHttp` combined
upstreams:
- Supergateway retains Streamable HTTP transport, `Mcp-Session-Id` isolation,
  external Bearer auth, `/readyz`, `toolPrefix` namespacing, combining, and
  session expiry.
- Each configured backend runs at most ONE confined local process (or one
  remote Streamable HTTP transport), started lazily on demand with
  single-flight coalescing, idle-reaped when unused, and cleaned up by full
  POSIX process group so wrapper launchers never orphan grandchildren.
- `initialize` and `tools/list` answers are cached per backend (invalidated
  on `notifications/tools/list_changed` or backend exit), so repeated
  one-shot sessions complete handshakes in milliseconds without waking idle
  backends.
- Role allowlists, capability filtering, truthful tool annotations,
  per-request deadlines, secret isolation, and lazy OpenTelemetry spans are
  enforced uniformly at this boundary.
*/

import { type ChildProcess, spawn } from "node:child_process";
import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual
} from "node:crypto";
import { once } from "node:events";
import { existsSync } from "node:fs";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse
} from "node:http";
import { createConnection } from "node:net";
import path from "node:path";
import { createInterface, type Interface } from "node:readline";

import { isTerminal } from "@modelcontextprotocol/sdk/experimental/tasks/interfaces.js";
import {
  CancelledNotificationSchema,
  CreateTaskResultSchema,
  GetTaskPayloadResultSchema,
  type JSONRPCMessage,
  ListTasksResultSchema,
  ProgressNotificationSchema,
  type ProgressToken,
  ProgressTokenSchema,
  type Task,
  TaskSchema,
  TaskStatusNotificationSchema
} from "@modelcontextprotocol/sdk/types.js";
import { isRecord } from "@simulatorlife/autodev-core";
import { z } from "zod";

import {
  KEYCHAIN_SECRET_NAMES,
  readRuntimeSecret
} from "../shared/runtime-secrets.ts";
import {
  MCP_SERVER_COCOINDEX,
  MCP_SERVER_FILESYSTEM,
  MCP_SERVER_XACPX
} from "../shared/tool-names.ts";
import type {
  McpToolCallCorrelation,
  ToolCallOutcome
} from "./mcp-telemetry.ts";
import {
  createRemoteMcpTransport,
  publicRemoteMcpMessage,
  remoteTransportErrorMessage
} from "./remote-transport.ts";
import type { GatewayCallObservations } from "./gateway-observations.ts";
import { SESSION_GRANT_META_KEY, verifySessionGrant } from "./session-grant.ts";

type JsonRecord = Record<string, unknown>;
type JsonRpcId = string | number;

function errorResponse(id: JsonRpcId, message: string): JsonRecord {
  return { jsonrpc: "2.0", id, error: { code: -32_601, message } };
}

const identifier = z.string().regex(/^[a-zA-Z0-9_.-]+$/u);
const toolIdentifier = z.string().regex(/^[a-zA-Z0-9_.-]+$/u);

export const CHATGPT_MCP_POOL_PORT_ENV = "AUTODEV_MCP_POOL_PORT";
export const CHATGPT_MCP_POOL_TOKEN_ENV = "AUTODEV_MCP_POOL_TOKEN";
const DEFAULT_BACKEND_IDLE_TIMEOUT_MS = 180_000;
const REQUEST_TIMEOUT_MS = 15_000;
const TOOL_CALL_TIMEOUT_MS = 60_000;
const MAX_BODY_BYTES = 16 * 1024 * 1024;
const MAX_SESSIONS_PER_SERVER = 256;
// Limit gateway lifetime bookkeeping, not the backend's own task store.
const MAX_PINNED_TASKS = 256;
const MAX_TIMER_MS = 2_147_483_647;
const PROCESS_KILL_GRACE_MS = 5000;

const CLIENT_METHODS = new Set([
  "initialize",
  "ping",
  "tools/list",
  "tools/call",
  "tasks/get",
  "tasks/list",
  "tasks/result",
  "tasks/cancel",
  "notifications/initialized",
  "notifications/cancelled"
]);

const pooledLocalBackendSchema = z
  .object({
    kind: z.literal("stdio"),
    /**
    The canonical MCP server this backend serves. The pool key may be
    role-qualified, but the server identity decides the confinement and
    sandbox rules the backend runs under.
    */
    server: z.string().min(1),
    command: z.string().min(1),
    args: z.array(z.string()),
    cwd: z.string().min(1),
    tools: z.array(toolIdentifier).min(1),
    /**
    Role-scoped environment for this backend. It is applied on top of the
    shared gateway environment so one pooled backend per role can enforce
    that role's own permissions.
    */
    env: z.record(z.string(), z.string()).optional(),
    /**
    The `env` variable that carries this backend's coordinator identity.
    When set, the backend is conversation-scoped: every ChatGPT
    conversation gets its own process, whose identity is this variable's
    value suffixed with a digest of the conversation's platform-supplied
    `_meta["openai/session"]`. A call without that identity is refused, so
    one conversation never acts under another's coordinator.
    */
    conversationScopedEnv: z
      .string()
      .regex(/^[A-Z0-9_]+$/u)
      .optional()
  })
  .strict()
  .refine(
    (spec) =>
      spec.conversationScopedEnv === undefined ||
      spec.env?.[spec.conversationScopedEnv] !== undefined,
    { message: "conversationScopedEnv must name a variable set in env" }
  );

const pooledRemoteBackendSchema = z
  .object({
    kind: z.literal("remote"),
    url: z.string().min(1),
    bearer_token_env_var: z
      .string()
      .regex(/^[A-Z0-9_]+$/u)
      .optional(),
    http_headers: z.record(z.string(), z.string()).optional(),
    tools: z.array(toolIdentifier).min(1)
  })
  .strict();

/**
A role's server for locally admitted sessions. It has no fixed workspace:
each request's session grant names the workspace its backend runs in, and
the gateway's admission provisions that backend on first use.
*/
const admittedBackendSchema = z
  .object({
    kind: z.literal("admitted"),
    role: z.string().regex(/^[a-z0-9-]+$/u),
    server: z.string().min(1),
    tools: z.array(toolIdentifier).min(1)
  })
  .strict();
type AdmittedBackendSpec = z.infer<typeof admittedBackendSchema>;

export const chatgptBackendPoolConfigSchema = z
  .object({
    version: z.literal(1),
    servers: z.record(
      identifier,
      z.discriminatedUnion("kind", [
        pooledLocalBackendSchema,
        pooledRemoteBackendSchema,
        admittedBackendSchema
      ])
    )
  })
  .strict();

export type PooledBackendSpec = Exclude<
  z.infer<typeof chatgptBackendPoolConfigSchema>["servers"][string],
  AdmittedBackendSpec
>;
export type ChatgptBackendPoolConfig = z.infer<
  typeof chatgptBackendPoolConfigSchema
>;

export interface ChatgptBackendPoolOptions {
  /**
  Base clean environment inherited by local backends (never contains tunnel/remote secrets).
  */
  readonly gatewayEnv: Record<string, string>;
  /**
  Host environment used solely for resolving per-remote-server credentials in memory.
  */
  readonly secretEnv?: NodeJS.ProcessEnv;
  /**
  Optional pre-generated Bearer token; defaults to a freshly minted 256-bit token.
  */
  readonly token?: string;
  /**
  Idle duration before an unused local backend process is gracefully reaped.
  */
  readonly idleTimeoutMs?: number;
  /**
  Maximum duration for an individual `tools/call` before timing out.
  */
  readonly toolCallTimeoutMs?: number;
  /**
  Maximum duration for initialize/list/ping requests.
  */
  readonly requestTimeoutMs?: number;
  /**
  Most concurrently retained conversations per conversation-scoped backend.
  */
  readonly maxConversations?: number;
  /**
  Admits locally granted sessions to `admitted` servers.
  */
  readonly admission?: GatewayAdmission;
  /**
  The gateway's ledger of the tool calls it served.
  */
  readonly observations?: GatewayCallObservations;
}

export interface GatewayAdmission {
  /**
  The private secret session grants are signed with.
  */
  readonly secret: string;
  /**
  Reviewed workspace for discovery-only backends; never a client execution grant.
  */
  readonly catalogueWorkspace: string;
  /**
  The confined launch of one role's server in an admitted workspace. A
  delegation backend also receives the session it acts for.
  */
  provision(
    server: string,
    role: string,
    workspace: string,
    session?: string
  ): {
    server: string;
    command: string;
    args: string[];
    cwd: string;
    env?: Record<string, string>;
  };
}

export interface ChatgptBackendPoolHandle {
  readonly port: number;
  readonly token: string;
  readonly server: Server;
  /**
  Active backend process/transport metrics for diagnostics and tests.
  */
  stats(): Record<
    string,
    {
      running: boolean;
      spawns: number;
      activeCalls: number;
      retainedTasks: number;
      uncertainTaskCreation: boolean;
      sessions: number;
      cachedTools: boolean;
      /**
      Conversation-scoped backends: the conversations with a backend of their own.
      */
      conversations?: number;
    }
  >;
  close(): Promise<void>;
}

interface PendingRpc {
  readonly backend: LiveBackend;
  readonly internalId: string;
  readonly clientId: JsonRpcId;
  readonly sessionId: string | null;
  readonly method: string;
  readonly progressToken?: ProgressToken;
  readonly createsTask: boolean;
  readonly taskId?: string;
  // Who may see the task this request creates or names.
  readonly taskOwner: string | null;
  readonly timer: NodeJS.Timeout;
  readonly detachAbort: () => void;
  cancelled: boolean;
  resolve(message: JsonRecord): void;
  reject(error: Error): void;
}

interface LiveBackend {
  send(message: JsonRecord): void;
  setProtocolVersion?(version: string): void;
  close(): Promise<void>;
  kill(): void;
}

interface TaskPin {
  readonly backend: LiveBackend;
  // The conversation (or, without one, the MCP session) that created the
  // task. A task ID is a handle, never a credential: only its owner may read,
  // cancel or list it.
  readonly owner: string;
  readonly ttl: number | null;
  // Null means execution or retention is not yet known to have ended.
  expiresAt: number | null;
}

interface LogicalSession {
  readonly id: string;
  sse?: ServerResponse | undefined;
  lastSeen: number;
}

function parseJson(value: string): JsonRecord | null {
  try {
    const parsed: unknown = JSON.parse(value);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function timingSafeBearerMatch(
  header: string | undefined,
  expectedToken: string
): boolean {
  if (!header) return false;
  const expected = `Bearer ${expectedToken}`;
  const actualBuffer = Buffer.from(header, "utf8");
  const expectedBuffer = Buffer.from(expected, "utf8");
  if (actualBuffer.length !== expectedBuffer.length) return false;
  return timingSafeEqual(actualBuffer, expectedBuffer);
}

/**
Terminate a spawned process and its entire POSIX process group so wrappers never orphan children.
*/
function signalProcessTree(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform !== "win32" && typeof child.pid === "number") {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      /*
      Fall back to direct child signal if group already exited or differs.
      */
    }
  }
  try {
    child.kill(signal);
  } catch {
    /*
    Already exited.
    */
  }
}

async function stopProcessTree(
  child: ChildProcess,
  graceMs = PROCESS_KILL_GRACE_MS
): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  signalProcessTree(child, "SIGTERM");
  const exited = await Promise.race([
    once(child, "exit").then(() => true),
    new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), graceMs);
      timer.unref();
    })
  ]);
  if (exited || child.exitCode !== null || child.signalCode !== null) {
    return;
  }

  signalProcessTree(child, "SIGKILL");
  await Promise.race([
    once(child, "exit").catch(() => {}),
    new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 1000);
      timer.unref();
    })
  ]);
}

/**
Check whether a live host CocoIndex daemon is already listening on its Unix socket.
*/
async function isUnixSocketListening(
  socketPath: string,
  timeoutMs = 250
): Promise<boolean> {
  if (!existsSync(socketPath)) return false;
  return new Promise<boolean>((resolve) => {
    let isSettled = false;
    const finish = (ok: boolean): void => {
      if (isSettled) return;
      isSettled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(ok);
    };
    const socket = createConnection({ path: socketPath });
    const timer = setTimeout(() => finish(false), timeoutMs);
    timer.unref();
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });
}

let sharedTelemetryPromise: Promise<
  typeof import("./mcp-telemetry.ts")
> | null = null;

function loadSharedTelemetry(): Promise<typeof import("./mcp-telemetry.ts")> {
  if (!sharedTelemetryPromise) {
    sharedTelemetryPromise = import("./mcp-telemetry.ts").then((module_) => {
      const token = readRuntimeSecret("OPENLIT_OTLP_API_KEY");
      try {
        module_.configureExternalMcpTelemetry(
          "pooled",
          "http://127.0.0.1:4318/v1/traces",
          token ? { Authorization: `Bearer ${token}` } : {}
        );
      } catch {
        /*
        Telemetry may already be initialized in the same process (e.g. tests).
        */
      }
      return module_;
    });
  }
  return sharedTelemetryPromise;
}

interface CachedInitialize {
  readonly serverInfo: unknown;
  readonly capabilities: JsonRecord;
  readonly fetchRawTools: () => Promise<readonly unknown[]>;
}

class CatalogueDiscoveryCache {
  private readonly initEntries = new Map<string, Promise<CachedInitialize>>();
  private readonly toolEntries = new Map<string, Promise<readonly unknown[]>>();

  publishInit(key: string, init: CachedInitialize): void {
    if (!this.initEntries.has(key)) {
      this.initEntries.set(key, Promise.resolve(init));
    }
  }

  publishTools(key: string, rawTools: readonly unknown[]): void {
    if (!this.toolEntries.has(key)) {
      this.toolEntries.set(key, Promise.resolve(rawTools));
    }
  }

  getOrComputeInit(
    key: string,
    compute: () => Promise<CachedInitialize>
  ): Promise<CachedInitialize> {
    const existing = this.initEntries.get(key);
    if (existing) return existing;
    const pending = compute().catch((error: unknown) => {
      if (this.initEntries.get(key) === pending) this.initEntries.delete(key);
      throw error;
    });
    this.initEntries.set(key, pending);
    return pending;
  }

  getOrComputeTools(
    key: string,
    compute: () => Promise<readonly unknown[]>
  ): Promise<readonly unknown[]> {
    const existing = this.toolEntries.get(key);
    if (existing) return existing;
    const pending = compute().catch((error: unknown) => {
      if (this.toolEntries.get(key) === pending) this.toolEntries.delete(key);
      throw error;
    });
    this.toolEntries.set(key, pending);
    return pending;
  }
}

function discoveryCacheKey(spec: PooledBackendSpec): string | null {
  if (spec.kind === "remote") {
    return JSON.stringify([
      "remote",
      spec.url,
      spec.bearer_token_env_var ?? null,
      spec.http_headers ?? null
    ]);
  }
  if (spec.conversationScopedEnv !== undefined) return null;
  return JSON.stringify([
    "stdio",
    spec.server,
    spec.command,
    spec.args,
    spec.cwd
  ]);
}

interface ControllerDiscoveryOptions {
  readonly cache: CatalogueDiscoveryCache;
  readonly shareDiscovery: boolean;
}

class PooledBackendController {
  readonly name: string;
  private readonly spec: PooledBackendSpec;
  private readonly allowed: Set<string>;
  private readonly gatewayEnv: Record<string, string>;
  private readonly secretEnv: NodeJS.ProcessEnv;
  private readonly idleTimeoutMs: number;
  private readonly toolCallTimeoutMs: number;
  private readonly requestTimeoutMs: number;
  private readonly discoveryCache: CatalogueDiscoveryCache | null;
  private readonly discoveryKey: string | null;
  private readonly shareDiscovery: boolean;
  private readonly observations: GatewayCallObservations | null;

  private live: LiveBackend | null = null;
  private starting: Promise<LiveBackend> | null = null;
  private cachedInitialize: {
    serverInfo: unknown;
    capabilities: JsonRecord;
  } | null = null;
  private cachedTools: unknown[] | null = null;
  private toolsRefreshInFlight: Promise<unknown[]> | null = null;
  private idleTimer: NodeJS.Timeout | null = null;
  private nextInternalId = 0;
  private spawns = 0;
  private activeCalls = 0;
  private closing = false;
  private readonly pending = new Map<string, PendingRpc>();
  private readonly taskPins = new Map<string, TaskPin>();
  // A lost creation acknowledgement may hide a running mutation. Do not
  // reap or admit more task creations on that backend until explicit close.
  private uncertainTaskBackend: LiveBackend | null = null;
  private readonly sessions = new Map<string, LogicalSession>();

  constructor(
    name: string,
    spec: PooledBackendSpec,
    options: ChatgptBackendPoolOptions,
    discovery?: ControllerDiscoveryOptions
  ) {
    this.name = name;
    this.spec = spec;
    this.allowed = new Set(spec.tools);
    this.gatewayEnv = options.gatewayEnv;
    this.secretEnv = options.secretEnv ?? process.env;
    this.idleTimeoutMs =
      options.idleTimeoutMs ?? DEFAULT_BACKEND_IDLE_TIMEOUT_MS;
    this.toolCallTimeoutMs = options.toolCallTimeoutMs ?? TOOL_CALL_TIMEOUT_MS;
    this.requestTimeoutMs = options.requestTimeoutMs ?? REQUEST_TIMEOUT_MS;
    this.discoveryCache = discovery?.cache ?? null;
    this.discoveryKey = discovery ? discoveryCacheKey(spec) : null;
    this.shareDiscovery =
      discovery?.shareDiscovery === true && this.discoveryKey !== null;
    this.observations = options.observations ?? null;
  }

  /**
  Run one admitted tool call and record what the gateway saw of it: the
  canonical server, the tool, the verified role, the outcome and the time.
  */
  private async observedToolCall(
    toolName: string,
    correlation: McpToolCallCorrelation | undefined,
    call: () => Promise<ToolCallOutcome>
  ): Promise<void> {
    const startedAt = performance.now();
    let status: ToolCallOutcome["status"] = "error";
    try {
      status = (await call()).status;
    } finally {
      this.observations?.record({
        server:
          correlation?.server ??
          ("server" in this.spec ? this.spec.server : this.name),
        tool: toolName,
        role: correlation?.role ?? null,
        status,
        durationMs: performance.now() - startedAt
      });
    }
  }

  private pruneTaskPins(): void {
    const now = performance.now();
    for (const [id, pin] of this.taskPins) {
      if (pin.expiresAt !== null && pin.expiresAt <= now) {
        this.taskPins.delete(id);
      }
    }
  }

  /**
  Include task execution and result retention, not just pending RPCs.
  */
  busy(): boolean {
    this.pruneTaskPins();
    return (
      this.activeCalls > 0 ||
      this.pending.size > 0 ||
      this.taskPins.size > 0 ||
      this.uncertainTaskBackend !== null
    );
  }

  private canCreateTask(): boolean {
    this.pruneTaskPins();
    let pendingCreations = 0;
    for (const request of this.pending.values()) {
      if (request.createsTask) pendingCreations += 1;
    }
    return (
      this.uncertainTaskBackend === null &&
      this.taskPins.size + pendingCreations < MAX_PINNED_TASKS
    );
  }

  private forgetBackendTasks(backend: LiveBackend): void {
    for (const [id, pin] of this.taskPins) {
      if (pin.backend === backend) this.taskPins.delete(id);
    }
    if (this.uncertainTaskBackend === backend) this.uncertainTaskBackend = null;
  }

  private observeTask(backend: LiveBackend, task: Task): void {
    const pin = this.taskPins.get(task.taskId);
    if (!pin || pin.backend !== backend || !isTerminal(task.status)) return;
    this.markTaskTerminal(pin);
  }

  private markTaskTerminal(pin: TaskPin): void {
    // The SDK resets its result TTL when a task becomes terminal. Measure
    // from the first observed terminal state, not creation or repeated polls.
    if (pin.expiresAt === null && pin.ttl !== null) {
      pin.expiresAt = performance.now() + pin.ttl;
    }
  }

  private observeTaskReply(pending: PendingRpc, message: JsonRecord): void {
    if (message.error) return;
    if (pending.createsTask) {
      const parsed = CreateTaskResultSchema.safeParse(message.result);
      if (!parsed.success || this.taskPins.has(parsed.data.task.taskId)) {
        this.uncertainTaskBackend = pending.backend;
        return;
      }
      const task = parsed.data.task;
      const ttl =
        // The installed SDK store treats zero as unlimited too.
        task.ttl !== null && Number.isFinite(task.ttl) && task.ttl > 0
          ? task.ttl
          : null;
      if (pending.taskOwner === null) return;
      this.taskPins.set(task.taskId, {
        backend: pending.backend,
        owner: pending.taskOwner,
        ttl,
        expiresAt: null
      });
      this.observeTask(pending.backend, task);
    } else if (pending.method === "tasks/list") {
      const parsed = ListTasksResultSchema.safeParse(message.result);
      if (parsed.success) {
        for (const task of parsed.data.tasks) {
          this.observeTask(pending.backend, task);
        }
      }
    } else if (pending.taskId !== undefined) {
      const pin = this.taskPins.get(pending.taskId);
      if (!pin || pin.backend !== pending.backend) return;
      if (pending.method === "tasks/result") {
        if (GetTaskPayloadResultSchema.safeParse(message.result).success) {
          this.markTaskTerminal(pin);
        }
      } else if (
        pending.method === "tasks/get" ||
        pending.method === "tasks/cancel"
      ) {
        const parsed = TaskSchema.safeParse(message.result);
        if (parsed.success && parsed.data.taskId === pending.taskId) {
          this.observeTask(pending.backend, parsed.data);
        }
      }
    }
  }

  // A backend lists every task it holds; a caller sees only its own.
  private ownedTaskList(
    response: JsonRecord,
    owner: string,
    id: JsonRpcId
  ): JsonRecord {
    const parsed = ListTasksResultSchema.safeParse(response.result);
    if (response.error || !parsed.success) {
      // A malformed list or upstream error may contain another owner's
      // private task data. Never bypass the ownership projection.
      return errorResponse(id, "Backend task list unavailable");
    }
    this.pruneTaskPins();
    const { tasks, nextCursor } = parsed.data;
    return {
      jsonrpc: "2.0",
      id,
      result: {
        tasks: tasks.filter(
          (task) => this.taskPins.get(task.taskId)?.owner === owner
        ),
        ...(nextCursor !== undefined && { nextCursor })
      }
    };
  }

  stats() {
    this.pruneTaskPins();
    return {
      running: this.live !== null,
      spawns: this.spawns,
      activeCalls: this.activeCalls,
      retainedTasks: this.taskPins.size,
      uncertainTaskCreation: this.uncertainTaskBackend !== null,
      sessions: this.sessions.size,
      cachedTools: this.cachedTools !== null
    };
  }

  createSession(): LogicalSession {
    if (this.sessions.size >= MAX_SESSIONS_PER_SERVER) {
      let oldest: LogicalSession | null = null;
      for (const session of this.sessions.values()) {
        if (!oldest || session.lastSeen < oldest.lastSeen) oldest = session;
      }
      if (oldest) this.deleteSession(oldest.id);
    }
    const session: LogicalSession = {
      id: randomUUID(),
      lastSeen: Date.now()
    };
    this.sessions.set(session.id, session);
    return session;
  }

  getSession(sessionId: string): LogicalSession | undefined {
    const session = this.sessions.get(sessionId);
    if (session) session.lastSeen = Date.now();
    return session;
  }

  deleteSession(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    this.sessions.delete(sessionId);
    if (session.sse && !session.sse.writableEnded) {
      try {
        session.sse.end();
      } catch {
        /*
        ignore closed socket
        */
      }
    }
  }

  attachSse(session: LogicalSession, res: ServerResponse): void {
    if (session.sse && !session.sse.writableEnded) {
      try {
        session.sse.end();
      } catch {
        /*
        replace prior stream
        */
      }
    }
    session.sse = res;
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "mcp-session-id": session.id
    });
    res.write(": connected\n\n");
    res.once("close", () => {
      if (session.sse === res) session.sse = undefined;
    });
  }

  private sendNotification(session: LogicalSession, message: JsonRecord): void {
    const sse = session.sse;
    if (!sse || sse.writableEnded || sse.destroyed) return;
    try {
      sse.write(`event: message\ndata: ${JSON.stringify(message)}\n\n`);
    } catch {
      session.sse = undefined;
    }
  }

  private broadcastNotification(message: JsonRecord): void {
    for (const session of this.sessions.values()) {
      this.sendNotification(session, message);
    }
  }

  /**
  A progress token is request-scoped, not a globally unique client ID.
  Only forward progress for a still-pending request on this backend.
  */
  private routeProgress(backend: LiveBackend, message: JsonRecord): void {
    if (message.jsonrpc !== "2.0") return;
    const parsed = ProgressNotificationSchema.safeParse(message);
    if (!parsed.success) return;
    const { progressToken } = parsed.data.params;
    if (typeof progressToken !== "string") return;
    const pending = this.pending.get(progressToken);
    if (
      !pending ||
      pending.backend !== backend ||
      pending.cancelled ||
      pending.progressToken === undefined ||
      !pending.sessionId
    ) {
      return;
    }
    const session = this.sessions.get(pending.sessionId);
    if (!session) return;
    this.sendNotification(session, {
      jsonrpc: "2.0",
      method: parsed.data.method,
      params: {
        ...parsed.data.params,
        progressToken: pending.progressToken
      }
    });
  }

  private clearIdleTimer(): void {
    if (!this.idleTimer) {
      return;
    }

    clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }

  private armIdleTimer(): void {
    this.clearIdleTimer();
    if (
      this.closing ||
      !this.live ||
      this.activeCalls > 0 ||
      this.pending.size > 0 ||
      this.idleTimeoutMs <= 0
    ) {
      return;
    }
    this.pruneTaskPins();
    if (this.uncertainTaskBackend !== null) return;
    if (this.taskPins.size > 0) {
      // A terminal task still owns its advertised result-retention window.
      // Active/unobserved tasks never expire merely because of elapsed time.
      const deadlines = Array.from(
        this.taskPins.values(),
        (pin) => pin.expiresAt
      ).filter((deadline): deadline is number => deadline !== null);
      if (deadlines.length > 0) {
        this.idleTimer = setTimeout(
          () => this.armIdleTimer(),
          Math.min(
            MAX_TIMER_MS,
            Math.max(1, Math.ceil(Math.min(...deadlines) - performance.now()))
          )
        );
        this.idleTimer.unref();
      }
      return;
    }
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      if (this.closing || !this.live || this.busy()) return;
      const backend = this.live;
      this.live = null;
      // Preserve cachedInitialize and cachedTools across idle reaps so
      // future discovery-only sessions never wake an unused backend.
      void backend.close().catch(() => {});
    }, this.idleTimeoutMs);
    this.idleTimer.unref();
  }

  private removePending(entry: PendingRpc): void {
    this.pending.delete(entry.internalId);
    clearTimeout(entry.timer);
    entry.detachAbort();
  }

  private cancelPending(entry: PendingRpc): void {
    if (this.pending.get(entry.internalId) !== entry) return;
    entry.cancelled = true;
    if (entry.createsTask) this.uncertainTaskBackend = entry.backend;
    this.removePending(entry);
    entry.backend.send({
      jsonrpc: "2.0",
      method: "notifications/cancelled",
      params: { requestId: entry.internalId }
    });
    entry.resolve(
      errorResponse(entry.clientId, "External MCP request cancelled")
    );
    this.armIdleTimer();
  }

  private handleBackendMessage(
    backend: LiveBackend,
    message: JsonRecord | null
  ): void {
    if (!message) return;
    const rawId = message.id;
    const id =
      typeof rawId === "string" || typeof rawId === "number" ? rawId : null;
    if (typeof message.method === "string") {
      if (id !== null) {
        backend.send(
          errorResponse(id, "MCP client capability is not externally approved")
        );
        return;
      }
      if (
        message.method === "notifications/tools/list_changed" &&
        this.live === backend
      ) {
        this.cachedTools = null;
        // The shared catalogue changed, not the callers' private state.
        // Never broadcast arbitrary backend metadata with this signal.
        this.broadcastNotification({
          jsonrpc: "2.0",
          method: "notifications/tools/list_changed"
        });
      } else if (message.method === "notifications/progress") {
        this.routeProgress(backend, message);
      } else if (message.method === "notifications/tasks/status") {
        const parsed = TaskStatusNotificationSchema.safeParse(message);
        if (message.jsonrpc === "2.0" && parsed.success) {
          this.observeTask(backend, parsed.data.params);
          this.armIdleTimer();
        }
      }
      return;
    }
    if (id === null) return;
    const key = String(id);
    const pending = this.pending.get(key);
    if (!pending || pending.backend !== backend) return;
    this.removePending(pending);
    if (pending.cancelled) {
      this.armIdleTimer();
      return;
    }
    this.observeTaskReply(pending, message);
    pending.resolve({ ...message, id: pending.clientId });
    this.armIdleTimer();
  }

  private handleBackendExit(backend: LiveBackend, reason: string): void {
    this.forgetBackendTasks(backend);
    if (this.live === backend) {
      this.live = null;
      this.clearIdleTimer();
      // Unexpected exit invalidates cached discovery so recovery/failure semantics stay truthful.
      this.cachedInitialize = null;
      this.cachedTools = null;
    }
    for (const entry of this.pending.values()) {
      if (entry.backend !== backend) continue;
      this.removePending(entry);
      entry.reject(new Error(reason));
    }
  }

  private async buildLocalChildEnv(): Promise<NodeJS.ProcessEnv> {
    if (this.spec.kind !== "stdio") return {};
    const isSandboxed = this.spec.command === "/usr/bin/sandbox-exec";
    const server = this.spec.server;
    if (isSandboxed && server === MCP_SERVER_FILESYSTEM) {
      return {
        HOME: this.spec.cwd,
        PATH: "/usr/bin:/bin",
        LANG: "en_US.UTF-8",
        ...this.spec.env
      };
    }
    let isCocoindexSupervised = false;
    if (isSandboxed && server === MCP_SERVER_COCOINDEX) {
      const homeDir = this.gatewayEnv.HOME;
      if (homeDir) {
        const daemonSock = path.join(homeDir, ".cocoindex_code", "daemon.sock");
        // Never allow a Seatbelt-jailed `ccc mcp` to hijack or duplicate an
        // already-running host `ccc run-daemon` (each daemon loads a ~1.4 GB
        // embedding worker and a jailed daemon fails other workspaces with EPERM).
        isCocoindexSupervised = await isUnixSocketListening(daemonSock);
      }
    }
    const childEnvironment: NodeJS.ProcessEnv = {
      ...(isSandboxed &&
        server === MCP_SERVER_COCOINDEX && {
          HF_HUB_OFFLINE: "1",
          TRANSFORMERS_OFFLINE: "1",
          ...(isCocoindexSupervised && {
            COCOINDEX_CODE_DAEMON_SUPERVISED: "1"
          })
        }),
      ...this.gatewayEnv,
      // The role-scoped environment is applied last so one role's identity and
      // coordinator always win over the gateway's shared defaults.
      ...this.spec.env
    };
    for (const secretName of [
      ...KEYCHAIN_SECRET_NAMES,
      "OPENAI_ADMIN_KEY",
      "OPENLIT_OTLP_API_KEY",
      CHATGPT_MCP_POOL_TOKEN_ENV,
      CHATGPT_MCP_POOL_PORT_ENV
    ]) {
      delete childEnvironment[secretName];
    }
    return childEnvironment;
  }

  private async spawnLiveBackend(): Promise<LiveBackend> {
    this.spawns += 1;
    if (this.spec.kind === "remote") {
      const transport = createRemoteMcpTransport(
        this.spec,
        this.name,
        this.secretEnv
      );
      let isClosed = false;
      let sendChain: Promise<void> = Promise.resolve();
      const live: LiveBackend = {
        setProtocolVersion: (version) => {
          transport.setProtocolVersion(version);
        },
        send: (message) => {
          if (isClosed) return;
          sendChain = sendChain.then(async () => {
            if (isClosed) return;
            try {
              await transport.send(message as unknown as JSONRPCMessage);
            } catch (error) {
              const id =
                typeof message.id === "string" || typeof message.id === "number"
                  ? String(message.id)
                  : null;
              if (id) {
                const entry = this.pending.get(id);
                if (entry && entry.backend === live) {
                  if (entry.createsTask) this.uncertainTaskBackend = live;
                  this.removePending(entry);
                  entry.resolve(
                    errorResponse(
                      entry.clientId,
                      remoteTransportErrorMessage(error)
                    )
                  );
                }
              }
            }
          });
        },
        close: async () => {
          if (isClosed) return;
          isClosed = true;
          await Promise.race([
            transport.terminateSession().catch(() => {}),
            new Promise((resolve) => setTimeout(resolve, 300).unref())
          ]);
          await transport.close().catch(() => {});
        },
        kill: () => {
          void live.close();
        }
      };
      transport.onmessage = (message) => {
        this.handleBackendMessage(
          live,
          publicRemoteMcpMessage(message) as unknown as JsonRecord
        );
      };
      transport.onerror = () => {
        /*
        Surface errors through pending requests rather than leaking URLs/headers.
        */
      };
      // eslint-disable-next-line unicorn/prefer-add-event-listener -- MCP SDK StreamableHTTPClientTransport exposes an onclose callback property, not EventTarget.
      transport.onclose = () => {
        if (isClosed) {
          return;
        }

        isClosed = true;
        this.handleBackendExit(live, `Remote MCP "${this.name}" closed`);
      };
      return live;
    }

    const childEnvironment = await this.buildLocalChildEnv();
    const child = spawn(this.spec.command, this.spec.args, {
      cwd: this.spec.cwd,
      env: childEnvironment,
      detached: process.platform !== "win32",
      stdio: ["pipe", "pipe", "pipe"]
    });
    const lines: Interface = createInterface({ input: child.stdout! });
    let isClosed = false;
    const live: LiveBackend = {
      send: (message) => {
        if (isClosed || !child.stdin || child.stdin.destroyed) return;
        child.stdin.write(`${JSON.stringify(message)}\n`);
      },
      close: async () => {
        if (isClosed) return;
        isClosed = true;
        lines.close();
        await stopProcessTree(child);
      },
      kill: () => {
        if (isClosed) return;
        isClosed = true;
        lines.close();
        signalProcessTree(child, "SIGKILL");
      }
    };
    lines.on("line", (line) => {
      this.handleBackendMessage(live, parseJson(line));
    });
    // Drain stderr without unbounded buffering so chatty servers never block on a full pipe.
    child.stderr?.resume();
    child.once("error", () => {
      if (isClosed) {
        return;
      }

      isClosed = true;
      lines.close();
      this.handleBackendExit(
        live,
        `External MCP backend "${this.name}" failed to start`
      );
    });
    child.once("close", (code, signal) => {
      if (isClosed) {
        return;
      }

      isClosed = true;
      lines.close();
      this.handleBackendExit(
        live,
        `External MCP backend "${this.name}" exited (code=${code}, signal=${signal})`
      );
    });
    return live;
  }

  private sendRawRequest(
    backend: LiveBackend,
    method: string,
    parameters: unknown,
    clientId: JsonRpcId,
    sessionId: string | null,
    timeoutMs: number,
    taskOwner: string | null = null,
    signal?: AbortSignal
  ): Promise<JsonRecord> {
    if (signal?.aborted)
      return Promise.resolve(
        errorResponse(clientId, "External MCP request cancelled")
      );
    const createsTask =
      method === "tools/call" &&
      isRecord(parameters) &&
      parameters.task !== undefined;
    if (createsTask && !this.canCreateTask()) {
      return Promise.resolve(
        errorResponse(clientId, "Backend task retention capacity unavailable")
      );
    }
    const taskId =
      isRecord(parameters) && typeof parameters.taskId === "string"
        ? parameters.taskId
        : undefined;
    const internalId = `pool:${++this.nextInternalId}`;
    const meta =
      isRecord(parameters) && isRecord(parameters._meta)
        ? parameters._meta
        : null;
    const progressToken = ProgressTokenSchema.safeParse(meta?.progressToken);
    const forwardedParameters =
      progressToken.success && isRecord(parameters)
        ? { ...parameters, _meta: { ...meta, progressToken: internalId } }
        : parameters;
    return new Promise<JsonRecord>((resolve, reject) => {
      const timer = setTimeout(() => {
        const entry = this.pending.get(internalId);
        if (!entry) return;
        this.removePending(entry);
        if (entry.createsTask) this.uncertainTaskBackend = backend;
        if (!entry.cancelled) {
          backend.send({
            jsonrpc: "2.0",
            method: "notifications/cancelled",
            params: { requestId: internalId, reason: "timeout" }
          });
        }
        resolve(errorResponse(clientId, "External MCP request timed out"));
        // If no other calls are active, recycle a backend that timed out so a
        // wedged server does not poison subsequent requests.
        this.pruneTaskPins();
        if (
          this.live !== backend ||
          this.pending.size > 0 ||
          this.taskPins.size > 0 ||
          this.uncertainTaskBackend !== null
        ) {
          return;
        }

        this.live = null;
        this.cachedInitialize = null;
        this.cachedTools = null;
        void backend.close().catch(() => {});
      }, timeoutMs);
      timer.unref();
      const onAbort = () => {
        const entry = this.pending.get(internalId);
        if (entry) this.cancelPending(entry);
      };
      this.pending.set(internalId, {
        backend,
        internalId,
        clientId,
        sessionId,
        method,
        createsTask,
        ...(taskId !== undefined && { taskId }),
        taskOwner,
        ...(progressToken.success && { progressToken: progressToken.data }),
        timer,
        detachAbort: () => signal?.removeEventListener("abort", onAbort),
        cancelled: false,
        resolve,
        reject
      });
      signal?.addEventListener("abort", onAbort, { once: true });
      backend.send({
        jsonrpc: "2.0",
        id: internalId,
        method,
        ...(forwardedParameters !== undefined && {
          params: forwardedParameters
        })
      });
    });
  }

  private async ensureStarted(): Promise<LiveBackend> {
    if (this.closing) throw new Error("Backend pool is shutting down");
    if (this.live) {
      this.clearIdleTimer();
      return this.live;
    }
    if (this.starting) return this.starting;
    const startPromise = (async (): Promise<LiveBackend> => {
      const backend = await this.spawnLiveBackend();
      try {
        const initResp = await this.sendRawRequest(
          backend,
          "initialize",
          {
            protocolVersion: "2025-03-26",
            capabilities: {},
            clientInfo: {
              name: "autodev-chatgpt-backend-pool",
              version: "1.0.0"
            }
          },
          0,
          null,
          this.requestTimeoutMs
        );
        if (initResp.error || !isRecord(initResp.result)) {
          throw new Error(
            isRecord(initResp.error) &&
              typeof initResp.error.message === "string"
              ? initResp.error.message
              : `Backend "${this.name}" failed initialize`
          );
        }
        if (typeof initResp.result.protocolVersion === "string") {
          backend.setProtocolVersion?.(initResp.result.protocolVersion);
        }
        const rawCaps = isRecord(initResp.result.capabilities)
          ? initResp.result.capabilities
          : {};
        this.cachedInitialize = {
          serverInfo: initResp.result.serverInfo ?? {
            name: this.name,
            version: "1.0.0"
          },
          capabilities: {
            tools: isRecord(rawCaps.tools) ? rawCaps.tools : {},
            ...(isRecord(rawCaps.tasks) && { tasks: rawCaps.tasks })
          }
        };
        if (this.discoveryCache && this.discoveryKey) {
          this.discoveryCache.publishInit(this.discoveryKey, {
            serverInfo: this.cachedInitialize.serverInfo,
            capabilities: this.cachedInitialize.capabilities,
            fetchRawTools: async () =>
              this.fetchRawTools(await this.ensureStarted())
          });
        }
        backend.send({
          jsonrpc: "2.0",
          method: "notifications/initialized"
        });
        // Publish `this.live` only AFTER handshake and cachedInitialize are ready
        // so concurrent callers coalesce onto `this.starting` instead of racing.
        this.live = backend;
        this.armIdleTimer();
        return backend;
      } catch (error) {
        if (this.live === backend) this.live = null;
        this.cachedInitialize = null;
        this.cachedTools = null;
        await backend.close().catch(() => {});
        throw error;
      }
    })();
    const tracked = startPromise.finally(() => {
      if (this.starting === tracked) this.starting = null;
    });
    this.starting = tracked;
    return tracked;
  }

  private filterAllowedTools(rawTools: readonly unknown[]): unknown[] {
    const collected: unknown[] = [];
    for (const tool of rawTools) {
      if (
        isRecord(tool) &&
        typeof tool.name === "string" &&
        this.allowed.has(tool.name)
      ) {
        collected.push(tool);
      }
    }
    return collected;
  }

  private async fetchRawTools(backend: LiveBackend): Promise<unknown[]> {
    const collected: unknown[] = [];
    let cursor: string | undefined;
    const seenCursors = new Set<string>();
    do {
      const resp = await this.sendRawRequest(
        backend,
        "tools/list",
        cursor ? { cursor } : {},
        0,
        null,
        this.requestTimeoutMs
      );
      if (resp.error || !isRecord(resp.result)) {
        throw new Error(
          isRecord(resp.error) && typeof resp.error.message === "string"
            ? resp.error.message
            : `Backend "${this.name}" failed tools/list`
        );
      }
      if (Array.isArray(resp.result.tools)) {
        collected.push(...resp.result.tools);
      }
      const next =
        typeof resp.result.nextCursor === "string"
          ? resp.result.nextCursor
          : undefined;
      if (!next || seenCursors.has(next)) break;
      seenCursors.add(next);
      cursor = next;
    } while (cursor);
    return collected;
  }

  private async ensureSharedInitialize(): Promise<CachedInitialize> {
    return this.discoveryCache!.getOrComputeInit(
      this.discoveryKey!,
      async () => {
        await this.ensureStarted();
        return {
          serverInfo: this.cachedInitialize!.serverInfo,
          capabilities: this.cachedInitialize!.capabilities,
          fetchRawTools: async () =>
            this.fetchRawTools(await this.ensureStarted())
        };
      }
    );
  }

  private async fetchFilteredTools(): Promise<unknown[]> {
    if (this.cachedTools !== null) return this.cachedTools;
    if (this.shareDiscovery && this.discoveryCache && this.discoveryKey) {
      const init = await this.ensureSharedInitialize();
      this.cachedInitialize ??= {
        serverInfo: init.serverInfo,
        capabilities: init.capabilities
      };
      const rawTools = await this.discoveryCache.getOrComputeTools(
        this.discoveryKey,
        init.fetchRawTools
      );
      const collected = this.filterAllowedTools(rawTools);
      this.cachedTools = collected;
      return collected;
    }
    if (this.toolsRefreshInFlight) return this.toolsRefreshInFlight;
    const fetchPromise = (async (): Promise<unknown[]> => {
      const backend = await this.ensureStarted();
      const rawTools = await this.fetchRawTools(backend);
      if (this.discoveryCache && this.discoveryKey && this.cachedInitialize) {
        this.discoveryCache.publishInit(this.discoveryKey, {
          serverInfo: this.cachedInitialize.serverInfo,
          capabilities: this.cachedInitialize.capabilities,
          fetchRawTools: async () =>
            this.fetchRawTools(await this.ensureStarted())
        });
        this.discoveryCache.publishTools(this.discoveryKey, rawTools);
      }
      const collected = this.filterAllowedTools(rawTools);
      this.cachedTools = collected;
      return collected;
    })();
    const tracked = fetchPromise.finally(() => {
      if (this.toolsRefreshInFlight === tracked) {
        this.toolsRefreshInFlight = null;
      }
    });
    this.toolsRefreshInFlight = tracked;
    return tracked;
  }

  handleCancellation(
    sessionId: string,
    requestId: JsonRpcId,
    owner?: string
  ): void {
    // An ambiguous request ID is not authority to cancel multiple requests.
    const matches = [...this.pending.values()].filter(
      (entry) =>
        entry.sessionId === sessionId &&
        entry.clientId === requestId &&
        (owner === undefined || entry.taskOwner === owner)
    );
    const [entry] = matches;
    if (!entry || matches.length !== 1) return;
    this.cancelPending(entry);
  }

  async handleRequest(
    message: JsonRecord,
    sessionId: string | null,
    signal?: AbortSignal,
    // Set when the caller's scope already established who owns its tasks.
    ownerOverride?: string,
    // The admission facts the caller verified, for the call's span.
    correlation?: McpToolCallCorrelation
  ): Promise<JsonRecord | null> {
    const method = message.method;
    const rawId = message.id;
    const id =
      typeof rawId === "string" || typeof rawId === "number" ? rawId : null;

    if (typeof method !== "string" || !CLIENT_METHODS.has(method)) {
      return id !== null && typeof method === "string"
        ? errorResponse(id, "MCP capability is not externally approved")
        : null;
    }

    if (method === "notifications/initialized") {
      return null;
    }

    if (method === "notifications/cancelled") {
      const parsed = CancelledNotificationSchema.safeParse(message);
      if (
        sessionId &&
        parsed.success &&
        parsed.data.params.requestId !== undefined
      ) {
        this.handleCancellation(
          sessionId,
          parsed.data.params.requestId,
          ownerOverride
        );
      }
      return null;
    }

    if (id === null) return null;
    if (signal?.aborted)
      return errorResponse(id, "External MCP request cancelled");

    if (method === "ping") {
      return { jsonrpc: "2.0", id, result: {} };
    }

    if (method === "initialize") {
      const requestedProtocol =
        isRecord(message.params) &&
        typeof message.params.protocolVersion === "string"
          ? message.params.protocolVersion
          : undefined;
      const negotiatedProtocol =
        requestedProtocol === "2024-11-05" ? "2024-11-05" : "2025-03-26";
      if (!this.cachedInitialize) {
        try {
          if (this.shareDiscovery) {
            const init = await this.ensureSharedInitialize();
            this.cachedInitialize = {
              serverInfo: init.serverInfo,
              capabilities: init.capabilities
            };
          } else {
            await this.ensureStarted();
          }
        } catch (error) {
          return errorResponse(
            id,
            error instanceof Error ? error.message : "Backend failed to start"
          );
        }
      }
      const init = this.cachedInitialize!;
      return {
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: negotiatedProtocol,
          serverInfo: init.serverInfo,
          capabilities: init.capabilities
        }
      };
    }

    if (method === "tools/list") {
      try {
        const tools = await this.fetchFilteredTools();
        return { jsonrpc: "2.0", id, result: { tools } };
      } catch (error) {
        return errorResponse(
          id,
          error instanceof Error ? error.message : "Failed to list MCP tools"
        );
      }
    }

    const owner = ownerOverride ?? taskOwner(message.params, sessionId);
    if (method === "tools/call") {
      const parameters = isRecord(message.params) ? message.params : null;
      const toolName = parameters?.name;
      if (typeof toolName !== "string" || !this.allowed.has(toolName)) {
        return errorResponse(id, "Tool is not enabled for this role");
      }
      if (parameters?.task !== undefined && owner === null) {
        return errorResponse(id, TASK_OWNER_REQUIRED);
      }
      this.activeCalls += 1;
      this.clearIdleTimer();
      try {
        const executeCall = async (): Promise<{
          response: JsonRecord;
          outcome: ToolCallOutcome;
        }> => {
          const backend = await this.ensureStarted();
          const response = await this.sendRawRequest(
            backend,
            "tools/call",
            parameters,
            id,
            sessionId,
            this.toolCallTimeoutMs,
            owner,
            signal
          );
          const resultObject = isRecord(response.result)
            ? response.result
            : null;
          const outcome: ToolCallOutcome =
            response.error || resultObject?.isError === true
              ? { status: "error", errorType: "tool_error" }
              : { status: "ok" };
          return { response, outcome };
        };

        let callResult: JsonRecord | undefined;
        const runCall = async (): Promise<ToolCallOutcome> => {
          const { response, outcome } = await executeCall();
          callResult = response;
          return outcome;
        };
        try {
          const telemetry = await loadSharedTelemetry().catch(() => null);
          await this.observedToolCall(toolName, correlation, () =>
            telemetry
              ? telemetry.recordToolCallSpan(
                  `${this.name}__${toolName}`,
                  runCall,
                  parameters?._meta,
                  correlation
                )
              : runCall()
          );
        } catch (error) {
          return errorResponse(
            id,
            error instanceof Error ? error.message : "External MCP call failed"
          );
        }
        return (
          callResult ?? errorResponse(id, "External MCP call returned no reply")
        );
      } finally {
        this.activeCalls = Math.max(0, this.activeCalls - 1);
        this.armIdleTimer();
      }
    }

    // tasks/* methods forwarded to the warm backend, each confined to the
    // tasks its caller created.
    if (owner === null) return errorResponse(id, TASK_OWNER_REQUIRED);
    const named =
      isRecord(message.params) && typeof message.params.taskId === "string"
        ? message.params.taskId
        : undefined;
    if (method !== "tasks/list") {
      this.pruneTaskPins();
      // Not found, whether it never existed or belongs to someone else.
      if (named === undefined || this.taskPins.get(named)?.owner !== owner)
        return errorResponse(id, "Task not found");
    }
    this.activeCalls += 1;
    this.clearIdleTimer();
    try {
      const backend = await this.ensureStarted();
      const response = await this.sendRawRequest(
        backend,
        method,
        message.params,
        id,
        sessionId,
        this.requestTimeoutMs,
        owner,
        signal
      );
      return method === "tasks/list"
        ? this.ownedTaskList(response, owner, id)
        : response;
    } catch (error) {
      return errorResponse(
        id,
        error instanceof Error ? error.message : "External MCP request failed"
      );
    } finally {
      this.activeCalls = Math.max(0, this.activeCalls - 1);
      this.armIdleTimer();
    }
  }

  async close(): Promise<void> {
    this.closing = true;
    this.clearIdleTimer();
    for (const sessionId of [...this.sessions.keys()]) {
      this.deleteSession(sessionId);
    }
    for (const entry of this.pending.values()) {
      this.removePending(entry);
      entry.reject(new Error("Backend pool shutting down"));
    }
    const starting = this.starting;
    if (starting) {
      await starting.catch(() => {});
    }
    const backend = this.live;
    this.live = null;
    if (!backend) {
      return;
    }

    this.forgetBackendTasks(backend);
    await backend.close().catch(() => {});
  }
}

const DEFAULT_MAX_CONVERSATIONS = 32;
const TASK_OWNER_REQUIRED =
  "MCP tasks belong to one conversation or session, and this request carries neither";

/**
Who owns the tasks a request creates or names: the ChatGPT conversation when
the platform supplies one, otherwise the MCP session the request arrived on.
*/
function taskOwner(
  parameters: unknown,
  sessionId: string | null
): string | null {
  const conversation = isRecord(parameters)
    ? chatgptConversationKey(parameters._meta)
    : null;
  if (conversation) return `conversation:${conversation}`;
  return sessionId ? `session:${sessionId}` : null;
}
const MAX_CONVERSATION_IDENTITY_LENGTH = 512;
/**
The platform-supplied conversation identity ChatGPT attaches to every tool
call: "an anonymized conversation id you can use to correlate requests within
a ChatGPT session" (Apps SDK changelog). It travels in request metadata the
client sets, never in tool arguments the model writes.
*/
const CHATGPT_CONVERSATION_META_KEY = "openai/session";

/**
The digest a conversation is known by inside AutoDev.

The raw identifier never reaches a process argument, environment or log.
*/
function chatgptConversationKey(meta: unknown): string | null {
  if (!isRecord(meta)) return null;
  const identity = meta[CHATGPT_CONVERSATION_META_KEY];
  if (
    typeof identity !== "string" ||
    !identity.trim() ||
    identity.length > MAX_CONVERSATION_IDENTITY_LENGTH
  )
    return null;
  return createHash("sha256")
    .update(identity.trim())
    .digest("hex")
    .slice(0, 24);
}

type ConversationScopedSpec = Extract<PooledBackendSpec, { kind: "stdio" }> & {
  readonly conversationScopedEnv: string;
  readonly env: Record<string, string>;
};

/**
Where one tool call or task request runs: the backend scope it belongs to, how
to start that scope's backend, who owns the tasks it creates, and the request
as the backend should see it. A string is the refusal sent instead.
*/
type ScopeResolution =
  | string
  | {
      readonly key: string;
      readonly spec: () => PooledBackendSpec;
      readonly owner?: string;
      /**
      The verified admission facts the call's span carries.
      */
      readonly correlation?: McpToolCallCorrelation;
      readonly message: JsonRecord;
    };

/**
A server whose tool calls and MCP task requests each run in a backend of
their own scope -- one ChatGPT conversation (the XACPX delegation
coordinator), or one admitted workspace (and, for delegation, session).
Discovery -- `initialize`, `tools/list` and the logical sessions that carry
them -- is answered by one catalogue backend. Scoped backends start lazily and
are reaped like any pooled backend; scopes beyond the retention bound evict
the least recently used idle one.
*/
class ScopedController {
  private readonly options: ChatgptBackendPoolOptions;
  private readonly maxScopes: number;
  private readonly catalogue: PooledBackendController;
  private readonly scopes = new Map<string, PooledBackendController>();
  private readonly resolve: (message: JsonRecord) => ScopeResolution;
  readonly name: string;

  constructor(
    name: string,
    catalogueSpec: PooledBackendSpec,
    resolve: (message: JsonRecord) => ScopeResolution,
    options: ChatgptBackendPoolOptions,
    catalogueDiscovery?: ControllerDiscoveryOptions
  ) {
    this.name = name;
    this.resolve = resolve;
    this.options = options;
    this.maxScopes = options.maxConversations ?? DEFAULT_MAX_CONVERSATIONS;
    this.catalogue = new PooledBackendController(
      name,
      catalogueSpec,
      options,
      catalogueDiscovery
    );
  }

  private scope(
    key: string,
    spec: () => PooledBackendSpec
  ): PooledBackendController | null {
    const existing = this.scopes.get(key);
    if (existing) {
      // Map order is recency order.
      this.scopes.delete(key);
      this.scopes.set(key, existing);
      return existing;
    }
    if (this.scopes.size >= this.maxScopes) {
      const idle = this.scopes
        .entries()
        .find(([, controller]) => !controller.busy());
      if (!idle) return null;
      this.scopes.delete(idle[0]);
      void idle[1].close();
    }
    const controller = new PooledBackendController(
      this.name,
      spec(),
      this.options
    );
    this.scopes.set(key, controller);
    return controller;
  }

  createSession(): LogicalSession {
    return this.catalogue.createSession();
  }

  getSession(sessionId: string): LogicalSession | undefined {
    return this.catalogue.getSession(sessionId);
  }

  deleteSession(sessionId: string): void {
    this.catalogue.deleteSession(sessionId);
  }

  attachSse(session: LogicalSession, response: ServerResponse): void {
    this.catalogue.attachSse(session, response);
  }

  async handleRequest(
    message: JsonRecord,
    sessionId: string | null,
    signal?: AbortSignal
  ): Promise<JsonRecord | null> {
    const method = message.method;
    if (method === "notifications/cancelled") {
      // Resolve the same scope and owner as the original invocation.
      // A cancellation never provisions a new backend or searches unrelated
      // scopes. Missing/expired grants and ambiguous identities fail closed.
      const resolution = this.resolve(message);
      if (!sessionId || typeof resolution === "string") return null;
      const owner =
        resolution.owner ?? taskOwner(resolution.message.params, sessionId);
      if (owner === null) return null;
      await this.scopes
        .get(resolution.key)
        ?.handleRequest(resolution.message, sessionId, signal, owner);
      return null;
    }
    if (
      typeof method !== "string" ||
      (method !== "tools/call" && !method.startsWith("tasks/"))
    )
      return this.catalogue.handleRequest(message, sessionId, signal);
    const rawId = message.id;
    const id =
      typeof rawId === "string" || typeof rawId === "number" ? rawId : null;
    if (signal?.aborted)
      return id === null
        ? null
        : errorResponse(id, "External MCP request cancelled");
    const resolution = this.resolve(message);
    if (typeof resolution === "string")
      return id === null ? null : errorResponse(id, resolution);
    const controller = this.scope(resolution.key, resolution.spec);
    if (!controller)
      return id === null
        ? null
        : errorResponse(
            id,
            `${this.name} is busy in ${this.maxScopes} other scopes; retry when one finishes.`
          );
    return controller.handleRequest(
      resolution.message,
      sessionId,
      signal,
      resolution.owner,
      resolution.correlation
    );
  }

  stats() {
    const catalogue = this.catalogue.stats();
    const scopes = this.scopes
      .values()
      .map((controller) => controller.stats())
      .toArray();
    return {
      ...catalogue,
      running: catalogue.running || scopes.some((scope) => scope.running),
      spawns: scopes.reduce(
        (total, scope) => total + scope.spawns,
        catalogue.spawns
      ),
      activeCalls: scopes.reduce(
        (total, scope) => total + scope.activeCalls,
        0
      ),
      retainedTasks: scopes.reduce(
        (total, scope) => total + scope.retainedTasks,
        catalogue.retainedTasks
      ),
      uncertainTaskCreation:
        catalogue.uncertainTaskCreation ||
        scopes.some((scope) => scope.uncertainTaskCreation),
      conversations: scopes.length
    };
  }

  async close(): Promise<void> {
    await Promise.all([
      this.catalogue.close(),
      ...this.scopes.values().map((controller) => controller.close())
    ]);
    this.scopes.clear();
  }
}

// One backend per ChatGPT conversation, named by its digest.
function conversationScoped(
  name: string,
  spec: ConversationScopedSpec,
  options: ChatgptBackendPoolOptions
): ScopedController {
  const scoped = (scope: string): PooledBackendSpec => {
    const variable = spec.conversationScopedEnv;
    return {
      ...spec,
      env: { ...spec.env, [variable]: `${spec.env[variable] ?? ""}:${scope}` }
    };
  };
  return new ScopedController(
    name,
    scoped("catalogue"),
    (message) => {
      const key = chatgptConversationKey(
        isRecord(message.params) ? message.params._meta : undefined
      );
      return key
        ? { key, spec: () => scoped(`conversation-${key}`), message }
        : `${name} acts for one ChatGPT conversation, and this request carries no conversation identity (_meta "${CHATGPT_CONVERSATION_META_KEY}").`;
    },
    options
  );
}

// One backend per admitted workspace -- and, for delegation, per session --
// started in that workspace from the grant every request carries.
function admitted(
  name: string,
  spec: AdmittedBackendSpec,
  options: ChatgptBackendPoolOptions,
  discoveryCache: CatalogueDiscoveryCache
): ScopedController {
  const admission = options.admission;
  if (!admission)
    throw new Error(`${name} needs gateway admission, which is not configured`);
  const provisioned = (
    workspace: string,
    session?: string
  ): PooledBackendSpec => ({
    kind: "stdio",
    tools: spec.tools,
    ...admission.provision(spec.server, spec.role, workspace, session)
  });
  return new ScopedController(
    name,
    provisioned(admission.catalogueWorkspace),
    (message) => {
      const parameters = isRecord(message.params) ? message.params : {};
      const meta = isRecord(parameters._meta) ? parameters._meta : {};
      const claims = verifySessionGrant(
        admission.secret,
        meta[SESSION_GRANT_META_KEY]
      );
      if (!claims)
        return `${name} needs a valid AutoDev session grant (_meta "${SESSION_GRANT_META_KEY}").`;
      if (claims.role !== spec.role)
        return `This session's grant is for the ${claims.role} role, not ${spec.role}.`;
      // The grant never reaches the backend.
      const { [SESSION_GRANT_META_KEY]: _grant, ...forwardedMeta } = meta;
      const isPerSession = spec.server === MCP_SERVER_XACPX;
      return {
        key: JSON.stringify([
          claims.workspace,
          isPerSession ? claims.session : null
        ]),
        spec: () =>
          provisioned(
            claims.workspace,
            isPerSession ? claims.session : undefined
          ),
        owner: `grant:${claims.session}`,
        correlation: {
          server: spec.server,
          role: claims.role,
          // A bounded label, never the workspace path.
          workspace: path.basename(claims.workspace),
          sessionId: claims.runtimeSession ? claims.session : null
        },
        message: { ...message, params: { ...parameters, _meta: forwardedMeta } }
      };
    },
    options,
    { cache: discoveryCache, shareDiscovery: true }
  );
}

type BackendRoute = PooledBackendController | ScopedController;

function backendRoute(
  name: string,
  spec: PooledBackendSpec | AdmittedBackendSpec,
  options: ChatgptBackendPoolOptions,
  discoveryCache: CatalogueDiscoveryCache
): BackendRoute {
  if (spec.kind === "admitted")
    return admitted(name, spec, options, discoveryCache);
  return spec.kind === "stdio" && spec.conversationScopedEnv !== undefined
    ? conversationScoped(name, spec as ConversationScopedSpec, options)
    : new PooledBackendController(name, spec, options, {
        cache: discoveryCache,
        shareDiscovery: spec.kind === "remote" && name.startsWith("local.")
      });
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > MAX_BODY_BYTES) {
      throw new Error("Request body exceeds limit");
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/**
Start the loopback pooled MCP backend HTTP server consumed by Supergateway.
Each configured server is mounted at `/mcp/<serverName>` and authenticated
with a freshly minted 256-bit Bearer token.
*/
export async function startChatgptBackendPool(
  rawConfig: ChatgptBackendPoolConfig,
  options: ChatgptBackendPoolOptions
): Promise<ChatgptBackendPoolHandle> {
  const config = chatgptBackendPoolConfigSchema.parse(rawConfig);
  const token = options.token?.trim() || randomBytes(32).toString("hex");
  const discoveryCache = new CatalogueDiscoveryCache();
  const controllers = new Map<string, BackendRoute>();
  for (const [name, spec] of Object.entries(config.servers)) {
    controllers.set(name, backendRoute(name, spec, options, discoveryCache));
  }

  const server = createServer((request, res) => {
    void (async () => {
      if (!timingSafeBearerMatch(request.headers.authorization, token)) {
        res.writeHead(401, { "content-type": "application/json" }).end(
          JSON.stringify({
            jsonrpc: "2.0",
            error: { code: -32_000, message: "Unauthorized" },
            id: null
          })
        );
        return;
      }

      const parsedUrl = new URL(request.url ?? "/", "http://127.0.0.1");
      if (parsedUrl.pathname === "/readyz" && request.method === "GET") {
        res.writeHead(200, { "content-type": "text/plain" }).end("ok\n");
        return;
      }

      const match = /^\/mcp\/([a-zA-Z0-9_.-]+)$/u.exec(parsedUrl.pathname);
      const controller = match?.[1] ? controllers.get(match[1]) : undefined;
      if (!controller) {
        res.writeHead(404, { "content-type": "application/json" }).end(
          JSON.stringify({
            jsonrpc: "2.0",
            error: { code: -32_001, message: "Unknown MCP backend" },
            id: null
          })
        );
        return;
      }

      const rawSessionId = request.headers["mcp-session-id"];
      const sessionIdHeader =
        typeof rawSessionId === "string" && rawSessionId.trim()
          ? rawSessionId.trim()
          : null;

      if (request.method === "DELETE") {
        if (sessionIdHeader) controller.deleteSession(sessionIdHeader);
        res.writeHead(204).end();
        return;
      }

      if (request.method === "GET") {
        if (!sessionIdHeader) {
          res.writeHead(400).end("Missing Mcp-Session-Id");
          return;
        }
        const session = controller.getSession(sessionIdHeader);
        if (!session) {
          res.writeHead(404).end("Session not found");
          return;
        }
        controller.attachSse(session, res);
        return;
      }

      if (request.method !== "POST") {
        res.writeHead(405).end("Method not allowed");
        return;
      }

      let payload: unknown;
      try {
        const text = await readBody(request);
        payload = JSON.parse(text);
      } catch {
        res.writeHead(400, { "content-type": "application/json" }).end(
          JSON.stringify({
            jsonrpc: "2.0",
            error: { code: -32_700, message: "Parse error" },
            id: null
          })
        );
        return;
      }

      const isBatch = Array.isArray(payload);
      const rawMessages: unknown[] = Array.isArray(payload)
        ? payload
        : [payload];
      if (rawMessages.length === 0 || !rawMessages.every(isRecord)) {
        res.writeHead(400, { "content-type": "application/json" }).end(
          JSON.stringify({
            jsonrpc: "2.0",
            error: { code: -32_600, message: "Invalid JSON-RPC payload" },
            id: null
          })
        );
        return;
      }
      const messages: JsonRecord[] = rawMessages;

      const hasInitialize = messages.some(
        (message) => message.method === "initialize"
      );
      let session: LogicalSession | undefined;
      if (sessionIdHeader) {
        session = controller.getSession(sessionIdHeader);
        if (!session) {
          res.writeHead(404, { "content-type": "application/json" }).end(
            JSON.stringify({
              jsonrpc: "2.0",
              error: { code: -32_001, message: "Session not found" },
              id: null
            })
          );
          return;
        }
      } else if (hasInitialize) {
        session = controller.createSession();
      } else {
        res.writeHead(400, { "content-type": "application/json" }).end(
          JSON.stringify({
            jsonrpc: "2.0",
            error: { code: -32_000, message: "Missing Mcp-Session-Id" },
            id: null
          })
        );
        return;
      }

      // The HTTP response owns this invocation, not the session's SSE
      // stream or another request with the same client JSON-RPC ID.
      const invocation = new AbortController();
      const onClose = () => {
        if (!res.writableFinished) invocation.abort();
      };
      res.once("close", onClose);
      if (res.destroyed) invocation.abort();
      const responses: JsonRecord[] = [];
      try {
        for (const message of messages) {
          if (invocation.signal.aborted) break;
          // Sequential per-POST message ordering matches JSON-RPC batch semantics.
          // eslint-disable-next-line no-await-in-loop -- preserve message order within one POST batch
          const reply = await controller.handleRequest(
            message,
            session.id,
            invocation.signal
          );
          if (reply) responses.push(reply);
        }
      } finally {
        res.off("close", onClose);
      }
      if (invocation.signal.aborted) {
        if (hasInitialize) controller.deleteSession(session.id);
        return;
      }

      // If initialization failed, do not retain an uninitialized session entry.
      if (hasInitialize && responses.some((reply) => reply.error)) {
        controller.deleteSession(session.id);
      }

      if (responses.length === 0) {
        res.writeHead(202, { "mcp-session-id": session.id }).end();
        return;
      }

      const body = isBatch ? responses : responses[0];
      res
        .writeHead(200, {
          "content-type": "application/json",
          "mcp-session-id": session.id
        })
        .end(JSON.stringify(body));
    })().catch(() => {
      if (!res.headersSent) {
        res.writeHead(500, { "content-type": "application/json" }).end(
          JSON.stringify({
            jsonrpc: "2.0",
            error: { code: -32_603, message: "Internal backend pool error" },
            id: null
          })
        );
      }
    });
  });

  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("Failed to bind loopback MCP backend pool");
  }

  return {
    port: address.port,
    token,
    server,
    stats: () =>
      Object.fromEntries(
        Array.from(controllers, ([name, ctrl]) => [name, ctrl.stats()])
      ),
    close: async () => {
      const serverClosed = new Promise<void>((resolve) =>
        server.close(() => resolve())
      );
      server.closeAllConnections();
      await serverClosed;
      await Promise.all(
        Array.from(controllers.values(), (controller) => controller.close())
      );
      if (sharedTelemetryPromise) {
        await Promise.race([
          sharedTelemetryPromise.then(
            // The pool does not own the process's telemetry: deliver its
            // spans, leaving the provider to whatever outlives the pool.
            (module_) => module_.flushTelemetry(),
            () => {}
          ),
          new Promise<void>((resolve) => setTimeout(resolve, 400).unref())
        ]);
      }
    }
  };
}
