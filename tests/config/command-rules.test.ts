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

import { createCodexPermissionsSource } from "@simulatorlife/autodev-runtime/platform";
import { materializeCommandRules } from "@simulatorlife/autodev-runtime/platform/install-materializer";
import {
  codexCliVersion,
  findCodexBinary
} from "@simulatorlife/autodev-runtime/shared/executables";

const REPOSITORY_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../.."
);

interface CodexLookup {
  readonly binary: string | null;
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

function decide(rulesFile: string, command: readonly string[]): string | null {
  const binary = codex.binary;
  if (!binary) throw new Error("the Codex CLI is not available");
  const result = spawnSync(
    binary,
    ["execpolicy", "check", "--rules", rulesFile, ...command],
    { encoding: "utf8" }
  );
  assert.equal(result.status, 0, result.stderr);
  const parsed = JSON.parse(result.stdout) as { decision?: string };
  return parsed.decision ?? null;
}

const COMMAND_DECISIONS: readonly [string, string | null][] = [
  ["git add runtime/src/file.ts", null],
  ["git commit -m message", null],
  ["git status --short", null],
  ["git push", null],
  ["git commit --amend -m message", "prompt"],
  ["git -c core.hooksPath=hooks commit -m message", null],
  ["git config core.hooksPath hooks", null],
  ["git push -f", "forbidden"],
  ["git push --force", "forbidden"],
  ["git push --force-with-lease", "forbidden"],
  ["git checkout -- file.ts", "forbidden"],
  ["git reset --hard HEAD", "forbidden"],
  ["git stash", "forbidden"],
  ["git clean -fd", "forbidden"],
  ["git rebase main", "forbidden"],
  ["git restore .", "forbidden"],
  ["git branch -D feature", "forbidden"],
  ["sudo ls", "forbidden"],
  ["ccc search query", "forbidden"],
  ["rm -rf /", "forbidden"],
  ["rm -rf ~", "forbidden"],
  ["rm -rf .", "forbidden"],
  ["rm -rf ..", "forbidden"],
  ["rm -rf .git", "forbidden"],
  ["rm -fr .git", "forbidden"],
  ["rm -rf build", null]
];

test(
  "projected rulesync.rules passes codex execpolicy checks",
  {
    skip: codex.skip ?? false
  },
  () => {
    const projection = createCodexPermissionsSource(REPOSITORY_ROOT);
    try {
      for (const [command, expected] of COMMAND_DECISIONS) {
        assert.equal(
          decide(projection.rulesSource, command.split(" ")),
          expected,
          `expected ${JSON.stringify(command)} -> ${expected ?? "unmatched"}`
        );
      }
    } finally {
      rmSync(projection.root, { recursive: true, force: true });
    }
  }
);

test("installer replaces a symlinked rulesync.rules with a regular-file copy, because Codex skips symlinked rule files", () => {
  const rules = mkdtempSync(path.join(os.tmpdir(), "autodev-rules-"));
  const projection = createCodexPermissionsSource(REPOSITORY_ROOT);
  try {
    const installed = path.join(rules, "rulesync.rules");
    symlinkSync(projection.rulesSource, installed);
    materializeCommandRules(REPOSITORY_ROOT, rules);
    const stat = lstatSync(installed);
    assert.equal(stat.isSymbolicLink(), false);
    assert.equal(stat.isFile(), true);
    assert.equal(stat.mode & 0o777, 0o644);
    assert.deepEqual(
      readFileSync(installed),
      readFileSync(projection.rulesSource)
    );
  } finally {
    rmSync(projection.root, { recursive: true, force: true });
    rmSync(rules, { recursive: true, force: true });
  }
});
