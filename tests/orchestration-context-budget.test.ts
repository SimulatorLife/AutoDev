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

function minimumAfter(phrase: string): number {
  const match = new RegExp(String.raw`${phrase}[^.]*?at least (\d+)`).exec(
    skill
  );
  assert.ok(match, `skill must set a floor for ${phrase}`);
  return Number(match[1]);
}

// Rollouts from 2026-11-09..11 spent 313M of 1.62B input tokens on empty
// write_stdin polls (222 at 1s yields) and 30s wait_agent loops: each poll
// re-sends the full conversation. These floors keep that from regressing.
test("orchestration skill bounds re-sent context from waiting on children", () => {
  assert.ok(minimumAfter("`timeout_ms`") >= 300_000);
  assert.match(skill, /one `wait_agent` call/);
});

test("orchestration skill bounds re-sent context from polling background commands", () => {
  assert.ok(minimumAfter("`yield_time_ms`") >= 60_000);
});

test("orchestration skill steers unrelated follow-up work to a fresh session", () => {
  assert.match(skill, /fresh session/);
  assert.match(skill, /auto_compact_token_limit/);
});

// Tool results over ~20k characters were 12% of calls but 58% of tool-output
// volume, mostly unscoped `rg`/`cat` dumps re-sent until compaction.
test("orchestration skill scopes reads and searches to the step", () => {
  assert.match(skill, /Scope reads and searches/);
  assert.match(skill, /truncation_policy/);
});
