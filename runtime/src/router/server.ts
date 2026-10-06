#!/usr/bin/env node

import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse
} from "node:http";
import { pathToFileURL } from "node:url";

import { beginShutdown } from "@simulatorlife/autodev-runtime/router/lifecycle";
import {
  loadRouterState,
  persistRouterStateNow
} from "@simulatorlife/autodev-runtime/router/persistence";
import { writeErrorLine } from "@simulatorlife/autodev-runtime/shared/output";

import { handleControlApiRequest } from "../control-api/index.ts";
import { codexState, handle, HOST, PORT, refreshCodexState } from "./http.ts";
import { closeOrchestratorMemoryHost } from "./memory-injection.ts";
import {
  isClientDisconnectError,
  ROUTER_INSTANCE_ID,
  transportErrorInfo
} from "./proxy.ts";

const IS_MAIN = Boolean(
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
);

let fatalExitPromise: Promise<void> | null = null;

export function handleFatalProcessError(phase: string, reason: unknown): void {
  if (fatalExitPromise) return;
  const info = transportErrorInfo(reason);
  if (phase === "uncaught_exception" && isClientDisconnectError(reason)) {
    writeErrorLine(
      JSON.stringify({
        schema: "autodev-router-event-v1",
        timestamp: new Date().toISOString(),
        routerInstanceId: ROUTER_INSTANCE_ID,
        requestId: null,
        phase: "client_disconnect_ignored",
        errorName: info.name,
        errorCode: info.code,
        syscall: info.syscall
      })
    );
    return;
  }
  writeErrorLine(
    JSON.stringify({
      schema: "autodev-router-event-v1",
      timestamp: new Date().toISOString(),
      routerInstanceId: ROUTER_INSTANCE_ID,
      requestId: null,
      phase,
      errorName: info.name,
      errorCode: info.code,
      syscall: info.syscall
    })
  );
  fatalExitPromise = persistRouterStateNow()
    .catch(() => undefined)
    .finally(() => process.exit(1));
}

async function closeMemoryHostSafely(): Promise<void> {
  try {
    await closeOrchestratorMemoryHost();
  } catch (error) {
    const info = transportErrorInfo(error);
    writeErrorLine(
      JSON.stringify({
        schema: "autodev-router-event-v1",
        timestamp: new Date().toISOString(),
        routerInstanceId: ROUTER_INSTANCE_ID,
        requestId: null,
        phase: "memory_pool_close_failed",
        errorName: info.name,
        errorCode: info.code,
        syscall: info.syscall
      })
    );
  }
}

export function createControlApiServer(): Server {
  return createServer((request: IncomingMessage, response: ServerResponse) => {
    let pathname: string;
    try {
      pathname = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
    } catch {
      response.writeHead(400, { "cache-control": "no-store" });
      response.end();
      return;
    }
    if (!pathname.startsWith("/control/")) {
      response.writeHead(404, { "cache-control": "no-store" });
      response.end();
      return;
    }
    void (async () => {
      try {
        const handled = await handleControlApiRequest(
          request,
          response,
          pathname
        );
        if (handled) return;
        response.writeHead(404, { "cache-control": "no-store" });
        response.end();
      } catch {
        if (response.headersSent) {
          response.destroy();
          return;
        }
        response.writeHead(500, { "cache-control": "no-store" });
        response.end();
      }
    })();
  });
}

function configuredControlApiListener(): { host: string; port: number } | null {
  const host = process.env.AUTODEV_CONTROL_API_LISTEN_HOST?.trim();
  if (!host) return null;
  const rawPort = process.env.AUTODEV_CONTROL_API_LISTEN_PORT?.trim();
  const port = rawPort ? Number(rawPort) : 4101;
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(
      "AUTODEV_CONTROL_API_LISTEN_PORT must be between 1 and 65535."
    );
  }
  return { host, port };
}

export function startRouterServer(port = PORT, host = HOST): Server {
  loadRouterState();
  const server = createServer((request, response) => {
    void handle(request, response);
  });
  let livePollStarted = false;
  let controlServer: Server | null = null;
  let cleanedUp = false;

  const sigtermHandler = (signal: string) => {
    void beginShutdown(signal, server, persistRouterStateNow).then(async () => {
      cleanup();
      await closeMemoryHostSafely();
      process.exit(0);
    });
  };
  const onSigint = () => sigtermHandler("SIGINT");
  const onSigterm = () => sigtermHandler("SIGTERM");
  const onUncaughtException = async (error: Error) => {
    // Client disconnects are intentionally ignored; keep the live server resources.
    if (isClientDisconnectError(error)) {
      handleFatalProcessError("uncaught_exception", error);
      return;
    }
    await closeMemoryHostSafely();
    cleanup();
    handleFatalProcessError("uncaught_exception", error);
  };
  const onUnhandledRejection = async (reason: unknown) => {
    await closeMemoryHostSafely();
    cleanup();
    handleFatalProcessError("unhandled_rejection", reason);
  };
  const cleanup = () => {
    if (cleanedUp) return;
    cleanedUp = true;
    if (livePollStarted) {
      codexState.collector.stopLivePoll();
      codexState.livePollStarted = false;
    }
    if (controlServer?.listening) controlServer.close();
    void closeMemoryHostSafely();
    process.off("uncaughtException", onUncaughtException);
    process.off("unhandledRejection", onUnhandledRejection);
    process.off("SIGINT", onSigint);
    process.off("SIGTERM", onSigterm);
    server.off("close", cleanup);
  };

  server.once("close", cleanup);
  process.on("uncaughtException", onUncaughtException);
  process.on("unhandledRejection", onUnhandledRejection);
  process.on("SIGINT", onSigint);
  process.on("SIGTERM", onSigterm);
  try {
    server.listen(port, host, () => {
      if (cleanedUp) return;
      try {
        if (!codexState.livePollStarted) {
          livePollStarted = true;
          codexState.livePollStarted = true;
          codexState.collector.startLivePoll();
        }
        void refreshCodexState();
        const controlListener = configuredControlApiListener();
        if (controlListener) {
          controlServer = createControlApiServer();
          controlServer.once("error", (error) => {
            cleanup();
            server.close();
            handleFatalProcessError("control_api_listener_error", error);
          });
          controlServer.listen(
            controlListener.port,
            controlListener.host,
            () => {
              writeErrorLine(
                `AutoDev Control API listening at http://${controlListener.host}:${controlListener.port}`
              );
            }
          );
        }
        writeErrorLine(
          `Codex model router listening at http://${host}:${port}`
        );
      } catch (error) {
        cleanup();
        server.close();
        handleFatalProcessError("router_startup_error", error);
      }
    });
  } catch (error) {
    cleanup();
    throw error;
  }
  return server;
}

if (IS_MAIN) {
  startRouterServer(PORT, HOST);
}

export {
  AGENT_ACTIVITY_TTL_MS,
  agentActivity,
  agentsStatus,
  getRouterStatus,
  handle,
  handleRequest,
  ingestAgentEvents,
  limitsStatus,
  loadCatalog,
  refreshCodexState,
  requestSession,
  resetRouterTelemetry,
  resolveTurnMetadataHeader,
  routingStatus,
  setCodexStateSnapshotForTests,
  workspaceContextFromRequest,
  workspaceMetadataForSession
} from "./http.ts";
export {
  autodevEnrichOtlpPayload,
  codexTelemetryStatus,
  ingestOtelLogs,
  ingestOtelMetrics,
  ingestOtelSignal,
  ingestOtelTraces,
  isAutodevAttributesEnabled,
  OTEL_PERSISTENCE_SCHEMA_VERSION,
  otelPersistenceSnapshot,
  resetOtelTelemetry,
  resolveTelemetryContext,
  restoreOtelTelemetry
} from "./otel.ts";
export {
  activeProviderRequests,
  carriesPendingToolResult,
  declaredLimit,
  decrementActiveRequests,
  downstreamHeaders,
  fallbackable,
  getActiveRequests,
  incrementActiveRequests,
  isClientDisconnectError,
  payloadForCandidate,
  proxyConcreteResponse,
  proxyOrchestratorResponse,
  proxyRoleResponse,
  recordNativeMcpExposure,
  ROUTER_INSTANCE_ID
} from "./proxy.ts";
export {
  AGENT_EVENTS_PATH,
  AGENT_EVENTS_URL_HEADER,
  bridgeTelemetryHeaders,
  closeBridgeSubagentsForRequest,
  FORWARDED_REQUEST_HEADERS,
  hasActiveBridgeSubagentsForSession,
  lookupBridgeSessionContext,
  mcpContractForRole,
  noteBridgeRequest,
  noteBridgeSession,
  noteOrchestratorSession,
  ORCHESTRATOR_AGENT_ROLE,
  orchestratorProviderForSession,
  orchestratorSessionInfo,
  providerCapabilities,
  recallBridgeSessionRequestId,
  recordSpawnFailure,
  recordSubagentSpawn,
  resetSubagentTelemetry,
  roleCapabilityRequirements,
  SESSION_ID_HEADER,
  SESSION_SCOPE_HEADER,
  spawnFailureStatus,
  SUBAGENT_SPAWN_TOOLS_HEADER,
  subagentSpawnToolsFor,
  subagentStatus,
  UNATTRIBUTED_SUBAGENT_ROLE
} from "./subagents.ts";
export {
  attributionDiagnosticsStatus,
  projectLiveAgents,
  registerWorkspaceId,
  resetAttributionDiagnostics,
  safeAgentIdentity,
  safePrivacyWorkspace,
  usageStatus
} from "./usage.ts";
export {
  isLoopbackAddress,
  routerAuthorizationValid,
  setRouterAuthTokenForTests
} from "@simulatorlife/autodev-runtime/router/auth";
export {
  parseConcurrencyConfig,
  PROCESS_FALLBACK_SESSION_KEY
} from "@simulatorlife/autodev-runtime/router/concurrency";
export {
  classifyProviderFailure,
  recordRouterEvent
} from "@simulatorlife/autodev-runtime/router/events";
export {
  loadRouterState,
  persistRouterStateNow,
  serializeRouterState
} from "@simulatorlife/autodev-runtime/router/persistence";
