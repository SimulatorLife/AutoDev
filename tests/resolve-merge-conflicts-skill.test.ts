/**
The merge-conflict skill and its bundled helper.

The helper is exercised against a synthetic conflicted repository rather
than by reading its source: the contract is what it reports and what it
leaves untouched, not how it is written.
*/

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { userLevelSkills } from "@simulatorlife/autodev-runtime/platform/user-level-skills";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const helperPath = path.join(
  repositoryRoot,
  ".rulesync/skills/resolve-merge-conflicts/scripts/extract_conflict_context.py"
);

const read = (relativePath: string): string =>
  readFileSync(new URL(`../${relativePath}`, import.meta.url), "utf8");

const skill = read(".rulesync/skills/resolve-merge-conflicts/SKILL.md");
const notices = read(
  ".rulesync/skills/resolve-merge-conflicts/THIRD_PARTY_NOTICES.md"
);

test("resolve-merge-conflicts is installed as a user-level skill", () => {
  const userLevel = userLevelSkills(
    path.join(repositoryRoot, ".rulesync", "skills")
  );
  assert.ok(userLevel.includes("resolve-merge-conflicts"));
});

test("merge conflict skill uses the compact extractor before full-file inspection", () => {
  // The skill has to point at the helper it ships, and the helper has to
  // exist where the skill says it does.
  assert.match(
    skill,
    /\.agents\/skills\/resolve-merge-conflicts\/scripts\/extract_conflict_context\.py/u
  );
  assert.equal(
    readFileSync(helperPath, "utf8").length > 0,
    true,
    "the helper the skill names exists"
  );
});

/**
A repository with one conflicted file.

The conflict is created by merging two branches that changed the same
file, so the helper sees the same three index stages a real merge leaves.
*/
function conflictedRepository(): string {
  const directory = mkdtempSync(path.join(tmpdir(), "autodev-conflict-"));
  const git = (...arguments_: string[]): void => {
    const result = spawnSync("git", arguments_, {
      cwd: directory,
      encoding: "utf8"
    });
    assert.equal(result.status, 0, `git ${arguments_.join(" ")} failed`);
  };
  git("init", "--initial-branch=main", ".");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "Test");
  writeFileSync(path.join(directory, "a.txt"), "base\n");
  git("add", "a.txt");
  git("commit", "-m", "base");
  git("checkout", "-b", "other");
  writeFileSync(path.join(directory, "a.txt"), "theirs\n");
  git("commit", "-am", "theirs");
  git("checkout", "main");
  writeFileSync(path.join(directory, "a.txt"), "ours\n");
  git("commit", "-am", "ours");
  spawnSync("git", ["merge", "other"], { cwd: directory, encoding: "utf8" });
  return directory;
}

function runHelper(
  repository: string,
  ...arguments_: string[]
): { readonly status: number | null; readonly stdout: string } {
  const result = spawnSync("python3", [helperPath, "--repo", repository, ...arguments_], {
    encoding: "utf8"
  });
  return { status: result.status, stdout: result.stdout };
}

test("the conflict helper reports the conflicted files and their index stages", () => {
  const repository = conflictedRepository();
  try {
    const { status, stdout } = runHelper(repository, "--json");
    assert.equal(status, 0);
    const report = JSON.parse(stdout) as {
      readonly repo_root: string;
      readonly conflicted_files: readonly {
        readonly path: string;
        readonly conflict_type: string;
        readonly stages: readonly number[];
        readonly marker_hunks: number;
        readonly parse_error: string | null;
      }[];
    };
    assert.equal(report.repo_root, realpathSync(repository));
    assert.equal(report.conflicted_files.length, 1);
    const file = report.conflicted_files[0];
    assert.equal(file?.path, "a.txt");
    assert.equal(file?.conflict_type, "text");
    assert.deepEqual(file?.stages, [1, 2, 3]);
    assert.equal(file?.marker_hunks, 1);
    assert.equal(file?.parse_error, null);
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
});

test("the conflict helper leaves the conflicted repository untouched", () => {
  const repository = conflictedRepository();
  try {
    const before = {
      status: spawnSync("git", ["status", "--porcelain"], {
        cwd: repository,
        encoding: "utf8"
      }).stdout,
      index: spawnSync("git", ["ls-files", "-u"], {
        cwd: repository,
        encoding: "utf8"
      }).stdout
    };
    runHelper(repository, "--json");
    runHelper(repository, "--file", "a.txt", "--context", "3");
    const after = {
      status: spawnSync("git", ["status", "--porcelain"], {
        cwd: repository,
        encoding: "utf8"
      }).stdout,
      index: spawnSync("git", ["ls-files", "-u"], {
        cwd: repository,
        encoding: "utf8"
      }).stdout
    };
    // The helper is diagnostic: it resolves nothing and stages nothing.
    assert.equal(after.status, before.status);
    assert.equal(after.index, before.index);
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
});

test("the conflict helper's context and line budget shape its output", () => {
  const repository = conflictedRepository();
  try {
    const wide = runHelper(repository, "--file", "a.txt", "--context", "5");
    const narrow = runHelper(
      repository,
      "--file",
      "a.txt",
      "--context",
      "1",
      "--max-lines",
      "2"
    );
    assert.equal(wide.status, 0);
    assert.equal(narrow.status, 0);
    assert.ok(wide.stdout.includes("ours (HEAD):"));
    assert.ok(wide.stdout.includes("theirs (other):"));
    // A smaller budget truncates the section it prints.
    assert.ok(
      narrow.stdout.length < wide.stdout.length,
      "the line budget did not shorten the output"
    );
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
});

test("the conflict helper exposes the flags the skill documents", () => {
  const help = spawnSync("python3", [helperPath, "--help"], {
    encoding: "utf8"
  }).stdout;
  for (const flag of [
    "--repo",
    "--file",
    "--all",
    "--json",
    "--context",
    "--max-lines"
  ]) {
    assert.ok(help.includes(flag), `the helper does not expose ${flag}`);
  }
});

test("Warp helper license notice is retained", () => {
  assert.match(notices, /MIT License/);
  assert.match(notices, /Copyright \(c\) \d{4} Denver Technologies, Inc\./);
  assert.match(notices, /warpdotdev\/common-skills/);
});
