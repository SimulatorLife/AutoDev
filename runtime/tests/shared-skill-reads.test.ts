import assert from "node:assert/strict";
import { homedir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  extractSkillReadPath,
  flattenCommandValue,
  isPathLikeToken,
  matchExecReadPaths,
  matchSkillReadPath,
  matchSkillReadTarget,
  normaliseSkillReadPath,
  resolveSkillRoots,
  tokenizeShellWords
} from "../src/shared/skill-reads.ts";

const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const CANONICAL_SKILL = path.join(
  REPO_ROOT,
  ".rulesync",
  "skills",
  "orchestration",
  "SKILL.md"
);
const NON_SKILL = path.join(REPO_ROOT, "AGENTS.md");

test("tokenizeShellWords parses shell arguments honouring quotes", () => {
  assert.deepEqual(tokenizeShellWords('cat "/path with spaces/file.txt" -n'), [
    "cat",
    "/path with spaces/file.txt",
    "-n"
  ]);
  assert.deepEqual(tokenizeShellWords("head -n 20 'single quoted' plain"), [
    "head",
    "-n",
    "20",
    "single quoted",
    "plain"
  ]);
});

test("normaliseSkillReadPath expands home directory and resolves paths", () => {
  const home = homedir();
  assert.equal(
    normaliseSkillReadPath("~/skills/test/SKILL.md"),
    path.join(home, "skills/test/SKILL.md")
  );
  assert.equal(
    normaliseSkillReadPath('"~/skills/test/SKILL.md"'),
    path.join(home, "skills/test/SKILL.md")
  );
  assert.equal(normaliseSkillReadPath(null), null);
  assert.equal(normaliseSkillReadPath(""), null);
});

test("isPathLikeToken recognizes absolute and home-relative paths only", () => {
  assert.equal(isPathLikeToken("/etc/hosts"), "/etc/hosts");
  assert.equal(isPathLikeToken("~/test"), "~/test");
  assert.equal(isPathLikeToken("-v"), null);
  assert.equal(isPathLikeToken("relative/path"), null);
  assert.equal(isPathLikeToken(123), null);
});

test("flattenCommandValue handles strings, arrays, and nested objects", () => {
  assert.equal(flattenCommandValue("cat a.txt"), "cat a.txt");
  assert.equal(
    flattenCommandValue(["bash", "-lc", "cat a.txt"]),
    "bash -lc cat a.txt"
  );
  assert.equal(flattenCommandValue({ command: "cat b.txt" }), "cat b.txt");
  assert.equal(flattenCommandValue({ cmd: "cat c.txt" }), "cat c.txt");
  assert.equal(
    flattenCommandValue({ command: { cmd: "cat d.txt" } }),
    "cat d.txt"
  );
});

test("matchExecReadPaths finds paths for supported read commands", () => {
  assert.deepEqual(matchExecReadPaths('cat "/var/log/syslog" && echo done'), [
    "/var/log/syslog"
  ]);
  assert.deepEqual(
    matchExecReadPaths('sed -n "1,20p" ~/sample.txt | grep foo'),
    ["~/sample.txt"]
  );
  // Plain sed without -n is not a read command
  assert.deepEqual(matchExecReadPaths('sed "s/a/b/" ~/sample.txt'), []);
});

test("resolveSkillRoots returns verified existing skill roots", () => {
  const roots = resolveSkillRoots(REPO_ROOT);
  assert.ok(Array.isArray(roots));
  assert.ok(roots.length > 0);
  assert.ok(
    roots.some((r) => r.includes(".rulesync") || r.includes(".agents"))
  );
});

test("matchSkillReadTarget and matchSkillReadPath validate canonical SKILL.md", () => {
  const target = matchSkillReadTarget(CANONICAL_SKILL);
  assert.ok(target !== null);
  assert.equal(target?.skill, "orchestration");
  assert.ok(
    target?.root.endsWith(".rulesync/skills") ||
      target?.root.endsWith(String.raw`.rulesync\skills`)
  );

  assert.equal(matchSkillReadPath(CANONICAL_SKILL), "orchestration");
  assert.equal(matchSkillReadPath(NON_SKILL), null);
  assert.equal(matchSkillReadPath(null), null);

  // Deeply nested SKILL.md is not a canonical root skill
  const nested = path.join(
    REPO_ROOT,
    ".rulesync",
    "skills",
    "orchestration",
    "references",
    "SKILL.md"
  );
  assert.equal(matchSkillReadPath(nested), null);

  // Curated skills live one level deeper under .rulesync/skills/.curated/<skill>/SKILL.md
  const curatedSkill = path.join(
    REPO_ROOT,
    ".rulesync",
    "skills",
    ".curated",
    "react-best-practices",
    "SKILL.md"
  );
  assert.equal(matchSkillReadPath(curatedSkill), "react-best-practices");
  assert.equal(
    matchSkillReadPath(
      path.join(REPO_ROOT, ".rulesync", "skills", ".curated", "SKILL.md")
    ),
    null
  );
  assert.equal(
    matchSkillReadPath(
      path.join(
        REPO_ROOT,
        ".rulesync",
        "skills",
        ".curated",
        "react-best-practices",
        "rules",
        "SKILL.md"
      )
    ),
    null
  );
});

test("extractSkillReadPath extracts paths across read and exec tool variants", () => {
  // Direct file read tools
  assert.equal(
    extractSkillReadPath("read_file", { file_path: CANONICAL_SKILL }),
    CANONICAL_SKILL
  );
  assert.equal(
    extractSkillReadPath("view_file", { AbsolutePath: CANONICAL_SKILL }),
    CANONICAL_SKILL
  );
  assert.equal(
    extractSkillReadPath("view", { file: CANONICAL_SKILL }),
    CANONICAL_SKILL
  );
  assert.equal(
    extractSkillReadPath("cat_file", { targetFile: CANONICAL_SKILL }),
    CANONICAL_SKILL
  );
  assert.equal(
    extractSkillReadPath("read", { files: [CANONICAL_SKILL] }),
    CANONICAL_SKILL
  );

  // Exec tools with matching skill path
  assert.equal(
    extractSkillReadPath("bash", { command: "cat " + CANONICAL_SKILL }),
    CANONICAL_SKILL
  );
  assert.equal(
    extractSkillReadPath("exec_command", "head -n 50 " + CANONICAL_SKILL),
    CANONICAL_SKILL
  );
  assert.equal(
    extractSkillReadPath("run_command", {
      command: { cmd: "cat " + CANONICAL_SKILL }
    }),
    CANONICAL_SKILL
  );

  // Non-read tool
  assert.equal(
    extractSkillReadPath("write_file", { file_path: CANONICAL_SKILL }),
    null
  );
  assert.equal(
    extractSkillReadPath("edit_file", { path: CANONICAL_SKILL }),
    null
  );
});
