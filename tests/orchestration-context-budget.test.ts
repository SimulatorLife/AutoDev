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
  assert.match(skill, /After compaction/);
});

// Tool results over ~20k characters were 12% of calls but 58% of tool-output
// volume, mostly unscoped `rg`/`cat` dumps re-sent until compaction.
test("orchestration skill scopes reads and searches to the step", () => {
  assert.match(skill, /Scope reads and searches/);
});

// Prompt caching bills the re-sent prefix at a fraction of the price, so the
// skill must not claim a repeated request costs as much as new work.
test("orchestration skill states the cost of re-sent context accurately", () => {
  assert.match(skill, /Prompt caching/);
  assert.doesNotMatch(skill, /costs as much as real work/);
});

// Session 01a1e620 spent eight root calls (one 34k chars) on git-history
// archaeology for a two-error lint fix.
test("orchestration skill keeps git history out of the root", () => {
  assert.match(skill, /The root does not read git history/);
  assert.match(skill, /role-sandbox hook/);
});

const readDocument = (relativePath: string): string =>
  readFileSync(
    fileURLToPath(new URL(`../${relativePath}`, import.meta.url)),
    "utf8"
  );

test("root orchestrator bootstrap stays terse and links to canonical F2-F5 references", () => {
  const bootstrap = readDocument("agents/prompts/orchestrator.md");
  assert.ok(bootstrap.length < 3000, `bootstrap is ${bootstrap.length} chars`);
  assert.match(bootstrap, /`max_output_tokens`\s+of 2000 or less/);
  assert.match(bootstrap, /references\/codex-code-mode\.md/);
  assert.match(bootstrap, /`session_id`.*`write_stdin`/);
  assert.match(bootstrap, /indexed CodeGraphContext first/);
  assert.match(bootstrap, /do not re-read files or re-run calls/);
  assert.match(
    bootstrap,
    /proportionate validation \(focused, subsystem, or full\)/
  );
  assert.match(bootstrap, /references\/validation\.md/);
});

test("codex-code-mode reference defines F2 bounded discovery, F3 session_id/write_stdin completion, and F5 CGC/no-redundant-read rules", () => {
  const codeMode = readDocument(
    ".rulesync/skills/orchestration/references/codex-code-mode.md"
  );
  assert.match(codeMode, /Default `max_output_tokens: 2000`/);
  assert.match(codeMode, /Justified exceptions/);
  assert.match(codeMode, /list_indexed_repositories/);
  assert.match(codeMode, /find_code/);
  assert.match(codeMode, /analyze_code_relationships/);
  assert.match(codeMode, /No redundant reads/);
  assert.match(codeMode, /returns a `session_id` without an `exit_code`/);
  assert.match(
    codeMode,
    /tools\.write_stdin\(\{ session_id, yield_time_ms: 60000 \}\)/
  );
  assert.match(codeMode, /until\s+`exit_code` is returned/);
});

test("validation reference defines F4 proportionate validation tiers and repository-state evidence", () => {
  const validation = readDocument(
    ".rulesync/skills/orchestration/references/validation.md"
  );
  assert.match(validation, /## Proportionate validation/);
  assert.match(validation, /\*\*Focused:\*\*/);
  assert.match(validation, /\*\*Subsystem:\*\*/);
  assert.match(validation, /\*\*Full:\*\*/);
  assert.match(validation, /### Repository-state evidence/);
  assert.match(validation, /git rev-parse --short HEAD/);
  assert.match(validation, /git status --short/);
});

test("development-lifecycle reference links Discover and Validate to canonical F2-F5 references", () => {
  const lifecycle = readDocument(
    ".rulesync/skills/orchestration/references/development-lifecycle.md"
  );
  assert.match(
    lifecycle,
    /indexed CodeGraphContext \(`list_indexed_repositories`/
  );
  assert.match(lifecycle, /references\/codex-code-mode\.md/);
  assert.match(
    lifecycle,
    /proportionate validation tiers\s+\(focused, subsystem, full\)/
  );
  assert.match(lifecycle, /references\/validation\.md/);
});
