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

import { InMemorySpanExporter } from "@opentelemetry/sdk-trace-base";
import { LOCAL_CONTROL_API_ACTOR } from "@simulatorlife/autodev-core";
import {
  GithubActionsAdapter,
  RuleSyncRepository
} from "@simulatorlife/autodev-data";
import {
  CONTROL_API_PATHS,
  type ControlApiRequestOptions,
  githubWorkflowsView,
  handleControlApiRequest,
  setGithubActionsAdapterForTests
} from "@simulatorlife/autodev-runtime/control-api";
import {
  getDefaultPersistenceManager,
  type RouterPersistence,
  setDefaultPersistenceManager
} from "@simulatorlife/autodev-runtime/router/persistence";
import { ROUTING_POLICY } from "@simulatorlife/autodev-runtime/router/routing";
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
    assert.equal(workspaces.body.schema, "autodev-control-workspaces-v1");
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

test("Tools catalog remains unknown when the role source is unavailable", async () => {
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
    assert.equal(tools.body.coverage, "unknown");
    assert.equal(tools.body.totalTools, null);
    assert.deepEqual(tools.body.tools, []);
  } finally {
    setExecutionContractForTests(priorContract);
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
    assert.equal(agents.body.schema, "autodev-control-agents-v1");
    assert.ok(agents.body.totalAgents > 0);
    assert.ok(Array.isArray(agents.body.agents));
    const configuredAgent = agents.body.agents.find(
      (agent: { role: string }) => agent.role === "orchestrator"
    );
    assert.ok(configuredAgent);
    assert.equal(configuredAgent.status, "configured");
    assert.equal(configuredAgent.valid, null);
    assert.equal(configuredAgent.convergence, "not-observed");

    const agentDetail = await call(
      "GET",
      CONTROL_API_PATHS.agents + "/orchestrator",
      { actor: "viewer-a" }
    );
    assert.equal(agentDetail.response.statusCode, 200);
    assert.equal(agentDetail.body.schema, "autodev-control-agent-detail-v1");
    assert.equal(agentDetail.body.role, "orchestrator");
    assert.equal(agentDetail.body.kind, "orchestrator");
    assert.equal(agentDetail.body.status, "configured");
    assert.equal(agentDetail.body.valid, null);
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
    assert.equal(providers.body.schema, "autodev-control-providers-v1");

    // 3. Models
    const models = await call("GET", CONTROL_API_PATHS.models, {
      actor: "viewer-a"
    });
    assert.equal(models.response.statusCode, 200);
    assert.equal(models.body.schema, "autodev-control-models-v1");
    assert.ok(models.body.totalModels > 0);

    // 4. MCPs
    const mcps = await call("GET", CONTROL_API_PATHS.mcps, {
      actor: "viewer-a"
    });
    assert.equal(mcps.response.statusCode, 200);
    assert.equal(mcps.body.schema, "autodev-control-mcps-v1");
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

    // 5. Tools: known capability declarations only; health and use are unknown.
    const tools = await call("GET", CONTROL_API_PATHS.tools, {
      actor: "viewer-a"
    });
    assert.equal(tools.response.statusCode, 200);
    assert.equal(tools.body.schema, "autodev-control-tools-v1");
    assert.equal(tools.body.source, "execution-contract");
    assert.equal(tools.body.coverage, "partial");
    const webSearch = tools.body.tools.find(
      (tool: { name: string; source: string }) =>
        tool.name === "web_search" && tool.source === "native"
    );
    assert.ok(webSearch);
    assert.ok(webSearch.exposedRoles.includes("docs-researcher"));
    const appTool = tools.body.tools.find(
      (tool: { name: string; source: string }) =>
        tool.name === "request_user_input" && tool.source === "plugin"
    );
    assert.ok(appTool);
    assert.ok(appTool.exposedRoles.includes("orchestrator"));
    assert.equal("status" in webSearch, false);

    // 6. Skills
    const skills = await call("GET", CONTROL_API_PATHS.skills, {
      actor: "viewer-a"
    });
    assert.equal(skills.response.statusCode, 200);
    assert.equal(skills.body.schema, "autodev-control-skills-v2");
    assert.equal(skills.body.source, ".rulesync/skills+execution-contract");
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
    assert.equal(hooks.body.schema, "autodev-control-hooks-v1");
    assert.equal(hooks.body.valid, true);

    // 8. Permissions
    const permissions = await call("GET", CONTROL_API_PATHS.permissions, {
      actor: "viewer-a"
    });
    assert.equal(permissions.response.statusCode, 200);
    assert.equal(permissions.body.schema, "autodev-control-permissions-v1");
    assert.equal(permissions.body.policy.approvalPolicy, "never");
    assert.equal(permissions.body.policy.sandboxMode, "workspace-write");

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
    assert.equal(promptDetail.body.schema, "autodev-control-prompt-detail-v3");
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
    assert.equal(workspaces.body.schema, "autodev-control-workspaces-v1");

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
    assert.equal(runtime.body.schema, "autodev-control-runtime-v1");

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
    assert.equal(prompts.body.readOnly, true);
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
    assert.equal(list.body.schema, "autodev-control-prompt-versions-v1");
    assert.equal(list.body.name, "audit");
    assert.equal(list.body.status, "available");
    assert.equal(list.body.hasMore, false);
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
    assert.equal(detail.body.schema, "autodev-control-prompt-detail-v3");
    assert.equal(detail.body.name, target.name);
    assert.equal(detail.body.type, "command");
    assert.equal(detail.body.source, target.path);
    assert.equal(detail.body.content, target.content);
    assert.equal(detail.body.preview, target.prompt);
    assert.equal(detail.body.revision, target.revision);

    // The detail surface contains only canonical content and its revision.
    assert.deepEqual(Object.keys(detail.body).sort(), [
      "content",
      "name",
      "preview",
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
    assert.equal(result.body.schema, "autodev-control-prompt-command-patch-v1");
    assert.equal(result.body.name, "dry");
    assert.match(result.body.revision, /^[a-f0-9]{64}$/u);
    assert.equal(result.body.changed, true);
    assert.equal(result.body.projectionUpdated, true);
    assert.equal(result.body.restartRequired, true);
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
    assert.equal(detail.body.schema, "autodev-control-prompt-detail-v3");
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
    assert.equal(detail.body.schema, "autodev-control-prompt-detail-v3");
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
    assert.deepEqual(res.body.recentRuns, []);
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
    assert.deepEqual(result.recentRuns, []);
    assert.match(String(result.runtimeMessage), /workspace .* is disabled/u);
    assert.equal(fetchCalls, 0);
  } finally {
    rmSync(repositoryRoot, { recursive: true, force: true });
  }
});

test("Control API /control/github returns explicit unavailable state without synthesizing health when token is missing", async () => {
  const saved = saveEnv();
  try {
    configure();
    delete process.env.AUTODEV_GITHUB_TOKEN;
    process.env.AUTODEV_GITHUB_REPOSITORY = "SimulatorLife/AutoDev";

    const res = await call("GET", CONTROL_API_PATHS.github, {
      actor: "viewer-a"
    });
    assert.equal(res.response.statusCode, 200);
    assert.equal(res.body.runtimeFactsAvailable, false);
    assert.equal(res.body.runtimeStatus, "unavailable");
    assert.equal(res.body.repository, "SimulatorLife/AutoDev");
    assert.equal(res.body.stats, null);
    assert.deepEqual(res.body.recentRuns, []);
    assert.ok(
      res.body.runtimeMessage.includes(
        "AUTODEV_GITHUB_TOKEN is not configured on the server"
      )
    );
  } finally {
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
