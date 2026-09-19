#!/usr/bin/env node

/**
 * Codex's tools, as an MCP server the Claude CLI can call.
 *
 * The Claude bridge runs the CLI with its built-in tools disabled, so every
 * action a Claude-served turn takes goes through here: `tools/list` returns
 * the tools Codex offered on the turn's request, and `tools/call` hands the
 * call to the bridge, which emits it to Codex and blocks until Codex returns
 * the output on its next request. See src/providers/claude-codex-tools.ts.
 *
 * Plain `node:http` rather than `fetch`: a Codex tool call can legitimately
 * outlast undici's default five-minute header timeout (a long test run, or a
 * question put to the user), and the bridge owns the turn's lifetime anyway.
 */

import { request as httpRequest } from "node:http";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";

const BRIDGE_URL = process.env.AUTODEV_BRIDGE_URL ?? "";
const BRIDGE_TOKEN = process.env.AUTODEV_BRIDGE_TOKEN ?? "";
const TURN = process.env.AUTODEV_CLAUDE_TURN ?? "";
const PROTOCOL_VERSION = "2025-06-18";

type JsonRpcId = string | number | null;
type JsonObject = Record<string, unknown>;
type Send = (message: JsonObject) => void;

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
      return;
    }
    emit({ jsonrpc: "2.0", id, result: reply.body });
  } catch (error: unknown) {
    toolError(
      id,
      `Codex could not run ${name}: ${error instanceof Error ? error.message : String(error)}`,
      emit
    );
  }
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
  lines.on("line", (line: string) => {
    if (!line.trim()) return;
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
    void handleMessage(message).catch((error: unknown) => {
      if (message.id !== undefined)
        send({
          jsonrpc: "2.0",
          id: message.id,
          error: {
            code: -32_603,
            message: error instanceof Error ? error.message : String(error)
          }
        });
    });
  });
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  runStdio();
}
