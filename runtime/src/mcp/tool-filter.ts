#!/usr/bin/env node

/** Stdio MCP policy boundary that exposes only the tools assigned to a role or external gateway. */
import { type ChildProcess, spawn } from "node:child_process";
import { createInterface } from "node:readline";

import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { isRecord } from "@simulatorlife/autodev-core";
import { isEntryPoint } from "@simulatorlife/autodev-runtime/shared/entry-point";
import type { RemoteBackendSpec } from "../shared/mcp-headers.ts";
import {
  KEYCHAIN_SECRET_NAMES,
  readRuntimeSecret
} from "../shared/runtime-secrets.ts";
import {
  MCP_SERVER_COCOINDEX,
  MCP_SERVER_FILESYSTEM
} from "../shared/tool-names.ts";
import type { ToolCallOutcome } from "./mcp-telemetry.ts";
import {
  createRemoteMcpTransport,
  publicRemoteMcpMessage,
  remoteTransportErrorMessage
} from "./remote-transport.ts";

function signalProcessGroup(
  child: ChildProcess,
  signal: NodeJS.Signals
): void {
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform !== "win32" && typeof child.pid === "number") {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      /* Process group already exited or differs; fall through to direct signal. */
    }
  }
  try {
    child.kill(signal);
  } catch {
    /* Already exited. */
  }
}

type JsonRecord = Record<string, unknown>;
type JsonRpcId = string | number;

interface BackendConnection {
  send(message: JsonRecord): void;
  close(): void;
  kill(): void;
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
  const [command, argsJson, toolsJson, profile, server] = args;
  const external = profile === "external";
  if (
    profile !== undefined &&
    (!external || !server || !/^[a-zA-Z0-9_-]+$/u.test(server))
  )
    throw new Error("Invalid MCP filter profile");
  let telemetryModulePromise: Promise<
    typeof import("./mcp-telemetry.ts")
  > | null = null;
  const loadTelemetry = () => {
    if (!telemetryModulePromise) {
      telemetryModulePromise = import("./mcp-telemetry.ts").then((mod) => {
        const token = readRuntimeSecret("OPENLIT_OTLP_API_KEY");
        mod.configureExternalMcpTelemetry(
          server!,
          "http://127.0.0.1:4318/v1/traces",
          token ? { Authorization: "Bearer " + token } : {}
        );
        return mod;
      });
    }
    return telemetryModulePromise;
  };
  if (!command?.trim()) throw new Error("a backend MCP command is required");
  const isRemote = command === "--remote";
  let remoteSpec: RemoteBackendSpec | null = null;
  let backendArgs: string[] = [];
  if (isRemote) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(argsJson ?? "null");
    } catch {
      throw new Error("remote MCP descriptor is invalid");
    }
    if (
      !isRecord(parsed) ||
      typeof parsed.url !== "string" ||
      !parsed.url.trim() ||
      (parsed.bearer_token_env_var !== undefined &&
        typeof parsed.bearer_token_env_var !== "string") ||
      (parsed.http_headers !== undefined &&
        (!isRecord(parsed.http_headers) ||
          !Object.values(parsed.http_headers).every(
            (value) => typeof value === "string"
          )))
    ) {
      throw new Error("remote MCP descriptor is invalid");
    }
    remoteSpec = parsed as unknown as RemoteBackendSpec;
  } else {
    const parsedArgs: unknown = JSON.parse(argsJson ?? "null");
    if (
      !Array.isArray(parsedArgs) ||
      !parsedArgs.every((arg) => typeof arg === "string")
    )
      throw new Error("backend MCP arguments must be a string array");
    backendArgs = parsedArgs;
  }
  const allowedTools: unknown = JSON.parse(toolsJson ?? "null");
  if (
    !Array.isArray(allowedTools) ||
    !allowedTools.every((tool) => typeof tool === "string" && tool.trim())
  )
    throw new Error("allowed MCP tools must be a string array");

  const allowed = new Set<string>(allowedTools);
  const pendingToolLists = new Set<JsonRpcId>();
  const pendingInitialize = new Map<JsonRpcId, string | undefined>();
  const deadlines = new Map<JsonRpcId, NodeJS.Timeout>();
  const cancelledRequests = new Set<JsonRpcId>();
  const observations = new Map<JsonRpcId, (outcome: ToolCallOutcome) => void>();
  const spans = new Set<Promise<ToolCallOutcome>>();
  const finish = (id: JsonRpcId, outcome: ToolCallOutcome): void => {
    const resolve = observations.get(id);
    observations.delete(id);
    resolve?.(outcome);
  };
  const clientMethods = new Set([
    "initialize",
    "ping",
    "tools/list",
    "tools/call",
    "tasks/get",
    "tasks/list",
    "tasks/result",
    "tasks/cancel",
    "notifications/initialized",
    "notifications/cancelled"
  ]);
  const clearDeadline = (id: JsonRpcId): void => {
    const timer = deadlines.get(id);
    if (timer) clearTimeout(timer);
    deadlines.delete(id);
  };
  const armDeadline = (id: JsonRpcId, milliseconds: number): void => {
    const timer = setTimeout(() => {
      clearDeadline(id);
      finish(id, { status: "error", errorType: "timeout" });
      process.stdout.write(
        jsonLine(errorResponse(id, "External MCP request timed out"))
      );
      connection.kill();
    }, milliseconds);
    timer.unref();
    deadlines.set(id, timer);
  };

  const clientLines = createInterface({ input: process.stdin });

  const shutdownFromBackend = (code: number, exitWhenFlushed = false): void => {
    if (external) {
      for (const id of deadlines.keys()) clearDeadline(id);
      for (const id of observations.keys())
        finish(id, { status: "error", errorType: "backend_closed" });
      if (telemetryModulePromise) {
        const flushed = Promise.allSettled([...spans]).then(() =>
          telemetryModulePromise!.then(
            (telemetry) => telemetry.shutdownTelemetry(),
            () => {}
          )
        );
        if (exitWhenFlushed) {
          void Promise.race([
            flushed,
            new Promise((resolve) => setTimeout(resolve, 400).unref())
          ]).finally(() => process.exit(code));
        }
      } else if (exitWhenFlushed) {
        process.exit(code);
      }
    } else if (exitWhenFlushed) {
      process.exit(code);
    }
    process.exitCode = code;
    clientLines.close();
    process.stdin.pause();
    process.stdin.destroy();
  };

  const handleBackendMessage = (
    message: JsonRecord | null,
    rawLine?: string
  ): void => {
    const result = message && isRecord(message.result) ? message.result : null;
    if (external) {
      if (!message) return;
      const id =
        typeof message.id === "string" || typeof message.id === "number"
          ? message.id
          : null;
      if (typeof message.method === "string") {
        if (id !== null)
          connection.send(
            errorResponse(
              id,
              "MCP client capability is not externally approved"
            )
          );
        else if (
          message.method === "notifications/tools/list_changed" ||
          message.method === "notifications/progress"
        )
          process.stdout.write(jsonLine(message));
        return;
      }
      if (id !== null) {
        if (!deadlines.has(id)) return;
        clearDeadline(id);
        if (cancelledRequests.delete(id)) {
          pendingToolLists.delete(id);
          pendingInitialize.delete(id);
          return;
        }
        finish(
          id,
          message.error || result?.isError === true
            ? { status: "error", errorType: "tool_error" }
            : { status: "ok" }
        );
        const requestedProtocol = pendingInitialize.get(id);
        if (pendingInitialize.delete(id) && result) {
          const capabilities = isRecord(result.capabilities)
            ? result.capabilities
            : {};
          // Keep all external filtered backends on a single tool-only protocol
          // version so Supergateway's CombinedServers does not tear down and
          // restart higher-version backends on every new session handshake.
          const negotiatedProtocol =
            requestedProtocol === "2024-11-05" ? "2024-11-05" : "2025-03-26";
          message.result = {
            protocolVersion: negotiatedProtocol,
            serverInfo: result.serverInfo,
            capabilities: {
              tools: isRecord(capabilities.tools) ? capabilities.tools : {},
              ...(isRecord(capabilities.tasks)
                ? { tasks: capabilities.tasks }
                : {})
            }
          };
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
        )
      };
      process.stdout.write(jsonLine(message));
      return;
    }
    process.stdout.write(
      rawLine !== undefined ? `${rawLine}\n` : jsonLine(message!)
    );
  };

  let connection: BackendConnection;
  if (remoteSpec) {
    const spec = remoteSpec;
    const transport = createRemoteMcpTransport(spec, server ?? "", process.env);
    let closed = false;
    transport.onmessage = (message) => {
      handleBackendMessage(
        publicRemoteMcpMessage(message) as unknown as JsonRecord
      );
    };
    transport.onerror = (error) => {
      process.stderr.write(
        `external remote MCP error: ${remoteTransportErrorMessage(error)}\n`
      );
    };
    transport.onclose = () => {
      if (!closed) {
        closed = true;
        shutdownFromBackend(0);
      }
    };
    let sendChain: Promise<void> = Promise.resolve();
    connection = {
      send(message) {
        if (closed) return;
        sendChain = sendChain.then(async () => {
          if (closed) return;
          try {
            await transport.send(message as unknown as JSONRPCMessage);
          } catch (error) {
            const id =
              typeof message.id === "string" || typeof message.id === "number"
                ? message.id
                : null;
            if (id !== null && deadlines.has(id)) {
              clearDeadline(id);
              finish(id, { status: "error", errorType: "tool_error" });
              pendingInitialize.delete(id);
              pendingToolLists.delete(id);
              process.stdout.write(
                jsonLine(
                  errorResponse(
                    id,
                    remoteTransportErrorMessage(error)
                  )
                )
              );
            }
          }
        });
      },
      close() {
        if (closed) return;
        closed = true;
        void Promise.race([
          transport.terminateSession().catch(() => {}),
          new Promise((resolve) => setTimeout(resolve, 300).unref())
        ])
          .finally(() => transport.close().catch(() => {}))
          .finally(() => shutdownFromBackend(0, true));
      },
      kill() {
        connection.close();
      }
    };
  } else {
    const sandboxed = external && command === "/usr/bin/sandbox-exec";
    let childEnv: NodeJS.ProcessEnv;
    if (sandboxed && server === MCP_SERVER_FILESYSTEM) {
      childEnv = {
        HOME: process.cwd(),
        PATH: "/usr/bin:/bin",
        LANG: "en_US.UTF-8"
      };
    } else if (external) {
      childEnv = {
        ...(sandboxed && server === MCP_SERVER_COCOINDEX
          ? {
              // Outbound HTTPS is blocked inside Seatbelt; avoid huggingface_hub
              // network probe stalls when initializing/querying cached models.
              HF_HUB_OFFLINE: "1",
              TRANSFORMERS_OFFLINE: "1"
            }
          : {}),
        ...process.env
      };
      for (const secretName of [
        ...KEYCHAIN_SECRET_NAMES,
        "OPENAI_ADMIN_KEY",
        "OPENLIT_OTLP_API_KEY"
      ]) {
        delete childEnv[secretName];
      }
    } else {
      childEnv = process.env;
    }
    const backend = spawn(command, backendArgs, {
      cwd: process.cwd(),
      env: childEnv,
      detached: process.platform !== "win32",
      stdio: ["pipe", "pipe", "inherit"]
    });
    const backendLines = createInterface({ input: backend.stdout! });
    backendLines.on("line", (line) => {
      handleBackendMessage(parseJson(line), line);
    });
    backend.on("error", (error) => {
      process.stderr.write(
        external
          ? "external MCP backend failed to start\n"
          : `role MCP backend failed to start: ${error.message}\n`
      );
      process.exitCode = 1;
    });
    backend.on("close", (code) => {
      backendLines.close();
      shutdownFromBackend(code ?? 1, external);
    });
    connection = {
      send(message) {
        backend.stdin?.write(jsonLine(message));
      },
      close() {
        if (backend.exitCode === null && backend.signalCode === null) {
          signalProcessGroup(backend, "SIGTERM");
          if (external) {
            const timer = setTimeout(() => {
              if (backend.exitCode === null && backend.signalCode === null)
                signalProcessGroup(backend, "SIGKILL");
            }, 5000);
            timer.unref();
          }
        }
      },
      kill() {
        if (backend.exitCode === null && backend.signalCode === null)
          signalProcessGroup(backend, "SIGKILL");
      }
    };
  }

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
    if (
      external &&
      (typeof message.method !== "string" || !clientMethods.has(message.method))
    ) {
      if (id !== null && typeof message.method === "string")
        process.stdout.write(
          jsonLine(
            errorResponse(id, "MCP capability is not externally approved")
          )
        );
      return;
    }
    if (external && id !== null && deadlines.has(id)) {
      process.stdout.write(
        jsonLine(errorResponse(id, "Duplicate outstanding MCP request"))
      );
      return;
    }
    if (external && message.method === "initialize" && id !== null) {
      const requested = isRecord(message.params)
        ? typeof message.params.protocolVersion === "string"
          ? message.params.protocolVersion
          : undefined
        : undefined;
      pendingInitialize.set(id, requested);
      if (isRecord(message.params))
        message.params = { ...message.params, capabilities: {} };
    }
    if (
      external &&
      message.method === "notifications/cancelled" &&
      isRecord(message.params)
    ) {
      const cancelled = message.params.requestId;
      if (typeof cancelled === "number" || typeof cancelled === "string") {
        if (deadlines.has(cancelled)) {
          finish(cancelled, { status: "error", errorType: "cancelled" });
          clearDeadline(cancelled);
          // The upstream may ignore cancellation. End that backend session
          // if it has not answered within the bounded cancellation grace.
          const timer = setTimeout(() => connection.kill(), 5000);
          timer.unref();
          deadlines.set(cancelled, timer);
          cancelledRequests.add(cancelled);
        }
      }
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
          process.stdout.write(
            jsonLine(errorResponse(id, "Duplicate outstanding MCP request"))
          );
          return;
        }
        const outcome = new Promise<ToolCallOutcome>((resolve) =>
          observations.set(id, resolve)
        );
        const span = loadTelemetry().then(
          (telemetry) =>
            telemetry.recordToolCallSpan(
              toolName,
              () => outcome,
              params?._meta
            ),
          () => outcome
        );
        spans.add(span);
        void span.then(
          () => spans.delete(span),
          () => spans.delete(span)
        );
      }
    }
    if (external && id !== null)
      armDeadline(id, message.method === "tools/call" ? 60_000 : 15_000);
    if (external) connection.send(message);
    else connection.send(parseJson(line) ?? message);
  });

  clientLines.on("close", () => {
    connection.close();
  });
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => {
      connection.close();
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
