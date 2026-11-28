#!/usr/bin/env node

import { execFile } from "node:child_process";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse
} from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { getDefaultRouterLifecycle } from "@simulatorlife/autodev-runtime/router/lifecycle";
import {
  loadRouterState,
  persistRouterStateNow,
  scheduleRouterStatePersist
} from "@simulatorlife/autodev-runtime/router/persistence";
import { getDefaultUsageTracker } from "@simulatorlife/autodev-runtime/router/usage";
import { isEntryPoint } from "@simulatorlife/autodev-runtime/shared/entry-point";
import { writeErrorLine } from "@simulatorlife/autodev-runtime/shared/output";
import type { QuotaAxiResponse } from "quota-axi";

import {
  handleControlApiDiagnosticsRequest,
  setControlApiDiagnosticsRouterStatusSource
} from "../control-api/diagnostics.ts";
import {
  getControlApiAvailability,
  handleControlApiRequest,
  setControlApiDiagnosticsHandler,
  setControlApiLiveSessionsSource,
  setControlApiProviderCheckSource,
  setControlApiProviderCliVersionSource,
  setControlApiProviderModelDiscoverySource,
  setControlApiProviderQuotaAxiSource,
  warmupDefaultPlaytestingRepository
} from "../control-api/request-handler.ts";
import { shutdownDefaultPlaytestRunControl } from "../playtesting/run-control-service.ts";
import { claudeQuotaAxiEnvironment } from "../providers/claude-credential.ts";
import { createProviderCliVersionService } from "../providers/cli-versions.ts";
import { createProviderModelDiscoveryService } from "../providers/model-discovery.ts";
import { findAgyBinary, findClaudeBinary } from "../shared/executables.ts";
import { resolveRuntimePackageManifest } from "../shared/runtime-source-root.ts";
import { SHARED_XACPX_SESSION_MANAGER } from "../xacpx/http.ts";
import {
  resolveXacpxOrchestrationSocketPath,
  startXacpxOrchestrationIpcServer,
  type XacpxOrchestrationIpcHandle
} from "../xacpx/orchestration-ipc.ts";
import {
  agentActivity,
  checkProvider,
  getRouterStatus,
  handle,
  HOST,
  initializeWorkerSharedState,
  PORT,
  recordProviderSignIn
} from "./http.ts";
import { configuredControlApiListener } from "./control-plane-config.ts";
import {
  isClientDisconnectError,
  ROUTER_INSTANCE_ID,
  transportErrorInfo
} from "./proxy.ts";
import { QUOTA_POLL, quotaAxiArgs as quotaAxiArguments } from "./quota-poll.ts";
import type { SharedRouterStateClient } from "./shared-state-ipc.ts";

const IS_MAIN = isEntryPoint(import.meta.url);

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

export function createControlApiServer(): Server {
  const server = createServer(
    (request: IncomingMessage, response: ServerResponse) => {
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
    }
  );
  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 66_000;
  return server;
}

export function startRouterServer(port = PORT, host = HOST): Server {
  loadRouterState();
  const server = createServer((request, response) => {
    void handle(request, response);
  });
  const isLivePollStarted = false;
  let quotaPollInterval: ReturnType<typeof setInterval> | null = null;
  let backgroundWarmupTimer: ReturnType<typeof setTimeout> | null = null;
  let quotaAxiRefresh: Promise<void> | null = null;
  // A quota-axi read still running when the router stops is killed with it,
  // not orphaned to finish a read nobody will publish and write its cache.
  const quotaAxiAbort = new AbortController();
  let controlServer: Server | null = null;
  let xacpxIpcServer: XacpxOrchestrationIpcHandle | null = null;
  let sharedStateClient: SharedRouterStateClient | null = null;
  let isCleanedUp = false;
  let playtestingShutdown: Promise<void> | null = null;
  const modelDiscovery = IS_MAIN
    ? createProviderModelDiscoveryService({
        onSnapshotChanged: scheduleRouterStatePersist,
        onSignIn: recordProviderSignIn
      })
    : null;
  if (modelDiscovery) {
    setControlApiProviderModelDiscoverySource(() => modelDiscovery.snapshot());
  }
  // The CLI versions are read in the background for the same reason the model
  // listings are: reading a version starts a process, and a Control API
  // request must not wait on six CLIs to answer a question about six numbers.
  const cliVersions = IS_MAIN ? createProviderCliVersionService() : null;
  if (cliVersions) {
    setControlApiProviderCliVersionSource(() => cliVersions.snapshot());
    cliVersions.start();
  }
  const runtimePackageRoot = path.dirname(
    resolveRuntimePackageManifest(path.dirname(fileURLToPath(import.meta.url)))
  );
  const runtimeBinDirectory = path.join(
    runtimePackageRoot,
    "node_modules",
    ".bin"
  );
  const quotaAxiExecutable = path.join(runtimeBinDirectory, "quota-axi");
  const refreshQuotaAxi = (): Promise<void> => {
    if (quotaAxiRefresh) return quotaAxiRefresh;
    // quota-axi finds `agy` and `claude` on PATH; a launchd PATH names neither
    // install, so the Runtime adds the directories of the very files its
    // bridges run.
    const cliDirectories = [
      findAgyBinary(process.env),
      findClaudeBinary(process.env)
    ]
      .filter((executable) => executable !== null)
      .map((executable) => path.dirname(executable));
    quotaAxiRefresh = new Promise<void>((resolve, reject) => {
      // A provider whose vendor named a retry moment, or whose last read is
      // younger than its read interval, is not asked on this tick; it keeps
      // its entry meanwhile.
      const plan = QUOTA_POLL.plan(Date.now());
      if (plan === null) {
        // Every provider is waiting. Reading anyway is the request the vendors
        // asked us not to make.
        resolve();
        return;
      }
      execFile(
        quotaAxiExecutable,
        quotaAxiArguments(plan),
        {
          cwd: runtimePackageRoot,
          encoding: "utf8",
          signal: quotaAxiAbort.signal,
          env: claudeQuotaAxiEnvironment({
            ...process.env,
            PATH: [
              runtimeBinDirectory,
              path.dirname(process.execPath),
              ...cliDirectories,
              process.env.PATH
            ]
              .filter(Boolean)
              .join(path.delimiter)
          })
        },
        (error, stdout) => {
          // quota-axi returns 1 when every provider failed, but still emits its
          // authoritative report. Preserve that report instead of interpreting
          // the exit status as a replacement availability model.
          if (error && error.code !== 1) {
            reject(error);
            return;
          }
          try {
            QUOTA_POLL.accept(
              JSON.parse(stdout) as QuotaAxiResponse,
              plan,
              Date.now()
            );
            scheduleRouterStatePersist();
            resolve();
          } catch (parseError) {
            reject(parseError);
          }
        }
      );
    }).finally(() => {
      quotaAxiRefresh = null;
    });
    return quotaAxiRefresh;
  };
  if (IS_MAIN) {
    setControlApiProviderQuotaAxiSource(() => QUOTA_POLL.report);
  }
  setControlApiProviderCheckSource((provider) =>
    checkProvider(
      provider,
      modelDiscovery ? (name) => modelDiscovery.refreshProvider(name) : null
    )
  );
  setControlApiLiveSessionsSource((now) =>
    getDefaultUsageTracker().listLiveSessions(now, agentActivity)!
  );
  // The Control API runs inside the router, so the diagnostics read the live
  // status from this process rather than calling the router over loopback.
  setControlApiDiagnosticsRouterStatusSource(() => getRouterStatus());
  setControlApiDiagnosticsHandler(
    (request, response, pathname, codexHome, repositoryRoot) =>
      handleControlApiDiagnosticsRequest(request, response, pathname, {
        ...(codexHome !== undefined && { codexHome }),
        ...(repositoryRoot !== undefined && { repositoryRoot })
      })
  );
  const closePlaytestingSafely = (): Promise<void> => {
    if (playtestingShutdown !== null) return playtestingShutdown;
    playtestingShutdown = shutdownDefaultPlaytestRunControl().catch(() => {
      writeErrorLine("playtest-run-control: shutdown cancellation failed.");
    });
    return playtestingShutdown;
  };

  const sigtermHandler = (signal: string) => {
    void getDefaultRouterLifecycle()
      .beginShutdown(signal, server, persistRouterStateNow)
      .then(async () => {
        cleanup();
        await closePlaytestingSafely();
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
    cleanup();
    await closePlaytestingSafely();
    handleFatalProcessError("uncaught_exception", error);
  };
  const onUnhandledRejection = async (reason: unknown) => {
    cleanup();
    await closePlaytestingSafely();
    handleFatalProcessError("unhandled_rejection", reason);
  };
  const cleanup = () => {
    if (isCleanedUp) return;
    isCleanedUp = true;
    if (backgroundWarmupTimer !== null) {
      clearTimeout(backgroundWarmupTimer);
      backgroundWarmupTimer = null;
    }
    if (xacpxIpcServer) {
      void xacpxIpcServer.close().catch(() => undefined);
      xacpxIpcServer = null;
    }
    if (sharedStateClient) {
      sharedStateClient.close();
      sharedStateClient = null;
    }
    void SHARED_XACPX_SESSION_MANAGER.closeAllSessions().catch(() => undefined);
    if (quotaPollInterval !== null) {
      clearInterval(quotaPollInterval);
      quotaPollInterval = null;
    }
    quotaAxiAbort.abort();
    if (controlServer?.listening) controlServer.close();
    modelDiscovery?.stop();
    if (modelDiscovery) setControlApiProviderModelDiscoverySource(null);
    cliVersions?.stop();
    if (cliVersions) setControlApiProviderCliVersionSource(null);
    setControlApiProviderQuotaAxiSource(null);
    setControlApiProviderCheckSource(null);
    setControlApiLiveSessionsSource(null);
    setControlApiDiagnosticsRouterStatusSource(null);
    void closePlaytestingSafely();
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
      if (isCleanedUp) return;
      void (async () => {
        try {
          const workerGenerationId =
            process.env.AUTODEV_ROUTER_WORKER_GENERATION?.trim();
          const workerXacpxSocket =
            process.env.AUTODEV_WORKER_XACPX_SOCKET?.trim();
          if (workerGenerationId) {
            sharedStateClient = await initializeWorkerSharedState();
          }
          const bound = server.address();
          if (!bound || typeof bound === "string") {
            throw new Error("Router server did not bind a TCP listener");
          }

          const configuredXacpxSocket =
            process.env.AUTODEV_XACPX_ORCHESTRATION_SOCKET?.trim();
          let startedXacpxSocket: string | null = null;
          if (workerXacpxSocket) {
            const handle = await startXacpxOrchestrationIpcServer({
              socketPath: workerXacpxSocket,
              manager: SHARED_XACPX_SESSION_MANAGER
            });
            if (isCleanedUp) {
              void handle.close().catch(() => undefined);
              return;
            }
            xacpxIpcServer = handle;
            startedXacpxSocket = handle.socketPath;
            writeErrorLine(
              `AutoDev worker XACPX orchestration IPC listening at ${handle.socketPath}`
            );
          } else if (
            configuredXacpxSocket !== "none" &&
            (IS_MAIN || Boolean(configuredXacpxSocket))
          ) {
            const socketPath = resolveXacpxOrchestrationSocketPath(
              undefined,
              process.env
            );
            void startXacpxOrchestrationIpcServer({
              socketPath,
              manager: SHARED_XACPX_SESSION_MANAGER
            })
              .then((handle) => {
                if (isCleanedUp) {
                  void handle.close().catch(() => undefined);
                  return;
                }
                xacpxIpcServer = handle;
                writeErrorLine(
                  `AutoDev XACPX orchestration IPC listening at ${handle.socketPath}`
                );
              })
              .catch(() => {
                writeErrorLine(
                  "AutoDev XACPX orchestration IPC startup failed."
                );
              });
          }

          const controlListener = configuredControlApiListener(port);
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

          if (workerGenerationId && process.send) {
            process.send({
              type: "autodev-router-worker-listening",
              generationId: workerGenerationId,
              port: bound.port,
              ...(startedXacpxSocket !== null && {
                xacpxSocket: startedXacpxSocket
              })
            });
          }

          if (getControlApiAvailability().enabled) {
            try {
              void warmupDefaultPlaytestingRepository().catch(() => {
                writeErrorLine("Playtesting schema startup warmup failed.");
              });
            } catch {
              writeErrorLine("Playtesting schema startup warmup failed.");
            }
          }
          // Defer heavy external provider probes until after both HTTP listeners
          // have bound and can service readiness probes.
          backgroundWarmupTimer = setTimeout(() => {
            backgroundWarmupTimer = null;
            if (isCleanedUp) return;
            modelDiscovery?.start();
            if (!IS_MAIN) {
              return;
            }

            void refreshQuotaAxi().catch(() => undefined);
            quotaPollInterval = setInterval(() => {
              void refreshQuotaAxi().catch(() => undefined);
            }, 60_000);
            quotaPollInterval.unref();
          }, 50);
          backgroundWarmupTimer.unref();
          writeErrorLine(
            `Codex model router listening at http://${host}:${port}`
          );
        } catch (error) {
          cleanup();
          server.close();
          handleFatalProcessError("router_startup_error", error);
        }
      })();
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
  requestClientSurface,
  requestSession,
  resetRouterTelemetry,
  resolveTurnMetadataHeader,
  routingStatus,
  workspaceContextFromRequest,
  workspaceMetadataForSession
} from "./http.ts";
export {
  activeProviderRequests,
  declaredLimit,
  decrementActiveRequests,
  fallbackable,
  getActiveRequests,
  incrementActiveRequests,
  isClientDisconnectError,
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
  subagentStatus,
  THREAD_ID_HEADER,
  UNATTRIBUTED_SUBAGENT_ROLE
} from "./subagents.ts";
export { safeAgentIdentity, safePrivacyWorkspace } from "./usage.ts";
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
