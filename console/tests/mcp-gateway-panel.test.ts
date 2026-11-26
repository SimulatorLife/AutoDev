import assert from "node:assert/strict";
import test from "node:test";

import type {
  ControlApiMcpGateway,
  ControlApiMcpsResponse
} from "@simulatorlife/autodev-core";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { McpGatewayPanel } from "../src/features/mcps/McpGatewayPanel.ts";
import { fetchMcps } from "../src/lib/server/control-api.ts";

// The gateway exactly as the Runtime publishes it on the MCP catalog.
const GATEWAY: ControlApiMcpGateway = {
  label: "com.codex.autodev-mcp-gateway",
  installed: true,
  ready: true,
  port: 3312,
  readinessUrl: "http://127.0.0.1:3312/readyz",
  generation: "generation-abc",
  workspace: "/Users/operator/Projects/example",
  role: "orchestrator",
  roles: ["orchestrator", "reviewer"],
  surfaces: [
    { role: "orchestrator", url: "http://127.0.0.1:3312/orchestrator/mcp" },
    { role: "reviewer", url: "http://127.0.0.1:3312/reviewer/mcp" }
  ],
  reviewed: { lsp: ["lsp_hover", "lsp_goto_definition"], memory: ["read"] },
  grants: { lsp: ["lsp_hover"], memory: ["read"] },
  error: null
};

const CATALOG: ControlApiMcpsResponse = {
  schema: "autodev-control-mcps-v3",
  source: ".rulesync/mcp.jsonc",
  revision: "b".repeat(64),
  readOnly: false,
  valid: true,
  issues: [],
  servers: [],
  gateway: GATEWAY
};

const render = (gateway: ControlApiMcpGateway | null): string =>
  renderToStaticMarkup(React.createElement(McpGatewayPanel, { gateway }));

test("the gateway panel reports readiness, published surfaces and effective grants", () => {
  const html = render(GATEWAY);
  assert.match(html, /data-mcp-gateway-status="Ready"/u);
  assert.match(html, /com\.codex\.autodev-mcp-gateway/u);
  assert.match(html, /http:\/\/127\.0\.0\.1:3312\/readyz/u);
  assert.match(html, /reviewer → http:\/\/127\.0\.0\.1:3312\/reviewer\/mcp/u);
  assert.match(html, /data-mcp-gateway-grant="lsp"/u);
  assert.match(html, /Narrowed from 2 reviewed/u);
  // The memory grant was not narrowed, so it carries no narrowing note.
  assert.equal(html.match(/Narrowed from/gu)?.length, 1);
});

test("the gateway panel is a read-only view with no mutation control", () => {
  const html = render(GATEWAY);
  for (const element of ["<form", "<input", "<select", "<button", "<textarea"])
    assert.equal(html.includes(element), false, `unexpected ${element}`);
});

test("the gateway panel keeps not installed, not ready, unreadable and unobserved apart", () => {
  assert.match(
    render({ ...GATEWAY, installed: false, ready: false, surfaces: [] }),
    /data-mcp-gateway-status="Not installed"[\s\S]*No surface is published until the gateway is installed/u
  );
  assert.match(
    render({ ...GATEWAY, ready: false }),
    /data-mcp-gateway-status="Installed, not ready"/u
  );
  const unreadable = render({
    ...GATEWAY,
    installed: false,
    ready: false,
    error: "The MCP gateway state could not be read."
  });
  assert.match(unreadable, /data-mcp-gateway-status="Unreadable"/u);
  assert.match(
    unreadable,
    /role="alert"[^>]*>The MCP gateway state could not be read\./u
  );
  assert.match(render(null), /data-mcp-gateway-status="Not observed"/u);
});

test("an MCP catalog whose gateway the panel cannot read fails closed", async () => {
  const config = { baseUrl: "http://127.0.0.1:4101", serviceToken: "t" };
  const serve = (body: unknown) => ({
    fetchImpl: async () => Response.json(body)
  });
  assert.equal((await fetchMcps(config, serve(CATALOG))).kind, "ok");
  for (const broken of [
    { ...CATALOG, gateway: undefined },
    { ...CATALOG, gateway: { ...GATEWAY, ready: "yes" } },
    {
      ...CATALOG,
      gateway: { ...GATEWAY, surfaces: [{ role: "orchestrator" }] }
    },
    { ...CATALOG, gateway: { ...GATEWAY, grants: { lsp: "lsp_hover" } } },
    { ...CATALOG, schema: "autodev-control-mcps-v2" }
  ]) {
    assert.equal(
      (await fetchMcps(config, serve(broken))).kind,
      "invalid-response"
    );
  }
});
