/**
The OpenTelemetry skill.

The skill is distributed to every provider, so it has to stay portable: it
may not name this repository's stack, and it has to keep the rules that
make an instrumentation review safe. The assertions check the topics the
skill covers rather than the exact wording of its sections.
*/

import assert from "node:assert/strict";
import { lstatSync, readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { userLevelSkills } from "@simulatorlife/autodev-runtime/platform/user-level-skills";

import { headings, splitFrontmatter } from "./support/skill-document.ts";

const repositoryRoot = new URL("../", import.meta.url);
const skillPath = new URL(
  ".rulesync/skills/opentelemetry/SKILL.md",
  repositoryRoot
);
const targetStatePath = new URL(
  "docs/autodev-console-target-state.md",
  repositoryRoot
);

/**
The section of a document that carries a heading.

The section is found by its title rather than by its number, so renumbering
the document does not break the check.
*/
function sectionByTitle(document: string, title: string): string {
  const heading = new RegExp(
    String.raw`^#{1,6}[ \t]+[^\n]*${title}[^\n]*$`,
    "mu"
  ).exec(document);
  if (!heading) return "";
  const rest = document.slice(heading.index + heading[0].length);
  const next = /^#{1,6}[ \t]+/mu.exec(rest);
  return next ? rest.slice(0, next.index) : rest;
}

test("opentelemetry skill is project-independent and retains its current repository projection", () => {
  assert.equal(lstatSync(skillPath).isSymbolicLink(), false);
  const content = readFileSync(skillPath, "utf8");
  const { front, body } = splitFrontmatter(content);

  assert.match(front, /^name: opentelemetry$/mu);
  assert.match(front, /^description:[ \t]*\S/mu);
  // A skill that declares no targets keeps RuleSync's default targets, which
  // reach every projection, so it stays a repository-only skill.
  assert.doesNotMatch(front, /^targets:/mu);

  // Content portability is independent of the current repository-only projection.
  const userLevel = userLevelSkills(
    fileURLToPath(new URL(".rulesync/skills", repositoryRoot))
  );
  assert.ok(!userLevel.includes("opentelemetry"));

  // The skill covers the topics an instrumentation review needs.
  const titles = headings(body);
  assert.ok(
    (body.match(/^##[ \t]/gmu) ?? []).length >= 8,
    "the skill declares its sections"
  );
  for (const topic of [
    /ownership/iu,
    /semantic convention/iu,
    /attribute/iu,
    /instrumentation/iu,
    /quality/iu,
    /collector/iu,
    /review/iu
  ]) {
    assert.ok(
      titles.some((title) => topic.test(title)),
      `the skill declares no section for ${topic.source}`
    );
  }

  // The skill points at the canonical document when one exists and says what
  // to do when none does.
  assert.match(
    body,
    /canonical[^.]*target-state document[^.]*if one exists/isu
  );
  assert.match(body, /If no canonical document exists/iu);
  // The skill stays portable: it names no project, stack, or vendor.
  assert.doesNotMatch(content, /AutoDev|OpenLIT/i);

  // The safety rules of the discipline.
  assert.match(body, /configured receiver/iu);
  assert.match(body, /authorized (?:control plane|owner)/iu);
  assert.match(body, /prefer established[^.]*semantic conventions/isu);
  assert.match(body, /never fabricate an attribute/iu);
});

test("AutoDev's target-state document owns its concrete observability architecture", () => {
  const targetState = readFileSync(targetStatePath, "utf8");
  const authorityLine = targetState
    .split("\n")
    .find((line) => line.startsWith("> **Authority:**"));
  assert.ok(authorityLine, "target doc must declare its authority");
  assert.match(authorityLine, /single living source of truth/i);
  assert.match(authorityLine, /OpenLIT.*fork/i);
  assert.match(authorityLine, /observability/i);
  const canonicalContract = sectionByTitle(
    targetState,
    "Canonical-document contract"
  );
  assert.ok(canonicalContract, "target doc must define its canonical contract");
  assert.match(canonicalContract, /must update this document/i);
  assert.match(canonicalContract, /same PR/i);
  const openLitStrategy = sectionByTitle(
    targetState,
    "OpenLIT maintenance strategy"
  );
  assert.ok(
    openLitStrategy,
    "target doc must define OpenLIT maintenance policy"
  );
  assert.match(openLitStrategy, /upstream/i);
  assert.match(openLitStrategy, /must\s+(?:not|never)\s+block AutoDev/i);

  // Project-specific architecture must not regress to the old local aggregator target.
  assert.match(targetState, /OpenLIT first-party OTLP receiver/);
  assert.match(targetState, /authenticated Control API/);
});
