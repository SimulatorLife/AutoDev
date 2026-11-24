#!/usr/bin/env node

/** Stdio MCP policy boundary that exposes only the tools assigned to a role. */
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

import { isRecord } from "@simulatorlife/autodev-core";
import { isEntryPoint } from "@simulatorlife/autodev-runtime/shared/entry-point";
import { readRuntimeSecret } from "../shared/runtime-secrets.ts";
import { configureExternalMcpTelemetry, recordToolCallSpan, shutdownTelemetry, type ToolCallOutcome } from "./codex-tools-shim-telemetry.ts";

type JsonRecord = Record<string, unknown>;
type JsonRpcId = string | number;

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
  const [command, argsJson, toolsJson, profile, server] = args;
  const external = profile === "external";
  if (profile !== undefined && (!external || !server || !/^[a-zA-Z0-9_-]+$/u.test(server)))
    throw new Error("Invalid MCP filter profile");
  if (external) {
    const token = readRuntimeSecret("OPENLIT_OTLP_API_KEY");
    configureExternalMcpTelemetry(server!, "http://127.0.0.1:4318/v1/traces", token ? { Authorization: "Bearer " + token } : {});
  }
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
  const pendingInitialize = new Set<JsonRpcId>();
  const observations = new Map<JsonRpcId, (outcome: ToolCallOutcome) => void>();
  const spans = new Set<Promise<ToolCallOutcome>>();
  const finish = (id: JsonRpcId, outcome: ToolCallOutcome): void => {
    const resolve = observations.get(id);
    observations.delete(id);
    resolve?.(outcome);
  };
  const clientMethods = new Set(["initialize", "ping", "tools/list", "tools/call", "notifications/initialized", "notifications/cancelled"]);
  const backend = spawn(command, backendArgs, {
    cwd: process.cwd(),
    env: external && command === "/usr/bin/sandbox-exec"
      ? { HOME: process.cwd(), PATH: "/usr/bin:/bin", LANG: "en_US.UTF-8" }
      : process.env,
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
    if (external && (typeof message.method !== "string" || !clientMethods.has(message.method))) {
      if (id !== null && typeof message.method === "string") process.stdout.write(jsonLine(errorResponse(id, "MCP capability is not externally approved")));
      return;
    }
    if (external && message.method === "initialize" && id !== null) {
      pendingInitialize.add(id);
      if (isRecord(message.params)) message.params = { ...message.params, capabilities: {} };
    }
    if (external && message.method === "notifications/cancelled" && isRecord(message.params)) {
      const cancelled = message.params.requestId;
      if (typeof cancelled === "number" || typeof cancelled === "string") finish(cancelled, { status: "error", errorType: "cancelled" });
    }
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
      if (external) {
        if (observations.has(id)) {
          process.stdout.write(jsonLine(errorResponse(id, "Duplicate outstanding MCP request")));
          return;
        }
        const outcome = new Promise<ToolCallOutcome>((resolve) => observations.set(id, resolve));
        const span = recordToolCallSpan(toolName, () => outcome, params?._meta);
        spans.add(span);
        void span.then(() => spans.delete(span), () => spans.delete(span));
      }
    }
    backend.stdin?.write(external ? jsonLine(message) : `${line}\n`);
  });

  backendLines.on("line", (line) => {
    const message = parseJson(line);
    const result = message && isRecord(message.result) ? message.result : null;
    if (external) {
      if (!message) return;
      const id = typeof message.id === "string" || typeof message.id === "number" ? message.id : null;
      if (typeof message.method === "string") {
        if (id !== null) backend.stdin?.write(jsonLine(errorResponse(id, "MCP client capability is not externally approved")));
        else if (message.method === "notifications/tools/list_changed" || message.method === "notifications/progress") process.stdout.write(jsonLine(message));
        return;
      }
      if (id !== null) {
        finish(id, message.error || result?.isError === true ? { status: "error", errorType: "tool_error" } : { status: "ok" });
        if (pendingInitialize.delete(id) && result) {
          const capabilities = isRecord(result.capabilities) ? result.capabilities : {};
          message.result = { protocolVersion: result.protocolVersion, serverInfo: result.serverInfo, capabilities: { tools: isRecord(capabilities.tools) ? capabilities.tools : {} } };
          process.stdout.write(jsonLine(message));
          return;
        }
      }
    }
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
        ).map((tool) => external ? { ...tool, annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } } : tool)
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
    process.stderr.write(external ? "external MCP backend failed to start\n" : `role MCP backend failed to start: ${error.message}\n`);
    process.exitCode = 1;
  });
  backend.on("close", (code) => {
    if (external) {
      for (const id of observations.keys()) finish(id, { status: "error", errorType: "backend_closed" });
      void Promise.allSettled([...spans]).then(() => shutdownTelemetry());
    }
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

if (isEntryPoint(import.meta.url)) {
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
