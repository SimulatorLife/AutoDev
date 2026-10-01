#!/usr/bin/env node

/**
 * The delegation tool a provider bridge hands its CLI.
 *
 * A CLI bridge's child agents are invisible to Codex: the CLI spawns them
 * inside its own runtime, no Codex thread is created, and the app has nothing
 * to render. The fix is to make the CLI ask Codex to spawn instead -- but a
 * CLI cannot reach Codex, only the bridge can, and only by ending its Responses
 * turn with a tool call.
 *
 * This dependency-free stdio JSON-RPC server forwards `spawn_subagent` calls to
 * the owning bridge over HTTP and blocks on the reply. It is deliberately a
 * small process boundary rather than an SDK-backed abstraction.
 */

import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";

const BRIDGE_URL = process.env.AUTODEV_BRIDGE_URL ?? "";
const BRIDGE_TOKEN = process.env.AUTODEV_BRIDGE_TOKEN ?? "";
const SESSION = process.env.AUTODEV_SPAWN_SESSION ?? "";
const CALL_TIMEOUT_MS =
  Number.parseInt(process.env.AUTODEV_SPAWN_CALL_TIMEOUT_MS ?? "") || 600_000;
const PROTOCOL_VERSION = "2025-06-18";

type JsonRpcId = string | number | null;
type JsonObject = Record<string, unknown>;

interface JsonRpcMessage {
  id?: JsonRpcId;
  method?: string;
  params?: JsonObject;
}

interface BridgeResponse {
  ok: boolean;
  status: number;
  body: JsonObject | null;
  text: string;
}

const TOOL = {
  name: "spawn_subagent",
  description: [
    "Delegate a bounded task to a subagent.",
    "",
    "This is the only way to delegate in this session. The child is created by the",
    "orchestration layer rather than inside this CLI, which is what makes it a real,",
    "trackable agent session rather than an invisible one. Returns the spawned",
    "agents' ids and per-child dispatch status. A rejected child has no child id to close.",
    "",
    "Spawn a whole batch in one call when the work is independent -- that is cheaper",
    "and runs in parallel. Each child must get the full context it needs: it cannot",
    "see this conversation."
  ].join("\n"),
  inputSchema: {
    type: "object",
    properties: {
      children: {
        type: "array",
        minItems: 1,
        description: "The subagents to spawn, one entry per child.",
        items: {
          type: "object",
          properties: {
            agent_type: {
              type: "string",
              description:
                "Configured role: explorer, worker, validator, docs-researcher, browser-tester, smart, or default."
            },
            message: {
              type: "string",
              description: "The complete, self-contained task for this child."
            }
          },
          required: ["message"]
        }
      }
    },
    required: ["children"]
  }
} as const;

type Send = (message: JsonObject) => void;

function send(message: JsonObject): void {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function reply(
  id: JsonRpcId | undefined,
  result: unknown,
  emit: Send = send
): void {
  emit({ jsonrpc: "2.0", id, result });
}

function fail(
  id: JsonRpcId | undefined,
  code: number,
  message: string,
  emit: Send = send
): void {
  emit({ jsonrpc: "2.0", id, error: { code, message } });
}

/** A tool result the model reads as a failure, not as a transport error. */
function toolError(
  id: JsonRpcId | undefined,
  text: string,
  emit: Send = send
): void {
  reply(id, { content: [{ type: "text", text }], isError: true }, emit);
}

async function callBridge(
  path: string,
  body: JsonObject
): Promise<BridgeResponse> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CALL_TIMEOUT_MS);
  try {
    const response = await fetch(new URL(path, BRIDGE_URL), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(BRIDGE_TOKEN ? { authorization: `Bearer ${BRIDGE_TOKEN}` } : {})
      },
      body: JSON.stringify({ session: SESSION, ...body }),
      signal: controller.signal
    });
    const text = await response.text();
    let parsed: JsonObject | null = null;
    try {
      const value: unknown = text ? JSON.parse(text) : null;
      parsed = isRecord(value) ? value : null;
    } catch {
      // The raw response text is retained for the model-facing fallback.
    }
    return { ok: response.ok, status: response.status, body: parsed, text };
  } finally {
    clearTimeout(timer);
  }
}

/** Whether the bridge lets this turn delegate. An unreachable bridge means no tool rather than a broken one. */
async function spawnOffered(): Promise<boolean> {
  try {
    const attach = await callBridge("/v1/bridge-spawn/attach", {
      pid: process.pid,
      ppid: process.ppid
    });
    return attach.ok && attach.body?.spawnAllowed === true;
  } catch {
    return false;
  }
}

async function callSpawnTool(
  id: JsonRpcId | undefined,
  params: JsonObject | undefined,
  emit: Send
): Promise<void> {
  const name = params?.name;
  if (name !== TOOL.name) {
    fail(id, -32_602, `unknown tool: ${String(name)}`, emit);
    return;
  }
  const argumentsObject = isRecord(params?.arguments) ? params.arguments : null;
  const children = argumentsObject?.children;
  if (!Array.isArray(children) || children.length === 0) {
    toolError(
      id,
      "spawn_subagent requires a non-empty `children` array.",
      emit
    );
    return;
  }
  try {
    const result = await callBridge("/v1/bridge-spawn/call", {
      children,
      pid: process.pid,
      ppid: process.ppid
    });
    if (!result.ok) {
      const error =
        typeof result.body?.error === "string"
          ? result.body.error
          : `Delegation failed (HTTP ${result.status}); no child was created. Do not retry blindly or take over delegated scopes.`;
      toolError(id, error, emit);
      return;
    }
    const text =
      typeof result.body?.text === "string" ? result.body.text : result.text;
    reply(id, { content: [{ type: "text", text }] }, emit);
  } catch (error: unknown) {
    const reason = isAbortError(error) ? "timed out" : "failed";
    toolError(
      id,
      `Delegation ${reason}; no child was created. Do not retry blindly or take over delegated scopes. Close known terminal child handles, retry once if appropriate, otherwise report that delegation is unavailable.`,
      emit
    );
  }
}

export async function handleMessage(
  message: JsonRpcMessage,
  emit: Send = send
): Promise<void> {
  const { id, method, params } = message;

  if (method === "initialize") {
    reply(
      id,
      {
        protocolVersion:
          typeof params?.protocolVersion === "string"
            ? params.protocolVersion
            : PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: "autodev-spawn", version: "1.0.0" }
      },
      emit
    );
    return;
  }

  if (method === "tools/list") {
    // The bridge decides whether this turn may delegate at all.
    reply(id, { tools: (await spawnOffered()) ? [TOOL] : [] }, emit);
    return;
  }

  if (method === "tools/call") {
    await callSpawnTool(id, params, emit);
    return;
  }

  // Notifications carry no id and expect no reply.
  if (id !== undefined) reply(id, {}, emit);
}

export function runStdio(): void {
  if (!BRIDGE_URL) {
    process.stderr.write(
      "autodev-spawn: AUTODEV_BRIDGE_URL is unset; the spawn tool will not be offered.\n"
    );
  }
  const rl = createInterface({ input: process.stdin });
  rl.on("line", (line: string) => {
    if (!line.trim()) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      return;
    }
    if (!isRecord(parsed)) return;
    const message: JsonRpcMessage = {
      ...(parsed.id === undefined ? {} : { id: asJsonRpcId(parsed.id) }),
      ...(typeof parsed.method === "string" ? { method: parsed.method } : {}),
      ...(isRecord(parsed.params) ? { params: parsed.params } : {})
    };
    void handleMessage(message).catch((error: unknown) => {
      if (message.id !== undefined)
        fail(message.id, -32_603, errorMessage(error));
    });
  });
}

function isRecord(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function asJsonRpcId(value: unknown): JsonRpcId {
  return typeof value === "string" ||
    typeof value === "number" ||
    value === null
    ? value
    : String(value);
}

function isAbortError(error: unknown): boolean {
  return isRecord(error) && error.name === "AbortError";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  runStdio();
}
