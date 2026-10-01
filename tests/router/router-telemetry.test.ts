import "../../src/router/http.ts";

import assert from "node:assert/strict";
import test from "node:test";

import {
  AggregationTemporality,
  InMemoryMetricExporter
} from "@opentelemetry/sdk-metrics";
import { InMemorySpanExporter } from "@opentelemetry/sdk-trace-base";

import { COOLDOWNS } from "@simulatorlife/autodev-runtime/router/cooldown";
import {
  recordBridgeSkillExposure,
  recordBridgeSkillUsed
} from "../../src/router/otel.ts";
import {
  EXHAUSTION_WAIT_MS,
  fetchUpstream,
  proxyConcreteResponse,
  proxyFallbackChain,
  writeResponseStream
} from "../../src/router/proxy.ts";
import type { ProviderRoute } from "../../src/router/routing.ts";
import {
  endAttemptSpan,
  endLogicalRequestSpan,
  flushTelemetryMetrics,
  getFinishedSpans,
  resetTelemetryExporter,
  resolveOtlpSignalEndpoint,
  setTelemetryExporter,
  setTelemetryMetricExporterForTest,
  startAttemptSpan,
  startLogicalRequestSpan,
  withLogicalSpan
} from "../../src/router/telemetry.ts";

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

const route = (provider: string, envKey: string): ProviderRoute => ({
  provider,
  pattern: /.*/,
  baseUrl: `http://${provider}.test/v1`,
  envKey
});

interface SpanRecord {
  name: string;
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
      await import("../../src/router/telemetry.ts");
    const tracer = ensureOtelInitialized();
    assert.ok(tracer, "tracer must be returned even without an endpoint");
    assert.equal(isOtlpExporterInstalled(), false);
  } finally {
    if (previousEndpoint !== undefined)
      process.env.OTEL_EXPORTER_OTLP_ENDPOINT = previousEndpoint;
  }
});
