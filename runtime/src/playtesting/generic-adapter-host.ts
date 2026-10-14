/**
 * Stdio host for the generic adapter.
 *
 * Serves the game-adapter protocol from a `GenericAdapter`, so the Runtime's
 * existing `PlaytestAdapterClient` talks to AutoDev's process and AutoDev talks
 * to the game through its declared bindings. The game ships an entry module and
 * a binding file; it does not ship protocol code.
 *
 * The transport is the same strict JSON-RPC the client validates: one request
 * per line, a response or error per id, and no invented envelope fields. A
 * malformed request is answered with a protocol error rather than dropped,
 * because a dropped request is a client that waits forever.
 */
import type { Readable, Writable } from "node:stream";

import {
  type PlaytestBindableMethod,
  type PlaytestJsonRpcNotification,
  type PlaytestJsonRpcRequest,
  type PlaytestJsonRpcResponse,
  PLAYTESTS_ADAPTER_APPLICATION_ERROR_CODES,
  PLAYTESTS_ADAPTER_DEFAULT_QUOTAS,
  PLAYTESTS_ADAPTER_METHODS
} from "@simulatorlife/autodev-core";

import {
  createGenericAdapter,
  type GenericAdapter,
  GenericAdapterError,
  type GenericAdapterOptions
} from "./generic-adapter.ts";
import { JsonLineFramer } from "./jsonl-framer.ts";

const GAME_METHOD_PREFIX_PATTERN = /^game\./u;

const METHOD_BY_NAME: ReadonlyMap<string, PlaytestBindableMethod> = new Map(
  PLAYTESTS_ADAPTER_METHODS.map((method) => [
    method,
    method.replace(GAME_METHOD_PREFIX_PATTERN, "") as PlaytestBindableMethod
  ])
);

const INVALID_REQUEST = -32_600;
const METHOD_NOT_FOUND = -32_601;
const INTERNAL_ERROR = -32_603;
const PARSE_ERROR = -32_700;

/** Parse one line into a request, rejecting anything the protocol forbids. */
export function parseAdapterRequest(line: string):
  | {
      readonly ok: true;
      readonly request: PlaytestJsonRpcRequest;
    }
  | {
      readonly ok: false;
      readonly code: number;
      readonly message: string;
      readonly id: string | null;
    } {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return {
      ok: false,
      code: PARSE_ERROR,
      message: "Adapter request is not valid JSON.",
      id: null
    };
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return {
      ok: false,
      code: INVALID_REQUEST,
      message: "Adapter request must be a JSON-RPC object.",
      id: null
    };
  }
  const candidate = value as Readonly<Record<string, unknown>>;
  const id = typeof candidate.id === "string" ? candidate.id : null;
  if (
    candidate.jsonrpc !== "2.0" ||
    typeof candidate.method !== "string" ||
    !Object.hasOwn(candidate, "id")
  ) {
    return {
      ok: false,
      code: INVALID_REQUEST,
      message: "Adapter request envelope is not supported.",
      id
    };
  }
  return { ok: true, request: value as unknown as PlaytestJsonRpcRequest };
}

export interface GenericAdapterHostOptions extends GenericAdapterOptions {
  readonly input: Readable;
  readonly output: Writable;
  /** Bound so an unbounded line cannot grow the buffer without limit. */
  readonly maximumLineBytes?: number;
}

export interface GenericAdapterHost {
  readonly adapter: GenericAdapter;
  /** Resolves once the input stream ends. */
  serve(): Promise<void>;
  /** Forward a game-emitted notification, e.g. `game.event`. */
  notify(method: string, params: Readonly<Record<string, unknown>>): void;
  close(): Promise<void>;
}

function errorResponse(
  id: string | null,
  code: number,
  message: string
): PlaytestJsonRpcResponse {
  return {
    jsonrpc: "2.0",
    id: id ?? "0",
    error: { code, message }
  } as unknown as PlaytestJsonRpcResponse;
}

function okResponse(id: string, result: unknown): PlaytestJsonRpcResponse {
  return {
    jsonrpc: "2.0",
    id,
    result: result === undefined ? null : result
  } as unknown as PlaytestJsonRpcResponse;
}

/**
 * Start the host. Binding problems surface before any stream is read, so a game
 * with an unusable declaration is told so rather than seeing a transport error.
 */
export async function startGenericAdapterHost(
  options: GenericAdapterHostOptions
): Promise<GenericAdapterHost> {
  const adapter = await createGenericAdapter(options);
  const framer = new JsonLineFramer(
    options.maximumLineBytes ?? PLAYTESTS_ADAPTER_DEFAULT_QUOTAS.maxMessageBytes
  );
  let closed = false;

  const write = (
    envelope: PlaytestJsonRpcResponse | PlaytestJsonRpcNotification
  ): void => {
    if (closed) return;
    options.output.write(`${JSON.stringify(envelope)}\n`);
  };

  const handle = async (line: string): Promise<void> => {
    const parsed = parseAdapterRequest(line);
    if (!parsed.ok) {
      write(errorResponse(parsed.id, parsed.code, parsed.message));
      return;
    }
    const { id, method, params } = parsed.request as {
      readonly id: string;
      readonly method: string;
      readonly params?: unknown;
    };
    const binding = METHOD_BY_NAME.get(method);
    if (binding === undefined) {
      write(
        errorResponse(id, METHOD_NOT_FOUND, `Unknown adapter method ${method}.`)
      );
      return;
    }
    // The capability advertisement is derived, not delegated: a game that
    // bound its own `capabilities` must not overwrite the digests AutoDev
    // computed from the game's own schemas.
    if (binding === "capabilities") {
      write(okResponse(id, adapter.capabilities));
      return;
    }
    try {
      const result = await adapter.invoke(
        binding,
        typeof params === "object" && params !== null && !Array.isArray(params)
          ? (params as Readonly<Record<string, unknown>>)
          : {}
      );
      write(okResponse(id, result));
    } catch (error) {
      if (error instanceof GenericAdapterError) {
        write(
          errorResponse(
            id,
            // An unbound method is an unsupported capability, which is the one
            // code the Runtime already maps to a terminal negotiation failure.
            error.code === "unbound-method"
              ? PLAYTESTS_ADAPTER_APPLICATION_ERROR_CODES.unsupportedCapability
              : INTERNAL_ERROR,
            error.message
          )
        );
        return;
      }
      write(
        errorResponse(
          id,
          INTERNAL_ERROR,
          error instanceof Error ? error.message : String(error)
        )
      );
    }
  };

  // Requests are answered strictly in order. A protocol whose replies can
  // overtake each other makes revision binding ambiguous.
  let queue: Promise<void> = Promise.resolve();
  const onData = (chunk: Buffer): void => {
    for (const line of framer.push(chunk)) {
      queue = queue.then(() => handle(line.toString("utf8")));
    }
  };
  options.input.on("data", onData);

  return {
    adapter,
    serve: async () => {
      await new Promise<void>((resolve) => {
        options.input.once("end", resolve);
        options.input.once("close", resolve);
      });
      await queue;
    },
    notify: (method, params) => {
      write({
        jsonrpc: "2.0",
        method,
        params
      } as unknown as PlaytestJsonRpcNotification);
    },
    close: async () => {
      if (closed) return;
      closed = true;
      options.input.off("data", onData);
      await adapter.close();
    }
  };
}

export { protocolMethodFor } from "./generic-adapter.ts";
