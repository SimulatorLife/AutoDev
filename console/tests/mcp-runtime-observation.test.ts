import assert from "node:assert/strict";
import test from "node:test";

import type { ControlApiMcpRuntimeResponse } from "@simulatorlife/autodev-core";

import { fetchMcpRuntime } from "../src/lib/server/control-api.ts";

/**
 * The MCP runtime observation, exactly as the Runtime publishes it.
 *
 * The Runtime does not observe the MCP client's own initialization, so it
 * publishes `null` for the two attempt counts rather than a zero: a zero
 * would claim the server was never brought up, which is a claim about a read
 * that never happens. The shared contract says so, and this fixture is typed
 * by that contract so the two cannot drift apart again.
 *
 * They had drifted. The Console's reader required a number for both fields,
 * so it rejected the Runtime's own payload, which failed the whole response,
 * and every MCP server on the page read "Not observed" while the Runtime held
 * an observation of six of them.
 */
const RUNTIME_PUBLISHED: ControlApiMcpRuntimeResponse = {
  schema: "autodev-control-mcp-runtime-v1",
  source: "runtime.telemetry",
  observedServers: 1,
  health: { ready: 0, error: 0, stale: 1, configured: 0, observed: 0 },
  servers: [
    {
      name: "autodev_spawn",
      health: "stale",
      lastSeenAt: "2026-11-03T19:02:21.397Z",
      lastStatus: "configured",
      initAttempts: null,
      toolDiscoveryAttempts: null,
      failures: 0,
      toolCalls: 0,
      averageDurationMs: 0,
      roles: [
        {
          role: "orchestrator",
          health: "stale",
          lastSeenAt: "2026-11-03T19:02:21.397Z",
          lastStatus: "configured"
        }
      ],
      tools: []
    }
  ]
};

test("the Console reads the MCP runtime observation the Runtime actually publishes", async () => {
  const config = { baseUrl: "http://127.0.0.1:4101", serviceToken: "t" };
  const result = await fetchMcpRuntime(config, {
    fetchImpl: async () => Response.json(RUNTIME_PUBLISHED)
  });
  assert.equal(
    result.kind,
    "ok",
    "the Runtime's own payload must be readable, or every MCP server reads 'Not observed'"
  );
});

test("the Console still refuses an MCP runtime observation it cannot read", async () => {
  const config = { baseUrl: "http://127.0.0.1:4101", serviceToken: "t" };
  const serve = (body: unknown) => ({
    fetchImpl: async () => Response.json(body)
  });
  const server = RUNTIME_PUBLISHED.servers[0]!;
  for (const broken of [
    { ...RUNTIME_PUBLISHED, schema: "autodev-control-mcp-runtime-v0" },
    { ...RUNTIME_PUBLISHED, observedServers: "1" },
    { ...RUNTIME_PUBLISHED, health: { ...RUNTIME_PUBLISHED.health, ready: "1" } },
    { ...RUNTIME_PUBLISHED, servers: {} },
    // A verdict outside the Runtime's vocabulary is not a readiness claim, so
    // it must not be rendered as one.
    { ...RUNTIME_PUBLISHED, servers: [{ ...server, health: "healthy" }] },
    { ...RUNTIME_PUBLISHED, servers: [{ ...server, lastSeenAt: 17 }] },
    { ...RUNTIME_PUBLISHED, servers: [{ ...server, toolCalls: "4" }] },
    // A count is a number or the Runtime's own "not observed"; a string is
    // neither.
    { ...RUNTIME_PUBLISHED, servers: [{ ...server, initAttempts: "1" }] },
    {
      ...RUNTIME_PUBLISHED,
      servers: [{ ...server, toolDiscoveryAttempts: "1" }]
    },
    { ...RUNTIME_PUBLISHED, servers: [{ ...server, tools: [{ name: "x" }] }] },
    { ...RUNTIME_PUBLISHED, servers: [{ ...server, roles: [{ role: "x" }] }] }
  ]) {
    assert.equal(
      (await fetchMcpRuntime(config, serve(broken))).kind,
      "invalid-response",
      JSON.stringify(broken)
    );
  }
});
