import { randomUUID } from "node:crypto";
import {
  createServer,
  type IncomingHttpHeaders,
  type IncomingMessage,
  request as httpRequest,
  type Server,
  type ServerResponse
} from "node:http";

const DEFAULT_RETIREMENT_DRAIN_TIMEOUT_MS = 30_000;

const HOP_BY_HOP_HEADERS = [
  "connection",
  "proxy-connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade"
];

/**
Forward end-to-end headers only, including Connection-nominated fields.
*/
function endToEndHeaders(headers: IncomingHttpHeaders): IncomingHttpHeaders {
  const result = { ...headers };
  const connectionTokens = String(headers.connection ?? "")
    .split(",")
    .map((token) => token.trim().toLowerCase());
  for (const token of [...HOP_BY_HOP_HEADERS, ...connectionTokens])
    delete result[token];
  return result;
}

/**
Runs operations one at a time in call order; a failed operation does not
block the ones queued after it.
*/
export function createSerialQueue(): <T>(
  operation: () => Promise<T>
) => Promise<T> {
  let tail: Promise<void> = Promise.resolve();
  return async (operation) => {
    const previous = tail;
    const { promise, resolve } = Promise.withResolvers<void>();
    tail = promise;
    try {
      await previous;
      return await operation();
    } finally {
      resolve();
    }
  };
}

/**
A worker's private listener; only the ingress owns the public port.
*/
export interface RouterGenerationEndpoint {
  id: string;
  host: string;
  port: number;
}

/**
Every generation transition the ingress and its supervisor report. Restart
and rollback name the generation whose release the new one runs.
*/
export type RouterIngressEvent =
  | { phase: "generation_activated"; generationId: string }
  | { phase: "generation_retired"; generationId: string }
  | {
      phase: "generation_drain_deadline_expired";
      generationId: string;
      inFlight: number;
    }
  | { phase: "successor_readiness_failed"; generationId: string }
  | {
      phase: "generation_worker_exited";
      generationId: string;
      exitCode: number | null;
      signal: string | null;
    }
  | {
      phase: "generation_restarted" | "generation_rolled_back";
      generationId: string;
      sourceGenerationId: string;
    }
  | { phase: "generation_restart_exhausted"; generationId: string }
  | { phase: "client_disconnected"; generationId: string; requestId: string }
  | {
      phase: "backend_connection_failed";
      generationId: string;
      requestId: string;
    };

interface Generation {
  endpoint: RouterGenerationEndpoint;
  state: "active" | "retiring" | "retired";
  requests: Set<AbortController>;
  drainTimer?: NodeJS.Timeout;
  retired: Promise<void>;
  resolveRetired: () => void;
}

export interface RouterIngressOptions {
  readinessTimeoutMs?: number;
  retirementDrainTimeoutMs?: number;
  onEvent?: (event: RouterIngressEvent) => void;
}

/**
Stable public HTTP listener. Each request captures its backend at admission,
so replacing the active generation cannot move an established SSE stream.
The worker remains independently responsible for authentication, routing,
request handling, Control API authorization and provider telemetry.
*/
export class RouterIngress {
  readonly server: Server;
  private readonly generations = new Map<string, Generation>();
  private active: Generation | null = null;
  private readonly serialized = createSerialQueue();
  private readonly readinessTimeoutMs: number;
  private readonly retirementDrainTimeoutMs: number;
  private readonly onEvent: (event: RouterIngressEvent) => void;

  constructor(options: RouterIngressOptions = {}) {
    this.readinessTimeoutMs = options.readinessTimeoutMs ?? 5000;
    this.retirementDrainTimeoutMs =
      options.retirementDrainTimeoutMs ?? DEFAULT_RETIREMENT_DRAIN_TIMEOUT_MS;
    if (
      !Number.isInteger(this.retirementDrainTimeoutMs) ||
      this.retirementDrainTimeoutMs < 1 ||
      this.retirementDrainTimeoutMs > 2_147_483_647
    ) {
      throw new Error("Invalid ingress retirement drain timeout");
    }
    this.onEvent = options.onEvent ?? (() => undefined);
    this.server = createServer((request, response) =>
      this.forward(request, response)
    );
    // HTTP upgrades cannot be forwarded by the HTTP/SSE adapter. Refuse
    // explicitly before admission rather than silently dropping the socket.
    this.server.on("upgrade", (_request, socket) => {
      socket.once("error", () => socket.destroy());
      socket.end(
        "HTTP/1.1 501 Not Implemented\r\nConnection: close\r\nContent-Length: 0\r\n\r\n",
        () => socket.destroy()
      );
    });
    this.server.keepAliveTimeout = 65_000;
    this.server.headersTimeout = 66_000;
  }

  listen(port: number, host: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const onError = (error: Error) => {
        this.server.off("listening", onListening);
        reject(error);
      };
      const onListening = () => {
        this.server.off("error", onError);
        resolve();
      };
      this.server.once("error", onError);
      this.server.once("listening", onListening);
      this.server.listen(port, host);
    });
  }

  getStatus(): {
    ready: boolean;
    activeGenerationId: string | null;
    generations: Array<{
      id: string;
      state: Generation["state"];
      inFlight: number;
    }>;
  } {
    return {
      ready: this.active !== null,
      activeGenerationId: this.active?.endpoint.id ?? null,
      generations: Array.from(this.generations.values(), (generation) => ({
        id: generation.endpoint.id,
        state: generation.state,
        inFlight: generation.requests.size
      }))
    };
  }

  /**
  Verify first, switch atomically, then permit the previous worker to retire.
  */
  activateGeneration(
    endpoint: RouterGenerationEndpoint
  ): Promise<string | null> {
    return this.serialized(async () => {
      if (
        !endpoint.id ||
        endpoint.host !== "127.0.0.1" ||
        !Number.isInteger(endpoint.port) ||
        endpoint.port < 1 ||
        endpoint.port > 65_535
      )
        throw new Error("Invalid router generation endpoint");
      if (this.generations.has(endpoint.id))
        throw new Error(`Router generation id already used: ${endpoint.id}`);
      if (!(await this.probeReadiness(endpoint))) {
        this.report({
          phase: "successor_readiness_failed",
          generationId: endpoint.id
        });
        throw new Error(`Router generation ${endpoint.id} is not ready`);
      }
      let resolveRetired!: () => void;
      const retired = new Promise<void>((resolve) => {
        resolveRetired = resolve;
      });
      const previous = this.active;
      const generation: Generation = {
        endpoint: { ...endpoint },
        state: "active",
        requests: new Set(),
        retired,
        resolveRetired
      };
      this.generations.set(endpoint.id, generation);
      this.active = generation;
      this.report({ phase: "generation_activated", generationId: endpoint.id });
      if (previous) this.beginRetirement(previous);
      return previous?.endpoint.id ?? null;
    });
  }

  /**
  Resolves after all admitted requests finish or are cancelled at the deadline.
  */
  async waitForRetirement(generationId: string): Promise<void> {
    const generation = this.generations.get(generationId);
    if (!generation)
      throw new Error(`Unknown router generation: ${generationId}`);
    if (generation.state === "active")
      throw new Error(
        `Cannot retire active router generation: ${generationId}`
      );
    await generation.retired;
  }

  /**
  The generation's worker is gone: stop admitting to it, flip readiness to
  unavailable if it was active, and cancel what it had admitted (those
  requests have no backend left) so it retires at once instead of answering
  502 until someone notices.
  */
  failGeneration(generationId: string): void {
    const generation = this.generations.get(generationId);
    if (!generation || generation.state === "retired") return;
    if (this.active === generation) this.active = null;
    generation.state = "retiring";
    for (const request of generation.requests) request.abort();
    this.finishRetirement(generation);
  }

  private beginRetirement(generation: Generation): void {
    generation.state = "retiring";
    if (generation.requests.size > 0) {
      generation.drainTimer = setTimeout(() => {
        this.report({
          phase: "generation_drain_deadline_expired",
          generationId: generation.endpoint.id,
          inFlight: generation.requests.size
        });
        for (const request of generation.requests) request.abort();
      }, this.retirementDrainTimeoutMs);
      generation.drainTimer.unref();
    }
    this.finishRetirement(generation);
  }

  private finishRetirement(generation: Generation): void {
    if (generation.state !== "retiring" || generation.requests.size > 0) return;
    clearTimeout(generation.drainTimer);
    generation.state = "retired";
    generation.resolveRetired();
    this.report({
      phase: "generation_retired",
      generationId: generation.endpoint.id
    });
  }

  /**
  The one telemetry sink for ingress and supervisor transitions.
  */
  report(event: RouterIngressEvent): void {
    try {
      this.onEvent(event);
    } catch {
      /*
      telemetry must not break traffic
      */
    }
  }

  private probeReadiness(endpoint: RouterGenerationEndpoint): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      const probe = httpRequest(
        {
          hostname: endpoint.host,
          port: endpoint.port,
          path: "/health/readiness",
          method: "GET",
          headers: { accept: "application/json", connection: "close" },
          timeout: this.readinessTimeoutMs
        },
        (response) => {
          const chunks: Buffer[] = [];
          let size = 0;
          response.on("data", (chunk: Buffer) => {
            size += chunk.length;
            if (size > 4096) {
              probe.destroy();
              return;
            }
            chunks.push(chunk);
          });
          response.once("end", () => {
            try {
              const body = JSON.parse(
                Buffer.concat(chunks).toString("utf8")
              ) as {
                status?: string;
                router?: string;
                lifecycle?: { state?: string; draining?: boolean };
              };
              resolve(
                response.statusCode === 200 &&
                  body.status === "ready" &&
                  body.router === "codex-model-router" &&
                  body.lifecycle?.state === "ready" &&
                  body.lifecycle.draining === false
              );
            } catch {
              resolve(false);
            }
          });
          response.once("error", () => resolve(false));
        }
      );
      probe.once("timeout", () => {
        probe.destroy();
        resolve(false);
      });
      probe.once("error", () => resolve(false));
      probe.end();
    });
  }

  private forward(request: IncomingMessage, response: ServerResponse): void {
    // The stable listener owns its readiness; ordinary health, Control API and
    // model routes pass unchanged to the selected worker generation.
    if (
      request.method === "GET" &&
      request.url === "/_autodev/ingress/readiness"
    ) {
      const status = this.getStatus();
      response.writeHead(status.ready ? 200 : 503, {
        "content-type": "application/json",
        "cache-control": "no-store"
      });
      response.end(JSON.stringify(status));
      return;
    }
    const generation = this.active;
    if (!generation) {
      response.writeHead(503, {
        "content-type": "application/json",
        "retry-after": "1"
      });
      response.end(
        JSON.stringify({ error: { code: "router_generation_unavailable" } })
      );
      return;
    }
    const headers = endToEndHeaders(request.headers);
    const requestIdHeader = headers["x-request-id"];
    const requestId =
      typeof requestIdHeader === "string" ? requestIdHeader : randomUUID();
    headers["x-request-id"] = requestId;
    const retirement = new AbortController();
    let isBackendCompleted = false;
    const finish = () => {
      if (generation.requests.delete(retirement))
        this.finishRetirement(generation);
    };
    const backend = httpRequest(
      {
        hostname: generation.endpoint.host,
        port: generation.endpoint.port,
        method: request.method,
        path: request.url,
        headers
      },
      (upstream) => {
        if (retirement.signal.aborted) {
          upstream.destroy();
          return;
        }
        const responseHeaders = endToEndHeaders(upstream.headers);
        response.writeHead(upstream.statusCode ?? 502, responseHeaders);
        upstream.pipe(response);
        upstream.once("end", () => {
          isBackendCompleted = true;
        });
        upstream.once("error", () => response.destroy());
      }
    );
    retirement.signal.addEventListener(
      "abort",
      () => {
        backend.destroy();
        // A response already flushed must not close a reused keep-alive socket.
        if (!response.writableFinished) response.destroy();
        finish();
      },
      { once: true }
    );
    generation.requests.add(retirement);
    request.once("aborted", () => backend.destroy());
    response.once("close", () => {
      if (
        !retirement.signal.aborted &&
        !response.writableEnded &&
        !isBackendCompleted
      )
        this.report({
          phase: "client_disconnected",
          generationId: generation.endpoint.id,
          requestId
        });
      backend.destroy();
      finish();
    });
    backend.once("error", () => {
      if (retirement.signal.aborted || response.destroyed) return;
      if (response.headersSent) {
        response.destroy();
      } else {
        this.report({
          phase: "backend_connection_failed",
          generationId: generation.endpoint.id,
          requestId
        });
        response.writeHead(502, { "content-type": "application/json" });
        response.end(
          JSON.stringify({ error: { code: "router_backend_unavailable" } })
        );
      }
    });
    request.pipe(backend);
  }
}
