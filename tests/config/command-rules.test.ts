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
import {
  codexCliVersion,
  findCodexBinary
} from "@simulatorlife/autodev-runtime/shared/executables";

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

/**
 * The Codex CLI the rules are judged by.
 *
 * The rules are a Codex contract, so they are checked with the CLI this
 * machine would actually run: the shared lookup answers with the newest CLI
 * installed, not with whichever copy a stale PATH entry names. A CLI that
 * predates the `execpolicy` subcommand cannot judge the rules at all -- it
 * rejects the check itself and says nothing about them -- so that is reported
 * as the reason the check could not run rather than as a rule failure.
 */
interface CodexLookup {
  /** The CLI to check with, or null when there is none to check with. */
  readonly binary: string | null;
  /** Why the rules cannot be checked, or null when they can. */
  readonly skip: string | null;
}

function locateCodex(): CodexLookup {
  let binary: string | null;
  try {
    binary = findCodexBinary();
  } catch {
    return {
      binary: null,
      skip: "CODEX_BIN names a CLI that is not executable"
    };
  }
  if (!binary) return { binary: null, skip: "codex CLI not installed" };
  const version = codexCliVersion(binary);
  const judged = spawnSync(binary, ["execpolicy", "check", "--help"], {
    encoding: "utf8"
  });
  if (judged.status !== 0)
    return {
      binary,
      skip:
        "the codex CLI at " +
        binary +
        (version ? " (version " + version + ")" : " (version unknown)") +
        " has no execpolicy check subcommand"
    };
  return { binary, skip: null };
}

const codex = locateCodex();

function decide(command: readonly string[]): string | null {
  const binary = codex.binary;
  if (!binary) throw new Error("the Codex CLI is not available");
  const result = spawnSync(
    binary,
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
  ["git status --short", "allow"],
  ["git diff --cached", "allow"],
  ["git rev-parse --short HEAD", "allow"],
  ["git ls-files runtime/src", "allow"],
  ["git branch --show-current", "allow"],
  ["git commit --amend -m message", "prompt"],
  ["git -c core.hooksPath=hooks commit -m message", null],
  ["git config core.hooksPath hooks", null],
  ["git push", null],
  ["git push --force", "forbidden"],
  ["git reset --hard HEAD", "forbidden"],
  ["git restore .", "forbidden"],
  ["git clean -fd", "forbidden"]
];

for (const [command, expected] of GIT_DECISIONS) {
  test(
    `default.rules decides ${JSON.stringify(command)} as ${expected ?? "unmatched"}`,
    { skip: codex.skip ?? false },
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
