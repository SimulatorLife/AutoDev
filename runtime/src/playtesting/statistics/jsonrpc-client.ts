/**
 * Tiny JSON-RPC-over-stdio client used to invoke the Playtesting Python
 * statistics worker. Lives next to the rest of the statistics layer so it
 * can be swapped (e.g. for a Python-embedded test harness) without
 * touching the analysis API.
 *
 * The client deliberately only handles envelopes where the response id
 * matches the request id; a mismatched envelope is treated as a wire
 * violation rather than a benign out-of-order message.
 */

import { Buffer } from "node:buffer";
import { type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";

import { JsonLineFramer } from "../jsonl-framer.ts";

export interface JsonRpcError {
  readonly code: number;
  readonly message: string;
  readonly data?: Readonly<Record<string, unknown>>;
}

export type JsonRpcEnvelope =
  | {
      readonly kind: "response";
      readonly id: string;
      readonly result: Record<string, unknown>;
    }
  | {
      readonly kind: "error";
      readonly id: string | null;
      readonly error: JsonRpcError;
    };

export class JsonRpcClientError extends Error {
  readonly category:
    | "spawn-failed"
    | "non-zero-exit"
    | "framing"
    | "envelope"
    | "rpc-error"
    | "missing-id"
    | "unknown-method";

  readonly cause?: unknown;
  constructor(
    category: JsonRpcClientError["category"],
    message: string,
    cause?: unknown
  ) {
    super(message);
    this.name = "JsonRpcClientError";
    this.category = category;
    if (cause !== undefined) this.cause = cause;
  }
}

export interface SpawnedJsonRpcTransport {
  readonly command: string;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
  readonly child: ChildProcessWithoutNullStreams;
  readonly requestLine: string;
  readonly framer: JsonLineFramer;
}

export interface JsonRpcSpawner {
  (
    payload: string,
    options: {
      readonly cwd: string;
      readonly env: Readonly<Record<string, string>>;
    }
  ): SpawnedJsonRpcTransport;
}

/**
 * Spawn a child process and forward one JSON-RPC envelope through it.
 *
 * Tests inject a `spawner` so they can drive the client with the same
 * fake-transport machinery used by `playtesting-adapter.test.ts`.
 */
export async function callJsonRpcMethod(
  spawner: JsonRpcSpawner,
  options: {
    readonly cwd: string;
    readonly env: Readonly<Record<string, string>>;
    readonly maxLineBytes?: number;
    readonly method: string;
    readonly params: Record<string, unknown>;
    readonly timeoutMs: number;
  }
): Promise<JsonRpcEnvelope> {
  const id = randomUUID();
  const request = {
    jsonrpc: "2.0",
    id,
    method: options.method,
    params: options.params
  };
  const requestLine = JSON.stringify(request);
  const transport = spawner(requestLine, {
    cwd: options.cwd,
    env: options.env
  });

  const framer =
    transport.framer ?? new JsonLineFramer(options.maxLineBytes ?? 1_048_576);
  const envelopes: JsonRpcEnvelope[] = [];
  let stderrBuffer = "";
  let spawnError: unknown = null;
  let responseReceived = false;

  transport.child.stdout.setEncoding("utf8");
  transport.child.stdout.on("data", (chunk: string | Buffer) => {
    const lines = framer.push(
      Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, "utf8")
    );
    for (const line of lines) {
      const parsed = parseEnvelope(line, id);
      if (parsed) {
        envelopes.push(parsed);
        responseReceived = true;
      }
    }
  });

  transport.child.stderr.setEncoding("utf8");
  transport.child.stderr.on("data", (chunk: string | Buffer) => {
    stderrBuffer += String(chunk);
    if (stderrBuffer.length > 16 * 1024) {
      stderrBuffer = stderrBuffer.slice(-16 * 1024);
    }
  });

  transport.child.once("error", (err) => {
    spawnError = err;
  });

  transport.child.stdin.end(`${requestLine}\n`);

  const exitCode: number | null = await new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        try {
          transport.child.kill("SIGKILL");
        } catch {
          // ignore
        }
        resolve(null);
      }
    }, options.timeoutMs);

    transport.child.once("close", (code) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve(code);
      }
    });
  });

  if (spawnError) {
    throw new JsonRpcClientError(
      "spawn-failed",
      `Failed to spawn ${transport.command}: ${(spawnError as Error).message ?? spawnError}.`,
      spawnError
    );
  }

  if (!responseReceived) {
    if (exitCode !== 0) {
      throw new JsonRpcClientError(
        "non-zero-exit",
        `${transport.command} exited with code ${exitCode} before responding; stderr: ${stderrBuffer.trim() || "<empty>"}`
      );
    }
    throw new JsonRpcClientError(
      "missing-id",
      `${transport.command} exited (code ${exitCode}) without emitting the requested envelope; stderr: ${stderrBuffer.trim() || "<empty>"}`
    );
  }

  if (envelopes.length !== 1) {
    throw new JsonRpcClientError(
      "envelope",
      `Worker returned ${envelopes.length} envelopes for a single request; refusing to guess which is canonical.`
    );
  }

  return envelopes[0]!;
}

/** Parse a single line of bytes as a JSON-RPC envelope. */
function parseEnvelope(
  line: Buffer,
  expectedId: string
): JsonRpcEnvelope | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line.toString("utf8"));
  } catch (error) {
    throw new JsonRpcClientError(
      "framing",
      `Worker emitted malformed JSON.`,
      error
    );
  }
  if (!parsed || typeof parsed !== "object") {
    return null;
  }
  const obj = parsed as Record<string, unknown>;
  if (obj.jsonrpc !== "2.0") {
    throw new JsonRpcClientError(
      "envelope",
      `Worker envelope missing jsonrpc=2.0.`
    );
  }
  const id = typeof obj.id === "string" ? obj.id : null;
  if ("result" in obj) {
    if (id !== expectedId) {
      throw new JsonRpcClientError(
        "missing-id",
        `Worker response id ${JSON.stringify(id)} did not match request id ${JSON.stringify(expectedId)}.`
      );
    }
    return {
      kind: "response",
      id,
      result: (obj.result ?? {}) as Record<string, unknown>
    };
  }
  if ("error" in obj) {
    const err = obj.error as JsonRpcError;
    return { kind: "error", id, error: err };
  }
  throw new JsonRpcClientError(
    "envelope",
    "Worker envelope had neither result nor error."
  );
}
