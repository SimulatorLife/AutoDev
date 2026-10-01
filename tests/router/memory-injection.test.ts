import assert from "node:assert/strict";
import test from "node:test";

import {
  AggregationTemporality,
  InMemoryMetricExporter
} from "@opentelemetry/sdk-metrics";
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
  flushTelemetryMetrics,
  setTelemetryMetricExporterForTest
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
  const exporter = new InMemoryMetricExporter(
    AggregationTemporality.CUMULATIVE
  );
  process.env.AUTODEV_MEMORY_DATABASE_URL =
    "postgresql://autodev_memory:invalid@127.0.0.1:1/autodev_memory?connect_timeout=1";
  process.env.AUTODEV_MEMORY_RECONSTRUCTION = "deterministic";
  delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  delete process.env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT;
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
    const injected = await injectOrchestratorMemory(
      request([
        {
          type: "message",
          role: "user",
          content: [
            { type: "input_text", text: "Use the prior proxy validation." }
          ]
        }
      ]),
      memoryHost(() => {})
    );
    assert.match(
      String(injected.instructions),
      /Use the current proxy request boundary/
    );
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
    assert.equal(
      injections?.dataPoints.find(
        (point) =>
          point.attributes["autodev.memory.injection.result"] === "injected"
      )?.value,
      1
    );
  } finally {
    await closeOrchestratorMemoryHost();
    if (previousDatabaseUrl === undefined)
      delete process.env.AUTODEV_MEMORY_DATABASE_URL;
    else process.env.AUTODEV_MEMORY_DATABASE_URL = previousDatabaseUrl;
    if (previousReconstruction === undefined)
      delete process.env.AUTODEV_MEMORY_RECONSTRUCTION;
    else process.env.AUTODEV_MEMORY_RECONSTRUCTION = previousReconstruction;
    if (previousOtlpEndpoint === undefined)
      delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
    else process.env.OTEL_EXPORTER_OTLP_ENDPOINT = previousOtlpEndpoint;
    if (previousMetricsEndpoint === undefined)
      delete process.env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT;
    else
      process.env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT = previousMetricsEndpoint;
  }
});
