import { createHash } from "node:crypto";
import path from "node:path";

import { trace } from "@opentelemetry/api";
import {
  type MemoryActor,
  type MemoryExecutionMode,
  type MemoryInjectionEvent,
  type MemoryInjectionResult,
  type MemoryReadContext,
  parseMemoryExecutionMode
} from "@simulatorlife/autodev-core";
import {
  createPostgresMemoryHost,
  injectMemoryContext,
  injectRetrievalOnlyMemoryContext,
  latestUserTask,
  MEMORY_STORAGE_PROBE_TIMEOUT_MS,
  MemoryAuthorizationError,
  MemoryConflictError,
  type MemoryRepositoryRootResolver,
  type MemoryService,
  MemoryValidationError,
  type PostgresMemoryHost
} from "@simulatorlife/autodev-runtime/memory";
import { awaitedToolResults } from "@simulatorlife/autodev-runtime/shared/responses-continuation";

import { configuredMemoryEmbeddingProvider } from "./memory-embedding.ts";
import { RoutedMemoryReconstructor } from "./memory-reconstruction.ts";
import { routerTelemetryTracer } from "./telemetry.ts";

const RUNTIME_INJECTION_RECORDED_BY = "autodev-router-memory-injection";
const MEMORY_EXPERIMENT_ID_PATTERN = /^[a-z\d][a-z\d._-]{0,127}$/iu;

type MemoryMode = Exclude<MemoryExecutionMode, "unknown">;

export const CONTROLLED_ABLATION_ARMS = [
  "jit",
  "retrieval-only",
  "disabled"
] as const;
export type ControlledAblationArm = (typeof CONTROLLED_ABLATION_ARMS)[number];

const trustedRepositoryRoots = new Map<string, string>();
const trustedSessionContexts = new Map<
  string,
  {
    workspaceId: string;
    repositoryId: string;
    root: string;
    sessionScope: string;
  } | null
>();

export function clearTrustedMemoryContextsForTest(): void {
  trustedRepositoryRoots.clear();
  trustedSessionContexts.clear();
}

/**
 * Deterministically assign a stable memory arm for an experiment given a trusted
 * session key. Buckets approximately evenly across the three arms using SHA-256.
 */
export function assignControlledAblationArm(
  experimentId: string,
  sessionKey: string,
  workspaceId: string,
  repositoryId: string
): ControlledAblationArm {
  const parts = [
    "autodev-memory-experiment-v1",
    experimentId,
    workspaceId,
    repositoryId,
    sessionKey
  ];
  const hash = createHash("sha256").update(parts.join("\u0000")).digest();
  const bucket = Number(hash.readBigUInt64BE(0) % 3n);
  return CONTROLLED_ABLATION_ARMS[bucket]!;
}

export function isTrustedSession(
  sessionKey: string | null | undefined,
  sessionScope: string | null | undefined,
  workspace:
    | {
        readonly key: string;
        readonly cwd?: string | null;
        readonly workspace_id?: string;
      }
    | null
    | undefined
): boolean {
  if (!sessionKey || typeof sessionKey !== "string") return false;
  const trimmed = sessionKey.trim();
  if (
    !trimmed ||
    trimmed.length > 256 ||
    trimmed === "process-scope" ||
    sessionScope !== "identified"
  ) {
    // The scope clause short-circuits ahead of the conflict check below, so a
    // non-identified observation neither grants nor revokes trust. That is
    // deliberate, and the ordering is what makes it safe: revocation is
    // absorbing (see the `existing === null` branch), so a caller who supplies
    // its own `sessionScope` must not be able to destroy trust by asserting a
    // weaker one. Revoking here would let anyone who can name a session key
    // kill that session's capture with an ordinary anonymous request, where a
    // cross-workspace conflict already demands the stronger claim of an
    // identified session. An unidentified session simply gets no memory this
    // turn, which is the whole of what the target state asks for — "missing,
    // process-fallback, or cross-workspace conflicted identities select
    // invalid".
    return false;
  }

  if (
    !workspace ||
    !workspace.key?.trim() ||
    workspace.key === "unknown" ||
    !workspace.cwd ||
    !path.isAbsolute(workspace.cwd)
  ) {
    return false;
  }

  const existing = trustedSessionContexts.get(trimmed);
  if (existing === null) {
    // Absorbing: the only writer runs once this function has returned true, so
    // a revoked session stays untrusted for the life of the process. Keeping
    // revocation narrow is what stops that permanence from being a denial of
    // service — see the note on the scope clause above.
    return false;
  }
  if (existing !== undefined) {
    const workspaceId = workspace.workspace_id?.trim() || workspace.key;
    // No scope term here on purpose. By the time an entry exists, its scope was
    // checked against "identified" above, and it was written by a call that had
    // already passed that same check, so the two could only ever compare equal.
    if (
      existing.workspaceId !== workspaceId ||
      existing.repositoryId !== workspace.key ||
      path.resolve(existing.root) !== path.resolve(workspace.cwd)
    ) {
      trustedSessionContexts.set(trimmed, null);
      return false;
    }
  }

  return true;
}

function memoryMode(env: NodeJS.ProcessEnv): MemoryMode {
  const configured = env.AUTODEV_MEMORY_MODE?.trim();
  if (!configured) return "jit";
  const parsed = parseMemoryExecutionMode(
    configured,
    env.AUTODEV_MEMORY_ABLATION === "1"
  );
  return parsed === "unknown" ? "invalid" : parsed;
}

export interface RouterMemoryModeContext {
  readonly sessionKey?: string | null;
  readonly sessionScope?: string | null;
  readonly workspace?: {
    readonly key: string;
    readonly cwd?: string | null;
    readonly workspace_id?: string;
  } | null;
}

export function resolveRouterMemoryMode(
  env: NodeJS.ProcessEnv,
  context?: RouterMemoryModeContext
): MemoryMode {
  const experimentId = env.AUTODEV_MEMORY_EXPERIMENT_ID?.trim();
  if (!experimentId) {
    return memoryMode(env);
  }
  if (!MEMORY_EXPERIMENT_ID_PATTERN.test(experimentId)) return "invalid";

  // An experiment is configured: require AUTODEV_MEMORY_ABLATION=1 (otherwise fail closed).
  if (env.AUTODEV_MEMORY_ABLATION !== "1") {
    return "invalid";
  }

  // Require trusted absolute workspace identity before assigning.
  const workspace = context?.workspace;
  if (
    !workspace ||
    !workspace.key?.trim() ||
    workspace.key === "unknown" ||
    !workspace.cwd ||
    !path.isAbsolute(workspace.cwd)
  ) {
    return "invalid";
  }

  // Require a trusted session key: never use requestId as a per-request substitute.
  const sessionKey = context?.sessionKey?.trim();
  if (!sessionKey || sessionKey === "process-scope") {
    return "invalid";
  }

  if (!isTrustedSession(sessionKey, context?.sessionScope, workspace)) {
    return "invalid";
  }

  const workspaceId = workspace.workspace_id?.trim() || workspace.key.trim();
  return assignControlledAblationArm(
    experimentId,
    sessionKey,
    workspaceId,
    workspace.key.trim()
  );
}

export function currentRouterMemoryMode(
  context?: RouterMemoryModeContext
): MemoryMode {
  return resolveRouterMemoryMode(process.env, context);
}

function annotateMemoryMode(mode: MemoryMode): void {
  try {
    trace.getActiveSpan()?.setAttribute("autodev.memory.mode", mode);
  } catch {
    // Telemetry must not affect whether advisory memory is queried.
  }
}

export interface OrchestratorMemoryRequest {
  readonly payload: Record<string, unknown>;
  readonly requestId: string;
  readonly sessionKey: string | null;
  readonly sessionScope?: string | null;
  readonly threadId: string | null;
  readonly workspace: {
    readonly key: string;
    readonly cwd?: string | null;
    readonly workspace_id?: string;
  } | null;
}

let memoryHost: PostgresMemoryHost | null = null;
let memoryDatabaseUrl: string | null = null;
let memoryHostClose: Promise<void> | null = null;

/**
 * Automatically add a governed packet to a root user turn before any provider
 * sees it. Tool-result continuations without a new human steer are untouched.
 */
export async function injectOrchestratorMemory(
  request: OrchestratorMemoryRequest,
  hostOverride?: PostgresMemoryHost | null
): Promise<Record<string, unknown>> {
  const mode = currentRouterMemoryMode({
    sessionKey: request.sessionKey,
    ...(request.sessionScope === undefined
      ? {}
      : { sessionScope: request.sessionScope }),
    workspace: request.workspace
  });
  annotateMemoryMode(mode);

  const workspace = request.workspace;
  if (
    !workspace ||
    !workspace.key.trim() ||
    workspace.key === "unknown" ||
    !workspace.cwd ||
    !path.isAbsolute(workspace.cwd)
  ) {
    return request.payload;
  }
  if (
    request.payload.instructions !== undefined &&
    typeof request.payload.instructions !== "string"
  ) {
    return request.payload;
  }

  const pending = awaitedToolResults(request.payload.input);
  const taskInput =
    pending.outputs.size > 0 ? pending.messages : request.payload.input;
  const task = latestUserTask(taskInput);
  if (!task) return request.payload;

  const workspaceId = workspace.workspace_id?.trim() || workspace.key;
  const taskId = request.sessionKey ?? request.requestId;
  if (isTrustedSession(request.sessionKey, request.sessionScope, workspace)) {
    rememberTrustedRepositoryRoot(
      workspaceId,
      workspace.key,
      workspace.cwd,
      [request.sessionKey!].filter((value): value is string =>
        Boolean(value?.trim())
      ),
      request.sessionScope
    );
  }

  if (mode === "disabled" || mode === "invalid") {
    await persistMemoryModeSkip(request, mode, hostOverride);
    return request.payload;
  }

  const host =
    hostOverride === undefined ? configuredMemoryHost() : hostOverride;
  if (!host) return request.payload;

  const context: MemoryReadContext = {
    workspaceId,
    repositoryId: workspace.key,
    role: "orchestrator",
    taskId,
    runId: request.requestId,
    ...(request.threadId ? { agentId: request.threadId } : {}),
    canReadGlobal: process.env.AUTODEV_MEMORY_READ_GLOBAL === "1"
  };
  const service = host.createService({
    resolve: (scope) =>
      scope.workspaceId === workspaceId && scope.repositoryId === workspace.key
        ? (workspace.cwd ?? null)
        : null
  });

  try {
    const taskContext = {
      taskId,
      runId: request.requestId,
      task,
      context,
      memoryMode: mode
    };
    const enriched =
      mode === "retrieval-only"
        ? await injectRetrievalOnlyMemoryContext(
            service,
            request.payload,
            taskContext
          )
        : await injectMemoryContext(service, request.payload, taskContext);
    // Emit the injection observation after packet construction so the durable
    // event reflects what the model actually received. The runtime emits
    // injection events under the `system` authority and never lets a
    // database failure break the request; an emit error is logged but the
    // enriched payload still returns to the caller.
    await emitInjectionObservation({
      service,
      context,
      request,
      taskContext,
      enriched
    });
    return enriched;
  } catch {
    // Historical memory is advisory; a database/curation failure must not fail the task.
    return request.payload;
  }
}

/**
 * Build a content-free, opaque correlation token for one actual injection
 * observation. The token mixes only the durable, scope-visible identity
 * (workspace, repository, task, run, agent), the host-selected mode, the
 * bounded sorted memory ids, and the bounded packet text digest. It contains
 * no transcript, prompt, claim, or telemetry content, and is never
 * propagated into metric dimensions or model prompts.
 */
export function createMemoryInjectionCorrelationToken(input: {
  readonly workspaceId: string;
  readonly repositoryId?: string;
  readonly taskId: string;
  readonly runId: string;
  readonly agentId?: string;
  readonly memoryMode: MemoryExecutionMode;
  readonly memoryIds: readonly string[];
  readonly packetText: string;
}): string {
  const identity = [
    input.workspaceId,
    input.repositoryId ?? "",
    input.taskId,
    input.runId,
    input.agentId ?? "",
    input.memoryMode,
    [...input.memoryIds].sort().join("\u0000"),
    createHash("sha256").update(input.packetText).digest("hex")
  ].join("\u0001");
  return createHash("sha256").update(identity).digest("hex");
}

async function emitInjectionObservation(input: {
  readonly service: MemoryService;
  readonly context: MemoryReadContext;
  readonly request: OrchestratorMemoryRequest;
  readonly taskContext: {
    readonly taskId: string;
    readonly runId: string;
    readonly memoryMode?: MemoryExecutionMode;
  };
  readonly enriched: Record<string, unknown>;
}): Promise<void> {
  try {
    const instructions = input.enriched.instructions;
    const instructionsText =
      typeof instructions === "string" ? instructions : "";
    // Bounded extraction: only a complete marker pair counts as a packet.
    // Operating on the bounded body prevents AGENTS.md policy / pre-existing
    // system instructions from being credited as a memory packet.
    const block = extractMemoryPacketBlock(instructionsText);
    let injectionResult: MemoryInjectionResult;
    let packetCharacterCount = 0;
    let memoryIds: readonly string[] = [];
    let packetDigest: string;
    if (block === null) {
      injectionResult =
        input.taskContext.memoryMode === "retrieval-only" ||
        input.taskContext.memoryMode === "jit"
          ? "empty"
          : "skipped";
      packetDigest = "";
    } else {
      injectionResult = "injected";
      packetCharacterCount = block.body.length;
      packetDigest = createHash("sha256").update(block.body).digest("hex");
      memoryIds = extractInjectedMemoryIds(block.body);
    }
    const token = createMemoryInjectionCorrelationToken({
      workspaceId: input.context.workspaceId,
      ...(input.context.repositoryId
        ? { repositoryId: input.context.repositoryId }
        : {}),
      taskId: input.taskContext.taskId,
      runId: input.taskContext.runId,
      ...(input.context.agentId ? { agentId: input.context.agentId } : {}),
      memoryMode: input.taskContext.memoryMode ?? "unknown",
      memoryIds,
      packetText: packetDigest
    });
    const event: MemoryInjectionEvent = {
      id: `inj-${token.slice(0, 32)}`,
      workspaceId: input.context.workspaceId,
      ...(input.context.repositoryId
        ? { repositoryId: input.context.repositoryId }
        : {}),
      scope: {
        kind: "task",
        workspaceId: input.context.workspaceId,
        taskId: input.taskContext.taskId,
        runId: input.taskContext.runId
      },
      taskId: input.taskContext.taskId,
      runId: input.taskContext.runId,
      agentId: input.context.agentId ?? input.taskContext.runId,
      ...(input.context.role ? { agentRole: input.context.role } : {}),
      correlationToken: token,
      memoryMode: input.taskContext.memoryMode ?? "unknown",
      injectionResult,
      packetCharacterCount,
      memoryIds,
      occurredAt: new Date().toISOString(),
      // Two arms, not four. `disabled` and `invalid` cannot reach this function:
      // `injectOrchestratorMemory` returns through `persistMemoryModeSkip`
      // before enrichment, and `emitSkipObservation` is what records those two
      // reason codes. This branch only ever sees a mode that actually attempted
      // a packet -- `jit`, `retrieval-only`, or an ablation arm -- so the
      // question it has to answer is only "did the packet arrive".
      reasonCode:
        injectionResult === "injected"
          ? "packet_attached"
          : "no_packet_research_returned_empty",
      evidence: [],
      recordedBy: RUNTIME_INJECTION_RECORDED_BY
    };
    const actor: MemoryActor = {
      id: RUNTIME_INJECTION_RECORDED_BY,
      authority: "system"
    };
    await input.service.recordInjectionEvent({
      event,
      actor,
      context: input.context
    });
    try {
      const span = trace.getActiveSpan();
      // The token deliberately never enters the attribute set; the metric
      // dimension stays bounded to the categorical decision + mode.
      span?.setAttribute("autodev.memory.injection.result", injectionResult);
    } catch {
      // Telemetry must not affect memory observation.
    }
  } catch (error) {
    // Observational emission is best-effort: never propagate injection logging
    // failures back to the routed request.
    try {
      trace.getActiveSpan()?.addEvent("memory_injection_emit_failed", {
        // Bounded, fixed-category failure classification only. The raw error
        // message/string is never serialized into telemetry: it may contain
        // SQL text, connection details, or other free-form sensitive data.
        "autodev.memory.error.type": memoryInjectionEmitFailureClass(error)
      });
    } catch {
      // ignore
    }
  }
}

/**
 * Bounded, fixed-category classification for a failed injection-event
 * emission. Never derived from `error.message`; only the error's own type
 * is observable.
 */
function memoryInjectionEmitFailureClass(error: unknown): string {
  if (error instanceof MemoryConflictError) return "conflict";
  if (error instanceof MemoryValidationError) return "validation";
  if (error instanceof MemoryAuthorizationError) return "authorization";
  return "unknown";
}

const MEMORY_PACKET_START = "--- AUTODEV MEMORY PACKET V1 ---";
const MEMORY_PACKET_END = "--- END AUTODEV MEMORY PACKET ---";

/**
 * Locate a complete memory-packet block in the post-enrichment instructions
 * string. Returns the bounded body (exclusive of the markers) when both
 * markers are present in the expected order, or null otherwise.
 */
function extractMemoryPacketBlock(
  instructionsText: string
): { readonly body: string } | null {
  if (!instructionsText) return null;
  const start = instructionsText.indexOf(MEMORY_PACKET_START);
  if (start === -1) return null;
  const end = instructionsText.indexOf(
    MEMORY_PACKET_END,
    start + MEMORY_PACKET_START.length
  );
  if (end === -1) return null;
  return {
    body: instructionsText.slice(start + MEMORY_PACKET_START.length, end).trim()
  };
}

function extractInjectedMemoryIds(packetBody: string): readonly string[] {
  if (!packetBody) return [];
  const ids = new Set<string>();
  const re = /"memoryId"\s*:\s*"([^"]+)"/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(packetBody)) !== null) {
    if (match[1]) ids.add(match[1]);
  }
  return [...ids];
}

async function persistMemoryModeSkip(
  request: OrchestratorMemoryRequest,
  mode: "disabled" | "invalid",
  hostOverride?: PostgresMemoryHost | null
): Promise<void> {
  const skipContext = skipSessionContextForRequest(request);
  if (!skipContext) return;
  try {
    const host =
      hostOverride === undefined ? configuredMemoryHost() : hostOverride;
    const service = host?.createService({
      resolve: (scope) =>
        scope.workspaceId === skipContext.workspaceId &&
        scope.repositoryId === skipContext.repositoryId
          ? (request.workspace?.cwd ?? null)
          : null
    });
    if (!service) return;
    await emitSkipObservation({
      service,
      context: skipContext.context,
      request,
      reasonCode:
        mode === "disabled" ? "memory_mode_disabled" : "memory_mode_invalid"
    });
  } catch {
    // Skip observation is best-effort and must never break the request.
  }
}

/**
 * Build the trusted session-scoped identifiers for a no-memory cohort
 * observation. Returns null when the workspace is unknown / untrusted, in
 * which case we deliberately do not fabricate a skip event.
 */
function skipSessionContextForRequest(request: OrchestratorMemoryRequest): {
  readonly context: MemoryReadContext;
  readonly workspaceId: string;
  readonly repositoryId: string;
} | null {
  const workspace = request.workspace;
  if (
    !workspace ||
    !workspace.key.trim() ||
    workspace.key === "unknown" ||
    !workspace.cwd ||
    !path.isAbsolute(workspace.cwd)
  ) {
    return null;
  }

  const isExperiment = Boolean(
    process.env.AUTODEV_MEMORY_EXPERIMENT_ID?.trim()
  );
  if (
    isExperiment &&
    !isTrustedSession(request.sessionKey, request.sessionScope, workspace)
  ) {
    return null;
  }

  const workspaceIdKey = workspace.workspace_id?.trim() || workspace.key;
  const taskId = request.sessionKey ?? request.requestId;
  const context: MemoryReadContext = {
    workspaceId: workspaceIdKey,
    repositoryId: workspace.key,
    role: "orchestrator",
    taskId,
    runId: request.requestId,
    ...(request.threadId ? { agentId: request.threadId } : {}),
    canReadGlobal: process.env.AUTODEV_MEMORY_READ_GLOBAL === "1"
  };
  return {
    context,
    workspaceId: workspaceIdKey,
    repositoryId: workspace.key
  };
}

async function emitSkipObservation(input: {
  readonly service: MemoryService;
  readonly context: MemoryReadContext;
  readonly request: OrchestratorMemoryRequest;
  readonly reasonCode: "memory_mode_disabled" | "memory_mode_invalid";
}): Promise<void> {
  try {
    const taskId = input.context.taskId ?? input.request.requestId;
    const runId = input.context.runId ?? input.request.requestId;
    const agentId = input.context.agentId ?? input.request.threadId ?? runId;
    const token = createMemoryInjectionCorrelationToken({
      workspaceId: input.context.workspaceId,
      ...(input.context.repositoryId
        ? { repositoryId: input.context.repositoryId }
        : {}),
      taskId,
      runId,
      agentId,
      memoryMode:
        input.reasonCode === "memory_mode_disabled" ? "disabled" : "invalid",
      memoryIds: [],
      packetText: ""
    });
    const event: MemoryInjectionEvent = {
      id: `inj-${token.slice(0, 32)}`,
      workspaceId: input.context.workspaceId,
      ...(input.context.repositoryId
        ? { repositoryId: input.context.repositoryId }
        : {}),
      scope: {
        kind: "task",
        workspaceId: input.context.workspaceId,
        taskId,
        runId
      },
      taskId,
      runId,
      agentId,
      ...(input.context.role ? { agentRole: input.context.role } : {}),
      correlationToken: token,
      memoryMode:
        input.reasonCode === "memory_mode_disabled" ? "disabled" : "invalid",
      injectionResult: "skipped",
      packetCharacterCount: 0,
      memoryIds: [],
      occurredAt: new Date().toISOString(),
      reasonCode: input.reasonCode,
      evidence: [],
      recordedBy: RUNTIME_INJECTION_RECORDED_BY
    };
    await input.service.recordInjectionEvent({
      event,
      actor: { id: RUNTIME_INJECTION_RECORDED_BY, authority: "system" },
      context: input.context
    });
    try {
      trace
        .getActiveSpan()
        ?.setAttribute("autodev.memory.injection.result", "skipped");
    } catch {
      // ignore
    }
  } catch {
    // Observational skip emission is best-effort.
  }
}

/** Reuse the router's one process-local PostgreSQL host for operator reads. */
export function createOrchestratorMemoryService(
  repositories: MemoryRepositoryRootResolver = trustedRepositoryResolver
) {
  return configuredMemoryHost()?.createService(repositories) ?? null;
}

function rememberTrustedRepositoryRoot(
  workspaceId: string,
  repositoryId: string,
  root: string,
  sessionIds: readonly string[],
  sessionScope: string | null | undefined
): void {
  const key = `${workspaceId}\u0000${repositoryId}`;
  trustedRepositoryRoots.delete(key);
  trustedRepositoryRoots.set(key, root);
  while (trustedRepositoryRoots.size > 256) {
    const oldest = trustedRepositoryRoots.keys().next().value as
      string | undefined;
    if (oldest === undefined) break;
    trustedRepositoryRoots.delete(oldest);
  }
  for (const sessionId of sessionIds) {
    const existing = trustedSessionContexts.get(sessionId);
    // `sessionScope` is the literal "identified": the sole caller reaches this
    // function only through `isTrustedSession`, which admits nothing else, and
    // a stored entry therefore always carries that same literal. It is kept on
    // the context because the capture route reads it back to describe the trust
    // it is acting on — not because it can ever disagree with itself here.
    const next = {
      workspaceId,
      repositoryId,
      root,
      sessionScope: sessionScope ?? "unknown"
    };
    trustedSessionContexts.set(
      sessionId,
      existing &&
        (existing.workspaceId !== workspaceId ||
          existing.repositoryId !== repositoryId ||
          path.resolve(existing.root) !== path.resolve(root))
        ? null
        : next
    );
    while (trustedSessionContexts.size > 512) {
      const oldest = trustedSessionContexts.keys().next().value as
        string | undefined;
      if (oldest === undefined) break;
      trustedSessionContexts.delete(oldest);
    }
  }
}

/** Resolve only an exact session/repository pairing previously seen by the router. */
export function trustedMemoryContextForSession(
  sessionId: string,
  root: string
): {
  workspaceId: string;
  repositoryId: string;
  root: string;
  sessionScope: string;
} | null {
  const context = trustedSessionContexts.get(sessionId);
  if (!context || path.resolve(context.root) !== path.resolve(root))
    return null;
  return context;
}

const trustedRepositoryResolver: MemoryRepositoryRootResolver = {
  resolve: (scope) =>
    Promise.resolve(
      scope.repositoryId
        ? (trustedRepositoryRoots.get(
            `${scope.workspaceId}\u0000${scope.repositoryId}`
          ) ?? null)
        : null
    )
};

/** Release the shared pool when the router drains. Repeated shutdown paths share one close. */
export function closeOrchestratorMemoryHost(): Promise<void> {
  if (memoryHostClose) return memoryHostClose;
  const current = memoryHost;
  if (!current) return Promise.resolve();
  memoryHostClose = current.close().finally(() => {
    if (memoryHost === current) {
      memoryHost = null;
      memoryDatabaseUrl = null;
    }
    memoryHostClose = null;
  });
  return memoryHostClose;
}

/**
 * What the Runtime can say about its own memory storage right now.
 *
 * Answered by the module that owns the host's lifecycle, because nothing else
 * can tell "not configured" apart from "configured but the host failed to
 * construct" -- both are a null host to every caller.
 *
 * The embedding provider is read from configuration rather than inferred. A
 * store that is reachable but has no embeddings accepts captures it cannot later
 * retrieve with, and that is a configuration fact rather than a read failure, so
 * nothing downstream would ever report it.
 */
export interface MemoryStorageStatus {
  readonly state: "not_configured" | "unreachable" | "reachable";
  readonly embeddings: "not_configured" | "configured";
  readonly probeTimeoutMs: number;
}

/**
 * Observe durable memory storage without requiring it to work.
 *
 * This is the read that has to succeed when every other memory read fails, so
 * it never resolves the service and never throws: a caller asking "is memory
 * connected" must get an answer even when the answer is that memory is not.
 */
export async function observeMemoryStorageStatus(
  timeoutMs: number = MEMORY_STORAGE_PROBE_TIMEOUT_MS
): Promise<MemoryStorageStatus> {
  const embeddings = configuredMemoryEmbeddingProvider()
    ? ("configured" as const)
    : ("not_configured" as const);
  const host = configuredMemoryHost();
  if (!host)
    return { state: "not_configured", embeddings, probeTimeoutMs: timeoutMs };
  return {
    state: await host.probe(timeoutMs),
    embeddings,
    probeTimeoutMs: timeoutMs
  };
}

function configuredMemoryHost(): PostgresMemoryHost | null {
  if (memoryHostClose) return null;
  const databaseUrl = process.env.AUTODEV_MEMORY_DATABASE_URL?.trim();
  if (!databaseUrl) return null;
  // Install the configured global MeterProvider before constructing
  // MemoryService instruments; the OTel Metrics API does not proxy meters
  // created before a provider has been registered.
  routerTelemetryTracer();
  if (memoryHost) return memoryDatabaseUrl === databaseUrl ? memoryHost : null;
  try {
    const useExistingOrchestratorModel =
      process.env.AUTODEV_MEMORY_RECONSTRUCTION !== "deterministic";
    const embedder = configuredMemoryEmbeddingProvider();
    memoryHost = createPostgresMemoryHost({
      databaseUrl,
      ...(embedder ? { embedder } : {}),
      ...(useExistingOrchestratorModel
        ? {
            reconstructor: new RoutedMemoryReconstructor(),
            maxResearchCandidates: 2
          }
        : {})
    });
    memoryDatabaseUrl = databaseUrl;
    return memoryHost;
  } catch {
    return null;
  }
}
