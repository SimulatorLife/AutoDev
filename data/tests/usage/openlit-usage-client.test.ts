import assert from "node:assert/strict";
import test from "node:test";

import type { UsageFilterSelection } from "@simulatorlife/autodev-core";

import { OpenLITUsageClient } from "../../src/usage/openlit-usage-client.ts";

const selection: UsageFilterSelection = {
  range: "7D",
  values: { provider: ["openai"], skill: ["agent-skill"] }
};

function response(body: unknown, status = 200): Response {
  return Response.json(body, {
    status,
    headers: { "Content-Type": "application/json" }
  });
}

const partialPayload = {
  schema: "autodev-openlit-usage-v3",
  widgets: [
    {
      key: "logical-requests",
      observed: true,
      rows: [{ requests: "12" }],
      valuePath: "0.requests"
    },
    {
      key: "cache-rate",
      observed: true,
      rows: [{ cached: "3", input: "4" }],
      ratio: { numerator: "0.cached", denominator: "0.input", multiplier: 100 }
    },
    {
      key: "requests-by-agent",
      observed: true,
      rows: [],
      xAxis: "role",
      yAxis: "requests"
    },
    {
      key: "input-tokens",
      observed: false,
      rows: [],
      valuePath: "0.input_tokens"
    },
    {
      key: "p95-latency",
      observed: true,
      rows: [{ p95_seconds: "1.425" }],
      valuePath: "0.p95_seconds"
    },
    {
      key: "mcp-duration",
      observed: true,
      rows: [{ p95_seconds: "0.042" }],
      valuePath: "0.p95_seconds"
    },
    {
      key: "attempt-errors-by-provider",
      observed: true,
      rows: [{ provider: "openai", failures: "2" }],
      xAxis: "provider",
      yAxis: "failures"
    },
    {
      key: "context-compactions",
      observed: true,
      rows: [{ compactions: "3" }],
      valuePath: "0.compactions"
    },
    {
      key: "skill-events-by-event",
      observed: true,
      rows: [{ event: "used", events: "4" }],
      xAxis: "event",
      yAxis: "events"
    },
    {
      key: "estimated-cost",
      observed: true,
      rows: [{ estimated_cost: "0.0081", costed_attempts: "2" }],
      valuePath: "0.estimated_cost"
    }
  ],
  filterOptions: {
    workspace: { supported: true, values: ["repo-a"] },
    provider: { supported: true, values: ["openai"] },
    model: { supported: false, values: [] },
    agent: { supported: true, values: [] },
    skill: { supported: true, values: ["agent-skill"] }
  },
  traceList: { kind: "not-applicable", reason: "skill-filter" }
};

test("OpenLITUsageClient sends typed URL filter state with server credentials", async () => {
  let requestedUrl = "";
  let requestedInit: RequestInit | undefined;
  const client = new OpenLITUsageClient({
    baseUrl: "http://openlit.local/",
    serviceToken: "secret",
    fetchImpl: async (input, init) => {
      requestedUrl = String(input);
      requestedInit = init;
      return response(partialPayload);
    }
  });

  const result = await client.query(selection);
  assert.equal(result.kind, "ok");
  assert.equal(requestedUrl, "http://openlit.local/api/autodev/usage");
  assert.equal(requestedInit?.method, "POST");
  assert.equal(
    (requestedInit?.headers as Record<string, string>).Authorization,
    "Bearer secret"
  );
  assert.deepEqual(JSON.parse(String(requestedInit?.body)), { selection });
  if (result.kind !== "ok") return;
  assert.equal(result.data.metrics.logicalRequests, 12);
  assert.equal(result.data.metrics.cacheReadRate, 75);
  assert.equal(result.data.metrics.totalInputTokens, null);
  assert.equal(result.data.metrics.p95LatencyMs, 1425);
  assert.equal(result.data.metrics.p95McpDurationMs, 42);
  assert.equal(result.data.metrics.failedAttempts, 2);
  assert.deepEqual(result.data.metrics.attemptErrorsByProvider, [
    { provider: "openai", count: 2 }
  ]);
  assert.equal(result.data.metrics.contextCompactions, 3);
  assert.deepEqual(result.data.metrics.skillEventsByEvent, [
    { event: "used", count: 4 }
  ]);
  assert.equal(result.data.metrics.estimatedCostUsd, 0.0081);
  assert.deepEqual(result.data.metrics.requestsByRole, []);
  assert.deepEqual(result.data.filterOptions.workspace, ["repo-a"]);
  assert.equal(result.data.filterOptions.model, null);
  assert.deepEqual(result.data.filterOptions.agent, []);
  assert.deepEqual(result.data.filterOptions.skill, ["agent-skill"]);
  assert.deepEqual(result.data.traceList, {
    kind: "not-applicable",
    reason: "skill-filter"
  });
});

test("OpenLITUsageClient keeps the recent trace list bounded and privacy-filtered", async () => {
  const payload = {
    ...partialPayload,
    traceList: {
      kind: "observed",
      partial: true,
      attempts: [
        {
          spanId: "0123456789abcdef",
          timestamp: "2026-10-07T12:00:00.000Z",
          durationNs: 1_250_000,
          statusCode: "ERROR",
          provider: "openai",
          model: "gpt-6-luna",
          role: "orchestrator",
          spanAttributes: { prompt: "must not reach the Usage page" }
        }
      ]
    }
  };
  const client = new OpenLITUsageClient({
    baseUrl: "http://openlit.local",
    serviceToken: "secret",
    fetchImpl: async () => response(payload)
  });

  const result = await client.query({ range: "24H", values: {} });
  assert.equal(result.kind, "ok");
  if (result.kind !== "ok") return;
  assert.deepEqual(result.data.traceList, {
    kind: "observed",
    partial: true,
    attempts: [
      {
        spanId: "0123456789abcdef",
        timestamp: "2026-10-07T12:00:00.000Z",
        durationNs: 1_250_000,
        statusCode: "ERROR",
        provider: "openai",
        model: "gpt-6-luna",
        role: "orchestrator"
      }
    ]
  });
  assert.equal(
    JSON.stringify(result.data.traceList).includes("must not reach"),
    false
  );
});

test("OpenLITUsageClient keeps authentication and HTTP failures explicit", async () => {
  const unauthorized = new OpenLITUsageClient({
    baseUrl: "http://openlit.local",
    serviceToken: "secret",
    fetchImpl: async () => response({}, 401)
  });
  assert.deepEqual(await unauthorized.query(selection), {
    kind: "unauthorized",
    status: 401
  });

  const unreachable = new OpenLITUsageClient({
    baseUrl: "http://openlit.local",
    serviceToken: "secret",
    fetchImpl: async () => {
      throw new TypeError("connection refused");
    }
  });
  assert.deepEqual(await unreachable.query(selection), { kind: "unreachable" });

  const invalidSchema = new OpenLITUsageClient({
    baseUrl: "http://openlit.local",
    serviceToken: "secret",
    fetchImpl: async () => response({ schema: "wrong" })
  });
  assert.deepEqual(await invalidSchema.query(selection), {
    kind: "invalid-response"
  });

  const previousSchema = new OpenLITUsageClient({
    baseUrl: "http://openlit.local",
    serviceToken: "secret",
    fetchImpl: async () =>
      response({ ...partialPayload, schema: "autodev-openlit-usage-v1" })
  });
  assert.deepEqual(await previousSchema.query(selection), {
    kind: "invalid-response"
  });

  const invalidJson = new OpenLITUsageClient({
    baseUrl: "http://openlit.local",
    serviceToken: "secret",
    fetchImpl: async () => new Response("upstream html")
  });
  assert.deepEqual(await invalidJson.query(selection), {
    kind: "invalid-response"
  });
});

test("OpenLITUsageClient rejects duplicate widgets and keeps invalid ratios unavailable", async () => {
  const duplicate = structuredClone(partialPayload);
  duplicate.widgets.push(duplicate.widgets[0]!);
  const duplicateClient = new OpenLITUsageClient({
    baseUrl: "http://openlit.local",
    serviceToken: "secret",
    fetchImpl: async () => response(duplicate)
  });
  assert.deepEqual(await duplicateClient.query(selection), {
    kind: "invalid-response"
  });

  const invalidRatio = structuredClone(partialPayload);
  invalidRatio.widgets[1]!.rows = [{ cached: "3", input: "0" }];
  const ratioClient = new OpenLITUsageClient({
    baseUrl: "http://openlit.local",
    serviceToken: "secret",
    fetchImpl: async () => response(invalidRatio)
  });
  const ratioResult = await ratioClient.query(selection);
  assert.equal(ratioResult.kind, "ok");
  if (ratioResult.kind === "ok") {
    assert.equal(ratioResult.data.metrics.cacheReadRate, null);
  }
});

test("OpenLITUsageClient rejects malformed metric rows without fabricating values", async () => {
  const malformed = structuredClone(partialPayload);
  malformed.widgets[0]!.rows = [{ requests: "NaN" }];
  const client = new OpenLITUsageClient({
    baseUrl: "http://openlit.local",
    serviceToken: "secret",
    fetchImpl: async () => response(malformed)
  });
  const result = await client.query(selection);
  assert.equal(result.kind, "ok");
  if (result.kind !== "ok") return;
  assert.equal(result.data.metrics.logicalRequests, null);
  assert.equal(result.data.metrics.physicalAttempts, null);
});

test("OpenLITUsageClient distinguishes an unpriced empty cost sum from observed zero cost", async () => {
  const emptyCost = structuredClone(partialPayload);
  const emptyWidget = emptyCost.widgets.find(
    (widget) => widget.key === "estimated-cost"
  );
  assert.ok(emptyWidget);
  emptyWidget.observed = false;
  emptyWidget.rows = [{ estimated_cost: "0", costed_attempts: "0" }];

  const emptyClient = new OpenLITUsageClient({
    baseUrl: "http://openlit.local",
    serviceToken: "secret",
    fetchImpl: async () => response(emptyCost)
  });
  const emptyResult = await emptyClient.query(selection);
  assert.equal(emptyResult.kind, "ok");
  if (emptyResult.kind === "ok") {
    assert.equal(emptyResult.data.metrics.estimatedCostUsd, null);
  }

  const freeCost = structuredClone(emptyCost);
  const freeWidget = freeCost.widgets.find(
    (widget) => widget.key === "estimated-cost"
  );
  assert.ok(freeWidget);
  freeWidget.observed = true;
  freeWidget.rows = [{ estimated_cost: "0", costed_attempts: "2" }];
  const freeClient = new OpenLITUsageClient({
    baseUrl: "http://openlit.local",
    serviceToken: "secret",
    fetchImpl: async () => response(freeCost)
  });
  const freeResult = await freeClient.query(selection);
  assert.equal(freeResult.kind, "ok");
  if (freeResult.kind === "ok") {
    assert.equal(freeResult.data.metrics.estimatedCostUsd, 0);
  }
});

test("OpenLITUsageClient fetches a bounded, typed trace summary with server credentials", async () => {
  const selectedSpanId = "0123456789abcdef";
  const traceId = "0123456789abcdef0123456789abcdef";
  let requestedUrl = "";
  let requestedInit: RequestInit | undefined;
  const client = new OpenLITUsageClient({
    baseUrl: "http://openlit.local/",
    serviceToken: "secret",
    fetchImpl: async (input, init) => {
      requestedUrl = String(input);
      requestedInit = init;
      return response({
        schema: "autodev-openlit-trace-detail-v1",
        traceId,
        selectedSpanId,
        spans: [
          {
            spanId: selectedSpanId,
            parentSpanId: null,
            spanName: "gen_ai.client_operation",
            serviceName: "autodev-router",
            timestamp: "2026-10-05T12:00:00.000Z",
            durationNs: 1_250_000,
            statusCode: "OK",
            spanAttributes: { prompt: "must not reach the Console view" }
          }
        ],
        partial: false
      });
    }
  });

  const result = await client.queryTrace(selectedSpanId);
  assert.equal(
    requestedUrl,
    `http://openlit.local/api/autodev/usage/span/${selectedSpanId}`
  );
  assert.equal(requestedInit?.method, "GET");
  assert.equal(
    (requestedInit?.headers as Record<string, string>).Authorization,
    "Bearer secret"
  );
  assert.equal(requestedInit?.body, undefined);
  assert.equal(result.kind, "ok");
  if (result.kind === "ok") {
    assert.deepEqual(result.data, {
      schema: "autodev-openlit-trace-detail-v1",
      traceId,
      selectedSpanId,
      spans: [
        {
          spanId: selectedSpanId,
          parentSpanId: null,
          spanName: "gen_ai.client_operation",
          serviceName: "autodev-router",
          timestamp: "2026-10-05T12:00:00.000Z",
          durationNs: 1_250_000,
          statusCode: "OK"
        }
      ],
      partial: false
    });
    assert.equal(JSON.stringify(result.data).includes("must not reach"), false);
  }
});

test("OpenLITUsageClient rejects invalid trace IDs before fetch and preserves not-found", async () => {
  let fetchCount = 0;
  const client = new OpenLITUsageClient({
    baseUrl: "http://openlit.local",
    serviceToken: "secret",
    fetchImpl: async () => {
      fetchCount += 1;
      return response(
        { error: { code: "autodev_usage_trace_not_found" } },
        404
      );
    }
  });

  assert.deepEqual(await client.queryTrace("span-id with query?x=1"), {
    kind: "invalid-span-id"
  });
  assert.equal(fetchCount, 0);
  assert.deepEqual(await client.queryTrace("0123456789abcdef"), {
    kind: "not-found"
  });
  assert.equal(fetchCount, 1);

  const genericNotFound = new OpenLITUsageClient({
    baseUrl: "http://openlit.local",
    serviceToken: "secret",
    fetchImpl: async () => response({ error: "route not found" }, 404)
  });
  assert.deepEqual(await genericNotFound.queryTrace("0123456789abcdef"), {
    kind: "http-error",
    status: 404
  });
});

test("OpenLITUsageClient treats malformed or over-limit trace detail as unavailable", async () => {
  const invalidDetails: unknown[] = [
    {
      schema: "wrong",
      traceId: "0123456789abcdef0123456789abcdef",
      selectedSpanId: "0123456789abcdef",
      spans: [],
      partial: false
    },
    {
      schema: "autodev-openlit-trace-detail-v1",
      traceId: "0123456789abcdef0123456789abcdef",
      selectedSpanId: "ffffffffffffffff",
      spans: [
        {
          spanId: "0123456789abcdef",
          parentSpanId: null,
          spanName: "span",
          serviceName: "svc",
          timestamp: "2026-10-05T12:00:00.000Z",
          durationNs: 1,
          statusCode: "OK"
        }
      ],
      partial: false
    }
  ];
  const overLimit = {
    schema: "autodev-openlit-trace-detail-v1",
    traceId: "0123456789abcdef0123456789abcdef",
    selectedSpanId: "0123456789abcdef",
    spans: Array.from({ length: 201 }, (_, index) => ({
      spanId: index.toString(16).padStart(16, "0"),
      parentSpanId: null,
      spanName: "span",
      serviceName: "svc",
      timestamp: "2026-10-05T12:00:00.000Z",
      durationNs: 1,
      statusCode: "OK"
    })),
    partial: true
  };
  const client = new OpenLITUsageClient({
    baseUrl: "http://openlit.local",
    serviceToken: "secret",
    fetchImpl: async () => response(invalidDetails.shift() ?? overLimit)
  });

  assert.deepEqual(await client.queryTrace("0123456789abcdef"), {
    kind: "unreachable"
  });
  assert.deepEqual(await client.queryTrace("0123456789abcdef"), {
    kind: "unreachable"
  });
  assert.deepEqual(await client.queryTrace("0123456789abcdef"), {
    kind: "unreachable"
  });
});
