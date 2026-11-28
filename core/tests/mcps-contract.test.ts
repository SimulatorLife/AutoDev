import assert from "node:assert/strict";
import test from "node:test";

import {
  CHATGPT_TUNNEL_SCHEMA_ID,
  chatgptTunnelStatusSchema,
  CONTROL_API_MCP_APPLIED_SCHEMA_ID,
  CONTROL_API_MCP_RUNTIME_SCHEMA_ID,
  CONTROL_API_MCPS_SCHEMA_ID,
  CONTROL_API_MCPS_SOURCE,
  controlApiMcpAppliedResponseSchema,
  controlApiMcpRuntimeResponseSchema,
  controlApiMcpServerPatchRequestSchema,
  controlApiMcpsResponseSchema
} from "../src/control-api/mcps.ts";

const RECONCILIATION = {
  status: {
    convergence: "converged",
    desiredGeneration: "gen-1",
    observedGeneration: "gen-1",
    lastApplyAt: "2026-11-27T08:00:00Z",
    lastObservationAt: "2026-11-27T08:00:01Z",
    lastError: null,
    explanation: "Converged."
  },
  history: []
};

test("mcps, mcp-runtime, mcp-applied, and chatgpt-tunnel schemas enforce full contracts", () => {
  assert.equal(
    controlApiMcpsResponseSchema.safeParse({
      schema: CONTROL_API_MCPS_SCHEMA_ID,
      source: CONTROL_API_MCPS_SOURCE,
      revision: "a".repeat(64),
      readOnly: false,
      valid: true,
      issues: [],
      servers: [
        {
          name: "lsp",
          enabled: true,
          transport: "stdio",
          targetOverrides: [{ target: "codexcli", enabled: true }],
          declared: true,
          roles: ["coder"]
        }
      ],
      gateway: {
        label: "com.autodev.mcp-gateway",
        installed: true,
        ready: true,
        port: 4109,
        readinessUrl: "http://127.0.0.1:4109/readyz",
        generation: "gen-1",
        workspace: "autodev",
        role: "orchestrator",
        roles: ["orchestrator"],
        surfaces: [{ role: "orchestrator", url: "http://127.0.0.1:4109/mcp" }],
        reviewed: { lsp: ["goto_definition"] },
        grants: { lsp: ["goto_definition"] },
        error: null
      }
    }).success,
    true
  );

  assert.equal(
    controlApiMcpRuntimeResponseSchema.safeParse({
      schema: CONTROL_API_MCP_RUNTIME_SCHEMA_ID,
      source: "otel",
      observedServers: 1,
      health: { ready: 1, error: 0, stale: 0, configured: 0, observed: 0 },
      servers: [
        {
          name: "lsp",
          health: "ready",
          lastSeenAt: "2026-11-27T08:00:00Z",
          lastStatus: "ok",
          initAttempts: null,
          toolDiscoveryAttempts: null,
          failures: 0,
          toolCalls: 2,
          averageDurationMs: 12,
          roles: [
            {
              role: "coder",
              health: "ready",
              lastSeenAt: null,
              lastStatus: "ok"
            }
          ],
          tools: [{ name: "goto_definition", count: 2, errors: 0 }]
        }
      ]
    }).success,
    true
  );

  const serverLaunch = {
    name: "lsp",
    command: "node",
    args: ["server.js"],
    cwd: null,
    url: null,
    bearerTokenEnvVar: null,
    httpHeaderNames: []
  };
  assert.equal(
    controlApiMcpAppliedResponseSchema.safeParse({
      schema: CONTROL_API_MCP_APPLIED_SCHEMA_ID,
      source: "/home/.codex/config.toml",
      declarationSource: CONTROL_API_MCPS_SOURCE,
      target: "codexcli",
      available: true,
      declaredServers: [serverLaunch],
      servers: [serverLaunch],
      reconciliation: RECONCILIATION
    }).success,
    true
  );

  assert.equal(
    chatgptTunnelStatusSchema.safeParse({
      schema: CHATGPT_TUNNEL_SCHEMA_ID,
      revision: "a".repeat(64),
      configured: true,
      enabled: true,
      ready: false,
      roles: ["orchestrator"],
      tunnelId: "tun-1"
    }).success,
    true
  );
  assert.equal(
    chatgptTunnelStatusSchema.safeParse({
      schema: CHATGPT_TUNNEL_SCHEMA_ID,
      revision: "bad",
      configured: true,
      enabled: true,
      ready: false,
      roles: ["orchestrator"],
      tunnelId: null
    }).success,
    false
  );
  assert.equal(
    controlApiMcpServerPatchRequestSchema.safeParse({
      expectedRevision: "a".repeat(64),
      launch: { command: "node", args: ["server.js"], httpHeaders: null }
    }).success,
    true
  );
});
