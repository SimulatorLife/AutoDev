import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { parse } from "smol-toml";

import { normalizedSource } from "./source-text.ts";

type JsonObject = Record<string, unknown>;
const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const read = (relativePath: string): string => {
  const text = readFileSync(join(repositoryRoot, relativePath), "utf8");
  return relativePath.endsWith(".ts") ? normalizedSource(text) : text;
};
const readJson = (relativePath: string): JsonObject =>
  JSON.parse(read(relativePath)) as JsonObject;
const asObject = (value: unknown): JsonObject => {
  assert.ok(value && typeof value === "object" && !Array.isArray(value));
  return value as JsonObject;
};

const portableConfig = parse(
  read("config/config.autodev.toml")
) as unknown as JsonObject;
const rulesyncMcp = readJson(".rulesync/mcp.jsonc");

test("Codex portable permission surface is explicit", () => {
  assert.equal(portableConfig.approval_policy, "never");
  assert.equal(portableConfig.sandbox_mode, "workspace-write");
  assert.equal(portableConfig.approvals_reviewer, "user");
  assert.equal(
    asObject(portableConfig.sandbox_workspace_write).network_access,
    true
  );
  assert.equal(asObject(portableConfig.tools).web_search, true);
  assert.equal(asObject(portableConfig.features).hooks, true);
  assert.equal(
    Object.hasOwn(asObject(portableConfig.features), "permissions"),
    false
  );
  for (const provider of Object.values(
    asObject(portableConfig.model_providers)
  )) {
    assert.equal(asObject(provider).wire_api, "responses");
  }
  assert.equal(Object.hasOwn(portableConfig, "mcp_servers"), false);
  for (const server of Object.values(
    asObject(asObject(rulesyncMcp).codexcli).mcpServers as JsonObject
  )) {
    const settings = asObject(server);
    if (Object.hasOwn(settings, "command"))
      assert.equal(settings.default_tools_approval_mode, "approve");
  }
});

test("Claude bridge acts only through Codex tools", () => {
  // Codex, not the CLI, enforces each role's sandbox, MCP allowlist, and
  // approvals, because every action a Claude turn takes is a Codex tool call.
  // The CLI keeps no built-in tool except web research, and only when Codex
  // offered its hosted web search, which no tool script can perform.
  const source = read("src/providers/claude.ts");
  for (const marker of [
    'const CLAUDE_WEB_TOOLS = ["WebSearch", "WebFetch"]',
    "const builtIns = options.webSearch ? CLAUDE_WEB_TOOLS : []",
    '"--tools", builtIns.join(",")',
    '"--strict-mcp-config"',
    "`mcp__${CODEX_TOOLS_SERVER}`",
    '"--permission-mode"',
    'CLAUDE_CODE_PERMISSION_MODE ?? "bypassPermissions"'
  ])
    assert.ok(source.includes(marker), marker);
  for (const obsolete of [
    "--disallowed-tools",
    "--add-dir",
    "bridgeMcpServers",
    "Bash(ccc"
  ]) {
    assert.ok(
      !source.includes(obsolete),
      `the Claude bridge no longer grants or filters CLI-native tools: ${obsolete}`
    );
  }
});

test("Antigravity permissions are dynamic and machine-local", () => {
  const source = read("src/platform/antigravity-settings.ts");
  const materializer = read("src/platform/install-materializer.ts");
  assert.ok(materializer.includes("updateAntigravityPermissions"));
  for (const marker of [
    "updateAntigravityPermissions",
    "missingAntigravityPermissions",
    "const permissions = asObject(config.permissions)",
    "function permissionList(config: JsonObject)",
    "normalizedReadRoots",
    "read_file(${root})",
    "read_file(${root}/**)",
    'join(home, ".agents")',
    'join(home, ".codex")',
    "mcp(cocoindex-code)",
    "mcp(lsp)",
    "read_url(*)",
    "unsandboxed(pwd)",
    "unsandboxed(pnpm test)",
    "unsandboxed(python3 -m unittest discover -s tests -p 'test_*.py')",
    "mcp(playwright)",
    "DENIED_COMMAND_PERMISSIONS",
    "permissions.deny = deny"
  ])
    assert.ok(source.includes(marker), marker);
  assert.ok(source.includes('openSync(temporary, "wx"'));
  assert.ok(source.includes("renameSync(temporary, path)"));
});

test("Rulesync permissions and subagent generation remain deferred", () => {
  assert.equal(read("rulesync.jsonc").includes('"permissions"'), false);
  const rulesyncConfig = readJson("rulesync.jsonc");
  const features = rulesyncConfig.features as unknown[];
  assert.equal(features.includes("permissions"), false);
  assert.equal(features.includes("subagents"), false);
  assert.equal(
    existsSync(join(repositoryRoot, ".rulesync", "subagents")),
    false
  );

  const contract = readJson("config/execution-contract.json");
  const providers = asObject(contract.providers);
  assert.deepEqual(
    Object.fromEntries(
      ["codex", "claude", "antigravity", "copilot", "minimax"].map((name) => [
        name,
        asObject(providers[name]).delegation
      ])
    ),
    {
      codex: "native",
      claude: "native",
      antigravity: "codex-shim",
      copilot: "codex-shim",
      minimax: "none"
    }
  );
  const mcpTargets = asObject(rulesyncMcp);
  assert.ok(
    Object.hasOwn(
      asObject(asObject(mcpTargets["antigravity-cli"]).mcpServers),
      "autodev_spawn"
    )
  );
  for (const target of ["codexcli", "copilotcli"])
    assert.equal(
      Object.hasOwn(
        asObject(asObject(mcpTargets[target]).mcpServers),
        "autodev_spawn"
      ),
      false
    );
});

test("the permission inventory reads sources without changing them", () => {
  const paths = [
    "config/config.autodev.toml",
    "src/providers/claude.ts",
    "scripts/install.sh",
    "rulesync.jsonc",
    ".rulesync/mcp.jsonc"
  ];
  const before = paths.map(read);
  for (const content of before) assert.ok(content.length > 0);
  assert.deepEqual(paths.map(read), before);
});
