import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path: string): string => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

const installer = read("scripts/install.sh");
const materializer = read("src/platform/install-materializer.ts");
const skill = read(".rulesync/skills/resolve-merge-conflicts/SKILL.md");
const helper = read(".rulesync/skills/resolve-merge-conflicts/scripts/extract_conflict_context.py");
const notices = read(".rulesync/skills/resolve-merge-conflicts/THIRD_PARTY_NOTICES.md");

test("resolve-merge-conflicts is installed as a user-level skill", () => {
  assert.match(materializer, /code-simplification/);
  assert.match(materializer, /resolve-merge-conflicts/);
  assert.match(materializer, /userSkills/);
});

test("merge conflict skill uses the compact extractor before full-file inspection", () => {
  assert.match(skill, /## Compact Conflict Context First/);
  assert.match(skill, /\$HOME\/\.agents\/skills\/resolve-merge-conflicts\/scripts\/extract_conflict_context\.py/);
  assert.match(skill, /--file path\/to\/file/);
  assert.match(skill, /--all/);
  assert.match(skill, /--json/);
  assert.match(skill, /--context 3/);
  assert.match(skill, /--max-lines 60/);
  assert.match(skill, /diagnostic only/);
  assert.match(skill, /git diff --name-only --diff-filter=U/);
});

test("bundled conflict helper extracts index and marker context without resolving files", () => {
  assert.match(helper, /run_git\(repo_root, "ls-files", "-u", "-z"\)/);
  assert.match(helper, /def parse_conflict_hunks/);
  assert.match(helper, /def build_index_preview/);
  assert.match(helper, /--repo/);
  assert.match(helper, /--file/);
  assert.match(helper, /--all/);
  assert.match(helper, /--json/);
  assert.match(helper, /--context/);
  assert.match(helper, /--max-lines/);
  assert.doesNotMatch(helper, /\["git",[^\n]*(?:add|checkout|merge|rebase|cherry-pick)/);
});

test("Warp helper license notice is retained", () => {
  assert.match(notices, /MIT License/);
  assert.match(notices, /Copyright \(c\) 2026 Denver Technologies, Inc\./);
  assert.match(notices, /warpdotdev\/common-skills/);
});
