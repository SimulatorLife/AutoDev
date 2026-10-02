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
  closeOrchestratorMemoryHost,
  createOrchestratorMemoryService,
  injectOrchestratorMemory,
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
  threadId: "root-thread",
  workspace: {
    key: "owner/repo",
    cwd: "/workspace/repo",
    workspace_id: "workspace-a"
  }
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
      root: "/workspace/repo"
    }
  );
  assert.equal(original.payload.instructions, "Authoritative root policy.");
});

test("disabled and invalid memory modes fail closed without querying memory", async () => {
  const previousMode = process.env.AUTODEV_MEMORY_MODE;
  const previousAblation = process.env.AUTODEV_MEMORY_ABLATION;
  delete process.env.AUTODEV_MEMORY_ABLATION;
  let hostCalls = 0;
  const host = {
    createService() {
      hostCalls += 1;
      throw new Error("disabled mode must not construct a MemoryService");
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
    assert.equal(hostCalls, 0);
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
      injectedPoints.reduce((total, point) => total + point.value, 0),
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
