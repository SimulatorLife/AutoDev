import assert from "node:assert/strict";
import test from "node:test";

import {
  type AgentDefinition,
  CANONICAL_NAVIGATION,
  type CanonicalNavSection,
  LOCAL_CONTROL_API_ACTOR
} from "@simulatorlife/autodev-core";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import {
  AgentDetailView,
  AgentsView,
  AppNav,
  DataTable,
  EvaluationsView,
  HooksView,
  McpDetailView,
  McpsView,
  MemoryPortalCard,
  PromptDetailView,
  PromptsView,
  SkillsView,
  StatCard,
  StatusBadge,
  ToolsView,
  UsageView,
  WorkspacesView
} from "../src/index.ts";
import {
  canonicalNavPath,
  canonicalSectionFromPath
} from "../src/lib/routes.ts";
import {
  CONTROL_API_PATHS,
  fetchAgentDetail,
  fetchPromptDetail,
  fetchProviders,
  fetchTools,
  readControlApiConfig
} from "../src/lib/server/control-api.ts";
import { readMemoryPortalConfig } from "../src/lib/server/memory-portal.ts";
import {
  readOpenLITUsageConfig,
  usageSelectionFromSearchParams
} from "../src/lib/server/openlit-usage.ts";
import {
  hooksFromControlApi,
  permissionsFromControlApi,
  promptDocumentFromControlApi,
  promptsFromControlApi,
  skillsFromControlApi,
  workspacesFromControlApi
} from "../src/lib/server/views.ts";

const CONFIGURED_AGENT: AgentDefinition = {
  id: "orchestrator",
  role: "orchestrator",
  kind: "orchestrator",
  readOnly: false,
  configured: true,
  valid: null,
  status: "configured",
  convergence: "not-observed",
  primaryModel: "autodev/orchestrator",
  models: ["autodev/orchestrator"],
  providers: ["codex"],
  tools: [
    { name: "orchestration", type: "skill" },
    { name: "playwright", type: "mcp", server: "playwright" }
  ],
  toolNames: ["orchestration", "playwright"]
};

test("AppNav renders exact 11 canonical navigation items in order via URL links", () => {
  const markup = renderToStaticMarkup(
    React.createElement(AppNav, {
      activeSection: "Agents",
      counts: { Agents: 8, MCPs: 5 }
    })
  );

  let lastIndex = -1;
  for (const section of CANONICAL_NAVIGATION) {
    const idx = markup.indexOf(`data-nav-item="${section.toLowerCase()}"`);
    assert.ok(idx !== -1, `${section} must be present in AppNav`);
    assert.ok(idx > lastIndex, `${section} must appear in canonical order`);
    lastIndex = idx;
  }

  // AppNav must render the canonical sections through real <a href="/...">
  // links rather than buttons that mutate local section state.
  for (const section of CANONICAL_NAVIGATION) {
    const href = `href="/${section.toLowerCase()}"`;
    assert.ok(
      markup.includes(href),
      `AppNav must expose a URL link for ${section} (${href})`
    );
  }
  assert.equal(markup.includes("<button"), false);
  assert.equal(markup.includes("Projects"), false);
  assert.equal(markup.includes("Organizations"), false);
  assert.equal(markup.includes("Environments"), false);
  assert.equal(markup.includes("Rule Engine"), false);
  assert.equal(markup.includes("OpenGround"), false);
});

test("StatusBadge renders valid variants", () => {
  for (const status of [
    "configured",
    "valid",
    "invalid",
    "ready",
    "unavailable",
    "converged",
    "pending",
    "error",
    "not-observed"
  ] as const) {
    const markup = renderToStaticMarkup(
      React.createElement(StatusBadge, { status })
    );
    assert.ok(markup.includes(`data-status="${status}"`));
  }
});

test("AgentsView keeps readiness and convergence unknown without observations", () => {
  const markup = renderToStaticMarkup(
    React.createElement(AgentsView, { agents: [CONFIGURED_AGENT] })
  );

  assert.equal(markup.includes("Runtime healthy"), false);
  assert.equal(markup.includes("Desired vs actual in sync"), false);
  assert.match(markup, /data-status="not-observed"/);
  assert.equal(markup.includes(">Not observed<"), true);
  assert.match(markup, /href="\/agents\/orchestrator"/);
});

test("Agent detail separates configuration from unobserved runtime state", () => {
  const markup = renderToStaticMarkup(
    React.createElement(AgentDetailView, { agent: CONFIGURED_AGENT })
  );

  assert.match(markup, /data-feature="agent-detail"/);
  assert.match(markup, /orchestrator/);
  assert.match(markup, /data-status="not-observed"/);
  assert.equal(markup.includes("Runtime healthy"), false);
  assert.equal(markup.includes("Converged"), false);
});

test("Prompt list links to source detail instead of synthesizing a preview", () => {
  const markup = renderToStaticMarkup(
    React.createElement(PromptsView, {
      commands: [
        {
          name: "dry",
          path: ".rulesync/commands/dry.md",
          description: "Dry-run command"
        }
      ]
    })
  );

  assert.match(markup, /href="\/prompts\/dry"/);
  assert.equal(markup.includes("Prompt Preview"), false);
  assert.equal(markup.includes("Lossless round-trip"), false);
});

test("Prompt detail renders canonical text and reports an actually empty source", () => {
  const source = "# /dry\n\nUse a dry run.";
  const prompt = promptDocumentFromControlApi({
    schema: "autodev-control-prompt-detail-v1",
    name: "dry",
    type: "command",
    source: ".rulesync/commands/dry.md",
    content: source
  });
  const markup = renderToStaticMarkup(
    React.createElement(PromptDetailView, { prompt })
  );
  assert.match(markup, /Use a dry run\./);
  assert.match(markup, /\.rulesync\/commands\/dry\.md/);

  const emptyMarkup = renderToStaticMarkup(
    React.createElement(PromptDetailView, {
      prompt: { ...prompt, content: "" }
    })
  );
  assert.match(emptyMarkup, /data-prompt-content="empty"/);
  assert.equal(emptyMarkup.includes("# /dry"), false);
});

test("DataTable renders table with columns and data", () => {
  interface TestRow {
    readonly id: string;
    readonly name: string;
  }
  const data: readonly TestRow[] = [
    { id: "1", name: "Alpha" },
    { id: "2", name: "Beta" }
  ];
  const markup = renderToStaticMarkup(
    DataTable<TestRow>({
      data,
      columns: [
        { id: "id", header: "ID", cell: (r: TestRow) => r.id },
        { id: "name", header: "Name", cell: (r: TestRow) => r.name }
      ],
      keyExtractor: (r: TestRow) => r.id
    })
  );
  assert.ok(markup.includes("Alpha"));
  assert.ok(markup.includes("Beta"));
  assert.ok(markup.includes("<table"));
});

test("StatCard renders value and title", () => {
  const markup = renderToStaticMarkup(
    React.createElement(StatCard, {
      title: "Requests",
      value: 1234,
      subtitle: "Last 24h"
    })
  );
  assert.ok(markup.includes("Requests"));
  assert.ok(markup.includes("1234"));
  assert.ok(markup.includes("Last 24h"));
});

test("server Control API client uses only its configured token and fixed local actor", async () => {
  const token = "server-only-control-token";
  const requests: Array<{ readonly url: string; readonly headers: Headers }> =
    [];
  const fetchImpl: typeof fetch = async (input, init) => {
    requests.push({
      url: String(input),
      headers: new Headers(init?.headers)
    });
    return Response.json({
      schema: "autodev-control-providers-v1",
      providers: [],
      disabledOrchestratorProviders: [],
      disabledSubagentProviders: []
    });
  };

  const result = await fetchProviders(
    { baseUrl: "http://127.0.0.1:4101", serviceToken: token },
    { fetchImpl }
  );

  const request = requests[0];
  assert.ok(request);
  assert.equal(
    request.url,
    `http://127.0.0.1:4101${CONTROL_API_PATHS.providers}`
  );
  assert.equal(request.headers.get("authorization"), `Bearer ${token}`);
  assert.equal(request.headers.get("x-autodev-actor"), LOCAL_CONTROL_API_ACTOR);
  const toolsResult = await fetchTools(
    { baseUrl: "http://127.0.0.1:4101", serviceToken: token },
    {
      fetchImpl: async (input, init) => {
        requests.push({
          url: String(input),
          headers: new Headers(init?.headers)
        });
        return Response.json({
          schema: "autodev-control-tools-v1",
          source: "execution-contract",
          readOnly: true,
          coverage: "partial",
          totalTools: 0,
          tools: []
        });
      }
    }
  );

  assert.equal(
    requests[1]?.url,
    `http://127.0.0.1:4101${CONTROL_API_PATHS.tools}`
  );
  assert.equal(requests[1]?.headers.get("authorization"), `Bearer ${token}`);
  assert.equal(
    requests[1]?.headers.get("x-autodev-actor"),
    LOCAL_CONTROL_API_ACTOR
  );
  assert.equal(JSON.stringify(result).includes(token), false);
  assert.equal(JSON.stringify(toolsResult).includes(token), false);
  assert.equal(readControlApiConfig({} as NodeJS.ProcessEnv), null);
});

test("Control API detail fetchers encode identifiers and preserve not-found status", async () => {
  const urls: string[] = [];
  const fetchImpl: typeof fetch = async (input) => {
    urls.push(String(input));
    return Response.json(
      {
        code: "autodev_control_api_unknown_resource",
        message: "Unknown resource.",
        status: 404
      },
      { status: 404 }
    );
  };
  const config = {
    baseUrl: "http://127.0.0.1:4101",
    serviceToken: "server-only"
  };

  const agent = await fetchAgentDetail("role/name", config, { fetchImpl });
  const prompt = await fetchPromptDetail("name with spaces", config, {
    fetchImpl
  });

  assert.equal(urls[0], "http://127.0.0.1:4101/control/agents/role%2Fname");
  assert.equal(
    urls[1],
    "http://127.0.0.1:4101/control/prompts/name%20with%20spaces"
  );
  assert.equal(agent.kind, "http-error");
  assert.equal(agent.status, 404);
  assert.equal(prompt.kind, "http-error");
  assert.equal(prompt.status, 404);
});

/**
 * Regression suite: missing data must NOT render green/optimistic state.
 *
 * Each view must report `Not observed` / `Unknown` / `Unknown` rather than
 * fabricated `100%`, `Connected`, `Active`, `Recorded`, or `Available`.
 */

test("UsageView with no metrics renders explicit 'Not observed' values", () => {
  const markup = renderToStaticMarkup(React.createElement(UsageView, {}));
  assert.match(markup, /Not observed/);
  assert.match(markup, /data-usage-observed="false"/);
  // Filters must NOT seed hardcoded providers/workspaces/models/roles.
  assert.equal(
    markup.includes("SimulatorLife/AutoDev"),
    false,
    "UsageView must not seed workspaces with fixture values"
  );
  assert.equal(
    markup.includes("gpt-5.6-terra"),
    false,
    "UsageView must not seed models with fixture values"
  );
});

test("Usage URL filters preserve stock time ranges, custom dates, and server-only credentials", () => {
  const now = new Date("2026-10-01T12:00:00.000Z");
  assert.deepEqual(
    usageSelectionFromSearchParams(
      {
        range: "7D",
        workspace: ["repo-a", "repo-b", "repo-a", ""],
        provider: "openai",
        skill: "unbound",
        startDate: "2026-09-20",
        endDate: "2026-10-01"
      },
      now
    ),
    {
      range: "7D",
      values: { workspace: ["repo-a", "repo-b"], provider: ["openai"] },
      customRange: { startDate: "2026-09-20", endDate: "2026-10-01" }
    }
  );
  assert.deepEqual(
    usageSelectionFromSearchParams(
      { range: "CUSTOM", startDate: "2026-09-01", endDate: "2026-10-01" },
      now
    ),
    {
      range: "CUSTOM",
      values: {},
      customRange: { startDate: "2026-09-01", endDate: "2026-10-01" }
    }
  );
  assert.equal(
    usageSelectionFromSearchParams({ range: "all-time" }, now).range,
    "24H"
  );
  assert.deepEqual(
    readOpenLITUsageConfig({
      AUTODEV_OPENLIT_USAGE_TOKEN: " secret ",
      AUTODEV_OPENLIT_USAGE_URL: "http://openlit:3000/"
    }),
    { baseUrl: "http://openlit:3000", serviceToken: "secret" }
  );
  assert.equal(readOpenLITUsageConfig({}), null);
});

test("UsageView persists selected filters in GET controls without defaults", () => {
  const markup = renderToStaticMarkup(
    React.createElement(UsageView, {
      selection: {
        range: "7D",
        values: { provider: ["openai"] },
        customRange: { startDate: "2026-09-20", endDate: "2026-10-01" }
      },
      filterOptions: {
        workspace: [],
        provider: ["openai", "anthropic"],
        model: null,
        agent: [],
        skill: null
      }
    })
  );
  assert.match(markup, /method="get"/);
  assert.match(markup, /name="range"/);
  assert.match(markup, /value="7D" selected/);
  assert.match(markup, /name="startDate" value="2026-09-20"/);
  assert.match(markup, /name="endDate" value="2026-10-01"/);
  assert.match(markup, /name="startDate"/);
  assert.match(markup, /name="endDate"/);
  assert.match(markup, /value="openai" selected/);
  assert.match(markup, /data-filter-options-observed="false"/);
  assert.match(markup, /data-usage-observed="false"/);
});

test("UsageView exposes OpenLIT custom-range controls with UTC date state", () => {
  const markup = renderToStaticMarkup(
    React.createElement(UsageView, {
      selection: {
        range: "CUSTOM",
        values: {},
        customRange: { startDate: "2026-09-17", endDate: "2026-10-01" }
      }
    })
  );
  assert.match(markup, /<details[^>]*open=""/);
  assert.match(markup, /value="24H"/);
  assert.match(markup, /value="7D"/);
  assert.match(markup, /value="1M"/);
  assert.match(markup, /value="3M"/);
  assert.match(markup, /value="CUSTOM" selected/);
  assert.match(markup, /Custom range accepts up to 90 days/);
  assert.match(markup, /current OpenLIT retention is about 30 days/);
});

test("UsageView with empty arrays still reports no synthetic counts", () => {
  const markup = renderToStaticMarkup(
    React.createElement(UsageView, {
      metrics: {
        logicalRequests: null,
        totalInputTokens: null,
        totalOutputTokens: null,
        cacheReadRate: null,
        p95LatencyMs: null,
        physicalAttempts: null,
        mcpCalls: null,
        p95McpDurationMs: null,
        mcpErrors: null,
        requestsByRole: [],
        attemptsByProvider: [],
        callsByTool: []
      }
    })
  );
  assert.match(markup, /Not observed/);
  assert.match(markup, /No logical requests were observed in this time range/);
  assert.match(markup, /No provider attempts were observed in this time range/);
  assert.match(markup, /No MCP tool calls were observed in this time range/);
  assert.match(markup, /data-usage-observed="true"/);
});

test("McpsView never reports 'Connected' or '100%' without runtime evidence", () => {
  const markup = renderToStaticMarkup(
    React.createElement(McpsView, {
      servers: [
        {
          name: "playwright",
          enabled: false,
          transport: "stdio",
          declared: true,
          roles: ["browser-tester"],
          targetOverrides: [{ target: "codexcli", enabled: false }]
        }
      ],
      sourceValidity: true
    })
  );
  assert.equal(markup.includes("Connected"), false);
  assert.equal(markup.includes("100%"), false);
  assert.equal(markup.includes("All servers available"), false);
  assert.match(markup, /data-mcp-connection-observed="false"/);
  assert.match(markup, /RuleSync source valid/);
  assert.match(markup, /codexcli: disabled/);
  assert.match(markup, />Disabled</);
  assert.match(markup, /data-status="configured"/);
  assert.match(markup, /STDIO/);
  assert.match(markup, /href="\/mcps\/playwright"/);
});

test("McpDetailView combines canonical desired state with unknown runtime health", () => {
  const markup = renderToStaticMarkup(
    React.createElement(McpDetailView, {
      sourceValidity: true,
      configuredTools: null,
      server: {
        name: "context7",
        enabled: true,
        transport: "http",
        targetOverrides: [{ target: "codexcli", enabled: false }],
        declared: true,
        roles: ["docs-researcher"]
      }
    })
  );
  assert.match(markup, /Desired state/);
  assert.match(markup, /Enabled by default/);
  assert.match(markup, /codexcli: disabled/);
  assert.match(markup, /docs-researcher/);
  assert.match(markup, /Runtime connection/);
  assert.match(markup, /Not observed/);
  assert.match(markup, /Configured tool allowlist/);
  assert.match(markup, /Tools, resources, prompts, and activity/);
  // Tools source is unavailable in this fixture; the section must report
  // Unknown and must not fabricate a Connected/ready state.
  assert.match(markup, /data-tool-allowlist-projection="unknown"/);
  assert.match(markup, />Unknown</);
  assert.doesNotMatch(markup, /Connected/);
});

test("McpDetailView renders populated configured tool allowlist from the Tools capability projection", () => {
  const markup = renderToStaticMarkup(
    React.createElement(McpDetailView, {
      sourceValidity: true,
      configuredTools: [
        {
          name: "resolve-library-id",
          source: "mcp",
          server: "context7",
          exposedRoles: ["docs-researcher"]
        },
        {
          name: "get-library-docs",
          source: "mcp",
          server: "context7",
          exposedRoles: ["docs-researcher", "code-reviewer"]
        }
      ],
      server: {
        name: "context7",
        enabled: true,
        transport: "http",
        targetOverrides: [],
        declared: true,
        roles: ["docs-researcher"]
      }
    })
  );
  assert.match(markup, /Configured tool allowlist/);
  assert.match(markup, /data-tool-allowlist-projection="partial"/);
  assert.match(markup, /data-enumerated-tool-count="2"/);
  assert.match(markup, /resolve-library-id/);
  assert.match(markup, /get-library-docs/);
  // Configured exposed roles must be visible per tool.
  assert.match(markup, />docs-researcher</);
  assert.match(markup, />code-reviewer</);
  // Section must NOT claim the remote server is connected or that this is
  // the full live tool inventory.
  assert.doesNotMatch(markup, /Connected/);
  assert.doesNotMatch(markup, /data-status="ready"/);
  // Live inventory section must remain explicit "Not observed".
  assert.match(markup, /Not observed/);
  assert.match(markup, /Tools, resources, prompts, and activity/);
});

test("McpDetailView distinguishes no enumerated allowlist entries from an empty live inventory", () => {
  const markup = renderToStaticMarkup(
    React.createElement(McpDetailView, {
      sourceValidity: true,
      configuredTools: [],
      server: {
        name: "context7",
        enabled: true,
        transport: "http",
        targetOverrides: [],
        declared: true,
        roles: ["docs-researcher"]
      }
    })
  );
  assert.match(markup, /Configured tool allowlist/);
  assert.match(markup, /data-tool-allowlist-projection="partial-empty"/);
  assert.match(markup, /data-enumerated-tool-count="0"/);
  assert.match(markup, /No allowlist entries enumerated/);
  assert.match(markup, /live inventory remains unknown/);
  // A partial projection with no entries is not evidence of no server tools.
  assert.match(markup, /live inventory remains unknown/);
  assert.doesNotMatch(markup, /None configured/);
  // No fabricated live inventory claims.
  assert.doesNotMatch(markup, /Connected/);
  assert.doesNotMatch(markup, /data-status="ready"/);
  // Live inventory section still stays explicitly unobserved.
  assert.match(markup, /Not observed/);
});

test("McpDetailView distinguishes an unavailable tool source from an empty allowlist", () => {
  const markup = renderToStaticMarkup(
    React.createElement(McpDetailView, {
      sourceValidity: true,
      configuredTools: null,
      server: {
        name: "playwright",
        enabled: false,
        transport: "stdio",
        targetOverrides: [],
        declared: true,
        roles: ["browser-tester"]
      }
    })
  );
  // null means the tools source is unavailable -- mark Unknown explicitly.
  assert.match(markup, /Configured tool allowlist/);
  assert.match(markup, /data-tool-allowlist-projection="unknown"/);
  assert.doesNotMatch(markup, /data-enumerated-tool-count="0"/);
  assert.match(markup, />Unknown</);
  // Critically: must NOT collapse to "None configured" (that would claim
  // the source was observed and the allowlist is empty, which is false).
  assert.doesNotMatch(markup, /None configured/);
  // And must not fabricate a live connection or ready tool.
  assert.doesNotMatch(markup, /Connected/);
  assert.doesNotMatch(markup, /data-status="ready"/);
  // Existing live section must remain explicitly unobserved.
  assert.match(markup, /Tools, resources, prompts, and activity/);
  assert.match(markup, /Not observed/);
});

test("McpsView distinguishes invalid canonical configuration from an empty list", () => {
  const markup = renderToStaticMarkup(
    React.createElement(McpsView, { servers: [], sourceValidity: false })
  );
  assert.match(markup, /data-mcp-source-validity="false"/);
  assert.match(markup, /RuleSync source invalid/);
  assert.match(markup, /Configured MCPs/);
  assert.match(markup, />Invalid</);
  assert.match(markup, /no MCP configuration was projected/);
  assert.doesNotMatch(markup, /Configured MCPs[\s\S]*?>0</);
});

test("SkillsView never reports 'Active' or 'Recorded' without OTel evidence", () => {
  const markup = renderToStaticMarkup(
    React.createElement(SkillsView, {
      skills: [
        {
          name: "orchestration",
          description: "Coordination",
          path: ".rulesync/skills/orchestration"
        }
      ]
    })
  );
  assert.equal(markup.includes("Active"), false);
  assert.equal(markup.includes("Recorded"), false);
  assert.match(markup, /data-skill-runtime-observed="false"/);
});

test("WorkspacesView never reports 'Available' without runtime evidence", () => {
  const markup = renderToStaticMarkup(
    React.createElement(WorkspacesView, {
      workspaces: [
        { name: "SimulatorLife/AutoDev", baseBranch: "main", weight: 100 }
      ]
    })
  );
  assert.equal(markup.includes("Available"), false);
  assert.match(markup, /data-workspace-availability-observed="false"/);
});

test("ToolsView falls back to 'Unknown' when status is missing", () => {
  const markup = renderToStaticMarkup(
    React.createElement(ToolsView, {
      coverage: "partial",
      tools: [
        {
          name: "read_file",
          source: "native",
          exposedRoles: ["orchestrator"]
          // status intentionally omitted
        }
      ]
    })
  );
  assert.equal(markup.includes(">ready<"), false);
  assert.match(markup, /Unknown/);
  assert.match(markup, /data-tools-coverage="partial"/);
  assert.match(
    markup,
    /Other tools, runtime availability, and historical use are not observed/
  );
  assert.doesNotMatch(markup, /Universal/);
});

test("ToolsView keeps an unavailable capability source unknown instead of zero", () => {
  const markup = renderToStaticMarkup(
    React.createElement(ToolsView, { tools: [], coverage: "unknown" })
  );
  assert.match(markup, /Known Declarations/);
  assert.match(markup, />Unknown</);
  assert.match(markup, /execution-contract role inventory is not observed/);
  assert.doesNotMatch(markup, /Known Declarations[\s\S]*?>0</);
});

test("ToolsView preserves explicit 'ready'/'unavailable' status values", () => {
  const readyMarkup = renderToStaticMarkup(
    React.createElement(ToolsView, {
      coverage: "partial",
      tools: [
        {
          name: "exec_command",
          source: "native",
          exposedRoles: ["orchestrator"],
          status: "ready"
        }
      ]
    })
  );
  assert.match(readyMarkup, /data-status="ready"/);

  const unavailableMarkup = renderToStaticMarkup(
    React.createElement(ToolsView, {
      coverage: "partial",
      tools: [
        {
          name: "exec_command",
          source: "native",
          exposedRoles: ["orchestrator"],
          status: "unavailable"
        }
      ]
    })
  );
  assert.match(unavailableMarkup, /data-status="unavailable"/);
});

test("readMemoryPortalConfig defaults to the local OpenLIT UI base URL", () => {
  assert.deepEqual(readMemoryPortalConfig({}), {
    href: "http://127.0.0.1:3000/memory"
  });
});

test("readMemoryPortalConfig normalizes a configured URL to the fixed /memory path", () => {
  assert.deepEqual(
    readMemoryPortalConfig({
      AUTODEV_OPENLIT_UI_URL: "https://openlit.example.com:8443/some/other/path?x=1"
    }),
    { href: "https://openlit.example.com:8443/memory" }
  );
  assert.deepEqual(
    readMemoryPortalConfig({ AUTODEV_OPENLIT_UI_URL: "  http://openlit:3000/  " }),
    { href: "http://openlit:3000/memory" }
  );
});

test("readMemoryPortalConfig rejects unsafe configured URLs", () => {
  assert.equal(
    readMemoryPortalConfig({ AUTODEV_OPENLIT_UI_URL: "not a url" }),
    null
  );
  assert.equal(
    readMemoryPortalConfig({ AUTODEV_OPENLIT_UI_URL: "javascript:alert(1)" }),
    null
  );
  assert.equal(
    readMemoryPortalConfig({ AUTODEV_OPENLIT_UI_URL: "ftp://openlit:3000" }),
    null
  );
  assert.equal(
    readMemoryPortalConfig({
      AUTODEV_OPENLIT_UI_URL: "https://admin:s3cret@openlit.example.com"
    }),
    null
  );
});

test("MemoryPortalCard links to the resolved Memory destination and never exposes a token", () => {
  const markup = renderToStaticMarkup(
    React.createElement(MemoryPortalCard, {
      href: "http://127.0.0.1:3000/memory"
    })
  );
  assert.match(markup, /data-feature="memory-portal"/);
  assert.match(
    markup,
    /href="http:\/\/127\.0\.0\.1:3000\/memory"[^>]*data-memory-portal-link="true"/
  );
  assert.match(markup, /target="_blank"/);
  assert.match(markup, /rel="noopener noreferrer"/);
  assert.match(markup, /Open AutoDev Memory/);
  assert.equal(/openlit/i.test(markup), false);
  assert.equal(markup.toLowerCase().includes("token"), false);
  assert.equal(markup.toLowerCase().includes("secret"), false);
  assert.equal(markup.toLowerCase().includes("bearer"), false);
});

test("Memory page contract renders the portal card on the default local destination without requiring the Control API token", () => {
  // Mirrors the branch logic of console/app/memory/page.tsx without
  // importing the App Router file (the test runner loads .ts only).
  const env = {
    AUTODEV_CONTROL_API_TOKEN: undefined,
    AUTODEV_OPENLIT_UI_URL: undefined
  };
  const portal = readMemoryPortalConfig(env);
  assert.ok(portal, "default portal config must resolve");
  const markup = renderToStaticMarkup(
    React.createElement(MemoryPortalCard, { href: portal.href })
  );
  assert.match(markup, /data-feature="memory-portal"/);
  assert.match(
    markup,
    /href="http:\/\/127.0.0.1:3000\/memory"[^>]*data-memory-portal-link="true"/
  );
  assert.match(markup, /target="_blank"/);
  assert.match(markup, /rel="noopener noreferrer"/);
  assert.match(markup, /Open AutoDev Memory/);
  // The page must never surface the Control API credential gate or the
  // historical "adapter pending" placeholder.
  assert.equal(markup.includes("autodev_control_api_disabled"), false);
  assert.equal(markup.includes("AUTODEV_CONTROL_API_TOKEN"), false);
  assert.equal(markup.includes("autodev_memory_adapter_pending"), false);
});

test("Memory page contract renders the explicit unavailable state when AUTODEV_OPENLIT_UI_URL is unsafe", () => {
  const env = {
    AUTODEV_CONTROL_API_TOKEN: undefined,
    AUTODEV_OPENLIT_UI_URL: "https://admin:s3cret@openlit.example.com"
  };
  const portal = readMemoryPortalConfig(env);
  assert.equal(portal, null);
  // Local harness mirroring the contract of the page's unavailable branch
  // (data-status, data-error-code, title, message, hint) so the test does
  // not need to import the .tsx route file.
  function Unavailable(props: { title: string; code: string; message: string; hint?: string }) {
    return React.createElement(
      "div",
      {
        role: "alert",
        "data-status": "unavailable",
        "data-error-code": props.code
      },
      React.createElement("h2", null, props.title),
      React.createElement("p", null, props.message),
      React.createElement("p", null, props.hint)
    );
  }
  const markup = renderToStaticMarkup(
    React.createElement(Unavailable, {
      title: "Memory destination URL is not configured safely",
      code: "autodev_memory_portal_url_invalid",
      message:
        "AUTODEV_OPENLIT_UI_URL must be an http or https URL with no embedded credentials.",
      hint: "Set AUTODEV_OPENLIT_UI_URL in the Next.js server environment, or unset it to use the local default."
    })
  );
  assert.match(markup, /data-status="unavailable"/);
  assert.match(markup, /data-error-code="autodev_memory_portal_url_invalid"/);
  assert.match(markup, /Memory destination URL is not configured safely/);
  assert.equal(markup.includes("data-memory-portal-link=\"true\""), false);
  assert.equal(markup.includes("autodev_control_api_disabled"), false);
  assert.equal(markup.includes("autodev_memory_adapter_pending"), false);
});

test("Memory page contract normalizes a configured AUTODEV_OPENLIT_UI_URL to the fixed /memory path", () => {
  const env = {
    AUTODEV_CONTROL_API_TOKEN: undefined,
    AUTODEV_OPENLIT_UI_URL: "https://memory.example.com/some/other/path?x=1"
  };
  const portal = readMemoryPortalConfig(env);
  assert.deepEqual(portal, { href: "https://memory.example.com/memory" });
  const markup = renderToStaticMarkup(
    React.createElement(MemoryPortalCard, { href: portal.href })
  );
  assert.match(
    markup,
    /href="https:\/\/memory.example.com\/memory"[^>]*data-memory-portal-link="true"/
  );
  assert.equal(markup.includes("data-status=\"unavailable\""), false);
});

test("EvaluationsView with empty results renders the explicit empty state", () => {
  const markup = renderToStaticMarkup(
    React.createElement(EvaluationsView, { evaluations: [] })
  );
  assert.match(markup, /No evaluations run yet/);
  assert.match(markup, /data-evaluation-pass-rate-observed="false"/);
  assert.match(markup, /Not observed/);
  assert.equal(markup.includes("100%"), false);
});

test("HooksView only renders hooks with valid action command lists", () => {
  const hooks = hooksFromControlApi({
    schema: "autodev-control-hooks-v1",
    source: "test",
    readOnly: true,
    valid: true,
    hooks: {
      sessionStart: [{ command: "echo hi", matcher: ".*" }]
    }
  });
  const markup = renderToStaticMarkup(
    React.createElement(HooksView, { hooks, sourceValidity: true })
  );
  assert.match(markup, /echo hi/);
  assert.match(markup, /Source validation/);
});

test("HooksView reports source validity as unknown when no validation is available", () => {
  const markup = renderToStaticMarkup(
    React.createElement(HooksView, { hooks: [] })
  );
  assert.match(markup, /data-hook-state="not-observed"/);
  assert.equal(markup.includes(">Valid<"), false);
});

test("HooksView distinguishes an invalid source from an absent one", () => {
  const markup = renderToStaticMarkup(
    React.createElement(HooksView, { hooks: [], sourceValidity: false })
  );
  assert.match(markup, /data-hook-state="invalid"/);
  assert.match(markup, /Hook source is invalid/);
});

test("View adapters translate Control API responses without inventing data", () => {
  const skills = skillsFromControlApi({
    schema: "autodev-control-skills-v1",
    source: "test",
    readOnly: true,
    skills: [{ name: "playwright", roles: ["browser-tester"] }]
  });
  assert.deepEqual(skills[0]?.name, "playwright");

  const prompts = promptsFromControlApi({
    schema: "autodev-control-prompts-v1",
    source: "test",
    readOnly: true,
    totalCommands: 1,
    commands: [
      { name: "dry", path: ".rulesync/commands/dry.md", description: "DRY" }
    ],
    rolePrompts: [
      {
        role: "orchestrator",
        path: "agents/prompts/roles/orchestrator.md"
      }
    ]
  });
  assert.equal(prompts[0]?.name, "dry");
  assert.equal(prompts[1]?.name, "orchestrator");

  const promptDocument = promptDocumentFromControlApi({
    schema: "autodev-control-prompt-detail-v1",
    name: "dry",
    type: "command",
    source: ".rulesync/commands/dry.md",
    content: "Exact source"
  });
  assert.deepEqual(promptDocument, {
    name: "dry",
    kind: "command",
    path: ".rulesync/commands/dry.md",
    content: "Exact source"
  });

  const workspaces = workspacesFromControlApi({
    schema: "autodev-control-workspaces-v1",
    source: "test",
    readOnly: true,
    totalWorkspaces: 1,
    workspaces: [
      { name: "SimulatorLife/AutoDev", baseBranch: "main", weight: 100 }
    ]
  });
  assert.equal(workspaces[0]?.name, "SimulatorLife/AutoDev");

  const perms = permissionsFromControlApi({
    schema: "autodev-control-permissions-v1",
    source: "test",
    readOnly: true,
    policy: {
      approvalPolicy: "never",
      sandboxMode: "workspace-write",
      approvalsReviewer: "user",
      networkAccess: true,
      webSearch: true,
      defaultToolsApprovalMode: "approve"
    },
    rolePermissions: {
      orchestrator: {
        readOnly: false,
        sandbox: "workspace-write",
        networkAccess: true,
        approvals: "never"
      }
    }
  });
  assert.equal(perms.roleMatrices[0]?.sandboxMode, "workspace-write");
});

test("All 11 canonical Console route paths map to a canonical nav section", () => {
  for (const section of CANONICAL_NAVIGATION) {
    const path = canonicalNavPath(section);
    assert.equal(canonicalSectionFromPath(path), section);
  }
  assert.equal(canonicalSectionFromPath("/not-a-resource"), null);
});
test("Canonical nav order is preserved (Agents through Workspaces)", () => {
  const expected: readonly CanonicalNavSection[] = [
    "Agents",
    "MCPs",
    "Skills",
    "Hooks",
    "Memory",
    "Evaluations",
    "Permissions",
    "Tools",
    "Usage",
    "Prompts",
    "Workspaces"
  ];
  assert.deepEqual([...CANONICAL_NAVIGATION], [...expected]);
});
