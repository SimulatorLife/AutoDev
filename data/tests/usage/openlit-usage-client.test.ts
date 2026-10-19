import assert from "node:assert/strict";
import test from "node:test";

import type { UsageFilterSelection } from "@simulatorlife/autodev-core";

import { OpenLITUsageClient } from "../../src/usage/openlit-usage-client.ts";

const selection: UsageFilterSelection = {
  range: "7D",
  values: { provider: ["openai"], skill: ["agent-skill"] }
};
const supportedSelection: UsageFilterSelection = {
  range: "7D",
  values: {
    workspace: ["repo-a"]
  }
};

function response(body: unknown, status = 200): Response {
  return Response.json(body, {
    status,
    headers: { "Content-Type": "application/json" }
  });
}

type UsageWidgetFixture = {
  key: string;
  querySucceeded: boolean;
  observed: boolean;
  partial: boolean;
  rows: unknown[];
  [key: string]: unknown;
};

function makeWidget(
  key: string,
  overrides: Record<string, unknown> = {}
): UsageWidgetFixture {
  return {
    key,
    querySucceeded: true,
    observed: false,
    partial: false,
    rows: [],
    ...overrides
  };
}

const partialPayload = {
  schema: "autodev-openlit-usage-v5",
  widgets: [
    makeWidget("logical-requests", {
      observed: true,
      rows: [{ requests: "12" }],
      valuePath: "0.requests"
    }),
    makeWidget("requests-by-agent", {
      observed: true,
      rows: [],
      xAxis: "role",
      yAxis: "requests"
    }),
    makeWidget("input-tokens", { valuePath: "0.input_tokens" }),
    makeWidget("output-tokens", {
      observed: true,
      rows: [{ output_tokens: "200" }],
      valuePath: "0.output_tokens"
    }),
    makeWidget("cache-rate", {
      observed: true,
      rows: [{ cached: "3", input: "4" }],
      ratio: { numerator: "0.cached", denominator: "0.input", multiplier: 100 }
    }),
    makeWidget("p95-latency", {
      observed: true,
      rows: [{ p95_seconds: "1.425" }],
      valuePath: "0.p95_seconds"
    }),
    makeWidget("attempts-by-provider", {
      observed: true,
      rows: [{ provider: "openai", attempts: "5" }],
      xAxis: "provider",
      yAxis: "attempts"
    }),
    makeWidget("mcp-calls"),
    makeWidget("mcp-duration", {
      observed: true,
      rows: [{ p95_seconds: "0.042" }],
      valuePath: "0.p95_seconds"
    }),
    makeWidget("mcp-errors"),
    makeWidget("mcp-by-tool", {
      observed: true,
      rows: [],
      xAxis: "tool",
      yAxis: "calls"
    }),
    makeWidget("attempt-errors-by-provider", {
      observed: true,
      rows: [{ provider: "openai", failures: "2" }],
      xAxis: "provider",
      yAxis: "failures"
    }),
    makeWidget("context-compactions", {
      observed: true,
      rows: [{ compactions: "3" }],
      valuePath: "0.compactions"
    }),
    makeWidget("context-compactions-over-time", {
      observed: true,
      rows: [
        { label: "10/06 00:00", count: "1" },
        { label: "10/07 00:00", count: "2" }
      ],
      xAxis: "label",
      yAxis: "count"
    }),
    makeWidget("context-compactions-by-workspace", {
      observed: true,
      rows: [{ g0: "repo-a", compactions: "3" }],
      xAxis: "g0",
      yAxis: "compactions"
    }),
    makeWidget("context-compactions-by-model", {
      observed: true,
      partial: true,
      rows: [{ g0: "gpt-6-luna", compactions: "3" }],
      xAxis: "g0",
      yAxis: "compactions"
    }),
    makeWidget("context-compactions-by-agent", {
      observed: true,
      rows: [{ g0: "orchestrator", compactions: "3" }],
      xAxis: "g0",
      yAxis: "compactions"
    }),
    makeWidget("git-commits", {
      observed: true,
      rows: [{ commits: "2" }],
      valuePath: "0.commits"
    }),
    makeWidget("git-files-changed", {
      observed: true,
      rows: [{ files_changed: "4" }],
      valuePath: "0.files_changed"
    }),
    makeWidget("git-files-added", {
      observed: true,
      rows: [{ files_added: "2" }],
      valuePath: "0.files_added"
    }),
    makeWidget("git-files-deleted", {
      observed: true,
      rows: [{ files_deleted: "1" }],
      valuePath: "0.files_deleted"
    }),
    makeWidget("git-lines-added", {
      observed: true,
      rows: [{ lines_added: "20" }],
      valuePath: "0.lines_added"
    }),
    makeWidget("git-lines-removed", {
      observed: true,
      rows: [{ lines_removed: "5" }],
      valuePath: "0.lines_removed"
    }),
    makeWidget("git-partial-commits", {
      observed: true,
      rows: [{ partial_commits: "1" }],
      valuePath: "0.partial_commits"
    }),
    makeWidget("git-commits-by-workspace", {
      observed: true,
      rows: [{ g0: "repo-a", commits: "2" }],
      xAxis: "g0",
      yAxis: "commits"
    }),
    makeWidget("git-commits-by-provider", {
      observed: true,
      rows: [{ g0: "codex", commits: "2" }],
      xAxis: "g0",
      yAxis: "commits"
    }),
    makeWidget("git-commits-by-agent", {
      observed: true,
      rows: [{ g0: "worker", commits: "2" }],
      xAxis: "g0",
      yAxis: "commits"
    }),
    makeWidget("skill-events-by-event", {
      observed: true,
      rows: [{ event: "used", events: "4" }],
      xAxis: "event",
      yAxis: "events"
    }),
    makeWidget("estimated-cost", {
      observed: true,
      rows: [{ estimated_cost: "0.0081", costed_attempts: "2" }],
      valuePath: "0.estimated_cost"
    })
  ],
  filterOptions: {
    workspace: { supported: true, values: ["repo-a"] },
    provider: { supported: true, values: ["openai"] },
    model: { supported: false, values: [] },
    agent: { supported: true, values: [] },
    skill: { supported: true, values: ["agent-skill"] }
  },
  traceList: { kind: "unavailable" }
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

  const result = await client.query(supportedSelection);
  assert.equal(result.kind, "ok");
  assert.equal(requestedUrl, "http://openlit.local/api/autodev/usage");
  assert.equal(requestedInit?.method, "POST");
  assert.equal(
    (requestedInit?.headers as Record<string, string>).Authorization,
    "Bearer secret"
  );
  assert.deepEqual(JSON.parse(String(requestedInit?.body)), {
    selection: supportedSelection
  });
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
  assert.equal(result.data.metrics.contextCompactionRatePercent, 25);
  assert.equal(result.data.metrics.contextCompactionsBreakdownsPartial, true);
  assert.deepEqual(result.data.metrics.contextCompactionsOverTime, [
    { bucket: "10/06 00:00", count: 1 },
    { bucket: "10/07 00:00", count: 2 }
  ]);
  assert.deepEqual(result.data.metrics.contextCompactionsByWorkspace, [
    { name: "repo-a", count: 3 }
  ]);
  assert.deepEqual(result.data.metrics.contextCompactionsByModel, [
    { name: "gpt-6-luna", count: 3 }
  ]);
  assert.deepEqual(result.data.metrics.contextCompactionsByAgent, [
    { name: "orchestrator", count: 3 }
  ]);
  assert.deepEqual(
    result.data.metrics.contextCompactionsUnsupportedFilters,
    []
  );
  assert.equal(result.data.metrics.contextCompactionsBreakdownsPartial, true);
  assert.deepEqual(result.data.metrics.skillEventsByEvent, [
    { event: "used", count: 4 }
  ]);
  assert.equal(result.data.metrics.estimatedCostUsd, 0.0081);
  assert.deepEqual(result.data.metrics.gitChanges, {
    status: "observed",
    notApplicableReason: null,
    unsupportedFilters: [],
    partial: true,
    breakdownsPartial: false,
    commits: 2,
    filesChanged: 4,
    filesAdded: 2,
    filesDeleted: 1,
    linesAdded: 20,
    linesRemoved: 5,
    partialCommits: 1,
    commitsByWorkspace: [{ name: "repo-a", count: 2 }],
    commitsByProvider: [{ name: "codex", count: 2 }],
    commitsByAgent: [{ name: "worker", count: 2 }]
  });
  assert.deepEqual(result.data.metrics.requestsByRole, []);
  assert.deepEqual(result.data.filterOptions.workspace, ["repo-a"]);
  assert.equal(result.data.filterOptions.model, null);
  assert.deepEqual(result.data.filterOptions.agent, []);
  assert.deepEqual(result.data.filterOptions.skill, ["agent-skill"]);
  assert.deepEqual(result.data.traceList, { kind: "unavailable" });
});

test("OpenLITUsageClient does not claim compaction metrics for provider or skill filters", async () => {
  const client = new OpenLITUsageClient({
    baseUrl: "http://openlit.local",
    serviceToken: "secret",
    fetchImpl: async () => response(partialPayload)
  });
  const result = await client.query(selection);
  assert.equal(result.kind, "ok");
  if (result.kind !== "ok") return;
  assert.equal(result.data.metrics.logicalRequests, 12);
  assert.equal(result.data.metrics.contextCompactions, null);
  assert.equal(result.data.metrics.contextCompactionRatePercent, null);
  assert.equal(result.data.metrics.contextCompactionsOverTime, null);
  assert.equal(result.data.metrics.contextCompactionsByWorkspace, null);
  assert.equal(result.data.metrics.contextCompactionsByModel, null);
  assert.equal(result.data.metrics.contextCompactionsByAgent, null);
  assert.deepEqual(result.data.metrics.contextCompactionsUnsupportedFilters, [
    "provider",
    "skill"
  ]);
  assert.deepEqual(result.data.metrics.gitChanges, {
    status: "not-applicable",
    notApplicableReason: "unsupported-filter",
    unsupportedFilters: ["skill"],
    partial: null,
    breakdownsPartial: false,
    commits: null,
    filesChanged: null,
    filesAdded: null,
    filesDeleted: null,
    linesAdded: null,
    linesRemoved: null,
    partialCommits: null,
    commitsByWorkspace: null,
    commitsByProvider: null,
    commitsByAgent: null
  });
});

test("Git Usage distinguishes a source-confirmed zero from no observed metric", async () => {
  const noObservation = structuredClone(partialPayload);
  const commits = noObservation.widgets.find(
    (widget) => widget.key === "git-commits"
  );
  assert.ok(commits);
  commits.observed = false;
  commits.rows = [];
  for (const id of [
    "git-commits-by-workspace",
    "git-commits-by-provider",
    "git-commits-by-agent"
  ]) {
    const breakdown = noObservation.widgets.find((widget) => widget.key === id);
    assert.ok(breakdown);
    breakdown.observed = false;
    breakdown.rows = [];
  }

  const client = new OpenLITUsageClient({
    baseUrl: "http://openlit.local",
    serviceToken: "secret",
    fetchImpl: async () => response(noObservation)
  });
  const unobserved = await client.query(supportedSelection);
  assert.equal(unobserved.kind, "ok");
  if (unobserved.kind === "ok") {
    assert.equal(unobserved.data.metrics.gitChanges.status, "not-observed");
    assert.equal(unobserved.data.metrics.gitChanges.commits, null);
  }

  commits.observed = true;
  commits.rows = [{ commits: "0" }];
  for (const id of [
    "git-files-changed",
    "git-files-added",
    "git-files-deleted",
    "git-lines-added",
    "git-lines-removed",
    "git-partial-commits"
  ]) {
    const count = noObservation.widgets.find((widget) => widget.key === id);
    assert.ok(count);
    count.observed = true;
    count.rows = [{ value: "0" }];
    count.valuePath = "0.value";
  }
  const emptyClient = new OpenLITUsageClient({
    baseUrl: "http://openlit.local",
    serviceToken: "secret",
    fetchImpl: async () => response(noObservation)
  });
  const empty = await emptyClient.query(supportedSelection);
  assert.equal(empty.kind, "ok");
  if (empty.kind === "ok") {
    assert.equal(empty.data.metrics.gitChanges.status, "observed");
    assert.equal(empty.data.metrics.gitChanges.commits, 0);
    assert.deepEqual(empty.data.metrics.gitChanges.commitsByWorkspace, []);
  }
});

test("Git Usage is not applicable to the live Active Sessions scope", async () => {
  const client = new OpenLITUsageClient({
    baseUrl: "http://openlit.local",
    serviceToken: "secret",
    fetchImpl: async () => response(partialPayload)
  });
  const result = await client.query({ range: "ACTIVE_SESSIONS", values: {} });
  assert.equal(result.kind, "ok");
  if (result.kind === "ok") {
    assert.equal(result.data.metrics.gitChanges.status, "not-applicable");
    assert.equal(
      result.data.metrics.gitChanges.notApplicableReason,
      "active-sessions"
    );
    assert.equal(result.data.metrics.gitChanges.commits, null);
  }
});

test("Git line totals stay unobserved when partial-diff coverage failed", async () => {
  const incomplete = structuredClone(partialPayload);
  const partialWidget = incomplete.widgets.find(
    (widget) => widget.key === "git-partial-commits"
  );
  assert.ok(partialWidget);
  partialWidget.querySucceeded = false;
  partialWidget.observed = false;
  partialWidget.rows = [];

  const client = new OpenLITUsageClient({
    baseUrl: "http://openlit.local",
    serviceToken: "secret",
    fetchImpl: async () => response(incomplete)
  });
  const result = await client.query(supportedSelection);
  assert.equal(result.kind, "ok");
  if (result.kind !== "ok") return;
  assert.equal(result.data.metrics.gitChanges.status, "observed");
  assert.equal(result.data.metrics.gitChanges.commits, 2);
  assert.equal(result.data.metrics.gitChanges.partial, null);
  assert.equal(result.data.metrics.gitChanges.partialCommits, null);
  assert.equal(result.data.metrics.gitChanges.filesChanged, 4);
  assert.equal(result.data.metrics.gitChanges.linesAdded, null);
  assert.equal(result.data.metrics.gitChanges.linesRemoved, null);
});

test("OpenLITUsageClient distinguishes a successful empty series from a failed query", async () => {
  const empty = structuredClone(partialPayload);
  const compactions = empty.widgets.find(
    (widget) => widget.key === "context-compactions"
  );
  assert.ok(compactions);
  compactions.observed = true;
  compactions.rows = [{ compactions: "0" }];
  for (const key of [
    "context-compactions-over-time",
    "context-compactions-by-workspace",
    "context-compactions-by-model",
    "context-compactions-by-agent"
  ]) {
    const widget = empty.widgets.find((item) => item.key === key);
    assert.ok(widget);
    widget.querySucceeded = true;
    widget.observed = false;
    widget.rows = [];
  }

  const client = new OpenLITUsageClient({
    baseUrl: "http://openlit.local",
    serviceToken: "secret",
    fetchImpl: async () => response(empty)
  });
  const result = await client.query(supportedSelection);
  assert.equal(result.kind, "ok");
  if (result.kind !== "ok") return;
  assert.equal(result.data.metrics.contextCompactions, 0);
  assert.equal(result.data.metrics.contextCompactionRatePercent, 0);
  assert.deepEqual(result.data.metrics.contextCompactionsOverTime, []);
  assert.deepEqual(result.data.metrics.contextCompactionsByWorkspace, []);

  const failed = structuredClone(empty);
  const failedSeries = failed.widgets.find(
    (widget) => widget.key === "context-compactions-over-time"
  );
  assert.ok(failedSeries);
  failedSeries.querySucceeded = false;
  const failedClient = new OpenLITUsageClient({
    baseUrl: "http://openlit.local",
    serviceToken: "secret",
    fetchImpl: async () => response(failed)
  });
  const failedResult = await failedClient.query(supportedSelection);
  assert.equal(failedResult.kind, "ok");
  if (failedResult.kind !== "ok") return;
  assert.equal(failedResult.data.metrics.contextCompactions, 0);
  assert.equal(failedResult.data.metrics.contextCompactionsOverTime, null);
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
      response({ ...partialPayload, schema: "autodev-openlit-usage-v3" })
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
  const cacheWidget = invalidRatio.widgets.find(
    (widget) => widget.key === "cache-rate"
  );
  assert.ok(cacheWidget);
  cacheWidget.rows = [{ cached: "3", input: "0" }];
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
  const logicalRequests = malformed.widgets.find(
    (widget) => widget.key === "logical-requests"
  );
  assert.ok(logicalRequests);
  logicalRequests.rows = [{ requests: "NaN" }];
  const client = new OpenLITUsageClient({
    baseUrl: "http://openlit.local",
    serviceToken: "secret",
    fetchImpl: async () => response(malformed)
  });
  const result = await client.query(selection);
  assert.equal(result.kind, "ok");
  if (result.kind !== "ok") return;
  assert.equal(result.data.metrics.logicalRequests, null);
  assert.equal(result.data.metrics.physicalAttempts, 5);
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
