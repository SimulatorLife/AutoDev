import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  lstatSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync
} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { materializeCommandRules } from "@simulatorlife/autodev-runtime/platform/install-materializer";

/**
 * `agents/rules/default.rules` is Codex execpolicy: the decision it returns is
 * what Codex does with a model-issued command. These rows pin the Git policy:
 * an agent can stage and commit its own work (`allow` runs it outside the
 * workspace-write sandbox, which keeps `.git` read-only), while publishing,
 * amending and history-destroying commands do not get that exemption.
 *
 * Codex also validates every rule's `match`/`not_match` examples when it loads
 * the file, so a malformed rule fails here as a load error.
 */
const RULES = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../agents/rules/default.rules"
);

const codexAvailable =
  spawnSync("codex", ["--version"], { encoding: "utf8" }).status === 0;

function decide(command: readonly string[]): string | null {
  const result = spawnSync(
    "codex",
    ["execpolicy", "check", "--rules", RULES, ...command],
    { encoding: "utf8" }
  );
  assert.equal(result.status, 0, result.stderr);
  const parsed = JSON.parse(result.stdout) as { decision?: string };
  return parsed.decision ?? null;
}

const GIT_DECISIONS: readonly [string, string | null][] = [
  ["git add runtime/src/file.ts", "allow"],
  ["git commit -m message", "allow"],
  ["git mv old.ts new.ts", "allow"],
  ["git rm --cached file", "allow"],
  ["git restore --staged file", "allow"],
  ["git switch -c feature", "allow"],
  ["git worktree add ../tree", "allow"],
  ["git commit --amend -m message", "prompt"],
  ["git -c core.hooksPath=hooks commit -m message", null],
  ["git push", null],
  ["git push --force", "forbidden"],
  ["git reset --hard HEAD", "forbidden"],
  ["git restore .", "forbidden"],
  ["git clean -fd", "forbidden"]
];

for (const [command, expected] of GIT_DECISIONS) {
  test(
    `default.rules decides ${JSON.stringify(command)} as ${expected ?? "unmatched"}`,
    { skip: codexAvailable ? false : "codex CLI not installed" },
    () => {
      assert.equal(decide(command.split(" ")), expected);
    }
  );
}

test("installer replaces a symlinked default.rules with a regular-file copy, because Codex skips symlinked rule files", () => {
  const repositoryRoot = path.resolve(path.dirname(RULES), "../..");
  const rules = mkdtempSync(path.join(os.tmpdir(), "autodev-rules-"));
  try {
    const installed = path.join(rules, "default.rules");
    symlinkSync(RULES, installed);
    materializeCommandRules(repositoryRoot, rules);
    const stat = lstatSync(installed);
    assert.equal(stat.isSymbolicLink(), false);
    assert.equal(stat.isFile(), true);
    assert.equal(stat.mode & 0o777, 0o644);
    assert.deepEqual(readFileSync(installed), readFileSync(RULES));
  } finally {
    rmSync(rules, { recursive: true, force: true });
  }
});
