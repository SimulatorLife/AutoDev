import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
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
import { parse as parseToml } from "smol-toml";

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));

const BROWSER_TESTER_TOOL_ALLOWLIST = [
  "browser_navigate",
  "browser_tabs",
  "browser_snapshot",
  "browser_take_screenshot",
  "browser_click",
  "browser_type",
  "browser_fill_form",
  "browser_press_key",
  "browser_wait_for",
  "browser_console_messages",
  "browser_network_requests",
  "browser_find",
  "browser_hover",
  "browser_select_option",
  "browser_drag",
  "browser_handle_dialog",
  "browser_resize",
  "browser_close"
] as const;
const BROWSER_TESTER_MCP_ENV_ALLOWLIST = [
  "PATH",
  "HOME",
  "TMPDIR",
  "TMP",
  "TEMP",
  "LANG",
  "LC_ALL",
  "CODEX_HOME",
  "AUTODEV_REPO_ROOT",
  "AUTODEV_NODE_BIN",
  "PLAYWRIGHT_BROWSERS_PATH"
] as const;

function browserTesterRoleToml(): string {
  return (
    [
      'name = "browser-tester"',
      'developer_instructions = "Test only the authorized rendered UI."',
      'sandbox_mode = "read-only"',
      "[features]",
      "shell_tool = false",
      "multi_agent = false",
      "multi_agent_v2 = false",
      "hooks = false",
      "memories = false",
      "[tools]",
      "web_search = false",
      "[shell_environment_policy]",
      'inherit = "none"',
      "[mcp_servers.playwright]",
      "enabled = true",
      'default_tools_approval_mode = "approve"',
      `enabled_tools = ${JSON.stringify(BROWSER_TESTER_TOOL_ALLOWLIST)}`,
      `env_vars = ${JSON.stringify(BROWSER_TESTER_MCP_ENV_ALLOWLIST)}`,
      '[plugins."codex-app-tools@openai-bundled"]',
      "enabled = false"
    ].join("\n") + "\n"
  );
}

const PLAYTESTER_TOOL_ALLOWLIST = [
  "playtest.capabilities",
  "playtest.run",
  "playtest.lookupRequest",
  "playtest.wait",
  "playtest.activeRuns",
  "playtest.cancel",
  "playtest.listEpisodes",
  "playtest.readEpisode",
  "playtest.readWindow"
] as const;
const PLAYTESTER_MCP_ENV_ALLOWLIST = [
  "PATH",
  "HOME",
  "TMPDIR",
  "TMP",
  "TEMP",
  "LANG",
  "LC_ALL",
  "AUTODEV_NODE_BIN",
  "AUTODEV_PLAYTEST_WORKSPACE_ID",
  "AUTODEV_PLAYTEST_ROLE",
  "AUTODEV_PLAYTEST_ACTOR_ID",
  "AUTODEV_PLAYTEST_TASK_ID",
  "AUTODEV_PLAYTEST_RUN_ID",
  "AUTODEV_PLAYTEST_REPOSITORY_ROOT",
  "AUTODEV_REPO_ROOT",
  "CODEX_HOME",
  "AUTODEV_OPENLIT_SECRET_FILE",
  "CLICKHOUSE_URL",
  "OPENLIT_DB_USER",
  "OPENLIT_DB_NAME",
  "AUTODEV_CONTROL_API_BASE_URL",
  "AUTODEV_CONTROL_API_LISTEN_HOST",
  "AUTODEV_CONTROL_API_LISTEN_PORT",
  "AUTODEV_PLAYTEST_CONTROL_API_ACTOR",
  "AUTODEV_PLAYTEST_CONTROL_API_ROLE"
] as const;

function playtesterRoleToml(
  options: {
    readonly tools?: readonly string[];
    readonly envVars?: readonly string[];
  } = {}
): string {
  return (
    [
      'name = "playtester"',
      'developer_instructions = "Play only within the approved bounds."',
      'sandbox_mode = "read-only"',
      "[features]",
      "shell_tool = false",
      "multi_agent = false",
      "multi_agent_v2 = false",
      "hooks = false",
      "memories = false",
      "[tools]",
      "web_search = false",
      "[shell_environment_policy]",
      'inherit = "none"',
      "[mcp_servers.playtest]",
      "enabled = true",
      'default_tools_approval_mode = "approve"',
      `enabled_tools = ${JSON.stringify(options.tools ?? PLAYTESTER_TOOL_ALLOWLIST)}`,
      `env_vars = ${JSON.stringify(options.envVars ?? PLAYTESTER_MCP_ENV_ALLOWLIST)}`,
      '[plugins."codex-app-tools@openai-bundled"]',
      "enabled = false",
      "[skills]",
      "include_instructions = false",
      "[skills.bundled]",
      "enabled = false",
      "[[skills.config]]",
      'name = "game-playtesting"',
      "enabled = true"
    ].join("\n") + "\n"
  );
}

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
      // The launcher publishes the router credential into the maintainer's
      // shell, and the environment wins over the credential file. A host that
      // carries one would answer these assertions with its own token instead
      // of the fixture's, so the fixture starts without it.
      CODEX_ROUTER_AUTH_TOKEN: undefined,
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

function playtesterEnvironment(
  f: ReturnType<typeof fixture>
): NodeJS.ProcessEnv {
  const secretFile = join(f.root, "openlit-secrets.env");
  writeFileSync(
    secretFile,
    "AUTODEV_PLAYTEST_CONTROL_API_TOKEN=runner-scoped-token\n",
    {
      mode: 0o600
    }
  );
  return {
    ...f.env,
    AUTODEV_OPENLIT_SECRET_FILE: secretFile,
    AUTODEV_CONTROL_API_BASE_URL: "http://127.0.0.1:4101",
    AUTODEV_CONTROL_API_TOKEN: "general-console-secret",
    CLICKHOUSE_URL: "http://127.0.0.1:8123",
    OPENLIT_DB_USER: "fixture-user",
    OPENLIT_DB_NAME: "fixture-db",
    OPENAI_API_KEY: "runtime-provider-secret",
    CODEX_ROUTER_AUTH_TOKEN: "local-router-token",
    AUTODEV_PLAYTEST_WORKSPACE_ID: "owner/game",
    AUTODEV_PLAYTEST_ROLE: "playtester",
    AUTODEV_PLAYTEST_ACTOR_ID: "control-api:actor",
    AUTODEV_PLAYTEST_TASK_ID: "playtest-task",
    AUTODEV_PLAYTEST_RUN_ID: "playtest-run",
    AUTODEV_PLAYTEST_REPOSITORY_ROOT: repositoryRoot,
    AUTODEV_PLAYTEST_CONTROL_API_ACTOR: "playtest-runtime",
    AUTODEV_PLAYTEST_CONTROL_API_ROLE: "playtester"
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
        "AUTODEV_PLAYTEST_CONTROL_API_ROLE=playtester\n" +
        "CODEX_ROUTER_AUTH_TOKEN=router-from-file\n"
    );
    const env = {
      ...f.env,
      CODEX_ENV_FILE: credentialFile,
      AUTODEV_PLAYTEST_CONTROL_API_TOKEN: "analyst-env-secret",
      AUTODEV_PLAYTEST_CONTROL_API_ROLE: "playtest-analyst"
    };
    const routerEnvironments: NodeJS.ProcessEnv[] = [];
    const deps: ProviderAgentDeps = {
      ensureRouter: async (environment) => {
        routerEnvironments.push(environment);
      },
      runCodex: (binary, args, runtimeEnvironment, checkOnly) => {
        calls.push({ binary, args, env: runtimeEnvironment, checkOnly });
        return 0;
      }
    };
    const prompt = buildProviderPrompt(
      "do the task",
      readRoleExecutionSettings(f.roleFile)
    );
    assert.match(
      prompt,
      /Provider-neutral role instructions:\nUse the typed path\.\n/u
    );
    assert.match(prompt, /AutoDev Code Mode/u);
    assert.match(prompt, /`exec` JavaScript tool/u);
    assert.match(prompt, /tools\.mcp__<server>__<tool>/u);
    assert.match(prompt, /Dotted names.*not necessarily callable syntax/u);
    assert.match(
      prompt,
      /Provider-managed bridge roles.*native MCP interface/u
    );
    assert.match(
      prompt,
      /Never infer tool absence from the parent session's tool list/u
    );
    assert.match(prompt, /Bounded task:\ndo the task$/u);
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
    assert.equal(
      routerEnvironments[0]?.CODEX_ROUTER_AUTH_TOKEN,
      "router-from-file",
      "isolated provider-agent loads its protected router credential before ensuring the Router"
    );
    assert.equal(routerEnvironments[0]?.AUTODEV_CONTROL_API_TOKEN, undefined);
    assert.equal(
      routerEnvironments[0]?.AUTODEV_PLAYTEST_CONTROL_API_TOKEN,
      undefined
    );
    assert.equal(
      routerEnvironments[0]?.AUTODEV_PLAYTEST_ANALYST_CONTROL_API_TOKEN,
      undefined
    );
    assert.equal(calls[0]?.binary, f.codex);
    assert.equal(calls[0]?.checkOnly, false);
    assert.equal(calls[0]?.env.AUTODEV_CONTROL_API_TOKEN, undefined);
    assert.equal(
      calls[0]?.env.AUTODEV_PLAYTEST_ANALYST_CONTROL_API_TOKEN,
      undefined
    );
    assert.equal(
      calls[0]?.env.AUTODEV_PLAYTEST_CONTROL_API_TOKEN,
      undefined,
      "ordinary roles must not inherit the Playtest runner secret"
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
    assert.equal(calls[0]?.env.GIT_AUTHOR_NAME, "AutoDev Agent (smart)");
    assert.equal(
      calls[0]?.env.GIT_AUTHOR_EMAIL,
      "autodev-smart-codex@agents.autodev.local"
    );
    assert.equal(calls[0]?.env.GIT_COMMITTER_NAME, "AutoDev Agent (smart)");
    assert.equal(
      calls[0]?.env.GIT_COMMITTER_EMAIL,
      "autodev-smart-codex@agents.autodev.local"
    );
    assert.equal(calls[0]?.args.at(-1), prompt);
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
        args.every(
          (argument) => !argument.startsWith("mcp_servers.autodev_memory.")
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

test("playtest analyst materializes a trusted symlinked Codex model catalog", async () => {
  const f = fixture();
  try {
    const sourceCodexHome = join(f.root, ".codex");
    const sourceRole = join(sourceCodexHome, "agents", "playtest-analyst.toml");
    const sourceCatalog = join(
      repositoryRoot,
      "config",
      "catalogs",
      "codex-model-catalog.json"
    );
    writeFileSync(
      sourceRole,
      [
        'name = "playtest-analyst"',
        'sandbox_mode = "read-only"',
        "[mcp_servers.playtest]",
        "enabled = true",
        'enabled_tools = ["playtest.prepareReview", "playtest.submitReview"]',
        'env_vars = ["AUTODEV_PLAYTEST_ROLE", "AUTODEV_PLAYTEST_ANALYSIS_ID"]'
      ].join("\n") + "\n"
    );
    writeFileSync(join(sourceCodexHome, "config.toml"), "[model]\n");
    symlinkSync(
      sourceCatalog,
      join(sourceCodexHome, "codex-model-catalog.json")
    );
    const isolatedHome = join(f.root, "analyst-home");
    const isolatedCodexHome = join(isolatedHome, ".codex");
    const environment: NodeJS.ProcessEnv = {
      ...f.env,
      AUTODEV_REPO_ROOT: repositoryRoot,
      AUTODEV_PLAYTEST_ANALYSIS_MODE: "1",
      AUTODEV_PLAYTEST_ANALYST_HOME: isolatedHome,
      AUTODEV_PLAYTEST_ANALYST_CODEX_HOME: isolatedCodexHome,
      AUTODEV_PLAYTEST_ANALYST_SOURCE_HOME: f.root,
      AUTODEV_PLAYTEST_ANALYST_SOURCE_CODEX_HOME: sourceCodexHome
    };
    const args = [
      "--role",
      "playtest-analyst",
      "--cwd",
      join(f.root, "workspace"),
      "--prompt",
      "inspect a bounded packet"
    ];
    const dependencies: ProviderAgentDeps = {
      ensureRouter: async () => undefined,
      runCodex: (_binary, _args, childEnvironment) => {
        const materialized = join(
          childEnvironment.CODEX_HOME!,
          "codex-model-catalog.json"
        );
        assert.equal(lstatSync(materialized).isFile(), true);
        assert.equal(lstatSync(materialized).isSymbolicLink(), false);
        assert.deepEqual(
          readFileSync(materialized),
          readFileSync(sourceCatalog)
        );
        return 0;
      }
    };
    const result = await runProviderAgent(args, environment, dependencies);
    assert.equal(result, 0);

    const sourceCatalogLink = join(sourceCodexHome, "codex-model-catalog.json");
    rmSync(sourceCatalogLink);
    const untrustedCatalog = join(f.root, "untrusted-model-catalog.json");
    writeFileSync(untrustedCatalog, "{}");
    symlinkSync(untrustedCatalog, sourceCatalogLink);
    await assert.rejects(
      () => runProviderAgent(args, environment, dependencies),
      /escapes trusted directories/u
    );
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("the analyst trusts AutoDev's configuration root when the Runtime runs from its materialized tree", async () => {
  const f = fixture();
  try {
    const sourceCodexHome = join(f.root, ".codex");
    const sourceRole = join(sourceCodexHome, "agents", "playtest-analyst.toml");
    const sourceCatalog = join(
      repositoryRoot,
      "config",
      "catalogs",
      "codex-model-catalog.json"
    );
    writeFileSync(
      sourceRole,
      [
        'name = "playtest-analyst"',
        'sandbox_mode = "read-only"',
        "[mcp_servers.playtest]",
        "enabled = true",
        'enabled_tools = ["playtest.prepareReview", "playtest.submitReview"]',
        'env_vars = ["AUTODEV_PLAYTEST_ROLE", "AUTODEV_PLAYTEST_ANALYSIS_ID"]'
      ].join("\n") + "\n"
    );
    writeFileSync(join(sourceCodexHome, "config.toml"), "[model]\n");
    symlinkSync(
      sourceCatalog,
      join(sourceCodexHome, "codex-model-catalog.json")
    );
    const isolatedHome = join(f.root, "analyst-home");
    const isolatedCodexHome = join(isolatedHome, ".codex");
    const materializedRoot = join(f.root, "materialized-runtime");
    mkdirSync(materializedRoot, { recursive: true });
    const environment: NodeJS.ProcessEnv = {
      ...f.env,
      // The materialized Runtime tree the analyst child actually runs from,
      // and the checkout that owns AutoDev's managed configuration.
      AUTODEV_REPO_ROOT: materializedRoot,
      AUTODEV_CONFIGURATION_ROOT: repositoryRoot,
      AUTODEV_PLAYTEST_ANALYSIS_MODE: "1",
      AUTODEV_PLAYTEST_ANALYST_HOME: isolatedHome,
      AUTODEV_PLAYTEST_ANALYST_CODEX_HOME: isolatedCodexHome,
      AUTODEV_PLAYTEST_ANALYST_SOURCE_HOME: f.root,
      AUTODEV_PLAYTEST_ANALYST_SOURCE_CODEX_HOME: sourceCodexHome
    };
    const dependencies: ProviderAgentDeps = {
      ensureRouter: async () => undefined,
      runCodex: (_binary, _args, childEnvironment) => {
        const materialized = join(
          childEnvironment.CODEX_HOME!,
          "codex-model-catalog.json"
        );
        assert.equal(lstatSync(materialized).isFile(), true);
        assert.equal(lstatSync(materialized).isSymbolicLink(), false);
        return 0;
      }
    };
    const result = await runProviderAgent(
      [
        "--role",
        "playtest-analyst",
        "--cwd",
        join(f.root, "workspace"),
        "--prompt",
        "inspect a bounded packet"
      ],
      environment,
      dependencies
    );
    assert.equal(result, 0);
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
        'env_vars = ["AUTODEV_PLAYTEST_ROLE", "AUTODEV_PLAYTEST_WORKSPACE_ID", "AUTODEV_PLAYTEST_ACTOR_ID", "AUTODEV_PLAYTEST_TASK_ID", "AUTODEV_PLAYTEST_RUN_ID", "AUTODEV_PLAYTEST_ANALYSIS_ID", "AUTODEV_PLAYTEST_SELECTED_EPISODE_IDS", "AUTODEV_PLAYTEST_ANALYSIS_KIND", "AUTODEV_PLAYTEST_ANALYSIS_METRIC_AGGREGATION", "AUTODEV_PLAYTEST_REPOSITORY_ROOT", "AUTODEV_REPO_ROOT", "CODEX_HOME"]'
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
      existsSync(join(f.root, "analyst-home", ".codex", "openlit-secrets.env")),
      false,
      "the isolated Codex home never receives the OpenLIT database secret"
    );
    const mcpEnvVars = childArgs.find((argument) =>
      argument.startsWith("mcp_servers.playtest.env_vars=")
    );
    assert.ok(mcpEnvVars);
    const parsedEnvVars = parseToml(mcpEnvVars) as {
      mcp_servers: { playtest: { env_vars: string[] } };
    };
    assert.equal(
      parsedEnvVars.mcp_servers.playtest.env_vars.includes("CODEX_HOME"),
      false,
      "the isolated CODEX_HOME must not pass through to the Playtesting MCP"
    );
    const mcpEnv = childArgs.find((argument) =>
      argument.startsWith("mcp_servers.playtest.env=")
    );
    assert.ok(mcpEnv);
    assert.deepEqual(parseToml(mcpEnv), {
      mcp_servers: {
        playtest: { env: { CODEX_HOME: join(f.root, ".codex") } }
      }
    });
    assert.ok(
      childArgs.every(
        (argument) => !argument.startsWith("mcp_servers.autodev_memory.")
      ),
      "a disabled Memory MCP must not leave a transport-less server table"
    );
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
        'env_vars = ["AUTODEV_PLAYTEST_ROLE", "AUTODEV_PLAYTEST_WORKSPACE_ID", "AUTODEV_PLAYTEST_ACTOR_ID", "AUTODEV_PLAYTEST_TASK_ID", "AUTODEV_PLAYTEST_RUN_ID", "AUTODEV_PLAYTEST_ANALYSIS_ID", "AUTODEV_PLAYTEST_SELECTED_EPISODE_IDS", "AUTODEV_PLAYTEST_ANALYSIS_KIND", "AUTODEV_PLAYTEST_ANALYSIS_METRIC_AGGREGATION", "AUTODEV_PLAYTEST_REPOSITORY_ROOT", "AUTODEV_REPO_ROOT"]',
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
        'command = "bash"',
        'args = ["-lc", "exec \\"${CODEX_HOME:-$HOME/.codex}/hooks/run-autodev-mcp.sh\\" playtest"]',
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
      CODEX_PROJECT_ROOT: repositoryRoot,
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
      AUTODEV_PLAYTEST_ANALYSIS_KIND: "discovery",
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
    const skillsOverride = call.args.find((arg) =>
      arg.startsWith("skills.config=")
    );
    assert.ok(skillsOverride);
    assert.deepEqual(parseToml(skillsOverride), {
      skills: {
        config: [
          { name: "playtest-analysis", enabled: true },
          { name: "orchestration", enabled: false }
        ]
      }
    });
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
          argument.includes("AUTODEV_PLAYTEST_ANALYSIS_KIND") &&
          argument.includes("AUTODEV_PLAYTEST_ANALYSIS_METRIC_AGGREGATION")
      ),
      "the analyst MCP must receive the Runtime-bound selection allowlist"
    );
    assert.equal(
      call.env.AUTODEV_PLAYTEST_ANALYSIS_KIND,
      "discovery",
      "the analyst process must carry the analysis kind into the Codex child"
    );
    assert.equal(call.env.AUTODEV_CONTROL_API_TOKEN, undefined);
    assert.equal(call.env.AUTODEV_OPENLIT_USAGE_TOKEN, undefined);
    assert.equal(call.env.OPENAI_API_KEY, undefined);
    assert.equal(call.env.AUTODEV_PLAYTEST_CONTROL_API_TOKEN, undefined);
    assert.equal(call.env.AUTODEV_PLAYTEST_CONTROL_API_ACTOR, undefined);
    assert.equal(call.env.AUTODEV_PLAYTEST_CONTROL_API_ROLE, undefined);
    assert.equal(call.env.AUTODEV_CONTROL_API_BASE_URL, undefined);
    assert.equal(call.env.CODEX_ROUTER_AUTH_TOKEN, "local-router-token");
    assert.equal(
      call.env.CODEX_PROJECT_ROOT,
      join(f.root, "workspace"),
      "Code Mode workspace attribution must remain the private empty directory, not the caller's source/game project"
    );
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
        'env_vars = ["AUTODEV_PLAYTEST_ROLE", "AUTODEV_PLAYTEST_WORKSPACE_ID", "AUTODEV_PLAYTEST_ACTOR_ID", "AUTODEV_PLAYTEST_TASK_ID", "AUTODEV_PLAYTEST_RUN_ID", "AUTODEV_PLAYTEST_ANALYSIS_ID", "AUTODEV_PLAYTEST_SELECTED_EPISODE_IDS", "AUTODEV_PLAYTEST_ANALYSIS_KIND", "AUTODEV_PLAYTEST_ANALYSIS_METRIC_AGGREGATION", "AUTODEV_PLAYTEST_REPOSITORY_ROOT", "AUTODEV_REPO_ROOT"]',
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
        'command = "bash"',
        'args = ["-lc", "exec \\"${CODEX_HOME:-$HOME/.codex}/hooks/run-autodev-mcp.sh\\" playtest"]',
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
      AUTODEV_PLAYTEST_ANALYSIS_KIND: "discovery",
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
    // The playtest server must keep the launch keys the Runtime installed for
    // it. That launcher binds the trusted Playtesting session context to the
    // server process; a direct `mcp-main.ts` spawn has no session context, so
    // the server's guard rejects the request and the analyst ends up with no
    // Playtesting tools at all.
    assert.ok(
      call.args.includes('mcp_servers.playtest.command="bash"'),
      "the analyst must keep the installed Playtesting MCP launch command"
    );
    assert.ok(
      call.args.some(
        (argument) =>
          argument.startsWith("mcp_servers.playtest.args=") &&
          argument.includes("run-autodev-mcp.sh")
      ),
      "the analyst must keep the installed Playtesting MCP launch arguments"
    );
    assert.equal(
      call.args.some(
        (argument) =>
          argument.startsWith("mcp_servers.playtest.args=") &&
          argument.includes("mcp-main.ts")
      ),
      false,
      "the analyst must not spawn the Playtesting MCP server outside its launcher"
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

test("argument parsing accepts the bounded playtester role", () => {
  const f = fixture();
  try {
    const playtesterRoleFile = join(
      f.root,
      ".codex",
      "agents",
      "playtester.toml"
    );
    writeFileSync(playtesterRoleFile, playtesterRoleToml());
    const options = parseProviderAgentArgs(
      [
        "--role",
        "playtester",
        "--cwd",
        join(f.root, "workspace"),
        "--prompt",
        "Run the approved session.",
        "--check"
      ],
      f.env
    );
    assert.equal(options.role, "playtester");
    assert.equal(options.roleFile, playtesterRoleFile);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("the installed browser-tester role file matches its exact read-only MCP contract", () => {
  const role = parseToml(
    readFileSync(
      join(repositoryRoot, "agents", "roles", "browser-tester.toml"),
      "utf8"
    )
  ) as unknown as {
    readonly name: string;
    readonly sandbox_mode: string;
    readonly features: Record<string, unknown>;
    readonly tools: Record<string, unknown>;
    readonly shell_environment_policy: Record<string, unknown>;
    readonly mcp_servers: {
      readonly playwright: {
        readonly enabled: boolean;
        readonly enabled_tools: readonly string[];
        readonly env_vars: readonly string[];
      };
    };
  };
  assert.equal(role.name, "browser-tester");
  assert.equal(role.sandbox_mode, "read-only");
  assert.deepEqual(role.features, {
    shell_tool: false,
    multi_agent: false,
    multi_agent_v2: false,
    hooks: false,
    memories: false
  });
  assert.equal(role.tools.web_search, false);
  assert.equal(role.shell_environment_policy.inherit, "none");
  assert.equal(role.mcp_servers.playwright.enabled, true);
  assert.deepEqual(
    role.mcp_servers.playwright.enabled_tools,
    BROWSER_TESTER_TOOL_ALLOWLIST
  );
  assert.deepEqual(
    role.mcp_servers.playwright.env_vars,
    BROWSER_TESTER_MCP_ENV_ALLOWLIST
  );
});

test("browser-tester provider run injects only its bounded Playwright MCP and strips unrelated credentials", async () => {
  const f = fixture();
  try {
    const roleFile = join(f.root, ".codex", "agents", "browser-tester.toml");
    writeFileSync(roleFile, browserTesterRoleToml());
    writeFileSync(
      join(f.root, ".codex", "config.toml"),
      [
        "[mcp_servers.lsp]",
        "enabled = true",
        "[mcp_servers.playwright]",
        "enabled = false",
        "[mcp_servers.playtest]",
        "enabled = false",
        'command = "bash"',
        'args = ["-lc", "exec \\"${CODEX_HOME:-$HOME/.codex}/hooks/run-autodev-mcp.sh\\" playtest"]',
        "[mcp_servers.codex_app]",
        "enabled = true",
        "[mcp_servers.unexpected]",
        "enabled = true"
      ].join("\n") + "\n"
    );
    const credentialFile = join(f.root, "browser-provider.env");
    writeFileSync(
      credentialFile,
      [
        "CODEX_ROUTER_AUTH_TOKEN=router-secret",
        "AUTODEV_CONTROL_API_TOKEN=general-secret",
        "AUTODEV_PLAYTEST_CONTROL_API_TOKEN=runner-secret",
        "OPENAI_API_KEY=provider-secret",
        "AUTODEV_MEMORY_DATABASE_URL=memory-secret"
      ].join("\n") + "\n"
    );
    const calls: Array<{ args: string[]; environment: NodeJS.ProcessEnv }> = [];
    const result = await runProviderAgent(
      [
        "--role",
        "browser-tester",
        "--cwd",
        join(f.root, "workspace"),
        "--prompt",
        "Inspect the authorized rendered UI without changing state."
      ],
      { ...f.env, CODEX_ENV_FILE: credentialFile },
      {
        ensureRouter: async () => undefined,
        runCodex: (_binary, args, environment) => {
          calls.push({ args, environment });
          return 0;
        }
      }
    );

    assert.equal(result, 0);
    assert.equal(calls.length, 1);
    const call = calls[0];
    assert.ok(call);
    for (const disabled of ["lsp", "playtest", "codex_app", "unexpected"])
      assert.ok(call.args.includes(`mcp_servers.${disabled}.enabled=false`));
    assert.ok(call.args.includes("mcp_servers.playwright.enabled=true"));
    assert.ok(call.args.includes("features.shell_tool=false"));
    assert.ok(call.args.includes("features.multi_agent=false"));
    assert.ok(call.args.includes('web_search="disabled"'));
    const toolsArgument = call.args.find((argument) =>
      argument.startsWith("mcp_servers.playwright.enabled_tools=")
    );
    assert.ok(toolsArgument);
    const tools = parseToml(toolsArgument) as {
      mcp_servers: { playwright: { enabled_tools: string[] } };
    };
    assert.deepEqual(
      tools.mcp_servers.playwright.enabled_tools,
      BROWSER_TESTER_TOOL_ALLOWLIST
    );
    const envVarsArgument = call.args.find((argument) =>
      argument.startsWith("mcp_servers.playwright.env_vars=")
    );
    assert.ok(envVarsArgument);
    const envVars = parseToml(envVarsArgument) as {
      mcp_servers: { playwright: { env_vars: string[] } };
    };
    assert.deepEqual(
      envVars.mcp_servers.playwright.env_vars,
      BROWSER_TESTER_MCP_ENV_ALLOWLIST
    );
    assert.ok(
      call.args.some((argument) =>
        argument.startsWith("mcp_servers.playwright.command=")
      )
    );
    assert.ok(
      call.args.some((argument) =>
        argument.startsWith("mcp_servers.playwright.args=")
      )
    );
    assert.equal(call.environment.CODEX_ROUTER_AUTH_TOKEN, "router-secret");
    assert.equal(call.environment.AUTODEV_CONTROL_API_TOKEN, undefined);
    assert.equal(
      call.environment.AUTODEV_PLAYTEST_CONTROL_API_TOKEN,
      undefined
    );
    assert.equal(call.environment.OPENAI_API_KEY, undefined);
    assert.equal(call.environment.AUTODEV_MEMORY_DATABASE_URL, undefined);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("the installed playtester role file matches its exact read-only MCP contract", () => {
  const role = parseToml(
    readFileSync(
      join(repositoryRoot, "agents", "roles", "playtester.toml"),
      "utf8"
    )
  ) as unknown as {
    readonly name: string;
    readonly sandbox_mode: string;
    readonly features: Record<string, unknown>;
    readonly tools: Record<string, unknown>;
    readonly shell_environment_policy: Record<string, unknown>;
    readonly mcp_servers: {
      readonly playtest: {
        readonly enabled: boolean;
        readonly enabled_tools: readonly string[];
        readonly env_vars: readonly string[];
      };
    };
  };
  assert.equal(role.name, "playtester");
  assert.equal(role.sandbox_mode, "read-only");
  assert.deepEqual(role.features, {
    shell_tool: false,
    multi_agent: false,
    multi_agent_v2: false,
    hooks: false,
    memories: false
  });
  assert.equal(role.tools.web_search, false);
  assert.equal(role.shell_environment_policy.inherit, "none");
  assert.equal(role.mcp_servers.playtest.enabled, true);
  assert.deepEqual(
    role.mcp_servers.playtest.enabled_tools,
    PLAYTESTER_TOOL_ALLOWLIST
  );
  assert.deepEqual(
    role.mcp_servers.playtest.env_vars,
    PLAYTESTER_MCP_ENV_ALLOWLIST
  );
  const runnerEnvironment = new Set<string>(role.mcp_servers.playtest.env_vars);
  assert.equal(runnerEnvironment.has("AUTODEV_CONTROL_API_TOKEN"), false);
  assert.equal(runnerEnvironment.has("OPENAI_API_KEY"), false);
});

test("playtester provider run enables only the exact read-only runner Playtesting MCP override and disables unrelated servers", async () => {
  const f = fixture();
  try {
    const playtesterRoleFile = join(
      f.root,
      ".codex",
      "agents",
      "playtester.toml"
    );
    writeFileSync(playtesterRoleFile, playtesterRoleToml());
    writeFileSync(
      join(f.root, ".codex", "config.toml"),
      [
        "[mcp_servers.lsp]",
        "enabled = true",
        "[mcp_servers.playtest]",
        "enabled = false",
        'command = "bash"',
        'args = ["-lc", "exec \\"${CODEX_HOME:-$HOME/.codex}/hooks/run-autodev-mcp.sh\\" playtest"]',
        "[mcp_servers.codex_app]",
        "enabled = true",
        "[mcp_servers.unexpected]",
        "enabled = true"
      ].join("\n") + "\n"
    );
    const calls: Array<{ args: string[]; environment: NodeJS.ProcessEnv }> = [];
    const env = playtesterEnvironment(f);

    const result = await runProviderAgent(
      [
        "--role",
        "playtester",
        "--cwd",
        join(f.root, "workspace"),
        "--prompt",
        "Run only the approved session."
      ],
      env,
      {
        ensureRouter: async () => undefined,
        runCodex: (_binary, args, environment) => {
          calls.push({ args, environment });
          return 0;
        }
      }
    );

    assert.equal(result, 0);
    assert.equal(calls.length, 1);
    const call = calls[0];
    assert.ok(call);
    assert.ok(call.args.includes("features.shell_tool=false"));
    assert.ok(call.args.includes('web_search="disabled"'));
    assert.ok(call.args.includes("mcp_servers.lsp.enabled=false"));
    assert.ok(call.args.includes("mcp_servers.codex_app.enabled=false"));
    assert.ok(call.args.includes("mcp_servers.unexpected.enabled=false"));
    assert.ok(call.args.includes("mcp_servers.playtest.enabled=true"));
    const enabledToolsArgument = call.args.find((argument) =>
      argument.startsWith("mcp_servers.playtest.enabled_tools=")
    );
    assert.ok(enabledToolsArgument);
    const enabledTools = parseToml(enabledToolsArgument) as {
      mcp_servers: { playtest: { enabled_tools: string[] } };
    };
    assert.deepEqual(enabledTools.mcp_servers.playtest.enabled_tools, [
      "playtest.capabilities",
      "playtest.run",
      "playtest.lookupRequest",
      "playtest.wait",
      "playtest.activeRuns",
      "playtest.cancel",
      "playtest.listEpisodes",
      "playtest.readEpisode",
      "playtest.readWindow"
    ]);
    assert.ok(
      [
        "playtest.submitReview",
        "playtest.prepareReview",
        "playtest.submitCrossSessionSynthesis"
      ].every(
        (analystOnlyTool) =>
          !enabledTools.mcp_servers.playtest.enabled_tools.includes(
            analystOnlyTool
          )
      ),
      "the runner must never receive analyst-only review/write tools"
    );
    const envVarsArgument = call.args.find((argument) =>
      argument.startsWith("mcp_servers.playtest.env_vars=")
    );
    assert.ok(envVarsArgument);
    const envVars = parseToml(envVarsArgument) as {
      mcp_servers: { playtest: { env_vars: string[] } };
    };
    assert.deepEqual(envVars.mcp_servers.playtest.env_vars, [
      "PATH",
      "HOME",
      "TMPDIR",
      "TMP",
      "TEMP",
      "LANG",
      "LC_ALL",
      "AUTODEV_NODE_BIN",
      "AUTODEV_PLAYTEST_WORKSPACE_ID",
      "AUTODEV_PLAYTEST_ROLE",
      "AUTODEV_PLAYTEST_ACTOR_ID",
      "AUTODEV_PLAYTEST_TASK_ID",
      "AUTODEV_PLAYTEST_RUN_ID",
      "AUTODEV_PLAYTEST_REPOSITORY_ROOT",
      "AUTODEV_REPO_ROOT",
      "CODEX_HOME",
      "AUTODEV_OPENLIT_SECRET_FILE",
      "CLICKHOUSE_URL",
      "OPENLIT_DB_USER",
      "OPENLIT_DB_NAME",
      "AUTODEV_CONTROL_API_BASE_URL",
      "AUTODEV_CONTROL_API_LISTEN_HOST",
      "AUTODEV_CONTROL_API_LISTEN_PORT",
      "AUTODEV_PLAYTEST_CONTROL_API_ACTOR",
      "AUTODEV_PLAYTEST_CONTROL_API_ROLE"
    ]);
    assert.equal(
      envVars.mcp_servers.playtest.env_vars.includes(
        "AUTODEV_CONTROL_API_TOKEN"
      ),
      false,
      "the runner must never receive the general Control API token"
    );
    assert.equal(
      envVars.mcp_servers.playtest.env_vars.includes("OPENAI_API_KEY"),
      false,
      "the runner must never receive provider API keys"
    );
    assert.equal(call.environment.AUTODEV_CONTROL_API_TOKEN, undefined);
    assert.equal(call.environment.AUTODEV_MEMORY_DATABASE_URL, undefined);
    assert.equal(
      call.args.some((argument) =>
        argument.startsWith("mcp_servers.autodev_memory.")
      ),
      false,
      "the playtester must not receive the source-writing Memory MCP"
    );
    assert.equal(
      call.environment.AUTODEV_PLAYTEST_CONTROL_API_TOKEN,
      undefined,
      "the runner token must remain in the protected CODEX_HOME file"
    );
    assert.equal(
      call.environment.CODEX_ROUTER_AUTH_TOKEN,
      "local-router-token"
    );
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("playtester dispatch fails closed when trusted session credentials are absent", async () => {
  const f = fixture();
  try {
    const playtesterRoleFile = join(
      f.root,
      ".codex",
      "agents",
      "playtester.toml"
    );
    writeFileSync(playtesterRoleFile, playtesterRoleToml());
    writeFileSync(join(f.root, ".codex", "config.toml"), "");
    const calls: unknown[] = [];
    await assert.rejects(
      () =>
        runProviderAgent(
          [
            "--role",
            "playtester",
            "--cwd",
            join(f.root, "workspace"),
            "--prompt",
            "Run only the approved session."
          ],
          f.env,
          {
            ensureRouter: async () => undefined,
            runCodex: (_binary, args, environment) => {
              calls.push({ args, environment });
              return 0;
            }
          }
        ),
      /trusted workspace\/session context/u
    );
    assert.equal(calls.length, 0);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("playtester dispatch fails closed when the materialized role drifts from the exact approved tool allowlist", async () => {
  const f = fixture();
  try {
    const playtesterRoleFile = join(
      f.root,
      ".codex",
      "agents",
      "playtester.toml"
    );
    writeFileSync(
      playtesterRoleFile,
      playtesterRoleToml({
        tools: [...PLAYTESTER_TOOL_ALLOWLIST, "playtest.submitReview"]
      })
    );
    writeFileSync(join(f.root, ".codex", "config.toml"), "");
    const calls: unknown[] = [];
    await assert.rejects(
      () =>
        runProviderAgent(
          [
            "--role",
            "playtester",
            "--cwd",
            join(f.root, "workspace"),
            "--prompt",
            "Run only the approved session."
          ],
          playtesterEnvironment(f),
          {
            ensureRouter: async () => undefined,
            runCodex: (_binary, args, environment) => {
              calls.push({ args, environment });
              return 0;
            }
          }
        ),
      /exact approved runner Playtesting tools/
    );
    assert.equal(calls.length, 0);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("playtester dispatch fails closed when the materialized role is missing the exact trusted environment allowlist", async () => {
  const f = fixture();
  try {
    const playtesterRoleFile = join(
      f.root,
      ".codex",
      "agents",
      "playtester.toml"
    );
    writeFileSync(
      playtesterRoleFile,
      playtesterRoleToml({
        envVars: ["AUTODEV_PLAYTEST_WORKSPACE_ID", "AUTODEV_PLAYTEST_ROLE"]
      })
    );
    writeFileSync(join(f.root, ".codex", "config.toml"), "");
    const calls: unknown[] = [];
    await assert.rejects(
      () =>
        runProviderAgent(
          [
            "--role",
            "playtester",
            "--cwd",
            join(f.root, "workspace"),
            "--prompt",
            "Run only the approved session."
          ],
          playtesterEnvironment(f),
          {
            ensureRouter: async () => undefined,
            runCodex: (_binary, args, environment) => {
              calls.push({ args, environment });
              return 0;
            }
          }
        ),
      /exact trusted Playtesting MCP environment allowlist/
    );
    assert.equal(calls.length, 0);
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
