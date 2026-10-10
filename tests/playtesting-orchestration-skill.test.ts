import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

const skill = readFileSync(
  fileURLToPath(
    new URL("../.rulesync/skills/orchestration/SKILL.md", import.meta.url)
  ),
  "utf8"
);

test("orchestration skill keeps playtest execution, analysis, validation, and publication separate", () => {
  for (const required of [
    "`playtester`",
    "`playtest-analyst`",
    "`validator`",
    "`browser-tester`",
    "Workspace enablement alone is not run approval",
    "The root retains workspace approval, experiment authorization, issue publication, and owner-promotion decisions"
  ]) {
    assert.ok(
      skill.includes(required),
      `missing playtesting handoff: ${required}`
    );
  }
});
