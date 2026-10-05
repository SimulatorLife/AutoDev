import assert from "node:assert/strict";
import test from "node:test";

import type { UsageFilterSelection } from "@simulatorlife/autodev-core";

import { OpenLITUsageClient } from "../../src/usage/openlit-usage-client.ts";

const selection: UsageFilterSelection = {
  range: "7D",
  values: { provider: ["openai"] }
};

function response(body: unknown, status = 200): Response {
  return Response.json(body, {
    status,
    headers: { "Content-Type": "application/json" }
  });
}

const partialPayload = {
  schema: "autodev-openlit-usage-v1",
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
    }
  ],
  filterOptions: {
    workspace: { supported: true, values: ["repo-a"] },
    provider: { supported: true, values: ["openai"] },
    model: { supported: false, values: [] },
    agent: { supported: true, values: [] }
  }
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
  assert.deepEqual(result.data.metrics.requestsByRole, []);
  assert.deepEqual(result.data.filterOptions.workspace, ["repo-a"]);
  assert.equal(result.data.filterOptions.model, null);
  assert.deepEqual(result.data.filterOptions.agent, []);
  assert.equal(result.data.filterOptions.skill, null);
});

test("OpenLITUsageClient keeps authentication and transport failures explicit", async () => {
  const unauthorized = new OpenLITUsageClient({
    baseUrl: "http://openlit.local",
    serviceToken: "secret",
    fetchImpl: async () => response({}, 401)
  });
  assert.deepEqual(await unauthorized.query(selection), {
    kind: "unauthorized",
    status: 401
  });

  const unavailable = new OpenLITUsageClient({
    baseUrl: "http://openlit.local",
    serviceToken: "secret",
    fetchImpl: async () => response({ schema: "wrong" })
  });
  assert.deepEqual(await unavailable.query(selection), { kind: "unreachable" });
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
    kind: "unreachable"
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
