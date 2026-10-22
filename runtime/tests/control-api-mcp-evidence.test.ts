import assert from "node:assert/strict";
import type { IncomingMessage } from "node:http";
import { Readable } from "node:stream";
import test from "node:test";

import type { ControlApiMcpRuntimeServer } from "@simulatorlife/autodev-core";

import {
  handleControlApiRequest,
  setControlApiMcpObservationsSource
} from "../src/control-api/index.ts";
import {
  getDefaultOtelTracker,
  mcpServerObservations,
  resetOtelTelemetry
} from "../src/router/otel.ts";
import { responseRecorder } from "./support/control-api-harness.ts";

const SERVICE_TOKEN = "m".repeat(64);
const OPERATOR_ACTOR = "mcp-evidence-operator";
const OBSERVED_SERVER = "lsp";

interface McpCatalogRecord {
  readonly name: string;
  readonly enabled: boolean | null;
  readonly transport: string;
  readonly declared: boolean;
  readonly roles: readonly string[];
}

type Call = (
  method: string,
  pathname: string
) => Promise<{ status: number; body: Record<string, unknown> | null }>;

function request(method: string, url: string): IncomingMessage {
  return Object.assign(Readable.from([]), {
    method,
    url,
    headers: {
      host: "127.0.0.1",
      authorization: `Bearer ${SERVICE_TOKEN}`,
      "x-autodev-actor": OPERATOR_ACTOR
    }
  }) as unknown as IncomingMessage;
}

function harness(): {
  readonly restore: () => void;
  readonly call: Call;
} {
  const previousToken = process.env.AUTODEV_CONTROL_API_TOKEN;
  const previousOperators = process.env.AUTODEV_CONTROL_OPERATORS;
  process.env.AUTODEV_CONTROL_API_TOKEN = SERVICE_TOKEN;
  process.env.AUTODEV_CONTROL_OPERATORS = OPERATOR_ACTOR;

  return {
    restore: () => {
      if (previousToken === undefined)
        delete process.env.AUTODEV_CONTROL_API_TOKEN;
      else process.env.AUTODEV_CONTROL_API_TOKEN = previousToken;
      if (previousOperators === undefined)
        delete process.env.AUTODEV_CONTROL_OPERATORS;
      else process.env.AUTODEV_CONTROL_OPERATORS = previousOperators;
    },
    call: async (method, pathname) => {
      const response = responseRecorder();
      await handleControlApiRequest(
        request(method, pathname),
        response,
        pathname
      );
      let parsed: Record<string, unknown> | null = null;
      if (response.body) {
        try {
          parsed = JSON.parse(response.body) as Record<string, unknown>;
        } catch {
          parsed = null;
        }
      }
      return { status: response.statusCode, body: parsed };
    }
  };
}

async function readCatalog(call: Call): Promise<readonly McpCatalogRecord[]> {
  const read = await call("GET", "/control/mcps");
  const servers = read.body?.servers as McpCatalogRecord[] | undefined;
  assert.ok(servers, "the MCP catalog must carry its servers");
  return servers;
}

/**
 * Records the Runtime's observation of a server and of a tool call on it.
 *
 * The initialization span and the tool-discovery span are separate: the second
 * is the one that carries the readiness signal, so a server that was only
 * initialized is not reported as ready.
 */
function observeServer(serverName: string): void {
  const tracker = getDefaultOtelTracker();
  const observedAtNanos = BigInt(Date.now()) * 1_000_000n;
  tracker.noteMcpServer(
    serverName,
    {
      name: "make_rmcp_client",
      startTimeUnixNano: (observedAtNanos - 1_000_000_000n).toString(),
      endTimeUnixNano: observedAtNanos.toString(),
      status: { code: 1 }
    },
    {
      server_name: serverName,
      workspace: "SimulatorLife/AutoDev",
      role: "orchestrator",
      model: "gpt-5"
    }
  );
  tracker.noteMcpServer(
    serverName,
    {
      name: "list_tools_for_client_uncached",
      startTimeUnixNano: (observedAtNanos - 500_000_000n).toString(),
      endTimeUnixNano: observedAtNanos.toString(),
      status: { code: 1 }
    },
    {
      server_name: serverName,
      workspace: "SimulatorLife/AutoDev",
      role: "orchestrator",
      model: "gpt-5"
    }
  );
  tracker.noteToolCounter(
    "codex.tool.call",
    {
      tool_name: "lsp_goto_definition",
      source: "codex",
      server: serverName,
      status: "success",
      workspace: "SimulatorLife/AutoDev",
      role: "orchestrator",
      model: "gpt-5"
    },
    {
      startTimeUnixNano: "1000000000",
      timeUnixNano: "2000000000",
      asInt: 3
    },
    "CUMULATIVE"
  );
}

const OBSERVATION: ControlApiMcpRuntimeServer = {
  name: OBSERVED_SERVER,
  health: "ready",
  lastSeenAt: "2026-10-22T12:00:00.000Z",
  lastStatus: "ready",
  initAttempts: 2,
  toolDiscoveryAttempts: 1,
  failures: 0,
  toolCalls: 6,
  averageDurationMs: 128,
  roles: [
    {
      role: "orchestrator",
      health: "ready",
      lastSeenAt: "2026-10-22T12:00:00.000Z",
      lastStatus: "ready"
    }
  ],
  tools: [{ name: "lsp_goto_definition", count: 6, errors: 0 }]
};

test("the MCP catalog stays a configuration read and carries no runtime evidence", async () => {
  resetOtelTelemetry();
  const h = harness();
  try {
    const read = await h.call("GET", "/control/mcps");
    assert.equal(read.status, 200);
    assert.equal(read.body?.schema, "autodev-control-mcps-v2");
    const servers = await readCatalog(h.call);
    assert.ok(servers.length > 0);
    // A declared server is not a reached server. The catalog says what each
    // server is, and says nothing about whether the Runtime has seen it, so
    // no row may carry an observation.
    for (const server of servers) {
      assert.equal(
        "runtime" in server,
        false,
        `${server.name} must not carry runtime evidence`
      );
    }
  } finally {
    h.restore();
    resetOtelTelemetry();
  }
});

test("the MCP runtime read reports unavailable observations when no source is attached", async () => {
  setControlApiMcpObservationsSource(null);
  const h = harness();
  try {
    const read = await h.call("GET", "/control/mcp-runtime");
    assert.equal(read.status, 200);
    assert.equal(read.body?.schema, "autodev-control-mcp-runtime-v1");
    // A Control API with no router attached has not been asked. Reporting an
    // empty observation here would say "the Runtime reached no MCP server",
    // which is a different claim from "nothing could be asked".
    assert.equal(read.body?.observedServers, null);
    assert.equal(read.body?.health, null);
    assert.deepEqual(read.body?.servers, []);
  } finally {
    h.restore();
    setControlApiMcpObservationsSource(null);
  }
});

test("the MCP runtime read publishes the observations its source reports", async () => {
  setControlApiMcpObservationsSource(() => [OBSERVATION]);
  const h = harness();
  try {
    const read = await h.call("GET", "/control/mcp-runtime");
    assert.equal(read.status, 200);
    assert.deepEqual(read.body?.servers, [OBSERVATION]);
    assert.equal(read.body?.observedServers, 1);
    // The counts are the runtime's, published in its own vocabulary, so the
    // console renders them rather than counting the servers itself.
    assert.deepEqual(read.body?.health, {
      ready: 1,
      error: 0,
      stale: 0,
      configured: 0,
      observed: 0
    });
  } finally {
    h.restore();
    setControlApiMcpObservationsSource(null);
  }
});

test("the MCP runtime read distinguishes an observation of nothing from an unavailable read", async () => {
  setControlApiMcpObservationsSource(() => []);
  const h = harness();
  try {
    const read = await h.call("GET", "/control/mcp-runtime");
    assert.equal(read.status, 200);
    // The Runtime was asked and reached no MCP server. That is a finding, and
    // it is not the same as never having been asked.
    assert.equal(read.body?.observedServers, 0);
    assert.deepEqual(read.body?.health, {
      ready: 0,
      error: 0,
      stale: 0,
      configured: 0,
      observed: 0
    });
  } finally {
    h.restore();
    setControlApiMcpObservationsSource(null);
  }
});

test("the runtime projects its own telemetry into the MCP observations it publishes", () => {
  resetOtelTelemetry();
  try {
    const observedAt = new Date().toISOString();
    observeServer(OBSERVED_SERVER);

    const servers = mcpServerObservations();
    const server = servers.find((entry) => entry.name === OBSERVED_SERVER);
    assert.ok(server, `the projection must carry ${OBSERVED_SERVER}`);
    // The health is the runtime's own verdict, and it is fresh because the
    // observation carries the current time.
    assert.equal(server.health, "ready");
    assert.equal(server.lastStatus, "ready");
    // The observation is stamped by the runtime, from the span it recorded.
    assert.ok(server.lastSeenAt, "an observed server carries a last-seen time");
    assert.ok(
      Math.abs(Date.parse(server.lastSeenAt) - Date.parse(observedAt)) < 5000,
      "the last-seen time is the observation the runtime recorded"
    );
    assert.equal(server.initAttempts, 1);
    assert.equal(server.toolDiscoveryAttempts, 1);
    assert.equal(server.failures, 0);
    // The tool call the runtime saw is the server's observed call count.
    assert.equal(server.toolCalls, 3);
    assert.deepEqual(server.tools, [
      { name: "lsp_goto_definition", count: 3, errors: 0 }
    ]);
    // The role the server was seen from is reported with its own health.
    assert.equal(server.roles.length, 1);
    assert.equal(server.roles[0]?.role, "orchestrator");
    assert.equal(server.roles[0]?.health, "ready");
  } finally {
    resetOtelTelemetry();
  }
});
