import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import type { IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import { handleControlApiRequest } from "../src/control-api/request-handler.ts";
import { mcpGatewayDirectory } from "../src/mcp/gateway-admission.ts";
import {
  GatewayCallObservations,
  mcpRuntimeServersFromGateway,
  publishedGatewayCallObservations,
  readMcpGatewayObservations
} from "../src/mcp/gateway-observations.ts";
import { ensurePrivateDirectory } from "../src/shared/private-service-files.ts";
import { responseRecorder } from "./support/control-api-harness.ts";

const SERVICE_TOKEN = "m".repeat(64);
const OPERATOR_ACTOR = "mcp-evidence-operator";

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

function harness(codexHome?: string): {
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
        pathname,
        codexHome === undefined ? {} : { codexHome }
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
A Codex home whose gateway directory exists, as an installed gateway's does.
*/
function gatewayHome(): { readonly codexHome: string; remove(): void } {
  const root = mkdtempSync(path.join(tmpdir(), "autodev-mcp-evidence-"));
  const codexHome = path.join(root, ".codex");
  ensurePrivateDirectory(codexHome);
  ensurePrivateDirectory(mcpGatewayDirectory(codexHome));
  return {
    codexHome,
    remove: () => rmSync(root, { recursive: true, force: true })
  };
}

const AT = new Date("2026-11-27T12:00:00.000Z");

test("the MCP catalog stays a configuration read and carries no runtime evidence", async () => {
  const h = harness();
  try {
    const read = await h.call("GET", "/control/mcps");
    assert.equal(read.status, 200);
    assert.equal(read.body?.schema, "autodev-control-mcps-v3");
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
  }
});

test("the MCP runtime read reports unavailable observations when no gateway has published", async () => {
  const home = gatewayHome();
  const h = harness(home.codexHome);
  try {
    const read = await h.call("GET", "/control/mcp-runtime");
    assert.equal(read.status, 200);
    assert.equal(read.body?.schema, "autodev-control-mcp-runtime-v1");
    assert.equal(read.body?.source, "mcp-gateway");
    // No gateway has reported. Reporting an empty observation here would say
    // "agents reached no MCP server", which is a different claim from
    // "nothing could be asked".
    assert.equal(read.body?.observedServers, null);
    assert.equal(read.body?.health, null);
    assert.deepEqual(read.body?.servers, []);
  } finally {
    h.restore();
    home.remove();
  }
});

test("a running gateway that has served nothing is an observation of nothing", async () => {
  const home = gatewayHome();
  const ledger = publishedGatewayCallObservations(home.codexHome);
  const h = harness(home.codexHome);
  try {
    const read = await h.call("GET", "/control/mcp-runtime");
    assert.equal(read.body?.observedServers, 0);
    assert.deepEqual(read.body?.health, {
      ready: 0,
      error: 0,
      stale: 0,
      configured: 0,
      observed: 0
    });
  } finally {
    ledger.close();
    h.restore();
    home.remove();
  }
});

test("the MCP runtime read publishes the calls the gateway served", async () => {
  const home = gatewayHome();
  const at = new Date();
  const ledger = publishedGatewayCallObservations(home.codexHome, {
    delayMs: 0,
    now: () => at
  });
  const h = harness(home.codexHome);
  try {
    const call = { server: "lsp", tool: "lsp_goto_definition" } as const;
    ledger.observations.record({
      ...call,
      role: "worker",
      status: "ok",
      durationMs: 30
    });
    ledger.observations.record({
      ...call,
      role: "worker",
      status: "ok",
      durationMs: 50
    });
    ledger.observations.record({
      server: "context7",
      tool: "resolve-library-id",
      role: null,
      status: "error",
      durationMs: 10
    });
    // Allow the coalesced publication, without stopping the publisher.
    await delay(0);
    const read = await h.call("GET", "/control/mcp-runtime");
    assert.equal(read.status, 200);
    assert.equal(read.body?.observedServers, 2);
    assert.deepEqual(read.body?.health, {
      ready: 1,
      error: 1,
      stale: 0,
      configured: 0,
      observed: 0
    });
    assert.deepEqual(read.body?.servers, [
      {
        name: "context7",
        health: "error",
        lastSeenAt: at.toISOString(),
        lastStatus: "error",
        initAttempts: null,
        toolDiscoveryAttempts: null,
        failures: 1,
        toolCalls: 1,
        averageDurationMs: 10,
        // The call's admission verified no role, so none is claimed.
        roles: [],
        tools: [{ name: "resolve-library-id", count: 1, errors: 1 }]
      },
      {
        name: "lsp",
        health: "ready",
        lastSeenAt: at.toISOString(),
        lastStatus: "ok",
        initAttempts: null,
        toolDiscoveryAttempts: null,
        failures: 0,
        toolCalls: 2,
        averageDurationMs: 40,
        roles: [
          {
            role: "worker",
            health: "ready",
            lastSeenAt: at.toISOString(),
            lastStatus: "ok"
          }
        ],
        tools: [{ name: "lsp_goto_definition", count: 2, errors: 0 }]
      }
    ]);
    ledger.close();
    const stopped = await h.call("GET", "/control/mcp-runtime");
    assert.equal(stopped.body?.observedServers, 2);
    assert.deepEqual(stopped.body?.health, {
      ready: 0,
      error: 0,
      stale: 2,
      configured: 0,
      observed: 0
    });
  } finally {
    ledger.close();
    h.restore();
    home.remove();
  }
});

test("a ledger whose gateway has exited describes the past, not a server that is up", () => {
  const observations = new GatewayCallObservations({ now: () => AT });
  observations.record({
    server: "lsp",
    tool: "lsp_hover",
    role: "explorer",
    status: "ok",
    durationMs: 5
  });
  const [server] = mcpRuntimeServersFromGateway(
    observations.snapshot(),
    () => false,
    AT.getTime()
  ) ?? [];
  assert.equal(server?.health, "stale");
  assert.equal(server?.roles[0]?.health, "stale");
  assert.equal(server?.toolCalls, 1);
});

test("freshness requires a running recent publisher, including when its PID is reused", () => {
  const observations = new GatewayCallObservations({ now: () => AT });
  const empty = observations.snapshot();
  const now = AT.getTime();
  assert.deepEqual(mcpRuntimeServersFromGateway(empty, () => true, now), []);
  assert.equal(mcpRuntimeServersFromGateway(empty, () => false, now), null);
  assert.equal(
    mcpRuntimeServersFromGateway(empty, () => true, now + 10001),
    null
  );
  assert.equal(mcpRuntimeServersFromGateway(empty, () => true, now - 1), null);
  observations.record({
    server: "lsp",
    tool: "lsp_hover",
    role: "explorer",
    status: "ok",
    durationMs: 5
  });
  const snapshot = observations.snapshot();
  assert.equal(
    mcpRuntimeServersFromGateway(snapshot, () => true, now)?.[0]?.health,
    "ready"
  );
  const stale = mcpRuntimeServersFromGateway(
    snapshot,
    () => true,
    now + 10001
  )?.[0];
  assert.equal(stale?.health, "stale");
  assert.equal(stale?.toolCalls, 1);
  assert.equal(stale?.roles[0]?.health, "stale");
});

test("an idle publisher renews its evidence and a stopped empty publisher is unavailable", async () => {
  const home = gatewayHome();
  const h = harness(home.codexHome);
  let now = Date.now();
  const ledger = publishedGatewayCallObservations(home.codexHome, {
    now: () => new Date(now),
    heartbeatMs: 10
  });
  try {
    const initial = readMcpGatewayObservations(home.codexHome);
    assert.ok(initial);
    now += 1;
    await delay(30);
    const renewed = readMcpGatewayObservations(home.codexHome);
    assert.equal(renewed?.publishedAt, new Date(now).toISOString());
    assert.equal(renewed?.startedAt, initial.startedAt);
    assert.deepEqual(renewed?.servers, []);
    ledger.close();
    const read = await h.call("GET", "/control/mcp-runtime");
    assert.equal(read.body?.observedServers, null);
    assert.equal(read.body?.health, null);
    assert.equal(
      readMcpGatewayObservations(home.codexHome)?.publisher,
      "stopped"
    );
    now += 1;
    await delay(30);
    assert.equal(
      readMcpGatewayObservations(home.codexHome)?.publishedAt,
      renewed?.publishedAt
    );
  } finally {
    ledger.close();
    h.restore();
    home.remove();
  }
});
