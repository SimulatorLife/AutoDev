import assert from "node:assert/strict";
import { once } from "node:events";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync
} from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
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
  buildAcpProviderLaunchSpec,
  buildGithubWorkerTaskSpec,
  GITHUB_WORKER_ROLE
} from "../src/acp/provider-profiles.ts";
import { evaluatePreToolUse as evaluateBlockCcc } from "../src/hooks/block-ccc-cli.ts";
import { evaluateFileSurfaceHook } from "../src/hooks/file-surface.ts";
import {
  extractHookContext,
  extractHookToolCall
} from "../src/hooks/hook-payload.ts";
import { evaluateRoleSandboxHook } from "../src/hooks/role-sandbox.ts";
import { resolveMcpCommand } from "../src/mcp/launcher.ts";
import {
  materializeMcodeProjection,
  renderMcodeProjection
} from "../src/platform/mcode-projection.ts";
import { COOLDOWNS } from "../src/router/cooldown/index.ts";
import { autodevHome, autodevStateHome } from "../src/shared/autodev-home.ts";
import { findMcodeBinary } from "../src/shared/executables.ts";
import {
  extractSkillReadPath,
  matchSkillReadTarget
} from "../src/shared/skill-reads.ts";
import { didHandleAcpRoute } from "../src/xacpx/http.ts";
import {
  type AcpConsoleSessionEvent,
  resolveXacpxBinaries,
  XacpxSessionManager
} from "../src/xacpx/manager.ts";

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));

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
    AUTODEV_AGENT_ROLE: "explorer",
    AUTODEV_PROVIDER: "antigravity"
  });
  assert.equal(hookContext.sessionId, "agy-session-1");
  assert.equal(hookContext.role, "explorer");
  assert.equal(hookContext.provider, "antigravity");
});

test("Antigravity PreToolUse payloads enforce file-surface, ccc block, and read-only sandbox", () => {
  const nativeWrite = JSON.stringify({
    toolCall: { name: "write_to_file", arguments: { TargetFile: "a.ts" } }
  });
  assert.equal(evaluateFileSurfaceHook(nativeWrite).denied, true);

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
  assert.equal(evaluateRoleSandboxHook(readonlyMcpWrite).denied, true);
});

test("MCP launcher resolves newly added github and xacpx servers", () => {
  const githubCommand = resolveMcpCommand("github", REPO_ROOT);
  assert.equal(existsSync(githubCommand.binary), true);
  const xacpxCommand = resolveMcpCommand("xacpx", REPO_ROOT, {
    AUTODEV_XACPX_COORDINATOR_SESSION: "coord-1",
    AUTODEV_XACPX_WORKSPACE: "AutoDev"
  });
  assert.equal(existsSync(xacpxCommand.binary), true);
  assert.deepEqual(xacpxCommand.args, [
    "mcp-stdio",
    "--coordinator-session",
    "coord-1",
    "--workspace",
    "AutoDev"
  ]);
});

test("ACP provider profiles disable native surfaces across all ACP providers", () => {
  for (const provider of ACP_PROVIDER_IDS) {
    const spec = buildAcpProviderLaunchSpec({
      provider,
      role: "worker",
      model: `${provider}-model`,
      cwd: REPO_ROOT,
      systemPrompt: "Static role prompt",
      sessionId: `sess-${provider}`
    });
    assert.equal(spec.nativeToolsDisabled, true);
    assert.equal(spec.nativePromptsDisabled, true);
    assert.equal(spec.nativeSkillsDisabled, true);
    assert.equal(spec.nativeMcpsDisabled, true);
    assert.equal(spec.compactionManagedByProvider, true);
    assert.ok(spec.mcpServers.includes("filesystem"));
  }

  const ghTask = buildGithubWorkerTaskSpec({
    provider: "opencli-chatgpt",
    model: "opencli-chatgpt-advanced",
    repository: "SimulatorLife/AutoDev",
    task: "Raise a PR to AutoDev to update README",
    sessionId: "gh-sess-1"
  });
  assert.equal(ghTask.role, GITHUB_WORKER_ROLE);
  assert.match(ghTask.prompt, /Raise a PR to AutoDev/u);
});

test("mcode projection materializes and detects drift from canonical .rulesync", () => {
  const temporaryDirectory = mkdtempSync(
    path.join(tmpdir(), "autodev-mcode-proj-")
  );
  const mcodeHome = path.join(temporaryDirectory, "mcode-home");
  try {
    const preview = renderMcodeProjection(REPO_ROOT);
    assert.ok(JSON.parse(preview.mcpJson).mcpServers.filesystem);
    assert.ok(JSON.parse(preview.mcpJson).mcpServers.github);
    assert.ok(JSON.parse(preview.mcpJson).mcpServers.xacpx);

    const result = materializeMcodeProjection({
      repositoryRoot: REPO_ROOT,
      mcodeHome
    });
    assert.equal(result.written.length, 4);
    assert.ok(existsSync(path.join(mcodeHome, "AGENTS.md")));
    assert.equal(
      readFileSync(path.join(mcodeHome, "mcp.json"), "utf8"),
      preview.mcpJson
    );

    const checkClean = materializeMcodeProjection({
      repositoryRoot: REPO_ROOT,
      mcodeHome,
      check: true
    });
    assert.deepEqual(checkClean.drifted, []);
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});

test("XacpxSessionManager resolves binaries, enforces github-worker <-> opencli boundary, and pins sessions", () => {
  const binaries = resolveXacpxBinaries(process.env, REPO_ROOT);
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

  // github-worker routes exclusively to opencli-chatgpt / opencli-gemini.
  mkdirSync(REPO_ROOT, { recursive: true });
  const ghPlan = manager.planDispatch({
    sessionId: "gh-worker-1",
    role: GITHUB_WORKER_ROLE,
    cwd: REPO_ROOT,
    systemPrompt: "GitHub worker prompt",
    promptOrTask: "Raise a PR to AutoDev",
    repository: "SimulatorLife/AutoDev"
  });
  assert.equal(ghPlan.kind, "opencli-github-worker");
  assert.match(ghPlan.session.provider, /^opencli-(?:chatgpt|gemini)$/u);
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
  const opencliCalls: string[] = [];
  const manager = new XacpxSessionManager({
    consoleSink: {
      emit: (event) => {
        events.push(event);
      }
    },
    acpTransportFactory: () => {
      transportCalls += 1;
      return { target: createMockAcpAgent() };
    },
    githubWorkerRunner: async (task) => {
      opencliCalls.push(`${task.provider}:${task.prompt}`);
      return { outputText: "github pr #42 opened", exitCode: 0 };
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
  assert.equal(firstTurn.outputText, "echo:attempt-write");
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
  assert.equal(ghResult.kind, "opencli-github-worker");
  assert.equal(ghResult.outputText, "github pr #42 opened");
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
      MINIMAX_API_KEY: "minimax-secret",
      CONTEXT7_API_KEY: "context7-secret"
    }
  });
  assert.equal(mcodeLaunch.command, "mcode");
  assert.deepEqual(mcodeLaunch.args, ["acp"]);
  assert.equal(mcodeLaunch.env.MINIMAX_API_KEY, "minimax-secret");
  assert.equal(mcodeLaunch.env.CONTEXT7_API_KEY, undefined);

  const claudeWorker = buildAcpProviderLaunchSpec({
    provider: "claude",
    role: "worker",
    model: "sonnet",
    cwd: REPO_ROOT,
    systemPrompt: "Worker",
    sessionId: "sess-claude-worker",
    env: {
      MINIMAX_API_KEY: "minimax-secret",
      CONTEXT7_API_KEY: "context7-secret"
    }
  });
  assert.equal(claudeWorker.env.MINIMAX_API_KEY, undefined);
  assert.equal(claudeWorker.env.CONTEXT7_API_KEY, undefined);

  const docsResearcher = buildAcpProviderLaunchSpec({
    provider: "claude",
    role: "docs-researcher",
    model: "sonnet",
    cwd: REPO_ROOT,
    systemPrompt: "Docs",
    sessionId: "sess-docs-1",
    env: {
      MINIMAX_API_KEY: "minimax-secret",
      CONTEXT7_API_KEY: "context7-secret"
    }
  });
  assert.equal(docsResearcher.env.MINIMAX_API_KEY, undefined);
  assert.equal(docsResearcher.env.CONTEXT7_API_KEY, "context7-secret");
  assert.equal(findMcodeBinary({ PATH: "", HOME: "/nonexistent-home" }), null);
});
