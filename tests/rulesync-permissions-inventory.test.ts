import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync
} from "node:fs";
import { tmpdir } from "node:os";
import path, { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { updateAntigravityPermissions } from "@simulatorlife/autodev-runtime/platform/antigravity-settings";
import { parseJsoncObject } from "@simulatorlife/autodev-data/files";
import { parse } from "smol-toml";

import { normalizedSource } from "./source-text.ts";

type JsonObject = Record<string, unknown>;
const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const read = (relativePath: string): string => {
  const text = readFileSync(join(repositoryRoot, relativePath), "utf8");
  return relativePath.endsWith(".ts") ? normalizedSource(text) : text;
};
const readJson = (relativePath: string): JsonObject =>
  parseJsoncObject(read(relativePath), relativePath) as JsonObject;
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
  // The recursive forced deletions are denied as a family, which covers the
  // `.git` case that used to carry its own rule.
  assert.equal(sharedBash["rm -rf *"], "deny");
  assert.equal(sharedBash["rm -fr *"], "deny");

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
  const modelProviders = Object.values(
    asObject(portableConfig.model_providers)
  );
  for (const provider of modelProviders) {
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
  assert.deepEqual(sharedPermission.mcp__xacpx, { "*": "allow" });
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
  // The read roots are shared by every target; Antigravity only overrides the
  // machine-local write behaviour.
  const sharedRead = asObject(sharedPermission.read);
  for (const root of [
    "~/.autodev/**",
    "~/.agents/**",
    "~/.codex/**",
    "~/.claude/**",
    "~/.gemini/**",
    "~/.minimax/**",
    "~/.mmx/**",
    "~/.opencli/**",
    "~/.copilot/**"
  ])
    assert.equal(sharedRead[root], "allow", root);
  for (const root of [
    "~/.ssh/**",
    "~/.gnupg/**",
    "~/.aws/**",
    "~/.netrc",
    "~/.npmrc",
    "~/.git-credentials"
  ])
    assert.equal(sharedRead[root], "deny", root);
  assert.equal(Object.hasOwn(agyPermission, "read"), false);
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
    "normalizedReadRoots"
  ])
    assert.ok(source.includes(marker), marker);
});

/**
The Antigravity permissions file is a secret-bearing document, so it is
written for its owner only.

The mode is asserted on the written file rather than on the source of the
writer, so a refactor of the writer cannot silently widen it.
*/
test("the Antigravity permissions file is written for its owner only", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "autodev-agy-permissions-"));
  try {
    const settingsPath = join(directory, "settings.json");
    updateAntigravityPermissions(settingsPath, [directory], directory);
    const mode = statSync(settingsPath).mode & 0o777;
    assert.equal(mode, 0o600, `expected 0600, got ${mode.toString(8)}`);
    // The document is written atomically as JSON, so a reader never sees a
    // half-written file.
    const parsed = JSON.parse(readFileSync(settingsPath, "utf8")) as JsonObject;
    assert.ok(asObject(parsed.permissions));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
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
        "opencli-gemini",
        "mcode"
      ].map((name) => [name, asObject(providers[name]).delegation])
    ),
    {
      codex: "xacpx",
      claude: "xacpx",
      "antigravity-gemini": "xacpx",
      "antigravity-argon": "xacpx",
      "antigravity-claude-gpt": "xacpx",
      copilot: "xacpx",
      minimax: "xacpx",
      "opencli-chatgpt": "xacpx",
      "opencli-gemini": "none",
      mcode: "xacpx"
    }
  );
  // The retired `chatgpt` contract entry must not come back.
  assert.equal(Object.hasOwn(providers, "chatgpt"), false);
  const mcpTargets = asObject(rulesyncMcp);
  const providerTargets = Object.keys(mcpTargets).filter(
    (name) => name !== "$schema" && name !== "mcpServers"
  );
  for (const target of providerTargets) {
    const servers = asObject(asObject(mcpTargets[target]).mcpServers);
    assert.equal(
      Object.hasOwn(servers, "autodev_spawn"),
      false,
      `${target} must not declare a separate spawn server`
    );
  }
});

test("the permission inventory reads sources without changing them", () => {
  const paths = [
    "config/config.autodev.toml",
    "scripts/install.sh",
    "rulesync.jsonc",
    ".rulesync/mcp.jsonc",
    ".rulesync/permissions.jsonc"
  ];
  const before = paths.map((relativePath) =>
    statSync(join(repositoryRoot, relativePath)).mtimeMs
  );
  const contents = paths.map(read);
  for (const content of contents) assert.ok(content.length > 0);
  const after = paths.map((relativePath) =>
    statSync(join(repositoryRoot, relativePath)).mtimeMs
  );
  assert.deepEqual(after, before);
});
