import assert from "node:assert/strict";
import test from "node:test";

import { context, trace } from "@opentelemetry/api";
import { InMemorySpanExporter } from "@opentelemetry/sdk-trace-base";
import type { MemoryRecord } from "@simulatorlife/autodev-core";
import {
  type CurrentStateAssessment,
  latestUserTask
} from "@simulatorlife/autodev-runtime/memory";

import { RoutedMemoryReconstructor } from "@simulatorlife/autodev-runtime/router/memory-reconstruction";
import { ORCHESTRATOR_ALIAS } from "@simulatorlife/autodev-runtime/router/routing";
import {
  endLogicalRequestSpan,
  resetTelemetryExporter,
  routerTelemetryTracer,
  setTelemetryExporter,
  startLogicalRequestSpan,
  withExtractedTraceContext
} from "@simulatorlife/autodev-runtime/router/telemetry";

const savedOtelEnv = {
  endpoint: process.env.OTEL_EXPORTER_OTLP_ENDPOINT,
  traceEndpoint: process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT
};
delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
delete process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT;
const memoryTraceExporter = new InMemorySpanExporter();
setTelemetryExporter(memoryTraceExporter);
test.after(() => {
  resetTelemetryExporter();
  if (savedOtelEnv.endpoint === undefined)
    delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  else process.env.OTEL_EXPORTER_OTLP_ENDPOINT = savedOtelEnv.endpoint;
  if (savedOtelEnv.traceEndpoint === undefined)
    delete process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT;
  else
    process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT = savedOtelEnv.traceEndpoint;
});

const evidence = {
  kind: "file" as const,
  uri: "file:///workspace/repo/src/router/memory.ts"
};
const memory: MemoryRecord = {
  id: "memory-procedure",
  kind: "procedural",
  scope: {
    kind: "repository",
    workspaceId: "workspace-a",
    repositoryId: "owner/repo"
  },
  claim: "Use the typed Control API adapter.",
  status: "active",
  provenance: {
    experienceIds: ["experience-a"],
    evidence: [evidence],
    createdBy: "curator",
    createdAt: "2026-10-01T00:00:00.000Z"
  },
  validity: {
    state: "verified",
    evidence: [evidence]
  },
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-01T00:00:00.000Z"
};
const assessment: CurrentStateAssessment = {
  compatibility: "compatible",
  source: "git_commit_and_file_identity",
  checkedAt: "2026-10-01T00:00:00.000Z",
  reasonCode: "verified_current_state",
  evidence: [evidence]
};

test("router-backed reconstructor reuses the configured orchestrator model and sends no user steer", async () => {
  const observed: { captured: { url: string; init: RequestInit } | null } = {
    captured: null
  };
  const adapter = new RoutedMemoryReconstructor({
    endpoint: "http://127.0.0.1:4100/v1/responses",
    authToken: "router-token",
    fetchImpl: async (url, init) => {
      observed.captured = { url: String(url), init: init ?? {} };
      return Response.json(
        {
          output_text: JSON.stringify({
            disposition: "revise",
            guidance: "Use the API's operator-only lifecycle endpoint.",
            rationale:
              "The current task uses the matching Control API boundary."
          })
        },
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }
  });

  const reconstructionSpan =
    routerTelemetryTracer().startSpan("memory.reconstruct");
  const reconstructionSpanContext = reconstructionSpan.spanContext();
  let result;
  try {
    result = await context.with(
      trace.setSpan(context.active(), reconstructionSpan),
      () =>
        adapter.reconstruct({
          memory,
          task: "Add a governed memory API action.",
          assessment
        })
    );
  } finally {
    reconstructionSpan.end();
  }
  assert.equal(result.disposition, "revise");
  assert.equal(
    result.guidance,
    "Use the API's operator-only lifecycle endpoint."
  );
  const captured = observed.captured;
  assert.ok(captured);
  assert.equal(captured.url, "http://127.0.0.1:4100/v1/responses");
  const headers = new Headers(captured.init.headers);
  assert.equal(headers.get("authorization"), "Bearer router-token");
  assert.match(
    headers.get("traceparent") ?? "",
    new RegExp(
      `^00-${reconstructionSpanContext.traceId}-${reconstructionSpanContext.spanId}-[0-9a-f]{2}$`,
      "u"
    )
  );
  const body = JSON.parse(String(captured.init.body)) as {
    model: string;
    stream: boolean;
    tools: unknown[];
    input: Array<{ role: string }>;
  };
  assert.equal(body.model, ORCHESTRATOR_ALIAS);
  assert.equal(body.stream, false);
  assert.deepEqual(body.tools, []);
  assert.equal(body.input[0]?.role, "developer");
  assert.equal(latestUserTask(body.input), null);
});

test("router-backed reconstruction fails closed on provider, schema, and response-size errors", async () => {
  const unavailable = new RoutedMemoryReconstructor({
    endpoint: "http://localhost:4100/v1/responses",
    fetchImpl: async () => new Response("unavailable", { status: 503 })
  });
  const failed = await unavailable.reconstruct({
    memory,
    task: "task",
    assessment
  });
  assert.equal(failed.disposition, "uncertain");

  const malformed = new RoutedMemoryReconstructor({
    fetchImpl: async () =>
      Response.json(
        { output_text: "not-json" },
        {
          status: 200
        }
      )
  });
  assert.equal(
    (await malformed.reconstruct({ memory, task: "task", assessment }))
      .disposition,
    "uncertain"
  );

  const oversized = new RoutedMemoryReconstructor({
    fetchImpl: async () => new Response("x".repeat(70_000), { status: 200 })
  });
  assert.equal(
    (await oversized.reconstruct({ memory, task: "task", assessment }))
      .disposition,
    "uncertain"
  );
});

test("router-backed reconstruction refuses remote or credential-bearing endpoints", () => {
  assert.throws(
    () =>
      new RoutedMemoryReconstructor({
        endpoint: "https://provider.example/v1/responses"
      }),
    TypeError
  );
  assert.throws(
    () =>
      new RoutedMemoryReconstructor({
        endpoint: "http://user:pass@127.0.0.1/v1/responses"
      }),
    TypeError
  );
});

test("router extracts W3C parent context for the nested routed reconstruction request", () => {
  const traceId = "4bf92f3577b34da6a3ce929d0e0e4736";
  const parentSpanId = "00f067aa0ba902b7";
  let routedSpan: ReturnType<typeof startLogicalRequestSpan> | undefined;
  withExtractedTraceContext(
    { traceparent: `00-${traceId}-${parentSpanId}-01` },
    () => {
      routedSpan = startLogicalRequestSpan({
        requestId: "private-request",
        role: "orchestrator",
        providerRole: "orchestrator",
        workspace: null,
        subject: "memory reconstruction",
        requestedModel: ORCHESTRATOR_ALIAS
      });
    }
  );
  assert.ok(routedSpan);
  endLogicalRequestSpan(routedSpan, { status: "ok" });
  const exported = memoryTraceExporter
    .getFinishedSpans()
    .find(
      (span) => span.spanContext().spanId === routedSpan?.spanContext().spanId
    );
  assert.equal(exported?.parentSpanContext?.traceId, traceId);
  assert.equal(exported?.parentSpanContext?.spanId, parentSpanId);
});
