import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { lstatSync, readFileSync, readlinkSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const agentsPath = join(repositoryRoot, "AGENTS.md");

test("AGENTS.md is the single regular repository instruction file", () => {
  const stat = lstatSync(agentsPath);
  assert.equal(stat.isSymbolicLink(), false);
  assert.ok(readFileSync(agentsPath, "utf8").trim());
});

test("CLAUDE.md is a symlink to AGENTS.md", () => {
  assert.equal(
    lstatSync(join(repositoryRoot, "CLAUDE.md")).isSymbolicLink(),
    true
  );
  assert.equal(
    readlinkSync(join(repositoryRoot, "CLAUDE.md")).toString(),
    "AGENTS.md"
  );
});

test("no other instruction copies exist", () => {
  for (const relativePath of [
    ".github/copilot-instructions.md",
    ".claude/CLAUDE.md",
    "GEMINI.md",
    ".rulesync/rules"
  ]) {
    assert.equal(
      lstatSafe(join(repositoryRoot, relativePath)),
      false,
      relativePath
    );
  }
  const tracked = execFileSync("git", ["ls-files", "-z"], {
    cwd: repositoryRoot,
    encoding: "utf8"
  })
    .split("\0")
    .filter(Boolean);
  const expected = readFileSync(agentsPath);
  const copies = tracked.filter((relativePath) => {
    const absolutePath = join(repositoryRoot, relativePath);
    return (
      relativePath !== "AGENTS.md" &&
      lstatSafe(absolutePath) &&
      !lstatSync(absolutePath).isSymbolicLink() &&
      readFileSync(absolutePath).equals(expected)
    );
  });
  assert.deepEqual(copies, []);
});

function lstatSafe(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}
