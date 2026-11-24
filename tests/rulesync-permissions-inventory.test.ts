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
const stripJsoncComments = (text: string): string =>
  text
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("//"))
    .join("\n");
const readJson = (relativePath: string): JsonObject =>
  JSON.parse(
    relativePath.endsWith(".jsonc")
      ? stripJsoncComments(read(relativePath))
      : read(relativePath)
  ) as JsonObject;
const asObject = (value: unknown): JsonObject => {
  assert.ok(value && typeof value === "object" && !Array.isArray(value));
  return value as JsonObject;
};

const portableConfig = parse(
  read("config/config.autodev.toml")
) as unknown as JsonObject;
const rulesyncMcp = readJson(".rulesync/mcp.jsonc");
const rulesyncPermissions = readJson(".rulesync/permissions.jsonc");

test("Codex permissions and rules are owned by .rulesync/permissions.jsonc, not config.autodev.toml or role sandbox_mode", () => {
  const codexcli = asObject(rulesyncPermissions.codexcli);
  const sharedBash = asObject(asObject(rulesyncPermissions.permission).bash);
  assert.equal(codexcli.base_permission_profile, ":danger-full-access");
  assert.ok(
    ["never", "on-request"].includes(String(codexcli.approval_policy)),
    `approval_policy must be supported: ${String(codexcli.approval_policy)}`
  );
  assert.equal(typeof codexcli.approvals_reviewer, "string");
  assert.notEqual(codexcli.approvals_reviewer, "");
  assert.equal(typeof asObject(codexcli.tools).web_search, "boolean");
  assert.equal(sharedBash["sudo *"], "deny");
  assert.equal(sharedBash["git checkout *"], "deny");
  assert.equal(sharedBash["git commit --amend *"], "deny");
  assert.equal(sharedBash["rm -rf .git *"], "deny");

  for (const forbidden of [
    "approval_policy",
    "approvals_reviewer",
    "sandbox_mode",
    "sandbox_workspace_write",
    "tools"
  ]) {
    assert.equal(
      Object.hasOwn(portableConfig, forbidden),
      false,
      `config/config.autodev.toml must not declare ${forbidden}`
    );
  }
  assert.equal(asObject(portableConfig.features).hooks, true);
  assert.equal(
    Object.hasOwn(asObject(portableConfig.features), "permissions"),
    false
  );
  assert.equal(
    existsSync(join(repositoryRoot, "agents/rules/default.rules")),
    false,
    "agents/rules/default.rules must be removed in favor of .rulesync/permissions.jsonc"
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

test("Antigravity static permissions live in .rulesync/permissions.jsonc and dynamic roots stay machine-local", () => {
  const source = read("runtime/src/platform/antigravity-settings.ts");
  const materializer = read("runtime/src/platform/install-materializer.ts");
  const canonical = readJson(".rulesync/permissions.jsonc");
  const sharedPermission = asObject(canonical.permission);
  const agyOverride = asObject(canonical["antigravity-cli"]);
  const agyPermission = asObject(agyOverride.permission);

  assert.equal(agyOverride.agentMode, "accept-edits");
  assert.deepEqual(sharedPermission.webfetch, { "*": "allow" });
  assert.deepEqual(sharedPermission.mcp__filesystem, { "*": "allow" });
  assert.deepEqual(sharedPermission["mcp__cocoindex-code__search"], {
    "*": "allow"
  });
  assert.deepEqual(sharedPermission.mcp__lsp, { "*": "allow" });
  assert.deepEqual(sharedPermission.mcp__openaiDeveloperDocs, { "*": "allow" });
  assert.deepEqual(sharedPermission.mcp__context7, { "*": "allow" });
  assert.deepEqual(sharedPermission.mcp__googleDeveloperKnowledge, {
    "*": "allow"
  });
  assert.deepEqual(sharedPermission.mcp__playwright, { "*": "deny" });
  assert.deepEqual(sharedPermission.mcp__playtest, { "*": "deny" });
  for (const tool of [
    "list_indexed_repositories",
    "find_code",
    "analyze_code_relationships",
    "get_repository_stats"
  ]) {
    assert.deepEqual(sharedPermission[`mcp__codegraphcontext__${tool}`], {
      "*": "allow"
    });
  }
  assert.equal(Object.hasOwn(sharedPermission, "mcp__codegraphcontext"), false);
  assert.equal(
    Object.hasOwn(sharedPermission, "mcp__codegraphcontext__add_code_to_graph"),
    false
  );
  assert.equal(
    Object.hasOwn(sharedPermission, "mcp__codegraphcontext__check_job_status"),
    false
  );
  assert.deepEqual(asObject(sharedPermission.bash)["ccc *"], "deny");
  assert.deepEqual(agyPermission.read, {
    "~/.agents/**": "allow",
    "~/.codex/**": "allow",
    "~/.claude/**": "allow",
    "~/.gemini/**": "allow",
    "~/.minimax/**": "allow",
    "~/.mmx/**": "allow",
    "~/.opencli/**": "allow",
    "~/.copilot/**": "allow"
  });
  assert.deepEqual(agyPermission.unsandboxed, {
    "pwd *": "allow",
    "pnpm test *": "allow",
    "regex:python3 -m unittest discover -s tests -p test_.*\\.py": "allow",
    "ccc *": "deny"
  });

  assert.ok(materializer.includes("updateAntigravityPermissions"));
  for (const marker of [
    "updateAntigravityPermissions",
    "missingAntigravityPermissions",
    "projectedAntigravityBaseline",
    "runRulesyncGenerate",
    "normalizedReadRoots",
    "read_file(${root})",
    "read_file(${root}/**)"
  ])
    assert.ok(source.includes(marker), marker);
  assert.ok(source.includes("atomicWriteSync(filePath"));
  assert.ok(source.includes("mode: 0o600"));
});

test("Codex Rulesync permissions are consolidated while subagent generation remains deferred", () => {
  assert.equal(read("rulesync.jsonc").includes('"permissions"'), false);
  const rulesyncConfig = readJson("rulesync.jsonc");
  const configuredTargets = rulesyncConfig.targets as Record<
    string,
    readonly string[]
  >;
  const features = new Set(Object.values(configuredTargets).flat());
  assert.equal(features.has("permissions"), false);
  assert.equal(
    existsSync(join(repositoryRoot, ".rulesync", "permissions.jsonc")),
    true
  );
  const permissionsDocument = readJson(".rulesync/permissions.jsonc");
  assert.equal(
    asObject(permissionsDocument.codexcli).base_permission_profile,
    ":danger-full-access"
  );
  assert.equal(features.has("subagents"), false);
  assert.equal(
    existsSync(join(repositoryRoot, ".rulesync", "subagents")),
    false
  );

  const contract = readJson("config/execution-contract.json");
  const providers = asObject(contract.providers);
  assert.deepEqual(
    Object.fromEntries(
      [
        "codex",
        "claude",
        "antigravity-gemini",
        "antigravity-argon",
        "antigravity-claude-gpt",
        "copilot",
        "minimax",
        "opencli-chatgpt",
        "opencli-gemini"
      ].map((name) => [name, asObject(providers[name]).delegation])
    ),
    {
      codex: "codex",
      claude: "codex",
      "antigravity-gemini": "codex",
      "antigravity-argon": "codex",
      "antigravity-claude-gpt": "codex",
      copilot: "none",
      minimax: "codex",
      "opencli-chatgpt": "codex",
      "opencli-gemini": "codex"
    }
  );
  const mcpTargets = asObject(rulesyncMcp);
  for (const target of Object.keys(mcpTargets).filter(
    (name) => name !== "$schema" && name !== "mcpServers"
  ))
    assert.equal(
      Object.hasOwn(
        asObject(asObject(mcpTargets[target]).mcpServers),
        "autodev_spawn"
      ),
      false,
      `${target} must not declare a separate spawn server`
    );
});

test("the permission inventory reads sources without changing them", () => {
  const paths = [
    "config/config.autodev.toml",
    "scripts/install.sh",
    "rulesync.jsonc",
    ".rulesync/mcp.jsonc",
    ".rulesync/permissions.jsonc"
  ];
  const before = paths.map(read);
  for (const content of before) assert.ok(content.length > 0);
  assert.deepEqual(paths.map(read), before);
});
