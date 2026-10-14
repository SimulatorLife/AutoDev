import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  buildProviderPrompt,
  parseProviderAgentArgs,
  type ProviderAgentDeps,
  readRoleExecutionSettings,
  runProviderAgent
} from "@simulatorlife/autodev-runtime/cli/provider-agent";

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));

function fixture(): {
  root: string;
  env: NodeJS.ProcessEnv;
  roleFile: string;
  codex: string;
} {
  const root = mkdtempSync(join(tmpdir(), "autodev-provider-agent-"));
  const codexHome = join(root, ".codex");
  const workspace = join(root, "workspace");
  mkdirSync(join(codexHome, "agents"), { recursive: true });
  mkdirSync(workspace);
  const roleFile = join(codexHome, "agents", "smart.toml");
  writeFileSync(
    roleFile,
    'name = "smart"\ndeveloper_instructions = "Use the typed path."\nmodel_reasoning_effort = "high"\nmodel_reasoning_summary = "concise"\nsandbox_mode = "read-only"\n'
  );
  const codex = join(root, "codex");
  writeFileSync(codex, "#!/bin/sh\nexit 0\n");
  chmodSync(codex, 0o700);
  return {
    root,
    env: {
      ...process.env,
      HOME: root,
      CODEX_HOME: codexHome,
      AUTODEV_REPO_ROOT: repositoryRoot,
      AUTODEV_MEMORY_DATABASE_URL:
        "postgresql://memory-user:secret@127.0.0.1/memory",
      AUTODEV_MEMORY_WORKSPACE_ID: "workspace-1",
      AUTODEV_MEMORY_REPOSITORY_ID: "repository-1",
      AUTODEV_MEMORY_REPOSITORY_ROOT: workspace,
      AUTODEV_MEMORY_AUTHORITY: "root",
      AUTODEV_MEMORY_READ_GLOBAL: "1",
      AUTODEV_MEMORY_READ_TASK_HISTORY: "1",
      CODEX_BIN: codex
    },
    roleFile,
    codex
  };
}

test("role settings are read from typed TOML without Python or shell parsing", () => {
  const f = fixture();
  try {
    assert.deepEqual(readRoleExecutionSettings(f.roleFile), {
      developerInstructions: "Use the typed path.",
      reasoningEffort: "high",
      reasoningSummary: "concise",
      sandboxMode: "read-only"
    });
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("argument parsing resolves role, workspace, prompt file, and executable", () => {
  const f = fixture();
  try {
    const promptFile = join(f.root, "prompt.txt");
    writeFileSync(promptFile, "read this prompt");
    const options = parseProviderAgentArgs(
      [
        "--role",
        "smart",
        "--cwd",
        join(f.root, "workspace"),
        "--prompt-file",
        promptFile,
        "--check"
      ],
      f.env
    );
    assert.equal(options.role, "smart");
    assert.equal(options.workspace, join(f.root, "workspace"));
    assert.equal(options.prompt, "read this prompt");
    assert.equal(options.checkOnly, true);
    assert.equal(options.codexBinary, f.codex);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("provider agent builds the bounded prompt and role-specific Codex flags", async () => {
  const f = fixture();
  try {
    const calls: Array<{
      binary: string;
      args: string[];
      env: NodeJS.ProcessEnv;
      checkOnly: boolean;
    }> = [];
    const credentialFile = join(f.root, "provider.env");
    writeFileSync(
      credentialFile,
      "AUTODEV_CONTROL_API_TOKEN=general-secret\n" +
        "AUTODEV_PLAYTEST_ANALYST_CONTROL_API_TOKEN=analyst-secret\n" +
        "AUTODEV_PLAYTEST_CONTROL_API_TOKEN=runner-file-secret\n" +
        "AUTODEV_PLAYTEST_CONTROL_API_ROLE=playtester\n"
    );
    const env = {
      ...f.env,
      CODEX_ENV_FILE: credentialFile,
      AUTODEV_PLAYTEST_CONTROL_API_TOKEN: "analyst-env-secret",
      AUTODEV_PLAYTEST_CONTROL_API_ROLE: "playtest-analyst"
    };
    const deps: ProviderAgentDeps = {
      ensureRouter: async () => undefined,
      runCodex: (binary, args, runtimeEnvironment, checkOnly) => {
        calls.push({ binary, args, env: runtimeEnvironment, checkOnly });
        return 0;
      }
    };
    assert.equal(
      buildProviderPrompt("do the task", readRoleExecutionSettings(f.roleFile)),
      "Provider-neutral role instructions:\nUse the typed path.\n\nBounded task:\ndo the task"
    );
    assert.equal(
      await runProviderAgent(
        [
          "--role",
          "smart",
          "--cwd",
          join(f.root, "workspace"),
          "--prompt",
          "do the task"
        ],
        env,
        deps
      ),
      0
    );
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.binary, f.codex);
    assert.equal(calls[0]?.checkOnly, false);
    assert.equal(calls[0]?.env.AUTODEV_CONTROL_API_TOKEN, undefined);
    assert.equal(
      calls[0]?.env.AUTODEV_PLAYTEST_ANALYST_CONTROL_API_TOKEN,
      undefined
    );
    assert.equal(
      calls[0]?.env.AUTODEV_PLAYTEST_CONTROL_API_TOKEN,
      "analyst-env-secret"
    );
    assert.equal(
      calls[0]?.env.AUTODEV_PLAYTEST_CONTROL_API_ROLE,
      "playtest-analyst"
    );
    assert.deepEqual(calls[0]?.args.slice(0, 8), [
      "--strict-config",
      "-C",
      join(f.root, "workspace"),
      "-c",
      "model_reasoning_effort=high",
      "-c",
      "model_reasoning_summary=concise",
      "-c"
    ]);
    assert.ok(calls[0]?.args.includes("sandbox_mode=read-only"));
    assert.ok(
      calls[0]?.args.includes("mcp_servers.autodev_memory.enabled=true")
    );
    assert.ok(
      calls[0]?.args.includes(
        'shell_environment_policy.filters.AUTODEV_MEMORY_DATABASE_URL="exclude"'
      )
    );
    assert.ok(
      calls[0]?.args.includes(
        `mcp_servers.autodev_memory.command=${JSON.stringify(process.execPath)}`
      )
    );
    assert.ok(
      calls[0]?.args.some((argument) => {
        const prefix = "mcp_servers.autodev_memory.args=";
        if (!argument.startsWith(prefix)) return false;
        assert.deepEqual(JSON.parse(argument.slice(prefix.length)), [
          join(
            f.root,
            "workspace",
            "runtime",
            "src",
            "router",
            "memory-mcp-main.ts"
          )
        ]);
        return true;
      })
    );
    assert.ok(
      calls[0]?.args.every(
        (argument) => !argument.includes("postgresql://memory-user:secret")
      )
    );
    assert.equal(
      calls[0]?.env.AUTODEV_MEMORY_REPOSITORY_ROOT,
      join(f.root, "workspace")
    );
    assert.equal(calls[0]?.env.AUTODEV_MEMORY_AUTHORITY, "worker");
    assert.equal(calls[0]?.env.AUTODEV_MEMORY_ROLE, "smart");
    assert.equal(calls[0]?.env.AUTODEV_MEMORY_READ_GLOBAL, undefined);
    assert.equal(calls[0]?.env.AUTODEV_MEMORY_READ_TASK_HISTORY, undefined);
    assert.equal(calls[0]?.env.AUTODEV_MEMORY_TASK_TEXT, undefined);
    assert.match(calls[0]?.env.AUTODEV_MEMORY_TASK_ID ?? "", /^provider-task-/);
    assert.match(calls[0]?.env.AUTODEV_MEMORY_RUN_ID ?? "", /^provider-run-/);
    assert.equal(
      calls[0]?.args.at(-1),
      "Provider-neutral role instructions:\nUse the typed path.\n\nBounded task:\ndo the task"
    );
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("provider agent disables direct Memory MCP access outside ordinary JIT", async () => {
  const f = fixture();
  try {
    const modes: Array<{
      readonly name: string;
      readonly environment: NodeJS.ProcessEnv;
    }> = [
      { name: "disabled", environment: { AUTODEV_MEMORY_MODE: "disabled" } },
      {
        name: "retrieval-only",
        environment: {
          AUTODEV_MEMORY_MODE: "retrieval-only",
          AUTODEV_MEMORY_ABLATION: "1"
        }
      },
      { name: "invalid", environment: { AUTODEV_MEMORY_MODE: "invalid" } },
      {
        name: "controlled JIT experiment",
        environment: {
          AUTODEV_MEMORY_MODE: "jit",
          AUTODEV_MEMORY_ABLATION: "1",
          AUTODEV_MEMORY_EXPERIMENT_ID: "memory-cohort-1"
        }
      },
      {
        name: "untrusted workspace",
        environment: {
          AUTODEV_MEMORY_REPOSITORY_ROOT: join(f.root, "elsewhere")
        }
      },
      {
        name: "missing database configuration",
        environment: { AUTODEV_MEMORY_DATABASE_URL: undefined }
      }
    ];

    for (const mode of modes) {
      const calls: string[][] = [];
      const deps: ProviderAgentDeps = {
        ensureRouter: async () => undefined,
        runCodex: (_binary, args) => {
          calls.push(args);
          return 0;
        }
      };
      assert.equal(
        await runProviderAgent(
          [
            "--role",
            "smart",
            "--cwd",
            join(f.root, "workspace"),
            "--prompt",
            "do the task"
          ],
          { ...f.env, ...mode.environment },
          deps
        ),
        0,
        mode.name
      );
      const args = calls[0] ?? [];
      assert.ok(
        args.includes("mcp_servers.autodev_memory.enabled=false"),
        mode.name
      );
      assert.ok(
        args.every(
          (argument) =>
            !argument.startsWith("mcp_servers.autodev_memory.command=") &&
            !argument.startsWith("mcp_servers.autodev_memory.args=")
        ),
        mode.name
      );
    }
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("provider agent check mode validates the role without requiring a prompt", async () => {
  const f = fixture();
  try {
    const calls: boolean[] = [];
    const deps: ProviderAgentDeps = {
      ensureRouter: async () => undefined,
      runCodex: (_binary, _args, _env, checkOnly) => {
        calls.push(checkOnly);
        return 0;
      }
    };
    assert.equal(
      await runProviderAgent(["--role", "smart", "--check"], f.env, deps),
      0
    );
    assert.deepEqual(calls, [true]);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("playtest-analyst runs through the provider-neutral role path", () => {
  const f = fixture();
  try {
    const roleFile = join(f.root, ".codex", "agents", "playtest-analyst.toml");
    writeFileSync(
      roleFile,
      'name = "playtest-analyst"\nsandbox_mode = "read-only"\n'
    );
    const options = parseProviderAgentArgs(
      [
        "--role",
        "playtest-analyst",
        "--cwd",
        join(f.root, "workspace"),
        "--prompt",
        "review only the selected evidence"
      ],
      f.env
    );
    assert.equal(options.role, "playtest-analyst");
    assert.equal(readRoleExecutionSettings(roleFile).sandboxMode, "read-only");
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("playtest analyst process excludes every Control API credential", async () => {
  const f = fixture();
  try {
    writeFileSync(
      join(f.root, ".codex", "agents", "playtest-analyst.toml"),
      [
        'name = "playtest-analyst"',
        'sandbox_mode = "read-only"',
        "[features]",
        "shell_tool = false",
        "multi_agent = false",
        "[tools]",
        "web_search = false",
        "[mcp_servers.playtest]",
        "enabled = true",
        'enabled_tools = ["playtest.prepareReview", "playtest.submitReview", "playtest.submitCrossSessionSynthesis"]',
        'env_vars = ["AUTODEV_PLAYTEST_ROLE", "AUTODEV_PLAYTEST_WORKSPACE_ID", "AUTODEV_PLAYTEST_ACTOR_ID", "AUTODEV_PLAYTEST_TASK_ID", "AUTODEV_PLAYTEST_RUN_ID", "AUTODEV_PLAYTEST_ANALYSIS_ID", "AUTODEV_PLAYTEST_SELECTED_EPISODE_IDS", "AUTODEV_PLAYTEST_ANALYSIS_METRIC_AGGREGATION", "AUTODEV_PLAYTEST_REPOSITORY_ROOT", "AUTODEV_REPO_ROOT", "CODEX_HOME"]'
      ].join("\n") + "\n"
    );
    writeFileSync(
      join(f.root, ".codex", "config.toml"),
      '[model_providers.local_model_router]\nname = "local"\nbase_url = "http://127.0.0.1:4100/v1"\nenv_key = "CODEX_ROUTER_AUTH_TOKEN"\nwire_api = "responses"\n'
    );
    const credentialFile = join(f.root, "analyst-provider.env");
    writeFileSync(
      credentialFile,
      [
        "AUTODEV_CONTROL_API_TOKEN=general-secret",
        "AUTODEV_PLAYTEST_CONTROL_API_TOKEN=runner-file-secret",
        "AUTODEV_MEMORY_DATABASE_URL=memory-secret",
        "AUTODEV_MEMORY_READ_GLOBAL=1",
        "OPENLIT_DB_PASSWORD=database-secret"
      ].join("\n") + "\n"
    );
    const environment: NodeJS.ProcessEnv = {
      ...f.env,
      CODEX_ENV_FILE: credentialFile,
      AUTODEV_CONTROL_API_BASE_URL: "http://127.0.0.1:4101",
      AUTODEV_PLAYTEST_ANALYST_HOME: join(f.root, "analyst-home"),
      AUTODEV_PLAYTEST_ANALYST_CODEX_HOME: join(
        f.root,
        "analyst-home",
        ".codex"
      ),
      AUTODEV_PLAYTEST_WORKSPACE_ID: "owner/RacingGame",
      AUTODEV_PLAYTEST_ROLE: "playtest-analyst",
      AUTODEV_PLAYTEST_ACTOR_ID: "analyst-1",
      AUTODEV_PLAYTEST_TASK_ID: "analysis-task-1",
      AUTODEV_PLAYTEST_RUN_ID: "analysis-run-1",
      AUTODEV_PLAYTEST_CONTROL_API_TOKEN: "analyst-scoped-secret",
      AUTODEV_PLAYTEST_CONTROL_API_ACTOR: "playtest-runtime",
      AUTODEV_PLAYTEST_CONTROL_API_ROLE: "playtest-analyst"
    };
    const childCalls: { args: string[]; environment: NodeJS.ProcessEnv }[] = [];
    assert.equal(
      await runProviderAgent(
        [
          "--role",
          "playtest-analyst",
          "--cwd",
          join(f.root, "workspace"),
          "--prompt",
          "review only selected packets"
        ],
        environment,
        {
          ensureRouter: async () => undefined,
          runCodex: (_binary, args, env) => {
            childCalls.push({ args, environment: env });
            return 0;
          }
        }
      ),
      0
    );
    assert.equal(childCalls.length, 1);
    const childCall = childCalls[0];
    assert.ok(childCall);
    const childEnvironment = childCall.environment;
    const childArgs = childCall.args;
    assert.equal(
      childEnvironment?.AUTODEV_PLAYTEST_CONTROL_API_TOKEN,
      undefined
    );
    assert.equal(
      childEnvironment?.AUTODEV_PLAYTEST_CONTROL_API_ROLE,
      undefined
    );
    assert.equal(
      childEnvironment?.AUTODEV_PLAYTEST_CONTROL_API_ACTOR,
      undefined
    );
    assert.equal(childEnvironment?.AUTODEV_CONTROL_API_BASE_URL, undefined);
    assert.equal(
      childEnvironment?.AUTODEV_PLAYTEST_ANALYST_CONTROL_API_TOKEN,
      undefined
    );
    assert.equal(childEnvironment?.AUTODEV_CONTROL_API_TOKEN, undefined);
    assert.equal(childEnvironment?.AUTODEV_MEMORY_DATABASE_URL, undefined);
    assert.equal(childEnvironment?.AUTODEV_MEMORY_READ_GLOBAL, undefined);
    assert.equal(childEnvironment?.OPENLIT_DB_PASSWORD, undefined);
    assert.equal(
      readFileSync(
        join(f.root, "analyst-home", ".codex", "openlit-secrets.env"),
        "utf8"
      ),
      "OPENLIT_DB_PASSWORD=database-secret\n"
    );
    assert.ok(childArgs.includes("mcp_servers.autodev_memory.enabled=false"));
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("playtest analysis restricts Codex to packet tools and an isolated execution context", async () => {
  const f = fixture();
  try {
    const analystRole = join(
      f.root,
      ".codex",
      "agents",
      "playtest-analyst.toml"
    );
    const baseConfig = join(f.root, ".codex", "config.toml");
    const environmentFile = join(f.root, ".codex", ".env");
    const isolatedHome = join(f.root, "analyst-home");
    const isolatedCodexHome = join(isolatedHome, ".codex");
    writeFileSync(
      join(f.root, ".codex", "agents", "worker.toml"),
      'name = "worker"\ndeveloper_instructions = "unrelated private role"\n'
    );
    writeFileSync(
      analystRole,
      [
        'name = "playtest-analyst"',
        'sandbox_mode = "read-only"',
        "[features]",
        "shell_tool = false",
        "multi_agent = false",
        "[tools]",
        "web_search = false",
        "[mcp_servers.lsp]",
        "enabled = false",
        "[mcp_servers.playtest]",
        "enabled = true",
        'enabled_tools = ["playtest.prepareReview", "playtest.submitReview", "playtest.submitCrossSessionSynthesis"]',
        'env_vars = ["AUTODEV_PLAYTEST_ROLE", "AUTODEV_PLAYTEST_WORKSPACE_ID", "AUTODEV_PLAYTEST_ACTOR_ID", "AUTODEV_PLAYTEST_TASK_ID", "AUTODEV_PLAYTEST_RUN_ID", "AUTODEV_PLAYTEST_ANALYSIS_ID", "AUTODEV_PLAYTEST_SELECTED_EPISODE_IDS", "AUTODEV_PLAYTEST_ANALYSIS_METRIC_AGGREGATION", "AUTODEV_PLAYTEST_REPOSITORY_ROOT", "AUTODEV_REPO_ROOT"]',
        "[mcp_servers.codex_app]",
        "enabled = false",
        '[plugins."codex-app-tools@openai-bundled"]',
        "enabled = false",
        "[skills]",
        "include_instructions = false",
        "[skills.bundled]",
        "enabled = false",
        "[[skills.config]]",
        'name = "playtest-analysis"',
        "enabled = true",
        "[[skills.config]]",
        'name = "orchestration"',
        "enabled = false"
      ].join("\n") + "\n"
    );
    writeFileSync(
      baseConfig,
      [
        "[mcp_servers.lsp]",
        "enabled = true",
        "[mcp_servers.playtest]",
        "enabled = false",
        "[mcp_servers.codex_app]",
        "enabled = true",
        "[mcp_servers.unexpected]",
        "enabled = true",
        '[plugins."codex-app-tools@openai-bundled"]',
        "enabled = true",
        '[plugins."unexpected-plugin@marketplace"]',
        "enabled = true"
      ].join("\n") + "\n"
    );
    writeFileSync(
      environmentFile,
      [
        "AUTODEV_CONTROL_API_TOKEN=file-control-secret",
        "AUTODEV_PLAYTEST_CONTROL_API_TOKEN=file-runner-secret",
        "AUTODEV_OPENLIT_USAGE_TOKEN=file-usage-secret",
        "OPENAI_API_KEY=file-provider-secret"
      ].join("\n") + "\n"
    );
    const captured: { args: string[]; env: NodeJS.ProcessEnv }[] = [];
    const env: NodeJS.ProcessEnv = {
      ...f.env,
      CODEX_ENV_FILE: environmentFile,
      AUTODEV_CONTROL_API_BASE_URL: "http://127.0.0.1:4101",
      AUTODEV_CONTROL_API_TOKEN: "runtime-control-secret",
      AUTODEV_OPENLIT_USAGE_TOKEN: "runtime-usage-secret",
      OPENAI_API_KEY: "runtime-provider-secret",
      CODEX_ROUTER_AUTH_TOKEN: "local-router-token",
      AUTODEV_PLAYTEST_ANALYSIS_MODE: "1",
      AUTODEV_PLAYTEST_ANALYST_HOME: isolatedHome,
      AUTODEV_PLAYTEST_ANALYST_CODEX_HOME: isolatedCodexHome,
      AUTODEV_PLAYTEST_WORKSPACE_ID: "owner/game",
      AUTODEV_PLAYTEST_ROLE: "playtest-analyst",
      AUTODEV_PLAYTEST_ACTOR_ID: "control-api:actor",
      AUTODEV_PLAYTEST_TASK_ID: "analysis-task",
      AUTODEV_PLAYTEST_RUN_ID: "analysis-run",
      AUTODEV_PLAYTEST_ANALYSIS_ID: "analysis-123",
      AUTODEV_PLAYTEST_SELECTED_EPISODE_IDS: JSON.stringify([
        "episode-1",
        "episode-2"
      ]),
      AUTODEV_PLAYTEST_ANALYSIS_METRIC_AGGREGATION: '{"status":"fixture"}',
      AUTODEV_PLAYTEST_REPOSITORY_ROOT: repositoryRoot,
      AUTODEV_PLAYTEST_CONTROL_API_TOKEN: "analyst-scoped-token",
      AUTODEV_PLAYTEST_CONTROL_API_ACTOR: "playtest-runtime",
      AUTODEV_PLAYTEST_CONTROL_API_ROLE: "playtest-analyst"
    };
    const result = await runProviderAgent(
      [
        "--role",
        "playtest-analyst",
        "--cwd",
        join(f.root, "workspace"),
        "--prompt",
        "Review only the supplied packets."
      ],
      env,
      {
        ensureRouter: async () => undefined,
        runCodex: (_binary, args, childEnv) => {
          captured.push({ args, env: childEnv });
          return 0;
        }
      }
    );

    assert.equal(result, 0);
    assert.equal(captured.length, 1);
    const call = captured[0];
    assert.ok(call);
    assert.ok(call.args.includes("features.shell_tool=false"));
    assert.ok(call.args.includes("features.multi_agent=false"));
    assert.ok(call.args.includes('web_search="disabled"'));
    assert.equal(
      call.args.some((argument) => argument.startsWith("tools.view_image=")),
      false,
      "do not pass unsupported view_image configuration to Codex"
    );
    assert.ok(call.args.includes('shell_environment_policy.inherit="none"'));
    assert.ok(call.args.includes("mcp_servers.lsp.enabled=false"));
    assert.ok(call.args.includes("mcp_servers.codex_app.enabled=false"));
    assert.ok(call.args.includes("mcp_servers.unexpected.enabled=false"));
    assert.ok(
      call.args.includes(
        'plugins."codex-app-tools@openai-bundled".enabled=false'
      )
    );
    assert.ok(
      call.args.includes(
        'plugins."unexpected-plugin@marketplace".enabled=false'
      )
    );
    assert.ok(call.args.includes("skills.include_instructions=false"));
    assert.ok(call.args.includes("skills.bundled.enabled=false"));
    assert.ok(
      call.args.includes(
        'skills.config=[{"name":"playtest-analysis","enabled":true},{"name":"orchestration","enabled":false}]'
      )
    );
    assert.deepEqual(
      readdirSync(join(isolatedCodexHome, "agents")),
      ["playtest-analyst.toml"],
      "the isolated profile contains no unrelated private role instructions"
    );
    assert.ok(call.args.includes("mcp_servers.playtest.enabled=true"));
    assert.ok(
      call.args.includes(
        'mcp_servers.playtest.enabled_tools=["playtest.prepareReview","playtest.submitReview","playtest.submitCrossSessionSynthesis"]'
      )
    );
    assert.ok(
      call.args.some(
        (argument) =>
          argument.startsWith("mcp_servers.playtest.env_vars=") &&
          argument.includes("AUTODEV_PLAYTEST_SELECTED_EPISODE_IDS") &&
          argument.includes("AUTODEV_PLAYTEST_ANALYSIS_METRIC_AGGREGATION")
      ),
      "the analyst MCP must receive the Runtime-bound selection allowlist"
    );
    assert.equal(call.env.AUTODEV_CONTROL_API_TOKEN, undefined);
    assert.equal(call.env.AUTODEV_OPENLIT_USAGE_TOKEN, undefined);
    assert.equal(call.env.OPENAI_API_KEY, undefined);
    assert.equal(call.env.AUTODEV_PLAYTEST_CONTROL_API_TOKEN, undefined);
    assert.equal(call.env.AUTODEV_PLAYTEST_CONTROL_API_ACTOR, undefined);
    assert.equal(call.env.AUTODEV_PLAYTEST_CONTROL_API_ROLE, undefined);
    assert.equal(call.env.AUTODEV_CONTROL_API_BASE_URL, undefined);
    assert.equal(call.env.CODEX_ROUTER_AUTH_TOKEN, "local-router-token");
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("analyst provider run enforces its role tool, skill, MCP, and environment policy", async () => {
  const f = fixture();
  try {
    const roleFile = join(f.root, ".codex", "agents", "playtest-analyst.toml");
    writeFileSync(
      roleFile,
      [
        'name = "playtest-analyst"',
        'sandbox_mode = "read-only"',
        "[features]",
        "shell_tool = false",
        "multi_agent = false",
        "[tools]",
        "web_search = false",
        "[mcp_servers.lsp]",
        "enabled = false",
        "[mcp_servers.playtest]",
        "enabled = true",
        'enabled_tools = ["playtest.prepareReview", "playtest.submitReview", "playtest.submitCrossSessionSynthesis"]',
        'env_vars = ["AUTODEV_PLAYTEST_ROLE", "AUTODEV_PLAYTEST_WORKSPACE_ID", "AUTODEV_PLAYTEST_ACTOR_ID", "AUTODEV_PLAYTEST_TASK_ID", "AUTODEV_PLAYTEST_RUN_ID", "AUTODEV_PLAYTEST_ANALYSIS_ID", "AUTODEV_PLAYTEST_SELECTED_EPISODE_IDS", "AUTODEV_PLAYTEST_ANALYSIS_METRIC_AGGREGATION", "AUTODEV_PLAYTEST_REPOSITORY_ROOT", "AUTODEV_REPO_ROOT"]',
        "[mcp_servers.codex_app]",
        "enabled = false",
        "[skills]",
        "include_instructions = false",
        "[skills.bundled]",
        "enabled = false",
        "[[skills.config]]",
        'name = "playtest-analysis"',
        "enabled = true"
      ].join("\n") + "\n"
    );
    writeFileSync(
      join(f.root, ".codex", "config.toml"),
      [
        "[mcp_servers.lsp]",
        "enabled = true",
        "[mcp_servers.playtest]",
        "enabled = false",
        "[mcp_servers.codex_app]",
        "enabled = true",
        "[mcp_servers.unexpected]",
        "enabled = true"
      ].join("\n") + "\n"
    );
    writeFileSync(
      join(f.root, ".codex", ".env"),
      [
        "AUTODEV_PLAYTEST_CONTROL_API_TOKEN=file-runner-secret",
        "AUTODEV_OPENLIT_USAGE_TOKEN=file-usage-secret",
        "GITHUB_TOKEN=file-github-secret"
      ].join("\n") + "\n"
    );
    const calls: Array<{ args: string[]; environment: NodeJS.ProcessEnv }> = [];
    const childEnvironment: NodeJS.ProcessEnv = {
      ...f.env,
      AUTODEV_PLAYTEST_ANALYSIS_MODE: "1",
      AUTODEV_PLAYTEST_ANALYST_HOME: join(f.root, "analyst-home"),
      AUTODEV_PLAYTEST_ANALYST_CODEX_HOME: join(
        f.root,
        "analyst-home",
        ".codex"
      ),
      AUTODEV_CONTROL_API_TOKEN: "runtime-control-secret",
      AUTODEV_PLAYTEST_CONTROL_API_TOKEN: "analyst-scoped-secret",
      AUTODEV_PLAYTEST_ANALYST_CONTROL_API_TOKEN: "duplicate-analyst-secret",
      AUTODEV_PLAYTEST_CONTROL_API_ACTOR: "playtest-runtime",
      AUTODEV_PLAYTEST_CONTROL_API_ROLE: "playtest-analyst",
      AUTODEV_PLAYTEST_ROLE: "playtest-analyst",
      AUTODEV_PLAYTEST_WORKSPACE_ID: "owner/game",
      AUTODEV_PLAYTEST_ACTOR_ID: "control-api:actor",
      AUTODEV_PLAYTEST_TASK_ID: "analysis-task",
      AUTODEV_PLAYTEST_RUN_ID: "analysis-run",
      AUTODEV_PLAYTEST_ANALYSIS_ID: "analysis-123",
      AUTODEV_PLAYTEST_SELECTED_EPISODE_IDS: JSON.stringify([
        "episode-1",
        "episode-2"
      ]),
      AUTODEV_PLAYTEST_ANALYSIS_METRIC_AGGREGATION: '{"status":"fixture"}',
      AUTODEV_PLAYTEST_REPOSITORY_ROOT: repositoryRoot,
      AUTODEV_CONTROL_API_BASE_URL: "http://127.0.0.1:4101",
      AUTODEV_OPENLIT_USAGE_TOKEN: "runtime-usage-secret",
      AUTODEV_GITHUB_TOKEN: "runtime-github-secret",
      OPENAI_API_KEY: "runtime-provider-secret",
      CODEX_ROUTER_AUTH_TOKEN: "runtime-router-secret"
    };

    await runProviderAgent(
      [
        "--role",
        "playtest-analyst",
        "--cwd",
        join(f.root, "workspace"),
        "--prompt",
        "Review only the explicitly selected packets."
      ],
      childEnvironment,
      {
        ensureRouter: async () => undefined,
        runCodex: (_binary, args, environment) => {
          calls.push({ args, environment });
          return 0;
        }
      }
    );

    assert.equal(calls.length, 1);
    const call = calls[0];
    assert.ok(call);
    assert.ok(call.args.includes("features.shell_tool=false"));
    assert.ok(call.args.includes("features.multi_agent=false"));
    assert.ok(call.args.includes('web_search="disabled"'));
    assert.equal(
      call.args.some((argument) => argument.startsWith("tools.view_image=")),
      false,
      "do not pass unsupported view_image configuration to Codex"
    );
    assert.ok(call.args.includes('shell_environment_policy.inherit="none"'));
    assert.ok(call.args.includes("mcp_servers.lsp.enabled=false"));
    assert.ok(call.args.includes("mcp_servers.codex_app.enabled=false"));
    assert.ok(call.args.includes("mcp_servers.unexpected.enabled=false"));
    assert.ok(call.args.includes("mcp_servers.playtest.enabled=true"));
    assert.ok(
      call.args.includes(
        'mcp_servers.playtest.enabled_tools=["playtest.prepareReview","playtest.submitReview","playtest.submitCrossSessionSynthesis"]'
      )
    );
    assert.equal(
      call.environment.AUTODEV_PLAYTEST_SELECTED_EPISODE_IDS,
      JSON.stringify(["episode-1", "episode-2"])
    );
    assert.equal(
      call.environment.AUTODEV_PLAYTEST_ANALYSIS_METRIC_AGGREGATION,
      '{"status":"fixture"}'
    );
    assert.equal(call.environment.AUTODEV_CONTROL_API_TOKEN, undefined);
    assert.equal(call.environment.AUTODEV_OPENLIT_USAGE_TOKEN, undefined);
    assert.equal(call.environment.AUTODEV_GITHUB_TOKEN, undefined);
    assert.equal(call.environment.OPENAI_API_KEY, undefined);
    assert.equal(
      call.environment.AUTODEV_PLAYTEST_CONTROL_API_TOKEN,
      undefined
    );
    assert.equal(
      call.environment.AUTODEV_PLAYTEST_ANALYST_CONTROL_API_TOKEN,
      undefined
    );
    assert.equal(
      call.environment.CODEX_ROUTER_AUTH_TOKEN,
      "runtime-router-secret"
    );
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("provider-agent forwards Runtime termination to Codex and waits for its exit", () => {
  const modulePath = fileURLToPath(
    new URL("../../runtime/src/cli/provider-agent.ts", import.meta.url)
  );
  const moduleUrl = pathToFileURL(modulePath).href;
  const script = [
    `import { runCodex } from ${JSON.stringify(moduleUrl)};`,
    "const result = runCodex(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], process.env, false);",
    "setTimeout(() => process.kill(process.pid, 'SIGTERM'), 50);",
    "process.stdout.write(String(await result));"
  ].join("\n");
  const output = execFileSync(
    process.execPath,
    ["--input-type=module", "-e", script],
    { encoding: "utf8", timeout: 10_000 }
  );
  assert.equal(output, "143");
});

test("provider agent rejects obsolete provider selection and invalid roles", () => {
  const f = fixture();
  try {
    assert.throws(
      () => parseProviderAgentArgs(["--provider", "claude"], f.env),
      /obsolete/
    );
    assert.throws(
      () => parseProviderAgentArgs(["--role", "unknown"], f.env),
      /Unsupported role/
    );
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("provider-agent help is a successful typed CLI path", () => {
  const module = fileURLToPath(
    new URL("../../runtime/src/cli/provider-agent.ts", import.meta.url)
  );
  const output = execFileSync(process.execPath, [module, "--help"], {
    encoding: "utf8"
  });
  assert.match(output, /Usage: run-provider-agent\.sh/);
});
