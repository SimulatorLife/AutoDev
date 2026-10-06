import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { RuleSyncRepository } from "@simulatorlife/autodev-data";
import {
  deterministicUuid,
  syncRulesyncPrompts
} from "@simulatorlife/autodev-data/openlit";

import { clickHouseSkipReason } from "./live-services.ts";

const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));
const commandsDir = join(repositoryRoot, ".rulesync", "commands");

test("RuleSyncRepository parses canonical command metadata and prompt body", async () => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "rulesync-command-read-"));
  try {
    const temporaryCommandsDir = join(temporaryRoot, ".rulesync", "commands");
    await mkdir(temporaryCommandsDir, { recursive: true });
    const content = `---\ntargets: [codexcli, claudecode]\ndescription: Custom command for refactoring.\n---\n# Refactor command\n\nDo something cleanly.\n`;
    await writeFile(join(temporaryCommandsDir, "test-refactor.md"), content);

    const state = new RuleSyncRepository(temporaryRoot).loadCommands();
    assert.equal(state.valid, true);
    assert.deepEqual(state.commands, [
      {
        name: "test-refactor",
        path: ".rulesync/commands/test-refactor.md",
        kind: "command",
        content,
        prompt: "# Refactor command\n\nDo something cleanly.",
        revision: createHash("sha256").update(content, "utf8").digest("hex"),
        description: "Custom command for refactoring.",
        targets: ["codexcli", "claudecode"]
      }
    ]);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("RuleSyncRepository reports invalid command frontmatter instead of a partial catalog", async () => {
  const temporaryRoot = await mkdtemp(
    join(tmpdir(), "rulesync-command-invalid-")
  );
  try {
    const temporaryCommandsDir = join(temporaryRoot, ".rulesync", "commands");
    await mkdir(temporaryCommandsDir, { recursive: true });
    await writeFile(
      join(temporaryCommandsDir, "bad.md"),
      "# Missing frontmatter\n"
    );

    assert.deepEqual(new RuleSyncRepository(temporaryRoot).loadCommands(), {
      source: ".rulesync/commands",
      valid: false,
      commands: []
    });
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("deterministicUuid produces valid RFC 4122 v5 UUIDs", () => {
  const uuid1 = deterministicUuid("autodev:prompt:dry");
  const uuid2 = deterministicUuid("autodev:prompt:dry");
  const uuid3 = deterministicUuid("autodev:prompt:kiss");

  const uuidRegex =
    /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

  assert.match(uuid1, uuidRegex);
  assert.match(uuid3, uuidRegex);
  assert.equal(uuid1, uuid2, "Same input must produce identical UUID");
  assert.notEqual(
    uuid1,
    uuid3,
    "Different inputs must produce different UUIDs"
  );
});

test("RuleSyncRepository catalog exactly mirrors canonical commands with real metadata", async () => {
  const state = new RuleSyncRepository(repositoryRoot).loadCommands();
  const onDiskNames = (await readdir(commandsDir))
    .filter((file) => file.endsWith(".md"))
    .map((file) => file.replace(/\.md$/u, ""))
    .sort();
  assert.equal(state.valid, true);
  assert.deepEqual(
    state.commands.map((command) => command.name).sort(),
    onDiskNames
  );
  for (const command of state.commands) {
    assert.ok(
      command.description,
      `Command "${command.name}" needs source metadata`
    );
    assert.ok(command.targets.length > 0);
    assert.ok(command.prompt.length > 0);
  }
});

test(
  "syncRulesyncPrompts synchronizes rulesync prompts idempotently against ClickHouse",
  { skip: await clickHouseSkipReason() },
  async () => {
    const result1 = await syncRulesyncPrompts({ repositoryRoot });
    assert.ok(
      result1.totalCatalogPrompts >= 54,
      `Expected at least 54 prompts, got ${result1.totalCatalogPrompts}`
    );
    assert.equal(result1.removed.length, 0);

    // Second run must be completely unchanged (idempotent)
    const result2 = await syncRulesyncPrompts({ repositoryRoot });
    assert.equal(result2.inserted.length, 0, "Second run should insert 0");
    assert.equal(result2.updated.length, 0, "Second run should update 0");
    assert.equal(
      result2.unchanged.length,
      result2.totalCatalogPrompts,
      "All prompts must be unchanged on second run"
    );
  }
);
