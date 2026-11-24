import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import {
  checkHookTrust,
  reconcileStaleOrchestratorState,
  syncHookTrust
} from "@simulatorlife/autodev-runtime/platform/install-materializer";
import { codexHookTrustEntries } from "@simulatorlife/autodev-runtime/platform/hook-trust";

import { withTempDir } from "../support/test-helpers.ts";

/**
 * The hooks Codex is given, and the hashes Codex computes for them.
 *
 * The hashes are the `currentHash` values Codex reported for these exact
 * definitions through its own `hooks/list`, so a computed hash that differs
 * from one of them means the computation no longer matches the Codex it is
 * meant to satisfy -- and Codex would skip the hook without saying so.
 */
const CODEX_HOOKS = {
  hooks: {
    SessionStart: [
      {
        matcher: ".*",
        hooks: [
          {
            type: "command",
            command:
              "~/.autodev/hooks/run-autodev-hook.sh ~/.autodev/src/hooks/session-start.ts"
          }
        ]
      }
    ],
    PreToolUse: [
      {
        matcher:
          "(?i)^(apply[_ -]?patch|view[_ -]?image|write[_ -]?to[_ -]?file|replace[_ -]?file[_ -]?content|multi[_ -]?replace[_ -]?file[_ -]?content)$",
        hooks: [
          {
            type: "command",
            command:
              "~/.autodev/hooks/run-autodev-hook.sh ~/.autodev/src/hooks/file-surface.ts",
            statusMessage: "Routing file work to the filesystem server"
          }
        ]
      },
      {
        matcher: "(?i)exec[_ -]?command|run[_ -]?command|bash",
        hooks: [
          {
            type: "command",
            command:
              "~/.autodev/hooks/run-autodev-hook.sh ~/.autodev/src/hooks/block-ccc-cli.ts",
            statusMessage: "Enforcing command policy"
          }
        ]
      },
      {
        matcher:
          "(?i)read[_ -]?file|view[_ -]?file|read[_ -]?text[_ -]?file|read[_ -]?multiple[_ -]?files|read|exec[_ -]?command|run[_ -]?command|bash|call[_ -]?mcp[_ -]?tool",
        hooks: [
          {
            type: "command",
            command:
              "~/.autodev/hooks/run-autodev-hook.sh ~/.autodev/src/hooks/skill-read-telemetry.ts",
            statusMessage: "Recording skill-read telemetry"
          }
        ]
      },
      {
        matcher:
          "(?i)^(apply[_ -]?patch|exec[_ -]?command|execute[_ -]?command|unified[_ -]?exec|write[_ -]?stdin|shell|bash|sh|zsh|run[_ -]?command|call[_ -]?mcp[_ -]?tool|write[_ -]?to[_ -]?file|replace[_ -]?file[_ -]?content|multi[_ -]?replace[_ -]?file[_ -]?content)$",
        hooks: [
          {
            type: "command",
            command:
              "~/.autodev/hooks/run-autodev-hook.sh ~/.autodev/src/hooks/role-sandbox.ts",
            statusMessage: "Enforcing the role sandbox"
          }
        ]
      }
    ]
  }
} as const;

const CODEX_HOOK_HASHES: Readonly<Record<string, string>> = {
  "session_start:0:0":
    "sha256:c5fc269277d2ae682a3ec500ac057703341aecb297e0dde03d2dc460e896b408",
  "pre_tool_use:0:0":
    "sha256:99f8511728b59f442167b0c6704d28f1cad4f81570b00c32e7fb0b9afcd3159b",
  "pre_tool_use:1:0":
    "sha256:41d1d83042fe89edeacfe32405437c6189f89750747200fd77d5ff7f99c9b0b6",
  "pre_tool_use:2:0":
    "sha256:4660e8381bc61c51b7de926a3288bb35949669dd3f342a8beb175860fa250363",
  "pre_tool_use:3:0":
    "sha256:f36cf114838a19935c986dfed17f6a4409d26034bc1ca79761ffb1c19f3dcce3"
};

/** The hash Codex computes for one hook position. */
function expectedHash(key: string): string {
  const hash = CODEX_HOOK_HASHES[key];
  if (hash === undefined) throw new Error(`no expected hash for ${key}`);
  return hash;
}

function writeCodexHooks(codexHome: string): void {
  writeFileSync(
    join(codexHome, "hooks.json"),
    `${JSON.stringify(CODEX_HOOKS, null, 2)}\n`
  );
}

test("the computed trust hashes are the hashes Codex computes for the same hooks", () => {
  const entries = codexHookTrustEntries(CODEX_HOOKS);
  assert.deepEqual(
    entries.map((entry) => entry.key),
    Object.keys(CODEX_HOOK_HASHES)
  );
  for (const entry of entries)
    assert.equal(entry.hash, expectedHash(entry.key), entry.key);
});

test("syncHookTrust writes the computed hashes and strips obsolete config.toml entries", () =>
  withTempDir((dir) => {
    const codexHome = join(dir, ".codex");
    const repoRoot = join(dir, "AutoDev");
    const configPath = join(codexHome, "config.toml");

    mkdirSync(codexHome, { recursive: true });
    const projectHooks = join(repoRoot, ".codex", "hooks.json");
    writeCodexHooks(codexHome);

    // Initial config with obsolete entries, including trust for the project
    // projection an earlier install wrote (Codex loads it a second time) and
    // trust for a hook position the projection no longer has.
    const initialContent = `
model = "autodev/orchestrator"

[hooks.state]

[hooks.state."${projectHooks}:pre_tool_use:0:0"]
trusted_hash = "${CODEX_HOOK_HASHES["pre_tool_use:0:0"]}"

[hooks.state."${codexHome}/config.toml:session_start:0:0"]
trusted_hash = "sha256:obsolete1"

[hooks.state."${codexHome}/hooks.json:user_prompt_submit:0:0"]
trusted_hash = "sha256:obsolete2"
`;
    writeFileSync(configPath, initialContent);

    // Before sync, checkHookTrust must fail
    assert.equal(checkHookTrust(configPath, codexHome, repoRoot), false);

    // Run sync
    syncHookTrust(configPath, codexHome, repoRoot);

    // After sync, checkHookTrust must pass
    assert.equal(checkHookTrust(configPath, codexHome, repoRoot), true);

    // Verify the content doesn't contain obsolete entries
    const updatedContent = readFileSync(configPath, "utf8");
    assert.doesNotMatch(updatedContent, /config\.toml:/);
    assert.equal(updatedContent.includes(projectHooks), false);
    assert.equal(updatedContent.includes("user_prompt_submit"), false);

    // Verify each hook Codex is given is trusted at user level only
    const userHooks = join(codexHome, "hooks.json");
    for (const [suffix, hash] of Object.entries(CODEX_HOOK_HASHES)) {
      assert.match(
        updatedContent,
        new RegExp(JSON.stringify(`${userHooks}:${suffix}`))
      );
      assert.match(updatedContent, new RegExp(hash));
    }
  }));

test("checkHookTrust detects a hash Codex no longer computes", () =>
  withTempDir((dir) => {
    const codexHome = join(dir, ".codex");
    const repoRoot = join(dir, "AutoDev");
    const configPath = join(codexHome, "config.toml");

    mkdirSync(codexHome, { recursive: true });
    writeCodexHooks(codexHome);
    writeFileSync(configPath, 'model = "test"\n');

    syncHookTrust(configPath, codexHome, repoRoot);
    assert.equal(checkHookTrust(configPath, codexHome, repoRoot), true);

    // Tamper with a hash
    const content = readFileSync(configPath, "utf8");
    const tampered = content.replace(
      expectedHash("session_start:0:0"),
      "sha256:tampered00000000000000000000000000000000000000000000000000000000"
    );
    writeFileSync(configPath, tampered);

    assert.equal(checkHookTrust(configPath, codexHome, repoRoot), false);
  }));

test("checkHookTrust fails when the hook definition Codex is given has changed", () =>
  withTempDir((dir) => {
    const codexHome = join(dir, ".codex");
    const repoRoot = join(dir, "AutoDev");
    const configPath = join(codexHome, "config.toml");

    mkdirSync(codexHome, { recursive: true });
    writeCodexHooks(codexHome);
    writeFileSync(configPath, 'model = "test"\n');
    syncHookTrust(configPath, codexHome, repoRoot);
    assert.equal(checkHookTrust(configPath, codexHome, repoRoot), true);

    // The definition changed, so the stored hash is no longer the hash Codex
    // computes for it.
    const changed = {
      hooks: {
        ...CODEX_HOOKS.hooks,
        PreToolUse: [
          ...CODEX_HOOKS.hooks.PreToolUse,
          {
            matcher: "write",
            hooks: [
              {
                type: "command",
                command: "~/.autodev/hooks/run-autodev-hook.sh new-hook.ts"
              }
            ]
          }
        ]
      }
    };
    writeFileSync(
      join(codexHome, "hooks.json"),
      `${JSON.stringify(changed, null, 2)}\n`
    );

    assert.equal(checkHookTrust(configPath, codexHome, repoRoot), false);
  }));

test("reconcileStaleOrchestratorState upgrades legacy degraded orchestrator defaults while keeping operator overrides", () =>
  withTempDir((dir) => {
    const codexHome = join(dir, ".codex");
    const statePath = join(codexHome, "codex-router-state.json");
    mkdirSync(codexHome, { recursive: true });
    writeFileSync(
      statePath,
      JSON.stringify({
        schema: "autodev-router-persisted-state-v4",
        roleAssignments: {
          claude: {
            orchestrator: {
              priority: 2,
              model: "claude-opus-5-5",
              reasoningEffort: "medium"
            }
          },
          "antigravity-claude-gpt": {
            orchestrator: {
              priority: 2,
              model: "claude-opus-5-5-medium",
              reasoningEffort: "high"
            }
          },
          "antigravity-gemini": {
            orchestrator: { priority: 3, model: null }
          },
          "antigravity-argon": {
            orchestrator: { priority: 3, model: "gemini-4-argon-medium" }
          },
          copilot: {
            orchestrator: { priority: "disabled", model: "copilot" }
          }
        }
      })
    );

    assert.equal(reconcileStaleOrchestratorState(codexHome), true);
    const updated = JSON.parse(readFileSync(statePath, "utf8")) as {
      roleAssignments: Record<string, Record<string, unknown>>;
    };
    assert.deepEqual(updated.roleAssignments.claude?.orchestrator, {
      priority: 2,
      model: "claude-opus-5-5",
      reasoningEffort: "high"
    });
    assert.deepEqual(
      updated.roleAssignments["antigravity-claude-gpt"]?.orchestrator,
      {
        priority: 2,
        model: "claude-opus-5-5-high",
        reasoningEffort: "high"
      }
    );
    assert.deepEqual(
      updated.roleAssignments["antigravity-gemini"]?.orchestrator,
      {
        priority: 3,
        model: null
      }
    );
    assert.deepEqual(
      updated.roleAssignments["antigravity-argon"]?.orchestrator,
      {
        priority: 3,
        model: "gemini-4-argon-medium"
      }
    );
    assert.deepEqual(updated.roleAssignments.copilot?.orchestrator, {
      priority: "disabled",
      model: "copilot"
    });
    assert.equal(reconcileStaleOrchestratorState(codexHome), false);
  }));
