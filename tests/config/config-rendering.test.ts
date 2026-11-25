import assert from "node:assert/strict";
import { mkdirSync, readdirSync, readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  compose,
  loadPortable,
  renderBridgeMcpCatalogue,
  serializeToml,
  type TomlTable,
  validateProviderContracts
} from "@simulatorlife/autodev-runtime/config";
import { userLevelSkills } from "@simulatorlife/autodev-runtime/platform/user-level-skills";
import { listBundledPlugins } from "@simulatorlife/autodev-runtime/shared/bundled-plugins";
import { parse } from "smol-toml";

test("TOML serialization is parseable and ends with one newline", () => {
  const input: TomlTable = { z: "last", a: true, nested: { value: 2 } };
  const output = serializeToml(input);
  assert.equal(output.endsWith("\n"), true);
  assert.equal(output.endsWith("\n\n"), false);
  // smol-toml returns null-prototype objects; structuredClone restores normal prototypes.
  const parsed = structuredClone(parse(output));
  assert.deepEqual(parsed, input);
});

test("composition preserves local state while AutoDev-owned keys win", () => {
  const result = compose(
    {
      owner: "autodev",
      hooks: { generated: true },
      mcp_servers: { lsp: { command: "lsp" } },
      plugins: { "codex-app-tools@openai-bundled": { enabled: false } }
    },
    {
      owner: "local",
      hooks: { state: { disabled: true }, stale: true },
      notify: "desktop",
      mcp_servers: { custom: { command: "custom" } },
      plugins: {
        "codex-app-tools@openai-bundled": { enabled: true },
        "github@openai-curated": { enabled: true }
      }
    }
  );
  assert.equal(result.owner, "autodev");
  assert.deepEqual(result.hooks, { state: { disabled: true } });
  assert.deepEqual(result.mcp_servers, {
    lsp: { command: "lsp" },
    custom: { command: "custom" }
  });
  assert.deepEqual(result.plugins, {
    "codex-app-tools@openai-bundled": { enabled: false },
    "github@openai-curated": { enabled: true }
  });
  assert.equal(result.notify, "desktop");
});

test("composition disables every bundled OpenAI plugin the portable source does not enable", () => {
  // The bundled marketplace ships native Codex surfaces (browser control,
  // computer use, the CUA REPL) that AutoDev does not expose to agents. The
  // portable source names the bundled plugins it allows; every other bundled
  // plugin is off even when the local config turns it on, so a plugin OpenAI
  // ships later cannot re-expose its tools.
  const result = compose(
    {
      plugins: {
        "codex-app-tools@openai-bundled": { enabled: true },
        "browser@openai-bundled": { enabled: false }
      }
    },
    {
      plugins: {
        "codex-app-tools@openai-bundled": { enabled: false },
        "unified-computer-use@openai-bundled": {
          enabled: true,
          mcp_servers: { cua_repl: { enabled: true } }
        },
        "github@openai-curated": { enabled: true }
      }
    }
  );
  assert.deepEqual(result.plugins, {
    "codex-app-tools@openai-bundled": { enabled: true },
    "browser@openai-bundled": { enabled: false },
    "unified-computer-use@openai-bundled": {
      enabled: false,
      mcp_servers: { cua_repl: { enabled: true } }
    },
    "github@openai-curated": { enabled: true }
  });
});

test("composition names every installed bundled plugin the portable source does not allow", () => {
  // Codex enables an installed plugin unless the config names it as disabled,
  // so a bundled plugin it installs after the last install is live for every
  // agent until a compose names it.
  const result = compose(
    {
      plugins: { "codex-app-tools@openai-bundled": { enabled: true } }
    },
    { plugins: {} },
    {
      bundledPlugins: ["browser", "codex-app-tools", "unified-computer-use"]
    }
  );
  assert.deepEqual(result.plugins, {
    "codex-app-tools@openai-bundled": { enabled: true },
    "browser@openai-bundled": { enabled: false },
    "unified-computer-use@openai-bundled": { enabled: false }
  });
});

test("the bundled lockdown holds even when the portable source declares no plugins", () => {
  const result = compose(
    {},
    { plugins: { "browser@openai-bundled": { enabled: true } } },
    { bundledPlugins: ["unified-computer-use"] }
  );
  assert.deepEqual(result.plugins, {
    "browser@openai-bundled": { enabled: false },
    "unified-computer-use@openai-bundled": { enabled: false }
  });
});

test("the composed config disables a bundled plugin Codex has installed", async () => {
  const codexHome = await mkdtemp(join(tmpdir(), "autodev-bundled-compose-"));
  try {
    mkdirSync(
      join(codexHome, "plugins", "cache", "openai-bundled", "browser", "1.0"),
      { recursive: true }
    );
    const result = compose(
      { plugins: { "codex-app-tools@openai-bundled": { enabled: true } } },
      {},
      { bundledPlugins: listBundledPlugins(codexHome) }
    );
    assert.deepEqual(result.plugins, {
      "codex-app-tools@openai-bundled": { enabled: true },
      "browser@openai-bundled": { enabled: false }
    });
  } finally {
    await rm(codexHome, { recursive: true, force: true });
  }
});

test("composition drops legacy permission and sandbox keys outside the portable source", () => {
  const result = compose(
    {
      default_permissions: ":danger-full-access",
      approval_policy: "never",
      approvals_reviewer: "user"
    },
    {
      sandbox_mode: "workspace-write",
      sandbox_workspace_write: { network_access: true },
      default_permissions: "rulesync",
      permissions: {
        rulesync: {
          extends: ":workspace",
          filesystem: { ":minimal": "read" }
        }
      },
      notify: "desktop"
    }
  );
  assert.equal(result.default_permissions, ":danger-full-access");
  assert.equal(result.approval_policy, "never");
  assert.equal(Object.hasOwn(result, "permissions"), false);
  assert.equal(Object.hasOwn(result, "sandbox_mode"), false);
  assert.equal(Object.hasOwn(result, "sandbox_workspace_write"), false);
  assert.equal(result.notify, "desktop");
});

test("the root config takes the orchestrator role's per-server MCP settings", async () => {
  const directory = await mkdtemp(join(tmpdir(), "autodev-root-role-"));
  try {
    const portable = join(directory, "portable.toml");
    const mcp = join(directory, "mcp.toml");
    const role = join(directory, "orchestrator.toml");
    await writeFile(portable, 'owner = "autodev"\n');
    await writeFile(
      mcp,
      [
        "[mcp_servers.lsp]",
        'command = "bash"',
        'args = ["-lc", "lsp"]',
        "[mcp_servers.codegraphcontext]",
        'command = "bash"',
        'args = ["-lc", "cgc"]',
        'default_tools_approval_mode = "prompt"',
        "[mcp_servers.playwright]",
        'command = "bash"',
        'args = ["-lc", "pw"]',
        ""
      ].join("\n")
    );
    await writeFile(
      role,
      [
        "[mcp_servers.lsp]",
        "enabled = true",
        "[mcp_servers.codegraphcontext]",
        "enabled = true",
        'default_tools_approval_mode = "approve"',
        'enabled_tools = ["list_indexed_repositories", "find_code"]',
        'command = "role-must-not-own-launch-keys"',
        "[mcp_servers.playwright]",
        "enabled = false",
        "[mcp_servers.codex_app]",
        "enabled = true",
        'enabled_tools = ["request_user_input"]',
        ""
      ].join("\n")
    );
    const result = compose(loadPortable(portable, mcp, role), {
      mcp_servers: {
        codegraphcontext: { command: "stale" },
        custom: { command: "custom" }
      }
    });
    assert.deepEqual(result.mcp_servers, {
      lsp: { command: "bash", args: ["-lc", "lsp"], enabled: true },
      codegraphcontext: {
        command: "bash",
        args: ["-lc", "cgc"],
        default_tools_approval_mode: "approve",
        enabled: true,
        enabled_tools: ["list_indexed_repositories", "find_code"]
      },
      playwright: { command: "bash", args: ["-lc", "pw"], enabled: false },
      custom: { command: "custom" }
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("no role TOML declares a spawn MCP server; every provider spawns through Codex exec", () => {
  const roleDir = join(import.meta.dirname, "../../agents/roles");
  for (const roleName of readdirSync(roleDir).filter((name) =>
    name.endsWith(".toml")
  )) {
    const role = parse(readFileSync(join(roleDir, roleName), "utf8")) as {
      mcp_servers?: Record<string, unknown>;
    };
    assert.equal(
      role.mcp_servers?.autodev_spawn,
      undefined,
      `${roleName} must not declare a separate spawn MCP server`
    );
  }
});

test("the portable Codex configuration exports its telemetry to OpenLIT without storing secrets", () => {
  // The router no longer receives OTLP: the agents export straight to the
  // authenticated first-party receiver, so the portable configuration is
  // where that decision is made.
  const portablePath = join(
    import.meta.dirname,
    "../../config/config.autodev.toml"
  );
  const source = readFileSync(portablePath, "utf8");
  const otel = (parse(source) as TomlTable).otel as TomlTable;
  assert.equal(
    ((otel.exporter as TomlTable)["otlp-http"] as TomlTable).endpoint,
    "http://127.0.0.1:4318/v1/logs"
  );
  assert.equal(
    ((otel.trace_exporter as TomlTable)["otlp-http"] as TomlTable).endpoint,
    "http://127.0.0.1:4318/v1/traces"
  );
  assert.equal(
    ((otel.metrics_exporter as TomlTable)["otlp-http"] as TomlTable).endpoint,
    "http://127.0.0.1:4318/v1/metrics"
  );
  // The receiver is authenticated with a bearer token, and the token lives in
  // the out-of-repository secret file -- never in the configuration. The
  // provider `env_key` names are not secrets: they name variables the agent
  // reads from its own environment.
  assert.doesNotMatch(source, /Bearer|OTLP_API_KEY/u);
});

test("bridge MCP catalogues are deterministic and preserve launch authentication", async () => {
  const directory = await mkdtemp(join(tmpdir(), "autodev-mcp-"));
  const savedKey = process.env.GOOGLE_DEVELOPER_KNOWLEDGE_API_KEY;
  process.env.GOOGLE_DEVELOPER_KNOWLEDGE_API_KEY = "do-not-leak-credential";
  try {
    const source = join(directory, "mcp.toml");
    await writeFile(
      source,
      '[mcp_servers.zed]\ncommand = "z"\n\n[mcp_servers.alpha]\ncommand = "a"\nargs = ["--stdio"]\ncwd = "/plugin"\n\n[mcp_servers.context7]\nurl = "https://example.invalid/mcp"\nbearer_token_env_var = "CONTEXT7_API_KEY"\nhttp_headers = { "X-Test" = "placeholder" }\n\n[mcp_servers.googleDeveloperKnowledge]\nurl = "https://developerknowledge.googleapis.com/mcp"\nenv_http_headers = { "X-Goog-Api-Key" = "GOOGLE_DEVELOPER_KNOWLEDGE_API_KEY" }\n'
    );
    const rendered = renderBridgeMcpCatalogue(source);
    assert.equal(
      rendered,
      '{\n  "alpha": {\n    "command": "a",\n    "args": [\n      "--stdio"\n    ],\n    "cwd": "/plugin"\n  },\n  "context7": {\n    "url": "https://example.invalid/mcp",\n    "bearer_token_env_var": "CONTEXT7_API_KEY",\n    "http_headers": {\n      "X-Test": "placeholder"\n    }\n  },\n  "googleDeveloperKnowledge": {\n    "url": "https://developerknowledge.googleapis.com/mcp",\n    "http_headers": {\n      "X-Goog-Api-Key": "${GOOGLE_DEVELOPER_KNOWLEDGE_API_KEY}"\n    }\n  },\n  "zed": {\n    "command": "z"\n  }\n}\n'
    );
    assert.equal(rendered.includes("do-not-leak-credential"), false);
  } finally {
    if (savedKey === undefined)
      delete process.env.GOOGLE_DEVELOPER_KNOWLEDGE_API_KEY;
    else process.env.GOOGLE_DEVELOPER_KNOWLEDGE_API_KEY = savedKey;
    await rm(directory, { recursive: true, force: true });
  }
});

test("execution-contract provider delegation is explicit and rejects legacy fields", () => {
  assert.deepEqual(
    validateProviderContracts({
      codex: {
        delegation: "xacpx",
        permissionMode: "native",
        mcpIngress: "local"
      },
      claude: {
        delegation: "xacpx",
        permissionMode: "native",
        mcpIngress: "local"
      },
      "opencli-chatgpt": {
        delegation: "xacpx",
        permissionMode: "upstream",
        mcpIngress: "gateway"
      }
    }),
    {
      codex: {
        delegation: "xacpx",
        permissionMode: "native",
        mcpIngress: "local"
      },
      claude: {
        delegation: "xacpx",
        permissionMode: "native",
        mcpIngress: "local"
      },
      "opencli-chatgpt": {
        delegation: "xacpx",
        permissionMode: "upstream",
        mcpIngress: "gateway"
      }
    }
  );
  assert.throws(
    () =>
      validateProviderContracts({
        "opencli-chatgpt": {
          delegation: "xacpx",
          permissionMode: "upstream",
          mcpIngress: "none"
        }
      }),
    /cannot declare delegation 'xacpx' with mcpIngress 'none'/u
  );
  assert.throws(
    () => validateProviderContracts({ unknown: {} }),
    /must declare delegation/
  );
  assert.throws(
    () =>
      validateProviderContracts({
        codex: { delegation: "codex" }
      }),
    /must declare delegation/
  );
  assert.throws(
    () =>
      validateProviderContracts({
        minimax: {
          delegation: "xacpx",
          mcpIngress: "local",
          spawnTools: ["invoke_subagent"]
        }
      }),
    /must not declare legacy spawnTools/
  );
  assert.throws(
    () =>
      validateProviderContracts({
        antigravity: {
          delegation: "xacpx",
          mcpIngress: "local",
          roleMcpInjection: true
        }
      }),
    /must not declare legacy roleMcpInjection/
  );
});

test("orchestrator MCP contract is provider-agnostic and omits Codex-only plugin MCPs", () => {
  const contract = JSON.parse(
    readFileSync("config/execution-contract.json", "utf8")
  ) as {
    roles: Record<
      string,
      {
        mcp?: string[];
        mcpTools?: Record<string, string[]>;
        allowProviderHop?: boolean;
      }
    >;
  };
  const orchestrator = contract.roles.orchestrator;
  assert.ok(orchestrator, "orchestrator role must be declared");
  assert.deepEqual(
    orchestrator.mcp,
    ["filesystem", "lsp", "cocoindex-code", "codegraphcontext", "xacpx"],
    "orchestrator MCPs must be provider-agnostic and include xacpx in deterministic order"
  );
  assert.equal("allowProviderHop" in orchestrator, false);
  assert.deepEqual(orchestrator.mcpTools, {
    codegraphcontext: [
      "list_indexed_repositories",
      "find_code",
      "analyze_code_relationships",
      "get_repository_stats"
    ]
  });

  for (const [roleName, roleCfg] of Object.entries(contract.roles)) {
    assert.ok(
      !(roleCfg.mcp ?? []).includes("codex_app"),
      `${roleName} must not list Codex-only codex_app in canonical mcp`
    );
    assert.ok(
      !(roleCfg.mcpTools ?? {}).codex_app,
      `${roleName} must not list codex_app in canonical mcpTools`
    );
  }
});

test("context7 is enabled on docs-researcher and explorer only", () => {
  // Freeze the per-role context7 boundary. docs-researcher and explorer are
  // the only roles the orchestrator enables Context7 on; every other role
  // (including the root orchestrator itself and browser-tester) must not
  // list context7 in its mcp set. This test reads the live contract so a
  // render failure surfaces here before it reaches install --check.
  const contract = JSON.parse(
    readFileSync("config/execution-contract.json", "utf8")
  ) as { roles: Record<string, { mcp?: string[] }> };

  const enabledRoles = ["docs-researcher", "explorer"];
  for (const roleName of enabledRoles) {
    const roleCfg = contract.roles[roleName];
    assert.ok(roleCfg, `${roleName} role must be declared`);
    assert.ok(
      (roleCfg.mcp ?? []).includes("context7"),
      `${roleName} must enable context7`
    );
  }

  const disabledRoles = [
    "browser-tester",
    "default",
    "orchestrator",
    "smart",
    "validator",
    "worker"
  ];
  for (const roleName of disabledRoles) {
    const roleCfg = contract.roles[roleName];
    assert.ok(roleCfg, `${roleName} role must be declared`);
    assert.ok(
      !(roleCfg.mcp ?? []).includes("context7"),
      `${roleName} must not enable context7`
    );
  }

  // Per-role MCP ordering must respect MCP_ORDER (filesystem=0, lsp=1,
  // cocoindex-code=2, codegraphcontext=3, playwright=4, openaiDeveloperDocs=5,
  // context7=6, googleDeveloperKnowledge=7, codex_app=8): within each role's
  // mcp list, known servers appear in ascending MCP_ORDER index; unknown keys
  // sort lexicographically after them. This protects against accidental
  // reorderings.
  const ORDER: Record<string, number> = {
    filesystem: 0,
    lsp: 1,
    "cocoindex-code": 2,
    codegraphcontext: 3,
    playwright: 4,
    openaiDeveloperDocs: 5,
    context7: 6,
    googleDeveloperKnowledge: 7,
    codex_app: 8,
    github: 9,
    xacpx: 10
  };
  for (const [roleName, roleCfg] of Object.entries(contract.roles)) {
    const mcp = roleCfg.mcp ?? [];
    let last = -1;
    for (const name of mcp) {
      const index = ORDER[name] ?? 99;
      assert.ok(
        index >= last,
        `${roleName} mcp ordering violated: ${name} (${index}) after ${last}`
      );
      last = index;
    }
  }
});

test("googleDeveloperKnowledge is enabled on the documentation roles only", () => {
  // Freeze the per-role googleDeveloperKnowledge boundary. docs-researcher and
  // smart are the only roles that enable Google Developer Knowledge; every
  // other role (including the root orchestrator, browser-tester, explorer,
  // implementation roles, and playtest roles) must not list it in its mcp set.
  // This test reads the live contract so a render failure surfaces here before
  // it reaches install --check.
  const contract = JSON.parse(
    readFileSync("config/execution-contract.json", "utf8")
  ) as { roles: Record<string, { mcp?: string[] }> };

  const enabledRoles = new Set(["docs-researcher", "smart"]);
  for (const roleName of enabledRoles) {
    const roleCfg = contract.roles[roleName];
    assert.ok(roleCfg, `${roleName} role must be declared`);
    assert.ok(
      (roleCfg.mcp ?? []).includes("googleDeveloperKnowledge"),
      `${roleName} must enable googleDeveloperKnowledge`
    );
  }

  for (const [roleName, roleCfg] of Object.entries(contract.roles)) {
    if (enabledRoles.has(roleName)) continue;
    assert.ok(
      !(roleCfg.mcp ?? []).includes("googleDeveloperKnowledge"),
      `${roleName} must not enable googleDeveloperKnowledge`
    );
  }
});

test("codegraphcontext is enabled on code-capable roles with scoped four-tool allowlist and disabled on non-code roles", () => {
  const contract = JSON.parse(
    readFileSync("config/execution-contract.json", "utf8")
  ) as {
    roles: Record<
      string,
      { mcp?: string[]; mcpTools?: Record<string, string[]> }
    >;
  };
  const expectedTools = [
    "list_indexed_repositories",
    "find_code",
    "analyze_code_relationships",
    "get_repository_stats"
  ];
  const codeRoles = [
    "default",
    "explorer",
    "smart",
    "validator",
    "worker",
    "orchestrator"
  ];
  for (const roleName of codeRoles) {
    const roleCfg = contract.roles[roleName];
    assert.ok(roleCfg, `${roleName} role must be declared`);
    assert.ok(
      (roleCfg.mcp ?? []).includes("codegraphcontext"),
      `${roleName} must enable codegraphcontext`
    );
    assert.deepEqual(
      roleCfg.mcpTools?.codegraphcontext,
      expectedTools,
      `${roleName} must have exactly the scoped four tools for codegraphcontext`
    );
  }

  const nonCodeRoles = ["docs-researcher", "browser-tester"];
  for (const roleName of nonCodeRoles) {
    const roleCfg = contract.roles[roleName];
    assert.ok(roleCfg, `${roleName} role must be declared`);
    assert.ok(
      !(roleCfg.mcp ?? []).includes("codegraphcontext"),
      `${roleName} must not enable codegraphcontext`
    );
    assert.ok(
      !(roleCfg.mcpTools ?? {}).codegraphcontext,
      `${roleName} must not list codegraphcontext in mcpTools`
    );
  }
});

test("lsp is scoped to precision tools on normal implementation roles and unrestricted on specialist roles", () => {
  const contract = JSON.parse(
    readFileSync("config/execution-contract.json", "utf8")
  ) as {
    roles: Record<
      string,
      { mcp?: string[]; mcpTools?: Record<string, string[]> }
    >;
  };
  const expectedTools = [
    "lsp_find_symbol",
    "lsp_smart_search",
    "lsp_goto_definition",
    "lsp_goto_type_definition",
    "lsp_find_references",
    "lsp_find_implementations",
    "lsp_type_hierarchy",
    "lsp_hover",
    "lsp_signature_help",
    "lsp_document_symbols",
    "lsp_diagnostics",
    "lsp_index_files",
    "lsp_workspace_diagnostics",
    "lsp_rename",
    "lsp_code_actions",
    "lsp_format_document"
  ];
  // CCC owns discovery and CGC owns call/import relationships; normal
  // implementation roles must not see the LSP tools that compete with them.
  const demotedTools = [
    "lsp_workspace_symbols",
    "lsp_call_hierarchy",
    "lsp_file_imports",
    "lsp_related_files"
  ];
  for (const roleName of ["default", "worker"]) {
    const roleCfg = contract.roles[roleName];
    assert.ok(roleCfg, `${roleName} role must be declared`);
    assert.ok(
      (roleCfg.mcp ?? []).includes("lsp"),
      `${roleName} must enable lsp`
    );
    assert.deepEqual(
      roleCfg.mcpTools?.lsp,
      expectedTools,
      `${roleName} must have exactly the scoped lsp precision tools`
    );
    for (const tool of demotedTools)
      assert.ok(
        !roleCfg.mcpTools?.lsp?.includes(tool),
        `${roleName} must not expose ${tool}`
      );
  }

  // Discovery, validation, and deep-debug roles keep the full LSP surface as
  // the escape hatch for questions the preferred owners cannot answer.
  for (const roleName of ["explorer", "validator", "smart", "orchestrator"]) {
    const roleCfg = contract.roles[roleName];
    assert.ok(roleCfg, `${roleName} role must be declared`);
    assert.ok(
      (roleCfg.mcp ?? []).includes("lsp"),
      `${roleName} must enable lsp`
    );
    assert.ok(
      !(roleCfg.mcpTools ?? {}).lsp,
      `${roleName} must keep the unrestricted lsp surface`
    );
  }
});

test("Playtester and Browser Tester project role tool/env/shell boundaries without legacy provider exclusions", () => {
  const contract = JSON.parse(
    readFileSync("config/execution-contract.json", "utf8")
  ) as {
    roles: Record<
      string,
      {
        shell?: boolean;
        hooks?: boolean;
        roleScopedMcp?: string[];
        mcpEnvVars?: Record<string, string[]>;
        mcpTools?: Record<string, string[]>;
      }
    >;
    providers: Record<
      string,
      {
        delegation?: string;
        mcpIngress?: string;
        roleMcpInjection?: boolean;
        spawnTools?: string[];
      }
    >;
  };
  assert.equal(
    contract.roles["browser-tester"]?.mcpTools?.playwright?.includes(
      "browser_evaluate"
    ),
    true
  );
  assert.equal(
    contract.roles.smart?.mcpTools?.playwright?.includes("browser_evaluate"),
    true
  );
  assert.equal(contract.roles["browser-tester"]?.shell, false);
  assert.equal(contract.roles["browser-tester"]?.hooks, false);
  assert.equal(contract.roles.playtester?.shell, false);
  assert.equal(contract.roles.playtester?.hooks, false);
  assert.equal(
    "roleScopedMcp" in (contract.roles["browser-tester"] ?? {}),
    false
  );
  assert.equal("roleScopedMcp" in (contract.roles.playtester ?? {}), false);
  assert.deepEqual(contract.roles["browser-tester"]?.mcpEnvVars?.playwright, [
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
  ]);
  assert.equal(
    contract.roles.playtester?.mcpEnvVars?.playtest?.includes(
      "AUTODEV_PLAYTEST_CONTROL_API_TOKEN"
    ),
    false,
    "the MCP reads the runner token from the protected secret file"
  );
  for (const [providerName, provider] of Object.entries(contract.providers)) {
    assert.equal(
      "roleMcpInjection" in provider,
      false,
      `${providerName} must not carry legacy roleMcpInjection`
    );
    assert.equal(
      "spawnTools" in provider,
      false,
      `${providerName} must not carry legacy spawnTools`
    );
  }
  for (const provider of [
    "claude",
    "codex",
    "copilot",
    "mcode",
    "minimax",
    "opencli-chatgpt",
    "antigravity-gemini",
    "antigravity-argon",
    "antigravity-claude-gpt"
  ]) {
    assert.equal(contract.providers[provider]?.delegation, "xacpx");
  }
  assert.equal(contract.providers["opencli-gemini"]?.delegation, "none");
  assert.equal(contract.providers["opencli-gemini"]?.mcpIngress, "site-native");
});

test("every AutoDev user-level skill is explicitly gated on root config and every role", () => {
  const userSkills = userLevelSkills(
    join(import.meta.dirname, "../../.rulesync/skills")
  );
  const checkSurface = (tomlPath: string) => {
    const parsed = parse(readFileSync(tomlPath, "utf8")) as {
      skills?: { config?: Array<{ name?: unknown; enabled?: unknown }> };
    };
    const entries = parsed.skills?.config ?? [];
    const seen = new Map<string, boolean>();
    for (const entry of entries) {
      assert.equal(typeof entry.name, "string", `${tomlPath}: skill name`);
      assert.equal(
        typeof entry.enabled,
        "boolean",
        `${tomlPath}: skill enabled flag for ${String(entry.name)}`
      );
      const name = entry.name as string;
      assert.equal(
        seen.has(name),
        false,
        `${tomlPath}: duplicate [[skills.config]] entry for ${name}`
      );
      seen.set(name, entry.enabled as boolean);
    }
    for (const skill of userSkills) {
      assert.equal(
        seen.has(skill),
        true,
        `${tomlPath}: missing explicit enabled/disabled gate for user-level skill ${skill}`
      );
    }
  };

  checkSurface(join(import.meta.dirname, "../../config/config.autodev.toml"));
  const rolesDir = join(import.meta.dirname, "../../agents/roles");
  for (const file of readdirSync(rolesDir).filter((name) =>
    name.endsWith(".toml")
  )) {
    checkSurface(join(rolesDir, file));
  }
});
