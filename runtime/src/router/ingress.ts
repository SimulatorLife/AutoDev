import { randomUUID } from "node:crypto";
import {
  createServer,
  type IncomingHttpHeaders,
  type IncomingMessage,
  request as httpRequest,
  type Server,
  type ServerResponse
} from "node:http";

/** A worker's private listener; only the ingress owns the public port. */
export interface RouterGenerationEndpoint {
  id: string;
  host: string;
  port: number;
}

export type RouterIngressEvent =
  | { phase: "generation_activated"; generationId: string }
  | { phase: "generation_retired"; generationId: string }
  | { phase: "successor_readiness_failed"; generationId: string }
  | { phase: "client_disconnected"; generationId: string; requestId: string }
  | {
      phase: "backend_connection_failed";
      generationId: string;
      requestId: string;
    };

interface Generation {
  endpoint: RouterGenerationEndpoint;
  state: "active" | "retiring" | "retired";
  inFlight: number;
  retired: Promise<void>;
  resolveRetired: () => void;
}

export interface RouterIngressOptions {
  readinessTimeoutMs?: number;
  onEvent?: (event: RouterIngressEvent) => void;
}

/**
 * Stable public HTTP listener. Each request captures its backend at admission,
 * so replacing the active generation cannot move an established SSE stream.
 * The worker remains independently responsible for authentication, routing,
 * request handling, Control API authorization and provider telemetry.
 */
export class RouterIngress {
  readonly server: Server;
  private readonly generations = new Map<string, Generation>();
  private active: Generation | null = null;
  private activationQueue: Promise<void> = Promise.resolve();
  private readonly readinessTimeoutMs: number;
  private readonly onEvent: (event: RouterIngressEvent) => void;

  constructor(options: RouterIngressOptions = {}) {
    this.readinessTimeoutMs = options.readinessTimeoutMs ?? 5000;
    this.onEvent = options.onEvent ?? (() => undefined);
    this.server = createServer((request, response) =>
      this.forward(request, response)
    );
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
        inFlight: generation.inFlight
      }))
    };
  }

  /** Verify first, switch atomically, then permit the previous worker to retire. */
  activateGeneration(
    endpoint: RouterGenerationEndpoint
  ): Promise<string | null> {
    const operation = this.activationQueue.then(async () => {
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
        this.emit({
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
        inFlight: 0,
        retired,
        resolveRetired
      };
      this.generations.set(endpoint.id, generation);
      this.active = generation;
      this.emit({ phase: "generation_activated", generationId: endpoint.id });
      if (previous) {
        previous.state = "retiring";
        this.finishRetirement(previous);
      }
      return previous?.endpoint.id ?? null;
    });
    this.activationQueue = operation.then(
      () => undefined,
      () => undefined
    );
    return operation;
  }

  /** Resolves only after every admitted request on this worker has ended. */
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

  private finishRetirement(generation: Generation): void {
    if (generation.state !== "retiring" || generation.inFlight !== 0) return;
    generation.state = "retired";
    generation.resolveRetired();
    this.emit({
      phase: "generation_retired",
      generationId: generation.endpoint.id
    });
  }

  private emit(event: RouterIngressEvent): void {
    try {
      this.onEvent(event);
    } catch {
      /* telemetry must not break traffic */
    }
  }

  private async probeReadiness(
    endpoint: RouterGenerationEndpoint
  ): Promise<boolean> {
    return await new Promise<boolean>((resolve) => {
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
    generation.inFlight += 1;
    const requestIdHeader = request.headers["x-request-id"];
    const requestId =
      typeof requestIdHeader === "string" ? requestIdHeader : randomUUID();
    const headers: IncomingHttpHeaders = {
      ...request.headers,
      "x-request-id": requestId
    };
    // Reconstruct hop-by-hop transport headers for the backend connection.
    const connectionTokens = String(headers.connection ?? "")
      .split(",")
      .map((token) => token.trim().toLowerCase());
    for (const token of [
      "connection",
      "proxy-connection",
      "keep-alive",
      "transfer-encoding",
      "upgrade",
      ...connectionTokens
    ])
      delete headers[token];
    let finished = false;
    let backendCompleted = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      generation.inFlight -= 1;
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
        const responseHeaders = { ...upstream.headers };
        const responseConnectionTokens = String(
          responseHeaders.connection ?? ""
        )
          .split(",")
          .map((token) => token.trim().toLowerCase());
        for (const token of [
          "connection",
          "proxy-connection",
          "keep-alive",
          "transfer-encoding",
          ...responseConnectionTokens
        ])
          delete responseHeaders[token];
        response.writeHead(upstream.statusCode ?? 502, responseHeaders);
        upstream.pipe(response);
        upstream.once("end", () => {
          backendCompleted = true;
        });
        upstream.once("error", () => response.destroy());
      }
    );
    request.once("aborted", () => backend.destroy());
    response.once("close", () => {
      if (!response.writableEnded && !backendCompleted)
        this.emit({
          phase: "client_disconnected",
          generationId: generation.endpoint.id,
          requestId
        });
      backend.destroy();
      finish();
    });
    backend.once("error", () => {
      if (response.headersSent) {response.destroy();} else {
        this.emit({
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
