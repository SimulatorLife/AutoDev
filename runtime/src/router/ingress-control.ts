import { type ChildProcess, spawn } from "node:child_process";
import { timingSafeEqual } from "node:crypto";
import { chmod, realpath, stat } from "node:fs/promises";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse
} from "node:http";
import path from "node:path";

import { isPathWithin } from "@simulatorlife/autodev-data/files";

import type { RouterGenerationEndpoint, RouterIngress } from "./ingress.ts";

const WORKER_ENTRY_PATTERN = /\.[cm]?[jt]s$/u;
const GENERATION_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/u;
const GENERATION_RETIREMENT_PATH_PATTERN =
  /^\/v1\/generations\/([a-zA-Z0-9._-]+)\/retirement$/u;

export interface RouterIngressSupervisorOptions {
  ingress: RouterIngress;
  controlSocket: string;
  controlToken: string;
  releasesDirectory: string;
  workerStartupTimeoutMs?: number;
}

/** Private management server; never shares the public TCP listener. */
export class RouterIngressSupervisor {
  readonly controlServer: Server;
  private readonly ingress: RouterIngress;
  private readonly controlSocket: string;
  private readonly controlToken: Buffer;
  private readonly releasesDirectory: string;
  private readonly startupTimeoutMs: number;
  private readonly workers = new Map<string, ChildProcess>();
  private activationQueue: Promise<void> = Promise.resolve();

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

  /**
   * Explicit process teardown for tests and ingress shutdown. This is not
   * called during generation cutover: retiring workers remain alive until
   * their admitted HTTP/SSE requests have finished.
   */
  async close(): Promise<void> {
    const workers = [...this.workers.values()];
    await Promise.all(
      workers.map(async (child) => {
        if (child.exitCode !== null || child.signalCode !== null) return;
        const exited = new Promise<void>((resolve) => {
          child.once("exit", () => resolve());
        });
        child.kill("SIGTERM");
        await exited;
      })
    );
    this.workers.clear();
    if (this.controlServer.listening) {
      this.controlServer.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        this.controlServer.close((error) =>
          error ? reject(error) : resolve()
        );
      });
    }
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
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        CODEX_MODEL_ROUTER_HOST: "127.0.0.1",
        CODEX_MODEL_ROUTER_PORT: "0",
        AUTODEV_CONTROL_API_DISABLED: "1",
        AUTODEV_ROUTER_WORKER_GENERATION: id
      };
      delete env.AUTODEV_ROUTER_INGRESS_CONTROL_TOKEN;
      const child = spawn(process.execPath, [entry], {
        env,
        stdio: ["ignore", "inherit", "inherit", "ipc"]
      });
      let settled = false;
      const finish = (error?: Error, port?: number) => {
        if (settled) return;
        settled = true;
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

  /** Spawn + readiness check + atomic cutover; old streams retain their worker. */
  activate(
    id: string,
    entry: string
  ): Promise<{
    activeGenerationId: string;
    retiringGenerationId: string | null;
  }> {
    const operation = this.activationQueue.then(async () => {
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
      try {
        const previous = await this.ingress.activateGeneration(endpoint);
        this.workers.set(id, child);
        if (previous) void this.retire(previous);
        return { activeGenerationId: id, retiringGenerationId: previous };
      } catch (error) {
        child.kill("SIGTERM");
        throw error;
      }
    });
    this.activationQueue = operation.then(
      () => undefined,
      () => undefined
    );
    return operation;
  }

  private async retire(id: string): Promise<void> {
    await this.ingress.waitForRetirement(id);
    const worker = this.workers.get(id);
    // Retirement is safe only after the last HTTP/SSE response finishes.
    if (worker && worker.exitCode === null) worker.kill("SIGTERM");
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
    if (request.method === "GET" && pathname === "/v1/status") {
      this.json(response, 200, this.ingress.getStatus());
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
          generation.state === "retired" ? 200 : 202,
          generation
        );
      } else {
        this.json(response, 404, { error: "unknown_generation" });
      }
      return;
    }
    if (request.method !== "POST" || pathname !== "/v1/generations") {
      this.json(response, 404, { error: "not_found" });
      return;
    }
    try {
      const input = await this.readBody(request);
      if (!input || typeof input !== "object" || Array.isArray(input)) {
        this.json(response, 400, { error: "invalid_generation" });
        return;
      }
      const { id, entry } = input as Record<string, unknown>;
      if (typeof id !== "string" || typeof entry !== "string") {
        this.json(response, 400, { error: "invalid_generation" });
        return;
      }
      const activated = await this.activate(id, entry);
      this.json(response, 200, activated);
    } catch (error) {
      this.json(response, 422, {
        error: "activation_failed",
        message:
          error instanceof Error ? error.message : "Unknown activation error"
      });
    }
  }
}
