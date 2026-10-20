import assert from "node:assert/strict";
import test from "node:test";

import type {
  UsageFilterSelection,
  UsageMetricsData,
  UsageTraceDetail,
  UsageTraceList
} from "@simulatorlife/autodev-core";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import {
  formatEstimatedCost,
  formatLatency,
  UsageView
} from "../src/features/usage/UsageView.ts";

const selection: UsageFilterSelection = {
  range: "7D",
  values: { provider: ["openai"], skill: ["agent-skill"] }
};
const compactionSelection: UsageFilterSelection = {
  range: "7D",
  values: {
    workspace: ["repo-a"],
    model: ["gpt-6-luna"],
    agent: ["orchestrator"]
  }
};

const unobservedGitChanges: UsageMetricsData["gitChanges"] = {
  status: "not-observed",
  notApplicableReason: null,
  unsupportedFilters: [],
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
};

const observedMetrics: UsageMetricsData = {
  logicalRequests: 42,
  totalInputTokens: 1200,
  totalOutputTokens: 300,
  cacheReadRate: 25,
  p95LatencyMs: 1250,
  estimatedCostUsd: 0.0081,
  physicalAttempts: 48,
  mcpCalls: 5,
  p95McpDurationMs: 30,
  mcpErrors: 0,
  failedAttempts: 2,
  attemptErrorsByProvider: [{ provider: "openai", count: 2 }],
  contextCompactions: 3,
  contextCompactionRatePercent: (3 / 42) * 100,
  contextCompactionsOverTime: [
    { bucket: "10/06 00:00", count: 1 },
    { bucket: "10/07 00:00", count: 2 }
  ],
  contextCompactionsByWorkspace: [{ name: "repo-a", count: 3 }],
  contextCompactionsByModel: [{ name: "gpt-6-luna", count: 3 }],
  contextCompactionsByAgent: [{ name: "orchestrator", count: 3 }],
  contextCompactionsUnsupportedFilters: [],
  contextCompactionsBreakdownsPartial: false,
  gitChanges: {
    status: "observed",
    notApplicableReason: null,
    unsupportedFilters: [],
    partial: true,
    breakdownsPartial: true,
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
  },
  skillEventsByEvent: [{ event: "used", count: 4 }],
  requestsByRole: [{ role: "Default", count: 42 }],
  requestsByWorkspace: {
    rows: [{ workspace: "repo-a", count: 42 }],
    partial: false
  },
  attemptsByProvider: [{ provider: "openai", count: 48 }],
  callsByTool: [{ tool: "mcp__playwright__test", count: 5 }]
};

test("Usage cost formatting keeps catalog estimates explicit and unobserved distinct", () => {
  assert.equal(formatEstimatedCost(0.0081), "$0.0081");
  assert.equal(formatEstimatedCost(541.080_125), "$541.08");
  assert.equal(formatEstimatedCost(null), "Not observed");
});

test("Usage renders Git output without double-counting file subsets or hiding partial diffs", () => {
  const markup = renderToStaticMarkup(
    React.createElement(UsageView, { metrics: observedMetrics })
  );

  assert.match(markup, /data-git-change-output="observed"/u);
  assert.match(markup, /Agent Commits/u);
  assert.match(markup, /Files Changed/u);
  assert.match(markup, /Subset of files changed/u);
  assert.match(markup, /Partial diff measurements were observed for 1 commit/u);
  assert.match(markup, /reached its result limit/u);
  assert.match(markup, /Commits by workspace/u);
  assert.match(markup, /Commits by provider/u);
  assert.match(markup, /Commits by agent role/u);
});

test("unobserved Git status alone does not make the Usage page look observed", () => {
  const metrics: UsageMetricsData = {
    ...observedMetrics,
    logicalRequests: null,
    totalInputTokens: null,
    totalOutputTokens: null,
    cacheReadRate: null,
    p95LatencyMs: null,
    estimatedCostUsd: null,
    physicalAttempts: null,
    mcpCalls: null,
    p95McpDurationMs: null,
    mcpErrors: null,
    failedAttempts: null,
    attemptErrorsByProvider: null,
    contextCompactions: null,
    contextCompactionRatePercent: null,
    contextCompactionsOverTime: null,
    contextCompactionsByWorkspace: null,
    contextCompactionsByModel: null,
    contextCompactionsByAgent: null,
    skillEventsByEvent: null,
    requestsByRole: null,
    requestsByWorkspace: null,
    attemptsByProvider: null,
    callsByTool: null,
    gitChanges: unobservedGitChanges
  };
  const markup = renderToStaticMarkup(
    React.createElement(UsageView, { metrics })
  );

  assert.match(markup, /data-usage-observed="false"/u);
  assert.match(markup, /No source-confirmed AutoDev commits were observed/u);
});

test("Usage latency formatting renders sub-millisecond durations in microseconds", () => {
  assert.equal(formatLatency(null), "Not observed");
  assert.equal(formatLatency(0), "0 ms");
  assert.equal(formatLatency(0.004), "4 µs");
  assert.equal(formatLatency(0.5), "500 µs");
  assert.equal(formatLatency(12.34), "12.3 ms");
  assert.equal(formatLatency(120.4), "120.4 ms");
  assert.equal(formatLatency(1250), "1.3 s");
});

test("Usage active-session stats and detail use the shared section spacing", () => {
  const markup = renderToStaticMarkup(
    React.createElement(UsageView, {
      selection: { range: "ACTIVE_SESSIONS", values: {} },
      activeSessions: {
        schema: "autodev-usage-active-sessions-v1",
        lifecycle: "ready",
        lifecycleChangedAt: "2026-10-01T12:00:00.000Z",
        activeSessions: 2,
        activeSubagentThreads: 1,
        inFlightRequests: 0,
        perSessionIdentityAvailable: false
      }
    })
  );

  assert.match(
    markup,
    /Active Sessions<\/h2><div class="flex flex-col gap-6"><div class="[^"]*" data-stat-grid="4">/u
  );
});

test("UsageView keeps scope filters but omits metrics until a snapshot is validated", () => {
  const markup = renderToStaticMarkup(
    React.createElement(UsageView, { selection })
  );

  assert.match(markup, /Usage scope:/);
  assert.match(markup, /Provider:/);
  assert.match(markup, /value="openai"/);
  assert.match(markup, /Skill:/);
  assert.match(markup, /value="agent-skill"/);
  assert.match(markup, /data-usage-observed="false"/);
  assert.doesNotMatch(markup, /Requests &amp; model usage/);
  assert.doesNotMatch(markup, /Logical Routed Requests/);
  assert.doesNotMatch(markup, /Requests by Agent Role/);
  assert.doesNotMatch(markup, /MCP Calls by Tool Name/);
});

test("UsageView groups validated request, reliability, skill, and MCP metrics with shared components", () => {
  const markup = renderToStaticMarkup(
    React.createElement(UsageView, {
      metrics: observedMetrics,
      selection: compactionSelection
    })
  );

  assert.match(markup, /Requests &amp; model usage/);
  assert.match(markup, /Estimated Cost/);
  assert.match(markup, /\$0\.0081/);
  assert.match(markup, /Logical Routed Requests/);
  assert.match(markup, />42</);
  assert.match(markup, /Requests by Agent Role/);
  assert.match(markup, /MCP tool activity/);
  assert.match(markup, /MCP Calls by Tool Name/);
  assert.match(markup, /Failed Provider Attempts/);
  assert.match(markup, /Context Compactions/);
  assert.match(markup, /Compactions per Request/);
  assert.match(markup, /Context Compactions Over Time/);
  assert.match(markup, /Context Compactions by Workspace/);
  assert.match(markup, /Context Compactions by Requested Model/);
  assert.match(markup, /Context Compactions by Agent Role/);
  assert.match(markup, /Failed attempts by provider/);
  assert.match(markup, /Skill observations by event/);
  assert.doesNotMatch(markup, /Shim-owned/);
  assert.match(markup, /data-usage-observed="true"/);

  const reliabilityStart = markup.indexOf("Reliability &amp; context");
  const skillActivityStart = markup.indexOf("Skill activity", reliabilityStart);
  const reliabilitySection = markup.slice(reliabilityStart, skillActivityStart);
  // The section heading is an `h2`: the shell's own `h1` names the page, and
  // the Usage page used to start at `h3`, so its outline skipped a level
  // before anything was said about the page.
  assert.match(
    reliabilitySection,
    /<\/h2><div class="flex flex-col gap-6"><div class="[^"]*" data-stat-grid="4">[\s\S]*Failed attempts by provider/u
  );
});

test("UsageView fails compaction widgets closed for unsupported provider and skill scopes", () => {
  const markup = renderToStaticMarkup(
    React.createElement(UsageView, {
      metrics: {
        ...observedMetrics,
        contextCompactions: null,
        contextCompactionRatePercent: null,
        contextCompactionsOverTime: null,
        contextCompactionsByWorkspace: null,
        contextCompactionsByModel: null,
        contextCompactionsByAgent: null,
        contextCompactionsUnsupportedFilters: ["provider", "skill"]
      },
      selection
    })
  );
  assert.match(markup, /data-context-compaction-scope="not-applicable"/u);
  assert.match(markup, /provider and skill filters/u);
  assert.match(markup, /Context compaction data is unavailable/u);
  assert.match(markup, /Compaction time-series data not observed/u);
});

test("UsageView shows the bounded recent-attempt table and preserves filters when opening a trace", () => {
  const traceList: UsageTraceList = {
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
  };
  const markup = renderToStaticMarkup(
    React.createElement(UsageView, {
      metrics: {
        ...observedMetrics,
        contextCompactions: null,
        contextCompactionRatePercent: null,
        contextCompactionsOverTime: null,
        contextCompactionsByWorkspace: null,
        contextCompactionsByModel: null,
        contextCompactionsByAgent: null,
        contextCompactionsUnsupportedFilters: ["provider", "skill"]
      },
      traceList,
      selection
    })
  );

  assert.match(markup, /Recent provider attempts/);
  assert.match(markup, /This list is partial/);
  assert.match(markup, /Time \(UTC\)/);
  assert.match(markup, /gpt-6-luna/);
  assert.match(markup, /data-trace-status="ERROR"/);
  assert.match(
    markup,
    /href="\/usage\?range=7D&amp;provider=openai&amp;skill=agent-skill&amp;spanId=0123456789abcdef"/
  );
});

test("UsageView renders bounded trace detail with an explicit way back to recent attempts", () => {
  const detail: UsageTraceDetail = {
    schema: "autodev-openlit-trace-detail-v1",
    traceId: "0123456789abcdef0123456789abcdef",
    selectedSpanId: "0123456789abcdef",
    partial: true,
    spans: [
      {
        spanId: "fedcba9876543210",
        parentSpanId: null,
        spanName: "autodev.logical_request",
        serviceName: "autodev-router",
        timestamp: "2026-10-07T11:59:59.000Z",
        durationNs: 2_000_000,
        statusCode: "OK"
      },
      {
        spanId: "0123456789abcdef",
        parentSpanId: "fedcba9876543210",
        spanName: "gen_ai.client_operation",
        serviceName: "autodev-router",
        timestamp: "2026-10-07T12:00:00.000Z",
        durationNs: 1_250_000,
        statusCode: "ERROR"
      }
    ]
  };
  const markup = renderToStaticMarkup(
    React.createElement(UsageView, {
      selection,
      traceLookup: { kind: "observed", detail }
    })
  );

  assert.match(markup, /data-feature="usage-trace-detail"/);
  assert.match(markup, /Trace ID:.*0123456789abcdef0123456789abcdef/);
  assert.match(markup, /Trace is partial/);
  assert.match(markup, /gen_ai\.client_operation/);
  assert.match(markup, /aria-current="true" data-trace-selected="true"/);
  assert.match(markup, /Close trace detail/);
  assert.match(
    markup,
    /href="\/usage\?range=7D&amp;provider=openai&amp;skill=agent-skill"/
  );
});

test("UsageView distinguishes unavailable and inapplicable recent attempts from an empty list", () => {
  const unavailable = renderToStaticMarkup(
    React.createElement(UsageView, {
      metrics: observedMetrics,
      traceList: { kind: "unavailable" },
      selection
    })
  );
  assert.match(unavailable, /Recent provider attempts were not observed/);
  assert.doesNotMatch(unavailable, /No provider attempts were observed/);

  const notApplicable = renderToStaticMarkup(
    React.createElement(UsageView, {
      metrics: observedMetrics,
      traceList: { kind: "not-applicable", reason: "skill-filter" },
      selection
    })
  );
  assert.match(
    notApplicable,
    /cannot safely attribute provider attempts to a skill/
  );
  assert.doesNotMatch(notApplicable, /No provider attempts were observed/);
});

test("UsageView keeps aggregate metrics visible when a selected trace is unavailable", () => {
  const markup = renderToStaticMarkup(
    React.createElement(UsageView, {
      metrics: observedMetrics,
      selection,
      traceLookup: { kind: "not-found" }
    })
  );

  assert.match(markup, /data-trace-state="not-found"/);
  assert.match(markup, /OpenLIT no longer has this span/);
  assert.match(markup, /Logical Routed Requests/);
  assert.match(markup, /Back to recent attempts/);
});
