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
