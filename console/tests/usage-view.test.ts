import assert from "node:assert/strict";
import test from "node:test";

import type {
  ControlApiMcpRuntimeResponse,
  McpServerResource,
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
  type UsageMcpInventory,
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
  p95ProviderQueueMs: null,
  p95ProviderSiteMs: null,
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
  contextCompactionsByProvider: [{ name: "anthropic", count: 3 }],
  providerHops: 3,
  providerHopRatePercent: 6,
  providerHopsOverTime: [{ bucket: "2026-11-09 09:00", count: 2 }],
  providerHopsByRoute: [{ name: "anthropic → openai", count: 3 }],
  providerHopsByProvider: [{ name: "openai", count: 3 }],
  providerHopsByRole: [{ name: "worker", count: 3 }],
  providerHopsByWorkspace: [{ name: "autodev", count: 3 }],
  providerHopsByReason: [{ name: "fallback", count: 3 }],
  providerHopsUnsupportedFilters: [],
  providerHopsBreakdownsPartial: false,
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
    linesAdded: null,
    linesRemoved: null,
    partialCommits: 1,
    commitsByWorkspace: [{ name: "repo-a", count: 2 }],
    commitsByProvider: [{ name: "codex", count: 2 }],
    commitsByAgent: [{ name: "worker", count: 2 }]
  },
  skillEventsByEvent: [{ event: "used", count: 4 }],
  requestsByRole: [{ role: "Default", count: 42 }],
  requestsByModel: [
    { model: "autodev/orchestrator", count: 28 },
    { model: "autodev/worker", count: 14 }
  ],
  requestsByWorkspace: {
    rows: [{ workspace: "repo-a", count: 42 }],
    partial: false
  },
  attemptsByProvider: [{ provider: "openai", count: 48 }],
  attemptsByModel: [
    { model: "gpt-5.4", count: 36 },
    { model: "claude-sonnet-4-5", count: 12 }
  ],
  callsByTool: [{ tool: "mcp__playwright__test", count: 5 }]
};

test("Usage cost formatting keeps catalog estimates explicit and unobserved distinct", () => {
  assert.equal(formatEstimatedCost(0.0081), "$0.0081");
  assert.equal(formatEstimatedCost(541.080125), "$541.08");
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
  assert.match(markup, /line totals are unavailable/u);
  assert.match(markup, /Not observed \/ Not observed/u);
  assert.match(markup, /reached its result limit/u);
  assert.match(markup, /Commits by workspace/u);
  assert.match(markup, /Commits by provider/u);
  assert.match(markup, /Commits by agent role/u);
});

test("Usage splits attempt latency into the provider queue wait and the time on it", () => {
  const markup = renderToStaticMarkup(
    React.createElement(UsageView, {
      metrics: {
        ...observedMetrics,
        p95ProviderQueueMs: 12_500,
        p95ProviderSiteMs: 101_400
      }
    })
  );
  assert.match(markup, /Attempt latency/u);
  for (const [title, ms] of [
    ["P95 Provider Queue", 12_500],
    ["P95 Provider On-site", 101_400]
  ] as const) {
    const at = markup.indexOf(title);
    assert.ok(at !== -1, title);
    assert.ok(
      markup.slice(at, at + 600).includes(formatLatency(ms)),
      `${title} shows ${formatLatency(ms)}`
    );
  }

  // An attempt that reports no phases leaves the cards unobserved, not zero.
  const unreported = renderToStaticMarkup(
    React.createElement(UsageView, { metrics: observedMetrics })
  );
  assert.match(unreported, /P95 Provider Queue[\s\S]*?Not observed/u);
});

test("Usage carries the session scope in the top bar, not in a metric filter", () => {
  const markup = renderToStaticMarkup(
    React.createElement(UsageView, {
      metrics: observedMetrics,
      selection: { range: "7D", values: {} }
    })
  );

  // The session id is a view scope carried by the page's own filter form, so
  // the scope is addressable and the page's answer is server-rendered.
  assert.match(markup, /data-text-field="usage-session-id"/u);
  assert.match(markup, /name="sessionId"/u);
  assert.match(markup, /placeholder="Session or thread ID"/u);
  assert.match(markup, /action="\/usage"/u);
  assert.doesNotMatch(markup, /data-feature="usage-session-lookup"/u);
  assert.doesNotMatch(markup, /action="\/api\/usage\/session"/u);
  // The session is a scope, not a filter option: no select offers it, and the
  // bounded filter dimensions stay the ones the telemetry source knows.
  assert.doesNotMatch(markup, /<select[^>]*name="session/u);
  for (const dimension of [
    "workspace",
    "provider",
    "model",
    "agent",
    "skill"
  ]) {
    assert.match(markup, new RegExp(`name="${dimension}[^"]*"`, "u"));
  }
});

test("a session scope replaces the fleet body and offers a way back", () => {
  const markup = renderToStaticMarkup(
    React.createElement(UsageView, {
      metrics: observedMetrics,
      selection: { range: "7D", values: {} },
      sessionScope: {
        sessionId: "01a0ba14-d54c-78f2-9367-3f80e9a8f75f",
        invalid: false,
        rawSessionId: "01a0ba14-d54c-78f2-9367-3f80e9a8f75f"
      },
      sessionView: React.createElement("p", null, "session diagnostics")
    })
  );

  assert.match(markup, /data-usage-session-scoped="true"/u);
  assert.match(markup, /session diagnostics/u);
  assert.match(markup, /Clear session/u);
  // The fleet's own metrics are a different question, and they are gone.
  assert.doesNotMatch(markup, /Requests &amp; model usage/u);
});

test("Active Sessions does not present an historical session query", () => {
  const markup = renderToStaticMarkup(
    React.createElement(UsageView, {
      metrics: observedMetrics,
      selection: { range: "ACTIVE_SESSIONS", values: {} }
    })
  );

  assert.doesNotMatch(markup, /data-feature="usage-session-lookup"/u);
});

test("Usage shows provider hops with both providers, the reason and where they happened", () => {
  const markup = renderToStaticMarkup(
    React.createElement(UsageView, { metrics: observedMetrics })
  );

  assert.match(markup, /Provider Hops/u);
  assert.match(markup, /Hops per Request/u);
  assert.match(markup, /Provider Hops Over Time/u);
  assert.match(
    markup,
    /<time dateTime="2026-11-09T09:00:00Z">2026-11-09 09:00:00 UTC<\/time>/u
  );
  assert.match(markup, /Provider Hops by Route/u);
  assert.match(markup, /anthropic → openai/u);
  assert.match(markup, /Provider Hops by Reason/u);
  assert.match(markup, /fallback/u);
  assert.match(markup, /Provider Hops by Provider/u);
  assert.match(markup, /Provider Hops by Workspace/u);
  assert.match(markup, /Provider Hops by Agent Role/u);
});

test("Usage labels hops without source workspace attribution explicitly", () => {
  const metrics: UsageMetricsData = {
    ...observedMetrics,
    providerHopsByWorkspace: [{ name: "", count: 236 }]
  };
  const markup = renderToStaticMarkup(
    React.createElement(UsageView, { metrics })
  );

  assert.match(markup, /Not attributed/u);
  assert.match(markup, /Provider hops by workspace/u);
  assert.match(markup, /Provider Hops by Workspace/u);
  assert.match(markup, /236/u);
});

test("Usage says when provider hops cannot answer the selected filters", () => {
  const metrics: UsageMetricsData = {
    ...observedMetrics,
    providerHopsUnsupportedFilters: ["provider"]
  };
  const markup = renderToStaticMarkup(
    React.createElement(UsageView, { metrics })
  );

  assert.match(markup, /data-provider-hop-scope="not-applicable"/u);
  assert.match(
    markup,
    /Provider hop data is unavailable for the selected provider filter/u
  );
});

test("a panel whose signal cannot answer the selection is not reported as unobserved", () => {
  // The source observed the signal; the selected filter is what rules it
  // out. Reporting that as "not observed" tells the reader a capture is
  // missing when it is there -- which is exactly how a working metric gets
  // mistaken for a broken one.
  const metrics: UsageMetricsData = {
    ...observedMetrics,
    providerHops: null,
    providerHopRatePercent: null,
    providerHopsOverTime: null,
    providerHopsByRoute: null,
    providerHopsByProvider: null,
    providerHopsByRole: null,
    providerHopsByWorkspace: null,
    providerHopsByReason: null,
    providerHopsUnsupportedFilters: ["provider"],
    contextCompactions: null,
    contextCompactionRatePercent: null,
    contextCompactionsOverTime: null,
    contextCompactionsByWorkspace: null,
    contextCompactionsByModel: null,
    contextCompactionsByAgent: null,
    contextCompactionsByProvider: null,
    contextCompactionsUnsupportedFilters: ["provider"]
  };
  const markup = renderToStaticMarkup(
    React.createElement(UsageView, { metrics })
  );

  assert.doesNotMatch(markup, /breakdown not observed/u);
  assert.doesNotMatch(markup, /data not observed/u);
  assert.match(
    markup,
    /Provider hop agent-role breakdown is unavailable for the selected provider filter/u
  );
  assert.match(
    markup,
    /Agent-role compaction breakdown is unavailable for the selected provider filter/u
  );
  assert.match(
    markup,
    /Requested-model compaction breakdown is unavailable for the selected provider filter/u
  );
  // The counts are ruled out by the selection, not missing from the source.
  assert.match(markup, /Not applicable/u);
});

test("an unobserved signal is still reported as unobserved", () => {
  // The opposite failure: a signal that really was not observed must not
  // borrow the wording that belongs to a filter the signal cannot answer.
  const metrics: UsageMetricsData = {
    ...observedMetrics,
    providerHops: null,
    providerHopRatePercent: null,
    providerHopsOverTime: null,
    providerHopsByRoute: null,
    providerHopsByProvider: null,
    providerHopsByRole: null,
    providerHopsByWorkspace: null,
    providerHopsByReason: null,
    providerHopsUnsupportedFilters: []
  };
  const markup = renderToStaticMarkup(
    React.createElement(UsageView, { metrics })
  );

  assert.match(markup, /Provider hop agent-role breakdown not observed/u);
});

test("unobserved Git status alone does not make the Usage page look observed", () => {
  const metrics: UsageMetricsData = {
    ...observedMetrics,
    logicalRequests: null,
    totalInputTokens: null,
    totalOutputTokens: null,
    cacheReadRate: null,
    p95LatencyMs: null,
    p95ProviderQueueMs: null,
    p95ProviderSiteMs: null,
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
    contextCompactionsByProvider: null,
    providerHops: null,
    providerHopRatePercent: null,
    providerHopsOverTime: null,
    providerHopsByRoute: null,
    providerHopsByProvider: null,
    providerHopsByRole: null,
    providerHopsByWorkspace: null,
    providerHopsByReason: null,
    providerHopsUnsupportedFilters: [],
    providerHopsBreakdownsPartial: false,
    skillEventsByEvent: null,
    requestsByRole: null,
    requestsByModel: null,
    requestsByWorkspace: null,
    attemptsByProvider: null,
    attemptsByModel: null,
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
        schema: "autodev-usage-active-sessions-v3",
        lifecycle: "ready",
        lifecycleChangedAt: "2026-10-01T12:00:00.000Z",
        activeSessions: 3,
        identifiedSessionCount: 3,
        activeSubagentThreads: 1,
        inFlightRequests: 0,
        sessionIdentities: [
          {
            sessionId: "session-fixture-a",
            state: "active",
            lastActivityAt: 1_760_000_000_000,
            provider: "claude",
            model: "opus",
            role: "orchestrator",
            clientSurface: "codex_desktop"
          },
          {
            sessionId: "session-fixture-b",
            state: "tool_wait",
            lastActivityAt: 1_760_000_001_000,
            provider: null,
            model: null,
            role: null,
            clientSurface: null
          },
          {
            sessionId: "abc",
            state: "resumed",
            lastActivityAt: 1_760_000_002_000,
            provider: null,
            model: null,
            role: null,
            clientSurface: "codex_exec"
          }
        ],
        sessionIdentitiesPartial: false,
        unattributedLiveActivityCount: 0
      }
    })
  );

  assert.match(
    markup,
    /Active Sessions<\/h2><div class="flex flex-col gap-6"><div class="[^"]*" data-stat-grid="3">/u
  );
  assert.match(markup, /session-…re-a/u);
  assert.match(markup, /••••/u);
  // The rendered identity stays masked; the link carries it, because the
  // session scope is addressable and a link that cannot name its session
  // cannot open it.
  assert.doesNotMatch(markup, />session-fixture-a</u);
  assert.doesNotMatch(markup, />abc</u);
  assert.match(markup, /sessionId=session-fixture-a/u);
  assert.match(markup, /Live Runtime sessions/u);
  for (const value of [
    "Client",
    "Provider",
    "Model",
    "Role",
    "Codex app",
    "codex exec",
    "claude",
    "opus",
    "orchestrator"
  ]) {
    assert.match(markup, new RegExp(value, "u"));
  }
  assert.match(markup, /Not observed/u);
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
  assert.match(markup, /Context Compactions by Provider/);
  assert.match(markup, /anthropic/);
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
        contextCompactionsByProvider: null,
        providerHops: null,
        providerHopRatePercent: null,
        providerHopsOverTime: null,
        providerHopsByRoute: null,
        providerHopsByProvider: null,
        providerHopsByRole: null,
        providerHopsByWorkspace: null,
        providerHopsByReason: null,
        providerHopsUnsupportedFilters: [],
        providerHopsBreakdownsPartial: false,
        contextCompactionsUnsupportedFilters: ["provider", "skill"]
      },
      selection
    })
  );
  assert.match(markup, /data-context-compaction-scope="not-applicable"/u);
  assert.match(markup, /provider and skill filters/u);
  assert.match(markup, /Context compaction data is unavailable/u);
  // The panels say the selection rules the signal out. They do not claim the
  // source never reported it -- that is a different fact, and reporting it
  // as a missing capture sends the reader after a metric that is there.
  assert.match(
    markup,
    /Compaction time-series data is unavailable for the selected provider and skill filters/u
  );
  assert.doesNotMatch(markup, /Compaction time-series data not observed/u);
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
        contextCompactionsByProvider: null,
        providerHops: null,
        providerHopRatePercent: null,
        providerHopsOverTime: null,
        providerHopsByRoute: null,
        providerHopsByProvider: null,
        providerHopsByRole: null,
        providerHopsByWorkspace: null,
        providerHopsByReason: null,
        providerHopsUnsupportedFilters: [],
        providerHopsBreakdownsPartial: false,
        contextCompactionsUnsupportedFilters: ["provider", "skill"]
      },
      traceList,
      selection
    })
  );

  assert.match(markup, /Recent provider attempts/);
  assert.match(markup, /This list is partial/);
  assert.match(markup, /Time/);
  assert.doesNotMatch(markup, /Time \(UTC\)/);
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

test("UsageView renders Requests by Model and Physical Attempts by Model beside role and provider charts", () => {
  const observed = renderToStaticMarkup(
    React.createElement(UsageView, { metrics: observedMetrics })
  );
  assert.match(observed, /Requests by Model/u);
  assert.match(observed, /autodev\/orchestrator/u);
  assert.match(observed, /autodev\/worker/u);
  assert.match(observed, /Physical Attempts by Model/u);
  assert.match(observed, /gpt-5\.4/u);
  assert.match(observed, /claude-sonnet-4-5/u);

  const unobserved = renderToStaticMarkup(
    React.createElement(UsageView, {
      metrics: {
        ...observedMetrics,
        requestsByModel: null,
        attemptsByModel: null
      }
    })
  );
  assert.match(unobserved, /Requested model telemetry not observed\./u);
  assert.match(unobserved, /Served model attempt telemetry not observed\./u);
});

const sampleMcpServers: readonly McpServerResource[] = [
  {
    name: "playwright",
    declared: true,
    enabled: true,
    transport: "stdio",
    targetOverrides: [],
    roles: ["orchestrator", "worker"]
  },
  {
    name: "lsp",
    declared: true,
    enabled: true,
    transport: "stdio",
    targetOverrides: [],
    roles: ["worker"]
  },
  {
    name: "legacy-disabled",
    declared: true,
    enabled: false,
    transport: "http",
    targetOverrides: [],
    roles: ["worker"]
  }
];

const sampleMcpRuntime: ControlApiMcpRuntimeResponse = {
  schema: "autodev-control-mcp-runtime-v1",
  source: "runtime.telemetry",
  observedServers: 2,
  health: { ready: 1, error: 1, stale: 0, configured: 0, observed: 0 },
  servers: [
    {
      name: "playwright",
      health: "error",
      lastSeenAt: "2026-11-21T09:00:00.000Z",
      lastStatus: "error",
      initAttempts: null,
      toolDiscoveryAttempts: null,
      toolCalls: 12,
      failures: 2,
      averageDurationMs: 42,
      roles: [],
      tools: [{ name: "browser_click", count: 12, errors: 2 }]
    },
    {
      name: "ephemeral-mcp",
      health: "ready",
      lastSeenAt: "2026-11-21T09:05:00.000Z",
      lastStatus: "ready",
      initAttempts: null,
      toolDiscoveryAttempts: null,
      toolCalls: 3,
      failures: 0,
      averageDurationMs: 10,
      roles: [],
      tools: []
    }
  ]
};

test("UsageView renders MCP servers exposed vs. used alongside MCP Calls by Tool Name", () => {
  const mcpInventory: UsageMcpInventory = {
    kind: "observed",
    servers: sampleMcpServers,
    sourceValidity: true,
    validationIssues: [],
    runtime: sampleMcpRuntime,
    runtimeFailure: null
  };
  const markup = renderToStaticMarkup(
    React.createElement(UsageView, { metrics: observedMetrics, mcpInventory })
  );

  assert.match(markup, /MCP Calls by Tool Name/u);
  assert.match(markup, /mcp__playwright__test/u);
  assert.match(markup, /data-mcp-inventory-status="observed"/u);
  assert.match(markup, /every call the shared MCP gateway served since it started/u);
  assert.match(
    markup,
    /3 configured · 2 exposed · 2 used · 1 exposed, never used/u
  );
  assert.match(markup, /playwright/u);
  assert.match(markup, /data-mcp-usage-state="used-with-errors"/u);
  assert.match(markup, /Used \(errors\)/u);
  assert.match(markup, /lsp/u);
  assert.match(markup, /data-mcp-usage-state="exposed-never-used"/u);
  assert.match(markup, /Exposed, never used/u);
  assert.match(markup, /legacy-disabled/u);
  assert.match(markup, /data-mcp-usage-state="disabled"/u);
  assert.match(markup, /ephemeral-mcp/u);
  assert.match(markup, /data-mcp-usage-state="observed-unconfigured"/u);
});

test("UsageView renders explicit unavailable state when Control API MCP inventory or runtime observations fail", () => {
  const unavailable = renderToStaticMarkup(
    React.createElement(UsageView, {
      metrics: observedMetrics,
      mcpInventory: {
        kind: "unavailable",
        code: "autodev_control_api_unreachable",
        message: "Control API timed out."
      }
    })
  );
  assert.match(unavailable, /data-mcp-inventory-status="unavailable"/u);
  assert.match(unavailable, /MCP server inventory is unavailable/u);
  assert.match(unavailable, /autodev_control_api_unreachable/u);
  assert.doesNotMatch(
    unavailable,
    /No MCP servers are configured or observed/u
  );

  const runtimeUnavailable = renderToStaticMarkup(
    React.createElement(UsageView, {
      metrics: observedMetrics,
      mcpInventory: {
        kind: "observed",
        servers: sampleMcpServers,
        sourceValidity: true,
        validationIssues: [],
        runtime: null,
        runtimeFailure: {
          code: "autodev_control_api_http_503",
          message: "Runtime observation endpoint returned 503."
        }
      }
    })
  );
  assert.match(
    runtimeUnavailable,
    /data-mcp-inventory-status="runtime-unavailable"/u
  );
  assert.match(
    runtimeUnavailable,
    /Runtime MCP observations are unavailable \(autodev_control_api_http_503\)/u
  );
  assert.match(runtimeUnavailable, /data-mcp-usage-state="not-observed"/u);
  assert.doesNotMatch(
    runtimeUnavailable,
    /data-mcp-usage-state="exposed-never-used"/u
  );
});
