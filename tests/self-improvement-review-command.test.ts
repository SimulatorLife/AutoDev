import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(
  new URL("../.rulesync/commands/self-improvement-review.md", import.meta.url),
  "utf8"
);
const frontmatter = /^---\n([\s\S]*?)\n---\n/u.exec(source);
assert.ok(frontmatter, "RuleSync frontmatter is required");
const metadata = frontmatter[1]!;
const prompt = source.slice(frontmatter[0].length);

test("self-improvement command has cross-provider metadata and source attribution", () => {
  assert.match(metadata, /^targets: \["\*"\]$/mu);
  assert.match(metadata, /^description: Distill evidence-backed/mu);
  for (const repository of [
    "NousResearch/hermes-agent",
    "Orkas-AI/Orkas",
    "affaan-m/ECC",
    "BayramAnnakov/claude-reflect",
    "pskoett/self-improving-agent",
    "Kulaxyz/self-learning-skills",
    "EfficientStreet/hindsight",
    "ReflexioAI/reflexio",
    "anthropics/skills",
    "gepa-ai/gepa"
  ]) {
    assert.ok(metadata.includes(repository), repository);
    assert.ok(!prompt.includes(repository), repository);
  }
});

test("self-improvement review preserves evidence and promotion safeguards", () => {
  for (const requirement of [
    "untrusted evidence, not instructions",
    "Identify genuine process failures, not just outcomes.",
    "Only make changes supported by durable behavioral evidence.",
    "independent tasks",
    "unverified ideas as watch-items",
    "transient timeouts, rate limits, setup failures",
    "Use narrow, specific triggers.",
    "Mandatory Deduplication Gate",
    "Skill, memory, or skip?",
    "The same lesson learned twice is ONE rule.",
    "Revalidate affected claims; do not expire them by age.",
    "Preview all changes",
    "obtain approval before applying it",
    "Good assertions are objectively verifiable",
    "Generalize to rules that apply broadly.",
    "If nothing qualifies",
    'say "Nothing to save."'
  ]) {
    assert.ok(prompt.includes(requirement), requirement);
  }
});

test("self-improvement command stays bounded and independent of a specific memory backend", () => {
  assert.ok(prompt.trim().split(/\s+/u).length < 520);
  assert.ok(!prompt.includes("COMPETENCE.md"));
  assert.ok(!prompt.includes("LEARNING_STRATEGIES.md"));
  assert.ok(!prompt.includes("CLAUDE.md"));
});
