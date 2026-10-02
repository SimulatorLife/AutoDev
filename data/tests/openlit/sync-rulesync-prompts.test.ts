import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  deterministicUuid,
  loadRulesyncPrompts,
  parseRulesyncPrompt,
  syncRulesyncPrompts
} from "@simulatorlife/autodev-data/openlit";

const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));
const commandsDir = join(repositoryRoot, ".rulesync", "commands");

test("parseRulesyncPrompt extracts description, targets, and body correctly", () => {
  const content = `---
targets: ["codexcli", "claude"]
description: Custom command for refactoring.
---
# Refactor command

Do something cleanly.`;

  const parsed = parseRulesyncPrompt("test-refactor", content);
  assert.equal(parsed.name, "test-refactor");
  assert.equal(parsed.description, "Custom command for refactoring.");
  assert.deepEqual(parsed.targets, ["codexcli", "claude"]);
  assert.equal(parsed.prompt, "# Refactor command\n\nDo something cleanly.");
});

test("parseRulesyncPrompt throws when frontmatter is missing", () => {
  assert.throws(
    () => parseRulesyncPrompt("bad", "# Missing frontmatter\n\nJust text"),
    /missing valid YAML frontmatter/i
  );
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

test("loadRulesyncPrompts exactly mirrors the canonical command directory", () => {
  const catalog = loadRulesyncPrompts(repositoryRoot);
  const onDiskNames = readdirSync(commandsDir)
    .filter((file) => file.endsWith(".md"))
    .map((file) => file.replace(/\.md$/u, ""))
    .sort();

  assert.deepEqual([...catalog.keys()].sort(), onDiskNames);
  for (const name of onDiskNames) {
    const entry = catalog.get(name)!;
    assert.ok(
      entry.description.length > 0,
      `Prompt "${name}" must have description`
    );
    assert.ok(
      entry.prompt.length > 0,
      `Prompt "${name}" must have prompt body`
    );
  }
});

test("syncRulesyncPrompts synchronizes rulesync prompts idempotently against ClickHouse", async () => {
  try {
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
  } catch (error) {
    if ((error as Error).message.includes("ECONNREFUSED")) {
      // ClickHouse container not running in this environment — skip gracefully
      return;
    }
    throw error;
  }
});
