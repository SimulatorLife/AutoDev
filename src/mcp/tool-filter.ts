#!/usr/bin/env node

/** Stdio MCP policy boundary that exposes only the tools assigned to a role. */
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";

type JsonRecord = Record<string, unknown>;
type JsonRpcId = string | number;

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseJson(value: string): JsonRecord | null {
  try {
    const parsed: unknown = JSON.parse(value);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function jsonLine(value: JsonRecord): string {
  return `${JSON.stringify(value)}\n`;
}

function errorResponse(id: JsonRpcId, message: string): JsonRecord {
  return {
    jsonrpc: "2.0",
    id,
    error: { code: -32_601, message }
  };
}

function runToolFilter(args: string[]): void {
  const [command, argsJson, toolsJson] = args;
  if (!command?.trim()) throw new Error("a backend MCP command is required");
  const backendArgs: unknown = JSON.parse(argsJson ?? "null");
  const allowedTools: unknown = JSON.parse(toolsJson ?? "null");
  if (
    !Array.isArray(backendArgs) ||
    !backendArgs.every((arg) => typeof arg === "string")
  )
    throw new Error("backend MCP arguments must be a string array");
  if (
    !Array.isArray(allowedTools) ||
    !allowedTools.every((tool) => typeof tool === "string" && tool.trim())
  )
    throw new Error("allowed MCP tools must be a string array");

  const allowed = new Set<string>(allowedTools);
  const pendingToolLists = new Set<JsonRpcId>();
  const backend = spawn(command, backendArgs, {
    cwd: process.cwd(),
    env: process.env,
    stdio: ["pipe", "pipe", "inherit"]
  });
  const clientLines = createInterface({ input: process.stdin });
  const backendLines = createInterface({ input: backend.stdout! });

  clientLines.on("line", (line) => {
    const message = parseJson(line);
    if (!message) {
      process.stderr.write("role MCP filter received invalid JSON-RPC input\n");
      return;
    }
    const id =
      typeof message.id === "string" || typeof message.id === "number"
        ? message.id
        : null;
    if (message.method === "tools/list" && id !== null)
      pendingToolLists.add(id);
    if (message.method === "tools/call") {
      const params = isRecord(message.params) ? message.params : null;
      const toolName = params?.name;
      if (
        id === null ||
        typeof toolName !== "string" ||
        !allowed.has(toolName)
      ) {
        if (id !== null)
          process.stdout.write(
            jsonLine(errorResponse(id, "Tool is not enabled for this role"))
          );
        return;
      }
    }
    backend.stdin?.write(`${line}\n`);
  });

  backendLines.on("line", (line) => {
    const message = parseJson(line);
    const result = message && isRecord(message.result) ? message.result : null;
    if (
      message &&
      (typeof message.id === "string" || typeof message.id === "number") &&
      pendingToolLists.delete(message.id) &&
      result &&
      Array.isArray(result.tools)
    ) {
      message.result = {
        ...result,
        tools: result.tools.filter(
          (tool) =>
            isRecord(tool) &&
            typeof tool.name === "string" &&
            allowed.has(tool.name)
        )
      };
      process.stdout.write(jsonLine(message));
      return;
    }
    process.stdout.write(`${line}\n`);
  });

  clientLines.on("close", () => {
    if (backend.exitCode === null && backend.signalCode === null)
      backend.kill("SIGTERM");
  });
  backend.on("error", (error) => {
    process.stderr.write(
      `role MCP backend failed to start: ${error.message}\n`
    );
    process.exitCode = 1;
  });
  backend.on("close", (code) => {
    process.exitCode = code ?? 1;
    clientLines.close();
    backendLines.close();
    process.stdin.pause();
    process.stdin.destroy();
  });
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => {
      if (!backend.killed) backend.kill(signal);
    });
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    runToolFilter(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(
      `role MCP filter: ${error instanceof Error ? error.message : String(error)}\n`
    );
    process.exitCode = 2;
  }
}

export { errorResponse, runToolFilter };
