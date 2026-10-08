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
  UsageView
} from "../src/features/usage/UsageView.ts";

const selection: UsageFilterSelection = {
  range: "7D",
  values: { provider: ["openai"], skill: ["agent-skill"] }
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
  skillEventsByEvent: [{ event: "used", count: 4 }],
  requestsByRole: [{ role: "Default", count: 42 }],
  attemptsByProvider: [{ provider: "openai", count: 48 }],
  callsByTool: [{ tool: "mcp__playwright__test", count: 5 }]
};

test("Usage cost formatting keeps catalog estimates explicit and unobserved distinct", () => {
  assert.equal(formatEstimatedCost(0.0081), "$0.0081");
  assert.equal(formatEstimatedCost(541.080_125), "$541.08");
  assert.equal(formatEstimatedCost(null), "Not observed");
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
    React.createElement(UsageView, { metrics: observedMetrics, selection })
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
  assert.match(markup, /Failed attempts by provider/);
  assert.match(markup, /Skill observations by event/);
  assert.doesNotMatch(markup, /Shim-owned/);
  assert.match(markup, /data-usage-observed="true"/);
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
      metrics: observedMetrics,
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
