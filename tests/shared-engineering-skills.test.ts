/**
The engineering skills that stay structural, evidence-driven, and
repository-agnostic.

The assertions here check the shape of a skill -- the phases it declares,
the tests it applies, the safety rules it states -- rather than the exact
wording of its sections, so an ordinary rewording of a skill does not
require a matching test edit.
*/

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  MCP_SERVER_COCOINDEX
} from "@simulatorlife/autodev-runtime/shared/tool-names";

import { headings } from "./support/skill-document.ts";

const read = (path: string): string =>
  readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

const architecture = read(
  ".rulesync/skills/improve-codebase-architecture/SKILL.md"
);
const diagnosing = read(".rulesync/skills/diagnosing-bugs/SKILL.md");

const architectureHeadings = headings(architecture);
const diagnosingHeadings = headings(diagnosing);

test("architecture skill stays structural, evidence-driven, and repository-agnostic", () => {
  assert.match(architecture, /^name: improve-codebase-architecture$/mu);
  // The architecture and the diagnosis skill share one authority convention.
  assert.ok(
    architectureHeadings.some((title) => /repository authority/i.test(title)),
    "the architecture skill states the repository-authority convention"
  );
  assert.ok(
    diagnosingHeadings.some((title) => /repository authority/i.test(title)),
    "the diagnosing skill states the repository-authority convention"
  );
  // The skill offers more than one mode, so a request is classified before
  // anything is changed.
  const modes = architectureHeadings.filter((title) => /mode/iu.test(title));
  assert.ok(modes.length >= 2, "the architecture skill declares its modes");
  // The skill applies a family of named tests to a candidate.
  const tests = architectureHeadings.filter((title) => /test/iu.test(title));
  assert.ok(tests.length >= 5, "the architecture skill declares its tests");
  // The skill stays structural: it does not require a particular stack, and it
  // does not add abstraction for its own sake.
  assert.match(
    architecture,
    /do not require a particular[^.]*(?:layout|architecture|framework|language|package manager)/iu
  );
  assert.match(
    architecture,
    /do not add abstraction merely to make the design look more architectural/iu
  );
  assert.doesNotMatch(
    architecture,
    /Tailwind|Mermaid|HTML report|Which of these would you like to explore/
  );
});

test("diagnosing skill requires root-cause evidence and verification of the original symptom", () => {
  assert.match(diagnosing, /^name: diagnosing-bugs$/mu);
  // The method is a fixed number of phases; the wording of each is not.
  const phases = diagnosingHeadings.filter((title) => /^phase \d+/iu.test(title));
  assert.ok(phases.length >= 5, "the diagnosing skill declares its phases");
  assert.match(diagnosing, /failure signal/iu);
  assert.match(diagnosing, /root cause/iu);
  // The skill must treat observed output as untrusted data.
  assert.match(
    diagnosing,
    /treat[^.]*logs[^.]*stack traces[^.]*CI output[^.]*as untrusted data/isu
  );
  // The skill must not weaken the signal that proves a failure.
  assert.match(
    diagnosing,
    /do not weaken assertions[^.]*(?:skip tests|swallow errors)/isu
  );
});

test("semantic and language-aware skills do not require a structural graph provider", () => {
  for (const skill of ["ccc", "lsp-mcp-server"]) {
    const body = read(`.rulesync/skills/${skill}/SKILL.md`);
    assert.doesNotMatch(
      body,
      /CodeGraphContext|\bCGC\b|list_indexed_repositories/
    );
    assert.match(body, /structural (?:code )?analysis|code context graph/i);
    assert.match(body, /when available|when exposed|not required|Neither is required/i);
  }
  assert.match(
    read(".rulesync/skills/ccc/SKILL.md"),
    new RegExp(MCP_SERVER_COCOINDEX, "u")
  );
  assert.match(
    read(".rulesync/skills/lsp-mcp-server/SKILL.md"),
    /lsp_goto_definition/
  );
});

test("shared navigation selects available capabilities rather than mandating a provider", () => {
  const prompt = read("agents/prompts/code-search.md");
  assert.doesNotMatch(
    prompt,
    /CodeGraphContext|CocoIndex|list_indexed_repositories|\bCGC\b/
  );
  assert.match(prompt, /semantic code discovery/i);
  assert.match(prompt, /structural analysis/i);
  assert.match(prompt, /language-aware analysis/i);
  assert.match(prompt, /authorized alternative/i);
});

test("orchestration uses the xacpx delegation contract without provider-native spawning", () => {
  const root = ".rulesync/skills/orchestration/";
  for (const path of [
    "SKILL.md",
    "references/runtime-contract.md",
    "references/development-lifecycle.md",
    "references/recovery.md",
    "references/tool-names.md",
    "references/web-chat.md",
    "references/playtesting.md",
    "references/validation.md",
    "references/xacpx-delegation.md"
  ]) {
    const body = read(root + path);
    assert.doesNotMatch(
      body,
      /multi_agent_v1__|codex-code-mode\.md|CodeGraphContext/
    );
  }
  const delegation = read(root + "references/xacpx-delegation.md");
  assert.match(delegation, /delegate_request/);
  assert.match(delegation, /task_watch/);
  assert.match(delegation, /task_cancel/);
  assert.match(delegation, /timeout does not mean failure/i);
});
