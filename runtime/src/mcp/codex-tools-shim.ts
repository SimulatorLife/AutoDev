#!/usr/bin/env node

/**
 * Codex's tools, as an MCP server a bridged CLI can call.
 *
 * A bridge serves a CLI as a model, not as a second agent runtime: it runs
 * with its built-in tools disabled, so every action the turn takes goes through
 * here. `tools/list` returns the tools Codex offered on the turn's request, and
 * `tools/call` hands the call to the bridge, which emits it to Codex and blocks
 * until Codex returns the output on its next request. See
 * runtime/src/providers/claude-codex-tools.ts for the tool surface, and
 * runtime/src/providers/codex-tool-turns.ts for the registry that joins a parked
 * call back to the turn holding it.
 *
 * The Claude and Antigravity bridges both launch this; `codexToolsMcpServer`
 * below is the one place that decides how, so the env contract read here and
 * the env written for a launch cannot drift apart.
 *
 * Plain `node:http` rather than `fetch`: a Codex tool call can legitimately
 * outlast undici's default five-minute header timeout (a long test run, or a
 * question put to the user), and the bridge owns the turn's lifetime anyway.
 */

import { request as httpRequest } from "node:http";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";

import {
  resolveRuntimeSourcePath,
  resolveRuntimeSourceRoot
} from "@simulatorlife/autodev-runtime/shared/runtime-source-root";
import { validatedAutoDevOtelResourceAttributes } from "@simulatorlife/autodev-runtime/telemetry/resource-context";

import {
  recordToolCallSpan,
  shutdownTelemetry,
  type ToolCallOutcome
} from "./codex-tools-shim-telemetry.ts";

const BRIDGE_URL = process.env.AUTODEV_BRIDGE_URL ?? "";
const BRIDGE_TOKEN = process.env.AUTODEV_BRIDGE_TOKEN ?? "";
/**
 * The env var naming the turn a launched shim belongs to.
 *
 * Named for the bridge rather than for the CLI it happens to serve first: the
 * turn, not the provider, is what a loopback call has to find.
 */
export const CODEX_TOOLS_TURN_ENV = "AUTODEV_BRIDGE_TURN";
const TURN = process.env[CODEX_TOOLS_TURN_ENV] ?? "";
const PROTOCOL_VERSION = "2025-06-18";

type JsonRpcId = string | number | null;
type JsonObject = Record<string, unknown>;
type Send = (message: JsonObject) => void;

/**
 * The launch definition a bridge writes into its CLI's MCP config.
 *
 * Narrower than a plain JSON object on purpose: every value here is a string,
 * and saying so lets the strict-typed callers assign it without a cast or a
 * widened alias on their side. A type rather than an interface because an
 * interface carries no implicit index signature, and the callers store it in
 * JSON-shaped records that require one.
 */
type CodexToolsMcpServer = {
  command: string;
  args: string[];
  env: Record<string, string>;
};

/**
 * The MCP server entry that launches this shim against one turn's bridge.
 *
 * The turn id is per-launch because several bridged processes can be running
 * at once, and a call has to reach the turn whose process made it rather than
 * whichever turn happens to be live.
 */
export function codexToolsMcpServer(
  turn: string,
  bridge: { url: string; token: string },
  environment: NodeJS.ProcessEnv = process.env
): CodexToolsMcpServer {
  const repoRoot = resolveRuntimeSourceRoot(
    import.meta.dirname,
    environment.AUTODEV_REPO_ROOT
  );
  const resourceAttributes =
    validatedAutoDevOtelResourceAttributes(environment);
  return {
    command: environment.AUTODEV_NODE_BIN ?? process.execPath,
    args: [resolveRuntimeSourcePath(repoRoot, "mcp/codex-tools-shim.ts")],
    env: {
      ...(resourceAttributes
        ? { OTEL_RESOURCE_ATTRIBUTES: resourceAttributes }
        : {}),
      AUTODEV_BRIDGE_URL: bridge.url,
      AUTODEV_BRIDGE_TOKEN: bridge.token,
      [CODEX_TOOLS_TURN_ENV]: turn
    }
  };
}

interface JsonRpcMessage {
  id?: JsonRpcId;
  method?: string;
  params?: JsonObject;
}

function send(message: JsonObject): void {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function isRecord(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** The reply body as a JSON object, or null when it is empty, malformed, or not an object. */
function parseJsonObject(text: string): JsonObject | null {
  if (!text) return null;
  try {
    const value: unknown = JSON.parse(text);
    return isRecord(value) ? value : null;
  } catch {
    return null;
  }
}

/** POST to the owning bridge and parse its JSON reply. */
export function callBridge(
  path: string,
  body: JsonObject,
  bridgeUrl = BRIDGE_URL,
  token = BRIDGE_TOKEN
): Promise<{ status: number; body: JsonObject | null }> {
  return new Promise((resolve, reject) => {
    const payload = Buffer.from(JSON.stringify(body));
    const target = new URL(path, bridgeUrl);
    const outbound = httpRequest(
      target,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": payload.length,
          ...(token ? { authorization: `Bearer ${token}` } : {})
        }
      },
      (response) => {
        let text = "";
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => {
          text += chunk;
        });
        response.on("end", () => {
          resolve({
            status: response.statusCode ?? 0,
            body: parseJsonObject(text)
          });
        });
        response.on("error", reject);
      }
    );
    outbound.on("error", reject);
    outbound.end(payload);
  });
}

function toolError(id: JsonRpcId | undefined, text: string, emit: Send): void {
  emit({
    jsonrpc: "2.0",
    id,
    result: { content: [{ type: "text", text }], isError: true }
  });
}

function initializeResult(params: JsonObject | undefined): JsonObject {
  return {
    protocolVersion:
      typeof params?.protocolVersion === "string"
        ? params.protocolVersion
        : PROTOCOL_VERSION,
    capabilities: { tools: {} },
    serverInfo: { name: "autodev-codex-tools", version: "1.0.0" }
  };
}

async function listTools(bridge: typeof callBridge): Promise<unknown[]> {
  try {
    const reply = await bridge("/v1/bridge-tools/list", { turn: TURN });
    if (reply.status === 200 && Array.isArray(reply.body?.tools))
      return reply.body.tools;
  } catch {
    // An unreachable bridge offers no tools rather than failing the listing.
  }
  return [];
}

async function callTool(
  id: JsonRpcId | undefined,
  params: JsonObject | undefined,
  emit: Send,
  bridge: typeof callBridge
): Promise<void> {
  const name = typeof params?.name === "string" ? params.name : "";
  const args = isRecord(params?.arguments) ? params.arguments : {};
  await recordToolCallSpan(
    name,
    async (): Promise<ToolCallOutcome> => {
      try {
        const reply = await bridge("/v1/bridge-tools/call", {
          turn: TURN,
          name,
          arguments: args
        });
        if (reply.status !== 200 || !reply.body) {
          const error =
            typeof reply.body?.error === "string"
              ? reply.body.error
              : `Codex could not run ${name} (HTTP ${reply.status}).`;
          toolError(id, error, emit);
          return { status: "error", errorType: "tool_error" };
        }
        emit({ jsonrpc: "2.0", id, result: reply.body });
        // The pinned Development MCP convention records
        // `error.type=tool_error` when CallToolResult.isError is true. The
        // tool-level outcome is a failure even though the bridge transport
        // succeeded; telemetry reflects that without changing the response.
        if (reply.body.isError === true) {
          return { status: "error", errorType: "tool_error" };
        }
        return { status: "ok" };
      } catch (error: unknown) {
        const message = `Codex could not run ${name}: ${error instanceof Error ? error.message : String(error)}`;
        toolError(id, message, emit);
        return { status: "error", errorType: "tool_error" };
      }
    },
    params?._meta
  );
}

export async function handleMessage(
  message: JsonRpcMessage,
  emit: Send = send,
  bridge = callBridge
): Promise<void> {
  const { id, method, params } = message;
  if (method === "initialize") {
    emit({ jsonrpc: "2.0", id, result: initializeResult(params) });
    return;
  }
  if (method === "tools/list") {
    emit({ jsonrpc: "2.0", id, result: { tools: await listTools(bridge) } });
    return;
  }
  if (method === "tools/call") {
    await callTool(id, params, emit, bridge);
    return;
  }
  // Notifications carry no id and expect no reply.
  if (id !== undefined) emit({ jsonrpc: "2.0", id, result: {} });
}

export function runStdio(): void {
  if (!BRIDGE_URL || !TURN)
    process.stderr.write(
      "autodev-codex-tools: bridge URL or turn is unset; no tools will be offered.\n"
    );
  const lines = createInterface({ input: process.stdin });
  const inFlight = new Set<Promise<void>>();
  let closing = false;
  let shutdownPromise: Promise<void> | null = null;
  const flushOnClose = (): void => {
    if (shutdownPromise) return;
    closing = true;
    shutdownPromise = Promise.allSettled(inFlight).then(shutdownTelemetry);
  };
  lines.once("close", flushOnClose);
  process.once("SIGTERM", () => lines.close());
  process.once("SIGINT", () => lines.close());

  lines.on("line", (line: string) => {
    if (closing || !line.trim()) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      return;
    }
    if (!isRecord(parsed)) return;
    const message: JsonRpcMessage = {
      ...(parsed.id === undefined ? {} : { id: parsed.id as JsonRpcId }),
      ...(typeof parsed.method === "string" ? { method: parsed.method } : {}),
      ...(isRecord(parsed.params) ? { params: parsed.params } : {})
    };
    const task = handleMessage(message)
      .catch((error: unknown) => {
        if (message.id === undefined) return;
        try {
          send({
            jsonrpc: "2.0",
            id: message.id,
            error: {
              code: -32_603,
              message: error instanceof Error ? error.message : String(error)
            }
          });
        } catch {
          // The peer may have closed stdout while this operation was in flight.
        }
      })
      .finally(() => inFlight.delete(task));
    inFlight.add(task);
  });
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  runStdio();
}
