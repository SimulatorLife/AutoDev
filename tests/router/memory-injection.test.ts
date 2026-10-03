import assert from "node:assert/strict";
import test from "node:test";

import {
  AggregationTemporality,
  InMemoryMetricExporter
} from "@opentelemetry/sdk-metrics";
import { InMemorySpanExporter } from "@opentelemetry/sdk-trace-base";
import type {
  EvidenceReference,
  ExperienceEnvelope,
  MemoryExpiredExperienceRequest,
  MemoryHistory,
  MemoryLifecycleEvent,
  MemoryReadContext,
  MemoryRecord,
  MemoryRepository,
  MemorySearchHit,
  MemorySearchRequest,
  MemoryVersionedUpdate
} from "@simulatorlife/autodev-core";
import {
  MemoryService,
  type PostgresMemoryHost
} from "@simulatorlife/autodev-runtime/memory";
import {
  assignControlledAblationArm,
  clearTrustedMemoryContextsForTest,
  closeOrchestratorMemoryHost,
  CONTROLLED_ABLATION_ARMS,
  createMemoryInjectionCorrelationToken,
  createOrchestratorMemoryService,
  currentRouterMemoryMode,
  injectOrchestratorMemory,
  isTrustedSession,
  resolveRouterMemoryMode,
  trustedMemoryContextForSession
} from "@simulatorlife/autodev-runtime/router/memory-injection";
import {
  endLogicalRequestSpan,
  flushTelemetryMetrics,
  setTelemetryExporter,
  setTelemetryMetricExporterForTest,
  startLogicalRequestSpan,
  withLogicalSpan
} from "@simulatorlife/autodev-runtime/router/telemetry";

const evidence: EvidenceReference = {
  kind: "file",
  uri: "file:///workspace/repo/runtime/src/router/proxy.ts"
};

class MemoryRepositoryStub implements MemoryRepository {
  private readonly record: MemoryRecord;

  constructor(record: MemoryRecord) {
    this.record = record;
  }

  async appendExperience(_experience: ExperienceEnvelope): Promise<void> {}
  async getExperience(_id: string): Promise<ExperienceEnvelope | null> {
    return null;
  }
  async searchExperiences(): Promise<readonly ExperienceEnvelope[]> {
    return [];
  }

  async listExperiences(): Promise<{
    items: readonly ExperienceEnvelope[];
    total: number;
    limit: number;
    offset: number;
  }> {
    return { items: [], total: 0, limit: 50, offset: 0 };
  }

  async listExpiredExperiences(
    _request: MemoryExpiredExperienceRequest
  ): Promise<readonly ExperienceEnvelope[]> {
    return [];
  }

  async purgeExperience(): Promise<"not_visible"> {
    return "not_visible";
  }
  async proposeMemory(
    _candidate: MemoryRecord,
    _event: MemoryLifecycleEvent
  ): Promise<void> {}
  async getMemory(_id: string): Promise<MemoryRecord | null> {
    return this.record;
  }
  async searchMemories(
    _request: MemorySearchRequest
  ): Promise<readonly MemorySearchHit[]> {
    return [{ memory: this.record, score: 1, matchedSignals: ["lexical"] }];
  }
  async listMemories(): Promise<{
    items: readonly MemoryRecord[];
    total: number;
    limit: number;
    offset: number;
  }> {
    return { items: [], total: 0, limit: 50, offset: 0 };
  }

  async getMemoryHistory(_id: string): Promise<MemoryHistory | null> {
    return null;
  }
  async transitionMemories(
    _changes: readonly MemoryVersionedUpdate[],
    _events: readonly MemoryLifecycleEvent[]
  ): Promise<boolean> {
    return true;
  }
  async recordInjectionEvent(): Promise<{
    readonly appended: boolean;
    readonly id: string;
  }> {
    return { appended: false, id: "" };
  }
  async recordOutcomeReport(): Promise<{
    readonly appended: boolean;
    readonly id: string;
  }> {
    return { appended: false, id: "" };
  }
  async findInjectionEventByTokenForSession(): Promise<null> {
    return null;
  }
  async listInjectionOutcomeJoins(): Promise<{
    readonly items: readonly never[];
    readonly total: number;
    readonly limit: number;
    readonly offset: number;
  }> {
    return { items: [], total: 0, limit: 50, offset: 0 };
  }
  async aggregateInjectionOutcomeCohorts(): Promise<{
    readonly schema: "autodev-memory-injection-outcome-cohorts-v1";
    readonly workspaceId: string;
    readonly repositoryId: string;
    readonly occurredFrom: string;
    readonly occurredUntil: string;
    readonly cells: readonly never[];
    readonly exposureCount: number;
    readonly reportCount: number;
  }> {
    return {
      schema: "autodev-memory-injection-outcome-cohorts-v1" as const,
      workspaceId: "workspace-a",
      repositoryId: "owner/repo",
      occurredFrom: "",
      occurredUntil: "",
      cells: [],
      exposureCount: 0,
      reportCount: 0
    };
  }
  async getInjectionEventByIdForSession(): Promise<null> {
    return null;
  }
  async recordInjectionUseReport(): Promise<{
    readonly appended: boolean;
    readonly id: string;
  }> {
    return { appended: false, id: "" };
  }
  async getInjectionUseReport(): Promise<null> {
    return null;
  }
  async listInjectionUseJoins(): Promise<{
    readonly items: readonly never[];
    readonly total: number;
    readonly limit: number;
    readonly offset: number;
  }> {
    return { items: [], total: 0, limit: 50, offset: 0 };
  }
  async aggregateInjectionUseCohorts(): Promise<{
    readonly schema: "autodev-memory-injection-use-cohorts-v1";
    readonly workspaceId: string;
    readonly repositoryId: string;
    readonly occurredFrom: string;
    readonly occurredUntil: string;
    readonly cells: readonly never[];
    readonly exposureCount: number;
  }> {
    return {
      schema: "autodev-memory-injection-use-cohorts-v1" as const,
      workspaceId: "workspace-a",
      repositoryId: "owner/repo",
      occurredFrom: "",
      occurredUntil: "",
      cells: [],
      exposureCount: 0
    };
  }
  async recordSessionOutcomeReport(): Promise<{
    readonly appended: boolean;
    readonly id: string;
  }> {
    return { appended: false, id: "" };
  }
  async getSessionOutcomeReport(): Promise<null> {
    return null;
  }
  async aggregateSessionOutcomeCohorts(): Promise<{
    readonly schema: "autodev-memory-session-outcome-cohorts-v1";
    readonly workspaceId: string;
    readonly repositoryId: string;
    readonly occurredFrom: string;
    readonly occurredUntil: string;
    readonly cells: readonly never[];
    readonly sessionCount: number;
    readonly reportedSessionCount: number;
    readonly unreportedSessionCount: number;
    readonly conflictingOutcomeSessionCount: number;
    readonly mixedModeSessionCount: number;
  }> {
    return {
      schema: "autodev-memory-session-outcome-cohorts-v1",
      workspaceId: "workspace-a",
      repositoryId: "owner/repo",
      occurredFrom: "",
      occurredUntil: "",
      cells: [],
      sessionCount: 0,
      reportedSessionCount: 0,
      unreportedSessionCount: 0,
      conflictingOutcomeSessionCount: 0,
      mixedModeSessionCount: 0
    };
  }
}

function verifiedRecord(): MemoryRecord {
  const now = "2026-10-01T12:00:00.000Z";
  return {
    id: "memory-proxy",
    kind: "procedural",
    scope: {
      kind: "repository",
      workspaceId: "workspace-a",
      repositoryId: "owner/repo"
    },
    claim: "Use bounded per-session request handling in the proxy.",
    status: "active",
    provenance: {
      experienceIds: ["experience-a"],
      evidence: [evidence],
      createdBy: "root",
      createdAt: now
    },
    validity: { state: "verified", checkedAt: now, evidence: [evidence] },
    createdAt: now,
    updatedAt: now
  };
}

function memoryHost(
  onResearch: (
    task: string,
    context: MemoryReadContext,
    repositoryRoot: string | null
  ) => void
): PostgresMemoryHost {
  return {
    createService: (repositories) =>
      new MemoryService({
        repository: new MemoryRepositoryStub(verifiedRecord()),
        verifier: {
          verify: async ({ task, context }) => {
            onResearch(task, context, await repositories.resolve(context));
            return {
              compatibility: "compatible",
              source: "git-test",
              checkedAt: "2026-10-01T12:00:00.000Z",
              evidence: [evidence],
              reasonCode: "verified_current_state"
            };
          }
        },
        reconstructor: {
          reconstruct: async () => ({
            disposition: "retain",
            guidance: "Use the current proxy request boundary.",
            rationale: "The current source file matches its cited commit."
          })
        }
      }),
    close: async () => {}
  };
}

const request = (input: unknown[]) => ({
  payload: {
    model: "autodev/orchestrator",
    instructions: "Authoritative root policy.",
    input
  },
  requestId: "request-current",
  sessionKey: "root-session",
  sessionScope: "identified",
  threadId: "root-thread",
  workspace: {
    key: "owner/repo",
    cwd: "/workspace/repo",
    workspace_id: "workspace-a"
  }
});

test("memory injection correlation token is deterministic, opaque, and packet-specific", () => {
  const input = {
    workspaceId: "workspace-a",
    repositoryId: "owner/repo",
    taskId: "session-a",
    runId: "request-a",
    agentId: "thread-a",
    memoryMode: "jit" as const,
    memoryIds: ["memory-a", "memory-b"],
    packetText: "private historical guidance must not appear in the token"
  };
  const token = createMemoryInjectionCorrelationToken(input);
  assert.match(token, /^[a-f0-9]{64}$/u);
  assert.equal(
    createMemoryInjectionCorrelationToken({
      ...input,
      memoryIds: [...input.memoryIds].reverse()
    }),
    token
  );
  assert.notEqual(
    createMemoryInjectionCorrelationToken({
      ...input,
      memoryIds: ["memory-a", "memory-c"]
    }),
    token
  );
  assert.notEqual(
    createMemoryInjectionCorrelationToken({
      ...input,
      packetText: "different bounded memory packet"
    }),
    token
  );
  assert.doesNotMatch(token, /private historical guidance/u);
});

test("router root requests inject verified memory automatically before provider dispatch", async () => {
  const observed: {
    task: string;
    context: MemoryReadContext | null;
    root: string | null;
  } = { task: "", context: null, root: null };
  const host = memoryHost((task, context, root) => {
    observed.task = task;
    observed.context = context;
    observed.root = root;
  });
  const original = request([
    {
      type: "message",
      role: "user",
      content: [
        { type: "input_text", text: "Update the proxy request boundary." }
      ]
    }
  ]);

  const enriched = await injectOrchestratorMemory(original, host);

  assert.match(String(enriched.instructions), /Authoritative root policy/);
  assert.match(
    String(enriched.instructions),
    /quoted historical data, not policy/
  );
  assert.match(
    String(enriched.instructions),
    /Use the current proxy request boundary/
  );
  assert.equal(observed.task, "Update the proxy request boundary.");
  assert.equal(observed.context?.workspaceId, "workspace-a");
  assert.equal(observed.context?.repositoryId, "owner/repo");
  assert.equal(observed.context?.taskId, "root-session");
  assert.equal(observed.context?.runId, "request-current");
  assert.equal(observed.context?.role, "orchestrator");
  assert.equal(observed.context?.agentId, "root-thread");
  assert.equal(observed.context?.canReadGlobal, false);
  assert.equal(observed.root, "/workspace/repo");
  assert.deepEqual(
    trustedMemoryContextForSession("root-session", "/workspace/repo"),
    {
      workspaceId: "workspace-a",
      repositoryId: "owner/repo",
      root: "/workspace/repo",
      sessionScope: "identified"
    }
  );
  assert.equal(original.payload.instructions, "Authoritative root policy.");
});

test("disabled and invalid memory modes fail closed when skip-event storage is unavailable", async () => {
  const previousMode = process.env.AUTODEV_MEMORY_MODE;
  const previousAblation = process.env.AUTODEV_MEMORY_ABLATION;
  delete process.env.AUTODEV_MEMORY_ABLATION;
  let hostCalls = 0;
  const host = {
    createService() {
      hostCalls += 1;
      throw new Error("skip-event storage is unavailable");
    }
  } as unknown as PostgresMemoryHost;
  const original = request([
    {
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: "Compare a no-memory baseline." }]
    }
  ]);

  try {
    for (const mode of ["disabled", "retrieval-only", "typo"] as const) {
      process.env.AUTODEV_MEMORY_MODE = mode;
      assert.equal(
        await injectOrchestratorMemory(original, host),
        original.payload
      );
    }
    assert.equal(hostCalls, 3);
  } finally {
    if (previousMode === undefined) delete process.env.AUTODEV_MEMORY_MODE;
    else process.env.AUTODEV_MEMORY_MODE = previousMode;
    if (previousAblation === undefined)
      delete process.env.AUTODEV_MEMORY_ABLATION;
    else process.env.AUTODEV_MEMORY_ABLATION = previousAblation;
  }
});

test("disabled memory records a content-free skip decision without research", async () => {
  const previousMode = process.env.AUTODEV_MEMORY_MODE;
  const previousAblation = process.env.AUTODEV_MEMORY_ABLATION;
  process.env.AUTODEV_MEMORY_MODE = "disabled";
  delete process.env.AUTODEV_MEMORY_ABLATION;
  const recorded: Array<Record<string, unknown>> = [];
  const service = {
    async recordInjectionEvent(input: { event: Record<string, unknown> }) {
      recorded.push(input.event);
      return { appended: true, id: String(input.event.id) };
    }
  };
  const host = {
    createService() {
      return service;
    },
    close: async () => {}
  } as unknown as PostgresMemoryHost;
  const original = request([
    {
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: "Do not store this task text." }]
    }
  ]);

  try {
    const result = await injectOrchestratorMemory(original, host);
    assert.equal(result, original.payload);
    assert.equal(recorded.length, 1);
    assert.equal(recorded[0]?.memoryMode, "disabled");
    assert.equal(recorded[0]?.injectionResult, "skipped");
    assert.equal(recorded[0]?.reasonCode, "memory_mode_disabled");
    assert.deepEqual(recorded[0]?.memoryIds, []);
    assert.equal("task" in recorded[0]!, false);
    assert.equal(
      JSON.stringify(recorded[0]).includes("Do not store this task text"),
      false
    );
  } finally {
    if (previousMode === undefined) delete process.env.AUTODEV_MEMORY_MODE;
    else process.env.AUTODEV_MEMORY_MODE = previousMode;
    if (previousAblation === undefined)
      delete process.env.AUTODEV_MEMORY_ABLATION;
    else process.env.AUTODEV_MEMORY_ABLATION = previousAblation;
  }
});

test("disabled and invalid modes ignore tool-result continuations without user steer and record user-task skips", async () => {
  const previousMode = process.env.AUTODEV_MEMORY_MODE;
  const previousAblation = process.env.AUTODEV_MEMORY_ABLATION;
  delete process.env.AUTODEV_MEMORY_ABLATION;
  const recorded: Array<Record<string, unknown>> = [];
  const service = {
    async recordInjectionEvent(input: { event: Record<string, unknown> }) {
      recorded.push(input.event);
      return { appended: true, id: String(input.event.id) };
    }
  };
  let hostCalls = 0;
  const host = {
    createService() {
      hostCalls += 1;
      return service;
    },
    close: async () => {}
  } as unknown as PostgresMemoryHost;

  const toolContinuationWithoutSteer = request([
    {
      type: "function_call_output",
      call_id: "call-1",
      output: "tool result"
    },
    {
      type: "message",
      role: "user",
      content: [
        {
          type: "input_text",
          text: "<subagent_notification>child completed</subagent_notification>"
        }
      ]
    }
  ]);

  const toolContinuationWithSteer = request([
    {
      type: "function_call_output",
      call_id: "call-1",
      output: "tool result"
    },
    {
      type: "message",
      role: "user",
      content: [
        {
          type: "input_text",
          text: "User steer: proceed with next phase"
        }
      ]
    }
  ]);

  try {
    for (const mode of ["disabled", "invalid"] as const) {
      process.env.AUTODEV_MEMORY_MODE = mode;
      recorded.length = 0;
      hostCalls = 0;

      const resultNoSteer = await injectOrchestratorMemory(
        toolContinuationWithoutSteer,
        host
      );
      assert.equal(resultNoSteer, toolContinuationWithoutSteer.payload);
      assert.equal(hostCalls, 0);
      assert.equal(recorded.length, 0);

      const resultWithSteer = await injectOrchestratorMemory(
        toolContinuationWithSteer,
        host
      );
      assert.equal(resultWithSteer, toolContinuationWithSteer.payload);
      assert.equal(hostCalls, 1);
      assert.equal(recorded.length, 1);
      assert.equal(recorded[0]?.memoryMode, mode);
      assert.equal(recorded[0]?.injectionResult, "skipped");
      assert.equal(
        recorded[0]?.reasonCode,
        mode === "disabled" ? "memory_mode_disabled" : "memory_mode_invalid"
      );
      assert.deepEqual(recorded[0]?.memoryIds, []);
      assert.equal("task" in recorded[0]!, false);
      assert.equal(
        JSON.stringify(recorded[0]).includes("proceed with next phase"),
        false
      );
    }
  } finally {
    if (previousMode === undefined) delete process.env.AUTODEV_MEMORY_MODE;
    else process.env.AUTODEV_MEMORY_MODE = previousMode;
    if (previousAblation === undefined)
      delete process.env.AUTODEV_MEMORY_ABLATION;
    else process.env.AUTODEV_MEMORY_ABLATION = previousAblation;
  }
});

test("retrieval-only ablation injects bounded unvalidated claims without JIT reconstruction", async () => {
  const previousMode = process.env.AUTODEV_MEMORY_MODE;
  const previousAblation = process.env.AUTODEV_MEMORY_ABLATION;
  process.env.AUTODEV_MEMORY_MODE = "retrieval-only";
  process.env.AUTODEV_MEMORY_ABLATION = "1";
  let validationCalls = 0;
  try {
    const output = await injectOrchestratorMemory(
      request([
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "Change the proxy boundary." }]
        }
      ]),
      memoryHost(() => {
        validationCalls += 1;
      })
    );
    assert.match(
      String(output.instructions),
      /Use bounded per-session request handling in the proxy/
    );
    assert.match(
      String(output.instructions),
      /Retrieval-only ablation: this claim was not validated/
    );
    assert.match(String(output.instructions), /not_evaluated/);
    assert.doesNotMatch(
      String(output.instructions),
      /Use the current proxy request boundary/
    );
    assert.equal(validationCalls, 0);
  } finally {
    if (previousMode === undefined) delete process.env.AUTODEV_MEMORY_MODE;
    else process.env.AUTODEV_MEMORY_MODE = previousMode;
    if (previousAblation === undefined)
      delete process.env.AUTODEV_MEMORY_ABLATION;
    else process.env.AUTODEV_MEMORY_ABLATION = previousAblation;
  }
});

test("tool-result continuations without a new user steer do not repeat a JIT search", async () => {
  let researchCalls = 0;
  const host = memoryHost(() => {
    researchCalls += 1;
  });
  const continuation = request([
    {
      type: "function_call_output",
      call_id: "call-1",
      output: "tool result"
    },
    {
      type: "message",
      role: "user",
      content: [
        {
          type: "input_text",
          text: "<subagent_notification>child completed</subagent_notification>"
        }
      ]
    }
  ]);

  const unchanged = await injectOrchestratorMemory(continuation, host);
  assert.equal(unchanged, continuation.payload);
  assert.equal(researchCalls, 0);
});

test("memory injection fails closed when the workspace root or database is unavailable", async () => {
  const noWorkspace = await injectOrchestratorMemory(
    {
      ...request([{ type: "message", role: "user", content: "Task" }]),
      workspace: null
    },
    memoryHost(() =>
      assert.fail("must not research without a verified workspace")
    )
  );
  assert.equal(noWorkspace.instructions, "Authoritative root policy.");
  const noDatabaseRequest = request([
    { type: "message", role: "user", content: "Task" }
  ]);
  assert.equal(
    await injectOrchestratorMemory(noDatabaseRequest),
    noDatabaseRequest.payload
  );
});

test("missing thread identity does not widen agent-scoped visibility", async () => {
  const original = {
    ...request([
      { type: "message", role: "user", content: "Inspect memory scope." }
    ]),
    threadId: null
  };
  const observed: { context: MemoryReadContext | null } = { context: null };
  await injectOrchestratorMemory(
    original,
    memoryHost((_task, nextContext) => {
      observed.context = nextContext;
    })
  );
  assert.equal(observed.context?.agentId, undefined);
});

test("router initializes the OTel meter provider before creating MemoryService instruments", async () => {
  const previousDatabaseUrl = process.env.AUTODEV_MEMORY_DATABASE_URL;
  const previousReconstruction = process.env.AUTODEV_MEMORY_RECONSTRUCTION;
  const previousOtlpEndpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  const previousMetricsEndpoint =
    process.env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT;
  const previousMemoryMode = process.env.AUTODEV_MEMORY_MODE;
  const previousAblation = process.env.AUTODEV_MEMORY_ABLATION;
  const spanExporter = new InMemorySpanExporter();
  const exporter = new InMemoryMetricExporter(
    AggregationTemporality.CUMULATIVE
  );
  process.env.AUTODEV_MEMORY_DATABASE_URL =
    "postgresql://autodev_memory:invalid@127.0.0.1:1/autodev_memory?connect_timeout=1";
  process.env.AUTODEV_MEMORY_RECONSTRUCTION = "deterministic";
  process.env.AUTODEV_MEMORY_MODE = "jit";
  process.env.AUTODEV_MEMORY_ABLATION = "1";
  delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  delete process.env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT;
  setTelemetryExporter(spanExporter);
  setTelemetryMetricExporterForTest(exporter);

  try {
    const service = createOrchestratorMemoryService();
    assert.ok(service);
    await assert.rejects(
      service.search({
        query: "verify telemetry setup",
        context: { workspaceId: "workspace-a", canReadGlobal: false },
        limit: 1
      })
    );
    const injectedRequest = request([
      {
        type: "message",
        role: "user",
        content: [
          { type: "input_text", text: "Use the prior proxy validation." }
        ]
      }
    ]);
    const jitSpan = startLogicalRequestSpan({
      requestId: "memory-jit-baseline",
      role: "orchestrator",
      providerRole: "orchestrator",
      workspace: { key: "owner/repo" },
      subject: "memory JIT baseline",
      requestedModel: null
    });
    let injected: Record<string, unknown> = injectedRequest.payload;
    await withLogicalSpan(jitSpan, async () => {
      injected = await injectOrchestratorMemory(
        injectedRequest,
        memoryHost(() => {})
      );
    });
    endLogicalRequestSpan(jitSpan, { status: "ok" });
    assert.match(
      String(injected.instructions),
      /Use the current proxy request boundary/
    );
    const jitRequestSpan = spanExporter
      .getFinishedSpans()
      .find(
        (span) => span.spanContext().spanId === jitSpan.spanContext().spanId
      );
    assert.equal(
      jitRequestSpan?.attributes["autodev.memory.injection.result"],
      "injected"
    );
    assert.equal(
      typeof jitRequestSpan?.attributes["autodev.memory.packet.entries"],
      "number"
    );

    const disabledRequest = request([
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "No-memory baseline." }]
      }
    ]);
    process.env.AUTODEV_MEMORY_MODE = "disabled";
    const disabledSpan = startLogicalRequestSpan({
      requestId: "memory-disabled-baseline",
      role: "orchestrator",
      providerRole: "orchestrator",
      workspace: { key: "owner/repo" },
      subject: "memory disabled baseline",
      requestedModel: null
    });
    let disabled: Record<string, unknown> = disabledRequest.payload;
    await withLogicalSpan(disabledSpan, async () => {
      disabled = await injectOrchestratorMemory(disabledRequest, {
        createService: () => {
          throw new Error("disabled mode must not construct MemoryService");
        },
        close: async () => {}
      });
    });
    endLogicalRequestSpan(disabledSpan, { status: "ok" });
    assert.equal(disabled, disabledRequest.payload);

    process.env.AUTODEV_MEMORY_MODE = "retrieval-only";
    const retrievalOnlyRequest = request([
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "Compare retrieved claims." }]
      }
    ]);
    const retrievalOnlySpan = startLogicalRequestSpan({
      requestId: "memory-retrieval-only-baseline",
      role: "orchestrator",
      providerRole: "orchestrator",
      workspace: { key: "owner/repo" },
      subject: "memory retrieval-only baseline",
      requestedModel: null
    });
    let retrievalOnly: Record<string, unknown> = retrievalOnlyRequest.payload;
    await withLogicalSpan(retrievalOnlySpan, async () => {
      retrievalOnly = await injectOrchestratorMemory(
        retrievalOnlyRequest,
        memoryHost(() => {
          throw new Error(
            "retrieval-only mode must skip current-state validation"
          );
        })
      );
    });
    endLogicalRequestSpan(retrievalOnlySpan, { status: "ok" });
    assert.match(
      String(retrievalOnly.instructions),
      /Retrieval-only ablation: this claim was not validated/
    );
    process.env.AUTODEV_MEMORY_MODE = "jit";

    const memoryModes = new Set(
      spanExporter
        .getFinishedSpans()
        .filter((span) => span.name === "autodev.routed_request")
        .map((span) => span.attributes["autodev.memory.mode"])
    );
    assert.ok(memoryModes.has("jit"));
    assert.ok(memoryModes.has("disabled"));
    assert.ok(memoryModes.has("retrieval-only"));
    await flushTelemetryMetrics();

    const metrics = exporter
      .getMetrics()
      .flatMap((resource) => resource.scopeMetrics)
      .flatMap((scope) => scope.metrics);
    const operations = metrics.find(
      (metric) => metric.descriptor.name === "autodev.memory.operations"
    );
    assert.ok(operations, JSON.stringify(metrics));
    assert.equal(
      operations.dataPoints.find(
        (point) =>
          point.attributes["autodev.memory.operation"] === "memory.query" &&
          point.attributes["autodev.memory.outcome"] === "error"
      )?.value,
      1
    );
    const injections = metrics.find(
      (metric) => metric.descriptor.name === "autodev.memory.injections"
    );
    const injectedPoints =
      injections?.dataPoints.filter(
        (point) =>
          point.attributes["autodev.memory.injection.result"] === "injected"
      ) ?? [];
    assert.equal(
      injectedPoints.reduce((total, point) => {
        if (typeof point.value !== "number") {
          throw new TypeError(
            "Memory injection counter must aggregate to a number."
          );
        }
        return total + point.value;
      }, 0),
      2
    );
    assert.deepEqual(
      new Set(
        injectedPoints.map((point) => point.attributes["autodev.memory.mode"])
      ),
      new Set(["jit", "retrieval-only"])
    );
  } finally {
    await closeOrchestratorMemoryHost();
    if (previousDatabaseUrl === undefined)
      delete process.env.AUTODEV_MEMORY_DATABASE_URL;
    else process.env.AUTODEV_MEMORY_DATABASE_URL = previousDatabaseUrl;
    if (previousReconstruction === undefined)
      delete process.env.AUTODEV_MEMORY_RECONSTRUCTION;
    else process.env.AUTODEV_MEMORY_RECONSTRUCTION = previousReconstruction;
    if (previousMemoryMode === undefined)
      delete process.env.AUTODEV_MEMORY_MODE;
    else process.env.AUTODEV_MEMORY_MODE = previousMemoryMode;
    if (previousAblation === undefined)
      delete process.env.AUTODEV_MEMORY_ABLATION;
    else process.env.AUTODEV_MEMORY_ABLATION = previousAblation;
    if (previousOtlpEndpoint === undefined)
      delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
    else process.env.OTEL_EXPORTER_OTLP_ENDPOINT = previousOtlpEndpoint;
    if (previousMetricsEndpoint === undefined)
      delete process.env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT;
    else
      process.env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT = previousMetricsEndpoint;
  }
});

test("controlled ablation assignment is deterministic and scoped to a session workspace", () => {
  const experimentId = "exp-controlled-2026";
  const sessionA = "codex-session-abc-123";
  const sessionB = "codex-session-xyz-789";
  const workspaceId = "workspace-a";
  const repositoryId = "owner/repo";

  const armA1 = assignControlledAblationArm(
    experimentId,
    sessionA,
    workspaceId,
    repositoryId
  );
  const armA2 = assignControlledAblationArm(
    experimentId,
    sessionA,
    workspaceId,
    repositoryId
  );
  assert.equal(armA1, armA2);
  assert.ok(CONTROLLED_ABLATION_ARMS.includes(armA1));

  const armB1 = assignControlledAblationArm(
    experimentId,
    sessionB,
    workspaceId,
    repositoryId
  );
  const armB2 = assignControlledAblationArm(
    experimentId,
    sessionB,
    workspaceId,
    repositoryId
  );
  assert.equal(armB1, armB2);
  assert.ok(CONTROLLED_ABLATION_ARMS.includes(armB1));

  const env = {
    AUTODEV_MEMORY_EXPERIMENT_ID: experimentId,
    AUTODEV_MEMORY_ABLATION: "1"
  };
  const context = {
    sessionKey: sessionA,
    sessionScope: "identified",
    workspace: {
      key: "owner/repo",
      cwd: "/workspace/repo",
      workspace_id: "workspace-a"
    }
  };

  const mode1 = resolveRouterMemoryMode(env, context);
  const mode2 = resolveRouterMemoryMode(env, context);
  assert.equal(mode1, armA1);
  assert.equal(mode2, armA1);
});

test("controlled ablation distributes across all arms across distinct sessions", () => {
  const experimentId = "exp-distribution-test";
  const observedArms = new Set<string>();
  const counts: Record<string, number> = {
    jit: 0,
    "retrieval-only": 0,
    disabled: 0
  };

  for (let i = 0; i < 150; i++) {
    const sessionKey = `codex-session-${i}-${i * 31}`;
    const arm = assignControlledAblationArm(
      experimentId,
      sessionKey,
      "workspace-a",
      "owner/repo"
    );
    observedArms.add(arm);
    counts[arm] = (counts[arm] ?? 0) + 1;
  }

  assert.deepEqual(
    observedArms,
    new Set(["jit", "retrieval-only", "disabled"])
  );
  assert.ok((counts.jit ?? 0) > 20, "jit arm adequately represented");
  assert.ok(
    (counts["retrieval-only"] ?? 0) > 20,
    "retrieval-only arm adequately represented"
  );
  assert.ok((counts.disabled ?? 0) > 20, "disabled arm adequately represented");
});

test("controlled ablation fails closed on missing, untrusted, or un-ablated session", async () => {
  clearTrustedMemoryContextsForTest();
  const previousExp = process.env.AUTODEV_MEMORY_EXPERIMENT_ID;
  const previousAblation = process.env.AUTODEV_MEMORY_ABLATION;

  try {
    process.env.AUTODEV_MEMORY_EXPERIMENT_ID = "exp-fail-closed";
    delete process.env.AUTODEV_MEMORY_ABLATION;

    const trustedWorkspace = {
      key: "owner/repo",
      cwd: "/workspace/repo",
      workspace_id: "workspace-a"
    };

    // 1. Missing AUTODEV_MEMORY_ABLATION=1 is invalid rather than a control arm.
    assert.equal(
      resolveRouterMemoryMode(process.env, {
        sessionKey: "session-1",
        sessionScope: "identified",
        workspace: trustedWorkspace
      }),
      "invalid"
    );

    assert.equal(
      resolveRouterMemoryMode(
        {
          AUTODEV_MEMORY_EXPERIMENT_ID: "invalid id",
          AUTODEV_MEMORY_ABLATION: "1"
        },
        {
          sessionKey: "session-1",
          sessionScope: "identified",
          workspace: trustedWorkspace
        }
      ),
      "invalid",
      "malformed experiment IDs cannot assign a cohort"
    );

    process.env.AUTODEV_MEMORY_ABLATION = "1";

    // 2. Missing/anonymous session keys are invalid, never a control arm.
    assert.equal(
      resolveRouterMemoryMode(process.env, {
        sessionKey: null,
        sessionScope: "process-fallback",
        workspace: trustedWorkspace
      }),
      "invalid"
    );
    assert.equal(
      resolveRouterMemoryMode(process.env, {
        sessionKey: "",
        sessionScope: "identified",
        workspace: trustedWorkspace
      }),
      "invalid"
    );
    assert.equal(
      resolveRouterMemoryMode(process.env, {
        sessionKey: "session-without-router-scope",
        workspace: trustedWorkspace
      }),
      "invalid"
    );
    assert.equal(
      resolveRouterMemoryMode(process.env, {
        sessionKey: "process-scope",
        sessionScope: "process-fallback",
        workspace: trustedWorkspace
      }),
      "invalid"
    );

    // 3. Untrusted / missing / relative workspace fails closed to disabled
    assert.equal(
      resolveRouterMemoryMode(process.env, {
        sessionKey: "session-1",
        sessionScope: "identified",
        workspace: null
      }),
      "invalid"
    );
    assert.equal(
      resolveRouterMemoryMode(process.env, {
        sessionKey: "session-1",
        sessionScope: "identified",
        workspace: { key: "owner/repo", cwd: "relative/path" }
      }),
      "invalid"
    );
    assert.equal(
      resolveRouterMemoryMode(process.env, {
        sessionKey: "session-1",
        sessionScope: "identified",
        workspace: { key: "unknown", cwd: "/workspace/repo" }
      }),
      "invalid"
    );

    // 4. Conflicting session across workspaces fails closed
    assert.ok(
      isTrustedSession("conflicted-session", "identified", {
        key: "repo-1",
        cwd: "/workspace/repo-1"
      })
    );
    // Observe session-conflict in first workspace
    await injectOrchestratorMemory({
      ...request([{ type: "message", role: "user", content: "first turn" }]),
      sessionKey: "conflicted-session",
      workspace: { key: "repo-1", cwd: "/workspace/repo-1" }
    });

    // Same session claimed in a different repository root must fail closed
    assert.equal(
      resolveRouterMemoryMode(process.env, {
        sessionKey: "conflicted-session",
        sessionScope: "identified",
        workspace: { key: "repo-2", cwd: "/workspace/repo-2" }
      }),
      "invalid"
    );

    // 5. In injection, missing sessionKey produces no fabricated skip event.
    const recordedEvents: Array<Record<string, unknown>> = [];
    const host = {
      createService() {
        return {
          async recordInjectionEvent(input: {
            event: Record<string, unknown>;
          }) {
            recordedEvents.push(input.event);
            return { appended: true, id: String(input.event.id) };
          }
        };
      },
      close: async () => {}
    } as unknown as PostgresMemoryHost;

    const noSessionRequest = {
      ...request([
        { type: "message", role: "user", content: "Task without session" }
      ]),
      sessionKey: null,
      requestId: "request-should-not-substitute"
    };

    const result = await injectOrchestratorMemory(noSessionRequest, host);
    assert.equal(result, noSessionRequest.payload);
    assert.equal(
      recordedEvents.length,
      0,
      "must not record a skip event substituting requestId for missing sessionKey"
    );
  } finally {
    clearTrustedMemoryContextsForTest();
    if (previousExp === undefined)
      delete process.env.AUTODEV_MEMORY_EXPERIMENT_ID;
    else process.env.AUTODEV_MEMORY_EXPERIMENT_ID = previousExp;
    if (previousAblation === undefined)
      delete process.env.AUTODEV_MEMORY_ABLATION;
    else process.env.AUTODEV_MEMORY_ABLATION = previousAblation;
  }
});

test("controlled ablation preserves default AUTODEV_MEMORY_MODE when no experiment is configured", () => {
  const previousExp = process.env.AUTODEV_MEMORY_EXPERIMENT_ID;
  const previousMode = process.env.AUTODEV_MEMORY_MODE;
  const previousAblation = process.env.AUTODEV_MEMORY_ABLATION;
  delete process.env.AUTODEV_MEMORY_EXPERIMENT_ID;

  try {
    // Default when unset -> jit
    delete process.env.AUTODEV_MEMORY_MODE;
    delete process.env.AUTODEV_MEMORY_ABLATION;
    assert.equal(currentRouterMemoryMode(), "jit");

    // Explicit disabled
    process.env.AUTODEV_MEMORY_MODE = "disabled";
    assert.equal(currentRouterMemoryMode(), "disabled");

    // retrieval-only requires ablation=1
    process.env.AUTODEV_MEMORY_MODE = "retrieval-only";
    assert.equal(currentRouterMemoryMode(), "invalid");
    process.env.AUTODEV_MEMORY_ABLATION = "1";
    assert.equal(currentRouterMemoryMode(), "retrieval-only");

    // invalid mode
    process.env.AUTODEV_MEMORY_MODE = "unrecognized_mode";
    assert.equal(currentRouterMemoryMode(), "invalid");
  } finally {
    if (previousExp === undefined)
      delete process.env.AUTODEV_MEMORY_EXPERIMENT_ID;
    else process.env.AUTODEV_MEMORY_EXPERIMENT_ID = previousExp;
    if (previousMode === undefined) delete process.env.AUTODEV_MEMORY_MODE;
    else process.env.AUTODEV_MEMORY_MODE = previousMode;
    if (previousAblation === undefined)
      delete process.env.AUTODEV_MEMORY_ABLATION;
    else process.env.AUTODEV_MEMORY_ABLATION = previousAblation;
  }
});
