import assert from "node:assert/strict";
import test from "node:test";

import { renderToStaticMarkup } from "react-dom/server";

import UsagePage from "../app/usage/page.ts";
import { sessionDiagnosticsReport } from "../e2e/session-diagnostics-fixture.ts";
import { clearUsageTelemetryCacheForTests } from "../src/lib/server/usage-telemetry.ts";

const usageToken = "usage-page-test-token";
const traceSpanId = "0123456789abcdef";
const usageWidgetIds = [
  "logical-requests",
  "input-tokens",
  "output-tokens",
  "cache-rate",
  "p95-latency",
  "p95-provider-queue",
  "p95-provider-site",
  "attempts-by-provider",
  "attempts-by-model",
  "requests-by-agent",
  "requests-by-model",
  "requests-by-workspace",
  "mcp-calls",
  "mcp-duration",
  "mcp-errors",
  "mcp-by-tool",
  "attempt-errors-by-provider",
  "context-compactions",
  "context-compactions-over-time",
  "context-compactions-by-workspace",
  "context-compactions-by-model",
  "context-compactions-by-agent",
  "context-compactions-by-provider",
  "git-commits",
  "git-files-changed",
  "git-files-added",
  "git-files-deleted",
  "git-lines-added",
  "git-lines-removed",
  "git-partial-commits",
  "git-commits-by-workspace",
  "git-commits-by-provider",
  "git-commits-by-agent",
  "provider-hops",
  "provider-hops-over-time",
  "provider-hops-by-route",
  "provider-hops-by-provider",
  "provider-hops-by-role",
  "provider-hops-by-workspace",
  "provider-hops-by-reason",
  "skill-events-by-event",
  "estimated-cost"
] as const;
const usageResponse = {
  schema: "autodev-openlit-usage-v5",
  widgets: usageWidgetIds.map((key) => ({
    key,
    querySucceeded: false,
    observed: false,
    partial: false,
    rows: []
  })),
  filterOptions: {
    workspace: { supported: true, values: [] },
    provider: { supported: true, values: ["openai"] },
    model: { supported: true, values: [] },
    agent: { supported: true, values: [] },
    skill: { supported: true, values: [] }
  },
  traceList: {
    kind: "observed",
    partial: false,
    attempts: [
      {
        spanId: traceSpanId,
        timestamp: "2026-10-07T12:00:00.000Z",
        durationNs: 1_250_000,
        statusCode: "OK",
        provider: "openai",
        model: "gpt-6-luna",
        role: "orchestrator"
      }
    ]
  }
};
const traceResponse = {
  schema: "autodev-openlit-trace-detail-v1",
  traceId: "0123456789abcdef0123456789abcdef",
  selectedSpanId: traceSpanId,
  partial: false,
  spans: [
    {
      spanId: traceSpanId,
      parentSpanId: null,
      spanName: "gen_ai.client_operation",
      serviceName: "autodev-router",
      timestamp: "2026-10-07T12:00:00.000Z",
      durationNs: 1_250_000,
      statusCode: "OK"
    }
  ]
};

function withUsageConfig(): () => void {
  const oldToken = process.env.AUTODEV_OPENLIT_USAGE_TOKEN;
  const oldUrl = process.env.AUTODEV_OPENLIT_USAGE_URL;
  const oldControlToken = process.env.AUTODEV_CONTROL_API_TOKEN;
  const oldCodexHome = process.env.CODEX_HOME;
  const oldFetch = fetch;
  process.env.AUTODEV_OPENLIT_USAGE_TOKEN = usageToken;
  process.env.AUTODEV_OPENLIT_USAGE_URL = "http://openlit.test";
  delete process.env.AUTODEV_CONTROL_API_TOKEN;
  process.env.CODEX_HOME = "/nonexistent-codex-home-for-usage-page-test";
  // The Usage telemetry cache is process-wide, so a read that a previous test
  // answered would otherwise answer this one -- and this file's tests each
  // stub a different response for the same selection.
  clearUsageTelemetryCacheForTests();
  return () => {
    if (oldToken === undefined) delete process.env.AUTODEV_OPENLIT_USAGE_TOKEN;
    else process.env.AUTODEV_OPENLIT_USAGE_TOKEN = oldToken;
    if (oldUrl === undefined) delete process.env.AUTODEV_OPENLIT_USAGE_URL;
    else process.env.AUTODEV_OPENLIT_USAGE_URL = oldUrl;
    if (oldControlToken === undefined) {
      delete process.env.AUTODEV_CONTROL_API_TOKEN;
    } else {
      process.env.AUTODEV_CONTROL_API_TOKEN = oldControlToken;
    }
    if (oldCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = oldCodexHome;
    globalThis.fetch = oldFetch;
    clearUsageTelemetryCacheForTests();
  };
}

test("UsagePage renders a validated v5 snapshot and selected trace using server-side OpenLIT calls", async () => {
  const restore = withUsageConfig();
  try {
    const requests: { url: string; init: RequestInit | undefined }[] = [];
    globalThis.fetch = async (input, init) => {
      const url = String(input);
      requests.push({ url, init });
      if (url === "http://openlit.test/api/autodev/usage") {
        return Response.json(usageResponse);
      }
      if (url === `http://openlit.test/api/autodev/usage/span/${traceSpanId}`) {
        return Response.json(traceResponse);
      }
      throw new Error(`Unexpected Usage request: ${url}`);
    };

    const markup = renderToStaticMarkup(
      await UsagePage({
        searchParams: Promise.resolve({
          range: "7D",
          provider: "openai",
          spanId: traceSpanId
        })
      })
    );

    assert.deepEqual(
      requests.map(({ url }) => url),
      [
        "http://openlit.test/api/autodev/usage",
        `http://openlit.test/api/autodev/usage/span/${traceSpanId}`
      ]
    );
    for (const request of requests) {
      assert.equal(
        (request.init?.headers as Record<string, string>).Authorization,
        `Bearer ${usageToken}`
      );
    }
    assert.match(markup, /Recent provider attempts/);
    assert.match(markup, /data-feature="usage-trace-detail"/);
    assert.match(markup, /gen_ai\.client_operation/);
    assert.match(markup, /value="openai" selected/);
    assert.match(markup, /data-mcp-inventory-status="unavailable"/);
    assert.match(markup, /autodev_control_api_not_configured/);
    assert.doesNotMatch(markup, new RegExp(usageToken));
  } finally {
    restore();
  }
});

test("UsagePage fails closed on a stale response schema while retaining its filters", async () => {
  const restore = withUsageConfig();
  try {
    globalThis.fetch = async () =>
      Response.json({ ...usageResponse, schema: "autodev-openlit-usage-v2" });

    const markup = renderToStaticMarkup(
      await UsagePage({
        searchParams: Promise.resolve({ range: "7D", provider: "openai" })
      })
    );

    assert.match(markup, /Usage telemetry response was invalid/);
    assert.match(markup, /required AutoDev Usage v5 contract/);
    assert.match(markup, /restart the managed Console/);
    assert.match(markup, /data-usage-observed="false"/);
    assert.match(markup, /Selected: openai/);
    assert.match(markup, /name="provider" value="openai"/);
    assert.doesNotMatch(markup, /Requests &amp; model usage/);
  } finally {
    restore();
  }
});

test("UsagePage maps an unreachable OpenLIT source to the actionable unavailable state", async () => {
  const restore = withUsageConfig();
  try {
    globalThis.fetch = async () => {
      throw new TypeError("connection refused");
    };

    const markup = renderToStaticMarkup(
      await UsagePage({
        searchParams: Promise.resolve({ range: "24H", provider: "openai" })
      })
    );

    assert.match(markup, /autodev_openlit_usage_unreachable/);
    assert.match(markup, /Check that OpenLIT is running/);
    assert.match(markup, /Selected: openai/);
    assert.match(markup, /data-usage-observed="false"/);
    assert.doesNotMatch(markup, /Requests &amp; model usage/);
  } finally {
    restore();
  }
});

const sessionId = "01a0ba14-d54c-78f2-9367-3f80e9a8f75f";
const threadId = "01a0ba16-d54c-78f2-9367-3f80e9a8f75f";
const controlApiToken = "control-api-test-token";
const sourceDiagnosticsReport = sessionDiagnosticsReport();
const diagnosticsReport = {
  ...sourceDiagnosticsReport,
  threads: (sourceDiagnosticsReport.threads as Record<string, unknown>[]).map(
    (thread) => ({ ...thread, modelProvider: "local_model_router" })
  )
};

const sessionUsageResponse = {
  schema: "autodev-openlit-session-usage-v3",
  status: "observed",
  partial: false,
  total: 1,
  limit: 50,
  offset: 0,
  hasMore: false,
  estimatedCostUsd: 0.01,
  spans: [
    {
      spanId: traceSpanId,
      traceId: "0123456789abcdef0123456789abcdef",
      parentSpanId: null,
      operationName: "chat",
      timestamp: "2026-11-10T12:00:00.000Z",
      durationNs: 1_000_000,
      statusCode: "OK",
      provider: "claude",
      conversationId: threadId,
      requestedModel: "autodev/worker",
      role: "worker",
      workspace: "SimulatorLife/AutoDev",
      inputTokens: 12,
      outputTokens: 3,
      cacheReadInputTokens: 4,
      costUsd: 0.001,
      requestKind: null,
      compactionProvider: null,
      hopRoute: null,
      hopFrom: null,
      hopTo: null,
      hopReason: null
    }
  ]
};

function withControlApiConfig(): () => void {
  const oldToken = process.env.AUTODEV_CONTROL_API_TOKEN;
  const oldUrl = process.env.AUTODEV_CONTROL_API_BASE_URL;
  process.env.AUTODEV_CONTROL_API_TOKEN = controlApiToken;
  process.env.AUTODEV_CONTROL_API_BASE_URL = "http://control.test";
  return () => {
    if (oldToken === undefined) delete process.env.AUTODEV_CONTROL_API_TOKEN;
    else process.env.AUTODEV_CONTROL_API_TOKEN = oldToken;
    if (oldUrl === undefined) delete process.env.AUTODEV_CONTROL_API_BASE_URL;
    else process.env.AUTODEV_CONTROL_API_BASE_URL = oldUrl;
  };
}

test("a session id in the top bar scopes the whole page to that session", async () => {
  const restore = withUsageConfig();
  const restoreControl = withControlApiConfig();
  try {
    const requests: string[] = [];
    globalThis.fetch = async (input, init) => {
      const url = String(input);
      requests.push(url);
      if (url.startsWith("http://control.test/control/diagnostics/sessions/")) {
        return Response.json(diagnosticsReport);
      }
      if (url === "http://openlit.test/api/autodev/usage/session") {
        const body = JSON.parse(String(init?.body)) as { limit: number };
        return Response.json({ ...sessionUsageResponse, limit: body.limit });
      }
      throw new Error(`Unexpected Usage request: ${url}`);
    };

    const markup = renderToStaticMarkup(
      await UsagePage({
        searchParams: Promise.resolve({ range: "24H", sessionId })
      })
    );

    assert.ok(
      requests.some((url) =>
        url.startsWith("http://control.test/control/diagnostics/sessions/")
      ),
      "the session's diagnostics are read from the Control API"
    );
    assert.ok(
      requests.includes("http://openlit.test/api/autodev/usage/session"),
      "the session's spans are read from the telemetry store"
    );
    assert.ok(
      !requests.includes("http://openlit.test/api/autodev/usage"),
      "a session-scoped page must not ask for the fleet-wide snapshot"
    );
    assert.match(markup, /data-usage-session-scoped="true"/);
    assert.match(markup, /name="sessionId"/);
    assert.match(markup, new RegExp(`value="${sessionId}"`));
    assert.match(markup, /Clear session/);
    assert.match(markup, /Overview/);
    assert.ok(
      markup.includes("Routed provider(s)"),
      `provider column missing; thread table: ${markup.includes("Session threads")}, actual provider: ${markup.includes("claude")}`
    );
    assert.match(markup, /claude/);
    assert.doesNotMatch(markup, /local_model_router/);
  } finally {
    restoreControl();
    restore();
  }
});

test("an invalid session id is refused before anything is read", async () => {
  const restore = withUsageConfig();
  const restoreControl = withControlApiConfig();
  try {
    const requests: string[] = [];
    globalThis.fetch = async (input) => {
      requests.push(String(input));
      throw new Error("nothing should be read");
    };

    const markup = renderToStaticMarkup(
      await UsagePage({
        searchParams: Promise.resolve({
          range: "24H",
          sessionId: "process-fallback"
        })
      })
    );

    assert.deepEqual(requests, []);
    assert.match(markup, /not a valid AutoDev session identity/u);
    assert.match(markup, /data-usage-session-scoped="true"/);
  } finally {
    restoreControl();
    restore();
  }
});

test("UsagePage loads Control API MCP inventory and runtime observations server-side", async () => {
  const restore = withUsageConfig();
  const restoreControl = withControlApiConfig();
  try {
    const requests: string[] = [];
    globalThis.fetch = async (input) => {
      const url = String(input);
      requests.push(url);
      if (url === "http://openlit.test/api/autodev/usage") {
        return Response.json(usageResponse);
      }
      if (url === "http://control.test/control/mcps") {
        return Response.json({
          schema: "autodev-control-mcps-v3",
          source: ".rulesync/mcp.jsonc",
          gateway: {
            label: "com.codex.autodev-mcp-gateway",
            installed: true,
            ready: true,
            port: 3312,
            readinessUrl: "http://127.0.0.1:3312/readyz",
            generation: "generation-1",
            workspace: "/workspace",
            role: "orchestrator",
            roles: ["orchestrator"],
            surfaces: [
              {
                role: "orchestrator",
                url: "http://127.0.0.1:3312/orchestrator/mcp"
              }
            ],
            reviewed: { lsp: ["lsp_hover"] },
            grants: { lsp: ["lsp_hover"] },
            error: null
          },
          revision: "rev-1",
          readOnly: false,
          valid: true,
          issues: [],
          servers: [
            {
              name: "playwright",
              declared: true,
              enabled: true,
              transport: "stdio",
              targetOverrides: [],
              roles: ["orchestrator"]
            },
            {
              name: "lsp",
              declared: true,
              enabled: true,
              transport: "stdio",
              targetOverrides: [],
              roles: ["worker"]
            }
          ]
        });
      }
      if (url === "http://control.test/control/mcp-runtime") {
        return Response.json({
          schema: "autodev-control-mcp-runtime-v1",
          source: "runtime.telemetry",
          observedServers: 1,
          health: { ready: 1, error: 0, stale: 0, configured: 0, observed: 0 },
          servers: [
            {
              name: "playwright",
              health: "ready",
              lastSeenAt: "2026-11-21T09:00:00.000Z",
              lastStatus: "ready",
              initAttempts: null,
              toolDiscoveryAttempts: null,
              toolCalls: 4,
              failures: 0,
              averageDurationMs: 25,
              roles: [],
              tools: []
            }
          ]
        });
      }
      throw new Error(`Unexpected UsagePage request: ${url}`);
    };

    const markup = renderToStaticMarkup(
      await UsagePage({
        searchParams: Promise.resolve({ range: "7D" })
      })
    );

    assert.ok(requests.includes("http://control.test/control/mcps"));
    assert.ok(requests.includes("http://control.test/control/mcp-runtime"));
    assert.match(markup, /data-mcp-inventory-status="observed"/u);
    assert.match(markup, /playwright/u);
    assert.match(markup, /data-mcp-usage-state="used"/u);
    assert.match(markup, /lsp/u);
    assert.match(markup, /data-mcp-usage-state="exposed-never-used"/u);
  } finally {
    restoreControl();
    restore();
  }
});

test("UsagePage renders explicit unavailable MCP inventory when Control API returns an error", async () => {
  const restore = withUsageConfig();
  const restoreControl = withControlApiConfig();
  try {
    globalThis.fetch = async (input) => {
      const url = String(input);
      if (url === "http://openlit.test/api/autodev/usage") {
        return Response.json(usageResponse);
      }
      if (
        url === "http://control.test/control/mcps" ||
        url === "http://control.test/control/mcp-runtime"
      ) {
        return new Response("unavailable", { status: 503 });
      }
      throw new Error(`Unexpected UsagePage request: ${url}`);
    };

    const markup = renderToStaticMarkup(
      await UsagePage({
        searchParams: Promise.resolve({ range: "7D" })
      })
    );

    assert.match(markup, /data-mcp-inventory-status="unavailable"/u);
    assert.match(markup, /MCP server inventory is unavailable/u);
    assert.doesNotMatch(markup, /No MCP servers are configured or observed/u);
  } finally {
    restoreControl();
    restore();
  }
});
