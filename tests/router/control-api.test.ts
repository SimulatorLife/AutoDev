import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { InMemorySpanExporter } from "@opentelemetry/sdk-trace-base";
import {
  type ControlApiProviderHealth,
  type ControlApiProviderModelDiscovery,
  LOCAL_CONTROL_API_ACTOR,
  PROVIDER_ROLES,
  type ProviderRoleAssignment
} from "@simulatorlife/autodev-core";
import {
  GithubActionsAdapter,
  RuleSyncRepository
} from "@simulatorlife/autodev-data";
import {
  CONTROL_API_PATHS,
  type ControlApiRequestOptions,
  githubWorkflowsView,
  handleControlApiRequest,
  setControlApiLiveAgentCountsSource,
  setControlApiMcpObservationsSource,
  setControlApiProviderHealthSource,
  setControlApiProviderModelDiscoverySource,
  setGithubActionsAdapterForTests
} from "@simulatorlife/autodev-runtime/control-api";
import { getDefaultConcurrencyManager } from "@simulatorlife/autodev-runtime/router/concurrency";
import {
  getDefaultPersistenceManager,
  type RouterPersistence,
  setDefaultPersistenceManager
} from "@simulatorlife/autodev-runtime/router/persistence";
import {
  ROUTES,
  ROUTING_POLICY
} from "@simulatorlife/autodev-runtime/router/routing";
import {
  getDefaultExecutionContract,
  setExecutionContractForTests
} from "@simulatorlife/autodev-runtime/router/subagents";
import {
  getFinishedSpans,
  resetTelemetryExporter,
  setTelemetryExporter
} from "@simulatorlife/autodev-runtime/router/telemetry";
import type { ExecutionContract } from "@simulatorlife/autodev-runtime/shared/execution-contract";
import { parse } from "smol-toml";

// Disabling a role is a priority, not a boolean: `disabled` is a member of
// the priority enum so a role cannot hold a priority and be disabled at once.
const DISABLE_SUBAGENT_BODY = { priority: "disabled", model: null } as const;

const ENV_KEYS = [
  "AUTODEV_CONTROL_API_TOKEN",
  "AUTODEV_CONTROL_VIEWERS",
  "AUTODEV_CONTROL_OPERATORS",
  "AUTODEV_MEMORY_DATABASE_URL",
  "AUTODEV_MEMORY_READ_GLOBAL",
  "AUTODEV_MEMORY_READ_TASK_HISTORY",
  "AUTODEV_GITHUB_TOKEN",
  "AUTODEV_GITHUB_REPOSITORY",
  "GITHUB_REPOSITORY",
  "CLICKHOUSE_URL"
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
  delete process.env.AUTODEV_GITHUB_TOKEN;
  delete process.env.AUTODEV_GITHUB_REPOSITORY;
  delete process.env.GITHUB_REPOSITORY;
  delete process.env.AUTODEV_MEMORY_DATABASE_URL;
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
  options: Parameters<typeof makeRequest>[2] = {},
  runtimeOptions: ControlApiRequestOptions = {}
) {
  const response = makeResponse();
  const handled = await handleControlApiRequest(
    makeRequest(method, url, options) as any,
    response as any,
    new URL(url, "http://127.0.0.1").pathname,
    runtimeOptions
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

test("Control API does not turn an unavailable evaluation store into empty history", async () => {
  const saved = saveEnv();
  try {
    configure();
    process.env.CLICKHOUSE_URL = "http://127.0.0.1:1";
    const result = await call("GET", CONTROL_API_PATHS.evaluations, {
      actor: "viewer-a"
    });
    assert.equal(result.response.statusCode, 503);
    assert.equal(
      result.body?.error?.code,
      "autodev_control_evaluations_unavailable"
    );
    assert.doesNotMatch(result.response.body, /ECONNREFUSED/u);
  } finally {
    restoreEnv(saved);
  }
});

test("Control API requires a service credential and rejects missing or untrusted actors", async () => {
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

test("Control API grants local single-user operator access only when no external actor allowlist is configured", async () => {
  const saved = saveEnv();
  try {
    process.env.AUTODEV_CONTROL_API_TOKEN = SERVICE_TOKEN;
    delete process.env.AUTODEV_CONTROL_VIEWERS;
    delete process.env.AUTODEV_CONTROL_OPERATORS;

    const local = await call("GET", CONTROL_API_PATHS.providers, {
      actor: LOCAL_CONTROL_API_ACTOR
    });
    assert.equal(local.response.statusCode, 200);

    const impersonated = await call("GET", CONTROL_API_PATHS.providers, {
      actor: "different-local-actor"
    });
    assert.equal(impersonated.response.statusCode, 403);

    process.env.AUTODEV_CONTROL_VIEWERS = "viewer-a";
    const localWithExternalPolicy = await call(
      "GET",
      CONTROL_API_PATHS.providers,
      { actor: LOCAL_CONTROL_API_ACTOR }
    );
    assert.equal(localWithExternalPolicy.response.statusCode, 403);
  } finally {
    restoreEnv(saved);
  }
});

test("provider model discovery is an authenticated read-only snapshot, separate from routing assignments", async () => {
  const saved = saveEnv();
  const priorState = ROUTING_POLICY.runtimeState();
  try {
    configure();
    setControlApiProviderModelDiscoverySource(() => ({
      schema: "autodev-control-provider-model-discovery-v1",
      source: "runtime-provider-discovery",
      providers: [
        {
          provider: "antigravity",
          discovery: {
            status: "observed",
            source: "agy models",
            observedAt: "2026-10-14T12:00:00.000Z",
            lastAttemptAt: "2026-10-14T12:00:00.000Z",
            models: [
              {
                id: "gemini-3.8-flash-low",
                displayName: "Gemini Flash Low",
                routeability: { status: "supported" }
              },
              {
                id: "gpt-oss-120b-medium",
                displayName: "GPT OSS Medium",
                routeability: {
                  status: "unsupported",
                  reason:
                    "Runtime has no route and quota ownership for this model ID."
                }
              }
            ]
          }
        },
        {
          provider: "copilot",
          discovery: {
            status: "unavailable",
            source: null,
            lastAttemptAt: null,
            reason:
              "No machine-readable model discovery adapter is configured for this provider."
          }
        }
      ]
    }));

    const result = await call("GET", CONTROL_API_PATHS.providerModels, {
      actor: "viewer-a"
    });
    assert.equal(result.response.statusCode, 200);
    assert.equal(
      result.body.schema,
      "autodev-control-provider-model-discovery-v1"
    );
    assert.equal(result.body.providers[0].discovery.status, "observed");
    assert.deepEqual(
      result.body.providers[0].discovery.models.map(
        (model: { id: string; routeability: { status: string } }) => [
          model.id,
          model.routeability.status
        ]
      ),
      [
        ["gemini-3.8-flash-low", "supported"],
        ["gpt-oss-120b-medium", "unsupported"]
      ]
    );
    assert.equal(result.body.providers[1].discovery.status, "unavailable");
    assert.deepEqual(ROUTING_POLICY.runtimeState(), priorState);

    const mutation = await call("POST", CONTROL_API_PATHS.providerModels, {
      actor: "operator-a",
      body: {}
    });
    assert.equal(mutation.response.statusCode, 405);
    assert.deepEqual(ROUTING_POLICY.runtimeState(), priorState);
  } finally {
    setControlApiProviderModelDiscoverySource(null);
    restoreEnv(saved);
  }
});

test("unobserved provider discovery publishes every known provider exactly once", async () => {
  const saved = saveEnv();
  try {
    configure();
    setControlApiProviderModelDiscoverySource(null);
    const result = await call("GET", CONTROL_API_PATHS.providerModels, {
      actor: "viewer-a"
    });
    assert.equal(result.response.statusCode, 200);
    assert.deepEqual(
      result.body.providers.map(
        (entry: { provider: string }) => entry.provider
      ),
      ROUTING_POLICY.providerIds()
    );
    assert.ok(
      result.body.providers.every(
        (entry: { discovery: { status: string } }) =>
          entry.discovery.status === "unavailable"
      )
    );
  } finally {
    setControlApiProviderModelDiscoverySource(null);
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
    assert.equal(providers.body.schema, "autodev-control-providers-v3");
    // Each provider's external links are its routing config's, unchanged.
    for (const provider of providers.body.providers as Array<{
      id: string;
      links: { usage: string | null; documentation: string | null };
    }>) {
      const configured = ROUTING_POLICY.config.providers[provider.id]?.links;
      assert.deepEqual(provider.links, {
        usage: configured?.usage ?? null,
        documentation: configured?.documentation ?? null
      });
    }

    const mcps = await call("GET", CONTROL_API_PATHS.mcps, {
      actor: "viewer-a"
    });
    assert.equal(mcps.response.statusCode, 200);
    assert.equal(mcps.body.source, ".rulesync/mcp.jsonc");
    assert.equal(mcps.body.valid, true);
    const undeclaredGithub = mcps.body.servers.find(
      (server: { name: string }) => server.name === "github"
    );
    assert.deepEqual(undeclaredGithub, {
      name: "github",
      enabled: null,
      transport: "unknown",
      targetOverrides: [],
      declared: false,
      roles: ["reviewer"]
    });
    const canonicalLsp = mcps.body.servers.find(
      (server: { name: string }) => server.name === "lsp"
    );
    assert.ok(canonicalLsp);
    assert.equal(canonicalLsp.declared, true);
    assert.deepEqual(canonicalLsp.roles, []);
    assert.equal("mcpSummary" in mcps.body, false);
    // The catalog is a configuration read, so no row carries the Runtime's
    // observation of that server either.
    assert.equal(
      mcps.body.servers.every(
        (server: { runtime?: unknown }) => !("runtime" in server)
      ),
      true
    );

    // The Runtime's observations live on their own read path, so the catalog
    // stays a configuration read and the two are composed by the page. With
    // no router attached there is no live evidence to publish, and the read
    // says so rather than reporting an empty observation as a fact.
    const mcpRuntime = await call("GET", CONTROL_API_PATHS.mcpRuntime, {
      actor: "viewer-a"
    });
    assert.equal(mcpRuntime.response.statusCode, 200);
    assert.equal(mcpRuntime.body.schema, "autodev-control-mcp-runtime-v1");
    assert.equal(mcpRuntime.body.observedServers, null);
    assert.equal(mcpRuntime.body.health, null);
    assert.deepEqual(mcpRuntime.body.servers, []);

    const skills = await call("GET", CONTROL_API_PATHS.skills, {
      actor: "viewer-a"
    });
    assert.equal(skills.response.statusCode, 200);
    assert.equal(skills.body.schema, "autodev-control-skills-v2");
    assert.equal(skills.body.valid, true);
    const lspSkill = skills.body.skills.find(
      (skill: { name: string }) => skill.name === "lsp-mcp-server"
    );
    assert.ok(lspSkill);
    assert.equal(lspSkill.path, ".rulesync/skills/lsp-mcp-server/SKILL.md");
    assert.match(lspSkill.description, /Use LSP/);
    assert.deepEqual(lspSkill.roles, ["reviewer"]);
    const orchestrationSkill = skills.body.skills.find(
      (skill: { name: string }) => skill.name === "orchestration"
    );
    assert.ok(orchestrationSkill);
    assert.deepEqual(orchestrationSkill.roles, ["default"]);
    assert.deepEqual(skills.body.unresolvedAssignments, []);
    assert.equal("bridgeUsage" in skills.body, false);

    const runtime = await call("GET", CONTROL_API_PATHS.runtime, {
      actor: "viewer-a"
    });
    assert.equal(runtime.response.statusCode, 200);
    assert.equal("otelReceiver" in runtime.body, false);
    assert.equal("subagents" in runtime.body, false);

    const workspaces = await call("GET", CONTROL_API_PATHS.workspaces, {
      actor: "viewer-a"
    });
    assert.equal(workspaces.response.statusCode, 200);
    assert.equal(workspaces.body.schema, "autodev-control-workspaces-v3");
    assert.equal(workspaces.body.source, "config/workspaces.json");
    assert.equal(workspaces.body.catalogStatus, "valid");
    assert.ok(Array.isArray(workspaces.body.workspaces));
    assert.equal(workspaces.body.totalWorkspaces, 5);
    assert.ok(
      workspaces.body.workspaces.some(
        (workspace: { id: string }) => workspace.id === "SimulatorLife/AutoDev"
      )
    );
  } finally {
    setExecutionContractForTests(priorContract);
    restoreEnv(saved);
  }
});

test("Control API publishes the Runtime's MCP observations on their own read path", async () => {
  const saved = saveEnv();
  const observation = {
    name: "lsp",
    health: "ready" as const,
    lastSeenAt: "2026-10-22T12:00:00.000Z",
    lastStatus: "ready",
    initAttempts: 1,
    toolDiscoveryAttempts: 1,
    failures: 0,
    toolCalls: 3,
    averageDurationMs: 42,
    roles: [],
    tools: [{ name: "lsp_goto_definition", count: 3, errors: 0 }]
  };
  try {
    configure();
    setControlApiMcpObservationsSource(() => [observation]);
    const read = await call("GET", CONTROL_API_PATHS.mcpRuntime, {
      actor: "viewer-a"
    });
    assert.equal(read.response.statusCode, 200);
    assert.equal(read.body.schema, "autodev-control-mcp-runtime-v1");
    // The Runtime's own record, published as it was reported: the read does
    // not derive a verdict of its own.
    assert.deepEqual(read.body.servers, [observation]);
    assert.equal(read.body.observedServers, 1);
    assert.deepEqual(read.body.health, {
      ready: 1,
      error: 0,
      stale: 0,
      configured: 0,
      observed: 0
    });

    // The catalog beside it stays a configuration read, so the observation
    // does not leak into the declaration.
    const mcps = await call("GET", CONTROL_API_PATHS.mcps, {
      actor: "viewer-a"
    });
    assert.equal(mcps.response.statusCode, 200);
    assert.equal(
      mcps.body.servers.every(
        (server: { runtime?: unknown }) => !("runtime" in server)
      ),
      true
    );
  } finally {
    setControlApiMcpObservationsSource(null);
    restoreEnv(saved);
  }
});

test("Control API reports per-workspace configuration health and runtime availability", async () => {
  const saved = saveEnv();
  interface WorkspaceFact {
    readonly id: string;
    readonly configuration: { readonly status: string };
    readonly runtime: {
      readonly status: string;
      readonly liveAgents?: number;
    };
  }
  try {
    configure();
    // No live source at all: the runtime has no evidence about any
    // workspace, so every workspace reads as unobserved rather than as an
    // idle zero. The two are different claims.
    setControlApiLiveAgentCountsSource(null);
    const unobserved = await call("GET", CONTROL_API_PATHS.workspaces, {
      actor: "viewer-a"
    });
    assert.equal(unobserved.response.statusCode, 200);
    const unobservedWorkspaces = unobserved.body.workspaces as WorkspaceFact[];
    assert.ok(unobservedWorkspaces.length > 0);
    for (const workspace of unobservedWorkspaces) {
      assert.equal(workspace.configuration.status, "configured");
      assert.equal(workspace.runtime.status, "not-observed");
    }

    // A registered live source answers for every workspace: the ones it
    // lists carry their count, and the ones it does not list are a measured
    // zero rather than an unknown.
    setControlApiLiveAgentCountsSource(() => ({
      count: 1,
      byRole: {},
      byProvider: {},
      byModel: {},
      byWorkspace: { "SimulatorLife/AutoDev": 1 },
      missingProvider: 0,
      missingModel: 0
    }));
    const observed = await call("GET", CONTROL_API_PATHS.workspaces, {
      actor: "viewer-a"
    });
    assert.equal(observed.response.statusCode, 200);
    const observedWorkspaces = observed.body.workspaces as WorkspaceFact[];
    const active = observedWorkspaces.find(
      (workspace) => workspace.id === "SimulatorLife/AutoDev"
    );
    assert.equal(active?.runtime.status, "observed");
    assert.equal(active?.runtime.liveAgents, 1);
    const idle = observedWorkspaces.find(
      (workspace) => workspace.id !== "SimulatorLife/AutoDev"
    );
    assert.equal(idle?.runtime.status, "observed");
    assert.equal(idle?.runtime.liveAgents, 0);
  } finally {
    setControlApiLiveAgentCountsSource(null);
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
      { roleHeader: "operator", body: DISABLE_SUBAGENT_BODY }
    );
    assert.equal(noActor.response.statusCode, 401);

    const captured = await captureAudit(() =>
      call("PATCH", CONTROL_API_PATHS.providers + "/claude/roles/subagent", {
        actor: "viewer-a",
        body: DISABLE_SUBAGENT_BODY
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
  let persistCalls = 0;
  let previous: ProviderRoleAssignment | null = null;
  setDefaultPersistenceManager({
    async persistNow() {
      persistCalls += 1;
      return true;
    }
  } as unknown as RouterPersistence);
  try {
    configure();
    // Captured after configure() because that is the state the PATCH actually
    // replaces, and reported as null because an unobserved assignment has no
    // JSON representation other than null.
    previous = ROUTING_POLICY.assignmentFor("claude", "subagent") ?? null;
    const path = CONTROL_API_PATHS.providers + "/claude/roles/subagent";

    const malformed = await call("PATCH", path, {
      actor: "operator-a",
      body: "not-json"
    });
    assert.equal(malformed.response.statusCode, 400);

    const extraField = await call("PATCH", path, {
      actor: "operator-a",
      body: { ...DISABLE_SUBAGENT_BODY, role: "subagent" }
    });
    assert.equal(extraField.response.statusCode, 400);

    const unknownProvider = await call(
      "PATCH",
      CONTROL_API_PATHS.providers + "/unknown/roles/subagent",
      { actor: "operator-a", body: DISABLE_SUBAGENT_BODY }
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
        body: DISABLE_SUBAGENT_BODY
      })
    );
    assert.equal(captured.result.response.statusCode, 200);
    assert.equal(captured.result.body.previous, previous);
    assert.equal(captured.result.body.priority, "disabled");
    assert.equal(
      captured.result.body.schema,
      "autodev-control-provider-role-v3"
    );
    assert.equal(
      captured.result.body.reconciliation.status.convergence,
      "converged"
    );
    assert.equal(
      ROUTING_POLICY.assignmentFor("claude", "subagent")?.priority,
      "disabled"
    );
    assert.equal(persistCalls, 1);

    const audit = captured.lines
      .map((line) => JSON.parse(line))
      .find((entry) => entry.schema === "autodev-control-api-audit-v1");
    assert.equal(audit.actor, "operator-a");
    assert.equal(audit.actorRole, "operator");
    assert.equal(audit.outcome, "ok");
    assert.deepEqual(audit.changes, {
      priority: "disabled",
      model: null,
      previous
    });
    assert.equal(audit.desiredGeneration, "subagent:disabled/none");
    assert.equal(audit.observedGeneration, audit.desiredGeneration);
    assert.equal(audit.restartRequired, false);
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
      "/control/providers/claude/roles/subagent"
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
    if (previous)
      ROUTING_POLICY.setProviderAssignment("claude", "subagent", previous);
    else ROUTING_POLICY.clearProviderAssignment("claude", "subagent");
    setDefaultPersistenceManager(originalPersistence);
    restoreEnv(saved);
  }
});

test("operator role PATCH configures and validates reasoning effort, respecting model catalogs and Antigravity fixed suffixes", async () => {
  const saved = saveEnv();
  const originalPersistence = getDefaultPersistenceManager();
  setDefaultPersistenceManager({
    async persistNow() {
      return true;
    }
  } as unknown as RouterPersistence);
  const previousClaude =
    ROUTING_POLICY.assignmentFor("claude", "subagent") ?? null;
  const previousAgy =
    ROUTING_POLICY.assignmentFor("antigravity", "subagent") ?? null;
  try {
    configure();
    ROUTING_POLICY.setProviderAssignment("claude", "subagent", {
      priority: 1,
      model: "sonnet"
    });
    ROUTING_POLICY.setProviderAssignment("antigravity", "subagent", {
      priority: 1,
      model: "gemini-3.8-flash-high"
    });
    const claudePath = CONTROL_API_PATHS.providers + "/claude/roles/subagent";

    // 1. Invalid reasoning effort for model (sonnet only supports low, medium, high)
    const invalidEffort = await call("PATCH", claudePath, {
      actor: "operator-a",
      body: { priority: 1, model: "sonnet", reasoningEffort: "extreme" }
    });
    assert.equal(invalidEffort.response.statusCode, 400);
    assert.equal(invalidEffort.body.error.code, "autodev_control_api_bad_body");

    // 2. Effort specified with null model is invalid
    const nullModelEffort = await call("PATCH", claudePath, {
      actor: "operator-a",
      body: { priority: 1, model: null, reasoningEffort: "high" }
    });
    assert.equal(nullModelEffort.response.statusCode, 400);

    // 3. Valid reasoning effort on Claude subagent (sonnet)
    const validPatch = await call("PATCH", claudePath, {
      actor: "operator-a",
      body: { priority: 1, model: "sonnet", reasoningEffort: "high" }
    });
    assert.equal(validPatch.response.statusCode, 200);
    assert.equal(validPatch.body.reasoningEffort, "high");
    assert.equal(validPatch.body.effectiveReasoningEffort, "high");
    assert.equal(validPatch.body.reasoningEffortInForce, true);
    assert.deepEqual(validPatch.body.supportedReasoningLevels, [
      "low",
      "medium",
      "high"
    ]);
    assert.equal(
      ROUTING_POLICY.assignmentFor("claude", "subagent")?.reasoningEffort,
      "high"
    );

    // 4. Clearing reasoning effort with null
    const clearPatch = await call("PATCH", claudePath, {
      actor: "operator-a",
      body: { priority: 1, model: "sonnet", reasoningEffort: null }
    });
    assert.equal(clearPatch.response.statusCode, 200);
    assert.equal(clearPatch.body.reasoningEffort, null);
    assert.equal(clearPatch.body.effectiveReasoningEffort, "medium");
    assert.equal(clearPatch.body.reasoningEffortInForce, true);
    assert.equal(
      ROUTING_POLICY.assignmentFor("claude", "subagent")?.reasoningEffort,
      undefined
    );

    // 5. Antigravity provider with fixed model slug (gemini-3.8-flash-high)
    const agyPath = CONTROL_API_PATHS.providers + "/antigravity/roles/subagent";
    const agyPatch = await call("PATCH", agyPath, {
      actor: "operator-a",
      body: {
        priority: 1,
        model: "gemini-3.8-flash-high",
        reasoningEffort: "low"
      }
    });
    assert.equal(agyPatch.response.statusCode, 200);
    assert.equal(agyPatch.body.reasoningEffort, "low");
    assert.equal(agyPatch.body.effectiveReasoningEffort, "high");
    assert.equal(agyPatch.body.reasoningEffortInForce, false);
  } finally {
    if (previousClaude)
      ROUTING_POLICY.setProviderAssignment(
        "claude",
        "subagent",
        previousClaude
      );
    else ROUTING_POLICY.clearProviderAssignment("claude", "subagent");
    if (previousAgy)
      ROUTING_POLICY.setProviderAssignment(
        "antigravity",
        "subagent",
        previousAgy
      );
    else ROUTING_POLICY.clearProviderAssignment("antigravity", "subagent");
    setDefaultPersistenceManager(originalPersistence);
    restoreEnv(saved);
  }
});

test("failed persistence rolls back the in-memory provider policy", async () => {
  const saved = saveEnv();
  const originalPersistence = getDefaultPersistenceManager();
  const previous = ROUTING_POLICY.assignmentFor("claude", "subagent");
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
      {
        actor: "operator-a",
        body: {
          priority:
            previous?.priority === "disabled" ? 1 : ("disabled" as const),
          model: null
        }
      }
    );
    assert.equal(result.response.statusCode, 500);
    assert.deepEqual(
      ROUTING_POLICY.assignmentFor("claude", "subagent") ?? null,
      previous ?? null
    );
  } finally {
    if (previous)
      ROUTING_POLICY.setProviderAssignment("claude", "subagent", previous);
    else ROUTING_POLICY.clearProviderAssignment("claude", "subagent");
    setDefaultPersistenceManager(originalPersistence);
    restoreEnv(saved);
  }
});

test("provider enablement disables globally while preserving its roles and limits", async () => {
  const saved = saveEnv();
  const originalPersistence = getDefaultPersistenceManager();
  setDefaultPersistenceManager({
    async persistNow() {
      return true;
    }
  } as unknown as RouterPersistence);
  try {
    configure();
    const path = CONTROL_API_PATHS.providers + "/claude";
    ROUTING_POLICY.setProviderLimits("claude", {
      perSession: 4,
      acrossSessions: 9
    });
    ROUTING_POLICY.setProviderAssignment("claude", "orchestrator", {
      priority: 2,
      model: "claude-opus-5-5"
    });
    ROUTING_POLICY.setProviderAssignment("claude", "subagent", {
      priority: 3,
      model: "sonnet"
    });

    const malformed = await call("PATCH", path, {
      actor: "operator-a",
      body: { disabled: "yes" }
    });
    assert.equal(malformed.response.statusCode, 400);

    const extraField = await call("PATCH", path, {
      actor: "operator-a",
      body: { disabled: true, priority: 1 }
    });
    assert.equal(extraField.response.statusCode, 400);

    const unknown = await call(
      "PATCH",
      CONTROL_API_PATHS.providers + "/nope_xyz",
      {
        actor: "operator-a",
        body: { disabled: true }
      }
    );
    assert.equal(unknown.response.statusCode, 404);

    const viewer = await call("PATCH", path, {
      actor: "viewer-a",
      body: { disabled: true }
    });
    assert.equal(viewer.response.statusCode, 403);

    const disabled = await call("PATCH", path, {
      actor: "operator-a",
      body: { disabled: true }
    });
    assert.equal(disabled.response.statusCode, 200);
    assert.equal(disabled.body.schema, "autodev-control-provider-enabled-v1");
    assert.equal(disabled.body.disabled, true);
    assert.equal(disabled.body.previous, false);
    assert.equal(ROUTING_POLICY.isProviderDisabled("claude"), true);
    // Disabling is provider-wide, so no role may serve a request -- but the
    // configuration the operator set must survive so re-enabling restores it.
    for (const role of PROVIDER_ROLES) {
      assert.equal(
        ROUTING_POLICY.isProviderEnabledForRole("claude", role),
        false
      );
    }
    assert.deepEqual(ROUTING_POLICY.limitsFor("claude"), {
      perSession: 4,
      acrossSessions: 9
    });
    assert.deepEqual(ROUTING_POLICY.assignmentFor("claude", "orchestrator"), {
      priority: 2,
      model: "claude-opus-5-5"
    });
    assert.deepEqual(ROUTING_POLICY.assignmentFor("claude", "subagent"), {
      priority: 3,
      model: "sonnet"
    });

    // "Preserved" has to mean preserved rather than unreachable: a role write
    // against a disabled provider is refused with a named reason, so the
    // Console's `mutable: false` and its "enable the provider first" message
    // describe the API rather than a convention. Without this the endpoint
    // would accept the change silently, and the operator's configuration would
    // be edited by a control the UI shows as inert.
    const roleWhileDisabled = await call(
      "PATCH",
      CONTROL_API_PATHS.providers + "/claude/roles/orchestrator",
      { actor: "operator-a", body: { priority: 1, model: "claude-opus-5-5" } }
    );
    assert.equal(roleWhileDisabled.response.statusCode, 409);
    assert.equal(
      roleWhileDisabled.body.error.code,
      "autodev_control_api_provider_disabled"
    );
    assert.deepEqual(ROUTING_POLICY.assignmentFor("claude", "orchestrator"), {
      priority: 2,
      model: "claude-opus-5-5"
    });

    const enabled = await call("PATCH", path, {
      actor: "operator-a",
      body: { disabled: false }
    });
    assert.equal(enabled.response.statusCode, 200);
    assert.equal(enabled.body.previous, true);
    assert.equal(ROUTING_POLICY.isProviderDisabled("claude"), false);
    // The preserved configuration is what makes re-enabling safe.
    assert.deepEqual(ROUTING_POLICY.limitsFor("claude"), {
      perSession: 4,
      acrossSessions: 9
    });
    assert.deepEqual(ROUTING_POLICY.assignmentFor("claude", "orchestrator"), {
      priority: 2,
      model: "claude-opus-5-5"
    });
    assert.equal(
      ROUTING_POLICY.isProviderEnabledForRole("claude", "orchestrator"),
      true
    );
  } finally {
    ROUTING_POLICY.setProviderEnabled("claude", true);
    ROUTING_POLICY.clearProviderLimits("claude");
    ROUTING_POLICY.clearProviderAssignment("claude", "orchestrator");
    ROUTING_POLICY.clearProviderAssignment("claude", "subagent");
    setDefaultPersistenceManager(originalPersistence);
    restoreEnv(saved);
  }
});

test("provider agent limits accept Unlimited and reject values that are not limits", async () => {
  const saved = saveEnv();
  const originalPersistence = getDefaultPersistenceManager();
  setDefaultPersistenceManager({
    async persistNow() {
      return true;
    }
  } as unknown as RouterPersistence);
  try {
    configure();
    const path = CONTROL_API_PATHS.providers + "/claude/limits";

    for (const body of [
      { perSession: 0, acrossSessions: 1 },
      { perSession: -2, acrossSessions: 1 },
      { perSession: 1.5, acrossSessions: 1 },
      { perSession: "3", acrossSessions: 1 },
      { perSession: 1 },
      { perSession: 1, acrossSessions: 1, extra: 2 }
    ]) {
      const rejected = await call("PATCH", path, {
        actor: "operator-a",
        body
      });
      assert.equal(
        rejected.response.statusCode,
        400,
        `limits body ${JSON.stringify(body)} is not a limit`
      );
    }

    const unlimited = await call("PATCH", path, {
      actor: "operator-a",
      body: { perSession: null, acrossSessions: null }
    });
    assert.equal(unlimited.response.statusCode, 200);
    assert.equal(unlimited.body.schema, "autodev-control-provider-limits-v1");
    assert.deepEqual(unlimited.body.agentLimits, {
      perSession: null,
      acrossSessions: null
    });
    assert.deepEqual(ROUTING_POLICY.limitsFor("claude"), {
      perSession: null,
      acrossSessions: null
    });

    const bounded = await call("PATCH", path, {
      actor: "operator-a",
      body: { perSession: 3, acrossSessions: 12 }
    });
    assert.equal(bounded.response.statusCode, 200);
    assert.deepEqual(ROUTING_POLICY.limitsFor("claude"), {
      perSession: 3,
      acrossSessions: 12
    });
    assert.deepEqual(bounded.body.previous, {
      perSession: null,
      acrossSessions: null
    });
  } finally {
    ROUTING_POLICY.clearProviderLimits("claude");
    setDefaultPersistenceManager(originalPersistence);
    restoreEnv(saved);
  }
});

test("a failed provider limits persist leaves no limits behind", async () => {
  const saved = saveEnv();
  const originalPersistence = getDefaultPersistenceManager();
  setDefaultPersistenceManager({
    async persistNow() {
      throw new Error("disk failure");
    }
  } as unknown as RouterPersistence);
  try {
    configure();
    ROUTING_POLICY.clearProviderLimits("claude");
    assert.equal(ROUTING_POLICY.limitsFor("claude"), undefined);

    const result = await call(
      "PATCH",
      CONTROL_API_PATHS.providers + "/claude/limits",
      { actor: "operator-a", body: { perSession: 7, acrossSessions: 7 } }
    );
    assert.equal(result.response.statusCode, 500);
    assert.equal(
      ROUTING_POLICY.limitsFor("claude"),
      undefined,
      "a rejected limit change must not become an active limit"
    );
  } finally {
    ROUTING_POLICY.clearProviderLimits("claude");
    setDefaultPersistenceManager(originalPersistence);
    restoreEnv(saved);
  }
});

test("a failed persist cannot leave behind an assignment that had none before", async () => {
  const saved = saveEnv();
  const originalPersistence = getDefaultPersistenceManager();
  setDefaultPersistenceManager({
    async persistNow() {
      throw new Error("disk failure");
    }
  } as unknown as RouterPersistence);
  try {
    configure();
    ROUTING_POLICY.clearProviderAssignment("claude", "subagent");
    assert.equal(
      ROUTING_POLICY.assignmentFor("claude", "subagent"),
      undefined,
      "the rollback-under-test requires an unobserved starting assignment"
    );

    const result = await call(
      "PATCH",
      CONTROL_API_PATHS.providers + "/claude/roles/subagent",
      { actor: "operator-a", body: { priority: "disabled", model: null } }
    );
    assert.equal(result.response.statusCode, 500);
    // Restoring the prior state here means forgetting the assignment, not
    // leaving the rejected change in memory where it would keep steering
    // routing despite never having been persisted.
    assert.equal(ROUTING_POLICY.assignmentFor("claude", "subagent"), undefined);
    assert.equal(
      ROUTING_POLICY.isProviderEnabledForRole("claude", "subagent"),
      true,
      "an unobserved assignment serves the role again after a rejected change"
    );
  } finally {
    ROUTING_POLICY.clearProviderAssignment("claude", "subagent");
    setDefaultPersistenceManager(originalPersistence);
    restoreEnv(saved);
  }
});

test("provider reset requires an operator actor and a body of exactly { confirm: true }", async () => {
  const saved = saveEnv();
  const originalPersistence = getDefaultPersistenceManager();
  setDefaultPersistenceManager({
    async persistNow() {
      return true;
    }
  } as unknown as RouterPersistence);
  try {
    configure();
    const path = CONTROL_API_PATHS.providersReset;

    const viewer = await call("POST", path, {
      actor: "viewer-a",
      body: { confirm: true }
    });
    assert.equal(viewer.response.statusCode, 403);
    assert.equal(
      viewer.body.error.code,
      "autodev_control_api_viewer_forbidden"
    );

    for (const body of [
      {},
      { confirm: false },
      { confirm: "true" },
      { confirm: true, extra: 1 },
      { force: true }
    ]) {
      const rejected = await call("POST", path, { actor: "operator-a", body });
      assert.equal(
        rejected.response.statusCode,
        400,
        `reset body ${JSON.stringify(body)} must be rejected`
      );
      assert.equal(rejected.body.error.code, "autodev_control_api_bad_body");
    }

    // An exact-path GET must be rejected as a method mismatch on the reset
    // route itself, not fall through and be read as a lookup for a provider
    // literally named "reset".
    const wrongMethod = await call("GET", path, { actor: "operator-a" });
    assert.equal(wrongMethod.response.statusCode, 405);
    assert.notEqual(
      wrongMethod.body.error.code,
      "autodev_control_api_unknown_provider"
    );
  } finally {
    setDefaultPersistenceManager(originalPersistence);
    restoreEnv(saved);
  }
});

test("provider reset clears only role assignments, provider disables, model disables, and provider limits, and preserves everything else", async () => {
  const saved = saveEnv();
  const originalPersistence = getDefaultPersistenceManager();
  const priorState = ROUTING_POLICY.runtimeState();
  const priorDiscoveredModels = ROUTING_POLICY.discoveredModels();
  const manager = getDefaultConcurrencyManager();
  const priorConcurrencyState = manager.persistenceSnapshot();
  setDefaultPersistenceManager({
    async persistNow() {
      return true;
    }
  } as unknown as RouterPersistence);
  try {
    configure();
    const staticRoutingConfig = ROUTING_POLICY.config;
    const staticProviderGroups = structuredClone(
      ROUTING_POLICY.config.providerGroups
    );
    const staticProviderModels = Object.fromEntries(
      Object.entries(ROUTING_POLICY.config.providers).map(
        ([provider, config]) => [provider, { ...config.models }]
      )
    );
    // Provider Runtime overrides, spread across more than one provider and
    // role so the cleared counts cannot be mistaken for a single-entry case.
    ROUTING_POLICY.setProviderAssignment("claude", "subagent", {
      priority: 2,
      model: "sonnet"
    });
    ROUTING_POLICY.setProviderAssignment("claude", "orchestrator", {
      priority: 1,
      model: "claude-opus-5-5"
    });
    ROUTING_POLICY.setProviderAssignment("antigravity", "subagent", {
      priority: 1,
      model: "gemini-3.8-flash-high"
    });
    ROUTING_POLICY.setProviderEnabled("claude", false);
    ROUTING_POLICY.setModelEnabled("sonnet", false);
    ROUTING_POLICY.setProviderLimits("antigravity", {
      perSession: 2,
      acrossSessions: 5
    });

    // Out-of-scope state the reset must never touch.
    ROUTING_POLICY.setAgentEnabled("worker", false);
    const preservedAgentEnabled = ROUTING_POLICY.isAgentEnabled("worker");
    const preservedGeneration =
      ROUTING_POLICY.agentEnablementGeneration("worker");
    ROUTING_POLICY.setDiscoveredProviderModels("claude", [
      {
        id: "sonnet",
        displayName: "Sonnet",
        routeability: { status: "supported" }
      }
    ]);
    const preservedDiscovery = ROUTING_POLICY.discoveredModels();
    manager.setMaxConcurrentThreadsPerSession(6);
    const preservedConcurrency = manager.effectivePerSessionLimit();

    const expectedCounts = {
      roleAssignments: 3,
      disabledProviders: 1,
      disabledModels: 1,
      providerLimits: 1
    };

    const captured = await captureAudit(() =>
      call("POST", CONTROL_API_PATHS.providersReset, {
        actor: "operator-a",
        body: { confirm: true }
      })
    );
    assert.equal(captured.result.response.statusCode, 200);
    assert.equal(
      captured.result.body.schema,
      "autodev-control-providers-reset-v1"
    );
    assert.equal(captured.result.body.actor, "operator-a");
    assert.deepEqual(captured.result.body.cleared, expectedCounts);
    assert.equal(
      captured.result.body.reconciliation.status.convergence,
      "converged"
    );

    // The four provider Runtime override fields are cleared.
    assert.equal(ROUTING_POLICY.assignmentFor("claude", "subagent"), undefined);
    assert.equal(
      ROUTING_POLICY.assignmentFor("claude", "orchestrator"),
      undefined
    );
    assert.equal(
      ROUTING_POLICY.assignmentFor("antigravity", "subagent"),
      undefined
    );
    assert.equal(ROUTING_POLICY.isProviderDisabled("claude"), false);
    assert.equal(ROUTING_POLICY.isModelEnabled("sonnet"), true);
    assert.equal(ROUTING_POLICY.limitsFor("antigravity"), undefined);

    // Static routing source remains the default authority; Reset clears only
    // the in-memory operator overlay and never edits its configuration object.
    assert.equal(ROUTING_POLICY.config, staticRoutingConfig);
    assert.deepEqual(
      ROUTING_POLICY.config.providerGroups,
      staticProviderGroups
    );
    assert.deepEqual(
      Object.fromEntries(
        Object.entries(ROUTING_POLICY.config.providers).map(
          ([provider, config]) => [provider, { ...config.models }]
        )
      ),
      staticProviderModels
    );

    // Everything out of scope survives exactly.
    assert.equal(
      ROUTING_POLICY.isAgentEnabled("worker"),
      preservedAgentEnabled
    );
    assert.equal(
      ROUTING_POLICY.agentEnablementGeneration("worker"),
      preservedGeneration
    );
    assert.deepEqual(ROUTING_POLICY.discoveredModels(), preservedDiscovery);
    assert.equal(manager.effectivePerSessionLimit(), preservedConcurrency);

    const audit = captured.lines
      .map((line) => JSON.parse(line))
      .find(
        (entry) =>
          entry.schema === "autodev-control-api-audit-v1" &&
          entry.action === "reset_providers"
      );
    assert.equal(audit.outcome, "ok");
    assert.equal(audit.resource, CONTROL_API_PATHS.providersReset);
    assert.deepEqual(audit.changes, { cleared: expectedCounts });

    // The next reset observes the first operation's history for this resource;
    // the first response is empty only because no reset has happened yet.
    const repeated = await call("POST", CONTROL_API_PATHS.providersReset, {
      actor: "operator-a",
      body: { confirm: true }
    });
    assert.equal(repeated.response.statusCode, 200);
    assert.deepEqual(repeated.body.cleared, {
      roleAssignments: 0,
      disabledProviders: 0,
      disabledModels: 0,
      providerLimits: 0
    });
    assert.ok(
      repeated.body.reconciliation.history.some(
        (entry: { action: string }) => entry.action === "reset_providers"
      )
    );
  } finally {
    ROUTING_POLICY.restoreRuntimeState(priorState);
    for (const provider of ROUTING_POLICY.providerIds()) {
      ROUTING_POLICY.setDiscoveredProviderModels(
        provider,
        priorDiscoveredModels
          .filter((model) => model.provider === provider)
          .map(({ provider: _provider, ...model }) => model)
      );
    }
    manager.restorePersistence(priorConcurrencyState);
    setDefaultPersistenceManager(originalPersistence);
    restoreEnv(saved);
  }
});

test("a failed provider reset persist restores the exact prior provider state", async () => {
  const saved = saveEnv();
  const originalPersistence = getDefaultPersistenceManager();
  const priorState = ROUTING_POLICY.runtimeState();
  setDefaultPersistenceManager({
    async persistNow() {
      throw new Error("disk failure");
    }
  } as unknown as RouterPersistence);
  try {
    configure();
    ROUTING_POLICY.setProviderAssignment("claude", "subagent", {
      priority: 2,
      model: "sonnet"
    });
    ROUTING_POLICY.setProviderEnabled("claude", false);
    ROUTING_POLICY.setModelEnabled("sonnet", false);
    ROUTING_POLICY.setProviderLimits("claude", {
      perSession: 1,
      acrossSessions: 2
    });
    const stateBeforeReset = ROUTING_POLICY.runtimeState();

    const result = await call("POST", CONTROL_API_PATHS.providersReset, {
      actor: "operator-a",
      body: { confirm: true }
    });
    assert.equal(result.response.statusCode, 500);
    assert.equal(
      result.body.error.code,
      "autodev_control_api_persistence_failed"
    );
    // A rejected reset must restore the exact state it started from, not an
    // empty one: the in-memory clear happens before persistence is attempted,
    // so the rollback has to put every override back.
    assert.deepEqual(ROUTING_POLICY.runtimeState(), stateBeforeReset);
  } finally {
    ROUTING_POLICY.restoreRuntimeState(priorState);
    setDefaultPersistenceManager(originalPersistence);
    restoreEnv(saved);
  }
});

test("provider reset serializes with a concurrent provider role mutation on the shared router-state queue", async () => {
  const saved = saveEnv();
  const originalPersistence = getDefaultPersistenceManager();
  const priorState = ROUTING_POLICY.runtimeState();
  const { promise: firstPersist, resolve: releaseFirstPersist } =
    Promise.withResolvers<boolean>();
  const { promise: firstPersistStarted, resolve: signalFirstPersist } =
    Promise.withResolvers<void>();
  let persistCalls = 0;
  let resetCall: Promise<any> | null = null;
  let roleCall: Promise<any> | null = null;
  setDefaultPersistenceManager({
    async persistNow() {
      persistCalls += 1;
      if (persistCalls === 1) {
        signalFirstPersist();
        return firstPersist;
      }
      return true;
    }
  } as unknown as RouterPersistence);
  try {
    configure();
    ROUTING_POLICY.setProviderAssignment("claude", "subagent", {
      priority: 2,
      model: "sonnet"
    });

    resetCall = call("POST", CONTROL_API_PATHS.providersReset, {
      actor: "operator-a",
      body: { confirm: true }
    });
    await firstPersistStarted;

    // The reset's persist is in flight; a provider role mutation that shares
    // the same router-state queue must wait rather than interleave with the
    // reset's own apply/persist/rollback sequence.
    roleCall = call(
      "PATCH",
      CONTROL_API_PATHS.providers + "/antigravity/roles/subagent",
      {
        actor: "operator-a",
        body: { priority: "disabled", model: null }
      }
    );
    const nextTurn = Promise.withResolvers<void>();
    setImmediate(nextTurn.resolve);
    await nextTurn.promise;
    assert.equal(
      persistCalls,
      1,
      "the role mutation must not persist before the reset's turn completes"
    );

    releaseFirstPersist(true);
    const [resetResult, roleResult] = await Promise.all([resetCall, roleCall]);
    assert.equal(resetResult.response.statusCode, 200);
    assert.equal(roleResult.response.statusCode, 200);
    assert.equal(persistCalls, 2);
    // The role mutation ran strictly after the reset committed, so its
    // assignment must be the one still standing.
    assert.equal(
      ROUTING_POLICY.assignmentFor("antigravity", "subagent")?.priority,
      "disabled"
    );
    assert.equal(ROUTING_POLICY.assignmentFor("claude", "subagent"), undefined);
  } finally {
    releaseFirstPersist(true);
    await Promise.all([resetCall, roleCall].filter(Boolean));
    ROUTING_POLICY.restoreRuntimeState(priorState);
    setDefaultPersistenceManager(originalPersistence);
    restoreEnv(saved);
  }
});

test("providers v2 reports routes, credential presence, tier models, priorities, and router health only when observed", async () => {
  const saved = saveEnv();
  try {
    configure();
    const unobserved = await call("GET", CONTROL_API_PATHS.providers, {
      actor: "viewer-a"
    });
    assert.equal(unobserved.response.statusCode, 200);
    const body = unobserved.body;
    assert.equal(
      body.orchestratorTier,
      ROUTING_POLICY.config.orchestrator.tier
    );
    assert.deepEqual(
      body.tiers.map(({ tier }: { tier: string }) => tier).sort(),
      Object.keys(ROUTING_POLICY.config.providerGroups).sort()
    );
    const claude = body.providers.find(
      (provider: { id: string }) => provider.id === "claude"
    );
    assert.ok(claude);
    assert.equal(typeof claude.route.baseUrl, "string");
    assert.equal(claude.credential.envKey, "LITELLM_API_KEY");
    assert.equal(typeof claude.credential.configured, "boolean");
    assert.equal(JSON.stringify(body).includes(SERVICE_TOKEN), false);
    assert.deepEqual(
      claude.models,
      Object.entries(ROUTING_POLICY.config.providers.claude!.models).map(
        ([tier, model]) => ({ tier, model })
      )
    );
    for (const { tier, group } of claude.priorities) {
      assert.ok(
        ROUTING_POLICY.config.providerGroups[tier]![group - 1]!.includes(
          "claude"
        )
      );
    }
    assert.deepEqual(claude.roles.orchestrator, {
      priority: ROUTING_POLICY.isProviderEnabledForRole(
        "claude",
        "orchestrator"
      )
        ? 1
        : ("disabled" as const),
      model: null,
      reasoningEffort: "medium",
      effectiveReasoningEffort: "medium",
      reasoningEffortInForce: true,
      supportedReasoningLevels: [],
      mutable: true,
      // The GET surface reports desired/observed generations but has no
      // runtime observation for this resource, so convergence stays
      // not-observed rather than inferring convergence from equal strings.
      convergence: {
        convergence: "not-observed",
        desiredGeneration: `orchestrator:enabled=${ROUTING_POLICY.isProviderEnabledForRole(
          "claude",
          "orchestrator"
        )}`,
        observedGeneration: `orchestrator:enabled=${ROUTING_POLICY.isProviderEnabledForRole(
          "claude",
          "orchestrator"
        )}`,
        lastApplyAt: null,
        lastObservationAt: null,
        lastError: null,
        explanation:
          "The runtime has not yet reported observed state for this resource; convergence is unknown."
      }
    });
    assert.equal(claude.health, null, "no router evidence means unobserved");

    setControlApiProviderHealthSource(() => ({
      claude: {
        cooldown: null,
        failureStreak: 0,
        probeFailureStreak: 0,
        inFlightRequests: 2,
        activeAgents: 1,
        attempts: 5,
        successes: 5,
        failures: 0,
        lastSuccessAt: "2026-10-05T15:00:00.000Z",
        lastFailure: null
      }
    }));
    const observed = await call("GET", CONTROL_API_PATHS.providers, {
      actor: "viewer-a"
    });
    const observedClaude = observed.body.providers.find(
      (provider: { id: string }) => provider.id === "claude"
    );
    assert.equal(observedClaude.health.inFlightRequests, 2);
    assert.equal(
      observed.body.providers.find(
        (provider: { id: string }) => provider.id === "codex"
      ).health,
      null
    );
  } finally {
    setControlApiProviderHealthSource(null);
    restoreEnv(saved);
  }
});

test("models v2 lists each routed model once with its provider, tiers, and enablement", async () => {
  const saved = saveEnv();
  try {
    configure();
    const result = await call("GET", CONTROL_API_PATHS.models, {
      actor: "viewer-a"
    });
    assert.equal(result.response.statusCode, 200);
    assert.equal(result.body.schema, "autodev-control-models-v2");
    const ids = result.body.models.map((model: { id: string }) => model.id);
    assert.equal(new Set(ids).size, ids.length);
    assert.deepEqual(
      [...ids].sort(),
      ROUTING_POLICY.configuredModels()
        .map(({ model }) => model)
        .sort()
    );
    for (const model of result.body.models) {
      assert.equal(
        ROUTING_POLICY.routeForModel(model.id)?.provider,
        model.provider
      );
      assert.ok(model.tiers.length > 0);
      // Model enablement carries the same desired-vs-actual contract as a
      // provider role. The GET surface reports generations but has no runtime
      // observation for this resource, so convergence stays not-observed rather
      // than inferring convergence from equal strings.
      assert.deepEqual(model.enablement, {
        enabled: ROUTING_POLICY.isModelEnabled(model.id),
        mutable: false,
        convergence: {
          convergence: "not-observed",
          desiredGeneration: `enabled=${ROUTING_POLICY.isModelEnabled(model.id)}`,
          observedGeneration: `enabled=${ROUTING_POLICY.isModelEnabled(model.id)}`,
          lastApplyAt: null,
          lastObservationAt: null,
          lastError: null,
          explanation:
            "The runtime has not yet reported observed state for this resource; convergence is unknown."
        }
      });
    }
    const sonnet = result.body.models.find(
      (model: { id: string }) => model.id === "sonnet"
    );
    assert.equal(sonnet?.displayName, "Claude Sonnet subscription");
  } finally {
    restoreEnv(saved);
  }
});

test("model enablement becomes mutable only for an observed routeable provider model", async () => {
  const saved = saveEnv();
  const entry = ROUTING_POLICY.configuredModels()[0]!;
  const previousDiscovered = ROUTING_POLICY.discoveredModels()
    .filter((model) => model.provider === entry.provider)
    .map(({ id, displayName, routeability }) => ({
      id,
      displayName,
      routeability
    }));
  try {
    configure();
    setControlApiProviderModelDiscoverySource(() => ({
      schema: "autodev-control-provider-model-discovery-v1",
      source: "runtime-provider-discovery",
      providers: [
        {
          provider: entry.provider,
          discovery: {
            status: "observed",
            source: "fixture provider listing",
            observedAt: "2026-10-14T12:00:00.000Z",
            lastAttemptAt: "2026-10-14T12:00:00.000Z",
            models: [
              {
                id: entry.model,
                displayName: null,
                routeability: { status: "supported" }
              }
            ]
          }
        }
      ]
    }));
    ROUTING_POLICY.setDiscoveredProviderModels(entry.provider, [
      {
        id: entry.model,
        displayName: null,
        routeability: { status: "supported" }
      }
    ]);

    const result = await call("GET", CONTROL_API_PATHS.models, {
      actor: "viewer-a"
    });
    assert.equal(result.response.statusCode, 200);
    const discovered = result.body.models.find(
      (model: { id: string }) => model.id === entry.model
    );
    assert.equal(discovered?.enablement.mutable, true);
  } finally {
    setControlApiProviderModelDiscoverySource(null);
    ROUTING_POLICY.setDiscoveredProviderModels(
      entry.provider,
      previousDiscovered
    );
    restoreEnv(saved);
  }
});

test("operator model PATCH validates, persists, audits, and rolls back on persistence failure", async () => {
  const saved = saveEnv();
  const originalPersistence = getDefaultPersistenceManager();
  const configured = ROUTING_POLICY.configuredModels()[0]!;
  const { model, provider } = configured;
  const path = CONTROL_API_PATHS.models + "/" + model;
  const previousDiscovered = ROUTING_POLICY.discoveredModels()
    .filter((entry) => entry.provider === provider)
    .map(({ id, displayName, routeability }) => ({
      id,
      displayName,
      routeability
    }));
  let persistCalls = 0;
  let failPersist = false;
  setDefaultPersistenceManager({
    async persistNow() {
      persistCalls += 1;
      if (failPersist) throw new Error("disk failure");
      return true;
    }
  } as unknown as RouterPersistence);
  try {
    configure();
    setControlApiProviderModelDiscoverySource(() => ({
      schema: "autodev-control-provider-model-discovery-v1",
      source: "runtime-provider-discovery",
      providers: [
        {
          provider,
          discovery: {
            status: "observed",
            source: "fixture provider listing",
            observedAt: "2026-10-14T12:00:00.000Z",
            lastAttemptAt: "2026-10-14T12:00:00.000Z",
            models: [
              {
                id: model,
                displayName: null,
                routeability: { status: "supported" }
              }
            ]
          }
        }
      ]
    }));
    ROUTING_POLICY.setDiscoveredProviderModels(provider, [
      { id: model, displayName: null, routeability: { status: "supported" } }
    ]);
    const viewer = await call("PATCH", path, {
      actor: "viewer-a",
      body: { enabled: false }
    });
    assert.equal(viewer.response.statusCode, 403);

    const extraField = await call("PATCH", path, {
      actor: "operator-a",
      body: { enabled: false, tier: "default" }
    });
    assert.equal(extraField.response.statusCode, 400);

    const unknown = await call(
      "PATCH",
      CONTROL_API_PATHS.models + "/gpt-not-configured",
      { actor: "operator-a", body: { enabled: false } }
    );
    assert.equal(unknown.response.statusCode, 404);
    assert.equal(unknown.body.error.code, "autodev_control_api_unknown_model");

    const read = await call("GET", path, { actor: "operator-a" });
    assert.equal(read.response.statusCode, 405);
    assert.equal(read.response.headers.allow, "PATCH");
    assert.equal(persistCalls, 0);

    resetTelemetryExporter();
    const captured = await captureAudit(() =>
      call("PATCH", path, { actor: "operator-a", body: { enabled: false } })
    );
    assert.equal(captured.result.response.statusCode, 200);
    assert.equal(captured.result.body.schema, "autodev-control-model-v1");
    assert.equal(captured.result.body.model, model);
    assert.equal(captured.result.body.enabled, false);
    assert.equal(captured.result.body.previous, true);
    assert.equal(captured.result.body.actor, "operator-a");
    // A model apply publishes the same desired-vs-actual evidence a provider
    // role does, so "did my toggle land?" is answerable for every mutable
    // routing resource rather than only for the provider ones.
    assert.equal(
      captured.result.body.reconciliation.status.convergence,
      "converged"
    );
    assert.equal(
      captured.result.body.reconciliation.status.desiredGeneration,
      "enabled=false"
    );
    assert.equal(
      captured.result.body.reconciliation.status.observedGeneration,
      "enabled=false"
    );
    assert.equal(captured.result.body.reconciliation.status.lastError, null);
    assert.ok(
      captured.result.body.reconciliation.history.some(
        (entry: { action: string }) => entry.action === "patch_model"
      )
    );
    assert.equal(ROUTING_POLICY.isModelEnabled(model), false);
    assert.deepEqual(ROUTING_POLICY.runtimeState().disabledModels, [model]);
    assert.equal(persistCalls, 1);
    const audit = captured.lines
      .map((line) => JSON.parse(line))
      .find((entry) => entry.schema === "autodev-control-api-audit-v1");
    assert.equal(audit.action, "patch_model");
    assert.equal(audit.resource, model);
    assert.deepEqual(audit.changes, { enabled: false, previous: true });
    assert.equal(audit.desiredGeneration, "enabled=false");
    assert.equal(audit.observedGeneration, audit.desiredGeneration);
    assert.equal(audit.restartRequired, false);
    assert.equal(
      getFinishedSpans().find(
        (span) =>
          span.name === "autodev.control.mutation" &&
          span.attributes["autodev.control.action"] === "patch_model"
      )?.attributes["autodev.control.outcome"],
      "ok"
    );

    failPersist = true;
    const failed = await call("PATCH", path, {
      actor: "operator-a",
      body: { enabled: true }
    });
    assert.equal(failed.response.statusCode, 500);
    assert.equal(
      ROUTING_POLICY.isModelEnabled(model),
      false,
      "a failed persist rolls the model back to its previous state"
    );
  } finally {
    resetTelemetryExporter();
    ROUTING_POLICY.resetDisabledModels();
    setControlApiProviderModelDiscoverySource(null);
    ROUTING_POLICY.setDiscoveredProviderModels(provider, previousDiscovered);
    setDefaultPersistenceManager(originalPersistence);
    restoreEnv(saved);
  }
});

test("operator cannot change model enablement without current routeable availability", async () => {
  const saved = saveEnv();
  const originalPersistence = getDefaultPersistenceManager();
  const configured = ROUTING_POLICY.configuredModels()[0]!;
  const previousDiscovered = ROUTING_POLICY.discoveredModels()
    .filter((entry) => entry.provider === configured.provider)
    .map(({ id, displayName, routeability }) => ({
      id,
      displayName,
      routeability
    }));
  let persistCalls = 0;
  setDefaultPersistenceManager({
    async persistNow() {
      persistCalls += 1;
      return true;
    }
  } as unknown as RouterPersistence);
  try {
    configure();
    setControlApiProviderModelDiscoverySource(() => ({
      schema: "autodev-control-provider-model-discovery-v1",
      source: "runtime-provider-discovery",
      providers: [
        {
          provider: configured.provider,
          discovery: {
            status: "unavailable",
            source: "fixture provider listing",
            lastAttemptAt: "2026-10-14T12:00:00.000Z",
            reason: "Provider model listing is unavailable."
          }
        }
      ]
    }));
    ROUTING_POLICY.setDiscoveredProviderModels(configured.provider, []);

    const result = await call(
      "PATCH",
      `${CONTROL_API_PATHS.models}/${encodeURIComponent(configured.model)}`,
      { actor: "operator-a", body: { enabled: false } }
    );
    assert.equal(result.response.statusCode, 409);
    assert.equal(
      result.body.error.code,
      "autodev_control_api_model_not_currently_routeable"
    );
    assert.equal(ROUTING_POLICY.isModelEnabled(configured.model), true);
    assert.equal(persistCalls, 0);
  } finally {
    setControlApiProviderModelDiscoverySource(null);
    ROUTING_POLICY.setDiscoveredProviderModels(
      configured.provider,
      previousDiscovered
    );
    setDefaultPersistenceManager(originalPersistence);
    restoreEnv(saved);
  }
});

test("provider role edits preserve an unavailable current model but accept new models only from current routeable discovery", async () => {
  const saved = saveEnv();
  const originalPersistence = getDefaultPersistenceManager();
  const provider = "claude";
  const role = "subagent" as const;
  const previousAssignment = ROUTING_POLICY.assignmentFor(provider, role);
  const previousDiscovered = ROUTING_POLICY.discoveredModels()
    .filter((entry) => entry.provider === provider)
    .map(({ id, displayName, routeability }) => ({
      id,
      displayName,
      routeability
    }));
  const discoveredModel = {
    id: "claude-opus-6-0",
    displayName: null,
    routeability: { status: "supported" as const }
  };
  let persistCalls = 0;
  setDefaultPersistenceManager({
    async persistNow() {
      persistCalls += 1;
      return true;
    }
  } as unknown as RouterPersistence);
  const publishDiscovery = (discovery: ControlApiProviderModelDiscovery) =>
    setControlApiProviderModelDiscoverySource(() => ({
      schema: "autodev-control-provider-model-discovery-v1",
      source: "runtime-provider-discovery",
      providers: [{ provider, discovery }]
    }));
  try {
    configure();
    ROUTING_POLICY.setProviderAssignment(provider, role, {
      priority: 1,
      model: "sonnet"
    });
    publishDiscovery({
      status: "stale",
      source: "fixture provider listing",
      observedAt: "2026-10-14T11:00:00.000Z",
      lastAttemptAt: "2026-10-14T12:00:00.000Z",
      reason: "Provider model listing timed out.",
      models: [discoveredModel]
    });
    ROUTING_POLICY.setDiscoveredProviderModels(provider, [discoveredModel]);

    const preserved = await call(
      "PATCH",
      `${CONTROL_API_PATHS.providers}/${provider}/roles/${role}`,
      {
        actor: "operator-a",
        body: { priority: 2, model: "sonnet" }
      }
    );
    assert.equal(preserved.response.statusCode, 200);
    assert.equal(preserved.body.model, "sonnet");
    assert.equal(ROUTING_POLICY.assignmentFor(provider, role)?.priority, 2);

    const staleChoice = await call(
      "PATCH",
      `${CONTROL_API_PATHS.providers}/${provider}/roles/${role}`,
      {
        actor: "operator-a",
        body: { priority: 3, model: discoveredModel.id }
      }
    );
    assert.equal(staleChoice.response.statusCode, 400);

    publishDiscovery({
      status: "observed",
      source: "fixture provider listing",
      observedAt: "2026-10-14T12:01:00.000Z",
      lastAttemptAt: "2026-10-14T12:01:00.000Z",
      models: [discoveredModel]
    });
    const availableChoice = await call(
      "PATCH",
      `${CONTROL_API_PATHS.providers}/${provider}/roles/${role}`,
      {
        actor: "operator-a",
        body: { priority: 3, model: discoveredModel.id }
      }
    );
    assert.equal(availableChoice.response.statusCode, 200);
    assert.equal(availableChoice.body.model, discoveredModel.id);

    publishDiscovery({
      status: "unavailable",
      source: "fixture provider listing",
      lastAttemptAt: "2026-10-14T12:02:00.000Z",
      reason: "Provider model listing is unavailable."
    });
    ROUTING_POLICY.setDiscoveredProviderModels(provider, []);
    const preserveDuringOutage = await call(
      "PATCH",
      `${CONTROL_API_PATHS.providers}/${provider}/roles/${role}`,
      {
        actor: "operator-a",
        body: { priority: 1, model: discoveredModel.id }
      }
    );
    assert.equal(preserveDuringOutage.response.statusCode, 200);
    assert.equal(preserveDuringOutage.body.model, discoveredModel.id);

    const newUnobservedChoice = await call(
      "PATCH",
      `${CONTROL_API_PATHS.providers}/${provider}/roles/${role}`,
      {
        actor: "operator-a",
        body: { priority: 2, model: "claude-opus-6-1" }
      }
    );
    assert.equal(newUnobservedChoice.response.statusCode, 400);
    assert.ok(persistCalls >= 3);
  } finally {
    setControlApiProviderModelDiscoverySource(null);
    ROUTING_POLICY.setDiscoveredProviderModels(provider, previousDiscovered);
    if (previousAssignment)
      ROUTING_POLICY.setProviderAssignment(provider, role, previousAssignment);
    else ROUTING_POLICY.clearProviderAssignment(provider, role);
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
    const toolsReadOnly = await call("PATCH", CONTROL_API_PATHS.tools, {
      actor: "operator-a",
      body: {}
    });
    assert.equal(toolsReadOnly.response.statusCode, 405);

    const legacy = await call("POST", "/v1/providers/claude", {
      actor: "operator-a",
      body: { role: "subagent", enabled: false }
    });
    assert.notEqual(legacy.response.statusCode, 200);
  } finally {
    restoreEnv(saved);
  }
});

test("Tools catalog stays authoritative when the role projection is empty but the RuleSync MCP source is valid", async () => {
  const saved = saveEnv();
  const priorContract = getDefaultExecutionContract();
  try {
    configure();
    setExecutionContractForTests({
      roles: {},
      providers: {}
    } as ExecutionContract);
    const tools = await call("GET", CONTROL_API_PATHS.tools, {
      actor: "viewer-a"
    });
    assert.equal(tools.response.statusCode, 200);
    assert.equal(tools.body.schema, "autodev-control-tools-v2");
    // The composite read model still reports declared MCP/plugin tools
    // because the canonical RuleSync source is authoritative on its own.
    assert.equal(tools.body.coverage, "complete");
    assert.equal(tools.body.validity, "valid");
    // The contract was handed to the Runtime, so it was observed: the empty
    // role projection above is a measurement, not a missing read.
    assert.equal(tools.body.executionContractObserved, true);
    assert.equal(typeof tools.body.totalTools, "number");
    assert.ok(Array.isArray(tools.body.tools));
    assert.ok(
      tools.body.tools.every(
        (tool: { exposedRoles: readonly string[] }) =>
          Array.isArray(tool.exposedRoles) && tool.exposedRoles.length === 0
      )
    );
    assert.equal(tools.body.usageLink, "/usage");
    assert.equal(tools.body.readOnly, true);
  } finally {
    setExecutionContractForTests(priorContract);
    restoreEnv(saved);
  }
});

test("the tool catalogue's count is not observed when the execution contract was not read", async () => {
  const saved = saveEnv();
  const priorContract = getDefaultExecutionContract();
  const priorContractFile = process.env.CODEX_EXECUTION_CONTRACT_FILE;
  try {
    configure();
    // A contract path that exists but cannot be read: the accessor finds it,
    // fails to read it, and falls back to an empty contract. The roles it
    // would have contributed are then missing from the catalogue, so a count
    // over the catalogue is a count over a scope that was only partly read.
    const unreadable = mkdtempSync(join(tmpdir(), "autodev-contract-"));
    process.env.CODEX_EXECUTION_CONTRACT_FILE = unreadable;
    setExecutionContractForTests(null);
    const tools = await call("GET", CONTROL_API_PATHS.tools, {
      actor: "viewer-a"
    });
    assert.equal(tools.response.statusCode, 200);
    // The RuleSync catalogue was read, so the contract's is the one read that
    // failed -- and one unread read makes the count incomplete rather than
    // small. The count used to be a number, and it was exactly right for the
    // tools that arrived and merely incomplete for the ones the contract
    // would have contributed.
    assert.equal(tools.body.validity, "valid");
    assert.equal(tools.body.totalTools, null);
    // The read that failed is named, so the Console can say which half of the
    // catalogue it has. The accessor fell back to an empty contract, and an
    // empty contract and a contract nobody read look the same to every caller
    // that only sees the roles.
    assert.equal(tools.body.executionContractObserved, false);
    rmSync(unreadable, { recursive: true, force: true });
  } finally {
    if (priorContractFile === undefined) {
      delete process.env.CODEX_EXECUTION_CONTRACT_FILE;
    } else {
      process.env.CODEX_EXECUTION_CONTRACT_FILE = priorContractFile;
    }
    setExecutionContractForTests(priorContract);
    restoreEnv(saved);
  }
});

test("Agent enablement is Runtime-owned, revision-bound, and independent of provider assignments", async () => {
  const saved = saveEnv();
  const originalPersistence = getDefaultPersistenceManager();
  const priorContract = getDefaultExecutionContract();
  const previousPolicyState = ROUTING_POLICY.runtimeState();
  const previousAssignment = ROUTING_POLICY.assignmentFor("claude", "subagent");
  let failPersistence = false;
  let persistCalls = 0;
  let persistedDisabledAgentRoles: readonly string[] = [];
  setDefaultPersistenceManager({
    async persistNow() {
      persistCalls += 1;
      persistedDisabledAgentRoles =
        ROUTING_POLICY.runtimeState().disabledAgentRoles;
      if (failPersistence) throw new Error("disk failure");
      return true;
    }
  } as unknown as RouterPersistence);
  try {
    configure();
    ROUTING_POLICY.setAgentEnabled("worker", true);
    setExecutionContractForTests({
      ...priorContract,
      roles: {
        ...priorContract.roles,
        "unrouted-agent": { mcp: [] }
      }
    });

    const collection = await call("GET", CONTROL_API_PATHS.agents, {
      actor: "viewer-a"
    });
    assert.equal(collection.response.statusCode, 200);
    assert.equal(collection.body.readOnly, false);
    const worker = collection.body.agents.find(
      (agent: { role: string }) => agent.role === "worker"
    );
    assert.deepEqual(worker.enablement, {
      kind: "observed",
      enabled: true,
      mutable: true,
      revision: (
        await call("GET", `${CONTROL_API_PATHS.agents}/worker`, {
          actor: "viewer-a"
        })
      ).body.enablement.revision
    });

    const unrouted = await call(
      "GET",
      `${CONTROL_API_PATHS.agents}/unrouted-agent`,
      { actor: "viewer-a" }
    );
    assert.deepEqual(unrouted.body.enablement, {
      kind: "unavailable",
      enabled: null,
      mutable: false,
      reason:
        "This configured Agent has no matching AutoDev model-router alias, so Runtime cannot enforce its enablement."
    });

    const path = `${CONTROL_API_PATHS.agents}/worker`;
    const initial = await call("GET", path, { actor: "viewer-a" });
    const initialRevision = initial.body.enablement.revision;
    const denied = await call("PATCH", path, {
      actor: "viewer-a",
      body: { enabled: false, expectedRevision: initialRevision }
    });
    assert.equal(denied.response.statusCode, 403);
    assert.equal(ROUTING_POLICY.isAgentEnabled("worker"), true);

    const missingRevision = await call("PATCH", path, {
      actor: "operator-a",
      body: { enabled: false }
    });
    assert.equal(missingRevision.response.statusCode, 400);
    const unknownAgent = await call(
      "PATCH",
      `${CONTROL_API_PATHS.agents}/unknown-agent`,
      {
        actor: "operator-a",
        body: { enabled: false, expectedRevision: initialRevision }
      }
    );
    assert.equal(unknownAgent.response.statusCode, 404);
    const unavailableAgent = await call(
      "PATCH",
      `${CONTROL_API_PATHS.agents}/unrouted-agent`,
      {
        actor: "operator-a",
        body: { enabled: false, expectedRevision: "0".repeat(64) }
      }
    );
    assert.equal(unavailableAgent.response.statusCode, 409);
    assert.equal(
      unavailableAgent.body.error.code,
      "autodev_control_api_agent_alias_unavailable"
    );

    const changed = await call("PATCH", path, {
      actor: "operator-a",
      body: { enabled: false, expectedRevision: initialRevision }
    });
    assert.equal(changed.response.statusCode, 200);
    assert.equal(changed.body.enabled, false);
    assert.equal(changed.body.previous, true);
    assert.equal(changed.body.actor, "operator-a");
    assert.notEqual(changed.body.revision, initialRevision);
    assert.equal(changed.body.reconciliation.status.convergence, "converged");
    assert.deepEqual(persistedDisabledAgentRoles, ["worker"]);
    assert.deepEqual(
      ROUTING_POLICY.assignmentFor("claude", "subagent") ?? null,
      previousAssignment ?? null
    );

    const staleRevision = await call("PATCH", path, {
      actor: "operator-a",
      body: { enabled: true, expectedRevision: initialRevision }
    });
    assert.equal(staleRevision.response.statusCode, 409);
    assert.equal(
      staleRevision.body.error.code,
      "autodev_control_api_agent_enablement_conflict"
    );
    assert.equal(persistCalls, 1);
    assert.equal(ROUTING_POLICY.isAgentEnabled("worker"), false);

    const reenabled = await call("PATCH", path, {
      actor: "operator-a",
      body: { enabled: true, expectedRevision: changed.body.revision }
    });
    assert.equal(reenabled.response.statusCode, 200);
    assert.equal(reenabled.body.enabled, true);
    assert.notEqual(reenabled.body.revision, initialRevision);
    const reconciled = await call("GET", path, { actor: "viewer-a" });
    assert.equal(reconciled.body.convergence, "converged");

    const staleAfterRoundTrip = await call("PATCH", path, {
      actor: "operator-a",
      body: { enabled: false, expectedRevision: initialRevision }
    });
    assert.equal(
      staleAfterRoundTrip.response.statusCode,
      409,
      "a stale revision conflicts even after the enablement value returns to its old value"
    );
    assert.equal(persistCalls, 2);

    const disabledAgain = await call("PATCH", path, {
      actor: "operator-a",
      body: { enabled: false, expectedRevision: reenabled.body.revision }
    });
    assert.equal(disabledAgain.response.statusCode, 200);
    assert.equal(disabledAgain.body.enabled, false);

    ROUTING_POLICY.setAgentEnabled("worker", true);
    const drifted = await call("GET", path, { actor: "viewer-a" });
    assert.equal(
      drifted.body.convergence,
      "pending",
      "the current runtime state must be compared with the last observed apply"
    );
    ROUTING_POLICY.setAgentEnabled("worker", false);

    const disabled = await call("GET", path, { actor: "viewer-a" });
    failPersistence = true;
    const failed = await call("PATCH", path, {
      actor: "operator-a",
      body: {
        enabled: true,
        expectedRevision: disabled.body.enablement.revision
      }
    });
    assert.equal(failed.response.statusCode, 500);
    assert.equal(ROUTING_POLICY.isAgentEnabled("worker"), false);
    assert.equal(persistCalls, 4);
  } finally {
    setExecutionContractForTests(priorContract);
    ROUTING_POLICY.restoreRuntimeState(previousPolicyState);
    setDefaultPersistenceManager(originalPersistence);
    restoreEnv(saved);
  }
});

test("Agent detail and mutation paths canonicalize role aliases before applying policy", async () => {
  const saved = saveEnv();
  const originalPersistence = getDefaultPersistenceManager();
  const previousPolicyState = ROUTING_POLICY.runtimeState();
  setDefaultPersistenceManager({
    async persistNow() {
      return true;
    }
  } as unknown as RouterPersistence);
  try {
    configure();
    ROUTING_POLICY.setAgentEnabled("worker", true);
    const path = `${CONTROL_API_PATHS.agents}/WORKER`;
    const detail = await call("GET", path, { actor: "viewer-a" });
    assert.equal(detail.response.statusCode, 200);
    assert.equal(detail.body.role, "worker");

    const changed = await call("PATCH", path, {
      actor: "operator-a",
      body: {
        enabled: false,
        expectedRevision: detail.body.enablement.revision
      }
    });
    assert.equal(changed.response.statusCode, 200);
    assert.equal(changed.body.role, "worker");
    assert.equal(ROUTING_POLICY.isAgentEnabled("worker"), false);
  } finally {
    ROUTING_POLICY.restoreRuntimeState(previousPolicyState);
    setDefaultPersistenceManager(originalPersistence);
    restoreEnv(saved);
  }
});

test("concurrent Agent enablement writes compare revisions after the prior persist completes", async () => {
  const saved = saveEnv();
  const originalPersistence = getDefaultPersistenceManager();
  const previousPolicyState = ROUTING_POLICY.runtimeState();
  const { promise: firstPersist, resolve: releaseFirstPersist } =
    Promise.withResolvers<boolean>();
  const { promise: firstPersistStarted, resolve: signalFirstPersist } =
    Promise.withResolvers<void>();
  let persistCalls = 0;
  let firstPatch: Promise<any> | null = null;
  let secondPatch: Promise<any> | null = null;
  setDefaultPersistenceManager({
    async persistNow() {
      persistCalls += 1;
      if (persistCalls === 1) {
        signalFirstPersist();
        return firstPersist;
      }
      return true;
    }
  } as unknown as RouterPersistence);
  try {
    configure();
    ROUTING_POLICY.setAgentEnabled("worker", true);
    const path = `${CONTROL_API_PATHS.agents}/worker`;
    const initial = await call("GET", path, { actor: "viewer-a" });
    firstPatch = call("PATCH", path, {
      actor: "operator-a",
      body: {
        enabled: false,
        expectedRevision: initial.body.enablement.revision
      }
    });
    await firstPersistStarted;

    // A read can see the in-flight desired value, but a second mutation for
    // this role must wait until that value has either persisted or rolled back.
    const inFlight = await call("GET", path, { actor: "viewer-a" });
    assert.equal(inFlight.body.enablement.enabled, false);
    secondPatch = call("PATCH", path, {
      actor: "operator-a",
      body: {
        enabled: true,
        expectedRevision: inFlight.body.enablement.revision
      }
    });
    const nextTurn = Promise.withResolvers<void>();
    setImmediate(nextTurn.resolve);
    await nextTurn.promise;
    assert.equal(persistCalls, 1);

    releaseFirstPersist(true);
    const [first, second] = await Promise.all([firstPatch, secondPatch]);
    assert.equal(first.response.statusCode, 200);
    assert.equal(second.response.statusCode, 200);
    assert.equal(ROUTING_POLICY.isAgentEnabled("worker"), true);
    assert.equal(persistCalls, 2);
  } finally {
    releaseFirstPersist(true);
    await Promise.all([firstPatch, secondPatch].filter(Boolean));
    ROUTING_POLICY.restoreRuntimeState(previousPolicyState);
    setDefaultPersistenceManager(originalPersistence);
    restoreEnv(saved);
  }
});

test("Control API surfaces all 13 typed resource families", async () => {
  const saved = saveEnv();
  try {
    configure();

    // 1. Agents collection and detail
    const agents = await call("GET", CONTROL_API_PATHS.agents, {
      actor: "viewer-a"
    });
    assert.equal(agents.response.statusCode, 200);
    assert.equal(agents.body.schema, "autodev-control-agents-v2");
    assert.ok(agents.body.totalAgents > 0);
    assert.ok(Array.isArray(agents.body.agents));
    const configuredAgent = agents.body.agents.find(
      (agent: { role: string }) => agent.role === "orchestrator"
    );
    assert.ok(configuredAgent);
    assert.equal(
      configuredAgent.status,
      "configured",
      "configuration without successful provider health evidence is not ready"
    );
    assert.equal(configuredAgent.valid, true);
    assert.equal(configuredAgent.convergence, "not-observed");

    const agentDetail = await call(
      "GET",
      CONTROL_API_PATHS.agents + "/orchestrator",
      { actor: "viewer-a" }
    );
    assert.equal(agentDetail.response.statusCode, 200);
    assert.equal(agentDetail.body.schema, "autodev-control-agent-detail-v3");
    assert.equal(agentDetail.body.role, "orchestrator");
    assert.equal(agentDetail.body.kind, "orchestrator");
    assert.equal(agentDetail.body.status, "configured");
    assert.equal(agentDetail.body.valid, true);
    assert.equal(agentDetail.body.convergence, "not-observed");

    const unknownAgent = await call(
      "GET",
      CONTROL_API_PATHS.agents + "/nonexistent-role-xyz",
      { actor: "viewer-a" }
    );
    assert.equal(unknownAgent.response.statusCode, 404);

    const agentPost = await call("POST", CONTROL_API_PATHS.agents, {
      actor: "operator-a",
      body: {}
    });
    assert.equal(agentPost.response.statusCode, 405);

    // 2. Providers
    const providers = await call("GET", CONTROL_API_PATHS.providers, {
      actor: "viewer-a"
    });
    assert.equal(providers.response.statusCode, 200);
    assert.equal(providers.body.schema, "autodev-control-providers-v3");

    // 3. Models
    const models = await call("GET", CONTROL_API_PATHS.models, {
      actor: "viewer-a"
    });
    assert.equal(models.response.statusCode, 200);
    assert.equal(models.body.schema, "autodev-control-models-v2");
    assert.ok(models.body.models.length > 0);

    // 4. MCPs
    const mcps = await call("GET", CONTROL_API_PATHS.mcps, {
      actor: "viewer-a"
    });
    assert.equal(mcps.response.statusCode, 200);
    assert.equal(mcps.body.schema, "autodev-control-mcps-v2");
    assert.equal(mcps.body.source, ".rulesync/mcp.jsonc");
    assert.equal(mcps.body.valid, true);
    assert.ok(
      mcps.body.servers.some(
        (server: { name: string }) => server.name === "lsp"
      )
    );
    const isolatedTargetMcp = mcps.body.servers.find(
      (server: { name: string }) => server.name === "autodev_spawn"
    );
    assert.ok(isolatedTargetMcp);
    assert.equal(isolatedTargetMcp.transport, "stdio");
    assert.equal(isolatedTargetMcp.enabled, null);
    assert.equal(isolatedTargetMcp.declared, true);
    assert.ok(
      isolatedTargetMcp.targetOverrides.some(
        (override: { target: string; enabled: boolean }) =>
          override.target === "antigravity-cli" && override.enabled
      )
    );
    const context7 = mcps.body.servers.find(
      (server: { name: string }) => server.name === "context7"
    );
    assert.ok(context7);
    assert.equal(context7.enabled, true);
    assert.deepEqual(context7.targetOverrides, [
      { target: "codexcli", enabled: false }
    ]);
    assert.doesNotMatch(
      JSON.stringify(mcps.body),
      /CONTEXT7_API_KEY|MCP_TOKEN|bearer_token/u
    );

    // 5. Tools: composite read model joining RuleSync MCP declarations with
    // the execution-contract role projection; per-tool historical use/error
    // evidence lives on the dedicated Usage path and is not synthesized here.
    const tools = await call("GET", CONTROL_API_PATHS.tools, {
      actor: "viewer-a"
    });
    assert.equal(tools.response.statusCode, 200);
    assert.equal(tools.body.schema, "autodev-control-tools-v2");
    assert.equal(tools.body.source, ".rulesync/mcp.jsonc");
    assert.equal(tools.body.readOnly, true);
    assert.ok(["complete", "partial"].includes(tools.body.coverage));
    assert.equal(tools.body.validity, "valid");
    assert.equal(tools.body.usageLink, "/usage");
    assert.equal(typeof tools.body.totalTools, "number");
    const webSearch = tools.body.tools.find(
      (tool: { name: string; source: string; sourceAuthority: string }) =>
        tool.name === "web_search" &&
        tool.source === "native" &&
        tool.sourceAuthority === "codex-native"
    );
    assert.ok(webSearch);
    assert.ok(webSearch.exposedRoles.includes("docs-researcher"));
    assert.equal(webSearch.availability, "configured");
    assert.ok(webSearch.canonicalEditSurface);
    const appTool = tools.body.tools.find(
      (tool: { name: string; source: string; sourceAuthority: string }) =>
        tool.name === "request_user_input" &&
        tool.source === "plugin" &&
        tool.sourceAuthority === "rulesync-plugin"
    );
    assert.ok(appTool);
    assert.ok(appTool.exposedRoles.includes("orchestrator"));
    assert.equal("status" in webSearch, false);
    // The RuleSync plugin entry for codex_app surfaces through the
    // composite catalog so the Console can pivot to its canonical edit
    // surface (MCP codex_app) without inventing per-tool evidence.
    assert.ok(
      tools.body.tools.some(
        (tool: { source: string; sourceAuthority: string; server?: string }) =>
          tool.source === "plugin" &&
          tool.sourceAuthority === "rulesync-plugin" &&
          tool.server === "codex_app"
      )
    );
    // The payload must never invent per-tool use/error evidence.
    assert.ok(
      tools.body.tools.every(
        (tool: { usage?: unknown }) => tool.usage === undefined
      )
    );

    // 6. Skills
    const skills = await call("GET", CONTROL_API_PATHS.skills, {
      actor: "viewer-a"
    });
    assert.equal(skills.response.statusCode, 200);
    assert.equal(skills.body.schema, "autodev-control-skills-v2");
    assert.equal(skills.body.source, ".rulesync/skills+execution-contract");
    // The skills collection has canonical write paths -- role assignment and
    // the canonical source -- so the Runtime must not claim it is read-only.
    // The flag used to be a stale constant that predated both write paths.
    assert.equal(skills.body.readOnly, false);
    const canonicalSkills = new RuleSyncRepository().loadSkills();
    assert.equal(canonicalSkills.valid, true);
    assert.equal(skills.body.valid, true);
    assert.deepEqual(
      skills.body.skills.map(
        (skill: { name: string; description: string; path: string }) => ({
          name: skill.name,
          description: skill.description,
          path: skill.path
        })
      ),
      canonicalSkills.skills
    );
    const executionRoles = getDefaultExecutionContract().roles ?? {};
    assert.deepEqual(
      skills.body.skills.map(
        (skill: { name: string; roles: readonly string[] }) => ({
          name: skill.name,
          roles: skill.roles
        })
      ),
      canonicalSkills.skills.map((skill) => ({
        name: skill.name,
        roles: Object.entries(executionRoles)
          .filter(([, raw]) => {
            if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
              return false;
            }
            const values = (raw as Record<string, unknown>).skills;
            return Array.isArray(values) && values.includes(skill.name);
          })
          .map(([role]) => role)
          .sort()
      }))
    );
    assert.deepEqual(skills.body.unresolvedAssignments, []);

    // 7. Hooks
    const hooks = await call("GET", CONTROL_API_PATHS.hooks, {
      actor: "viewer-a"
    });
    assert.equal(hooks.response.statusCode, 200);
    assert.equal(hooks.body.schema, "autodev-control-hooks-v2");
    assert.equal(hooks.body.valid, true);
    assert.equal(hooks.body.target, "codexcli");
    assert.ok(
      typeof hooks.body.revision === "string" && hooks.body.revision.length > 0,
      "the hook declaration publishes the revision a write compares against"
    );
    assert.ok(
      Array.isArray(hooks.body.events) && hooks.body.events.length > 0,
      "the hook declaration publishes the events the target receives"
    );

    // 8. Permissions
    const permissions = await call("GET", CONTROL_API_PATHS.permissions, {
      actor: "viewer-a"
    });
    assert.equal(permissions.response.statusCode, 200);
    assert.equal(permissions.body.schema, "autodev-control-permissions-v2");
    // The policy is read from the canonical source that states it. The
    // portable source declares these two, and the response used to publish
    // literals that happened to agree with it -- so a policy the operator had
    // changed was still published as the old one.
    const canonicalPolicy = parse(
      readFileSync(
        join(
          fileURLToPath(new URL("../../", import.meta.url)),
          "config",
          "config.autodev.toml"
        ),
        "utf8"
      )
    ) as Record<string, unknown>;
    assert.equal(
      permissions.body.policy.approvalPolicy,
      canonicalPolicy.approval_policy
    );
    assert.equal(
      permissions.body.policy.sandboxMode,
      canonicalPolicy.sandbox_mode
    );
    assert.equal(permissions.body.policyStatus, "valid");
    assert.ok(
      typeof permissions.body.revision === "string" &&
        permissions.body.revision.length === 64,
      "the permission policy publishes the revision a write compares against"
    );

    // The effective capability matrix must be a real projection of the
    // execution contract, not an absent value the Console would render as
    // "None". It is the same join `/control/agents` exposes, so a role's
    // permissions page can never contradict its Agents row.
    assert.ok(
      Object.keys(permissions.body.rolePermissions).length > 0,
      "rolePermissions must project at least one role"
    );
    for (const [role, entry] of Object.entries(
      permissions.body.rolePermissions
    ) as Array<[string, Record<string, unknown>]>) {
      assert.ok(
        Array.isArray(entry.mcp),
        `role ${role} must project an mcp list`
      );
      assert.ok(
        Array.isArray(entry.skills),
        `role ${role} must project a skills list`
      );
      assert.ok(
        (entry.mcp as unknown[]).every((value) => typeof value === "string"),
        `role ${role} mcp entries must be strings`
      );
      assert.ok(
        (entry.skills as unknown[]).every((value) => typeof value === "string"),
        `role ${role} skill entries must be strings`
      );
      // A role's sandbox is what its own declaration states. The projection
      // keeps a boolean instead, and the runtime answered every role but the
      // read-only ones with "workspace-write" -- so the orchestrator, declared
      // `danger-full-access`, was published as a sandboxed role.
      assert.ok(
        entry.sandboxMode === null ||
          ["read-only", "workspace-write", "unrestricted"].includes(
            entry.sandboxMode as string
          ),
        `role ${role} must publish a sandbox the product supports`
      );
    }
    // The orchestrator is the product's unsandboxed role. It must say so.
    assert.equal(
      permissions.body.rolePermissions.orchestrator?.sandboxMode,
      "unrestricted",
      "the orchestrator declares danger-full-access and must be published as unrestricted"
    );
    const agentsForComparison = await call("GET", CONTROL_API_PATHS.agents, {
      actor: "viewer-a"
    });
    for (const agent of agentsForComparison.body.agents) {
      const entry = permissions.body.rolePermissions[agent.role];
      assert.ok(
        entry,
        `agent ${agent.role} must have a permissions matrix entry`
      );
      assert.deepEqual(
        entry.skills,
        agent.skills,
        `role ${agent.role} skills must match its agent record`
      );
      assert.deepEqual(
        entry.mcp,
        agent.mcps,
        `role ${agent.role} mcp servers must match its agent record`
      );
    }

    // 9. Prompts collection and detail
    const prompts = await call("GET", CONTROL_API_PATHS.prompts, {
      actor: "viewer-a"
    });
    assert.equal(prompts.response.statusCode, 200);
    assert.equal(prompts.body.schema, "autodev-control-prompts-v2");
    assert.equal(prompts.body.valid, true);
    assert.equal(prompts.body.source, ".rulesync/commands");
    assert.ok(prompts.body.totalCommands > 0);

    const promptDetail = await call("GET", CONTROL_API_PATHS.prompts + "/dry", {
      actor: "viewer-a"
    });
    assert.equal(promptDetail.response.statusCode, 200);
    assert.equal(promptDetail.body.schema, "autodev-control-prompt-detail-v4");
    assert.equal(promptDetail.body.name, "dry");

    const unknownPrompt = await call(
      "GET",
      CONTROL_API_PATHS.prompts + "/nonexistent-prompt-xyz",
      { actor: "viewer-a" }
    );
    assert.equal(unknownPrompt.response.statusCode, 404);

    // 10. Workspaces
    const workspaces = await call("GET", CONTROL_API_PATHS.workspaces, {
      actor: "viewer-a"
    });
    assert.equal(workspaces.response.statusCode, 200);
    assert.equal(workspaces.body.schema, "autodev-control-workspaces-v3");

    // 11. Routing
    const routing = await call("GET", CONTROL_API_PATHS.routing, {
      actor: "viewer-a"
    });
    assert.equal(routing.response.statusCode, 200);
    assert.equal(routing.body.schema, "autodev-control-routing-v1");
    assert.ok(Array.isArray(routing.body.routes));

    // 12. Runtime
    const runtime = await call("GET", CONTROL_API_PATHS.runtime, {
      actor: "viewer-a"
    });
    assert.equal(runtime.response.statusCode, 200);
    assert.equal(runtime.body.schema, "autodev-control-runtime-v2");

    // 13. GitHub: parsed workflow definitions/triggers only; never live
    // Actions API facts.
    const github = await call("GET", CONTROL_API_PATHS.github, {
      actor: "viewer-a"
    });
    assert.equal(github.response.statusCode, 200);
    assert.equal(github.body.schema, "autodev-control-github-v1");
    assert.equal(github.body.source, ".github/workflows");
    assert.equal(github.body.readOnly, true);
    assert.equal(github.body.catalogStatus, "valid");
    assert.equal(github.body.runtimeFactsAvailable, false);
    assert.ok(Array.isArray(github.body.workflows));
    const scheduler = github.body.workflows.find(
      (workflow: { id: string }) => workflow.id === "_scheduler.yml"
    );
    assert.ok(scheduler);
    assert.deepEqual(scheduler.schedules, ["*/15 * * * *"]);
    assert.ok(scheduler.events.includes("workflow_dispatch"));

    const githubMutation = await call("PATCH", CONTROL_API_PATHS.github, {
      actor: "operator-a",
      body: {}
    });
    assert.equal(githubMutation.response.statusCode, 405);
  } finally {
    restoreEnv(saved);
  }
});

test("Agent readiness uses observed provider health rather than configuration alone", async () => {
  const saved = saveEnv();
  const previousPolicyState = ROUTING_POLICY.runtimeState();
  const routeCredentialKeys: string[] = [
    ...new Set(
      ROUTES.flatMap((route) =>
        typeof route.envKey === "string" ? [route.envKey] : []
      )
    )
  ];
  const previousRouteCredentials = Object.fromEntries(
    routeCredentialKeys.map((key) => [key, process.env[key]])
  );
  try {
    configure();
    for (const key of routeCredentialKeys) {
      process.env[key] = "provider-health-fixture-credential";
    }
    ROUTING_POLICY.setAgentEnabled("worker", true);

    const health = (
      overrides: Partial<ControlApiProviderHealth> = {}
    ): ControlApiProviderHealth => ({
      cooldown: null,
      failureStreak: 0,
      probeFailureStreak: 0,
      inFlightRequests: 0,
      activeAgents: 0,
      attempts: 0,
      successes: 0,
      failures: 0,
      lastSuccessAt: null,
      lastFailure: null,
      ...overrides
    });
    const healthy: Record<string, ControlApiProviderHealth> =
      Object.fromEntries(
        ROUTES.map((route) => [
          route.provider,
          health({
            attempts: 1,
            successes: 1,
            lastSuccessAt: "2026-10-19T12:00:00.000Z"
          })
        ])
      );
    setControlApiProviderHealthSource(() => healthy);
    const ready = await call("GET", `${CONTROL_API_PATHS.agents}/worker`, {
      actor: "viewer-a"
    });
    assert.equal(ready.body.status, "ready");

    setControlApiProviderHealthSource(() => ({}));
    const unobserved = await call("GET", `${CONTROL_API_PATHS.agents}/worker`, {
      actor: "viewer-a"
    });
    assert.equal(unobserved.body.status, "configured");

    setControlApiProviderHealthSource(() =>
      Object.fromEntries(
        ROUTES.map((route) => [
          route.provider,
          health({
            cooldown: {
              kind: "probe",
              failureClass: "probe_unavailable",
              until: "2026-10-19T12:05:00.000Z",
              resetsAt: null,
              lastResortEligible: false
            },
            probeFailureStreak: 1
          })
        ])
      )
    );
    const unavailable = await call(
      "GET",
      `${CONTROL_API_PATHS.agents}/worker`,
      { actor: "viewer-a" }
    );
    assert.equal(unavailable.body.status, "unavailable");
  } finally {
    setControlApiProviderHealthSource(null);
    ROUTING_POLICY.restoreRuntimeState(previousPolicyState);
    for (const key of routeCredentialKeys) {
      const value = previousRouteCredentials[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    restoreEnv(saved);
  }
});

test("Control API prompts listing projects the canonical RuleSyncRepository.loadCommands output", async () => {
  const saved = saveEnv();
  try {
    configure();
    const commandState = new RuleSyncRepository().loadCommands();
    assert.equal(commandState.valid, true);
    const expectedCommands = commandState.commands.map((command) => ({
      name: command.name,
      path: command.path,
      ...(command.description === undefined
        ? {}
        : { description: command.description })
    }));
    assert.ok(expectedCommands.length > 0);

    const prompts = await call("GET", CONTROL_API_PATHS.prompts, {
      actor: "viewer-a"
    });
    assert.equal(prompts.response.statusCode, 200);
    assert.equal(prompts.body.schema, "autodev-control-prompts-v2");
    assert.equal(prompts.body.source, ".rulesync/commands");
    assert.equal(prompts.body.valid, true);
    // The prompts collection has a canonical write path -- the command's own
    // source -- so the Runtime must not claim it is read-only. The flag used
    // to be a stale constant that predated the write path.
    assert.equal(prompts.body.readOnly, false);
    assert.equal(prompts.body.totalCommands, expectedCommands.length);
    assert.deepEqual(prompts.body.commands, expectedCommands);

    // The listing projection must strip content so it matches what
    // RuleSyncRepository.loadCommands returns without exposing file bodies.
    for (const command of prompts.body.commands) {
      assert.equal(Object.hasOwn(command, "content"), false);
      assert.deepEqual(Object.keys(command).sort(), [
        "description",
        "name",
        "path"
      ]);
    }
  } finally {
    restoreEnv(saved);
  }
});

test("Control API exposes bounded Git prompt history and selected-version diff as read-only data", async () => {
  const saved = saveEnv();
  const repositoryRoot = mkdtempSync(
    join(tmpdir(), "autodev-prompt-history-control-")
  );
  try {
    configure();
    const commandsDir = join(repositoryRoot, ".rulesync", "commands");
    mkdirSync(commandsDir, { recursive: true });
    const commandPath = join(commandsDir, "audit.md");
    const canonical =
      "---\ntargets: [codexcli]\ndescription: Review source.\n---\n\n# Audit\n\nReview the source.\n";
    await writeFileSync(commandPath, canonical);
    execFileSync("git", ["-C", repositoryRoot, "init", "-q"]);
    execFileSync("git", ["-C", repositoryRoot, "config", "user.name", "Tests"]);
    execFileSync("git", [
      "-C",
      repositoryRoot,
      "config",
      "user.email",
      "tests@example.invalid"
    ]);
    execFileSync("git", [
      "-C",
      repositoryRoot,
      "add",
      ".rulesync/commands/audit.md"
    ]);
    execFileSync("git", [
      "-C",
      repositoryRoot,
      "commit",
      "-q",
      "-m",
      "Initial command"
    ]);
    await writeFileSync(
      commandPath,
      canonical.replace("Review the source.", "Review the current source.")
    );

    const options = { repositoryRoot };
    const list = await call(
      "GET",
      `${CONTROL_API_PATHS.prompts}/audit/versions`,
      { actor: "viewer-a" },
      options
    );
    assert.equal(list.response.statusCode, 200);
    assert.equal(list.body.schema, "autodev-control-prompt-versions-v2");
    assert.equal(list.body.name, "audit");
    assert.equal(list.body.status, "available");
    assert.equal(list.body.hasMore, false);
    assert.equal(list.body.offset, 0);
    assert.equal(list.body.limit, 20);
    assert.equal(list.body.versions.length, 1);
    const revision = list.body.versions[0].versionHash as string;

    const version = await call(
      "GET",
      `${CONTROL_API_PATHS.prompts}/audit/versions/${revision}`,
      { actor: "viewer-a" },
      options
    );
    assert.equal(version.response.statusCode, 200);
    assert.equal(version.body.schema, "autodev-control-prompt-version-v1");
    assert.equal(version.body.name, "audit");
    assert.equal(version.body.versionHash, revision);
    assert.equal(version.body.content, canonical);
    assert.match(version.body.diff, /-Review the source\./u);
    assert.match(version.body.diff, /\+Review the current source\./u);

    const mutation = await call(
      "PATCH",
      `${CONTROL_API_PATHS.prompts}/audit/versions/${revision}`,
      { actor: "operator-a", body: {} },
      options
    );
    assert.equal(mutation.response.statusCode, 405);
    assert.equal(mutation.response.headers.allow, "GET");

    const unavailableRepository = mkdtempSync(
      join(tmpdir(), "autodev-prompt-history-no-git-")
    );
    try {
      const noGitCommands = join(
        unavailableRepository,
        ".rulesync",
        "commands"
      );
      mkdirSync(noGitCommands, { recursive: true });
      writeFileSync(
        join(noGitCommands, "audit.md"),
        "---\ndescription: Review source.\n---\n\n# Audit\n"
      );
      const unavailable = await call(
        "GET",
        `${CONTROL_API_PATHS.prompts}/audit/versions`,
        { actor: "viewer-a" },
        { repositoryRoot: unavailableRepository }
      );
      assert.equal(unavailable.response.statusCode, 200);
      assert.equal(unavailable.body.status, "unavailable");
      assert.deepEqual(unavailable.body.versions, []);
    } finally {
      rmSync(unavailableRepository, { recursive: true, force: true });
    }
  } finally {
    restoreEnv(saved);
    rmSync(repositoryRoot, { recursive: true, force: true });
  }
});

test("Control API pages prompt history and opens a revision from an older page", async () => {
  // The history is one ordered list, so the page is a window onto it. A
  // revision the operator reached by paging back is older than the newest
  // page, and it has to open: the page is how the operator found it, not a
  // limit on which revisions exist.
  const saved = saveEnv();
  const repositoryRoot = mkdtempSync(
    join(tmpdir(), "autodev-prompt-history-page-control-")
  );
  try {
    configure();
    const commandsDir = join(repositoryRoot, ".rulesync", "commands");
    mkdirSync(commandsDir, { recursive: true });
    const commandPath = join(commandsDir, "audit.md");
    execFileSync("git", ["-C", repositoryRoot, "init", "-q"]);
    execFileSync("git", ["-C", repositoryRoot, "config", "user.name", "Tests"]);
    execFileSync("git", [
      "-C",
      repositoryRoot,
      "config",
      "user.email",
      "tests@example.invalid"
    ]);

    const revisions: string[] = [];
    for (let revision = 0; revision < 25; revision += 1) {
      writeFileSync(
        commandPath,
        `---\ntargets: [codexcli]\ndescription: Audit revision ${revision}.\n---\n\n# Audit\n\nRevision ${revision}.\n`
      );
      execFileSync("git", [
        "-C",
        repositoryRoot,
        "add",
        ".rulesync/commands/audit.md"
      ]);
      execFileSync("git", [
        "-C",
        repositoryRoot,
        "commit",
        "-q",
        "-m",
        `Command revision ${revision}`
      ]);
      revisions.push(
        execFileSync("git", ["-C", repositoryRoot, "rev-parse", "HEAD"], {
          encoding: "utf8"
        }).trim()
      );
    }

    const options = { repositoryRoot };
    const newest = await call(
      "GET",
      `${CONTROL_API_PATHS.prompts}/audit/versions`,
      { actor: "viewer-a" },
      options
    );
    assert.equal(newest.response.statusCode, 200);
    assert.equal(newest.body.hasMore, true);
    assert.equal(newest.body.offset, 0);
    assert.equal(newest.body.limit, 20);
    assert.equal(newest.body.versions.length, 20);
    assert.equal(newest.body.versions[0].versionHash, revisions[24]);

    const older = await call(
      "GET",
      `${CONTROL_API_PATHS.prompts}/audit/versions?offset=20`,
      { actor: "viewer-a" },
      options
    );
    assert.equal(older.response.statusCode, 200);
    assert.equal(older.body.hasMore, false);
    assert.equal(older.body.offset, 20);
    assert.equal(older.body.limit, 20);
    assert.equal(older.body.versions.length, 5);
    assert.equal(older.body.versions[0].versionHash, revisions[4]);

    // A revision from the older page opens like any other.
    const oldest = revisions[0];
    assert.ok(oldest);
    const version = await call(
      "GET",
      `${CONTROL_API_PATHS.prompts}/audit/versions/${oldest}`,
      { actor: "viewer-a" },
      options
    );
    assert.equal(version.response.statusCode, 200);
    assert.equal(version.body.versionHash, oldest);
    assert.match(version.body.content, /Revision 0\./u);

    // A page the repository cannot answer is refused rather than clamped.
    for (const query of [
      "offset=-1",
      "offset=1.5",
      "offset=abc",
      "limit=0",
      "limit=101",
      "page=2"
    ]) {
      const refused = await call(
        "GET",
        `${CONTROL_API_PATHS.prompts}/audit/versions?${query}`,
        { actor: "viewer-a" },
        options
      );
      assert.equal(
        refused.response.statusCode,
        400,
        `expected ${query} to be refused`
      );
      assert.equal(
        refused.body.error.code,
        "autodev_control_api_prompt_history_page_invalid"
      );
    }
  } finally {
    restoreEnv(saved);
    rmSync(repositoryRoot, { recursive: true, force: true });
  }
});

test("Control API prompt detail serves the canonical command content from RuleSyncRepository.loadCommands", async () => {
  const saved = saveEnv();
  try {
    configure();
    const assets = new RuleSyncRepository().loadCommands();
    assert.equal(assets.valid, true);
    assert.ok(assets.commands.length > 0);
    const target = assets.commands[0];
    assert.ok(target);

    const detail = await call(
      "GET",
      CONTROL_API_PATHS.prompts + "/" + encodeURIComponent(target.name),
      { actor: "viewer-a" }
    );
    assert.equal(detail.response.statusCode, 200);
    assert.equal(detail.body.schema, "autodev-control-prompt-detail-v4");
    assert.equal(detail.body.name, target.name);
    assert.equal(detail.body.type, "command");
    assert.equal(detail.body.source, target.path);
    assert.equal(detail.body.content, target.content);
    assert.equal(detail.body.preview, target.prompt);
    assert.equal(detail.body.revision, target.revision);

    // The detail surface contains only canonical content, its revision,
    // the bounded diff summary, and the reconciliation view.
    assert.deepEqual(Object.keys(detail.body).sort(), [
      "content",
      "diff",
      "name",
      "preview",
      "reconciliation",
      "revision",
      "schema",
      "source",
      "type"
    ]);
  } finally {
    restoreEnv(saved);
  }
});

test("operator Prompt PATCH validates source, applies the Rulesync projection, and audits only metadata", async () => {
  const saved = saveEnv();
  const repositoryRoot = mkdtempSync(
    join(tmpdir(), "autodev-prompt-control-repository-")
  );
  const codexHome = mkdtempSync(join(tmpdir(), "autodev-prompt-control-home-"));
  const commandsDir = join(repositoryRoot, ".rulesync", "commands");
  try {
    configure();
    cpSync(join(process.cwd(), ".rulesync", "commands"), commandsDir, {
      recursive: true
    });
    symlinkSync(
      resolve(process.cwd(), "node_modules"),
      join(repositoryRoot, "node_modules"),
      "dir"
    );

    const source = new RuleSyncRepository(repositoryRoot).loadCommands();
    assert.equal(source.valid, true);
    const current = source.commands.find((command) => command.name === "dry");
    assert.ok(current);
    const content =
      '---\ntargets: ["*"]\ndescription: Edited through AutoDev Console.\n---\n\n# Edited command\n\nA canonical edit reaches the generated Codex prompt.\n';
    const runtimeOptions = { repositoryRoot, codexHome };

    const viewerAttempt = await call(
      "PATCH",
      CONTROL_API_PATHS.prompts + "/dry",
      {
        actor: "viewer-a",
        body: { content, expectedRevision: current.revision }
      },
      runtimeOptions
    );
    assert.equal(viewerAttempt.response.statusCode, 403);
    assert.equal(
      new RuleSyncRepository(repositoryRoot)
        .loadCommands()
        .commands.find((command) => command.name === "dry")?.revision,
      current.revision
    );

    const { result, lines } = await captureAudit(() =>
      call(
        "PATCH",
        CONTROL_API_PATHS.prompts + "/dry",
        {
          actor: "operator-a",
          body: { content, expectedRevision: current.revision }
        },
        runtimeOptions
      )
    );
    assert.equal(result.response.statusCode, 200);
    assert.equal(result.body.schema, "autodev-control-prompt-command-patch-v2");
    assert.equal(result.body.name, "dry");
    assert.match(result.body.revision, /^[a-f0-9]{64}$/u);
    assert.equal(result.body.changed, true);
    assert.equal(result.body.diff.summary.length > 0, true);
    assert.equal(result.body.diff.identifier.length, 64);
    assert.equal(result.body.reconciliation.status.convergence, "converged");
    assert.equal(
      result.body.reconciliation.status.desiredGeneration,
      result.body.reconciliation.status.observedGeneration
    );
    assert.equal(result.body.reconciliation.status.lastError, null);
    assert.equal(result.body.reconciliation.history.length > 0, true);
    assert.doesNotMatch(lines.join(""), /A canonical edit reaches/u);
    assert.equal(
      new RuleSyncRepository(repositoryRoot)
        .loadCommands()
        .commands.find((command) => command.name === "dry")?.content,
      content
    );
    assert.match(
      readFileSync(join(codexHome, "prompts", "dry.md"), "utf8"),
      /A canonical edit reaches the generated Codex prompt\./u
    );

    const detail = await call(
      "GET",
      CONTROL_API_PATHS.prompts + "/dry",
      { actor: "viewer-a" },
      runtimeOptions
    );
    assert.equal(detail.response.statusCode, 200);
    assert.equal(detail.body.schema, "autodev-control-prompt-detail-v4");
    assert.equal(detail.body.revision, result.body.revision);
    assert.equal(detail.body.content, content);
    assert.equal(
      detail.body.preview,
      "# Edited command\n\nA canonical edit reaches the generated Codex prompt."
    );

    const invalidSource = await call(
      "PATCH",
      CONTROL_API_PATHS.prompts + "/dry",
      {
        actor: "operator-a",
        body: {
          content: "not frontmatter",
          expectedRevision: result.body.revision
        }
      },
      runtimeOptions
    );
    assert.equal(invalidSource.response.statusCode, 400);
    assert.equal(
      invalidSource.body.error.code,
      "autodev_control_prompt_invalid_source"
    );
    assert.equal(
      new RuleSyncRepository(repositoryRoot)
        .loadCommands()
        .commands.find((command) => command.name === "dry")?.content,
      content
    );

    const stale = await call(
      "PATCH",
      CONTROL_API_PATHS.prompts + "/dry",
      {
        actor: "operator-a",
        body: { content: current.content, expectedRevision: current.revision }
      },
      runtimeOptions
    );
    assert.equal(stale.response.statusCode, 409);
    assert.equal(
      stale.body.error.code,
      "autodev_control_prompt_revision_conflict"
    );
    const wrongMethod = await call(
      "POST",
      CONTROL_API_PATHS.prompts + "/dry",
      {
        actor: "operator-a",
        body: { content, expectedRevision: result.body.revision }
      },
      runtimeOptions
    );
    assert.equal(wrongMethod.response.statusCode, 405);
    assert.equal(wrongMethod.response.headers.allow, "GET, PATCH");
  } finally {
    restoreEnv(saved);
    rmSync(repositoryRoot, { recursive: true, force: true });
    rmSync(codexHome, { recursive: true, force: true });
  }
});

test("Control API prompt detail serves an unshadowed role prompt from its canonical source file", async () => {
  const saved = saveEnv();
  try {
    configure();
    const prompts = await call("GET", CONTROL_API_PATHS.prompts, {
      actor: "viewer-a"
    });
    assert.equal(prompts.response.statusCode, 200);
    const commandNames = new Set(
      prompts.body.commands.map((command: { name: string }) => command.name)
    );
    const rolePrompt = prompts.body.rolePrompts.find(
      (entry: { role: string; path: string }) => !commandNames.has(entry.role)
    ) as { role: string; path: string } | undefined;
    assert.ok(
      rolePrompt,
      "expected at least one role prompt without a command shadow"
    );

    const detail = await call(
      "GET",
      CONTROL_API_PATHS.prompts + "/" + encodeURIComponent(rolePrompt.role),
      { actor: "viewer-a" }
    );
    assert.equal(detail.response.statusCode, 200);
    assert.equal(detail.body.schema, "autodev-control-prompt-detail-v4");
    assert.equal(detail.body.type, "role");
    assert.equal(detail.body.name, rolePrompt.role);
    assert.match(detail.body.revision, /^[a-f0-9]{64}$/u);
    assert.equal(detail.body.source, rolePrompt.path);
    assert.equal(
      detail.body.content,
      readFileSync(join(process.cwd(), rolePrompt.path), "utf8")
    );
    assert.equal(detail.body.preview, detail.body.content);
  } finally {
    restoreEnv(saved);
  }
});

test("Memory Control API requires an explicit workspace scope and configured storage", async () => {
  const saved = saveEnv();
  try {
    configure();
    delete process.env.AUTODEV_MEMORY_DATABASE_URL;
    const missingScope = await call("GET", "/control/memory/records", {
      actor: "viewer-a"
    });
    assert.equal(missingScope.response.statusCode, 400);
    assert.equal(missingScope.body.error.code, "autodev_memory_invalid_filter");

    const unavailable = await call(
      "GET",
      "/control/memory/records?workspaceId=workspace-a&repositoryId=owner%2Frepo",
      { actor: "viewer-a" }
    );
    assert.equal(unavailable.response.statusCode, 503);
    assert.equal(unavailable.body.error.code, "autodev_memory_unavailable");
  } finally {
    restoreEnv(saved);
  }
});

test("native transcript capture requires an operator and an observed session scope", async () => {
  const saved = saveEnv();
  try {
    configure();
    delete process.env.AUTODEV_MEMORY_DATABASE_URL;
    const denied = await call("POST", "/control/memory/capture", {
      actor: "viewer-a",
      body: {
        sessionId: "session-a",
        transcriptPath: "/tmp/codex/sessions/session.jsonl",
        cwd: "/workspace/repo"
      }
    });
    assert.equal(denied.response.statusCode, 403);
    assert.equal(denied.body.error.code, "autodev_memory_capture_forbidden");

    const unknownSession = await call("POST", "/control/memory/capture", {
      actor: "operator-a",
      body: {
        sessionId: "session-a",
        transcriptPath: "/tmp/codex/sessions/session.jsonl",
        cwd: "/workspace/repo"
      }
    });
    assert.equal(unknownSession.response.statusCode, 403);
    assert.equal(
      unknownSession.body.error.code,
      "autodev_memory_capture_scope_forbidden"
    );
  } finally {
    restoreEnv(saved);
  }
});

test("Memory Control API rejects invalid filters before opening the memory host", async () => {
  const saved = saveEnv();
  try {
    configure();
    delete process.env.AUTODEV_MEMORY_DATABASE_URL;
    const invalidKind = await call(
      "GET",
      "/control/memory/records?workspaceId=workspace-a&kind=prompt",
      { actor: "viewer-a" }
    );
    assert.equal(invalidKind.response.statusCode, 400);

    const invalidScope = await call(
      "GET",
      "/control/memory/experiences?workspaceId=workspace-a&taskId=task-a",
      { actor: "viewer-a" }
    );
    assert.equal(invalidScope.response.statusCode, 400);
    const invalidMemoryMode = await call(
      "GET",
      "/control/memory/experiences?workspaceId=workspace-a&memoryMode=other",
      { actor: "viewer-a" }
    );
    assert.equal(invalidMemoryMode.response.statusCode, 400);
    const invalidOutcome = await call(
      "GET",
      "/control/memory/experiences?workspaceId=workspace-a&outcome=maybe",
      { actor: "viewer-a" }
    );
    assert.equal(invalidOutcome.response.statusCode, 400);
  } finally {
    restoreEnv(saved);
  }
});

test("Memory Control API bounds the records and experiences time window", async () => {
  const saved = saveEnv();
  try {
    configure();
    delete process.env.AUTODEV_MEMORY_DATABASE_URL;
    const rejects = async (query: string): Promise<number> => {
      const result = await call(
        "GET",
        `/control/memory/records?workspaceId=workspace-a&${query}`,
        { actor: "viewer-a" }
      );
      return result.response.statusCode;
    };

    // Half a window is the same filter written two ways, so the ambiguous form
    // is refused rather than guessed at.
    assert.equal(await rejects("occurredFrom=2026-09-01T00:00:00Z"), 400);
    assert.equal(await rejects("occurredUntil=2026-10-01T00:00:00Z"), 400);
    assert.equal(await rejects("occurredFrom=yesterday"), 400);
    assert.equal(
      await rejects(
        "occurredUntil=2026-09-01T00:00:00Z&occurredFrom=2026-10-01T00:00:00Z"
      ),
      400
    );
    // The same 365-day ceiling the cohort reads carry, so an operator gets one
    // answer for how far back they can look on every Memory surface.
    assert.equal(
      await rejects(
        "occurredFrom=2020-01-01T00:00:00Z&occurredUntil=2026-10-01T00:00:00Z"
      ),
      400
    );
    // A well-formed window parses and proceeds to the memory host, which is
    // absent here -- so it must fail as unavailable, never as a bad request.
    const accepted = await call(
      "GET",
      "/control/memory/records?workspaceId=workspace-a&occurredFrom=2026-09-01T00:00:00Z&occurredUntil=2026-10-01T00:00:00Z",
      { actor: "viewer-a" }
    );
    assert.notEqual(accepted.response.statusCode, 400);
  } finally {
    restoreEnv(saved);
  }
});

test("Memory Control API audits denied lifecycle writes and gates global reads", async () => {
  const saved = saveEnv();
  try {
    configure();
    delete process.env.AUTODEV_MEMORY_DATABASE_URL;
    process.env.AUTODEV_MEMORY_READ_GLOBAL = "1";
    const write = await captureAudit(() =>
      call("POST", "/control/memory/records?workspaceId=workspace-a", {
        actor: "viewer-a",
        body: {}
      })
    );
    assert.equal(write.result.response.statusCode, 403);
    assert.equal(write.lines.length, 1);
    const audit = JSON.parse(write.lines[0] ?? "null") as {
      outcome: string;
      reason: string;
      resource: string;
    };
    assert.equal(audit.outcome, "denied");
    assert.equal(audit.reason, "viewer_cannot_mutate");
    assert.equal(audit.resource, "/control/memory/records");

    const getPurge = await call(
      "GET",
      "/control/memory/experiences/experience-a/purge?workspaceId=workspace-a&repositoryId=owner%2Frepo",
      { actor: "operator-a" }
    );
    assert.equal(getPurge.response.statusCode, 405);
    assert.equal(getPurge.response.headers.allow, "POST");

    const viewerPurge = await captureAudit(() =>
      call(
        "POST",
        "/control/memory/experiences/experience-a/purge?workspaceId=workspace-a&repositoryId=owner%2Frepo",
        {
          actor: "viewer-a",
          body: { reason: "privacy_request" }
        }
      )
    );
    assert.equal(viewerPurge.result.response.statusCode, 403);
    assert.equal(viewerPurge.lines.length, 1);
    const purgeAudit = JSON.parse(viewerPurge.lines[0] ?? "null") as {
      action: string;
      outcome: string;
      resource: string;
      reason: string;
    };
    assert.equal(purgeAudit.action, "purge");
    assert.equal(purgeAudit.outcome, "denied");
    assert.equal(purgeAudit.resource, "/control/memory/experiences");
    assert.equal(purgeAudit.reason, "viewer_cannot_mutate");

    const unavailablePurge = await captureAudit(() =>
      call(
        "POST",
        "/control/memory/experiences/experience-a/purge?workspaceId=workspace-a&repositoryId=owner%2Frepo",
        {
          actor: "operator-a",
          body: { reason: "privacy_request" }
        }
      )
    );
    assert.equal(unavailablePurge.result.response.statusCode, 503);
    assert.equal(unavailablePurge.lines.length, 1);
    const unavailableAudit = JSON.parse(
      unavailablePurge.lines[0] ?? "null"
    ) as { action: string; outcome: string; resource: string; reason: string };
    assert.equal(unavailableAudit.action, "purge");
    assert.equal(unavailableAudit.outcome, "error");
    assert.equal(unavailableAudit.resource, "/control/memory/experiences");
    assert.equal(unavailableAudit.reason, "memory_unavailable");

    const malformed = await call(
      "POST",
      "/control/memory/records?workspaceId=workspace-a",
      { actor: "operator-a", body: "not-json" }
    );
    assert.equal(malformed.response.statusCode, 400);
    assert.equal(malformed.body.error.code, "autodev_control_api_bad_body");

    const viewerGlobal = await call(
      "GET",
      "/control/memory/records?workspaceId=workspace-a&includeGlobal=true",
      { actor: "viewer-a" }
    );
    assert.equal(viewerGlobal.response.statusCode, 403);
    assert.equal(
      viewerGlobal.body.error.code,
      "autodev_memory_scope_forbidden"
    );
    process.env.AUTODEV_MEMORY_READ_TASK_HISTORY = "1";
    const viewerTaskHistory = await call(
      "GET",
      "/control/memory/experiences?workspaceId=workspace-a&includeTaskHistory=true",
      { actor: "viewer-a" }
    );
    assert.equal(viewerTaskHistory.response.statusCode, 403);
    const operatorGrantRequired = await call(
      "GET",
      "/control/memory/experiences?workspaceId=workspace-a&includeTaskHistory=true",
      { actor: "operator-a" }
    );
    assert.equal(operatorGrantRequired.response.statusCode, 503);
    delete process.env.AUTODEV_MEMORY_READ_TASK_HISTORY;
  } finally {
    restoreEnv(saved);
  }
});

test("Control API /control/github surfaces authoritative read-only GitHub Actions runtime state and scoped stats when configured", async () => {
  const saved = saveEnv();
  try {
    configure();
    process.env.AUTODEV_GITHUB_TOKEN = "ghp_mock_token_123";
    process.env.AUTODEV_GITHUB_REPOSITORY = "SimulatorLife/AutoDev";

    const mockFetch: typeof fetch = async (input) => {
      const url = String(input);
      if (url.includes("/actions/workflows/101/runs?")) {
        return Response.json({ total_count: 0, workflow_runs: [] });
      }
      if (url.includes("/actions/workflows")) {
        return Response.json(
          {
            total_count: 5,
            workflows: [
              {
                id: 101,
                name: "scheduler",
                path: ".github/workflows/_scheduler.yml",
                state: "active",
                html_url:
                  "https://github.com/SimulatorLife/AutoDev/actions/workflows/_scheduler.yml",
                created_at: "2026-01-01T00:00:00Z",
                updated_at: "2026-02-01T00:00:00Z"
              },
              {
                id: 102,
                name: "Agent Invoke",
                path: ".github/workflows/agent-invoke.yml",
                state: "disabled_manually",
                html_url:
                  "https://github.com/SimulatorLife/AutoDev/actions/workflows/agent-invoke.yml",
                created_at: "2026-01-01T00:00:00Z",
                updated_at: "2026-02-01T00:00:00Z"
              },
              {
                id: 103,
                name: "AutoDev Metrics Dashboard",
                path: ".github/workflows/metrics-dashboard.yml",
                state: "disabled_manually",
                html_url:
                  "https://github.com/SimulatorLife/AutoDev/actions/workflows/metrics-dashboard.yml",
                created_at: "2026-01-01T00:00:00Z",
                updated_at: "2026-02-01T00:00:00Z"
              },
              {
                id: 104,
                name: "Target Auto-merge",
                path: ".github/workflows/target-automerge.yml",
                state: "active",
                html_url:
                  "https://github.com/SimulatorLife/AutoDev/actions/workflows/target-automerge.yml",
                created_at: "2026-01-01T00:00:00Z",
                updated_at: "2026-02-01T00:00:00Z"
              },
              {
                id: 105,
                name: "Target PR Janitor",
                path: ".github/workflows/target-pr-janitor.yml",
                state: "disabled_inactivity",
                html_url:
                  "https://github.com/SimulatorLife/AutoDev/actions/workflows/target-pr-janitor.yml",
                created_at: "2026-01-01T00:00:00Z",
                updated_at: "2026-02-01T00:00:00Z"
              }
            ]
          },
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      if (url.includes("/actions/runs")) {
        return Response.json(
          {
            total_count: 3,
            workflow_runs: [
              {
                id: 5001,
                name: "scheduler",
                workflow_id: 101,
                path: ".github/workflows/_scheduler.yml",
                head_branch: "main",
                head_sha: "c47aeaa297b555fbd0b3cf961028bc8ae06485ed",
                event: "schedule",
                status: "completed",
                conclusion: "success",
                html_url:
                  "https://github.com/SimulatorLife/AutoDev/actions/runs/5001",
                created_at: "2026-10-04T05:00:00Z",
                updated_at: "2026-10-04T05:05:00Z",
                run_attempt: 1
              },
              {
                id: 5002,
                name: "scheduler",
                workflow_id: 101,
                path: ".github/workflows/_scheduler.yml",
                head_branch: "main",
                head_sha: "32917704044df54124558718110ec1695f83b0a3",
                event: "schedule",
                status: "completed",
                conclusion: "failure",
                html_url:
                  "https://github.com/SimulatorLife/AutoDev/actions/runs/5002",
                created_at: "2026-10-04T04:45:00Z",
                updated_at: "2026-10-04T04:50:00Z",
                run_attempt: 1
              },
              {
                id: 5003,
                name: "Agent Invoke",
                workflow_id: 102,
                path: ".github/workflows/agent-invoke.yml",
                head_branch: "feat/tests",
                head_sha: "6031b1d2a886961d369f1e9d1e82f05026a4edcc",
                event: "workflow_call",
                status: "in_progress",
                conclusion: null,
                html_url:
                  "https://github.com/SimulatorLife/AutoDev/actions/runs/5003",
                created_at: "2026-10-04T05:10:00Z",
                updated_at: "2026-10-04T05:12:00Z",
                run_attempt: 1
              }
            ]
          },
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      return new Response("Not found", { status: 404 });
    };

    setGithubActionsAdapterForTests(
      new GithubActionsAdapter({ fetchFn: mockFetch })
    );

    const res = await call("GET", CONTROL_API_PATHS.github, {
      actor: "viewer-a"
    });
    assert.equal(res.response.statusCode, 200);
    assert.equal(res.body.schema, "autodev-control-github-v1");
    assert.equal(res.body.readOnly, true);
    assert.equal(res.body.catalogStatus, "valid");
    assert.equal(res.body.runtimeFactsAvailable, true);
    assert.equal(res.body.runtimeStatus, "available");
    assert.equal(res.body.repository, "SimulatorLife/AutoDev");

    // Scoped statistics
    assert.deepEqual(res.body.stats, {
      totalRuns: 3,
      successfulRuns: 1,
      failedRuns: 1,
      inProgressRuns: 1,
      cancelledRuns: 0,
      successRate: 0.5
    });

    assert.equal(res.body.recentRuns.length, 3);
    assert.equal(res.body.recentRuns[0].id, 5001);

    // Correlated workflow definitions
    const scheduler = res.body.workflows.find(
      (w: { id: string }) => w.id === "_scheduler.yml"
    );
    assert.ok(scheduler);
    assert.equal(scheduler.actionsState, "active");
    assert.equal(scheduler.actionsWorkflowId, 101);
    assert.equal(scheduler.recentRunsCount, 2);
    assert.equal(scheduler.lastRunStatus, "completed");
    assert.equal(scheduler.lastRunConclusion, "success");
    assert.deepEqual(scheduler.schedules, ["*/15 * * * *"]);

    const agentInvoke = res.body.workflows.find(
      (w: { id: string }) => w.id === "agent-invoke.yml"
    );
    assert.ok(agentInvoke);
    assert.equal(agentInvoke.actionsState, "disabled_manually");
    assert.equal(agentInvoke.actionsWorkflowId, 102);
    assert.equal(agentInvoke.recentRunsCount, 1);
    assert.equal(agentInvoke.lastRunStatus, "in_progress");
    assert.equal(agentInvoke.lastRunConclusion, null);
  } finally {
    setGithubActionsAdapterForTests(null);
    restoreEnv(saved);
  }
});

test("GitHub snapshot cache TTL starts after a slow upstream read completes", async () => {
  const repositoryRoot = mkdtempSync(
    join(tmpdir(), "autodev-github-cache-clock-")
  );
  const originalNow = Date.now;
  const originalFetch = Object.getOwnPropertyDescriptor(
    GithubActionsAdapter.prototype,
    "fetchRuntimeSnapshot"
  );
  const snapshot = {
    workflows: [],
    runs: [],
    stats: {
      totalRuns: 0,
      successfulRuns: 0,
      failedRuns: 0,
      inProgressRuns: 0,
      cancelledRuns: 0,
      successRate: null
    }
  } satisfies Awaited<
    ReturnType<typeof GithubActionsAdapter.prototype.fetchRuntimeSnapshot>
  >;
  let now = 1000;
  let fetchCount = 0;
  try {
    mkdirSync(join(repositoryRoot, ".github", "workflows"), {
      recursive: true
    });
    mkdirSync(join(repositoryRoot, "config"), { recursive: true });
    writeFileSync(
      join(repositoryRoot, ".github", "workflows", "ci.yml"),
      "name: CI\non:\n  push:\n"
    );
    writeFileSync(
      join(repositoryRoot, "config", "workspaces.json"),
      JSON.stringify({
        schema: "autodev-workspaces-v1",
        workspaces: [
          {
            id: "Owner/Repo",
            baseBranch: "main",
            enabled: true,
            agentRoles: null
          }
        ]
      })
    );
    setGithubActionsAdapterForTests(null);
    Date.now = () => now;
    Object.defineProperty(
      GithubActionsAdapter.prototype,
      "fetchRuntimeSnapshot",
      {
        configurable: true,
        writable: true,
        value: async () => {
          fetchCount += 1;
          // Simulate an upstream operation that outlasts the 15-second cache TTL.
          now += 16_000;
          return snapshot;
        }
      }
    );

    const options = { repository: "Owner/Repo", token: "test-token" };
    const first = await githubWorkflowsView(repositoryRoot, options);
    const second = await githubWorkflowsView(repositoryRoot, options);

    assert.equal(first.runtimeFactsAvailable, true);
    assert.equal(second.runtimeFactsAvailable, true);
    assert.equal(fetchCount, 1);
  } finally {
    Date.now = originalNow;
    if (originalFetch) {
      Object.defineProperty(
        GithubActionsAdapter.prototype,
        "fetchRuntimeSnapshot",
        originalFetch
      );
    }
    setGithubActionsAdapterForTests(null);
    rmSync(repositoryRoot, { recursive: true, force: true });
  }
});

test("Control API /control/github rejects unconfigured workspace repositories", async () => {
  const saved = saveEnv();
  try {
    configure();
    process.env.AUTODEV_GITHUB_TOKEN = "ghp_mock_token_123";
    process.env.AUTODEV_GITHUB_REPOSITORY = "UnconfiguredOrg/UntrustedRepo";

    const res = await call("GET", CONTROL_API_PATHS.github, {
      actor: "viewer-a"
    });
    assert.equal(res.response.statusCode, 200);
    assert.equal(res.body.runtimeFactsAvailable, false);
    assert.equal(res.body.runtimeStatus, "invalid");
    assert.equal(res.body.repository, "UnconfiguredOrg/UntrustedRepo");
    assert.equal(res.body.stats, null);
    // The Actions read did not happen, so the runs were never asked for.
    // An empty list here would claim the workflows had never run.
    assert.equal(res.body.recentRuns, null);
    assert.ok(
      res.body.runtimeMessage.includes(
        "not a recognized workspace in config/workspaces.json"
      )
    );
    // All workflows default to unavailable
    for (const workflow of res.body.workflows) {
      assert.equal(workflow.actionsState, "unavailable");
    }
  } finally {
    restoreEnv(saved);
  }
});

test("GitHub runtime state rejects disabled workspaces before calling GitHub", async () => {
  const repositoryRoot = mkdtempSync(
    join(tmpdir(), "autodev-github-disabled-")
  );
  let fetchCalls = 0;
  try {
    mkdirSync(join(repositoryRoot, ".github", "workflows"), {
      recursive: true
    });
    mkdirSync(join(repositoryRoot, "config"), { recursive: true });
    writeFileSync(
      join(repositoryRoot, ".github", "workflows", "ci.yml"),
      "name: CI\non:\n  push:\n"
    );
    writeFileSync(
      join(repositoryRoot, "config", "workspaces.json"),
      JSON.stringify({
        schema: "autodev-workspaces-v1",
        workspaces: [
          {
            id: "SimulatorLife/AutoDev",
            baseBranch: "main",
            enabled: false,
            agentRoles: null
          }
        ]
      })
    );

    const actionsAdapter = new GithubActionsAdapter({
      fetchFn: async () => {
        fetchCalls++;
        return new Response("{}", { status: 200 });
      }
    });
    const result = await githubWorkflowsView(repositoryRoot, {
      actionsAdapter,
      token: "test-token",
      repository: "SimulatorLife/AutoDev"
    });

    assert.equal(result.runtimeFactsAvailable, false);
    assert.equal(result.runtimeStatus, "invalid");
    assert.equal(result.stats, null);
    // The Actions read was refused before it happened, so the runs are not
    // observed rather than empty.
    assert.equal(result.recentRuns, null);
    assert.match(String(result.runtimeMessage), /workspace .* is disabled/u);
    assert.equal(fetchCalls, 0);
  } finally {
    rmSync(repositoryRoot, { recursive: true, force: true });
  }
});

test("Control API /control/github reads public repository Actions data without a token", async () => {
  const saved = saveEnv();
  const authorizationHeaders: (string | null)[] = [];
  try {
    configure();
    delete process.env.AUTODEV_GITHUB_TOKEN;
    process.env.AUTODEV_GITHUB_REPOSITORY = "SimulatorLife/AutoDev";

    const mockFetch: typeof fetch = async (input, init) => {
      authorizationHeaders.push(
        new Headers(init?.headers).get("authorization")
      );
      const url = String(input);
      if (url.includes("/actions/workflows")) {
        return Response.json({
          total_count: 1,
          workflows: [
            {
              id: 101,
              name: "scheduler",
              path: ".github/workflows/_scheduler.yml",
              state: "active",
              html_url:
                "https://github.com/SimulatorLife/AutoDev/actions/workflows/_scheduler.yml",
              created_at: "2026-01-01T00:00:00Z",
              updated_at: "2026-02-01T00:00:00Z"
            }
          ]
        });
      }
      return Response.json({
        total_count: 1,
        workflow_runs: [
          {
            id: 5001,
            name: "Scheduler",
            workflow_id: 101,
            path: ".github/workflows/_scheduler.yml",
            head_branch: "main",
            head_sha: "abc123",
            event: "schedule",
            status: "completed",
            conclusion: "success",
            html_url:
              "https://github.com/SimulatorLife/AutoDev/actions/runs/5001",
            created_at: "2026-10-04T04:45:00Z",
            updated_at: "2026-10-04T04:50:00Z",
            run_attempt: 1
          }
        ]
      });
    };

    setGithubActionsAdapterForTests(
      new GithubActionsAdapter({ fetchFn: mockFetch })
    );

    const res = await call("GET", CONTROL_API_PATHS.github, {
      actor: "viewer-a"
    });
    assert.equal(res.response.statusCode, 200);
    assert.equal(res.body.runtimeFactsAvailable, true);
    assert.equal(res.body.runtimeStatus, "available");
    assert.equal(res.body.repository, "SimulatorLife/AutoDev");
    assert.equal(res.body.stats.totalRuns, 1);
    assert.equal(res.body.stats.successfulRuns, 1);
    assert.equal(res.body.recentRuns.length, 1);
    assert.deepEqual(authorizationHeaders, [null, null]);
    const scheduler = res.body.workflows.find(
      (workflow: { id: string }) => workflow.id === "_scheduler.yml"
    );
    assert.ok(scheduler);
    assert.equal(scheduler.actionsState, "active");
    assert.equal(scheduler.recentRunsCount, 1);
    assert.equal(scheduler.lastRunStatus, "completed");
  } finally {
    setGithubActionsAdapterForTests(null);
    restoreEnv(saved);
  }
});

test("Control API /control/github remains unavailable when no repository is bound", async () => {
  const saved = saveEnv();
  let fetchCalls = 0;
  try {
    configure();
    delete process.env.AUTODEV_GITHUB_TOKEN;
    delete process.env.AUTODEV_GITHUB_REPOSITORY;
    delete process.env.GITHUB_REPOSITORY;
    setGithubActionsAdapterForTests(
      new GithubActionsAdapter({
        fetchFn: async () => {
          fetchCalls++;
          return Response.json({});
        }
      })
    );

    const res = await call("GET", CONTROL_API_PATHS.github, {
      actor: "viewer-a"
    });
    assert.equal(res.response.statusCode, 200);
    assert.equal(res.body.runtimeFactsAvailable, false);
    assert.equal(res.body.runtimeStatus, "unavailable");
    assert.equal(res.body.repository, null);
    assert.match(String(res.body.runtimeMessage), /no repository is bound/u);
    assert.equal(fetchCalls, 0);
  } finally {
    setGithubActionsAdapterForTests(null);
    restoreEnv(saved);
  }
});

test("Control API /control/github treats a GitHub 403 as unavailable, not invalid", async () => {
  const saved = saveEnv();
  try {
    configure();
    delete process.env.AUTODEV_GITHUB_TOKEN;
    process.env.AUTODEV_GITHUB_REPOSITORY = "SimulatorLife/AutoDev";
    setGithubActionsAdapterForTests(
      new GithubActionsAdapter({
        fetchFn: async () =>
          Response.json({ message: "API rate limit exceeded" }, { status: 403 })
      })
    );

    const res = await call("GET", CONTROL_API_PATHS.github, {
      actor: "viewer-a"
    });
    assert.equal(res.response.statusCode, 200);
    assert.equal(res.body.runtimeFactsAvailable, false);
    assert.equal(res.body.runtimeStatus, "unavailable");
    assert.match(String(res.body.runtimeMessage), /403 Forbidden/u);
  } finally {
    setGithubActionsAdapterForTests(null);
    restoreEnv(saved);
  }
});

test("Control API /control/github handles API failure without leaking token", async () => {
  const saved = saveEnv();
  const SECRET_TOKEN = "ghp_SUPER_SECRET_TOKEN_NEVER_LOG";
  try {
    configure();
    process.env.AUTODEV_GITHUB_TOKEN = SECRET_TOKEN;
    process.env.AUTODEV_GITHUB_REPOSITORY = "SimulatorLife/AutoDev";

    const mockFetch: typeof fetch = async () =>
      Response.json(
        {
          message: `Invalid credentials token=${SECRET_TOKEN}`
        },
        { status: 401, headers: { "Content-Type": "application/json" } }
      );

    setGithubActionsAdapterForTests(
      new GithubActionsAdapter({ fetchFn: mockFetch })
    );

    const res = await call("GET", CONTROL_API_PATHS.github, {
      actor: "viewer-a"
    });
    assert.equal(res.response.statusCode, 200);
    assert.equal(res.body.runtimeFactsAvailable, false);
    assert.equal(res.body.runtimeStatus, "invalid");
    assert.equal(res.body.stats, null);
    assert.equal(res.body.runtimeMessage.includes(SECRET_TOKEN), false);
    assert.ok(res.body.runtimeMessage.includes("[REDACTED]"));
  } finally {
    setGithubActionsAdapterForTests(null);
    restoreEnv(saved);
  }
});

test("Control API /control/runtime/concurrency mutates orchestrator concurrency limit with revision checking and persistence", async () => {
  const saved = saveEnv();
  try {
    configure();
    const manager = getDefaultConcurrencyManager();
    const initialStatus = manager.concurrencyStatus();

    // 1. Viewer is forbidden
    const viewerAttempt = await call("PATCH", CONTROL_API_PATHS.concurrency, {
      actor: "viewer-a",
      body: { maxConcurrentThreadsPerSession: 8 }
    });
    assert.equal(viewerAttempt.response.statusCode, 403);
    assert.equal(
      viewerAttempt.body.error.code,
      "autodev_control_api_viewer_forbidden"
    );

    // 2. Invalid body is rejected
    const invalidAttempt = await call("PATCH", CONTROL_API_PATHS.concurrency, {
      actor: "operator-a",
      body: { maxConcurrentThreadsPerSession: -5 }
    });
    assert.equal(invalidAttempt.response.statusCode, 400);

    // 3. Operator mutates limit to 8
    const patched = await call("PATCH", CONTROL_API_PATHS.concurrency, {
      actor: "operator-a",
      body: {
        maxConcurrentThreadsPerSession: 8,
        revision: initialStatus.revision
      }
    });
    assert.equal(patched.response.statusCode, 200);
    assert.equal(patched.body.schema, "autodev-control-concurrency-v1");
    assert.equal(patched.body.concurrency.effectivePerSessionLimit, 8);
    assert.equal(patched.body.concurrency.configSource, "stored_override");
    assert.equal(patched.body.concurrency.revision, initialStatus.revision + 1);

    // 4. Stale revision is rejected with 409 Conflict
    const staleAttempt = await call("PATCH", CONTROL_API_PATHS.concurrency, {
      actor: "operator-a",
      body: {
        maxConcurrentThreadsPerSession: 12,
        revision: initialStatus.revision
      }
    });
    assert.equal(staleAttempt.response.statusCode, 409);
    assert.equal(staleAttempt.body.error.code, "autodev_control_api_conflict");

    // 5. Operator mutates limit to null (Unlimited)
    const unlimited = await call("PATCH", CONTROL_API_PATHS.concurrency, {
      actor: "operator-a",
      body: {
        maxConcurrentThreadsPerSession: null,
        revision: patched.body.concurrency.revision
      }
    });
    assert.equal(unlimited.response.statusCode, 200);
    assert.equal(unlimited.body.concurrency.effectivePerSessionLimit, null);
    assert.equal(unlimited.body.concurrency.configSource, "stored_override");

    // 6. Operator resets to config file
    const reset = await call("PATCH", CONTROL_API_PATHS.concurrency, {
      actor: "operator-a",
      body: {
        resetToConfigFile: true,
        revision: unlimited.body.concurrency.revision
      }
    });
    assert.equal(reset.response.statusCode, 200);
    assert.notEqual(reset.body.concurrency.configSource, "stored_override");
    assert.equal(
      reset.body.concurrency.effectivePerSessionLimit,
      initialStatus.maxConcurrentThreadsPerSession
    );
  } finally {
    getDefaultConcurrencyManager().clearStoredLimit();
    restoreEnv(saved);
  }
});

test("queued provider role patches revalidate an unchanged model after reset clears its assignment", async () => {
  const saved = saveEnv();
  const originalPersistence = getDefaultPersistenceManager();
  const priorState = ROUTING_POLICY.runtimeState();
  const { promise: firstPersist, resolve: releaseFirstPersist } =
    Promise.withResolvers<boolean>();
  const { promise: firstPersistStarted, resolve: signalFirstPersist } =
    Promise.withResolvers<void>();
  let persistCalls = 0;
  let firstCall: Promise<any> | null = null;
  let resetCall: Promise<any> | null = null;
  let staleRoleCall: Promise<any> | null = null;
  setDefaultPersistenceManager({
    async persistNow() {
      persistCalls += 1;
      if (persistCalls === 1) {
        signalFirstPersist();
        return firstPersist;
      }
      return true;
    }
  } as unknown as RouterPersistence);
  try {
    configure();
    // This assignment is preserved when discovery is unavailable, but once
    // reset clears it the same model is no longer admissible as a new choice.
    ROUTING_POLICY.setProviderAssignment("claude", "subagent", {
      priority: 2,
      model: "retired-model"
    });

    firstCall = call(
      "PATCH",
      CONTROL_API_PATHS.providers + "/antigravity/roles/default",
      {
        actor: "operator-a",
        body: { priority: 1, model: null }
      }
    );
    await firstPersistStarted;

    // Queue the reset first, then submit the old preserved model while the
    // assignment still exists in memory. Its value must be checked again only
    // after the reset's serialized turn clears that assignment.
    resetCall = call("POST", CONTROL_API_PATHS.providersReset, {
      actor: "operator-a",
      body: { confirm: true }
    });
    staleRoleCall = call(
      "PATCH",
      CONTROL_API_PATHS.providers + "/claude/roles/subagent",
      {
        actor: "operator-a",
        body: { priority: 1, model: "retired-model" }
      }
    );

    releaseFirstPersist(true);
    const [firstResult, resetResult, staleRoleResult] = await Promise.all([
      firstCall,
      resetCall,
      staleRoleCall
    ]);
    assert.equal(firstResult.response.statusCode, 200);
    assert.equal(resetResult.response.statusCode, 200);
    assert.equal(staleRoleResult.response.statusCode, 400);
    assert.equal(
      staleRoleResult.body.error.code,
      "autodev_control_api_bad_body"
    );
    assert.equal(ROUTING_POLICY.assignmentFor("claude", "subagent"), undefined);
  } finally {
    releaseFirstPersist(true);
    await Promise.all([firstCall, resetCall, staleRoleCall].filter(Boolean));
    ROUTING_POLICY.restoreRuntimeState(priorState);
    setDefaultPersistenceManager(originalPersistence);
    restoreEnv(saved);
  }
});

test("queued provider role patches recheck provider enablement after a disable commits", async () => {
  const saved = saveEnv();
  const originalPersistence = getDefaultPersistenceManager();
  const priorState = ROUTING_POLICY.runtimeState();
  const { promise: firstPersist, resolve: releaseFirstPersist } =
    Promise.withResolvers<boolean>();
  const { promise: firstPersistStarted, resolve: signalFirstPersist } =
    Promise.withResolvers<void>();
  let persistCalls = 0;
  let firstCall: Promise<any> | null = null;
  let disableCall: Promise<any> | null = null;
  let roleCall: Promise<any> | null = null;
  setDefaultPersistenceManager({
    async persistNow() {
      persistCalls += 1;
      if (persistCalls === 1) {
        signalFirstPersist();
        return firstPersist;
      }
      return true;
    }
  } as unknown as RouterPersistence);
  try {
    configure();
    ROUTING_POLICY.setProviderEnabled("claude", true);

    firstCall = call(
      "PATCH",
      CONTROL_API_PATHS.providers + "/antigravity/roles/default",
      {
        actor: "operator-a",
        body: { priority: 1, model: null }
      }
    );
    await firstPersistStarted;

    disableCall = call("PATCH", CONTROL_API_PATHS.providers + "/claude", {
      actor: "operator-a",
      body: { disabled: true }
    });
    roleCall = call(
      "PATCH",
      CONTROL_API_PATHS.providers + "/claude/roles/subagent",
      {
        actor: "operator-a",
        body: { priority: 1, model: "sonnet" }
      }
    );

    releaseFirstPersist(true);
    const [firstResult, disableResult, roleResult] = await Promise.all([
      firstCall,
      disableCall,
      roleCall
    ]);
    assert.equal(firstResult.response.statusCode, 200);
    assert.equal(disableResult.response.statusCode, 200);
    assert.equal(roleResult.response.statusCode, 409);
    assert.equal(
      roleResult.body.error.code,
      "autodev_control_api_provider_disabled"
    );
    assert.equal(ROUTING_POLICY.isProviderDisabled("claude"), true);
    assert.equal(ROUTING_POLICY.assignmentFor("claude", "subagent"), undefined);
  } finally {
    releaseFirstPersist(true);
    await Promise.all([firstCall, disableCall, roleCall].filter(Boolean));
    ROUTING_POLICY.restoreRuntimeState(priorState);
    setDefaultPersistenceManager(originalPersistence);
    restoreEnv(saved);
  }
});
