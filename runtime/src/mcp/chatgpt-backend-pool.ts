/**
 * Loopback pooled MCP backend host for Supergateway Streamable HTTP ingress.
 *
 * External clients such as ChatGPT often open a fresh Streamable HTTP session
 * (`initialize` -> `notifications/initialized` -> single `tools/call`) for
 * every tool invocation without ever reusing `Mcp-Session-Id` or sending
 * `DELETE`. Letting Supergateway spawn a fresh stdio tree per session × per
 * backend multiplies Node/Python processes linearly with every tool call and
 * exhausts host memory.
 *
 * This host sits strictly on loopback (`127.0.0.1:<ephemeral>`, per-generation
 * Bearer token) behind Supergateway's native `streamableHttp` combined
 * upstreams:
 * - Supergateway retains Streamable HTTP transport, `Mcp-Session-Id` isolation,
 *   external Bearer auth, `/readyz`, `toolPrefix` namespacing, combining, and
 *   session expiry.
 * - Each configured backend runs at most ONE confined local process (or one
 *   remote Streamable HTTP transport), started lazily on demand with
 *   single-flight coalescing, idle-reaped when unused, and cleaned up by full
 *   POSIX process group so wrapper launchers never orphan grandchildren.
 * - `initialize` and `tools/list` answers are cached per backend (invalidated
 *   on `notifications/tools/list_changed` or backend exit), so repeated
 *   one-shot sessions complete handshakes in milliseconds without waking idle
 *   backends.
 * - Role allowlists, capability filtering, truthful tool annotations,
 *   per-request deadlines, secret isolation, and lazy OpenTelemetry spans are
 *   enforced uniformly at this boundary.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { once } from "node:events";
import { existsSync, readFileSync } from "node:fs";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse
} from "node:http";
import { createConnection } from "node:net";
import path from "node:path";
import { createInterface, type Interface } from "node:readline";

import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { isRecord } from "@simulatorlife/autodev-core";
import { z } from "zod";

import { isEntryPoint } from "../shared/entry-point.ts";
import {
  KEYCHAIN_SECRET_NAMES,
  readRuntimeSecret
} from "../shared/runtime-secrets.ts";
import {
  MCP_SERVER_COCOINDEX,
  MCP_SERVER_FILESYSTEM
} from "../shared/tool-names.ts";
import type { ToolCallOutcome } from "./mcp-telemetry.ts";
import {
  errorResponse,
  type RemoteBackendSpec,
  resolveRemoteMcpHeaders
} from "./tool-filter.ts";

type JsonRecord = Record<string, unknown>;
type JsonRpcId = string | number;

const identifier = z.string().regex(/^[a-zA-Z0-9_.-]+$/u);
const toolIdentifier = z.string().regex(/^[a-zA-Z0-9_.-]+$/u);

export const CHATGPT_MCP_POOL_PORT_ENV = "AUTODEV_MCP_POOL_PORT";
export const CHATGPT_MCP_POOL_TOKEN_ENV = "AUTODEV_MCP_POOL_TOKEN";
export const DEFAULT_BACKEND_IDLE_TIMEOUT_MS = 180_000;
const REQUEST_TIMEOUT_MS = 15_000;
const TOOL_CALL_TIMEOUT_MS = 60_000;
const MAX_BODY_BYTES = 16 * 1024 * 1024;
const MAX_SESSIONS_PER_SERVER = 256;
const PROCESS_KILL_GRACE_MS = 5_000;

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
     * The canonical MCP server this backend serves. The pool key may be
     * role-qualified, but the server identity decides the confinement and
     * sandbox rules the backend runs under.
     */
    server: z.string().min(1),
    command: z.string().min(1),
    args: z.array(z.string()),
    cwd: z.string().min(1),
    tools: z.array(toolIdentifier).min(1),
    /**
     * Role-scoped environment for this backend. It is applied on top of the
     * shared gateway environment so one pooled backend per role can enforce
     * that role's own permissions.
     */
    env: z.record(z.string(), z.string()).optional()
  })
  .strict();

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

export const chatgptBackendPoolConfigSchema = z
  .object({
    version: z.literal(1),
    servers: z.record(
      identifier,
      z.discriminatedUnion("kind", [
        pooledLocalBackendSchema,
        pooledRemoteBackendSchema
      ])
    )
  })
  .strict();

export type PooledBackendSpec = z.infer<
  typeof chatgptBackendPoolConfigSchema
>["servers"][string];
export type ChatgptBackendPoolConfig = z.infer<
  typeof chatgptBackendPoolConfigSchema
>;

export interface ChatgptBackendPoolOptions {
  /** Base clean environment inherited by local backends (never contains tunnel/remote secrets). */
  readonly gatewayEnv: Record<string, string>;
  /** Host environment used solely for resolving per-remote-server credentials in memory. */
  readonly secretEnv?: NodeJS.ProcessEnv;
  /** Optional pre-generated Bearer token; defaults to a freshly minted 256-bit token. */
  readonly token?: string;
  /** Idle duration before an unused local backend process is gracefully reaped. */
  readonly idleTimeoutMs?: number;
  /** Maximum duration for an individual `tools/call` before timing out. */
  readonly toolCallTimeoutMs?: number;
  /** Maximum duration for initialize/list/ping requests. */
  readonly requestTimeoutMs?: number;
}

export interface ChatgptBackendPoolHandle {
  readonly port: number;
  readonly token: string;
  readonly server: Server;
  /** Active backend process/transport metrics for diagnostics and tests. */
  stats(): Record<
    string,
    {
      running: boolean;
      spawns: number;
      activeCalls: number;
      sessions: number;
      cachedTools: boolean;
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
  readonly timer: NodeJS.Timeout;
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
  const actualBuf = Buffer.from(header, "utf8");
  const expectedBuf = Buffer.from(expected, "utf8");
  if (actualBuf.length !== expectedBuf.length) return false;
  return timingSafeEqual(actualBuf, expectedBuf);
}

/** Terminate a spawned process and its entire POSIX process group so wrappers never orphan children. */
export function signalProcessTree(
  child: ChildProcess,
  signal: NodeJS.Signals
): void {
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform !== "win32" && typeof child.pid === "number") {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      /* Fall back to direct child signal if group already exited or differs. */
    }
  }
  try {
    child.kill(signal);
  } catch {
    /* Already exited. */
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
  if (!exited && child.exitCode === null && child.signalCode === null) {
    signalProcessTree(child, "SIGKILL");
    await Promise.race([
      once(child, "exit").catch(() => {}),
      new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 1000);
        timer.unref();
      })
    ]);
  }
}

/** Check whether a live host CocoIndex daemon is already listening on its Unix socket. */
async function isUnixSocketListening(
  socketPath: string,
  timeoutMs = 250
): Promise<boolean> {
  if (!existsSync(socketPath)) return false;
  return new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (ok: boolean): void => {
      if (settled) return;
      settled = true;
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
    sharedTelemetryPromise = import("./mcp-telemetry.ts").then((mod) => {
      const token = readRuntimeSecret("OPENLIT_OTLP_API_KEY");
      try {
        mod.configureExternalMcpTelemetry(
          "pooled",
          "http://127.0.0.1:4318/v1/traces",
          token ? { Authorization: `Bearer ${token}` } : {}
        );
      } catch {
        /* Telemetry may already be initialized in the same process (e.g. tests). */
      }
      return mod;
    });
  }
  return sharedTelemetryPromise;
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
  private readonly sessions = new Map<string, LogicalSession>();

  constructor(
    name: string,
    spec: PooledBackendSpec,
    options: ChatgptBackendPoolOptions
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
  }

  stats() {
    return {
      running: this.live !== null,
      spawns: this.spawns,
      activeCalls: this.activeCalls,
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
        /* ignore closed socket */
      }
    }
  }

  attachSse(session: LogicalSession, res: ServerResponse): void {
    if (session.sse && !session.sse.writableEnded) {
      try {
        session.sse.end();
      } catch {
        /* replace prior stream */
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

  private broadcastNotification(message: JsonRecord): void {
    const payload = `event: message\ndata: ${JSON.stringify(message)}\n\n`;
    for (const session of this.sessions.values()) {
      const sse = session.sse;
      if (!sse || sse.writableEnded || sse.destroyed) continue;
      try {
        sse.write(payload);
      } catch {
        session.sse = undefined;
      }
    }
  }

  private clearIdleTimer(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
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
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      if (
        this.closing ||
        !this.live ||
        this.activeCalls > 0 ||
        this.pending.size > 0
      ) {
        return;
      }
      const backend = this.live;
      this.live = null;
      // Preserve cachedInitialize and cachedTools across idle reaps so
      // future discovery-only sessions never wake an unused backend.
      void backend.close().catch(() => {});
    }, this.idleTimeoutMs);
    this.idleTimer.unref();
  }

  private handleBackendMessage(message: JsonRecord | null): void {
    if (!message) return;
    const rawId = message.id;
    const id =
      typeof rawId === "string" || typeof rawId === "number" ? rawId : null;
    if (typeof message.method === "string") {
      if (id !== null) {
        this.live?.send(
          errorResponse(id, "MCP client capability is not externally approved")
        );
        return;
      }
      if (message.method === "notifications/tools/list_changed") {
        this.cachedTools = null;
        this.broadcastNotification(message);
      } else if (message.method === "notifications/progress") {
        this.broadcastNotification(message);
      }
      return;
    }
    if (id === null) return;
    const key = String(id);
    const pending = this.pending.get(key);
    if (!pending) return;
    this.pending.delete(key);
    clearTimeout(pending.timer);
    if (pending.cancelled) {
      this.armIdleTimer();
      return;
    }
    pending.resolve({ ...message, id: pending.clientId });
    this.armIdleTimer();
  }

  private handleBackendExit(backend: LiveBackend, reason: string): void {
    if (this.live === backend) {
      this.live = null;
      this.clearIdleTimer();
      // Unexpected exit invalidates cached discovery so recovery/failure semantics stay truthful.
      this.cachedInitialize = null;
      this.cachedTools = null;
    }
    for (const [key, entry] of [...this.pending.entries()]) {
      if (entry.backend !== backend) continue;
      this.pending.delete(key);
      clearTimeout(entry.timer);
      entry.reject(new Error(reason));
    }
  }

  private async buildLocalChildEnv(): Promise<NodeJS.ProcessEnv> {
    if (this.spec.kind !== "stdio") return {};
    const sandboxed = this.spec.command === "/usr/bin/sandbox-exec";
    const server = this.spec.server;
    if (sandboxed && server === MCP_SERVER_FILESYSTEM) {
      return {
        HOME: this.spec.cwd,
        PATH: "/usr/bin:/bin",
        LANG: "en_US.UTF-8",
        ...(this.spec.env ?? {})
      };
    }
    let cocoindexSupervised = false;
    if (sandboxed && server === MCP_SERVER_COCOINDEX) {
      const homeDir = this.gatewayEnv.HOME;
      if (homeDir) {
        const daemonSock = path.join(homeDir, ".cocoindex_code", "daemon.sock");
        // Never allow a Seatbelt-jailed `ccc mcp` to hijack or duplicate an
        // already-running host `ccc run-daemon` (each daemon loads a ~1.4 GB
        // embedding worker and a jailed daemon fails other workspaces with EPERM).
        cocoindexSupervised = await isUnixSocketListening(daemonSock);
      }
    }
    const childEnv: NodeJS.ProcessEnv = {
      ...(sandboxed && server === MCP_SERVER_COCOINDEX
        ? {
            HF_HUB_OFFLINE: "1",
            TRANSFORMERS_OFFLINE: "1",
            ...(cocoindexSupervised
              ? { COCOINDEX_CODE_DAEMON_SUPERVISED: "1" }
              : {})
          }
        : {}),
      ...this.gatewayEnv,
      // The role-scoped environment is applied last so one role's identity and
      // coordinator always win over the gateway's shared defaults.
      ...(this.spec.env ?? {})
    };
    for (const secretName of [
      ...KEYCHAIN_SECRET_NAMES,
      "OPENAI_ADMIN_KEY",
      "OPENLIT_OTLP_API_KEY",
      CHATGPT_MCP_POOL_TOKEN_ENV,
      CHATGPT_MCP_POOL_PORT_ENV
    ]) {
      delete childEnv[secretName];
    }
    return childEnv;
  }

  private async spawnLiveBackend(): Promise<LiveBackend> {
    this.spawns += 1;
    if (this.spec.kind === "remote") {
      const remoteSpec: RemoteBackendSpec = {
        url: this.spec.url,
        ...(this.spec.bearer_token_env_var
          ? { bearer_token_env_var: this.spec.bearer_token_env_var }
          : {}),
        ...(this.spec.http_headers
          ? { http_headers: this.spec.http_headers }
          : {})
      };
      const headers = resolveRemoteMcpHeaders(
        remoteSpec,
        this.name,
        this.secretEnv
      );
      const { StreamableHTTPClientTransport } =
        await import("@modelcontextprotocol/sdk/client/streamableHttp.js");
      const transport = new StreamableHTTPClientTransport(
        new URL(remoteSpec.url),
        { requestInit: { headers } }
      );
      let closed = false;
      let sendChain: Promise<void> = Promise.resolve();
      const live: LiveBackend = {
        setProtocolVersion: (version) => {
          transport.setProtocolVersion(version);
        },
        send: (message) => {
          if (closed) return;
          sendChain = sendChain.then(async () => {
            if (closed) return;
            try {
              await transport.send(message as unknown as JSONRPCMessage);
            } catch (error) {
              const id =
                typeof message.id === "string" || typeof message.id === "number"
                  ? String(message.id)
                  : null;
              if (id) {
                const entry = this.pending.get(id);
                if (entry) {
                  this.pending.delete(id);
                  clearTimeout(entry.timer);
                  entry.resolve(
                    errorResponse(
                      entry.clientId,
                      error instanceof Error
                        ? error.message
                        : "Remote MCP request failed"
                    )
                  );
                }
              }
            }
          });
        },
        close: async () => {
          if (closed) return;
          closed = true;
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
        this.handleBackendMessage(message as unknown as JsonRecord);
      };
      transport.onerror = () => {
        /* Surface errors through pending requests rather than leaking URLs/headers. */
      };
      transport.onclose = () => {
        if (!closed) {
          closed = true;
          this.handleBackendExit(live, `Remote MCP "${this.name}" closed`);
        }
      };
      return live;
    }

    const childEnv = await this.buildLocalChildEnv();
    const child = spawn(this.spec.command, this.spec.args, {
      cwd: this.spec.cwd,
      env: childEnv,
      detached: process.platform !== "win32",
      stdio: ["pipe", "pipe", "pipe"]
    });
    const lines: Interface = createInterface({ input: child.stdout! });
    let closed = false;
    const live: LiveBackend = {
      send: (message) => {
        if (closed || !child.stdin || child.stdin.destroyed) return;
        child.stdin.write(`${JSON.stringify(message)}\n`);
      },
      close: async () => {
        if (closed) return;
        closed = true;
        lines.close();
        await stopProcessTree(child);
      },
      kill: () => {
        if (closed) return;
        closed = true;
        lines.close();
        signalProcessTree(child, "SIGKILL");
      }
    };
    lines.on("line", (line) => {
      this.handleBackendMessage(parseJson(line));
    });
    // Drain stderr without unbounded buffering so chatty servers never block on a full pipe.
    child.stderr?.resume();
    child.once("error", () => {
      if (!closed) {
        closed = true;
        lines.close();
        this.handleBackendExit(
          live,
          `External MCP backend "${this.name}" failed to start`
        );
      }
    });
    child.once("close", (code, signal) => {
      if (!closed) {
        closed = true;
        lines.close();
        this.handleBackendExit(
          live,
          `External MCP backend "${this.name}" exited (code=${code}, signal=${signal})`
        );
      }
    });
    return live;
  }

  private sendRawRequest(
    backend: LiveBackend,
    method: string,
    params: unknown,
    clientId: JsonRpcId,
    sessionId: string | null,
    timeoutMs: number
  ): Promise<JsonRecord> {
    const internalId = `pool:${++this.nextInternalId}`;
    return new Promise<JsonRecord>((resolve, reject) => {
      const timer = setTimeout(() => {
        const entry = this.pending.get(internalId);
        if (!entry) return;
        this.pending.delete(internalId);
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
        if (this.live === backend && this.pending.size === 0) {
          this.live = null;
          this.cachedInitialize = null;
          this.cachedTools = null;
          void backend.close().catch(() => {});
        }
      }, timeoutMs);
      timer.unref();
      this.pending.set(internalId, {
        backend,
        internalId,
        clientId,
        sessionId,
        method,
        timer,
        cancelled: false,
        resolve,
        reject
      });
      backend.send({
        jsonrpc: "2.0",
        id: internalId,
        method,
        ...(params !== undefined ? { params } : {})
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
            ...(isRecord(rawCaps.tasks) ? { tasks: rawCaps.tasks } : {})
          }
        };
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

  private async fetchFilteredTools(): Promise<unknown[]> {
    if (this.cachedTools !== null) return this.cachedTools;
    if (this.toolsRefreshInFlight) return this.toolsRefreshInFlight;
    const fetchPromise = (async (): Promise<unknown[]> => {
      const backend = await this.ensureStarted();
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
          for (const tool of resp.result.tools) {
            if (
              isRecord(tool) &&
              typeof tool.name === "string" &&
              this.allowed.has(tool.name)
            ) {
              collected.push(tool);
            }
          }
        }
        const next =
          typeof resp.result.nextCursor === "string"
            ? resp.result.nextCursor
            : undefined;
        if (!next || seenCursors.has(next)) break;
        seenCursors.add(next);
        cursor = next;
      } while (cursor);
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

  handleCancellation(sessionId: string, requestId: JsonRpcId): void {
    for (const entry of this.pending.values()) {
      if (entry.sessionId === sessionId && entry.clientId === requestId) {
        entry.cancelled = true;
        clearTimeout(entry.timer);
        this.live?.send({
          jsonrpc: "2.0",
          method: "notifications/cancelled",
          params: { requestId: entry.internalId }
        });
        entry.resolve(
          errorResponse(requestId, "External MCP request cancelled")
        );
        // Keep entry in `this.pending` briefly? No — removing immediately drops any late reply cleanly.
        this.pending.delete(entry.internalId);
        this.armIdleTimer();
      }
    }
  }

  async handleRequest(
    message: JsonRecord,
    sessionId: string | null
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
      if (sessionId && isRecord(message.params)) {
        const reqId = message.params.requestId;
        if (typeof reqId === "string" || typeof reqId === "number") {
          this.handleCancellation(sessionId, reqId);
        }
      }
      return null;
    }

    if (id === null) return null;

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
          await this.ensureStarted();
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

    if (method === "tools/call") {
      const params = isRecord(message.params) ? message.params : null;
      const toolName = params?.name;
      if (typeof toolName !== "string" || !this.allowed.has(toolName)) {
        return errorResponse(id, "Tool is not enabled for this role");
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
            params,
            id,
            sessionId,
            this.toolCallTimeoutMs
          );
          const resultObj = isRecord(response.result) ? response.result : null;
          const outcome: ToolCallOutcome =
            response.error || resultObj?.isError === true
              ? { status: "error", errorType: "tool_error" }
              : { status: "ok" };
          return { response, outcome };
        };

        let callResult: JsonRecord | undefined;
        try {
          const telemetry = await loadSharedTelemetry().catch(() => null);
          if (telemetry) {
            await telemetry.recordToolCallSpan(
              `${this.name}__${toolName}`,
              async () => {
                const { response, outcome } = await executeCall();
                callResult = response;
                return outcome;
              },
              params?._meta
            );
          } else {
            callResult = (await executeCall()).response;
          }
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

    // tasks/* methods forwarded to the warm backend
    this.activeCalls += 1;
    this.clearIdleTimer();
    try {
      const backend = await this.ensureStarted();
      return await this.sendRawRequest(
        backend,
        method,
        message.params,
        id,
        sessionId,
        this.requestTimeoutMs
      );
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
    for (const [key, entry] of [...this.pending.entries()]) {
      this.pending.delete(key);
      clearTimeout(entry.timer);
      entry.reject(new Error("Backend pool shutting down"));
    }
    const starting = this.starting;
    if (starting) {
      await starting.catch(() => {});
    }
    const backend = this.live;
    this.live = null;
    if (backend) {
      await backend.close().catch(() => {});
    }
  }
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buf.length;
    if (total > MAX_BODY_BYTES) {
      throw new Error("Request body exceeds limit");
    }
    chunks.push(buf);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * Start the loopback pooled MCP backend HTTP server consumed by Supergateway.
 * Each configured server is mounted at `/mcp/<serverName>` and authenticated
 * with a freshly minted 256-bit Bearer token.
 */
export async function startChatgptBackendPool(
  rawConfig: ChatgptBackendPoolConfig,
  options: ChatgptBackendPoolOptions
): Promise<ChatgptBackendPoolHandle> {
  const config = chatgptBackendPoolConfigSchema.parse(rawConfig);
  const token = options.token?.trim() || randomBytes(32).toString("hex");
  const controllers = new Map<string, PooledBackendController>();
  for (const [name, spec] of Object.entries(config.servers)) {
    controllers.set(name, new PooledBackendController(name, spec, options));
  }

  const server = createServer((req, res) => {
    void (async () => {
      if (!timingSafeBearerMatch(req.headers.authorization, token)) {
        res.writeHead(401, { "content-type": "application/json" }).end(
          JSON.stringify({
            jsonrpc: "2.0",
            error: { code: -32_000, message: "Unauthorized" },
            id: null
          })
        );
        return;
      }

      const parsedUrl = new URL(req.url ?? "/", "http://127.0.0.1");
      if (parsedUrl.pathname === "/readyz" && req.method === "GET") {
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

      const rawSessionId = req.headers["mcp-session-id"];
      const sessionIdHeader =
        typeof rawSessionId === "string" && rawSessionId.trim()
          ? rawSessionId.trim()
          : null;

      if (req.method === "DELETE") {
        if (sessionIdHeader) controller.deleteSession(sessionIdHeader);
        res.writeHead(204).end();
        return;
      }

      if (req.method === "GET") {
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

      if (req.method !== "POST") {
        res.writeHead(405).end("Method not allowed");
        return;
      }

      let payload: unknown;
      try {
        const text = await readBody(req);
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

      const hasInitialize = messages.some((msg) => msg.method === "initialize");
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

      const responses: JsonRecord[] = [];
      for (const msg of messages) {
        // Sequential per-POST message ordering matches JSON-RPC batch semantics.
        // eslint-disable-next-line no-await-in-loop -- preserve message order within one POST batch
        const reply = await controller.handleRequest(msg, session.id);
        if (reply) responses.push(reply);
      }

      // If initialization failed, do not retain an uninitialized session entry.
      if (hasInitialize && responses.some((reply) => Boolean(reply.error))) {
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
        [...controllers.entries()].map(([name, ctrl]) => [name, ctrl.stats()])
      ),
    close: async () => {
      const serverClosed = new Promise<void>((resolve) =>
        server.close(() => resolve())
      );
      server.closeAllConnections();
      await serverClosed;
      await Promise.all(
        [...controllers.values()].map((controller) => controller.close())
      );
      if (sharedTelemetryPromise) {
        await Promise.race([
          sharedTelemetryPromise.then(
            (mod) => mod.shutdownTelemetry(),
            () => {}
          ),
          new Promise<void>((resolve) => setTimeout(resolve, 400).unref())
        ]);
      }
    }
  };
}

if (isEntryPoint(import.meta.url)) {
  const configFile = process.argv[2];
  if (!configFile) {
    process.stderr.write("Expected backend-pool.json path\n");
    process.exit(2);
  }
  const token = process.env[CHATGPT_MCP_POOL_TOKEN_ENV]?.trim();
  if (!token) {
    process.stderr.write(`Missing ${CHATGPT_MCP_POOL_TOKEN_ENV}\n`);
    process.exit(2);
  }
  void (async () => {
    const rl = createInterface({ input: process.stdin });
    const firstLine = await new Promise<string>((resolve, reject) => {
      rl.once("line", resolve);
      rl.once("close", () => reject(new Error("Missing gatewayEnv handshake")));
    });
    const parsed = JSON.parse(firstLine) as {
      gatewayEnv?: Record<string, string>;
    };
    const gatewayEnv = parsed.gatewayEnv ?? {};
    const config = chatgptBackendPoolConfigSchema.parse(
      JSON.parse(readFileSync(configFile, "utf8"))
    );
    const pool = await startChatgptBackendPool(config, {
      gatewayEnv,
      secretEnv: process.env,
      token
    });
    process.stdout.write(`${JSON.stringify({ port: pool.port })}\n`);
    let closing = false;
    const shutdown = (): void => {
      if (closing) return;
      closing = true;
      rl.close();
      void pool.close().finally(() => process.exit(0));
    };
    rl.once("close", shutdown);
    process.once("SIGTERM", shutdown);
    process.once("SIGINT", shutdown);
  })().catch(() => {
    process.stderr.write("ChatGPT MCP backend pool failed to start\n");
    process.exit(1);
  });
}
