import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import {
  connect as connectUnixSocket,
  createServer,
  type Server,
  type Socket
} from "node:net";

const MAX_RPC_LINE_BYTES = 1_048_576;
const UNIX_SOCKET_MAX_BYTES = 96;

interface RpcEnvelope {
  id: string;
  method?: string;
  params?: Record<string, unknown>;
}

/**
Resolve the public XACPX orchestration Unix socket path without importing
heavy XACPX session manager modules into the lightweight ingress supervisor.
*/
export function resolvePublicXacpxSocketPath(
  codexHome?: string,
  environment: NodeJS.ProcessEnv = process.env
): string {
  const explicit =
    environment.XACPX_ORCHESTRATION_SOCKET?.trim() ||
    environment.AUTODEV_XACPX_ORCHESTRATION_SOCKET?.trim();
  if (explicit) return explicit;
  const home = environment.HOME?.trim() || homedir();
  const base =
    codexHome?.trim() ||
    environment.CODEX_HOME?.trim() ||
    path.join(home, ".codex");
  const preferred = path.join(base, "run", "xacpx-orchestration.sock");
  if (Buffer.byteLength(preferred, "utf8") <= UNIX_SOCKET_MAX_BYTES) {
    return preferred;
  }
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

function extractCoordinatorSession(envelope: RpcEnvelope): string | null {
  const parameters = envelope.params;
  if (!parameters || typeof parameters !== "object") return null;
  const direct =
    nonEmptyString(parameters.coordinatorSession) ??
    nonEmptyString(parameters.sourceHandle);
  if (direct) return direct;
  const filter = parameters.filter;
  if (filter && typeof filter === "object") {
    return nonEmptyString((filter as Record<string, unknown>).coordinatorSession);
  }
  return null;
}

function writeRpcError(
  socket: Socket,
  id: string,
  code: string,
  message: string
): void {
  if (socket.destroyed) return;
  socket.write(
    `${JSON.stringify({ id, ok: false, error: { code, message } })}\n`
  );
}

/**
Single-owner Unix socket router for XACPX orchestration IPC (`xacpx-orchestration.sock`).
Keeps one public socket open across worker generation cutovers while pinning
each `coordinatorSession` to the worker generation that holds its in-memory
coordinator/task/session state until that generation exits cleanly or crashes.
*/
export class XacpxOrchestrationSocketRouter {
  readonly socketPath: string;
  private server: Server | null = null;
  private activeGenerationId: string | null = null;
  private readonly workerSockets = new Map<string, string>();
  private readonly coordinatorPins = new Map<string, string>();

  constructor(socketPath: string) {
    this.socketPath = socketPath;
  }

  setActiveGeneration(generationId: string | null): void {
    this.activeGenerationId = generationId;
  }

  registerGeneration(generationId: string, workerSocketPath: string): void {
    this.workerSockets.set(generationId, workerSocketPath);
  }

  unregisterGeneration(generationId: string): void {
    this.workerSockets.delete(generationId);
    for (const [coordinator, owner] of this.coordinatorPins) {
      if (owner === generationId) {
        this.coordinatorPins.delete(coordinator);
      }
    }
    if (this.activeGenerationId === generationId) {
      this.activeGenerationId = null;
    }
  }

  private resolveTargetGeneration(coordinatorSession: string | null): {
    generationId: string;
    workerSocketPath: string;
  } | null {
    if (coordinatorSession) {
      const pinned = this.coordinatorPins.get(coordinatorSession);
      if (pinned) {
        const pinnedPath = this.workerSockets.get(pinned);
        if (pinnedPath) {
          return { generationId: pinned, workerSocketPath: pinnedPath };
        }
        this.coordinatorPins.delete(coordinatorSession);
      }
    }
    if (!this.activeGenerationId) return null;
    const activePath = this.workerSockets.get(this.activeGenerationId);
    if (!activePath) return null;
    return {
      generationId: this.activeGenerationId,
      workerSocketPath: activePath
    };
  }

  private forwardLine(
    line: string,
    clientSocket: Socket
  ): void {
    let parsed: RpcEnvelope;
    try {
      const candidate: unknown = JSON.parse(line);
      if (
        !candidate ||
        typeof candidate !== "object" ||
        typeof (candidate as { id?: unknown }).id !== "string"
      ) {
        return;
      }
      parsed = candidate as RpcEnvelope;
    } catch {
      return;
    }

    const coordinatorSession = extractCoordinatorSession(parsed);
    const target = this.resolveTargetGeneration(coordinatorSession);
    if (!target) {
      writeRpcError(
        clientSocket,
        parsed.id,
        "ORCHESTRATION_UNAVAILABLE",
        "No live router worker generation is available for XACPX orchestration."
      );
      return;
    }

    if (coordinatorSession && !this.coordinatorPins.has(coordinatorSession)) {
      this.coordinatorPins.set(coordinatorSession, target.generationId);
    }

    const upstream = connectUnixSocket(target.workerSocketPath);
    let settled = false;
    let buffer = "";

    const fail = (message: string) => {
      if (settled) return;
      settled = true;
      upstream.destroy();
      writeRpcError(clientSocket, parsed.id, "ORCHESTRATION_UNAVAILABLE", message);
    };

    upstream.once("connect", () => {
      upstream.write(`${line}\n`);
    });
    upstream.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      const newlineIndex = buffer.indexOf("\n");
      if (newlineIndex === -1) return;
      const responseLine = buffer.slice(0, newlineIndex).trim();
      if (!settled) {
        settled = true;
        if (responseLine && !clientSocket.destroyed) {
          clientSocket.write(`${responseLine}\n`);
        }
        upstream.end();
      }
    });
    upstream.once("error", (error: Error) => {
      fail(error.message || "XACPX worker IPC connection failed.");
    });
    upstream.once("close", () => {
      if (!settled) {
        fail("XACPX worker IPC connection closed before replying.");
      }
    });
  }

  async listen(): Promise<void> {
    if (this.server) return;
    const directory = path.dirname(this.socketPath);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    try {
      if (statSync(this.socketPath).isSocket()) {
        rmSync(this.socketPath, { force: true });
      }
    } catch {
      /* absent */
    }
    const server = createServer((socket) => {
      let buffer = "";
      socket.on("data", (chunk: Buffer) => {
        buffer += chunk.toString("utf8");
        if (Buffer.byteLength(buffer, "utf8") > MAX_RPC_LINE_BYTES) {
          buffer = "";
          socket.destroy();
          return;
        }
        while (true) {
          const newlineIndex = buffer.indexOf("\n");
          if (newlineIndex === -1) break;
          const line = buffer.slice(0, newlineIndex).trim();
          buffer = buffer.slice(newlineIndex + 1);
          if (line.length > 0) {
            this.forwardLine(line, socket);
          }
        }
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(this.socketPath, () => {
        server.off("error", reject);
        resolve();
      });
    });
    chmodSync(this.socketPath, 0o600);
    this.server = server;
  }

  async close(): Promise<void> {
    if (this.server) {
      const server = this.server;
      this.server = null;
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    }
    this.workerSockets.clear();
    this.coordinatorPins.clear();
    try {
      if (statSync(this.socketPath).isSocket()) {
        rmSync(this.socketPath, { force: true });
      }
    } catch {
      /* ignore cleanup errors */
    }
  }
}
