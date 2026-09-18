#!/usr/bin/env node

import { createServer, type Server } from 'node:http';
import { pathToFileURL } from 'node:url';

import {
  PORT,
  HOST,
  codexState,
  refreshCodexState,
  setCodexStateSnapshotForTests,
  getRouterStatus,
  agentsStatus,
  routingStatus,
  limitsStatus,
  handle,
  handleRequest,
  ingestAgentEvents,
  resetRouterTelemetry,
  requestSession,
  workspaceContextFromRequest,
  workspaceMetadataForSession,
  parseTurnMetadataJson,
  resolveTurnMetadataHeader,
  loadCatalog,
  AGENT_ACTIVITY_TTL_MS,
  agentActivity,
} from './http.ts';

import {
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
  ROUTER_INSTANCE_ID,
  transportErrorInfo,
} from './proxy.ts';

import {
  isLoopbackAddress,
  routerAuthorizationValid,
  setRouterAuthTokenForTests,
} from './auth.ts';

import {
  beginShutdown,
  getLifecycleStatus,
  isDraining,
  resetLifecycleForTests,
} from './lifecycle.ts';

import {
  concurrencyStatus,
  parseConcurrencyConfig,
  PROCESS_FALLBACK_SESSION_KEY,
  recordConcurrencyDenial,
  releaseSubagentSlot,
  resetConcurrencyTelemetry,
  tryAcquireSubagentSlot,
} from './concurrency.ts';

import {
  classifyProviderFailure,
  recordRouterEvent,
} from './events.ts';

import {
  AGENT_EVENTS_PATH,
  AGENT_EVENTS_URL_HEADER,
  AGENT_ROLE_HEADER,
  bridgeTelemetryHeaders,
  closeBridgeSubagentsForRequest,
  FORWARDED_REQUEST_HEADERS,
  lookupBridgeSessionContext,
  mcpContractForRole,
  noteBridgeRequest,
  noteBridgeSession,
  noteOrchestratorSession,
  orchestratorProviderForSession,
  orchestratorSessionInfo,
  hasActiveBridgeSubagentsForSession,
  ORCHESTRATOR_AGENT_ROLE,
  providerCapabilities,
  recallBridgeSessionRequestId,
  recordSpawnFailure,
  recordSubagentSpawn,
  resetSubagentTelemetry,
  roleCapabilityRequirements,
  SESSION_ID_HEADER,
  SESSION_SCOPE_HEADER,
  spawnFailureStatus,
  subagentSpawnToolsFor,
  subagentStatus,
  SUBAGENT_SPAWN_TOOLS_HEADER,
  UNATTRIBUTED_SUBAGENT_ROLE,
} from './subagents.ts';

import {
  attributionDiagnosticsStatus,
  projectLiveAgents,
  registerWorkspaceId,
  resetAttributionDiagnostics,
  usageStatus,
  safeAgentIdentity,
  safePrivacyWorkspace,
} from './usage.ts';

import {
  autodevEnrichOtlpPayload,
  codexTelemetryStatus,
  ingestOtelLogs,
  ingestOtelMetrics,
  ingestOtelSignal,
  ingestOtelTraces,
  isAutodevAttributesEnabled,
  otelPersistenceSnapshot,
  OTEL_PERSISTENCE_SCHEMA_VERSION,
  resetOtelTelemetry,
  resolveTelemetryContext,
  restoreOtelTelemetry,
} from './otel.ts';

import {
  loadRouterState,
  persistRouterStateNow,
  serializeRouterState,
} from './persistence.ts';

import {
  ORCHESTRATOR_ALIAS,
} from './routing.ts';

const IS_MAIN = Boolean(process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href);

let fatalExitPromise: Promise<void> | null = null;

export function handleFatalProcessError(phase: string, reason: unknown): void {
  if (fatalExitPromise) return;
  const info = transportErrorInfo(reason);
  if (phase === 'uncaught_exception' && isClientDisconnectError(reason)) {
    console.error(JSON.stringify({
      schema: 'autodev-router-event-v1',
      timestamp: new Date().toISOString(),
      routerInstanceId: ROUTER_INSTANCE_ID,
      requestId: null,
      phase: 'client_disconnect_ignored',
      errorName: info.name,
      errorCode: info.code,
      syscall: info.syscall,
    }));
    return;
  }
  console.error(JSON.stringify({
    schema: 'autodev-router-event-v1',
    timestamp: new Date().toISOString(),
    routerInstanceId: ROUTER_INSTANCE_ID,
    requestId: null,
    phase,
    errorName: info.name,
    errorCode: info.code,
    syscall: info.syscall,
  }));
  fatalExitPromise = persistRouterStateNow()
    .catch(() => undefined)
    .finally(() => process.exit(1));
}

export function startRouterServer(port = PORT, host = HOST): Server {
  loadRouterState();
  process.on('uncaughtException', (error) => handleFatalProcessError('uncaught_exception', error));
  process.on('unhandledRejection', (reason) => handleFatalProcessError('unhandled_rejection', reason));
  void refreshCodexState();
  if (!codexState.livePollStarted) {
    codexState.collector.startLivePoll();
    codexState.livePollStarted = true;
  }
  const server = createServer((request, response) => { void handle(request, response); });
  const sigtermHandler = (signal: string) => { void beginShutdown(signal, server); };
  process.on('SIGINT', () => sigtermHandler('SIGINT'));
  process.on('SIGTERM', () => sigtermHandler('SIGTERM'));
  server.listen(port, host, () => {
    console.error(`Codex model router listening at http://${host}:${port}`);
  });
  return server;
}

if (IS_MAIN) {
  startRouterServer(PORT, HOST);
}

export {
  refreshCodexState,
  activeProviderRequests,
  AGENT_ROLE_HEADER,
  ORCHESTRATOR_AGENT_ROLE,
  beginShutdown,
  proxyConcreteResponse,
  proxyOrchestratorResponse,
  proxyRoleResponse,
  ORCHESTRATOR_ALIAS,
  payloadForCandidate,
  classifyProviderFailure,
  codexTelemetryStatus,
  setCodexStateSnapshotForTests,
  declaredLimit,
  concurrencyStatus,
  agentsStatus,
  decrementActiveRequests,
  downstreamHeaders,
  fallbackable,
  FORWARDED_REQUEST_HEADERS,
  getActiveRequests,
  getLifecycleStatus,
  getRouterStatus,
  handle,
  handleRequest,
  incrementActiveRequests,
  ingestOtelLogs,
  ingestOtelMetrics,
  ingestOtelSignal,
  ingestOtelTraces,
  autodevEnrichOtlpPayload,
  isAutodevAttributesEnabled,
  isClientDisconnectError,
  isDraining,
  routingStatus,
  limitsStatus,
  isLoopbackAddress,
  loadCatalog,
  loadRouterState,
  parseConcurrencyConfig,
  parseTurnMetadataJson,
  persistRouterStateNow,
  PROCESS_FALLBACK_SESSION_KEY,
  roleCapabilityRequirements,
  recordConcurrencyDenial,
  recordRouterEvent,
  recordSpawnFailure,
  releaseSubagentSlot,
  requestSession,
  resetConcurrencyTelemetry,
  resetLifecycleForTests,
  resetOtelTelemetry,
  resetRouterTelemetry,
  resolveTurnMetadataHeader,
  ROUTER_INSTANCE_ID,
  spawnFailureStatus,
  routerAuthorizationValid,
  setRouterAuthTokenForTests,
  serializeRouterState,
  tryAcquireSubagentSlot,
  providerCapabilities,
  subagentSpawnToolsFor,
  bridgeTelemetryHeaders,
  mcpContractForRole,
  recordNativeMcpExposure,
  recordSubagentSpawn,
  resetSubagentTelemetry,
  subagentStatus,
  ingestAgentEvents,
  noteBridgeRequest,
  noteBridgeSession,
  lookupBridgeSessionContext,
  recallBridgeSessionRequestId,
  closeBridgeSubagentsForRequest,
  UNATTRIBUTED_SUBAGENT_ROLE,
  noteOrchestratorSession,
  orchestratorProviderForSession,
  orchestratorSessionInfo,
  hasActiveBridgeSubagentsForSession,
  SUBAGENT_SPAWN_TOOLS_HEADER,
  SESSION_ID_HEADER,
  SESSION_SCOPE_HEADER,
  carriesPendingToolResult,
  AGENT_EVENTS_URL_HEADER,
  AGENT_EVENTS_PATH,
  workspaceContextFromRequest,
  workspaceMetadataForSession,
  registerWorkspaceId,
  attributionDiagnosticsStatus,
  resetAttributionDiagnostics,
  OTEL_PERSISTENCE_SCHEMA_VERSION,
  resolveTelemetryContext,
  safeAgentIdentity,
  safePrivacyWorkspace,
  otelPersistenceSnapshot,
  restoreOtelTelemetry,
  agentActivity,
  AGENT_ACTIVITY_TTL_MS,
  usageStatus,
  projectLiveAgents,
};
