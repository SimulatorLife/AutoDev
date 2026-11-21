import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import {
  CANONICAL_HOOK_HASHES,
  checkHookTrust,
  reconcileStaleOrchestratorState,
  syncHookTrust
} from "@simulatorlife/autodev-runtime/platform/install-materializer";

import { withTempDir } from "../support/test-helpers.ts";

test("CANONICAL_HOOK_HASHES contains every canonical hook", () => {
  const keys = Object.keys(CANONICAL_HOOK_HASHES).sort();
  assert.deepEqual(keys, [
    "pre_tool_use:0:0",
    "pre_tool_use:1:0",
    "pre_tool_use:2:0",
    "session_end:0:0",
    "session_start:0:0",
    "subagent_start:0:0",
    "user_prompt_submit:0:0"
  ]);
  for (const hash of Object.values(CANONICAL_HOOK_HASHES)) {
    assert.match(hash, /^sha256:[a-f0-9]{64}$/);
  }
});

test("syncHookTrust populates canonical hashes and strips obsolete config.toml entries", () =>
  withTempDir((dir) => {
    const codexHome = join(dir, ".codex");
    const repoRoot = join(dir, "AutoDev");
    const configPath = join(codexHome, "config.toml");

    mkdirSync(codexHome, { recursive: true });
    const projectHooks = join(repoRoot, ".codex", "hooks.json");

    // Initial config with obsolete entries, including trust for the project
    // projection an earlier install wrote (Codex loads it a second time).
    const initialContent = `
model = "autodev/orchestrator"

[hooks.state]

[hooks.state."${projectHooks}:user_prompt_submit:0:0"]
trusted_hash = "${CANONICAL_HOOK_HASHES["user_prompt_submit:0:0"]}"

[hooks.state."${codexHome}/config.toml:user_prompt_submit:0:0"]
trusted_hash = "sha256:obsolete1"

[hooks.state."${codexHome}/config.toml:subagent_start:0:0"]
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

    // Verify each canonical hook is trusted at user level only
    const userHooks = join(codexHome, "hooks.json");
    for (const [suffix, hash] of Object.entries(CANONICAL_HOOK_HASHES)) {
      assert.match(
        updatedContent,
        new RegExp(JSON.stringify(`${userHooks}:${suffix}`))
      );
      assert.match(updatedContent, new RegExp(hash));
    }
  }));

test("checkHookTrust detects missing or drifted hashes", () =>
  withTempDir((dir) => {
    const codexHome = join(dir, ".codex");
    const repoRoot = join(dir, "AutoDev");
    const configPath = join(codexHome, "config.toml");

    mkdirSync(codexHome, { recursive: true });
    writeFileSync(configPath, 'model = "test"\n');

    syncHookTrust(configPath, codexHome, repoRoot);
    assert.equal(checkHookTrust(configPath, codexHome, repoRoot), true);

    // Tamper with a hash
    const content = readFileSync(configPath, "utf8");
    const tampered = content.replace(
      CANONICAL_HOOK_HASHES["user_prompt_submit:0:0"],
      "sha256:tampered00000000000000000000000000000000000000000000000000000000"
    );
    writeFileSync(configPath, tampered);

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
            orchestrator: { priority: 2, model: null }
          },
          "antigravity-argon": {
            orchestrator: { priority: 2, model: "gemini-4-argon-medium" }
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
        model: "gemini-4-argon-high",
        reasoningEffort: "high"
      }
    );
    assert.deepEqual(updated.roleAssignments.copilot?.orchestrator, {
      priority: "disabled",
      model: "copilot"
    });
    assert.equal(reconcileStaleOrchestratorState(codexHome), false);
  }));
