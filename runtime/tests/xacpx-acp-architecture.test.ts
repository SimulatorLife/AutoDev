import assert from "node:assert/strict";
import { once } from "node:events";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync
} from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  AGENT_METHODS,
  AgentApp,
  CLIENT_METHODS,
  PROTOCOL_VERSION
} from "@agentclientprotocol/sdk";

import {
  ACP_PROVIDER_IDS,
  buildAcpProviderLaunchSpec
} from "../src/acp/provider-profiles.ts";
import {
  buildOpencliRoleTaskSpec,
  GITHUB_WORKER_ROLE
} from "../src/providers/opencli-role.ts";
import { renderBridgeMcpCatalogue } from "../src/config/render-bridge-mcp-catalogue.ts";
import { evaluatePreToolUse as evaluateBlockCcc } from "../src/hooks/block-ccc-cli.ts";
import { evaluateFileSurfaceHook } from "../src/hooks/file-surface.ts";
import {
  extractHookContext,
  extractHookToolCall
} from "../src/hooks/hook-payload.ts";
import { evaluateRoleSandboxHook } from "../src/hooks/role-sandbox.ts";
import { ensureLocalAdmission, readLocalAdmission } from "../src/mcp/gateway-admission.ts";
import { MCP_GRANT_ENV } from "../src/mcp/gateway-client.ts";
import { resolveMcpCommand } from "../src/mcp/launcher.ts";
import { verifySessionGrant } from "../src/mcp/session-grant.ts";
import { COOLDOWNS } from "../src/router/cooldown/index.ts";
import { ROUTING_POLICY, RoutingPolicy } from "../src/router/routing.ts";
import { autodevHome, autodevStateHome } from "../src/shared/autodev-home.ts";
import { roleContract } from "../src/shared/execution-contract.ts";
import { findMcodeBinary } from "../src/shared/executables.ts";
import {
  extractSkillReadPath,
  matchSkillReadTarget
} from "../src/shared/skill-reads.ts";
import { didHandleAcpRoute } from "../src/xacpx/http.ts";
import {
  type AcpConsoleSessionEvent,
  resolveAcpPermissionResponse,
  resolveXacpxBinaries,
  validateDelegatedRole,
  validateDelegatedWorkspace,
  XacpxSessionManager
} from "../src/xacpx/manager.ts";
import { startXacpxOrchestrationIpcServer } from "../src/xacpx/orchestration-ipc.ts";

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
// ACP sessions are admitted to the shared MCP gateway: give this run's
// isolated CODEX_HOME the gateway's admission files.
ensureLocalAdmission(process.env.CODEX_HOME!);

test("autodevHome resolves $AUTODEV_HOME and autodevStateHome honors transition fallback", () => {
  assert.equal(
    autodevHome({ AUTODEV_HOME: "/tmp/custom-autodev" }, "/Users/example"),
    "/tmp/custom-autodev"
  );
  assert.equal(
    autodevHome({}, "/Users/example"),
    path.join("/Users/example", ".autodev")
  );
  assert.equal(
    autodevStateHome({ CODEX_HOME: "/tmp/legacy-codex" }, "/Users/example"),
    "/tmp/legacy-codex"
  );
  assert.equal(
    autodevStateHome(
      { AUTODEV_HOME: "/tmp/custom-autodev", CODEX_HOME: "/tmp/legacy-codex" },
      "/Users/example"
    ),
    "/tmp/custom-autodev"
  );
});

test("hook payload normalization handles Antigravity toolCall and call_mcp_tool wrappers", () => {
  const agyDirect = {
    toolCall: {
      name: "read_file",
      arguments: { path: `${REPO_ROOT}/.rulesync/skills/ccc/SKILL.md` }
    },
    conversation_id: "agy-session-1"
  };
  const directCall = extractHookToolCall(agyDirect);
  assert.equal(directCall?.toolName, "read_file");
  const directPath = extractSkillReadPath(
    directCall?.toolName,
    directCall?.toolInput
  );
  assert.equal(
    matchSkillReadTarget(directPath, [
      path.join(REPO_ROOT, ".rulesync", "skills")
    ])?.skill,
    "ccc"
  );

  const agyMcp = {
    toolCall: {
      name: "call_mcp_tool",
      arguments: {
        ServerName: "filesystem",
        ToolName: "read_text_file",
        Arguments: {
          path: path.join(
            REPO_ROOT,
            ".rulesync",
            "skills",
            "lsp-mcp-server",
            "SKILL.md"
          )
        }
      }
    }
  };
  const unwrapped = extractHookToolCall(agyMcp);
  assert.equal(unwrapped?.toolName, "mcp__filesystem__read_text_file");
  const mcpPath = extractSkillReadPath(
    unwrapped?.toolName,
    unwrapped?.toolInput
  );
  assert.equal(
    matchSkillReadTarget(mcpPath, [path.join(REPO_ROOT, ".rulesync", "skills")])
      ?.skill,
    "lsp-mcp-server"
  );

  const hookContext = extractHookContext(agyDirect, {
    AUTODEV_SESSION_ID: "runtime-session-1",
    AUTODEV_AGENT_ROLE: "explorer",
    AUTODEV_PROVIDER: "antigravity"
  });
  assert.equal(hookContext.origin, "runtime");
  assert.equal(hookContext.sessionId, "runtime-session-1");
  assert.equal(hookContext.role, "explorer");
  assert.equal(hookContext.provider, "antigravity");

  // The same payload in a native Antigravity chat carries no AutoDev role.
  const nativeContext = extractHookContext(agyDirect, {});
  assert.equal(nativeContext.origin, "unmanaged");
  assert.equal(nativeContext.sessionId, "agy-session-1");
  assert.equal(nativeContext.role, null);
});

test("Antigravity PreToolUse payloads enforce file-surface, ccc block, and read-only sandbox", () => {
  const runtimeEnvironment = {
    AUTODEV_SESSION_ID: "runtime-session-1",
    AUTODEV_AGENT_ROLE: "explorer",
    AUTODEV_PROVIDER: "antigravity"
  };
  const nativeWrite = JSON.stringify({
    toolCall: { name: "write_to_file", arguments: { TargetFile: "a.ts" } }
  });
  assert.equal(
    evaluateFileSurfaceHook(nativeWrite, runtimeEnvironment).denied,
    true
  );
  // A native Antigravity chat keeps its own file tools.
  assert.equal(evaluateFileSurfaceHook(nativeWrite, {}).denied, false);

  const cccRun = JSON.stringify({
    toolCall: { name: "run_command", arguments: { command: "ccc search foo" } }
  });
  assert.equal(evaluateBlockCcc(cccRun).blocked, true);

  const readonlyMcpWrite = JSON.stringify({
    agent_type: "explorer",
    toolCall: {
      name: "call_mcp_tool",
      arguments: {
        ServerName: "filesystem",
        ToolName: "write_file",
        Arguments: { path: "foo.ts", content: "x" }
      }
    }
  });
  assert.equal(
    evaluateRoleSandboxHook(readonlyMcpWrite, runtimeEnvironment).denied,
    true
  );
  assert.equal(evaluateRoleSandboxHook(readonlyMcpWrite, {}).denied, false);
});

test("MCP launcher resolves newly added github and xacpx servers", () => {
  const githubCommand = resolveMcpCommand("github");
  assert.equal(existsSync(githubCommand.args[0]!), true);
  const xacpxCommand = resolveMcpCommand("xacpx", {
    AUTODEV_XACPX_COORDINATOR_SESSION: "coord-1",
    AUTODEV_XACPX_WORKSPACE: "AutoDev"
  });
  assert.equal(xacpxCommand.binary, process.execPath);
  assert.equal(existsSync(xacpxCommand.args[0]!), true);
  assert.deepEqual(xacpxCommand.args.slice(1), [
    "mcp-stdio",
    "--coordinator-session",
    "coord-1",
    "--workspace",
    "AutoDev"
  ]);
});

test("ACP sessions reach their role's MCP servers only through the gateway client under their own grant", () => {
  const options = {
    provider: "claude" as const,
    role: "docs-researcher",
    model: "sonnet",
    cwd: REPO_ROOT,
    systemPrompt: "Research",
    sessionId: "sess-gateway",
    env: {
      ...process.env,
      AUTODEV_REPO_ROOT: "/not-the-runtime",
      CONTEXT7_API_KEY: "context7-secret",
      GOOGLE_DEVELOPER_KNOWLEDGE_API_KEY: "google-secret"
    }
  };
  const spec = buildAcpProviderLaunchSpec(options);
  // Backend credentials stay with the gateway.
  assert.equal(spec.env.CONTEXT7_API_KEY, undefined);
  assert.equal(spec.env.GOOGLE_DEVELOPER_KNOWLEDGE_API_KEY, undefined);
  // The gateway client of this Runtime, never one a repository override names.
  const client = realpathSync(new URL("../src/mcp/gateway-client.ts", import.meta.url));
  assert.deepEqual(
    spec.acpMcpServers.map((server) => server.name),
    roleContract("docs-researcher").mcp
  );
  for (const server of spec.acpMcpServers) {
    assert.ok("command" in server);
    assert.equal(server.command, process.execPath);
    assert.deepEqual(server.args, [client, server.name]);
    assert.equal(JSON.stringify(server).includes("context7-secret"), false);
    const grant = server.env.find((entry) => entry.name === MCP_GRANT_ENV)?.value;
    // The session's grant names its own workspace, role and session.
    assert.deepEqual(
      { ...verifySessionGrant(readLocalAdmission(process.env.CODEX_HOME!)!.secret, grant), expiresAt: 0 },
      { workspace: realpathSync(REPO_ROOT), role: "docs-researcher", session: "sess-gateway", expiresAt: 0 }
    );
  }
  // Without an installed gateway, or in the home directory, no MCP is offered.
  const empty = mkdtempSync(path.join(tmpdir(), "autodev-no-gateway-"));
  assert.throws(
    () => buildAcpProviderLaunchSpec({ ...options, env: { ...options.env, CODEX_HOME: empty } }),
    /MCP gateway is not installed/u
  );
  assert.throws(
    () => buildAcpProviderLaunchSpec({ ...options, cwd: homedir() }),
    /AutoDev MCP is unavailable here/u
  );
  rmSync(empty, { recursive: true, force: true });
});

test("ACP MCP tools are checked against canonical role permissions", () => {
  const options = [
    { optionId: "allow", name: "Allow", kind: "allow_once" as const },
    { optionId: "reject", name: "Reject", kind: "reject_once" as const }
  ];
  const cases = [
    ["worker", "mcp__filesystem__write_file", "allow"],
    ["explorer", "mcp__filesystem__write_file", "reject"],
    ["explorer", "mcp__filesystem__read_text_file", "allow"],
    ["worker", "mcp__cocoindex-code__search", "allow"],
    ["worker", "mcp__codegraphcontext__delete_repository", "reject"],
    ["worker", "mcp__commands__test", "allow"],
    ["explorer", "mcp__commands__test", "reject"],
    ["worker", "mcp__playwright__browser_navigate", "reject"],
    ["worker", "mcp__filesystem", "reject"],
    ["worker", "mcp__cocoindex_code__search", "reject"],
    ["worker", "mcp__malformed", "reject"],
    ["worker", "   ", "reject"]
  ] as const;
  for (const [role, name, expected] of cases) {
    assert.deepEqual(
      resolveAcpPermissionResponse(role, {
        sessionId: "fixture",
        toolCall: { toolCallId: name, name },
        options
      }),
      { outcome: { outcome: "selected", optionId: expected } },
      name
    );
  }
  const request = {
    sessionId: "fixture",
    toolCall: { toolCallId: "read", name: "mcp__filesystem__read_text_file" }
  };
  assert.deepEqual(
    resolveAcpPermissionResponse("worker", {
      ...request,
      options: [options[1]!]
    }),
    { outcome: { outcome: "selected", optionId: "reject" } }
  );
  assert.deepEqual(
    resolveAcpPermissionResponse("worker", { ...request, options: [] }),
    { outcome: { outcome: "cancelled" } }
  );
});

test("ACP provider profiles project canonical role capabilities, native mcpServers, and truthful isolation", () => {
  for (const provider of ACP_PROVIDER_IDS) {
    const spec = buildAcpProviderLaunchSpec({
      provider,
      role: "worker",
      model: `${provider}-model`,
      cwd: REPO_ROOT,
      systemPrompt: "Static role prompt",
      sessionId: `sess-${provider}`
    });
    assert.equal(spec.compactionManagedByProvider, true);
    assert.equal(spec.readOnly, false);
    assert.equal(spec.shell, true);
    assert.equal(spec.hooks, true);
    assert.ok(spec.mcpServers.includes("filesystem"));
    assert.deepEqual(
      spec.acpMcpServers.map((server) => server.name),
      roleContract("worker").mcp
    );
    assert.ok(spec.isolation.nativeTools);
    if (provider === "claude") {
      assert.equal(spec.isolation.nativeTools, "enforced");
      assert.equal(spec.isolation.systemPromptInjection, "cli_flag");
      assert.equal(spec.isolation.gaps.length, 0);
    } else {
      assert.equal(spec.isolation.systemPromptInjection, "initial_turn");
      assert.ok(spec.isolation.gaps.length > 0);
    }

    const browserSpec = buildAcpProviderLaunchSpec({
      provider,
      role: "browser-tester",
      model: `${provider}-model`,
      cwd: REPO_ROOT,
      systemPrompt: "Browser tester prompt",
      sessionId: `sess-bt-${provider}`
    });
    assert.equal(browserSpec.readOnly, true);
    assert.equal(browserSpec.shell, false);
    assert.equal(browserSpec.hooks, false);
    assert.equal(browserSpec.env.AUTODEV_MCP_READ_ONLY, "1");
    assert.equal(browserSpec.env.AUTODEV_ROLE_SHELL_ENABLED, "0");
    assert.ok(
      browserSpec.acpMcpServers.some((server) => server.name === "playwright")
    );
  }

  assert.throws(
    () =>
      buildAcpProviderLaunchSpec({
        provider: "claude",
        role: "nonexistent-role",
        model: "claude-sonnet",
        cwd: REPO_ROOT,
        systemPrompt: "x",
        sessionId: "sess-bad"
      }),
    /Unknown AutoDev agent role/u
  );

  const ghTask = buildOpencliRoleTaskSpec({
    role: GITHUB_WORKER_ROLE,
    provider: "opencli-chatgpt",
    model: "opencli-chatgpt-advanced",
    repository: "SimulatorLife/AutoDev",
    task: "Raise a PR to AutoDev to update README",
    sessionId: "gh-sess-1",
    workspace: REPO_ROOT,
    systemPrompt: "",
    mcpApp: "AutoDev"
  });
  assert.equal(ghTask.role, GITHUB_WORKER_ROLE);
  assert.match(ghTask.prompt, /Raise a PR to AutoDev/u);
  assert.equal(ghTask.mcpApp, "AutoDev");
  assert.equal(ghTask.site, "chatgpt");
});

test("XacpxSessionManager resolves binaries, dispatches every transport, and pins sessions", () => {
  const binaries = resolveXacpxBinaries(process.env);
  assert.equal(existsSync(binaries.xacpxBin), true);
  assert.equal(existsSync(binaries.acpxBin), true);

  const events: AcpConsoleSessionEvent[] = [];
  const manager = new XacpxSessionManager({
    consoleSink: {
      emit: (event) => {
        events.push(event);
      }
    }
  });

  const workerPlan = manager.planDispatch({
    sessionId: "acp-worker-1",
    role: "worker",
    cwd: REPO_ROOT,
    systemPrompt: "Worker prompt",
    promptOrTask: "Implement feature"
  });
  assert.equal(workerPlan.kind, "acp");
  assert.equal(events[0]?.type, "session_started");

  // Re-dispatching on the same session stays pinned and emits session_resumed.
  const resumedPlan = manager.planDispatch({
    sessionId: "acp-worker-1",
    role: "worker",
    cwd: REPO_ROOT,
    systemPrompt: "Worker prompt",
    promptOrTask: "Follow-up"
  });
  assert.equal(resumedPlan.kind, "acp");
  assert.equal(resumedPlan.session.provider, workerPlan.session.provider);
  assert.equal(events[1]?.type, "session_resumed");

  // Switching roles on an already-pinned session is refused.
  assert.throws(() =>
    manager.planDispatch({
      sessionId: "acp-worker-1",
      role: "explorer",
      cwd: REPO_ROOT,
      systemPrompt: "Explorer prompt",
      promptOrTask: "Explore"
    })
  );

  // Cooling down the pinned provider refuses mid-session hopping.
  COOLDOWNS.cooldownProvider(workerPlan.session.provider, {
    failureClass: "rate_limit",
    model: workerPlan.session.model
  });
  try {
    assert.throws(
      () =>
        manager.planDispatch({
          sessionId: "acp-worker-1",
          role: "worker",
          cwd: REPO_ROOT,
          systemPrompt: "Worker prompt",
          promptOrTask: "Retry"
        }),
      /start a new session instead of hopping/u
    );
  } finally {
    COOLDOWNS.clearAfterSuccess(
      workerPlan.session.provider,
      workerPlan.session.model
    );
  }

  // The `github-worker` role is served by an opencli site, and the site is
  // chosen by capability rather than by the role.
  mkdirSync(REPO_ROOT, { recursive: true });
  const ghPlan = manager.planDispatch({
    sessionId: "gh-worker-1",
    role: GITHUB_WORKER_ROLE,
    cwd: REPO_ROOT,
    systemPrompt: "GitHub worker prompt",
    promptOrTask: "Raise a PR to AutoDev",
    repository: "SimulatorLife/AutoDev"
  });
  assert.equal(ghPlan.kind, "opencli");
  assert.match(ghPlan.session.provider, /^opencli-(?:chatgpt|gemini)$/u);
  assert.equal(ghPlan.task.role, GITHUB_WORKER_ROLE);
});

test("an opencli-backed provider serves every role its transport can reach", async () => {
  const policy = new RoutingPolicy(
    ROUTING_POLICY.config,
    ROUTING_POLICY.configFile,
    {}
  );
  for (const provider of policy.providerIds()) {
    policy.setProviderAssignment(provider, "subagent", {
      priority: "disabled",
      model: null
    });
    policy.setProviderAssignment(provider, "orchestrator", {
      priority: "disabled",
      model: null
    });
  }
  policy.setProviderAssignment("opencli-chatgpt", "subagent", {
    priority: 1,
    model: "opencli-chatgpt-fast"
  });
  policy.setProviderAssignment("opencli-chatgpt", "orchestrator", {
    priority: 1,
    model: "opencli-chatgpt-balanced"
  });
  assert.deepEqual(
    policy.roleCandidates("worker").map((candidate) => candidate.provider),
    ["opencli-chatgpt"]
  );

  const manager = new XacpxSessionManager({
    policy,
    opencliRunner: async () => ({
      outputText: "done",
      exitCode: 0,
      conversationId: "chat-1"
    })
  });
  try {
    // A leaf role: the site drives it with the role's MCP app selected.
    const worker = manager.selectCandidateForSession(
      "opencli-parity-worker",
      "worker"
    );
    assert.equal(worker.provider, "opencli-chatgpt");
    const workerPlan = manager.planDispatch({
      sessionId: "opencli-parity-worker",
      role: "worker",
      cwd: REPO_ROOT,
      systemPrompt: "Worker prompt",
      promptOrTask: "Implement the feature"
    });
    assert.equal(workerPlan.kind, "opencli");
    assert.equal(workerPlan.task.role, "worker");
    assert.equal(workerPlan.task.mcpApp, "AutoDev worker");
    assert.match(workerPlan.task.prompt, /Worker prompt/u);
    assert.match(workerPlan.task.prompt, /Implement the feature/u);

    // The orchestrator tier: the same transport now holds the delegation path.
    const orchestrator = manager.selectCandidateForSession(
      "opencli-parity-orchestrator",
      "orchestrator"
    );
    assert.equal(orchestrator.provider, "opencli-chatgpt");
    const orchestratorPlan = manager.planDispatch({
      sessionId: "opencli-parity-orchestrator",
      role: "orchestrator",
      cwd: REPO_ROOT,
      systemPrompt: "Orchestrator prompt",
      promptOrTask: "Plan and delegate"
    });
    assert.equal(orchestratorPlan.kind, "opencli");
    assert.equal(orchestratorPlan.task.role, "orchestrator");
    assert.equal(orchestratorPlan.task.mcpApp, "AutoDev");
  } finally {
    await manager.closeAllSessions();
  }
});

test("a site without a gateway ingress is refused for roles the gateway owns, with the reason named", () => {
  const policy = new RoutingPolicy(
    ROUTING_POLICY.config,
    ROUTING_POLICY.configFile,
    {}
  );
  for (const provider of policy.providerIds()) {
    policy.setProviderAssignment(provider, "subagent", {
      priority: "disabled",
      model: null
    });
  }
  policy.setProviderAssignment("opencli-gemini", "subagent", {
    priority: 1,
    model: "opencli-gemini-4-neon"
  });
  const manager = new XacpxSessionManager({ policy });
  // The `github` surface is the site's own integration, so that role is
  // deliverable; a role whose tools live in the gateway is not.
  assert.equal(policy.providerReachesRoleMcp("opencli-gemini", "github-worker"), true);
  assert.equal(policy.providerReachesRoleMcp("opencli-gemini", "worker"), false);
  assert.throws(
    () => manager.selectCandidateForSession("gemini-parity-worker", "worker"),
    /cannot reach the MCP surface of role 'worker'/u
  );
  assert.equal(manager.getPinnedSession("gemini-parity-worker"), null);
});

test("OpenCLI sessions resume the verified conversation and never replay an uncertain turn", async () => {
  const policy = new RoutingPolicy(
    ROUTING_POLICY.config,
    ROUTING_POLICY.configFile,
    {}
  );
  for (const provider of policy.providerIds()) {
    policy.setProviderAssignment(provider, "subagent", {
      priority: "disabled",
      model: null
    });
  }
  const provider = "opencli-chatgpt";
  const model = "opencli-chatgpt-fast";
  policy.setProviderAssignment(provider, "subagent", { priority: 1, model });
  COOLDOWNS.clearAfterSuccess(provider, model);
  const calls: Array<{
    conversationId: string | null;
    repository: string | null;
  }> = [];
  const manager = new XacpxSessionManager({
    policy,
    opencliRunner: async (task) => {
      calls.push({
        conversationId: task.conversationId,
        repository: task.repository
      });
      return {
        outputText: "done",
        exitCode: 0,
        conversationId: calls.length === 3 ? "wrong-chat" : "verified-chat"
      };
    }
  });
  const request = {
    sessionId: "opencli-persistent",
    role: GITHUB_WORKER_ROLE,
    cwd: REPO_ROOT,
    systemPrompt: "",
    promptOrTask: "inspect",
    repository: "SimulatorLife/AutoDev"
  };
  try {
    COOLDOWNS.cooldownProvider(provider, {
      failureClass: "rate_limit",
      model
    });
    await assert.rejects(
      manager.executeTurn(request),
      /All eligible provider candidates.*cooling down/u
    );
    assert.equal(manager.getPinnedSession(request.sessionId), null);
    assert.equal(calls.length, 0);
    COOLDOWNS.clearAfterSuccess(provider, model);
    const first = await manager.executeTurn(request);
    assert.equal(first.conversationId, "verified-chat");
    const next = await manager.promptSession(request.sessionId, "follow-up");
    assert.equal(next.conversationId, first.conversationId);
    assert.deepEqual(calls, [
      { conversationId: null, repository: request.repository },
      { conversationId: "verified-chat", repository: request.repository }
    ]);
    await assert.rejects(
      manager.executeTurn({ ...request, repository: "another/repo" }),
      /repository cannot change/u
    );
    await assert.rejects(
      manager.executeTurn({ ...request, cwd: path.dirname(REPO_ROOT) }),
      /workspace or parent identity cannot change/u
    );
    await assert.rejects(
      manager.promptSession(request.sessionId, "mismatched reply"),
      /does not match the pinned conversation/u
    );
    await assert.rejects(
      manager.promptSession(request.sessionId, "do not replay"),
      /outcome is uncertain/u
    );
    assert.equal(calls.length, 3);
  } finally {
    await manager.closeAllSessions();
    COOLDOWNS.clearAfterSuccess(provider, model);
  }

  const cancellingManager = new XacpxSessionManager({
    policy,
    opencliRunner: (_task, signal) =>
      new Promise((_resolve, reject) => {
        signal?.addEventListener(
          "abort",
          () => reject(new Error("OpenCLI turn cancelled")),
          { once: true }
        );
      })
  });
  try {
    const turn = cancellingManager.executeTurn(request);
    const rejection = assert.rejects(turn, /cancelled/u);
    assert.equal(await cancellingManager.cancelSession(request.sessionId), true);
    await rejection;
    assert.equal(COOLDOWNS.isCooling(provider, Date.now(), model), false);
    await assert.rejects(
      cancellingManager.promptSession(request.sessionId, "do not replay"),
      /outcome is uncertain/u
    );
  } finally {
    await cancellingManager.closeAllSessions();
    COOLDOWNS.clearAfterSuccess(provider, model);
  }
});

test("XacpxSessionManager executes live ACP turns, enforces read-only permissions, and serves /v1/acp/sessions", async () => {
  const permissionOutcomes: string[] = [];
  let createdSessions = 0;
  let cancelledSessions = 0;
  let closedSessions = 0;

  const createMockAcpAgent = () =>
    new AgentApp({ name: "mock-acp-agent" })
      .onRequest(AGENT_METHODS.initialize, async () => ({
        protocolVersion: PROTOCOL_VERSION,
        agentCapabilities: { loadSession: false }
      }))
      .onRequest(AGENT_METHODS.session_new, async () => {
        createdSessions += 1;
        return { sessionId: `acp-live-${createdSessions}` };
      })
      .onRequest(AGENT_METHODS.session_prompt, async ({ params, client }) => {
        const promptText = params.prompt
          .map((block) => (block.type === "text" ? block.text : ""))
          .join("");
        const permission = await client.request(
          CLIENT_METHODS.session_request_permission,
          {
            sessionId: params.sessionId,
            toolCall: {
              toolCallId: "tc-1",
              name: promptText.includes("attempt-write")
                ? "mcp__filesystem__write_file"
                : "mcp__filesystem__read_text_file",
              rawInput: { path: "/tmp/example.ts" }
            },
            options: [
              {
                optionId: "allow",
                name: "Allow once",
                kind: "allow_once"
              },
              {
                optionId: "reject",
                name: "Reject once",
                kind: "reject_once"
              }
            ]
          }
        );
        permissionOutcomes.push(
          permission.outcome.outcome === "selected"
            ? permission.outcome.optionId
            : permission.outcome.outcome
        );
        await client.notify("session/update", {
          sessionId: params.sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: {
              type: "text",
              text: `echo:${promptText}`
            }
          }
        });
        return { stopReason: "end_turn" };
      })
      .onNotification(AGENT_METHODS.session_cancel, () => {
        cancelledSessions += 1;
      })
      .onRequest(AGENT_METHODS.session_close, async () => {
        closedSessions += 1;
        return {};
      });

  const events: AcpConsoleSessionEvent[] = [];
  let transportCalls = 0;
  let launchedPromptMode: string | undefined;
  const opencliCalls: string[] = [];
  const manager = new XacpxSessionManager({
    consoleSink: {
      emit: (event) => {
        events.push(event);
      }
    },
    acpTransportFactory: (launch) => {
      transportCalls += 1;
      launchedPromptMode = launch.isolation.systemPromptInjection;
      return { target: createMockAcpAgent() };
    },
    opencliRunner: async (task) => {
      opencliCalls.push(`${task.provider}:${task.prompt}`);
      return {
        outputText: "github pr #42 opened",
        exitCode: 0,
        conversationId: "github-chat-42"
      };
    }
  });

  // Read-only explorer denies mutating tools and allows read-only tools across
  // two turns sharing one pinned ACP session.
  const firstTurn = await manager.executeTurn({
    sessionId: "sess-ro-1",
    role: "explorer",
    cwd: REPO_ROOT,
    systemPrompt: "Explorer prompt",
    promptOrTask: "attempt-write"
  });
  assert.equal(firstTurn.kind, "acp");
  assert.equal(
    firstTurn.outputText,
    launchedPromptMode === "initial_turn"
      ? "echo:<system_instructions>\nExplorer prompt\n</system_instructions>\n\nattempt-write"
      : "echo:attempt-write"
  );
  assert.equal(firstTurn.stopReason, "end_turn");
  assert.equal(transportCalls, 1);

  const followUpTurn = await manager.promptSession(
    "sess-ro-1",
    "read-file-next"
  );
  assert.equal(followUpTurn.acpSessionId, firstTurn.acpSessionId);
  assert.equal(followUpTurn.outputText, "echo:read-file-next");
  assert.equal(transportCalls, 1);
  assert.deepEqual(permissionOutcomes, ["reject", "allow"]);

  // Direct github-worker web execution bypasses ACP and /v1/responses.
  const ghResult = await manager.executeTurn({
    sessionId: "sess-gh-1",
    role: GITHUB_WORKER_ROLE,
    cwd: REPO_ROOT,
    systemPrompt: "",
    promptOrTask: "Inspect PR checks",
    repository: "SimulatorLife/AutoDev"
  });
  assert.equal(ghResult.kind, "opencli");
  assert.equal(ghResult.outputText, "github pr #42 opened");
  assert.equal(ghResult.conversationId, "github-chat-42");
  assert.equal(opencliCalls.length, 1);

  // HTTP /v1/acp/sessions endpoint round-trip.
  const server = createServer((request, response) => {
    const pathname = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
    void (async () => {
      const handled = await didHandleAcpRoute(
        request,
        response,
        pathname,
        manager
      );
      if (!handled) {
        response.writeHead(404).end();
      }
    })();
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const port = (server.address() as AddressInfo).port;
    const listResponse = await fetch(
      `http://127.0.0.1:${port}/v1/acp/sessions`
    );
    assert.equal(listResponse.status, 200);
    const listBody = (await listResponse.json()) as {
      sessions: { sessionId: string }[];
    };
    assert.equal(listBody.sessions.length, 2);

    const cancelResponse = await fetch(
      `http://127.0.0.1:${port}/v1/acp/sessions/sess-ro-1/cancel`,
      { method: "POST" }
    );
    assert.equal(cancelResponse.status, 200);
    assert.equal(cancelledSessions, 1);

    const deleteResponse = await fetch(
      `http://127.0.0.1:${port}/v1/acp/sessions/sess-ro-1`,
      { method: "DELETE" }
    );
    assert.equal(deleteResponse.status, 200);
    assert.equal(closedSessions, 1);
    assert.equal(manager.hasLiveAcpSession("sess-ro-1"), false);
  } finally {
    await manager.closeAllSessions();
    server.close();
  }

  // Minimax routes cleanly through mcode ACP and binary discovery, and receives
  // MINIMAX_API_KEY only for mcode while CONTEXT7_API_KEY is injected only for
  // roles that enable context7.
  const mcodeLaunch = buildAcpProviderLaunchSpec({
    provider: "mcode",
    role: "worker",
    model: "MiniMax-M3",
    cwd: REPO_ROOT,
    systemPrompt: "Worker",
    sessionId: "sess-mcode-1",
    env: {
      CODEX_HOME: process.env.CODEX_HOME!,
      MINIMAX_API_KEY: "minimax-secret",
      CONTEXT7_API_KEY: "context7-secret"
    }
  });
  assert.equal(mcodeLaunch.command, "mcode");
  assert.deepEqual(mcodeLaunch.args, ["acp"]);
  assert.equal(mcodeLaunch.env.MINIMAX_API_KEY, "minimax-secret");
  assert.equal(mcodeLaunch.env.CONTEXT7_API_KEY, undefined);
  // MiniMax Code reads its profile from MINIMAX_DATA_DIR and never from
  // MCODE_HOME, so the AutoDev-managed profile is handed over that way.
  assert.equal(
    mcodeLaunch.env.MINIMAX_DATA_DIR,
    path.join(autodevHome(), "providers", "mcode")
  );
  assert.equal(mcodeLaunch.env.MCODE_HOME, undefined);

  const claudeWorker = buildAcpProviderLaunchSpec({
    provider: "claude",
    role: "worker",
    model: "sonnet",
    cwd: REPO_ROOT,
    systemPrompt: "Worker",
    sessionId: "sess-claude-worker",
    env: {
      CODEX_HOME: process.env.CODEX_HOME!,
      MINIMAX_API_KEY: "minimax-secret",
      CONTEXT7_API_KEY: "context7-secret"
    }
  });
  assert.equal(claudeWorker.env.MINIMAX_API_KEY, undefined);
  assert.equal(claudeWorker.env.CONTEXT7_API_KEY, undefined);

  const documentationResearcher = buildAcpProviderLaunchSpec({
    provider: "claude",
    role: "docs-researcher",
    model: "sonnet",
    cwd: REPO_ROOT,
    systemPrompt: "Docs",
    sessionId: "sess-docs-1",
    env: {
      CODEX_HOME: process.env.CODEX_HOME!,
      MINIMAX_API_KEY: "minimax-secret",
      CONTEXT7_API_KEY: "context7-secret"
    }
  });
  assert.equal(documentationResearcher.env.MINIMAX_API_KEY, undefined);
  // Documentation servers are reached through the gateway, which alone holds
  // their credentials.
  assert.equal(documentationResearcher.env.CONTEXT7_API_KEY, undefined);
  assert.equal(findMcodeBinary({ PATH: "", HOME: "/nonexistent-home" }), null);
});

test("XACPX role permissions, anti-escalation, workspace confinement, and orchestration IPC enforce canonical contracts", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "autodev-xacpx-ipc-"));
  const workspace = path.join(root, "workspace");
  const outside = path.join(root, "outside");
  mkdirSync(workspace, { recursive: true });
  mkdirSync(outside, { recursive: true });

  // Anti-escalation and unknown role denial.
  assert.equal(validateDelegatedRole("worker"), "worker");
  assert.equal(validateDelegatedRole("explorer"), "explorer");
  assert.throws(() => validateDelegatedRole("orchestrator"), /escalation/i);
  assert.throws(() => validateDelegatedRole("nonexistent"), /Unknown/i);

  // Workspace confinement.
  assert.equal(
    validateDelegatedWorkspace(workspace, workspace),
    path.resolve(workspace).replace(/^\/var\//, "/private/var/")
  );
  assert.throws(
    () => validateDelegatedWorkspace(outside, workspace),
    /confinement/i
  );

  // Per-role MCP server + read-only permission enforcement.
  const options = [
    { optionId: "allow", name: "Allow", kind: "allow_once" as const },
    { optionId: "reject", name: "Reject", kind: "reject_once" as const }
  ];
  const workerWrite = resolveAcpPermissionResponse("worker", {
    sessionId: "s1",
    toolCall: { toolCallId: "1", name: "mcp__filesystem__write_file" },
    options
  });
  assert.deepEqual(workerWrite, {
    outcome: { outcome: "selected", optionId: "allow" }
  });
  const explorerWrite = resolveAcpPermissionResponse("explorer", {
    sessionId: "s2",
    toolCall: { toolCallId: "2", name: "mcp__filesystem__write_file" },
    options
  });
  assert.deepEqual(explorerWrite, {
    outcome: { outcome: "selected", optionId: "reject" }
  });
  const workerUngrantedMcp = resolveAcpPermissionResponse("worker", {
    sessionId: "s3",
    toolCall: { toolCallId: "3", name: "mcp__playwright__browser_navigate" },
    options
  });
  assert.deepEqual(workerUngrantedMcp, {
    outcome: { outcome: "selected", optionId: "reject" }
  });
  const workerDisallowedCgcTool = resolveAcpPermissionResponse("worker", {
    sessionId: "s4",
    toolCall: {
      toolCallId: "4",
      name: "mcp__codegraphcontext__delete_repository"
    },
    options
  });
  assert.deepEqual(workerDisallowedCgcTool, {
    outcome: { outcome: "selected", optionId: "reject" }
  });

  // Shell-disabled roles deny host shell tools; writable worker allows shell.
  const browserShell = resolveAcpPermissionResponse("browser-tester", {
    sessionId: "s5",
    toolCall: { toolCallId: "5", name: "bash" },
    options
  });
  assert.deepEqual(browserShell, {
    outcome: { outcome: "selected", optionId: "reject" }
  });
  const analystShell = resolveAcpPermissionResponse("playtest-analyst", {
    sessionId: "s6",
    toolCall: { toolCallId: "6", name: "exec_command" },
    options
  });
  assert.deepEqual(analystShell, {
    outcome: { outcome: "selected", optionId: "reject" }
  });
  const workerShell = resolveAcpPermissionResponse("worker", {
    sessionId: "s7",
    toolCall: { toolCallId: "7", name: "bash" },
    options
  });
  assert.deepEqual(workerShell, {
    outcome: { outcome: "selected", optionId: "allow" }
  });

  // Provider-native file tools are denied across ALL roles in favor of filesystem MCP.
  for (const nativeFileTool of [
    "apply_patch",
    "view_image",
    "write_to_file",
    "replace_file_content"
  ]) {
    const decision = resolveAcpPermissionResponse("worker", {
      sessionId: "s8",
      toolCall: { toolCallId: `nf-${nativeFileTool}`, name: nativeFileTool },
      options
    });
    assert.deepEqual(
      decision,
      { outcome: { outcome: "selected", optionId: "reject" } },
      `native file tool ${nativeFileTool} must be denied even for writable worker`
    );
  }

  // Unknown role fails closed.
  const unknownDecision = resolveAcpPermissionResponse("nonexistent", {
    sessionId: "s9",
    toolCall: { toolCallId: "9", name: "mcp__filesystem__read_text_file" },
    options
  });
  assert.deepEqual(unknownDecision, {
    outcome: { outcome: "selected", optionId: "reject" }
  });

  // Direct canonical `.rulesync/mcp.jsonc` catalogue rendering (no temp Codex TOML detour).
  const catalogue = JSON.parse(
    renderBridgeMcpCatalogue(path.join(REPO_ROOT, ".rulesync", "mcp.jsonc"))
  ) as Record<string, Record<string, unknown>>;
  for (const requiredServer of [
    "filesystem",
    "lsp",
    "cocoindex-code",
    "codegraphcontext",
    "xacpx",
    "github",
    "playwright",
    "playtest",
    "openaiDeveloperDocs",
    "context7",
    "googleDeveloperKnowledge"
  ]) {
    assert.ok(
      catalogue[requiredServer],
      `canonical MCP catalogue must include ${requiredServer}`
    );
  }
  assert.equal(
    roleContract("orchestrator", REPO_ROOT).mcp.includes("codex_app"),
    false
  );
  assert.deepEqual(catalogue.googleDeveloperKnowledge?.http_headers, {
    "X-Goog-Api-Key": "${GOOGLE_DEVELOPER_KNOWLEDGE_API_KEY}"
  });

  // ACP session/new delivers native mcpServers and injects canonical system prompt on initial turn only.
  const observedSessionNew: Array<{ cwd: string; mcpServers: unknown[] }> = [];
  const observedPrompts: string[] = [];
  const acpManager = new XacpxSessionManager({
    acpTransportFactory: (launch) => ({
      target: new AgentApp({ name: `mock-${launch.provider}` })
        .onRequest(AGENT_METHODS.initialize, async () => ({
          protocolVersion: PROTOCOL_VERSION,
          agentCapabilities: { loadSession: false }
        }))
        .onRequest(AGENT_METHODS.session_new, async ({ params }) => {
          observedSessionNew.push({
            cwd: params.cwd,
            mcpServers: [...(params.mcpServers ?? [])]
          });
          return { sessionId: "acp-mcp-1" };
        })
        .onRequest(AGENT_METHODS.session_prompt, async ({ params, client }) => {
          const text = params.prompt
            .map((b) => (b.type === "text" ? b.text : ""))
            .join("");
          observedPrompts.push(text);
          await client.notify("session/update", {
            sessionId: params.sessionId,
            update: {
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text: "ok" }
            }
          });
          return { stopReason: "end_turn" };
        })
        .onRequest(AGENT_METHODS.session_close, async () => ({}))
    })
  });
  await acpManager.executeTurn({
    sessionId: "sess-mcp-gw-1",
    role: "worker",
    cwd: workspace,
    systemPrompt: "CANONICAL_ROLE_INSTRUCTIONS",
    promptOrTask: "first turn"
  });
  await acpManager.promptSession("sess-mcp-gw-1", "second turn");
  await acpManager.closeSession("sess-mcp-gw-1");
  assert.equal(observedSessionNew.length, 1);
  assert.deepEqual(
    observedSessionNew[0]?.mcpServers.map(
      (server) => (server as { name: string }).name
    ),
    roleContract("worker").mcp
  );
  assert.equal(observedPrompts.length, 2);
  assert.match(observedPrompts[1] ?? "", /^second turn$/u);

  // Orchestration IPC server lifecycle check.
  const socketPath = path.join(root, "xacpx.sock");
  const manager = new XacpxSessionManager();
  const handle = await startXacpxOrchestrationIpcServer({
    socketPath,
    manager,
    authorizedWorkspaceRoot: workspace,
    repositoryRoot: REPO_ROOT
  });
  try {
    assert.equal(existsSync(socketPath), true);
  } finally {
    await handle.close();
    rmSync(root, { recursive: true, force: true });
  }
});
