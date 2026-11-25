/**
The routing metadata of the two playtesting skills.

The descriptions are the routing surface: a router reads them to decide
which skill owns a request. The probes below are therefore derived from
the canonical descriptions rather than typed in, so rewording a description
cannot break a test that was only restating it.
*/

import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import test from "node:test";

import { assertReportSections } from "./support/playtesting-sections.ts";
import {
  frontmatterDescription,
  headings,
  splitFrontmatter
} from "./support/skill-document.ts";

const repositoryRoot = new URL("../", import.meta.url);
const collator = new Intl.Collator();

function read(relativePath: string): string {
  return readFileSync(new URL(relativePath, repositoryRoot), "utf8");
}

const gamePlaytesting = splitFrontmatter(
  read(".rulesync/skills/game-playtesting/SKILL.md")
);
const playtestAnalysis = splitFrontmatter(
  read(".rulesync/skills/playtest-analysis/SKILL.md")
);
const gamePlaytestingDescription = frontmatterDescription(
  gamePlaytesting.front
);
const playtestAnalysisDescription = frontmatterDescription(
  playtestAnalysis.front
);

// Each description lists quoted example prompts inside its "Trigger only
// when..." clause specifically so routing can match real user phrasing (per
// the writing-agent-skills guidance to "include likely user terminology").
// Extracting those literal quoted examples from the canonical source text
// and checking substring containment is a deterministic proxy classifier:
// it proves the frontmatter itself carries example phrasing that
// discriminates the required cases. It does not exercise a live model's
// routing decision, which only the running agent can do.
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

function hasTriggerPhrase(prompt: string, examplePhrases: string[]): boolean {
  const lowered = prompt.toLowerCase();
  return examplePhrases.some((phrase) => lowered.includes(phrase));
}

const gamePlaytestingExamples = exampleTriggerPhrases(
  gamePlaytestingDescription
);
const playtestAnalysisExamples = exampleTriggerPhrases(
  playtestAnalysisDescription
);

/**
The quoted examples a body states under its negative-trigger heading.

These are the requests the skill must refuse, so they are read from the
canonical body rather than typed into the test.
*/
function negativeTriggerExamples(body: string): string[] {
  const section = body
    .split(/^#{1,6}[ \t].*negative trigger.*$/imu, 2)[1]
    ?.split(/^#{1,6}[ \t]+/mu, 1)[0];
  assert.ok(section, "the body states a negative-trigger section");
  return Array.from(section.matchAll(/"([^"]+)"/gu), (match) =>
    match[1]?.toLowerCase()
  ).filter(Boolean) as string[];
}

test("game-playtesting and playtest-analysis declare distinct names and triggers", () => {
  assert.match(gamePlaytesting.front, /^name: game-playtesting$/mu);
  assert.match(playtestAnalysis.front, /^name: playtest-analysis$/mu);
  assert.notEqual(gamePlaytestingDescription, playtestAnalysisDescription);
});

test("each playtesting skill routes the requests only it owns", () => {
  // A phrase the two descriptions do not share discriminates them: it has to
  // reach one skill and not the other, so the routing metadata is real.
  const onlyGamePlaytesting = gamePlaytestingExamples.find(
    (phrase) => !playtestAnalysisExamples.includes(phrase)
  );
  assert.ok(
    onlyGamePlaytesting,
    "the two descriptions are not discriminable by their quoted examples"
  );
  assert.equal(hasTriggerPhrase(onlyGamePlaytesting, gamePlaytestingExamples), true);
  assert.equal(
    hasTriggerPhrase(onlyGamePlaytesting, playtestAnalysisExamples),
    false
  );

  const onlyPlaytestAnalysis = playtestAnalysisExamples.find(
    (phrase) => !gamePlaytestingExamples.includes(phrase)
  );
  assert.ok(
    onlyPlaytestAnalysis,
    "the two descriptions are not discriminable by their quoted examples"
  );
  assert.equal(
    hasTriggerPhrase(onlyPlaytestAnalysis, playtestAnalysisExamples),
    true
  );
  assert.equal(
    hasTriggerPhrase(onlyPlaytestAnalysis, gamePlaytestingExamples),
    false
  );
});

test("an ordinary engineering request matches neither playtesting skill", () => {
  // The refusal examples are the canonical ones, so a request a skill names
  // as out of scope must not route to that skill.
  const refusals = negativeTriggerExamples(gamePlaytesting.body);
  assert.ok(refusals.length > 0);
  for (const refusal of refusals) {
    assert.equal(
      hasTriggerPhrase(refusal, gamePlaytestingExamples),
      false,
      `game-playtesting routes a request it refuses: ${refusal}`
    );
  }
  const analysisRefusals = negativeTriggerExamples(playtestAnalysis.body);
  assert.ok(analysisRefusals.length > 0);
  for (const refusal of analysisRefusals) {
    assert.equal(
      hasTriggerPhrase(refusal, playtestAnalysisExamples),
      false,
      `playtest-analysis routes a request it refuses: ${refusal}`
    );
  }
  // A request both skills refuse reaches neither of them.
  const unmatched = refusals.filter(
    (refusal) =>
      !hasTriggerPhrase(refusal, gamePlaytestingExamples) &&
      !hasTriggerPhrase(refusal, playtestAnalysisExamples)
  );
  assert.ok(
    unmatched.length > 0,
    "no request routes to neither playtesting skill"
  );
});

test("game-playtesting explicitly excludes analysis and issue publication from its scope", () => {
  assert.match(gamePlaytestingDescription, /\bnot for\b/i);
  // The scope is stated where routing reads it: the skill's own list of what
  // it does not do. The check is on the scope it states rather than on a
  // heading name, because the section has been renamed as the skill gained
  // its mode separation.
  assert.match(gamePlaytesting.body, /do not use this skill for/i);
  assert.match(gamePlaytesting.body, /playtest-analysis/);
  assert.match(gamePlaytesting.body, /GitHub issue/i);
});

test("playtest-analysis owns the normative 8-step procedure and required report sections", () => {
  const titles = headings(playtestAnalysis.body);
  assert.ok(
    titles.some((title) => /8-step review procedure/i.test(title)),
    "the skill states its review procedure"
  );
  for (let step = 1; step <= 8; step += 1) {
    assert.match(
      playtestAnalysis.body,
      new RegExp(String.raw`^${step}\. `, "mu"),
      `missing step ${step}`
    );
  }
  assert.ok(
    titles.some((title) => /required report sections/i.test(title)),
    "the skill states its required report sections"
  );
  assert.match(playtestAnalysis.body, /playtest\.prepareReview/);
  assert.match(
    playtestAnalysis.body,
    /exact packet ID, packet artifact ID, and SHA-256/
  );
  assertReportSections(playtestAnalysis.body, "playtest-analysis");
});

test("playtest-analysis is null-safe and never creates a GitHub issue directly", () => {
  assert.ok(
    headings(playtestAnalysis.body).some((title) =>
      /null-safe evidence and scores/i.test(title)
    ),
    "the skill states its null-safe scoring rules"
  );
  assert.match(playtestAnalysis.body, /null,? never a mid-scale/i);
  assert.match(playtestAnalysis.body, /never produce a GitHub issue/i);
  assert.match(playtestAnalysis.body, /propose findings\/hypotheses only/i);
});

test("playtest-analysis proposes experiments for root approval instead of running them", () => {
  assert.match(
    playtestAnalysis.body,
    /cannot run it yourself|request execution via the root/i
  );
});

test("human validation stays a conditional reference, not a third skill", () => {
  assert.ok(
    headings(playtestAnalysis.body).some((title) =>
      /human validation/i.test(title)
    ),
    "the skill references human validation conditionally"
  );
  assert.match(playtestAnalysis.body, /not a separate skill/i);
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
  const playtestingSkillDirectories = readdirSync(
    new URL(".rulesync/skills", repositoryRoot)
  ).filter((name) => /playtest|gameplay/i.test(name));
  assert.deepEqual(
    playtestingSkillDirectories.sort((left, right) => collator.compare(left, right)),
    ["game-playtesting", "playtest-analysis"]
  );
});

test("neither new skill duplicates orchestration/delegation policy", () => {
  for (const body of [gamePlaytesting.body, playtestAnalysis.body]) {
    assert.doesNotMatch(body, /spawn_agent/i);
    assert.doesNotMatch(body, /## Delegation/);
    assert.doesNotMatch(
      body,
      /root orchestrator['\u{2019}]s? (?:scheduling|delegation) policy/iu
    );
  }
});
