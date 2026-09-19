#!/usr/bin/env node

/**
 * Start one AutoDev MCP server the way Codex does and exercise it.
 *
 * Runs `$CODEX_HOME/hooks/run-autodev-mcp.sh <server>` with a minimal
 * environment (Codex does not start MCP servers with your shell's PATH), does
 * the MCP handshake, lists the tools, makes each requested call in order, and
 * prints the server's stderr if it dies -- which is what an agent sees as
 * "Transport closed". The server runs in its own process group and the whole
 * group is killed at the end, so no language server it spawned is orphaned.
 *
 *   node mcp-probe.ts <server> [--cwd DIR] [--call <tool> '<json-args>']... [--timeout-ms N]
 */

import { spawn } from "node:child_process";
import { homedir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

type JsonRecord = Record<string, unknown>;

interface JsonRpcMessage {
  id?: number;
  result?: {
    tools?: Array<{ name: string }>;
    content?: Array<{ text?: string; type?: string }>;
    isError?: boolean;
    [key: string]: unknown;
  };
  error?: unknown;
  [key: string]: unknown;
}

export interface ProbeOptions {
  server: string;
  cwd: string;
  launcher: string;
  calls: Array<{ tool: string; args: JsonRecord }>;
  timeoutMs: number;
  env?: NodeJS.ProcessEnv;
}

export interface ProbeResult {
  tools: string[];
  calls: Array<{ tool: string; ok: boolean; text: string }>;
  exited: { code: number | null; signal: string | null } | null;
  stderrTail: string;
}

const EXCERPT = 400;

function formatCallReply(
  reply: JsonRpcMessage | null,
  exited: ProbeResult["exited"]
): { ok: boolean; text: string } {
  if (reply === null) {
    const text = exited
      ? "no reply: the server exited"
      : "no reply: timed out";
    return { ok: false, text };
  }
  const content = reply.result?.content;
  let text: string;
  if (reply.error) {
    text = `error: ${JSON.stringify(reply.error)}`;
  } else if (Array.isArray(content)) {
    text = content
      .map((part) => part.text ?? `[${part.type}]`)
      .join("\n");
  } else {
    text = JSON.stringify(reply.result);
  }
  return {
    ok: !reply.error && !reply.result?.isError,
    text: text.length > EXCERPT ? `${text.slice(0, EXCERPT)}…` : text
  };
}

async function executeCalls(
  calls: ProbeOptions["calls"],
  rpc: (method: string, params: JsonRecord) => Promise<JsonRpcMessage | null>,
  getExited: () => ProbeResult["exited"]
): Promise<ProbeResult["calls"]> {
  const results: ProbeResult["calls"] = [];
  let chain: Promise<unknown> = Promise.resolve();
  for (const call of calls) {
    chain = chain.then(async () => {
      const reply = await rpc("tools/call", {
        name: call.tool,
        arguments: call.args
      });
      const formatted = formatCallReply(reply, getExited());
      results.push({ tool: call.tool, ...formatted });
      return null;
    });
  }
  await chain;
  return results;
}

/** The environment Codex gives an MCP server: HOME and a system PATH, not your shell's. */
export function codexLikeEnv(): NodeJS.ProcessEnv {
  return {
    HOME: process.env.HOME ?? homedir(),
    PATH: "/usr/bin:/bin:/usr/sbin:/sbin:/usr/local/bin",
    ...(process.env.CODEX_HOME ? { CODEX_HOME: process.env.CODEX_HOME } : {})
  };
}

export async function probe(options: ProbeOptions): Promise<ProbeResult> {
  const child = spawn(options.launcher, [options.server], {
    cwd: options.cwd,
    env: options.env ?? codexLikeEnv(),
    stdio: ["pipe", "pipe", "pipe"],
    detached: true
  });
  let stderr = "";
  let buffer = "";
  let nextId = 0;
  let exited: ProbeResult["exited"] = null;
  const pending = new Map<number, (message: JsonRpcMessage | null) => void>();
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  child.stdout.on("data", (chunk: Buffer) => {
    buffer += chunk.toString();
    let newline: number;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      try {
        const message = JSON.parse(line) as JsonRpcMessage;
        if (typeof message.id === "number") {
          pending.get(message.id)?.(message);
          pending.delete(message.id);
        }
      } catch {
        /* not a JSON-RPC line */
      }
    }
  });
  child.on("exit", (code, signal) => {
    exited = { code, signal };
    for (const settle of pending.values()) settle(null);
    pending.clear();
  });
  const rpc = (
    method: string,
    params: JsonRecord
  ): Promise<JsonRpcMessage | null> =>
    new Promise((resolve) => {
      if (exited) {
        resolve(null);
        return;
      }
      const id = ++nextId;
      const timer = setTimeout(() => {
        pending.delete(id);
        resolve(null);
      }, options.timeoutMs);
      pending.set(id, (message) => {
        clearTimeout(timer);
        resolve(message);
      });
      child.stdin.write(
        `${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`
      );
    });
  const result: ProbeResult = {
    tools: [],
    calls: [],
    exited: null,
    stderrTail: ""
  };
  try {
    const init = await rpc("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "autodev-mcp-probe", version: "1" }
    });
    if (init) {
      child.stdin.write(
        `${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`
      );
      const listed = await rpc("tools/list", {});
      result.tools = (listed?.result?.tools ?? []).map((tool) =>
        String(tool.name)
      );
      result.calls = await executeCalls(options.calls, rpc, () => exited);
    }
  } finally {
    result.exited = exited;
    // The launcher, the server, and anything it spawned share this group.
    try {
      if (child.pid) process.kill(-child.pid, "SIGTERM");
    } catch {
      /* already gone */
    }
    result.stderrTail = stderr.slice(-3000);
  }
  return result;
}

function parseArgs(argv: string[]): ProbeOptions | null {
  const codexHome = process.env.CODEX_HOME ?? path.join(homedir(), ".codex");
  let server = "";
  let cwd = process.cwd();
  let timeoutMs = 60_000;
  const calls: ProbeOptions["calls"] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (arg === "--cwd") cwd = argv[++index] ?? cwd;
    else if (arg === "--timeout-ms")
      timeoutMs = Number(argv[++index] ?? timeoutMs);
    else if (arg === "--call") {
      const tool = argv[++index];
      const raw =
        argv[index + 1] && !argv[index + 1]!.startsWith("--")
          ? argv[++index]!
          : "{}";
      if (!tool) return null;
      calls.push({ tool, args: JSON.parse(raw) as JsonRecord });
    } else if (!arg.startsWith("--")) server = arg;
  }
  if (!server) return null;
  return {
    server,
    cwd,
    calls,
    timeoutMs,
    launcher: path.join(codexHome, "hooks", "run-autodev-mcp.sh")
  };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const options = parseArgs(process.argv.slice(2));
  if (!options) {
    process.stderr.write(
      "usage: mcp-probe.ts <server> [--cwd DIR] [--call <tool> '<json-args>']... [--timeout-ms N]\n"
    );
    process.exit(2);
  }
  const result = await probe(options);
  process.stdout.write(
    `tools (${result.tools.length}): ${result.tools.slice(0, 40).join(", ")}${result.tools.length > 40 ? ", …" : ""}\n`
  );
  for (const call of result.calls)
    process.stdout.write(
      `${call.ok ? "OK  " : "FAIL"} ${call.tool}: ${call.text}\n`
    );
  if (result.exited)
    process.stdout.write(
      `SERVER EXITED code=${result.exited.code} signal=${result.exited.signal}\n--- stderr tail ---\n${result.stderrTail}\n`
    );
  process.exit(result.exited || result.calls.some((call) => !call.ok) ? 1 : 0);
}
