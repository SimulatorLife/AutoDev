import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  CANONICAL_HOOK_HASHES,
  checkHookTrust,
  syncHookTrust
} from "../../src/platform/install-materializer.ts";

function withTempDir<T>(callback: (directory: string) => T): T {
  const directory = mkdtempSync(join(tmpdir(), "autodev-hook-trust-"));
  try {
    return callback(directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test("CANONICAL_HOOK_HASHES contains the 5 required hooks", () => {
  const keys = Object.keys(CANONICAL_HOOK_HASHES).sort();
  assert.deepEqual(keys, [
    "pre_tool_use:0:0",
    "pre_tool_use:1:0",
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
    mkdirSync(join(repoRoot, ".codex"), { recursive: true });
    writeFileSync(join(repoRoot, ".codex", "hooks.json"), "{}");

    // Initial config with obsolete entries
    const initialContent = `
model = "autodev/orchestrator"

[hooks.state]

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

    // Verify each canonical hook is present
    const userHooks = join(codexHome, "hooks.json");
    const projectHooks = join(repoRoot, ".codex", "hooks.json");
    for (const [suffix, hash] of Object.entries(CANONICAL_HOOK_HASHES)) {
      assert.match(
        updatedContent,
        new RegExp(JSON.stringify(`${userHooks}:${suffix}`))
      );
      assert.match(
        updatedContent,
        new RegExp(JSON.stringify(`${projectHooks}:${suffix}`))
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
