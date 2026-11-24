import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

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
import {
  extractSkillReadPath,
  matchSkillReadTarget
} from "../src/shared/skill-reads.ts";
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
