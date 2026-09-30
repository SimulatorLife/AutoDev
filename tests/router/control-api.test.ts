import assert from "node:assert/strict";
import test from "node:test";

import { InMemorySpanExporter } from "@opentelemetry/sdk-trace-base";

import {
  CONTROL_API_PATHS,
  handleControlApiRequest
} from "../../src/router/control-api.ts";
import {
  getDefaultPersistenceManager,
  type RouterPersistence,
  setDefaultPersistenceManager
} from "../../src/router/persistence.ts";
import { ROUTING_POLICY } from "../../src/router/routing.ts";
import {
  getDefaultExecutionContract,
  setExecutionContractForTests
} from "../../src/router/subagents.ts";
import {
  getFinishedSpans,
  resetTelemetryExporter,
  setTelemetryExporter
} from "../../src/router/telemetry.ts";
import type { ExecutionContract } from "../../src/shared/execution-contract.ts";

const ENV_KEYS = [
  "AUTODEV_CONTROL_API_TOKEN",
  "AUTODEV_CONTROL_VIEWERS",
  "AUTODEV_CONTROL_OPERATORS"
] as const;
const SERVICE_TOKEN = "unit-test-secret-token-0123456789abcdef";
const telemetryExporter = new InMemorySpanExporter();
setTelemetryExporter(telemetryExporter);

function saveEnv(): Record<string, string | undefined> {
  return Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
}

function restoreEnv(saved: Record<string, string | undefined>): void {
  for (const key of ENV_KEYS) {
    const value = saved[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

function configure(): void {
  process.env.AUTODEV_CONTROL_API_TOKEN = SERVICE_TOKEN;
  process.env.AUTODEV_CONTROL_VIEWERS = "viewer-a";
  process.env.AUTODEV_CONTROL_OPERATORS = "operator-a";
}

function makeRequest(
  method: string,
  url: string,
  options: {
    actor?: string;
    token?: string;
    body?: unknown;
    roleHeader?: string;
  } = {}
) {
  const headers: Record<string, string> = { host: "127.0.0.1" };
  if (options.token !== "")
    headers.authorization = "Bearer " + (options.token ?? SERVICE_TOKEN);
  if (options.actor) headers["x-autodev-actor"] = options.actor;
  if (options.roleHeader) headers["x-autodev-role"] = options.roleHeader;
  let body = Buffer.alloc(0);
  if (options.body !== undefined) {
    headers["content-type"] = "application/json";
    body = Buffer.from(
      typeof options.body === "string"
        ? options.body
        : JSON.stringify(options.body)
    );
  }
  return {
    method,
    url,
    headers,
    socket: { remoteAddress: "127.0.0.1" },
    async *[Symbol.asyncIterator]() {
      if (body.length > 0) yield body;
    }
  };
}

function makeResponse() {
  const chunks: Buffer[] = [];
  const headers: Record<string, string> = {};
  return {
    statusCode: 0,
    body: "",
    headers,
    headersSent: false,
    writableEnded: false,
    setHeader(name: string, value: string) {
      headers[name.toLowerCase()] = value;
    },
    writeHead(status: number, values: Record<string, string>) {
      this.statusCode = status;
      Object.assign(
        headers,
        Object.fromEntries(
          Object.entries(values).map(([key, value]) => [
            key.toLowerCase(),
            value
          ])
        )
      );
      this.headersSent = true;
    },
    write(chunk: string | Buffer) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      return true;
    },
    end(chunk?: string | Buffer) {
      if (chunk)
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      this.body = Buffer.concat(chunks).toString("utf8");
      this.writableEnded = true;
    }
  };
}

async function call(
  method: string,
  url: string,
  options: Parameters<typeof makeRequest>[2] = {}
) {
  const response = makeResponse();
  const handled = await handleControlApiRequest(
    makeRequest(method, url, options) as any,
    response as any,
    url
  );
  return {
    handled,
    response,
    body: response.body ? JSON.parse(response.body) : null
  };
}

async function captureAudit<T>(action: () => Promise<T>): Promise<{
  result: T;
  lines: string[];
}> {
  const original = process.stderr.write;
  const lines: string[] = [];
  process.stderr.write = ((chunk: unknown) => {
    lines.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  try {
    return { result: await action(), lines };
  } finally {
    process.stderr.write = original;
  }
}

test("Control API requires both a service credential and an actor allowlist", async () => {
  const saved = saveEnv();
  try {
    for (const key of ENV_KEYS) delete process.env[key];
    const disabled = await call("GET", CONTROL_API_PATHS.providers, {
      actor: "viewer-a"
    });
    assert.equal(disabled.response.statusCode, 503);

    configure();
    const noToken = await call("GET", CONTROL_API_PATHS.providers, {
      actor: "viewer-a",
      token: ""
    });
    assert.equal(noToken.response.statusCode, 401);

    const noActor = await call("GET", CONTROL_API_PATHS.providers);
    assert.equal(noActor.response.statusCode, 401);

    const unknownActor = await call("GET", CONTROL_API_PATHS.providers, {
      actor: "intruder"
    });
    assert.equal(unknownActor.response.statusCode, 403);
  } finally {
    restoreEnv(saved);
  }
});

test("viewer reads control resources; MCP and Skills views contain configuration, not OTel history", async () => {
  const saved = saveEnv();
  const priorContract = getDefaultExecutionContract();
  try {
    configure();
    setExecutionContractForTests({
      roles: {
        default: { mcp: ["playwright"], skills: ["orchestration"] },
        reviewer: { mcp: ["playwright", "github"], skills: ["lsp-mcp-server"] }
      },
      providers: {}
    } as unknown as ExecutionContract);

    const providers = await call("GET", CONTROL_API_PATHS.providers, {
      actor: "viewer-a"
    });
    assert.equal(providers.response.statusCode, 200);
    assert.equal(providers.body.schema, "autodev-control-providers-v1");

    const mcps = await call("GET", CONTROL_API_PATHS.mcps, {
      actor: "viewer-a"
    });
    assert.equal(mcps.response.statusCode, 200);
    assert.equal(mcps.body.source, "execution-contract");
    assert.deepEqual(mcps.body.servers, [
      { name: "github", roles: ["reviewer"] },
      { name: "playwright", roles: ["default", "reviewer"] }
    ]);
    assert.equal("mcpSummary" in mcps.body, false);

    const skills = await call("GET", CONTROL_API_PATHS.skills, {
      actor: "viewer-a"
    });
    assert.equal(skills.response.statusCode, 200);
    assert.deepEqual(skills.body.skills, [
      { name: "lsp-mcp-server", roles: ["reviewer"] },
      { name: "orchestration", roles: ["default"] }
    ]);
    assert.equal("bridgeUsage" in skills.body, false);

    const runtime = await call("GET", CONTROL_API_PATHS.runtime, {
      actor: "viewer-a"
    });
    assert.equal(runtime.response.statusCode, 200);
    assert.equal("otelReceiver" in runtime.body, false);
    assert.equal("subagents" in runtime.body, false);
  } finally {
    setExecutionContractForTests(priorContract);
    restoreEnv(saved);
  }
});

test("role headers cannot grant access and viewers cannot mutate", async () => {
  const saved = saveEnv();
  try {
    configure();
    const noActor = await call(
      "PATCH",
      CONTROL_API_PATHS.providers + "/claude/roles/subagent",
      { roleHeader: "operator", body: { enabled: false } }
    );
    assert.equal(noActor.response.statusCode, 401);

    const captured = await captureAudit(() =>
      call("PATCH", CONTROL_API_PATHS.providers + "/claude/roles/subagent", {
        actor: "viewer-a",
        body: { enabled: false }
      })
    );
    assert.equal(captured.result.response.statusCode, 403);
    const audit = captured.lines
      .map((line) => JSON.parse(line))
      .find((entry) => entry.schema === "autodev-control-api-audit-v1");
    assert.equal(audit.actor, "viewer-a");
    assert.equal(audit.actorVerified, true);
    assert.equal(audit.outcome, "denied");
    assert.equal(audit.reason, "viewer_cannot_mutate");
    assert.equal(JSON.stringify(audit).includes(SERVICE_TOKEN), false);
  } finally {
    restoreEnv(saved);
  }
});

test("operator PATCH validates fields, persists provider state, and audits the action", async () => {
  const saved = saveEnv();
  const originalPersistence = getDefaultPersistenceManager();
  const previous = ROUTING_POLICY.isProviderEnabledForRole(
    "claude",
    "subagent"
  );
  let persistCalls = 0;
  setDefaultPersistenceManager({
    async persistNow() {
      persistCalls += 1;
      return true;
    }
  } as unknown as RouterPersistence);
  try {
    configure();
    const path = CONTROL_API_PATHS.providers + "/claude/roles/subagent";

    const malformed = await call("PATCH", path, {
      actor: "operator-a",
      body: "not-json"
    });
    assert.equal(malformed.response.statusCode, 400);

    const extraField = await call("PATCH", path, {
      actor: "operator-a",
      body: { enabled: false, role: "subagent" }
    });
    assert.equal(extraField.response.statusCode, 400);

    const unknownProvider = await call(
      "PATCH",
      CONTROL_API_PATHS.providers + "/unknown/roles/subagent",
      { actor: "operator-a", body: { enabled: false } }
    );
    assert.equal(unknownProvider.response.statusCode, 404);
    assert.equal(
      unknownProvider.body.error.code,
      "autodev_control_api_unknown_provider"
    );

    resetTelemetryExporter();
    const captured = await captureAudit(() =>
      call("PATCH", path, {
        actor: "operator-a",
        body: { enabled: false }
      })
    );
    assert.equal(captured.result.response.statusCode, 200);
    assert.equal(captured.result.body.previous, previous);
    assert.equal(captured.result.body.enabled, false);
    assert.equal(
      ROUTING_POLICY.isProviderEnabledForRole("claude", "subagent"),
      false
    );
    assert.equal(persistCalls, 1);

    const audit = captured.lines
      .map((line) => JSON.parse(line))
      .find((entry) => entry.schema === "autodev-control-api-audit-v1");
    assert.equal(audit.actor, "operator-a");
    assert.equal(audit.actorRole, "operator");
    assert.equal(audit.outcome, "ok");
    assert.deepEqual(audit.changes, { enabled: false, previous });
    assert.equal(JSON.stringify(audit).includes(SERVICE_TOKEN), false);
    const mutationSpan = getFinishedSpans().find(
      (span) =>
        span.name === "autodev.control.mutation" &&
        span.attributes["autodev.control.outcome"] === "ok"
    );
    assert.equal(
      mutationSpan?.attributes["autodev.control.action"],
      "patch_provider_role"
    );
    assert.equal(
      mutationSpan?.attributes["autodev.control.resource"],
      "claude/roles/subagent"
    );
    assert.equal(mutationSpan?.attributes["autodev.control.outcome"], "ok");
    assert.equal(
      mutationSpan?.attributes["autodev.control.actor_role"],
      "operator"
    );
    assert.equal(Object.hasOwn(mutationSpan?.attributes ?? {}, "actor"), false);
    assert.equal(
      Object.hasOwn(mutationSpan?.attributes ?? {}, "changes"),
      false
    );
  } finally {
    resetTelemetryExporter();
    ROUTING_POLICY.setProviderEnabledForRole("claude", "subagent", previous);
    setDefaultPersistenceManager(originalPersistence);
    restoreEnv(saved);
  }
});

test("failed persistence rolls back the in-memory provider policy", async () => {
  const saved = saveEnv();
  const originalPersistence = getDefaultPersistenceManager();
  const previous = ROUTING_POLICY.isProviderEnabledForRole(
    "claude",
    "subagent"
  );
  setDefaultPersistenceManager({
    async persistNow() {
      throw new Error("disk failure");
    }
  } as unknown as RouterPersistence);
  try {
    configure();
    const result = await call(
      "PATCH",
      CONTROL_API_PATHS.providers + "/claude/roles/subagent",
      { actor: "operator-a", body: { enabled: !previous } }
    );
    assert.equal(result.response.statusCode, 500);
    assert.equal(
      ROUTING_POLICY.isProviderEnabledForRole("claude", "subagent"),
      previous
    );
  } finally {
    ROUTING_POLICY.setProviderEnabledForRole("claude", "subagent", previous);
    setDefaultPersistenceManager(originalPersistence);
    restoreEnv(saved);
  }
});

test("read-only collections reject mutations and the removed admin route stays absent", async () => {
  const saved = saveEnv();
  try {
    configure();
    const readonly = await call("PATCH", CONTROL_API_PATHS.mcps, {
      actor: "operator-a",
      body: {}
    });
    assert.equal(readonly.response.statusCode, 405);

    const legacy = await call("POST", "/v1/providers/claude", {
      actor: "operator-a",
      body: { role: "subagent", enabled: false }
    });
    assert.notEqual(legacy.response.statusCode, 200);
  } finally {
    restoreEnv(saved);
  }
});
