#!/usr/bin/env node

/**
 * The delegation tool a provider bridge hands its CLI.
 *
 * A CLI bridge's child agents are invisible to Codex: the CLI spawns them
 * inside its own runtime, no Codex thread is created, and the app has nothing
 * to render. The fix is to make the CLI ask *Codex* to spawn instead -- but a
 * CLI cannot reach Codex, only the bridge can, and only by ending its Responses
 * turn with a tool call.
 *
 * This is the tool that bridges the two. The CLI calls `spawn_subagent`; this
 * server forwards the call to its owning bridge over HTTP and blocks on the
 * reply. The bridge ends its Responses turn with an `exec` call carrying the
 * spawn script, Codex runs it and returns the new agent ids on the next
 * request, and the bridge answers this call with them. The CLI stays alive
 * throughout because it is parked inside a tool call -- Claude Code holds one
 * open for at least 400s with no `MCP_TOOL_TIMEOUT` override, measured.
 *
 * Deliberately dependency-free: this runs as a child process of a launchd
 * service, and a stdio JSON-RPC loop is small enough that an SDK would be more
 * risk than help.
 */

import { createInterface } from "node:readline";

const BRIDGE_URL = process.env.AUTODEV_BRIDGE_URL ?? "";
const BRIDGE_TOKEN = process.env.AUTODEV_BRIDGE_TOKEN ?? "";
const SESSION = process.env.AUTODEV_SPAWN_SESSION ?? "";
// Kept under the CLI's own tool timeout so the bridge always answers first: a
// call this server abandons leaves the CLI waiting on a reply that never comes.
const CALL_TIMEOUT_MS = Number.parseInt(process.env.AUTODEV_SPAWN_CALL_TIMEOUT_MS ?? "", 10) || 600_000;

const PROTOCOL_VERSION = "2025-06-18";

const TOOL = {
  name: "spawn_subagent",
  description: [
    "Delegate a bounded task to a subagent.",
    "",
    "This is the only way to delegate in this session. The child is created by the",
    "orchestration layer rather than inside this CLI, which is what makes it a real,",
    "trackable agent session rather than an invisible one. Returns the spawned",
    "agents' ids.",
    "",
    "Spawn a whole batch in one call when the work is independent -- that is cheaper",
    "and runs in parallel. Each child must get the full context it needs: it cannot",
    "see this conversation.",
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
              description: "Configured role: explorer, worker, validator, docs-researcher, browser-tester, smart, or default.",
            },
            message: {
              type: "string",
              description: "The complete, self-contained task for this child.",
            },
          },
          required: [ "message" ],
        },
      },
    },
    required: [ "children" ],
  },
};

const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
const reply = (id, result) => send({ jsonrpc: "2.0", id, result });
const fail = (id, code, message) => send({ jsonrpc: "2.0", id, error: { code, message } });
/** A tool result the model reads as a failure it can act on, not a transport error. */
const toolError = (id, text) => reply(id, { content: [ { type: "text", text } ], isError: true });

async function callBridge(path, body) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CALL_TIMEOUT_MS);
  try {
    const response = await fetch(new URL(path, BRIDGE_URL), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(BRIDGE_TOKEN ? { authorization: `Bearer ${BRIDGE_TOKEN}` } : {}),
      },
      body: JSON.stringify({ session: SESSION, ...body }),
      signal: controller.signal,
    });
    const text = await response.text();
    let parsed = null;
    try { parsed = text ? JSON.parse(text) : null; } catch { /* reported below */ }
    return { ok: response.ok, status: response.status, body: parsed, text };
  } finally {
    clearTimeout(timer);
  }
}

async function handle(message) {
  const { id, method, params } = message;

  if (method === "initialize") {
    reply(id, {
      protocolVersion: typeof params?.protocolVersion === "string" ? params.protocolVersion : PROTOCOL_VERSION,
      capabilities: { tools: {} },
      serverInfo: { name: "autodev-spawn", version: "1.0.0" },
    });
    return;
  }

  if (method === "tools/list") {
    // The bridge decides whether this turn may delegate at all -- a leaf role
    // must not be offered the tool, and some runtimes share one MCP config
    // across every agent regardless of depth. An unreachable bridge means no
    // tool rather than a broken one.
    let offered = false;
    try {
      const attach = await callBridge("/v1/bridge-spawn/attach", { pid: process.pid, ppid: process.ppid });
      offered = attach.ok && attach.body?.spawnAllowed === true;
    } catch {
      offered = false;
    }
    reply(id, { tools: offered ? [ TOOL ] : [] });
    return;
  }

  if (method === "tools/call") {
    if (params?.name !== TOOL.name) {
      fail(id, -32602, `unknown tool: ${String(params?.name)}`);
      return;
    }
    const children = params?.arguments?.children;
    if (!Array.isArray(children) || children.length === 0) {
      toolError(id, "spawn_subagent requires a non-empty `children` array.");
      return;
    }
    try {
      const result = await callBridge("/v1/bridge-spawn/call", { children, pid: process.pid, ppid: process.ppid });
      if (!result.ok) {
        toolError(id, result.body?.error ?? `Delegation failed (HTTP ${result.status}). Do the work directly.`);
        return;
      }
      reply(id, { content: [ { type: "text", text: result.body?.text ?? result.text ?? "" } ] });
    } catch (error) {
      // The turn must not die because delegation did; tell the model so it can
      // fall back to doing the work itself.
      const reason = error?.name === "AbortError" ? "timed out" : "failed";
      toolError(id, `Delegation ${reason}. Do the work directly and say that delegation was unavailable.`);
    }
    return;
  }

  // Notifications carry no id and expect no reply.
  if (id !== undefined) reply(id, {});
}

if (!BRIDGE_URL) {
  process.stderr.write("autodev-spawn: AUTODEV_BRIDGE_URL is unset; the spawn tool will not be offered.\n");
}

const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
  if (!line.trim()) return;
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return; // Not addressable: no id to fail against.
  }
  void handle(message).catch((error) => {
    if (message?.id !== undefined) fail(message.id, -32603, String(error?.message ?? error));
  });
});
