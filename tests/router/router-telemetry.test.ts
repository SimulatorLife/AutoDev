import "@simulatorlife/autodev-runtime/router/http";

import assert from "node:assert/strict";
import test from "node:test";

import { trace } from "@opentelemetry/api";
import {
  AggregationTemporality,
  InMemoryMetricExporter
} from "@opentelemetry/sdk-metrics";
import { InMemorySpanExporter } from "@opentelemetry/sdk-trace-base";
import { COOLDOWNS } from "@simulatorlife/autodev-runtime/router/cooldown";
import {
  recordBridgeSkillExposure,
  recordBridgeSkillUsed
} from "@simulatorlife/autodev-runtime/router/otel";
import {
  EXHAUSTION_WAIT_MS,
  fetchUpstream,
  proxyConcreteResponse,
  proxyFallbackChain,
  proxyOrchestratorResponse,
  writeResponseStream
} from "@simulatorlife/autodev-runtime/router/proxy";
import type { Candidate } from "@simulatorlife/autodev-runtime/router/routing";
import {
  compactCompactionDimension,
  COMPACTION_DIMENSION_ALLOWLISTS,
  COMPACTION_DIMENSION_OTHER,
  endAttemptSpan,
  endLogicalRequestSpan,
  flushTelemetryMetrics,
  getFinishedSpans,
  ATTR_AUTODEV_GIT_PARTIAL,
  METRIC_CONTEXT_COMPACTIONS,
  METRIC_GIT_COMMITS,
  METRIC_GIT_FILES_ADDED,
  METRIC_GIT_FILES_CHANGED,
  METRIC_GIT_FILES_DELETED,
  METRIC_GIT_LINES_ADDED,
  METRIC_GIT_LINES_REMOVED,
  recordContextCompaction,
  recordGitCommit,
  resetTrackedGitCommitsForTest,
  resetTelemetryExporter,
  resolveOtlpSignalEndpoint,
  sanitizeCategoricalLabel,
  setTelemetryExporter,
  setTelemetryMetricExporterForTest,
  startAttemptSpan,
  startLogicalRequestSpan,
  withLogicalSpan
} from "@simulatorlife/autodev-runtime/router/telemetry";

function jsonResponse(value: unknown, status = 200): Response {
  return Response.json(value, {
    status,
    headers: { "content-type": "application/json" }
  });
}

function responseRecorder(): any {
  const chunks: Buffer[] = [];
  return {
    statusCode: 0,
    headers: {} as Record<string, string | number>,
    body: "",
    headersSent: false,
    writableEnded: false,
    destroyed: false,
    closed: false,
    writeHead(status: number, headers: Record<string, string | number>) {
      this.statusCode = status;
      this.headers = headers;
      this.headersSent = true;
    },
    write(chunk: string | Buffer) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      return true;
    },
    end(chunk?: string | Buffer) {
      if (chunk)
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      this.body = Buffer.concat(chunks).toString("utf8");
      this.writableEnded = true;
    },
    on() {
      return this;
    },
    removeListener() {
      return this;
    }
  };
}

const route = (provider: string, envKey: string): Candidate => ({
  provider,
  pattern: /.*/,
  baseUrl: `http://${provider}.test/v1`,
  model: provider === "claude" ? "sonnet" : "MiniMax-M3",
  envKey
});

interface SpanRecord {
  name: string;
  spanId: string;
  traceId: string;
  attributes: Record<string, unknown>;
  status: { code: number };
  parentSpanContext: { spanId: string; traceId: string } | undefined;
  kind: number;
}

function snapshotSpans(): SpanRecord[] {
  return getFinishedSpans().map((span) => {
    const parent = span.parentSpanContext;
    return {
      name: span.name,
      spanId: span.spanContext().spanId,
      traceId: span.spanContext().traceId,
      attributes: { ...span.attributes } as Record<string, unknown>,
      status: { code: span.status.code as number },
      parentSpanContext: parent
        ? { spanId: parent.spanId, traceId: parent.traceId }
        : undefined,
      kind: span.kind as number
    };
  });
}

function findLogical(spans: SpanRecord[]): SpanRecord[] {
  return spans.filter((s) => s.name === "autodev.routed_request");
}

function findAttemptSpans(spans: SpanRecord[]): SpanRecord[] {
  return spans.filter((s) => s.name === "gen_ai.client_operation");
}

function findMetricPoints(metricName: string): Array<{
  attributes: Record<string, unknown>;
  value: number | { count: number; sum: number };
}> {
  return telemetryMetricExporter
    .getMetrics()
    .flatMap((resource) => resource.scopeMetrics)
    .flatMap((scope) => scope.metrics)
    .filter((metric) => metric.descriptor.name === metricName)
    .flatMap((metric) => {
      const points = metric.dataPoints as Array<{
        attributes: Record<string, unknown>;
        value: unknown;
      }>;
      return points.map((point) => {
        const value = point.value as number | { count: number; sum: number };
        return {
          attributes: point.attributes,
          value:
            typeof value === "object" && value !== null
              ? { count: value.count, sum: value.sum }
              : value
        };
      });
    });
}

test("generic OTLP endpoint resolves to distinct signal paths", () => {
  assert.equal(
    resolveOtlpSignalEndpoint("http://127.0.0.1:4318/", "traces"),
    "http://127.0.0.1:4318/v1/traces"
  );
  assert.equal(
    resolveOtlpSignalEndpoint("http://127.0.0.1:4318/v1/logs", "metrics"),
    "http://127.0.0.1:4318/v1/metrics"
  );
  assert.equal(resolveOtlpSignalEndpoint("not-a-url", "metrics"), null);
});

test(
  "source metrics count one logical request and one physical GenAI operation with reported token and cache usage",
  { concurrency: false },
  async () => {
    installExporter();
    const logical = startLogicalRequestSpan({
      requestId: "must-not-be-a-metric-dimension",
      role: "worker",
      providerRole: "subagent",
      workspace: { key: "workspace-metrics" },
      subject: "metric fixture",
      requestedModel: "metric-model"
    });
    await withLogicalSpan(logical, async () => {
      const attempt = startAttemptSpan({
        provider: "metric-provider",
        model: "metric-model",
        selection: "primary",
        attemptNumber: 1,
        role: "worker",
        workspace: { key: "workspace-metrics" }
      });
      endAttemptSpan(attempt, {
        status: "ok",
        usage: { input: 100, output: 25, cacheRead: 40 },
        responseModel: "metric-model-response"
      });
    });
    endLogicalRequestSpan(logical, { status: "ok" });
    await flushTelemetryMetrics();

    const input = findMetricPoints("gen_ai.client.token.usage").find(
      (point) =>
        point.attributes["gen_ai.provider.name"] === "metric-provider" &&
        point.attributes["gen_ai.request.model"] === "metric-model" &&
        point.attributes["gen_ai.token.type"] === "input"
    );
    const output = findMetricPoints("gen_ai.client.token.usage").find(
      (point) =>
        point.attributes["gen_ai.provider.name"] === "metric-provider" &&
        point.attributes["gen_ai.token.type"] === "output"
    );
    const cache = findMetricPoints(
      "autodev.gen_ai.cache_read.input_tokens"
    ).find(
      (point) => point.attributes["gen_ai.provider.name"] === "metric-provider"
    );
    const logicalRequests = findMetricPoints(
      "autodev.router.logical_requests"
    ).find(
      (point) =>
        point.attributes["autodev.workspace"] === "workspace-metrics" &&
        point.attributes["autodev.router.outcome"] === "success"
    );
    const attemptDuration = findMetricPoints(
      "gen_ai.client.operation.duration"
    ).find(
      (point) => point.attributes["gen_ai.provider.name"] === "metric-provider"
    );

    assert.equal(
      input?.value && typeof input.value === "object"
        ? input.value.sum
        : input?.value,
      100
    );
    assert.equal(
      output?.value && typeof output.value === "object"
        ? output.value.sum
        : output?.value,
      25
    );
    assert.equal(
      cache?.value && typeof cache.value === "object"
        ? cache.value.sum
        : cache?.value,
      40
    );
    assert.equal(logicalRequests?.value, 1);
    assert.equal(
      Object.hasOwn(logicalRequests?.attributes ?? {}, "requestId"),
      false,
      "request IDs must never become metric dimensions"
    );
    assert.ok(
      attemptDuration?.value && typeof attemptDuration.value === "object"
    );
    assert.equal(attemptDuration?.value.count, 1);
  }
);

test(
  "accepted bridge skill exposure and use are distinct AutoDev spans with bounded metric dimensions",
  { concurrency: false },
  async () => {
    installExporter();
    const context = {
      workspace: "skill-contract-workspace",
      role: "worker"
    };
    assert.equal(
      recordBridgeSkillExposure({
        event: {
          type: "skill_exposed",
          skill: "workspace-audit",
          source: "role_contract",
          pluginId: "private-plugin-id"
        },
        context
      }),
      true
    );
    assert.equal(
      recordBridgeSkillUsed({
        event: {
          type: "skill_used",
          skill: "workspace-audit",
          source: "skill_read",
          eventId: "private-event-id"
        },
        context
      }),
      true
    );
    assert.equal(
      recordBridgeSkillUsed({
        event: {
          type: "skill_used",
          skill: "workspace-audit",
          source: "skill_read",
          eventId: "private-event-id"
        },
        context
      }),
      false,
      "deduplicated bridge use must not double-count the OTel observation"
    );

    const skillSpans = snapshotSpans().filter(
      (span) => span.name === "autodev.skill"
    );
    assert.deepEqual(
      skillSpans.map((span) => span.attributes["autodev.skill.event"]),
      ["exposed", "used"]
    );
    for (const span of skillSpans) {
      assert.equal(span.attributes["autodev.skill.name"], "workspace-audit");
      assert.equal(span.attributes["autodev.workspace"], context.workspace);
      assert.equal(span.attributes["autodev.agent.role"], context.role);
      assert.equal(Object.hasOwn(span.attributes, "private-plugin-id"), false);
      assert.equal(Object.hasOwn(span.attributes, "private-event-id"), false);
    }

    await flushTelemetryMetrics();
    const skillPoints = findMetricPoints("autodev.skill.events");
    assert.equal(skillPoints.length, 2);
    for (const point of skillPoints) {
      assert.equal(point.value, 1);
      assert.equal(point.attributes["autodev.workspace"], context.workspace);
      assert.equal(point.attributes["autodev.agent.role"], context.role);
      assert.equal(
        Object.hasOwn(point.attributes, "autodev.skill.name"),
        false
      );
    }
  }
);

delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
delete process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT;
delete process.env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT;
const telemetryTestExporter = new InMemorySpanExporter();
const telemetryMetricExporter = new InMemoryMetricExporter(
  AggregationTemporality.CUMULATIVE
);
setTelemetryExporter(telemetryTestExporter);
setTelemetryMetricExporterForTest(telemetryMetricExporter);

function installExporter(): InMemorySpanExporter {
  resetTelemetryExporter();
  telemetryMetricExporter.reset();
  return telemetryTestExporter;
}

function findLogicalSpanId(): string | null {
  for (const span of getFinishedSpans()) {
    if (span.name === "autodev.routed_request") {
      return span.spanContext().spanId;
    }
  }
  return null;
}

function findLogicalTraceId(): string | null {
  for (const span of getFinishedSpans()) {
    if (span.name === "autodev.routed_request") {
      return span.spanContext().traceId;
    }
  }
  return null;
}

test(
  "streaming attempt span stays open through response consumption and captures only reported final usage",
  { concurrency: false },
  async () => {
    installExporter();
    const previousKey = process.env.LITELLM_API_KEY;
    process.env.LITELLM_API_KEY = "claude-key";
    const originalFetch = globalThis.fetch;
    const event =
      'data: {"type":"response.completed","response":{"id":"stream-result","status":"completed","model":"claude-3","usage":{"input_tokens":40,"output_tokens":10,"cache_read_input_tokens":15}}}\n\n';
    globalThis.fetch = (async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(event));
            controller.close();
          }
        }),
        { status: 200, headers: { "content-type": "text/event-stream" } }
      )) as typeof fetch;

    try {
      let pending: Awaited<ReturnType<typeof fetchUpstream>> | null = null;
      const logical = startLogicalRequestSpan({
        requestId: "private-stream-request-id",
        role: "worker",
        providerRole: "subagent",
        workspace: null,
        subject: "stream fixture",
        requestedModel: "claude-3"
      });
      await withLogicalSpan(logical, async () => {
        pending = await fetchUpstream(
          route("claude", "LITELLM_API_KEY"),
          { model: "claude-3", input: [], stream: true },
          true,
          null,
          null,
          "worker",
          "private-stream-request-id",
          null,
          {
            selection: "primary",
            attemptNumber: 1,
            model: "claude-3",
            role: "worker"
          }
        );
        assert.equal(pending.ok, true);
        assert.equal(
          findAttemptSpans(snapshotSpans()).length,
          0,
          "provider span remains open until the streaming body is consumed"
        );
        if (!pending.ok) throw new Error("mock provider should succeed");
        await writeResponseStream(
          responseRecorder(),
          pending.upstream,
          "claude-3",
          pending.signal,
          null,
          null,
          false,
          {
            ...(pending.attemptSpan ? { span: pending.attemptSpan } : {}),
            ...(pending.attemptStatusCode === undefined
              ? {}
              : { statusCode: pending.attemptStatusCode })
          }
        );
      });
      endLogicalRequestSpan(logical, { status: "ok" });
      const attempt = findAttemptSpans(snapshotSpans())[0];
      assert.equal(attempt?.attributes["gen_ai.usage.input_tokens"], 40);
      assert.equal(attempt?.attributes["gen_ai.usage.output_tokens"], 10);
      assert.equal(
        attempt?.attributes["gen_ai.usage.cache_read.input_tokens"],
        15
      );
    } finally {
      globalThis.fetch = originalFetch;
      if (previousKey === undefined) delete process.env.LITELLM_API_KEY;
      else process.env.LITELLM_API_KEY = previousKey;
      resetTelemetryExporter();
    }
  }
);

test(
  "orchestrator payload preparation and memory spans share the routed-request trace",
  { concurrency: false },
  async () => {
    COOLDOWNS.clearAll();
    const previousKey = process.env.LITELLM_API_KEY;
    process.env.LITELLM_API_KEY = "claude-key";
    const originalFetch = globalThis.fetch;
    let upstreamInstructions: unknown;
    globalThis.fetch = (async (
      _input: string | URL | Request,
      init?: RequestInit
    ) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      upstreamInstructions = body.instructions;
      return jsonResponse({
        id: "resp-memory-trace",
        status: "completed",
        model: "claude-test",
        output: []
      });
    }) as typeof fetch;
    installExporter();
    let preparedSpanId: string | null = null;
    try {
      await proxyFallbackChain(
        responseRecorder(),
        {
          candidates: [route("claude", "LITELLM_API_KEY")],
          agentRole: "orchestrator",
          origin: "orchestrator",
          subject: "the orchestrator",
          preparePayload: async (payload) => {
            const active = trace.getActiveSpan();
            assert.ok(
              active,
              "preparation runs inside the logical request span"
            );
            preparedSpanId = active.spanContext().spanId;
            active.setAttribute("autodev.memory.mode", "jit");
            const researchSpan = trace
              .getTracer("autodev.memory.test", "1.0.0")
              .startSpan("memory.research");
            researchSpan.end();
            return { ...payload, instructions: "advisory memory packet" };
          }
        },
        { model: "autodev/orchestrator", input: [], stream: false },
        false,
        "req-memory-trace",
        null,
        { key: "memory-trace-workspace" }
      );

      const spans = snapshotSpans();
      const logical = findLogical(spans);
      const research = spans.find((span) => span.name === "memory.research");
      assert.equal(logical.length, 1);
      assert.equal(upstreamInstructions, "advisory memory packet");
      assert.ok(preparedSpanId);
      assert.equal(logical[0]?.attributes["autodev.memory.mode"], "jit");
      assert.equal(preparedSpanId, logical[0]?.spanId);
      assert.ok(research);
      assert.equal(research.parentSpanContext?.spanId, logical[0]?.spanId);
      assert.equal(research.parentSpanContext?.traceId, logical[0]?.traceId);
    } finally {
      globalThis.fetch = originalFetch;
      if (previousKey === undefined) delete process.env.LITELLM_API_KEY;
      else process.env.LITELLM_API_KEY = previousKey;
      resetTelemetryExporter();
    }
  }
);

test(
  "a failed advisory payload preparation does not prevent provider routing",
  { concurrency: false },
  async () => {
    COOLDOWNS.clearAll();
    const previousKey = process.env.LITELLM_API_KEY;
    process.env.LITELLM_API_KEY = "claude-key";
    const originalFetch = globalThis.fetch;
    let forwardedInput: unknown;
    globalThis.fetch = (async (
      _input: string | URL | Request,
      init?: RequestInit
    ) => {
      forwardedInput = JSON.parse(String(init?.body));
      return jsonResponse({
        id: "resp-memory-preparation-error",
        status: "completed",
        model: "claude-test",
        output: []
      });
    }) as typeof fetch;
    installExporter();
    const originalPayload = {
      model: "autodev/worker",
      instructions: "Keep canonical policy.",
      input: [],
      stream: false
    };
    try {
      const response = responseRecorder();
      await proxyFallbackChain(
        response,
        {
          candidates: [route("claude", "LITELLM_API_KEY")],
          role: "worker",
          subject: "worker turn",
          preparePayload: async () => {
            throw new Error("memory service unavailable");
          }
        },
        originalPayload,
        false,
        "req-memory-preparation-error",
        null,
        { key: "memory-preparation-workspace" }
      );

      assert.equal(response.statusCode, 200);
      assert.equal(
        (forwardedInput as Record<string, unknown>).instructions,
        originalPayload.instructions
      );
      const logical = findLogical(snapshotSpans());
      assert.equal(logical.length, 1);
      assert.equal(
        logical[0]?.attributes["autodev.memory.injection.result"],
        "unavailable"
      );
    } finally {
      globalThis.fetch = originalFetch;
      if (previousKey === undefined) delete process.env.LITELLM_API_KEY;
      else process.env.LITELLM_API_KEY = previousKey;
      resetTelemetryExporter();
    }
  }
);

test(
  "the orchestrator router attaches the selected memory mode to its logical span",
  { concurrency: false },
  async () => {
    COOLDOWNS.clearAll();
    const previousKey = process.env.LITELLM_API_KEY;
    const previousDatabaseUrl = process.env.AUTODEV_MEMORY_DATABASE_URL;
    const previousMode = process.env.AUTODEV_MEMORY_MODE;
    const previousAblation = process.env.AUTODEV_MEMORY_ABLATION;
    process.env.LITELLM_API_KEY = "claude-key";
    process.env.AUTODEV_MEMORY_MODE = "disabled";
    delete process.env.AUTODEV_MEMORY_DATABASE_URL;
    delete process.env.AUTODEV_MEMORY_ABLATION;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      jsonResponse({
        id: "resp-disabled-memory",
        status: "completed",
        model: "claude-test",
        output: []
      })) as typeof fetch;
    installExporter();
    try {
      await proxyOrchestratorResponse(
        responseRecorder(),
        {
          model: "autodev/orchestrator",
          input: [
            { type: "message", role: "user", content: "A no-memory task." }
          ],
          stream: false
        },
        false,
        "req-disabled-memory",
        null,
        { key: "memory-mode-workspace" }
      );

      await proxyFallbackChain(
        responseRecorder(),
        {
          candidates: [],
          agentRole: "orchestrator",
          subject: "the orchestrator with no providers"
        },
        { model: "autodev/orchestrator", input: [], stream: false },
        false,
        "req-disabled-memory-no-provider",
        null,
        { key: "memory-mode-workspace" }
      );
      const logical = findLogical(snapshotSpans());
      assert.equal(logical.length, 2);
      assert.ok(
        logical.every(
          (span) => span.attributes["autodev.memory.mode"] === "disabled"
        )
      );
      assert.ok(
        logical.every(
          (span) =>
            span.attributes["autodev.memory.injection.result"] === undefined
        )
      );
    } finally {
      globalThis.fetch = originalFetch;
      if (previousKey === undefined) delete process.env.LITELLM_API_KEY;
      else process.env.LITELLM_API_KEY = previousKey;
      if (previousDatabaseUrl === undefined)
        delete process.env.AUTODEV_MEMORY_DATABASE_URL;
      else process.env.AUTODEV_MEMORY_DATABASE_URL = previousDatabaseUrl;
      if (previousMode === undefined) delete process.env.AUTODEV_MEMORY_MODE;
      else process.env.AUTODEV_MEMORY_MODE = previousMode;
      if (previousAblation === undefined)
        delete process.env.AUTODEV_MEMORY_ABLATION;
      else process.env.AUTODEV_MEMORY_ABLATION = previousAblation;
      resetTelemetryExporter();
    }
  }
);

test(
  "fallback chain produces one logical routed-request span and one GenAI attempt span per actual provider/model attempt",
  { concurrency: false },
  async () => {
    COOLDOWNS.clearAll();
    const previousClaude = process.env.LITELLM_API_KEY;
    const previousMiniMax = process.env.MINIMAX_API_KEY;
    process.env.LITELLM_API_KEY = "claude-key";
    process.env.MINIMAX_API_KEY = "minimax-key";
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = String(input);
      return url.includes("claude.test")
        ? new Response("capacity", { status: 503 })
        : jsonResponse({
            id: "resp_2",
            status: "completed",
            model: "MiniMax-M3",
            output: [],
            usage: {
              input_tokens: 120,
              output_tokens: 30,
              cache_read_input_tokens: 12
            }
          });
    }) as typeof fetch;
    installExporter();
    try {
      await proxyFallbackChain(
        responseRecorder(),
        {
          candidates: [
            { ...route("claude", "LITELLM_API_KEY"), model: "sonnet" },
            { ...route("minimax", "MINIMAX_API_KEY"), model: "MiniMax-M3" }
          ],
          role: "worker",
          subject: "worker turn",
          sessionKey: "session-chain",
          session: { key: "session-chain", scope: "identified" }
        },
        { model: "autodev/worker", input: [], stream: false },
        false,
        "req-chain",
        null,
        { key: "fallback-accounting-workspace" }
      );
      const spans = snapshotSpans();
      const logical = findLogical(spans);
      const attempts = findAttemptSpans(spans);
      assert.equal(
        logical.length,
        1,
        "exactly one logical routed-request span per request"
      );
      assert.equal(
        attempts.length,
        2,
        "exactly one GenAI attempt span per actual provider/model attempt"
      );
      const traceId = findLogicalTraceId();
      assert.ok(traceId, "logical span should be on a real trace");
      const logicalSpanId = findLogicalSpanId();
      assert.ok(logicalSpanId, "logical span id must be visible");
      for (const attempt of attempts) {
        assert.equal(attempt.parentSpanContext?.traceId, traceId);
        assert.equal(attempt.parentSpanContext?.spanId, logicalSpanId);
      }
      assert.equal(attempts[0]?.attributes["gen_ai.provider.name"], "claude");
      assert.equal(attempts[0]?.attributes["gen_ai.request.model"], "sonnet");
      assert.equal(
        attempts[0]?.attributes["autodev.requested_model"],
        "autodev/worker",
        "physical attempts retain the model selected by the caller as routing context"
      );
      assert.equal(
        attempts[0]?.attributes["autodev.router.selection"],
        "primary"
      );
      assert.equal(
        attempts[0]?.status.code,
        2,
        "failed Claude attempt is recorded with ERROR status"
      );
      assert.equal(attempts[1]?.attributes["gen_ai.provider.name"], "minimax");
      assert.equal(
        attempts[1]?.attributes["gen_ai.request.model"],
        "MiniMax-M3"
      );
      assert.equal(
        attempts[1]?.attributes["autodev.router.selection"],
        "primary"
      );
      assert.equal(
        attempts[1]?.status.code,
        1,
        "successful MiniMax attempt is recorded with OK status"
      );
      const logicalAttrs = logical[0]?.attributes ?? {};
      assert.equal(
        Object.keys(logicalAttrs).includes("gen_ai.usage.input_tokens"),
        false,
        "logical span must never carry gen_ai.usage.input_tokens"
      );
      assert.equal(
        Object.keys(logicalAttrs).includes("gen_ai.usage.output_tokens"),
        false,
        "logical span must never carry gen_ai.usage.output_tokens"
      );
      assert.equal(
        Object.keys(logicalAttrs).includes(
          "gen_ai.usage.cache_read.input_tokens"
        ),
        false,
        "logical span must never carry gen_ai.usage.cache_read.input_tokens"
      );
      assert.equal(
        Object.keys(logicalAttrs).includes("http.response.status_code"),
        false,
        "logical span must not duplicate attempt-level http status"
      );
      assert.equal(logicalAttrs["autodev.router.subject"], "worker turn");
      assert.equal(logicalAttrs["autodev.router.provider_role"], "subagent");
      assert.equal(logicalAttrs["autodev.requested_model"], "autodev/worker");
      assert.equal(logicalAttrs["autodev.agent.role"], "worker");
      await flushTelemetryMetrics();
      const workspacePoints = (metricName: string) =>
        findMetricPoints(metricName).filter(
          (point) =>
            point.attributes["autodev.workspace"] ===
            "fallback-accounting-workspace"
        );
      const logicalRequests = workspacePoints(
        "autodev.router.logical_requests"
      );
      const physicalDurations = workspacePoints(
        "gen_ai.client.operation.duration"
      );
      const tokenUsage = workspacePoints("gen_ai.client.token.usage");
      const cacheRead = workspacePoints(
        "autodev.gen_ai.cache_read.input_tokens"
      );
      assert.equal(logicalRequests.length, 1);
      assert.equal(logicalRequests[0]?.value, 1);
      assert.equal(physicalDurations.length, 2);
      const inputTokens = tokenUsage.find(
        (point) =>
          point.attributes["gen_ai.provider.name"] === "minimax" &&
          point.attributes["gen_ai.token.type"] === "input"
      );
      const outputTokens = tokenUsage.find(
        (point) =>
          point.attributes["gen_ai.provider.name"] === "minimax" &&
          point.attributes["gen_ai.token.type"] === "output"
      );
      assert.equal(
        inputTokens?.value && typeof inputTokens.value === "object"
          ? inputTokens.value.sum
          : inputTokens?.value,
        120
      );
      assert.equal(
        outputTokens?.value && typeof outputTokens.value === "object"
          ? outputTokens.value.sum
          : outputTokens?.value,
        30
      );
      assert.equal(cacheRead.length, 1);
      assert.equal(
        cacheRead[0]?.value && typeof cacheRead[0].value === "object"
          ? cacheRead[0].value.sum
          : cacheRead[0]?.value,
        12
      );
    } finally {
      globalThis.fetch = originalFetch;
      if (previousClaude === undefined) delete process.env.LITELLM_API_KEY;
      else process.env.LITELLM_API_KEY = previousClaude;
      if (previousMiniMax === undefined) delete process.env.MINIMAX_API_KEY;
      else process.env.MINIMAX_API_KEY = previousMiniMax;
      COOLDOWNS.clearAll();
      resetTelemetryExporter();
    }
  }
);

test(
  "terminal fallback failures and incomplete provider responses mark the logical request as failed",
  { concurrency: false },
  async () => {
    COOLDOWNS.clearAll();
    const previousKey = process.env.LITELLM_API_KEY;
    process.env.LITELLM_API_KEY = "claude-key";
    const originalFetch = globalThis.fetch;

    try {
      for (const [label, upstream] of [
        [
          "non-fallbackable status",
          Response.json(
            { error: { message: "invalid request" } },
            { status: 400 }
          )
        ],
        [
          "incomplete success response",
          jsonResponse({
            id: "resp-incomplete",
            status: "incomplete",
            incomplete_details: { reason: "max_output_tokens" },
            output: []
          })
        ]
      ] as const) {
        globalThis.fetch = (async () => upstream.clone()) as typeof fetch;
        installExporter();
        await proxyFallbackChain(
          responseRecorder(),
          {
            candidates: [
              { ...route("claude", "LITELLM_API_KEY"), model: "sonnet" }
            ],
            role: "worker",
            subject: "terminal failure fixture",
            sessionKey: `session-terminal-${label}`
          },
          { model: "autodev/worker", input: [], stream: false },
          false,
          `req-terminal-${label}`,
          null,
          null
        );

        const logical = findLogical(snapshotSpans());
        assert.equal(logical.length, 1, `${label}: one logical request span`);
        assert.equal(
          logical[0]?.status.code,
          2,
          `${label}: final logical request must not inherit the attempt's transport success`
        );
      }
    } finally {
      globalThis.fetch = originalFetch;
      if (previousKey === undefined) delete process.env.LITELLM_API_KEY;
      else process.env.LITELLM_API_KEY = previousKey;
      COOLDOWNS.clearAll();
      resetTelemetryExporter();
    }
  }
);

test(
  "concrete provider failures mark their logical request as failed",
  { concurrency: false },
  async () => {
    COOLDOWNS.clearAll();
    const previousKey = process.env.LITELLM_API_KEY;
    process.env.LITELLM_API_KEY = "claude-key";
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      Response.json(
        { error: { message: "invalid request" } },
        { status: 400 }
      )) as typeof fetch;
    installExporter();

    try {
      await proxyConcreteResponse(
        responseRecorder(),
        route("claude", "LITELLM_API_KEY"),
        { model: "sonnet", input: [], stream: false },
        false,
        "req-concrete-failure",
        null,
        null
      );

      const logical = findLogical(snapshotSpans());
      assert.equal(logical.length, 1);
      assert.equal(
        logical[0]?.status.code,
        2,
        "a handled upstream failure must not be finalized as a successful request"
      );
    } finally {
      globalThis.fetch = originalFetch;
      if (previousKey === undefined) delete process.env.LITELLM_API_KEY;
      else process.env.LITELLM_API_KEY = previousKey;
      COOLDOWNS.clearAll();
      resetTelemetryExporter();
    }
  }
);

test(
  "a provider served after an exhaustion wait finalizes the logical request once as successful",
  { concurrency: false, skip: EXHAUSTION_WAIT_MS <= 0 },
  async () => {
    COOLDOWNS.clearAll();
    const previousKey = process.env.LITELLM_API_KEY;
    process.env.LITELLM_API_KEY = "claude-key";
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      jsonResponse({
        id: "resp-after-exhaustion-wait",
        status: "completed",
        model: "sonnet",
        output: []
      })) as typeof fetch;
    installExporter();

    try {
      COOLDOWNS.cooldownProvider("claude", {
        failureClass: "quota_exhausted",
        resetsAt: new Date(Date.now() + 100).toISOString(),
        structured: true
      });
      const response = responseRecorder();
      await proxyFallbackChain(
        response,
        {
          candidates: [
            { ...route("claude", "LITELLM_API_KEY"), model: "sonnet" }
          ],
          role: "worker",
          subject: "exhaustion wait fixture",
          sessionKey: "session-exhaustion-wait"
        },
        { model: "autodev/worker", input: [], stream: false },
        false,
        "req-exhaustion-wait-success",
        null,
        null
      );

      assert.equal(response.statusCode, 200);
      const logical = findLogical(snapshotSpans());
      assert.equal(logical.length, 1);
      assert.equal(logical[0]?.status.code, 1);
      assert.equal(
        snapshotSpans().some(
          (span) =>
            span.name === "autodev.routed_request" && span.status.code === 2
        ),
        false,
        "successful retry after the wait must not be followed by failure finalization"
      );
    } finally {
      globalThis.fetch = originalFetch;
      if (previousKey === undefined) delete process.env.LITELLM_API_KEY;
      else process.env.LITELLM_API_KEY = previousKey;
      COOLDOWNS.clearAll();
      resetTelemetryExporter();
    }
  }
);

test(
  "attempt span carries real token usage only when the owning response provides it; logical span never duplicates token counts",
  { concurrency: false },
  async () => {
    COOLDOWNS.clearAll();
    const previousKey = process.env.LITELLM_API_KEY;
    process.env.LITELLM_API_KEY = "claude-key";
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      jsonResponse({
        id: "resp_usage",
        status: "completed",
        model: "sonnet",
        output: [],
        usage: {
          input_tokens: 100,
          output_tokens: 50,
          cache_read_input_tokens: 20
        }
      })) as typeof fetch;
    installExporter();
    try {
      await proxyFallbackChain(
        responseRecorder(),
        {
          candidates: [
            { ...route("claude", "LITELLM_API_KEY"), model: "sonnet" }
          ],
          role: "worker",
          subject: "worker turn",
          sessionKey: "session-usage",
          session: { key: "session-usage", scope: "identified" }
        },
        { model: "autodev/worker", input: [], stream: false },
        false,
        "req-usage",
        null,
        null
      );
      const spans = snapshotSpans();
      const logical = findLogical(spans);
      const attempts = findAttemptSpans(spans);
      assert.equal(logical.length, 1);
      assert.equal(attempts.length, 1);
      const attemptAttrs = attempts[0]?.attributes ?? {};
      const logicalAttrs = logical[0]?.attributes ?? {};
      assert.equal(attemptAttrs["gen_ai.usage.input_tokens"], 100);
      assert.equal(attemptAttrs["gen_ai.usage.output_tokens"], 50);
      assert.equal(attemptAttrs["gen_ai.usage.cache_read.input_tokens"], 20);
      assert.equal(
        Object.keys(logicalAttrs).includes("gen_ai.usage.input_tokens"),
        false
      );
      assert.equal(
        Object.keys(logicalAttrs).includes("gen_ai.usage.output_tokens"),
        false
      );
      assert.equal(
        Object.keys(logicalAttrs).includes(
          "gen_ai.usage.cache_read.input_tokens"
        ),
        false
      );
      assert.equal(
        Number(attemptAttrs["gen_ai.usage.cache_read.input_tokens"]) >
          Number(attemptAttrs["gen_ai.usage.input_tokens"]),
        false,
        "cache read must be a subset of input tokens"
      );
    } finally {
      globalThis.fetch = originalFetch;
      if (previousKey === undefined) delete process.env.LITELLM_API_KEY;
      else process.env.LITELLM_API_KEY = previousKey;
      COOLDOWNS.clearAll();
      resetTelemetryExporter();
    }
  }
);

test(
  "absent cache_read input tokens produce no SyntheticError field; logical span omits both",
  { concurrency: false },
  async () => {
    COOLDOWNS.clearAll();
    const previousKey = process.env.LITELLM_API_KEY;
    process.env.LITELLM_API_KEY = "claude-key";
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      jsonResponse({
        id: "resp_no_cache",
        status: "completed",
        model: "sonnet",
        output: [],
        usage: { input_tokens: 12, output_tokens: 8 }
      })) as typeof fetch;
    installExporter();
    try {
      await proxyFallbackChain(
        responseRecorder(),
        {
          candidates: [
            { ...route("claude", "LITELLM_API_KEY"), model: "sonnet" }
          ],
          role: "worker",
          subject: "worker turn"
        },
        { model: "autodev/worker", input: [], stream: false },
        false,
        "req-no-cache",
        null,
        null
      );
      const attempts = findAttemptSpans(snapshotSpans());
      const logical = findLogical(snapshotSpans());
      const attemptAttrs = attempts[0]?.attributes ?? {};
      assert.equal(attemptAttrs["gen_ai.usage.input_tokens"], 12);
      assert.equal(attemptAttrs["gen_ai.usage.output_tokens"], 8);
      assert.equal(
        Object.keys(attemptAttrs).includes(
          "gen_ai.usage.cache_read.input_tokens"
        ),
        false,
        "no zero-placeholder when cache_read is absent"
      );
      const logicalAttrs = logical[0]?.attributes ?? {};
      assert.equal(
        Object.keys(logicalAttrs).includes("gen_ai.usage.input_tokens"),
        false
      );
    } finally {
      globalThis.fetch = originalFetch;
      if (previousKey === undefined) delete process.env.LITELLM_API_KEY;
      else process.env.LITELLM_API_KEY = previousKey;
      COOLDOWNS.clearAll();
      resetTelemetryExporter();
    }
  }
);

test("missing workspace and unattributed role produce no autodev.workspace/autodev.agent.role attributes", async () => {
  COOLDOWNS.clearAll();
  const previousKey = process.env.LITELLM_API_KEY;
  process.env.LITELLM_API_KEY = "claude-key";
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    jsonResponse({
      id: "resp_priv",
      status: "completed",
      model: "sonnet",
      output: []
    })) as typeof fetch;
  installExporter();
  try {
    await proxyFallbackChain(
      responseRecorder(),
      {
        candidates: [
          { ...route("claude", "LITELLM_API_KEY"), model: "sonnet" }
        ],
        role: "unattributed",
        subject: "unattributed turn"
      },
      { model: "autodev/worker", input: [], stream: false },
      false,
      "req-priv",
      null,
      null
    );
    const spans = snapshotSpans();
    const logical = findLogical(spans)[0];
    assert.ok(logical);
    const logicalAttrs = logical.attributes;
    assert.equal(
      Object.keys(logicalAttrs).includes("autodev.workspace"),
      false,
      "missing workspace must not produce an attribute"
    );
    assert.equal(
      Object.keys(logicalAttrs).includes("autodev.agent.role"),
      false,
      "unattributed role must not produce an attribute"
    );
  } finally {
    globalThis.fetch = originalFetch;
    if (previousKey === undefined) delete process.env.LITELLM_API_KEY;
    else process.env.LITELLM_API_KEY = previousKey;
    COOLDOWNS.clearAll();
    resetTelemetryExporter();
  }
});

test(
  "an upstream 503 carries http.response.status_code from the source response, never a fabricated value",
  { concurrency: false },
  async () => {
    COOLDOWNS.clearAll();
    const previousKey = process.env.LITELLM_API_KEY;
    process.env.LITELLM_API_KEY = "claude-key";
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response("capacity", { status: 503 })) as typeof fetch;
    installExporter();
    try {
      await proxyFallbackChain(
        responseRecorder(),
        {
          candidates: [
            { ...route("claude", "LITELLM_API_KEY"), model: "sonnet" }
          ],
          role: "worker",
          subject: "worker turn"
        },
        { model: "autodev/worker", input: [], stream: false },
        false,
        "req-503",
        null,
        null
      );
      const attempts = findAttemptSpans(snapshotSpans());
      const logical = findLogical(snapshotSpans());
      assert.equal(attempts.length, 1);
      assert.equal(attempts[0]?.attributes["http.response.status_code"], 503);
      assert.equal(
        Object.keys(logical[0]?.attributes ?? {}).includes(
          "http.response.status_code"
        ),
        false
      );
    } finally {
      globalThis.fetch = originalFetch;
      if (previousKey === undefined) delete process.env.LITELLM_API_KEY;
      else process.env.LITELLM_API_KEY = previousKey;
      COOLDOWNS.clearAll();
      resetTelemetryExporter();
    }
  }
);

test(
  "transport-unavailable candidate produces attempt spans with status ERROR and no synthetic token totals",
  { concurrency: false },
  async () => {
    COOLDOWNS.clearAll();
    const previousClaude = process.env.LITELLM_API_KEY;
    const previousMiniMax = process.env.MINIMAX_API_KEY;
    process.env.LITELLM_API_KEY = "claude-key";
    process.env.MINIMAX_API_KEY = "minimax-key";
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("claude.test")) {
        throw new TypeError("fetch failed", {
          cause: Object.assign(new Error("connect ECONNREFUSED"), {
            code: "ECONNREFUSED"
          })
        });
      }
      return jsonResponse({
        id: "resp_other",
        status: "completed",
        model: "MiniMax-M3",
        output: []
      });
    }) as typeof fetch;
    installExporter();
    try {
      await proxyFallbackChain(
        responseRecorder(),
        {
          candidates: [
            { ...route("claude", "LITELLM_API_KEY"), model: "sonnet" },
            { ...route("minimax", "MINIMAX_API_KEY"), model: "MiniMax-M3" }
          ],
          role: "worker",
          subject: "worker turn"
        },
        { model: "autodev/worker", input: [], stream: false },
        false,
        "req-unavailable",
        null,
        null
      );
      const spans = snapshotSpans();
      const logical = findLogical(spans);
      const attempts = findAttemptSpans(spans);
      // Claude transport-fails: each retry is its own physical attempt
      // span, so the count is at least one Claude attempt plus the
      // successful MiniMax fallback. With UPSTREAM_TRANSPORT_MAX_ATTEMPTS
      // retries the Claude provider can produce up to that many spans
      // before the chain falls back.
      const claudeAttempts = attempts.filter(
        (a) => a.attributes["gen_ai.provider.name"] === "claude"
      );
      const minimaxAttempts = attempts.filter(
        (a) => a.attributes["gen_ai.provider.name"] === "minimax"
      );
      assert.ok(
        claudeAttempts.length > 0,
        "at least one Claude attempt span must be emitted"
      );
      assert.equal(
        minimaxAttempts.length,
        1,
        "exactly one MiniMax attempt span for the fallback"
      );
      // Every Claude attempt span: error status, no synthetic tokens,
      // no http status code (transport error never produced one).
      for (const claudeAttempt of claudeAttempts) {
        assert.equal(
          claudeAttempt.status.code,
          2,
          "transport-unavailable Claude attempt records ERROR status"
        );
        assert.equal(
          Object.keys(claudeAttempt.attributes).includes(
            "gen_ai.usage.input_tokens"
          ),
          false
        );
        assert.equal(
          Object.keys(claudeAttempt.attributes).includes(
            "gen_ai.usage.output_tokens"
          ),
          false
        );
        assert.equal(
          Object.keys(claudeAttempt.attributes).includes(
            "gen_ai.usage.cache_read.input_tokens"
          ),
          false
        );
      }
      // The successful MiniMax attempt is recorded with OK status and
      // has no token totals because the mock body omits usage.
      assert.equal(minimaxAttempts[0]?.status.code, 1);
      assert.equal(
        Object.keys(minimaxAttempts[0]?.attributes ?? {}).includes(
          "gen_ai.usage.input_tokens"
        ),
        false
      );
      // The logical span never carries attempt-level outcomes.
      assert.equal(
        Object.keys(logical[0]?.attributes ?? {}).includes(
          "gen_ai.usage.input_tokens"
        ),
        false
      );
      assert.equal(
        Object.keys(logical[0]?.attributes ?? {}).includes(
          "http.response.status_code"
        ),
        false
      );
    } finally {
      globalThis.fetch = originalFetch;
      if (previousClaude === undefined) delete process.env.LITELLM_API_KEY;
      else process.env.LITELLM_API_KEY = previousClaude;
      if (previousMiniMax === undefined) delete process.env.MINIMAX_API_KEY;
      else process.env.MINIMAX_API_KEY = previousMiniMax;
      COOLDOWNS.clearAll();
      resetTelemetryExporter();
    }
  }
);

test(
  "concrete retry emits one GenAI attempt span per fetchUpstream call, including retries",
  { concurrency: false },
  async () => {
    COOLDOWNS.clearAll();
    const previousKey = process.env.LITELLM_API_KEY;
    process.env.LITELLM_API_KEY = "claude-key";
    const originalFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      return calls === 1
        ? new Response("temporarily unavailable", { status: 503 })
        : jsonResponse({
            id: "resp_2",
            status: "completed",
            model: "sonnet",
            output: []
          });
    }) as typeof fetch;
    installExporter();
    try {
      await proxyConcreteResponse(
        responseRecorder(),
        route("claude", "LITELLM_API_KEY"),
        { model: "sonnet", input: [], stream: false },
        false,
        "req-concrete-retry",
        null,
        null,
        null,
        { key: "session-concrete-retry", scope: "identified" }
      );
      const spans = snapshotSpans();
      const logical = findLogical(spans);
      const attempts = findAttemptSpans(spans);
      assert.equal(logical.length, 1);
      assert.equal(attempts.length, 2);
      for (const attempt of attempts) {
        assert.equal(attempt.attributes["gen_ai.provider.name"], "claude");
        assert.equal(attempt.attributes["gen_ai.request.model"], "sonnet");
        assert.equal(
          attempt.attributes["autodev.router.selection"],
          "concrete"
        );
      }
      assert.equal(attempts[0]?.attributes["autodev.router.attempt_number"], 1);
      assert.equal(attempts[1]?.attributes["autodev.router.attempt_number"], 2);
    } finally {
      globalThis.fetch = originalFetch;
      if (previousKey === undefined) delete process.env.LITELLM_API_KEY;
      else process.env.LITELLM_API_KEY = previousKey;
      COOLDOWNS.clearAll();
      resetTelemetryExporter();
    }
  }
);

test("the OTLP exporter is not installed when OTEL_EXPORTER_OTLP_ENDPOINT is unset", async () => {
  const previousEndpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  try {
    const { ensureOtelInitialized, isOtlpExporterInstalled } =
      await import("@simulatorlife/autodev-runtime/router/telemetry");
    const tracer = ensureOtelInitialized();
    assert.ok(tracer, "tracer must be returned even without an endpoint");
    assert.equal(isOtlpExporterInstalled(), false);
  } finally {
    if (previousEndpoint !== undefined)
      process.env.OTEL_EXPORTER_OTLP_ENDPOINT = previousEndpoint;
  }
});

test(
  "positive context compaction emits source-confirmed OTel counter exactly once with bounded categorical labels",
  { concurrency: false },
  async () => {
    installExporter();
    const compactionTurnMetadata = JSON.stringify({
      request_kind: "compaction",
      compaction: {
        trigger: "threshold",
        reason: "context_window_exceeded",
        implementation: "summarize",
        phase: "pre_turn",
        strategy: "drop_middle"
      },
      workspaces: { "/path/to/repo": {} }
    });

    const logical = startLogicalRequestSpan({
      requestId: "positive-compaction-req",
      role: "worker",
      providerRole: "subagent",
      workspace: { key: "positive-compaction-workspace" },
      subject: "compaction request",
      requestedModel: "gpt-4o",
      turnMetadataHeader: compactionTurnMetadata
    });

    await withLogicalSpan(logical, async () => {
      const attempt = startAttemptSpan({
        provider: "openai",
        model: "gpt-4o",
        selection: "primary",
        attemptNumber: 1,
        role: "worker",
        workspace: { key: "positive-compaction-workspace" }
      });
      endAttemptSpan(attempt, {
        status: "ok",
        responseModel: "gpt-4o"
      });
    });

    endLogicalRequestSpan(logical, {
      status: "ok",
      provider: "openai"
    });
    await flushTelemetryMetrics();

    const points = findMetricPoints(METRIC_CONTEXT_COMPACTIONS).filter(
      (p) =>
        p.attributes["autodev.workspace"] === "positive-compaction-workspace"
    );
    assert.equal(
      points.length,
      1,
      "exactly one compaction point must be emitted for positive case"
    );
    const point = points[0]!;
    assert.equal(point.value, 1);
    assert.equal(point.attributes["gen_ai.provider.name"], "openai");
    assert.equal(point.attributes["gen_ai.request.model"], "gpt-4o");
    assert.equal(
      point.attributes["autodev.workspace"],
      "positive-compaction-workspace"
    );
    assert.equal(point.attributes["autodev.agent.role"], "worker");
    assert.equal(point.attributes["autodev.compaction.trigger"], "threshold");
    assert.equal(
      point.attributes["autodev.compaction.reason"],
      "context_window_exceeded"
    );
    assert.equal(
      point.attributes["autodev.compaction.implementation"],
      "summarize"
    );
    assert.equal(point.attributes["autodev.compaction.phase"], "pre_turn");
    assert.equal(
      point.attributes["autodev.compaction.strategy"],
      "drop_middle"
    );

    // Verify logical span recorded request_kind
    const spans = snapshotSpans();
    const logicalSpan = spans.find((s) => s.name === "autodev.routed_request");
    assert.equal(logicalSpan?.attributes["autodev.request_kind"], "compaction");
    assert.equal(
      logicalSpan?.attributes["autodev.compaction.trigger"],
      "threshold"
    );
  }
);

test(
  "non-compaction requests including remote_compaction_v2 do not emit compaction counts",
  { concurrency: false },
  async () => {
    installExporter();

    // Case 1: remote_compaction_v2 is present on regular request - NOT compaction
    const regularWithRemoteCompactionFlag = JSON.stringify({
      remote_compaction_v2: true,
      workspaces: { "/path/to/repo": {} }
    });

    const logical1 = startLogicalRequestSpan({
      requestId: "normal-req-with-remote-flag",
      role: "worker",
      providerRole: "subagent",
      workspace: { key: "non-compaction-workspace" },
      subject: "regular request",
      requestedModel: "gpt-4o",
      turnMetadataHeader: regularWithRemoteCompactionFlag
    });
    endLogicalRequestSpan(logical1, { status: "ok", provider: "openai" });

    // Case 2: request_kind is "chat"
    const chatRequest = JSON.stringify({
      request_kind: "chat",
      compaction: { trigger: "manual" },
      workspaces: { "/path/to/repo": {} }
    });
    const logical2 = startLogicalRequestSpan({
      requestId: "chat-req",
      role: "worker",
      providerRole: "subagent",
      workspace: { key: "non-compaction-workspace" },
      subject: "chat request",
      requestedModel: "gpt-4o",
      turnMetadataHeader: chatRequest
    });
    endLogicalRequestSpan(logical2, { status: "ok", provider: "openai" });

    // Case 3: missing metadata entirely
    const logical3 = startLogicalRequestSpan({
      requestId: "no-metadata-req",
      role: "worker",
      providerRole: "subagent",
      workspace: { key: "non-compaction-workspace" },
      subject: "no metadata request",
      requestedModel: "gpt-4o",
      turnMetadataHeader: null
    });
    endLogicalRequestSpan(logical3, { status: "ok", provider: "openai" });

    await flushTelemetryMetrics();
    const points = findMetricPoints(METRIC_CONTEXT_COMPACTIONS).filter(
      (p) => p.attributes["autodev.workspace"] === "non-compaction-workspace"
    );
    assert.equal(
      points.length,
      0,
      "non-compaction requests must never emit compaction metrics"
    );
  }
);

test(
  "failed compaction request does not emit compaction counter",
  { concurrency: false },
  async () => {
    installExporter();
    const compactionMetadata = JSON.stringify({
      request_kind: "compaction",
      compaction: { trigger: "threshold", reason: "overflow" }
    });

    const logical = startLogicalRequestSpan({
      requestId: "failed-compaction-req",
      role: "worker",
      providerRole: "subagent",
      workspace: { key: "failed-compaction-workspace" },
      subject: "failed compaction",
      requestedModel: "gpt-4o",
      turnMetadataHeader: compactionMetadata
    });

    // Request failed with error
    endLogicalRequestSpan(logical, {
      status: "error",
      errorMessage: "upstream 503 unavailable"
    });
    await flushTelemetryMetrics();

    const points = findMetricPoints(METRIC_CONTEXT_COMPACTIONS).filter(
      (p) => p.attributes["autodev.workspace"] === "failed-compaction-workspace"
    );
    assert.equal(
      points.length,
      0,
      "failed compaction requests must not increment the compaction counter"
    );
  }
);

test(
  "duplicate requests and client retries with same requestId are deduplicated",
  { concurrency: false },
  async () => {
    installExporter();
    const compactionMetadata = JSON.stringify({
      request_kind: "compaction",
      compaction: { trigger: "threshold" }
    });

    // First attempt succeeds
    const logical1 = startLogicalRequestSpan({
      requestId: "dedup-same-request-id",
      role: "worker",
      providerRole: "subagent",
      workspace: { key: "dedup-workspace" },
      subject: "compaction attempt 1",
      requestedModel: "gpt-4o",
      turnMetadataHeader: compactionMetadata
    });
    endLogicalRequestSpan(logical1, { status: "ok", provider: "openai" });

    // Client-side retry with same requestId succeeds again
    const logical2 = startLogicalRequestSpan({
      requestId: "dedup-same-request-id",
      role: "worker",
      providerRole: "subagent",
      workspace: { key: "dedup-workspace" },
      subject: "compaction retry 2",
      requestedModel: "gpt-4o",
      turnMetadataHeader: compactionMetadata
    });
    endLogicalRequestSpan(logical2, { status: "ok", provider: "openai" });

    await flushTelemetryMetrics();
    const points = findMetricPoints(METRIC_CONTEXT_COMPACTIONS).filter(
      (p) => p.attributes["autodev.workspace"] === "dedup-workspace"
    );
    assert.equal(
      points.length,
      1,
      "retried request with same requestId must not double count"
    );
    assert.equal(points[0]?.value, 1);
  }
);

test("privacy protection sanitizes IDs, paths, prompt content, and high-cardinality values", () => {
  // Valid categorical values pass
  assert.equal(sanitizeCategoricalLabel("threshold"), "threshold");
  assert.equal(
    sanitizeCategoricalLabel("context_window_exceeded"),
    "context_window_exceeded"
  );
  assert.equal(sanitizeCategoricalLabel("drop_middle"), "drop_middle");
  assert.equal(sanitizeCategoricalLabel("pre_turn"), "pre_turn");
  assert.equal(sanitizeCategoricalLabel("summarize"), "summarize");

  // Prohibited IDs and prefixes are stripped
  assert.equal(sanitizeCategoricalLabel("session-12345"), null);
  assert.equal(sanitizeCategoricalLabel("thread_abc123"), null);
  assert.equal(sanitizeCategoricalLabel("turn.001"), null);
  assert.equal(sanitizeCategoricalLabel("window_id_99"), null);
  assert.equal(sanitizeCategoricalLabel("req-4567"), null);
  assert.equal(sanitizeCategoricalLabel("conv-789"), null);

  // UUIDs are stripped
  assert.equal(
    sanitizeCategoricalLabel("123e4567-e89b-12d3-a456-426614174000"),
    null
  );

  // Paths and URLs are stripped
  assert.equal(sanitizeCategoricalLabel("/Users/project/path"), null);
  assert.equal(sanitizeCategoricalLabel("http://example.com"), null);

  // Content with whitespace is stripped
  assert.equal(sanitizeCategoricalLabel("Summarize this context please"), null);

  // Oversized (>64 chars) is stripped
  assert.equal(sanitizeCategoricalLabel("a".repeat(65)), null);

  // Unattributed and unknown are stripped
  assert.equal(sanitizeCategoricalLabel("unattributed"), null);
  assert.equal(sanitizeCategoricalLabel("unknown"), null);

  // Non-string is stripped
  assert.equal(sanitizeCategoricalLabel(123), null);
  assert.equal(sanitizeCategoricalLabel(null), null);
  assert.equal(sanitizeCategoricalLabel(undefined), null);

  // Hex hashes are stripped
  assert.equal(
    sanitizeCategoricalLabel(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
    ),
    null
  );
});

test(
  "exported metric plumbing verifies OTel descriptor, unit, and cumulative sum",
  { concurrency: false },
  async () => {
    installExporter();
    const result = recordContextCompaction({
      requestId: "exported-plumbing-req",
      provider: "anthropic",
      model: "claude-sonnet",
      workspace: { key: "test-workspace" },
      role: "worker",
      compaction: {
        trigger: "threshold",
        strategy: "drop_middle"
      }
    });
    assert.equal(result, true);
    await flushTelemetryMetrics();

    const metric = telemetryMetricExporter
      .getMetrics()
      .flatMap((r) => r.scopeMetrics)
      .flatMap((s) => s.metrics)
      .find((m) => m.descriptor.name === METRIC_CONTEXT_COMPACTIONS);

    assert.ok(metric, "metric must exist in exported metrics");
    assert.equal(metric.descriptor.name, "autodev.context.compactions");
    assert.equal(metric.descriptor.unit, "{compaction}");
    assert.equal(
      metric.descriptor.description,
      "Source-confirmed context compactions completed by the AutoDev router."
    );
    const point = metric.dataPoints.find(
      (p) =>
        (p as { attributes: Record<string, unknown> }).attributes[
          "autodev.workspace"
        ] === "test-workspace"
    ) as { value: number } | undefined;
    assert.ok(point, "data point for test-workspace must exist");
    assert.equal(point.value, 1);
  }
);

test(
  "proxyConcreteResponse emits compaction metric on successful served response",
  { concurrency: false },
  async () => {
    const previousKey = process.env.LITELLM_API_KEY;
    process.env.LITELLM_API_KEY = "claude-key";
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      jsonResponse({
        id: "resp_compaction",
        status: "completed",
        model: "sonnet",
        output: []
      })) as typeof fetch;

    installExporter();
    const compactionHeader = JSON.stringify({
      request_kind: "compaction",
      compaction: {
        trigger: "threshold",
        reason: "window_pressure"
      },
      workspaces: { "/path/to/project": {} }
    });

    try {
      await proxyConcreteResponse(
        responseRecorder(),
        route("claude", "LITELLM_API_KEY"),
        { model: "sonnet", input: [], stream: false },
        false,
        "req-concrete-compaction-e2e",
        compactionHeader,
        { key: "workspace-concrete" },
        null,
        { key: "session-concrete-compaction", scope: "identified" }
      );
      await flushTelemetryMetrics();

      const points = findMetricPoints(METRIC_CONTEXT_COMPACTIONS).filter(
        (p) => p.attributes["autodev.workspace"] === "workspace-concrete"
      );
      assert.equal(
        points.length,
        1,
        "compaction point must be emitted by proxy"
      );
      assert.equal(points[0]?.attributes["gen_ai.provider.name"], "claude");
      assert.equal(points[0]?.attributes["gen_ai.request.model"], "sonnet");
      assert.equal(
        points[0]?.attributes["autodev.workspace"],
        "workspace-concrete"
      );
      assert.equal(
        points[0]?.attributes["autodev.compaction.trigger"],
        "threshold"
      );
      assert.equal(
        points[0]?.attributes["autodev.compaction.reason"],
        "window_pressure"
      );
    } finally {
      globalThis.fetch = originalFetch;
      if (previousKey === undefined) delete process.env.LITELLM_API_KEY;
      else process.env.LITELLM_API_KEY = previousKey;
      COOLDOWNS.clearAll();
      resetTelemetryExporter();
    }
  }
);

test(
  "proxyFallbackChain retry across candidates emits exactly one compaction point for the serving provider",
  { concurrency: false },
  async () => {
    const previousClaudeKey = process.env.LITELLM_API_KEY;
    const previousMinimaxKey = process.env.MINIMAX_API_KEY;
    process.env.LITELLM_API_KEY = "claude-key";
    process.env.MINIMAX_API_KEY = "minimax-key";
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input) => {
      const url = String(input);
      if (url.includes("claude.test")) {
        return new Response("claude overloaded", { status: 529 });
      }
      return jsonResponse({
        id: "resp_minimax",
        status: "completed",
        model: "MiniMax-M3",
        output: []
      });
    }) as typeof fetch;

    installExporter();
    const compactionHeader = JSON.stringify({
      request_kind: "compaction",
      compaction: {
        trigger: "threshold",
        strategy: "drop_middle"
      },
      workspaces: { "/path/to/project": {} }
    });

    const candidates = [
      route("claude", "LITELLM_API_KEY"),
      route("minimax", "MINIMAX_API_KEY")
    ];

    try {
      await proxyFallbackChain(
        responseRecorder(),
        {
          candidates,
          role: "worker",
          subject: "fallback compaction"
        },
        { model: "worker-model", input: [], stream: false },
        false,
        "req-fallback-compaction-e2e",
        compactionHeader,
        { key: "workspace-fallback" },
        null
      );
      await flushTelemetryMetrics();

      const points = findMetricPoints(METRIC_CONTEXT_COMPACTIONS).filter(
        (p) => p.attributes["autodev.workspace"] === "workspace-fallback"
      );
      assert.equal(
        points.length,
        1,
        "fallback retry across multiple candidates must emit exactly one compaction count"
      );
      assert.equal(
        points[0]?.attributes["gen_ai.provider.name"],
        "minimax",
        "must be attributed to the provider that actually served the request"
      );
      assert.equal(points[0]?.attributes["autodev.agent.role"], "worker");
      assert.equal(
        points[0]?.attributes["autodev.compaction.strategy"],
        "drop_middle"
      );
    } finally {
      globalThis.fetch = originalFetch;
      if (previousClaudeKey === undefined) delete process.env.LITELLM_API_KEY;
      else process.env.LITELLM_API_KEY = previousClaudeKey;
      if (previousMinimaxKey === undefined) delete process.env.MINIMAX_API_KEY;
      else process.env.MINIMAX_API_KEY = previousMinimaxKey;
      COOLDOWNS.clearAll();
      resetTelemetryExporter();
    }
  }
);

test("compactCompactionDimension maps source-supported values and collapses unfamiliar values to a single bucket", () => {
  const { trigger, reason, implementation, phase, strategy } =
    COMPACTION_DIMENSION_ALLOWLISTS;

  // Source-supported values pass through unchanged.
  for (const value of trigger) {
    assert.equal(compactCompactionDimension(value, trigger), value);
  }
  for (const value of reason) {
    assert.equal(compactCompactionDimension(value, reason), value);
  }
  for (const value of implementation) {
    assert.equal(compactCompactionDimension(value, implementation), value);
  }
  for (const value of phase) {
    assert.equal(compactCompactionDimension(value, phase), value);
  }
  for (const value of strategy) {
    assert.equal(compactCompactionDimension(value, strategy), value);
  }

  // Shape-safe but unfamiliar values collapse to COMPACTION_DIMENSION_OTHER
  // so attacker-controlled metadata cannot multiply metric series.
  const unfamiliar = [
    "hostile_label_1",
    "attacker_supplied_2",
    "unique_value_3",
    "x".repeat(63),
    "z".repeat(63),
    "label.with.dots",
    "MixedCaseValue",
    "totally_new_category"
  ];
  const seen = new Set<string>();
  for (const value of unfamiliar) {
    const mapped = compactCompactionDimension(value, trigger);
    assert.equal(mapped, COMPACTION_DIMENSION_OTHER);
    if (mapped) seen.add(mapped);
  }
  assert.equal(
    seen.size,
    1,
    "unfamiliar values must collapse to exactly one bucket"
  );

  // Non-string, empty, oversized, ID-like, or otherwise unsafe values
  // return null so the metric recorder omits the dimension entirely.
  assert.equal(compactCompactionLabelLike(null, trigger), null);
  assert.equal(compactCompactionLabelLike(undefined, trigger), null);
  assert.equal(compactCompactionLabelLike(42, trigger), null);
  assert.equal(compactCompactionLabelLike("", trigger), null);
  assert.equal(compactCompactionLabelLike("a".repeat(65), trigger), null);
  assert.equal(compactCompactionLabelLike("session-12345", trigger), null);
  assert.equal(compactCompactionLabelLike("unattributed", trigger), null);
  assert.equal(compactCompactionLabelLike("unknown", trigger), null);
  assert.equal(
    compactCompactionLabelLike("123e4567-e89b-12d3-a456-426614174000", trigger),
    null
  );

  // Allowlist size is the upper bound on cardinality for that dimension
  // plus one. Each clamp's cardinality is strictly bounded.
  for (const [name, set] of Object.entries(COMPACTION_DIMENSION_ALLOWLISTS)) {
    assert.ok(
      set.size > 0 && set.size <= 16,
      `${name} allowlist must be small and bounded, got ${set.size}`
    );
  }
});

function compactCompactionLabelLike(
  value: unknown,
  allowlist: ReadonlySet<string>
): string | null {
  return compactCompactionDimension(value, allowlist);
}

test(
  "arbitrary attacker-supplied metadata cannot multiply the compaction metric series",
  { concurrency: false },
  async () => {
    installExporter();

    // Generate 200 unique attacker-controlled trigger/reason/implementation/
    // phase/strategy values, all shape-safe for `sanitizeCategoricalLabel`
    // (64 chars, alphanumeric/_.-) but never present in any source allowlist.
    // Each one would have created a new metric series without the bounded
    // dimension allowlist.
    const alphabet =
      "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
    const seenTriggers = new Set<string>();
    const seenReasons = new Set<string>();
    const seenImplementations = new Set<string>();
    const seenPhases = new Set<string>();
    const seenStrategies = new Set<string>();

    function randomLabel(): string {
      let out = "";
      for (let i = 0; i < 24; i += 1) {
        const idx = Math.floor(Math.random() * alphabet.length);
        out += alphabet[idx];
      }
      return out;
    }

    function unique(pool: Set<string>, prefix: string, index: number): string {
      let candidate = `${prefix}_${index}_${randomLabel()}`;
      while (pool.has(candidate)) candidate = `${candidate}x`;
      pool.add(candidate);
      return candidate;
    }

    const totalRequests = 200;
    for (let i = 0; i < totalRequests; i += 1) {
      const logical = startLogicalRequestSpan({
        requestId: `cardinality-bounded-${i}`,
        role: "worker",
        providerRole: "subagent",
        workspace: { key: "cardinality-bounded-workspace" },
        subject: `bounded compaction ${i}`,
        requestedModel: "gpt-4o",
        turnMetadataHeader: JSON.stringify({
          request_kind: "compaction",
          compaction: {
            trigger: unique(seenTriggers, "trigger", i),
            reason: unique(seenReasons, "reason", i),
            implementation: unique(seenImplementations, "impl", i),
            phase: unique(seenPhases, "phase", i),
            strategy: unique(seenStrategies, "strategy", i)
          },
          workspaces: { "/path/to/repo": {} }
        })
      });
      await withLogicalSpan(logical, async () => {
        const attempt = startAttemptSpan({
          provider: "openai",
          model: "gpt-4o",
          selection: "primary",
          attemptNumber: 1,
          role: "worker",
          workspace: { key: "cardinality-bounded-workspace" }
        });
        endAttemptSpan(attempt, {
          status: "ok",
          responseModel: "gpt-4o"
        });
      });
      endLogicalRequestSpan(logical, {
        status: "ok",
        provider: "openai"
      });
    }

    await flushTelemetryMetrics();
    const points = findMetricPoints(METRIC_CONTEXT_COMPACTIONS).filter(
      (p) =>
        p.attributes["autodev.workspace"] === "cardinality-bounded-workspace"
    );

    // Every unknown dimension value collapses to COMPACTION_DIMENSION_OTHER,
    // so all 200 distinct requests must collapse into a single bounded
    // metric series, not 200 series.
    assert.equal(
      points.length,
      1,
      "200 distinct arbitrary metadata values must collapse to a single bounded metric series"
    );
    assert.equal(points[0]?.value, totalRequests);
    assert.equal(
      points[0]?.attributes["autodev.compaction.trigger"],
      COMPACTION_DIMENSION_OTHER
    );
    assert.equal(
      points[0]?.attributes["autodev.compaction.reason"],
      COMPACTION_DIMENSION_OTHER
    );
    assert.equal(
      points[0]?.attributes["autodev.compaction.implementation"],
      COMPACTION_DIMENSION_OTHER
    );
    assert.equal(
      points[0]?.attributes["autodev.compaction.phase"],
      COMPACTION_DIMENSION_OTHER
    );
    assert.equal(
      points[0]?.attributes["autodev.compaction.strategy"],
      COMPACTION_DIMENSION_OTHER
    );
    assert.equal(
      points[0]?.attributes["autodev.workspace"],
      "cardinality-bounded-workspace"
    );
    assert.equal(points[0]?.attributes["autodev.agent.role"], "worker");
    assert.equal(points[0]?.attributes["gen_ai.provider.name"], "openai");
    assert.equal(points[0]?.attributes["gen_ai.request.model"], "gpt-4o");
  }
);

test(
  "unknown compaction categories still increment the counter once per source-confirmed compaction",
  { concurrency: false },
  async () => {
    installExporter();

    // Each invocation uses unique, unfamiliar trigger/reason/implementation
    // values that all collapse to COMPACTION_DIMENSION_OTHER, but the
    // counter must still increment exactly once per request because the
    // request_kind was source-confirmed as "compaction".
    const ids = ["unknown-cat-req-a", "unknown-cat-req-b", "unknown-cat-req-c"];
    for (const requestId of ids) {
      const logical = startLogicalRequestSpan({
        requestId,
        role: "worker",
        providerRole: "subagent",
        workspace: { key: "unknown-cat-workspace" },
        subject: "unknown category compaction",
        requestedModel: "gpt-4o",
        turnMetadataHeader: JSON.stringify({
          request_kind: "compaction",
          compaction: {
            trigger: "unfamiliar_trigger_xyz",
            reason: "unfamiliar_reason_xyz",
            implementation: "unfamiliar_impl_xyz",
            phase: "unfamiliar_phase",
            strategy: "unfamiliar_strategy"
          },
          workspaces: { "/path/to/repo": {} }
        })
      });
      await withLogicalSpan(logical, async () => {
        const attempt = startAttemptSpan({
          provider: "openai",
          model: "gpt-4o",
          selection: "primary",
          attemptNumber: 1,
          role: "worker",
          workspace: { key: "unknown-cat-workspace" }
        });
        endAttemptSpan(attempt, {
          status: "ok",
          responseModel: "gpt-4o"
        });
      });
      endLogicalRequestSpan(logical, {
        status: "ok",
        provider: "openai"
      });
    }

    await flushTelemetryMetrics();
    const points = findMetricPoints(METRIC_CONTEXT_COMPACTIONS).filter(
      (p) => p.attributes["autodev.workspace"] === "unknown-cat-workspace"
    );

    // All three requests share the same collapsed dimensions, so they
    // aggregate into a single bounded series with sum == 3.
    assert.equal(points.length, 1);
    assert.equal(points[0]?.value, ids.length);
    for (const dimension of [
      "autodev.compaction.trigger",
      "autodev.compaction.reason",
      "autodev.compaction.implementation",
      "autodev.compaction.phase",
      "autodev.compaction.strategy"
    ]) {
      assert.equal(
        points[0]?.attributes[dimension],
        COMPACTION_DIMENSION_OTHER,
        `${dimension} must collapse to ${COMPACTION_DIMENSION_OTHER}`
      );
    }
  }
);

test(
  "mixing source-supported and unfamiliar values keeps the supported value and only collapses the unfamiliar one",
  { concurrency: false },
  async () => {
    installExporter();

    // First request: trigger is allowed ("threshold"), reason is unfamiliar.
    const logical1 = startLogicalRequestSpan({
      requestId: "mixed-cat-req-1",
      role: "worker",
      providerRole: "subagent",
      workspace: { key: "mixed-cat-workspace" },
      subject: "mixed category compaction",
      requestedModel: "gpt-4o",
      turnMetadataHeader: JSON.stringify({
        request_kind: "compaction",
        compaction: {
          trigger: "threshold",
          reason: "completely_unknown_reason"
        },
        workspaces: { "/path/to/repo": {} }
      })
    });
    await withLogicalSpan(logical1, async () => {
      const attempt = startAttemptSpan({
        provider: "openai",
        model: "gpt-4o",
        selection: "primary",
        attemptNumber: 1,
        role: "worker",
        workspace: { key: "mixed-cat-workspace" }
      });
      endAttemptSpan(attempt, {
        status: "ok",
        responseModel: "gpt-4o"
      });
    });
    endLogicalRequestSpan(logical1, {
      status: "ok",
      provider: "openai"
    });

    // Second request: trigger is unfamiliar, phase is familiar.
    const logical2 = startLogicalRequestSpan({
      requestId: "mixed-cat-req-2",
      role: "worker",
      providerRole: "subagent",
      workspace: { key: "mixed-cat-workspace" },
      subject: "mixed category compaction",
      requestedModel: "gpt-4o",
      turnMetadataHeader: JSON.stringify({
        request_kind: "compaction",
        compaction: {
          trigger: "another_unfamiliar_trigger",
          phase: "pre_turn"
        },
        workspaces: { "/path/to/repo": {} }
      })
    });
    await withLogicalSpan(logical2, async () => {
      const attempt = startAttemptSpan({
        provider: "openai",
        model: "gpt-4o",
        selection: "primary",
        attemptNumber: 1,
        role: "worker",
        workspace: { key: "mixed-cat-workspace" }
      });
      endAttemptSpan(attempt, {
        status: "ok",
        responseModel: "gpt-4o"
      });
    });
    endLogicalRequestSpan(logical2, {
      status: "ok",
      provider: "openai"
    });

    await flushTelemetryMetrics();
    const points = findMetricPoints(METRIC_CONTEXT_COMPACTIONS).filter(
      (p) => p.attributes["autodev.workspace"] === "mixed-cat-workspace"
    );

    // The two requests differ in both trigger and (trigger vs reason)
    // dimensions, so they produce two distinct bounded series rather than
    // a single series that would lose the supported value.
    assert.equal(points.length, 2);
    const byTrigger = new Map<string, (typeof points)[number]>();
    for (const point of points) {
      byTrigger.set(
        String(point.attributes["autodev.compaction.trigger"]),
        point
      );
    }
    assert.ok(byTrigger.has("threshold"));
    assert.ok(byTrigger.has(COMPACTION_DIMENSION_OTHER));
    assert.equal(byTrigger.get("threshold")?.value, 1);
    assert.equal(
      byTrigger.get("threshold")?.attributes["autodev.compaction.reason"],
      COMPACTION_DIMENSION_OTHER
    );
    assert.equal(byTrigger.get(COMPACTION_DIMENSION_OTHER)?.value, 1);
    assert.equal(
      byTrigger.get(COMPACTION_DIMENSION_OTHER)?.attributes[
        "autodev.compaction.phase"
      ],
      "pre_turn"
    );
  }
);

test(
  "totally absent compaction dimensions do not produce the other bucket",
  { concurrency: false },
  async () => {
    installExporter();

    // request_kind is compaction but no compaction payload at all: no
    // trigger/reason/implementation/phase/strategy is reported. The
    // metric point must not be padded with placeholder dimensions; it
    // should simply omit them so the cardinality stays at its baseline.
    const logical = startLogicalRequestSpan({
      requestId: "no-dimensions-req",
      role: "worker",
      providerRole: "subagent",
      workspace: { key: "no-dimensions-workspace" },
      subject: "bare compaction",
      requestedModel: "gpt-4o",
      turnMetadataHeader: JSON.stringify({
        request_kind: "compaction",
        workspaces: { "/path/to/repo": {} }
      })
    });
    await withLogicalSpan(logical, async () => {
      const attempt = startAttemptSpan({
        provider: "openai",
        model: "gpt-4o",
        selection: "primary",
        attemptNumber: 1,
        role: "worker",
        workspace: { key: "no-dimensions-workspace" }
      });
      endAttemptSpan(attempt, {
        status: "ok",
        responseModel: "gpt-4o"
      });
    });
    endLogicalRequestSpan(logical, {
      status: "ok",
      provider: "openai"
    });

    await flushTelemetryMetrics();
    const points = findMetricPoints(METRIC_CONTEXT_COMPACTIONS).filter(
      (p) => p.attributes["autodev.workspace"] === "no-dimensions-workspace"
    );

    assert.equal(points.length, 1);
    assert.equal(points[0]?.value, 1);
    for (const dimension of [
      "autodev.compaction.trigger",
      "autodev.compaction.reason",
      "autodev.compaction.implementation",
      "autodev.compaction.phase",
      "autodev.compaction.strategy"
    ]) {
      assert.equal(
        Object.hasOwn(points[0]?.attributes ?? {}, dimension),
        false,
        `${dimension} must be omitted when not reported, not synthesized as "other"`
      );
    }
  }
);

test(
  "thread, session, and high-cardinality IDs in any compaction dimension collapse to the safe-bucket shape, never reaching the metric",
  { concurrency: false },
  async () => {
    installExporter();

    const hostileValues = [
      "session-12345",
      "thread_abc123",
      "turn.001",
      "window_id_99",
      "req-4567",
      "conv-789",
      "123e4567-e89b-12d3-a456-426614174000",
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      "/Users/project/path",
      "a".repeat(65),
      "",
      null,
      undefined,
      42
    ];

    for (const [index, hostileValue] of hostileValues.entries()) {
      const logical = startLogicalRequestSpan({
        requestId: `hostile-dim-${index}`,
        role: "worker",
        providerRole: "subagent",
        workspace: { key: "hostile-dim-workspace" },
        subject: `hostile dimension ${index}`,
        requestedModel: "gpt-4o",
        turnMetadataHeader: JSON.stringify({
          request_kind: "compaction",
          compaction: {
            trigger: hostileValue ?? "unknown",
            reason: hostileValue ?? "unknown",
            implementation: hostileValue ?? "unknown",
            phase: hostileValue ?? "unknown",
            strategy: hostileValue ?? "unknown"
          },
          workspaces: { "/path/to/repo": {} }
        })
      });
      await withLogicalSpan(logical, async () => {
        const attempt = startAttemptSpan({
          provider: "openai",
          model: "gpt-4o",
          selection: "primary",
          attemptNumber: 1,
          role: "worker",
          workspace: { key: "hostile-dim-workspace" }
        });
        endAttemptSpan(attempt, {
          status: "ok",
          responseModel: "gpt-4o"
        });
      });
      endLogicalRequestSpan(logical, {
        status: "ok",
        provider: "openai"
      });
    }

    await flushTelemetryMetrics();
    const points = findMetricPoints(METRIC_CONTEXT_COMPACTIONS).filter(
      (p) => p.attributes["autodev.workspace"] === "hostile-dim-workspace"
    );

    // No thread/session/ID/path leaked into metric dimensions; the only
    // thing present is the bounded provider/model/workspace/role and the
    // provider-role attribute. All compaction dimensions must be omitted
    // because every hostile value was rejected by sanitizeCategoricalLabel
    // and so compactCompactionDimension returned null.
    assert.equal(
      points.length,
      1,
      "every hostile dimension value must produce one bounded series"
    );
    assert.equal(points[0]?.value, hostileValues.length);
    for (const dimension of [
      "autodev.compaction.trigger",
      "autodev.compaction.reason",
      "autodev.compaction.implementation",
      "autodev.compaction.phase",
      "autodev.compaction.strategy"
    ]) {
      assert.equal(
        Object.hasOwn(points[0]?.attributes ?? {}, dimension),
        false,
        `${dimension} must not be present for unsafe input`
      );
    }
    // No thread/session/window IDs, conversation keys, or raw request
    // identifiers leak into metric attributes. The standard
    // `gen_ai.request.model` attribute name is a class identifier, not
    // a per-request ID, so it is excluded from this assertion.
    const forbiddenSubstrings = [
      "sessionid",
      "threadid",
      "requestid",
      "conversationid",
      "windowid",
      "userid",
      "session_id",
      "thread_id",
      "request_id",
      "conversation_id",
      "window_id",
      "user_id"
    ];
    for (const key of Object.keys(points[0]?.attributes ?? {})) {
      const normalized = key.toLowerCase();
      for (const forbidden of forbiddenSubstrings) {
        assert.equal(
          normalized.includes(forbidden),
          false,
          `metric attribute "${key}" must not be a high-cardinality identifier`
        );
      }
    }
  }
);

test("a git commit's change output is recorded once, with no identity in dimensions", async () => {
  installExporter();
  resetTrackedGitCommitsForTest();

  const commit = "a".repeat(40);
  const recorded = recordGitCommit({
    commit,
    filesChanged: 3,
    filesAdded: 1,
    filesDeleted: 1,
    linesAdded: 42,
    linesRemoved: 7,
    workspace: { key: "workspace-a" },
    role: "worker"
  });
  assert.equal(recorded, true, "a first observation must be recorded");

  // A second producer observing the same commit must not double-count it.
  assert.equal(
    recordGitCommit({
      commit,
      filesChanged: 3,
      filesAdded: 1,
      filesDeleted: 1,
      linesAdded: 42,
      linesRemoved: 7
    }),
    false,
    "an already-recorded commit must be refused"
  );

  await flushTelemetryMetrics();

  const value = (name: string): number => {
    const [point] = findMetricPoints(name);
    assert.ok(point, `${name} must be emitted`);
    return typeof point.value === "number" ? point.value : point.value.sum;
  };

  // Every requested signal is its own instrument.
  assert.equal(value(METRIC_GIT_COMMITS), 1);
  // Added and deleted are subsets of changed: three instruments, three
  // different numbers, and no total that adds them together.
  assert.equal(value(METRIC_GIT_FILES_CHANGED), 3);
  assert.equal(value(METRIC_GIT_FILES_ADDED), 1);
  assert.equal(value(METRIC_GIT_FILES_DELETED), 1);
  assert.equal(value(METRIC_GIT_LINES_ADDED), 42);
  assert.equal(value(METRIC_GIT_LINES_REMOVED), 7);

  const [point] = findMetricPoints(METRIC_GIT_COMMITS);
  assert.ok(point);
  // The existing `autodev.workspace` dimension, by its wire name.
  assert.equal(point.attributes["autodev.workspace"], "workspace-a");
  assert.equal(point.attributes[ATTR_AUTODEV_GIT_PARTIAL], undefined);

  // The commit id is used for idempotency and must never become a dimension.
  const serialized = JSON.stringify(point.attributes);
  assert.equal(serialized.includes(commit), false);
  for (const forbidden of ["commit", "sha", "path", "branch", "repository"]) {
    assert.equal(
      Object.keys(point.attributes).some((key) =>
        key.toLowerCase().includes(forbidden)
      ),
      false,
      `${forbidden} must not appear in metric dimensions`
    );
  }
});

test("a partially measurable commit is labelled rather than silently shrunk", async () => {
  installExporter();
  resetTrackedGitCommitsForTest();

  recordGitCommit({
    commit: "b".repeat(40),
    filesChanged: 2,
    filesAdded: 1,
    filesDeleted: 0,
    linesAdded: 0,
    linesRemoved: 0,
    partial: true,
    workspace: { key: "workspace-a" }
  });
  await flushTelemetryMetrics();

  // Cumulative temporality keeps one point per attribute set, so the partial
  // one is found by its attribute rather than assumed to be the first.
  const partialPoint = findMetricPoints(METRIC_GIT_COMMITS).find(
    (point) => point.attributes[ATTR_AUTODEV_GIT_PARTIAL] === "true"
  );
  assert.ok(
    partialPoint,
    "a commit with an unsummarizable diff must carry the partial label"
  );
});

test("an unmeasurable commit is refused rather than recorded as zero changes", async () => {
  installExporter();
  resetTrackedGitCommitsForTest();
  await flushTelemetryMetrics();
  const totalBefore = totalGitCommits();

  // Negative counts cannot come from git, so they are rejected instead of
  // being clamped into a plausible-looking zero.
  assert.equal(
    recordGitCommit({
      commit: "c".repeat(40),
      filesChanged: -1,
      filesAdded: 0,
      filesDeleted: 0,
      linesAdded: 0,
      linesRemoved: 0
    }),
    false
  );
  assert.equal(
    recordGitCommit({
      commit: "",
      filesChanged: 1,
      filesAdded: 1,
      filesDeleted: 0,
      linesAdded: 1,
      linesRemoved: 0
    }),
    false
  );

  // Re-measure the same way: the exporter keeps every collection snapshot, so
  // clearing it first means both readings cover exactly one snapshot rather
  // than summing an accumulating buffer.
  telemetryMetricExporter.reset();
  await flushTelemetryMetrics();
  // Nothing was emitted: the two refused calls left the running total exactly
  // where it was, rather than adding a zero-change commit.
  assert.equal(totalGitCommits(), totalBefore);
});

/** Cumulative temporality keeps one point per attribute set, so sum them. */
function totalGitCommits(): number {
  return findMetricPoints(METRIC_GIT_COMMITS).reduce(
    (sum, point) =>
      sum + (typeof point.value === "number" ? point.value : point.value.sum),
    0
  );
}
