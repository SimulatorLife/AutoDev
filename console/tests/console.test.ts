import assert from "node:assert/strict";
import test from "node:test";

import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import {
  CANONICAL_NAVIGATION,
  type CanonicalNavSection
} from "../../core/src/index.ts";
import {
  AppNav,
  ConsoleApp,
  type ConsoleAppData,
  ControlApiClient,
  DataTable,
  StatCard,
  StatusBadge
} from "../src/index.ts";

test("AppNav renders exact 11 canonical navigation items in order", () => {
  let _selected: CanonicalNavSection | null = null;
  const markup = renderToStaticMarkup(
    React.createElement(AppNav, {
      activeSection: "Agents",
      onSelectSection: (s) => {
        _selected = s;
      },
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
    "error"
  ] as const) {
    const markup = renderToStaticMarkup(
      React.createElement(StatusBadge, { status })
    );
    assert.ok(markup.includes(`data-status="${status}"`));
  }
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

test("ConsoleApp renders feature view without crashing", () => {
  const dummyData: ConsoleAppData = {
    agents: [
      {
        id: "orchestrator",
        role: "orchestrator",
        kind: "orchestrator",
        readOnly: false,
        configured: true,
        valid: true,
        status: "ready",
        convergence: "converged",
        primaryModel: "autodev/orchestrator",
        models: ["gpt-5.6-terra"],
        providers: ["codex"],
        tools: [],
        toolNames: []
      }
    ],
    mcps: [{ server: "playwright", roles: ["browser-tester"] }],
    skills: [{ name: "orchestration", description: "Coordination", path: ".rulesync/skills/orchestration" }],
    hooks: [{ event: "sessionStart", actions: [{ type: "command", command: "echo start" }] }],
    permissions: {
      policy: {
        approvalPolicy: "never",
        sandboxMode: "workspace-write",
        networkAccess: true,
        webSearch: true,
        approvalsReviewer: "user",
        defaultToolsApprovalMode: "approve"
      },
      roleMatrices: [
        {
          role: "orchestrator",
          readOnly: false,
          sandboxMode: "workspace-write",
          allowedMcpServers: ["playwright"],
          allowedSkills: ["orchestration"]
        }
      ]
    },
    tools: [
      {
        name: "read_file",
        source: "native",
        exposedRoles: ["orchestrator"]
      }
    ],
    prompts: [
      {
        name: "dry",
        path: ".rulesync/commands/dry.md",
        description: "Don't repeat yourself"
      }
    ],
    workspaces: [
      {
        name: "SimulatorLife/AutoDev",
        baseBranch: "main",
        weight: 100
      }
    ]
  };

  const markup = renderToStaticMarkup(
    React.createElement(ConsoleApp, {
      initialSection: "Agents",
      data: dummyData
    })
  );
  assert.ok(markup.includes("AutoDev Console"));
  assert.ok(markup.includes("Configured Agents"));
  assert.ok(markup.includes("orchestrator"));
});

test("ControlApiClient constructs expected URLs and methods", async () => {
  const calls: Array<{ url: string; method: string; body?: string | undefined }> = [];
  const mockFetch = (
    url: string | URL | Request,
    init?: RequestInit
  ): Promise<Response> => {
    calls.push({
      url: String(url),
      method: init?.method ?? "GET",
      body: typeof init?.body === "string" ? init.body : undefined
    });
    return Promise.resolve(
      Response.json(
        { ok: true },
        {
          status: 200,
          headers: { "Content-Type": "application/json" }
        }
      )
    );
  };

  const client = new ControlApiClient({
    baseUrl: "http://127.0.0.1:4101",
    fetchImpl: mockFetch as unknown as typeof fetch
  });

  await client.getAgents();
  await client.getProviders();
  await client.getModels();
  await client.getMcps();
  await client.getSkills();
  await client.getHooks();
  await client.getPermissions();
  await client.getPrompts();
  await client.getWorkspaces();
  await client.getRouting();
  await client.getRuntime();
  await client.patchProviderRole("claude", "subagent", true);

  assert.equal(calls.length, 12);
  assert.equal(calls[0]?.url, "http://127.0.0.1:4101/control/agents");
  assert.equal(calls[1]?.url, "http://127.0.0.1:4101/control/providers");
  assert.equal(calls[2]?.url, "http://127.0.0.1:4101/control/models");
  assert.equal(calls[3]?.url, "http://127.0.0.1:4101/control/mcps");
  assert.equal(calls[4]?.url, "http://127.0.0.1:4101/control/skills");
  assert.equal(calls[5]?.url, "http://127.0.0.1:4101/control/hooks");
  assert.equal(calls[6]?.url, "http://127.0.0.1:4101/control/permissions");
  assert.equal(calls[7]?.url, "http://127.0.0.1:4101/control/prompts");
  assert.equal(calls[8]?.url, "http://127.0.0.1:4101/control/workspaces");
  assert.equal(calls[9]?.url, "http://127.0.0.1:4101/control/routing");
  assert.equal(calls[10]?.url, "http://127.0.0.1:4101/control/runtime");
  assert.equal(
    calls[11]?.url,
    "http://127.0.0.1:4101/control/providers/claude/roles/subagent"
  );
  assert.equal(calls[11]?.method, "PATCH");
  assert.equal(calls[11]?.body, JSON.stringify({ enabled: true }));
});
