import { type ChildProcess, spawn } from "node:child_process";
import { timingSafeEqual } from "node:crypto";
import { chmod, lstat, realpath, stat } from "node:fs/promises";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse
} from "node:http";
import path from "node:path";

import { isPathWithin } from "@simulatorlife/autodev-data/files";
import { ExponentialBackoff, handleAll, retry } from "cockatiel";

import {
  createSerialQueue,
  type RouterGenerationEndpoint,
  type RouterIngress
} from "./ingress.ts";

const DEFAULT_WORKER_SHUTDOWN_TIMEOUT_MS = 60_000;
// A worker that served this long before crashing was healthy; its crash
// starts a fresh restart streak instead of extending a crash loop.
const WORKER_STABLE_MS = 60_000;
const MAX_CONSECUTIVE_CRASH_RESTARTS = 3;
const RESTART_ACTIVATION_RETRIES = 3;
const MAX_GENERATION_ID_LENGTH = 128;
const RESTART_SUFFIX_PATTERN = /\.restart-\d+$/u;

const WORKER_ENTRY_PATTERN = /\.[cm]?[jt]s$/u;
const GENERATION_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/u;
const STATUS_PATH = "/v1/status";
const GENERATIONS_PATH = "/v1/generations";
const ROLLBACK_PATH = "/v1/rollback";
const GENERATION_RETIREMENT_PATH_PATTERN =
  /^\/v1\/generations\/([a-zA-Z0-9._-]+)\/retirement$/u;

export interface RouterIngressSupervisorOptions {
  ingress: RouterIngress;
  controlSocket: string;
  controlToken: string;
  releasesDirectory: string;
  workerStartupTimeoutMs?: number;
  workerShutdownTimeoutMs?: number;
}

interface ActivationResult {
  activeGenerationId: string;
  retiringGenerationId: string | null;
}

class NoRollbackTargetError extends Error {}

/**
Private management server; never shares the public TCP listener.

It owns each worker process for its whole life: an active worker that exits
on its own is detected, the ingress stops routing to it, and its release is
restarted under a new generation ID (bounded, so a crash loop ends in an
explicit unavailable state rather than spinning). The generation that was
active before the current one stays retained as the rollback target.
*/
export class RouterIngressSupervisor {
  readonly controlServer: Server;
  private readonly ingress: RouterIngress;
  private readonly controlSocket: string;
  private readonly controlToken: Buffer;
  private readonly releasesDirectory: string;
  private readonly startupTimeoutMs: number;
  private readonly shutdownTimeoutMs: number;
  private readonly workers = new Map<string, ChildProcess>();
  private readonly stoppingWorkers = new WeakMap<ChildProcess, Promise<void>>();
  // Verified worker entry of the active and rollback generations only.
  private readonly releases = new Map<string, string>();
  private readonly lifetime = new AbortController();
  private readonly serialized = createSerialQueue();
  private rollbackGenerationId: string | null = null;
  private crashStreak = 0;
  private restartCount = 0;

  constructor(options: RouterIngressSupervisorOptions) {
    if (!options.controlToken || options.controlToken.length < 32) {
      throw new Error(
        "Ingress control requires a secret of at least 32 characters"
      );
    }
    if (
      !path.isAbsolute(options.controlSocket) ||
      !path.isAbsolute(options.releasesDirectory)
    ) {
      throw new Error(
        "Ingress control socket and releases directory must be absolute"
      );
    }
    this.ingress = options.ingress;
    this.controlSocket = options.controlSocket;
    this.controlToken = Buffer.from(options.controlToken);
    this.releasesDirectory = options.releasesDirectory;
    this.startupTimeoutMs = options.workerStartupTimeoutMs ?? 10_000;
    this.shutdownTimeoutMs =
      options.workerShutdownTimeoutMs ?? DEFAULT_WORKER_SHUTDOWN_TIMEOUT_MS;
    if (
      !Number.isInteger(this.shutdownTimeoutMs) ||
      this.shutdownTimeoutMs < 1 ||
      this.shutdownTimeoutMs > 2_147_483_647
    ) {
      throw new Error("Invalid ingress worker shutdown timeout");
    }
    this.controlServer = createServer((request, response) => {
      void this.handle(request, response).catch(() => {
        if (response.headersSent) {
          response.destroy();
        } else {
          this.json(response, 500, { error: "internal_error" });
        }
      });
    });
  }

  async listen(): Promise<void> {
    // The socket is reachable the moment it binds, before any chmod could
    // narrow it, so its directory must already exclude everyone else.
    await this.assertPrivateSocketDirectory();
    // Do not unlink an existing socket: it could belong to a running ingress.
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => {
        this.controlServer.off("listening", onListening);
        reject(error);
      };
      const onListening = () => {
        this.controlServer.off("error", onError);
        resolve();
      };
      this.controlServer.once("error", onError);
      this.controlServer.once("listening", onListening);
      this.controlServer.listen(this.controlSocket);
    });
    await chmod(this.controlSocket, 0o600);
  }

  private async assertPrivateSocketDirectory(): Promise<void> {
    const directory = await lstat(path.dirname(this.controlSocket));
    if (
      !directory.isDirectory() ||
      (directory.mode & 0o077) !== 0 ||
      directory.uid !== process.getuid?.()
    ) {
      throw new Error(
        "Ingress control socket directory must be a private (0700) directory owned by this user"
      );
    }
  }

  /**
  Explicit process teardown for tests and ingress shutdown. This is not
  called during generation cutover: retiring workers retain their admitted
  HTTP/SSE requests until completion or the ingress drain deadline.
  */
  async close(): Promise<void> {
    this.lifetime.abort();
    const workers = [...this.workers.values()];
    await Promise.all(workers.map((child) => this.stopWorker(child)));
    this.workers.clear();
    if (!this.controlServer.listening) {
      return;
    }

    this.controlServer.closeAllConnections();
    await new Promise<void>((resolve, reject) => {
      this.controlServer.close((error) => (error ? reject(error) : resolve()));
    });
  }

  private authorized(request: IncomingMessage): boolean {
    const authorization = request.headers.authorization;
    if (
      typeof authorization !== "string" ||
      !authorization.startsWith("Bearer ")
    )
      return false;
    const actual = Buffer.from(authorization.slice(7));
    return (
      actual.length === this.controlToken.length &&
      timingSafeEqual(actual, this.controlToken)
    );
  }

  private json(response: ServerResponse, status: number, body: unknown): void {
    response.writeHead(status, {
      "content-type": "application/json",
      "cache-control": "no-store"
    });
    response.end(JSON.stringify(body));
  }

  private async readBody(request: IncomingMessage): Promise<unknown> {
    const chunks: Buffer[] = [];
    let length = 0;
    for await (const chunk of request) {
      length += (chunk as Buffer).length;
      if (length > 4096) throw new Error("Request body too large");
      chunks.push(chunk as Buffer);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  }

  private async verifiedEntry(entry: string): Promise<string> {
    if (!path.isAbsolute(entry))
      throw new Error("Worker entry must be absolute");
    const [root, resolved] = await Promise.all([
      realpath(this.releasesDirectory),
      realpath(entry)
    ]);
    if (resolved === root || !isPathWithin(root, resolved)) {
      throw new Error(
        "Worker entry must be inside the immutable releases directory"
      );
    }
    const entryStat = await stat(resolved);
    if (!entryStat.isFile() || !WORKER_ENTRY_PATTERN.test(resolved)) {
      throw new Error("Worker entry must be a JavaScript or TypeScript file");
    }
    return resolved;
  }

  private spawnWorker(
    id: string,
    entry: string
  ): Promise<{
    child: ChildProcess;
    endpoint: RouterGenerationEndpoint;
  }> {
    return new Promise((resolve, reject) => {
      const environment: NodeJS.ProcessEnv = {
        ...process.env,
        CODEX_MODEL_ROUTER_HOST: "127.0.0.1",
        CODEX_MODEL_ROUTER_PORT: "0",
        AUTODEV_CONTROL_API_DISABLED: "1",
        AUTODEV_ROUTER_WORKER_GENERATION: id
      };
      delete environment.AUTODEV_ROUTER_INGRESS_CONTROL_TOKEN;
      const child = spawn(process.execPath, [entry], {
        env: environment,
        stdio: ["ignore", "inherit", "inherit", "ipc"]
      });
      let isSettled = false;
      const finish = (error?: Error, port?: number) => {
        if (isSettled) return;
        isSettled = true;
        clearTimeout(timer);
        child.off("error", onError);
        child.off("exit", onExit);
        child.off("message", onMessage);
        if (error || port === undefined) {
          if (child.exitCode === null) child.kill("SIGTERM");
          reject(error ?? new Error("Worker did not announce its listener"));
        } else {
          resolve({ child, endpoint: { id, host: "127.0.0.1", port } });
        }
      };
      const onError = (error: Error) => finish(error);
      const onExit = () =>
        finish(new Error("Worker exited before announcing its listener"));
      const onMessage = (message: unknown) => {
        if (!message || typeof message !== "object") return;
        const payload = message as Record<string, unknown>;
        if (
          payload.type === "autodev-router-worker-listening" &&
          payload.generationId === id &&
          typeof payload.port === "number" &&
          Number.isInteger(payload.port) &&
          payload.port > 0 &&
          payload.port <= 65_535
        ) {
          finish(undefined, payload.port);
        }
      };
      const timer = setTimeout(
        () => finish(new Error("Worker listener announcement timed out")),
        this.startupTimeoutMs
      );
      child.once("error", onError);
      child.once("exit", onExit);
      child.on("message", onMessage);
    });
  }

  /**
  Spawn + readiness check + atomic cutover; old streams retain their worker.
  */
  activate(id: string, entry: string): Promise<ActivationResult> {
    return this.serialized(() => {
      this.crashStreak = 0;
      return this.activateNow(id, entry);
    });
  }

  /**
  Reactivate the retained prior release under a new generation ID, through
  the same verification and readiness gate as a forward activation.
  */
  rollback(id: string): Promise<ActivationResult> {
    return this.serialized(async () => {
      const source = this.rollbackGenerationId;
      const entry = source === null ? undefined : this.releases.get(source);
      if (source === null || entry === undefined)
        throw new NoRollbackTargetError(
          "No retained generation to roll back to"
        );
      this.crashStreak = 0;
      const result = await this.activateNow(id, entry);
      this.ingress.report({
        phase: "generation_rolled_back",
        generationId: id,
        sourceGenerationId: source
      });
      return result;
    });
  }

  getStatus(): ReturnType<RouterIngress["getStatus"]> & {
    rollbackGenerationId: string | null;
  } {
    return {
      ...this.ingress.getStatus(),
      rollbackGenerationId: this.rollbackGenerationId
    };
  }

  private async activateNow(
    id: string,
    entry: string
  ): Promise<ActivationResult> {
    if (
      !GENERATION_ID_PATTERN.test(id) ||
      this.workers.has(id) ||
      this.ingress
        .getStatus()
        .generations.some((generation) => generation.id === id)
    ) {
      throw new Error("Invalid or duplicate generation ID");
    }
    const verified = await this.verifiedEntry(entry);
    const { child, endpoint } = await this.spawnWorker(id, verified);
    let previous: string | null;
    try {
      previous = await this.ingress.activateGeneration(endpoint);
    } catch (error) {
      child.kill("SIGTERM");
      throw error;
    }
    this.workers.set(id, child);
    this.superviseWorker(id, child);
    this.releases.set(id, verified);
    if (previous) {
      this.rollbackGenerationId = previous;
      void this.retire(previous);
    }
    for (const generationId of this.releases.keys()) {
      if (generationId !== id && generationId !== this.rollbackGenerationId)
        this.releases.delete(generationId);
    }
    return { activeGenerationId: id, retiringGenerationId: previous };
  }

  /**
  An exit the supervisor did not ask for. The ingress stops routing to the
  generation at once; an active generation is then restarted from its own
  release. Exits caused by stopWorker are retirement, not failure.
  */
  private superviseWorker(id: string, child: ChildProcess): void {
    const startedAt = performance.now();
    child.once("exit", (exitCode, signal) => {
      if (this.stoppingWorkers.has(child)) return;
      this.workers.delete(id);
      const wasActive = this.ingress.getStatus().activeGenerationId === id;
      this.ingress.report({
        phase: "generation_worker_exited",
        generationId: id,
        exitCode,
        signal
      });
      this.ingress.failGeneration(id);
      if (wasActive) void this.restart(id, performance.now() - startedAt);
    });
  }

  private async restart(failedId: string, uptimeMs: number): Promise<void> {
    const entry = this.releases.get(failedId);
    if (entry === undefined || this.lifetime.signal.aborted) return;
    this.crashStreak = uptimeMs >= WORKER_STABLE_MS ? 1 : this.crashStreak + 1;
    if (this.crashStreak > MAX_CONSECUTIVE_CRASH_RESTARTS) {
      this.ingress.report({
        phase: "generation_restart_exhausted",
        generationId: failedId
      });
      return;
    }
    const policy = retry(handleAll, {
      maxAttempts: RESTART_ACTIVATION_RETRIES,
      backoff: new ExponentialBackoff()
    });
    try {
      await policy.execute(
        () =>
          this.serialized(async () => {
            // An operator activation or rollback during the backoff wins.
            if (this.ingress.getStatus().activeGenerationId !== null) return;
            const id = this.restartGenerationId(failedId);
            await this.activateNow(id, entry);
            this.ingress.report({
              phase: "generation_restarted",
              generationId: id,
              sourceGenerationId: failedId
            });
          }),
        this.lifetime.signal
      );
    } catch {
      if (!this.lifetime.signal.aborted)
        this.ingress.report({
          phase: "generation_restart_exhausted",
          generationId: failedId
        });
    }
  }

  private restartGenerationId(failedId: string): string {
    const suffix = `.restart-${++this.restartCount}`;
    return (
      failedId
        .replace(RESTART_SUFFIX_PATTERN, "")
        .slice(0, MAX_GENERATION_ID_LENGTH - suffix.length) + suffix
    );
  }

  private stopWorker(child: ChildProcess): Promise<void> {
    const existing = this.stoppingWorkers.get(child);
    if (existing) return existing;
    if (child.exitCode !== null || child.signalCode !== null)
      return Promise.resolve();

    const stopped = new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
      }, this.shutdownTimeoutMs);
      timer.unref();
      child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
      // Give the worker its normal graceful shutdown before escalation.
      child.kill("SIGTERM");
    });
    this.stoppingWorkers.set(child, stopped);
    return stopped;
  }

  private async retire(id: string): Promise<void> {
    await this.ingress.waitForRetirement(id);
    const worker = this.workers.get(id);
    if (worker) await this.stopWorker(worker);
    this.workers.delete(id);
  }

  private async handle(
    request: IncomingMessage,
    response: ServerResponse
  ): Promise<void> {
    if (!this.authorized(request)) {
      this.json(response, 401, { error: "unauthorized" });
      return;
    }
    const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
    if (request.method === "GET" && pathname === STATUS_PATH) {
      this.json(response, 200, this.getStatus());
      return;
    }
    const retirement = GENERATION_RETIREMENT_PATH_PATTERN.exec(pathname);
    if (request.method === "GET" && retirement) {
      const generation = this.ingress
        .getStatus()
        .generations.find((candidate) => candidate.id === retirement[1]);
      if (generation) {
        this.json(
          response,
          generation.state === "retired" && !this.workers.has(generation.id)
            ? 200
            : 202,
          generation
        );
      } else {
        this.json(response, 404, { error: "unknown_generation" });
      }
      return;
    }
    if (
      request.method === "POST" &&
      (pathname === GENERATIONS_PATH || pathname === ROLLBACK_PATH)
    ) {
      await this.handleActivation(
        pathname === ROLLBACK_PATH,
        request,
        response
      );
      return;
    }
    this.json(response, 404, { error: "not_found" });
  }

  private async handleActivation(
    isRollback: boolean,
    request: IncomingMessage,
    response: ServerResponse
  ): Promise<void> {
    let input: unknown;
    try {
      input = await this.readBody(request);
    } catch {
      input = null;
    }
    const { id, entry } =
      input && typeof input === "object" && !Array.isArray(input)
        ? (input as Record<string, unknown>)
        : {};
    if (typeof id !== "string" || (!isRollback && typeof entry !== "string")) {
      this.json(response, 400, { error: "invalid_generation" });
      return;
    }
    try {
      const activated = isRollback
        ? await this.rollback(id)
        : await this.activate(id, entry as string);
      this.json(response, 200, activated);
    } catch (error) {
      if (error instanceof NoRollbackTargetError) {
        this.json(response, 409, { error: "no_rollback_target" });
        return;
      }
      this.json(response, 422, {
        error: "activation_failed",
        message:
          error instanceof Error ? error.message : "Unknown activation error"
      });
    }
  }
}
