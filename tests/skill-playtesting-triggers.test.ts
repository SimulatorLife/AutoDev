import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import test from "node:test";

const repositoryRoot = new URL("../", import.meta.url);

function read(relativePath: string): string {
  return readFileSync(new URL(relativePath, repositoryRoot), "utf8");
}

function splitFrontmatter(text: string): [string, string] {
  const match = /^---\n(?<front>[\s\S]*?)\n---\n(?<body>[\s\S]*)$/u.exec(text);
  assert.ok(
    match?.groups?.front !== undefined && match.groups.body !== undefined,
    "missing skill frontmatter"
  );
  return [match.groups.front, match.groups.body.replaceAll(/^\n+|\n+$/gu, "")];
}

function description(frontmatter: string): string {
  const match = /^description:[ \t]*(?<value>\S.*)$/mu.exec(frontmatter);
  assert.ok(match?.groups?.value, "missing skill description");
  return match.groups.value.trim();
}

const [gamePlaytestingFront, gamePlaytestingBody] = splitFrontmatter(
  read(".rulesync/skills/game-playtesting/SKILL.md")
);
const [playtestAnalysisFront, playtestAnalysisBody] = splitFrontmatter(
  read(".rulesync/skills/playtest-analysis/SKILL.md")
);
const gamePlaytestingDescription = description(gamePlaytestingFront);
const playtestAnalysisDescription = description(playtestAnalysisFront);

test("game-playtesting and playtest-analysis declare distinct names and triggers", () => {
  assert.match(gamePlaytestingFront, /^name: game-playtesting$/mu);
  assert.match(playtestAnalysisFront, /^name: playtest-analysis$/mu);
  assert.notEqual(gamePlaytestingDescription, playtestAnalysisDescription);
});

// Each description lists quoted example prompts inside its "Trigger only
// when..." clause specifically so routing can match real user phrasing (per
// the writing-agent-skills guidance to "include likely user terminology").
// Extracting those literal quoted examples from the canonical source text
// and checking substring containment is a deterministic proxy classifier:
// it proves the frontmatter itself carries example phrasing that
// discriminates the three required cases. It does not exercise a live
// model's routing decision, which only the running agent can do.
function exampleTriggerPhrases(descriptionText: string): string[] {
  const phrases = Array.from(descriptionText.matchAll(/"([^"]+)"/gu), (match) =>
    match[1]?.toLowerCase()
  ).filter(Boolean) as string[];
  assert.ok(
    phrases.length > 0,
    "description must include quoted trigger examples"
  );
  return phrases;
}

function matchesTrigger(prompt: string, examplePhrases: string[]): boolean {
  const lowered = prompt.toLowerCase();
  return examplePhrases.some((phrase) => lowered.includes(phrase));
}

const gamePlaytestingExamples = exampleTriggerPhrases(
  gamePlaytestingDescription
);
const playtestAnalysisExamples = exampleTriggerPhrases(
  playtestAnalysisDescription
);

test("positive trigger: 'play ten episodes' matches game-playtesting, not playtest-analysis", () => {
  const prompt = "play ten episodes of the target game";
  assert.equal(matchesTrigger(prompt, gamePlaytestingExamples), true);
  assert.equal(matchesTrigger(prompt, playtestAnalysisExamples), false);
});

test("positive trigger: 'analyze this existing trace' matches playtest-analysis, not game-playtesting", () => {
  const prompt =
    "analyze this existing trace and explain why the player got confused";
  assert.equal(matchesTrigger(prompt, playtestAnalysisExamples), true);
  assert.equal(matchesTrigger(prompt, gamePlaytestingExamples), false);
});

test("negative trigger: 'fix this code' matches neither skill", () => {
  const prompt = "fix this code so the build passes";
  assert.equal(matchesTrigger(prompt, gamePlaytestingExamples), false);
  assert.equal(matchesTrigger(prompt, playtestAnalysisExamples), false);
});

test("game-playtesting explicitly excludes analysis and issue publication from its scope", () => {
  assert.match(gamePlaytestingDescription, /[Nn]ot for analyzing, scoring/);
  assert.match(gamePlaytestingBody, /## Non-goals/);
  assert.match(gamePlaytestingBody, /playtest-analysis/);
  assert.match(gamePlaytestingBody, /GitHub issue/);
});

test("playtest-analysis owns the normative 8-step procedure and required report sections", () => {
  assert.match(playtestAnalysisBody, /## The 8-step review procedure/);
  for (let step = 1; step <= 8; step += 1) {
    assert.match(
      playtestAnalysisBody,
      new RegExp(String.raw`^${step}\. `, "mu"),
      `missing step ${step}`
    );
  }
  assert.match(playtestAnalysisBody, /## Required report sections/);
  for (const section of [
    "provenance/coverage",
    "chronological episode summary",
    "authoritative metrics",
    "scored experience dimensions",
    "evidence-linked observations",
    "alternative explanations",
    "cross-session context",
    "testable hypotheses/experiments",
    "evidence-status decision",
    "suggested follow-up"
  ]) {
    assert.match(playtestAnalysisBody, new RegExp(section, "iu"), section);
  }
});

test("playtest-analysis is null-safe and never creates a GitHub issue directly", () => {
  assert.match(playtestAnalysisBody, /## Null-safe evidence and scores/);
  assert.match(playtestAnalysisBody, /null, never a mid-scale category/);
  assert.match(playtestAnalysisBody, /Never produce a GitHub issue directly/);
  assert.match(playtestAnalysisBody, /propose findings\/hypotheses only/i);
});

test("playtest-analysis proposes experiments for root approval instead of running them", () => {
  assert.match(
    playtestAnalysisBody,
    /Request execution via the root; you cannot run it yourself/
  );
});

test("human validation stays a conditional reference, not a third skill", () => {
  assert.match(playtestAnalysisBody, /## Human validation \(conditional\)/);
  assert.match(playtestAnalysisBody, /not a separate skill/);
  assert.equal(
    existsSync(
      new URL(
        ".rulesync/skills/playtest-analysis/references/human-validation.md",
        repositoryRoot
      )
    ),
    true
  );
  // No third overlapping skill directory (e.g. a standalone gameplay-critic
  // or human-validation skill) exists alongside the two target skills.
  const playtestingSkillDirs = readdirSync(
    new URL(".rulesync/skills", repositoryRoot)
  ).filter((name) => /playtest|gameplay/i.test(name));
  assert.deepEqual(playtestingSkillDirs.sort(), [
    "game-playtesting",
    "playtest-analysis"
  ]);
});

test("neither new skill duplicates orchestration/delegation policy", () => {
  for (const body of [gamePlaytestingBody, playtestAnalysisBody]) {
    assert.doesNotMatch(body, /spawn_agent/i);
    assert.doesNotMatch(body, /## Delegation/);
    assert.doesNotMatch(
      body,
      /root orchestrator['\u2019]s? (?:scheduling|delegation) policy/i
    );
  }
});
