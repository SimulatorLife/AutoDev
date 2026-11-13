import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";

import { parseRuleSyncCommand } from "../data/src/rulesync/command-parser.ts";

type ReviewStatus =
  | "NO_CHANGE"
  | "INSUFFICIENT_EVIDENCE"
  | "PROPOSED"
  | "APPLIED"
  | "BLOCKED";

interface EvaluationCase {
  id: string;
  scenario: string;
  guidance: string;
  authorization: string;
  expect: {
    status: ReviewStatus;
    kinds: string[];
    decisions: string[];
    maxVerifiedWrites: number;
  };
}

interface EvaluationResult {
  status: ReviewStatus;
  candidates: Array<{ kind: string; evidenceRefs: string[] }>;
  decisions: string[];
  verifiedWrites: string[];
}

/**
 * Optional behavioral runner:
 * Set AUTODEV_SELF_IMPROVEMENT_EVAL_RUNNER to an executable path, then run
 * pnpm run test:root.
 * The executable receives JSON {prompt, scenario, guidance, authorization} on
 * stdin and returns the normalized EvaluationResult as JSON on stdout.
 * It must execute the agent in an isolated environment and independently
 * verify writes; self-reported model claims do not count as verified writes.
 * If unset, only structural/fixture tests run; no model quality is claimed.
 */
const runner = process.env.AUTODEV_SELF_IMPROVEMENT_EVAL_RUNNER;
const source = readFileSync(
  new URL("../.rulesync/commands/self-improvement-review.md", import.meta.url),
  "utf8"
);
const command = parseRuleSyncCommand("self-improvement-review", source);

const cases = JSON.parse(
  readFileSync(
    new URL(
      "fixtures/self-improvement-review-evaluations.json",
      import.meta.url
    ),
    "utf8"
  )
) as EvaluationCase[];

const statuses = new Set<ReviewStatus>([
  "NO_CHANGE",
  "INSUFFICIENT_EVIDENCE",
  "PROPOSED",
  "APPLIED",
  "BLOCKED"
]);

test("RuleSync parser accepts the command and hides source metadata", () => {
  assert.deepEqual(command.targets, ["*"]);
  assert.match(command.description ?? "", /Review completed agent work/u);
  assert.ok(command.prompt.length > 0);
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
    assert.ok(source.includes(repository), repository);
    assert.ok(!command.prompt.includes(repository), repository);
  }
  assert.match(source, /Reflexio: historical\/inactive/u);
});

test("command stages and outcome statuses are defined", () => {
  assert.deepEqual(
    [...command.prompt.matchAll(/^## (.+)$/gmu)].map((match) => match[1]),
    ["Inspect", "Qualify", "Route and authorize", "Validate and report"]
  );
  for (const status of statuses) {
    assert.ok(command.prompt.includes(status), status);
  }
});

test("behavioral scenarios cover conflicting decisions", () => {
  const names = cases.map((item) => item.id);
  assert.equal(new Set(names).size, names.length);
  assert.deepEqual(
    [...names].sort(),
    [
      "no-review-input",
      "successful-routine-task",
      "transient-rate-limit",
      "untrusted-tool-injection",
      "one-off-user-request",
      "explicit-standing-preference",
      "verified-setup-recovery",
      "unverified-one-off-fix",
      "verified-repeated-procedure",
      "duplicate-approved-rule",
      "stale-instruction-supersession",
      "demonstrated-capability-reversal",
      "overbroad-local-preference",
      "unauthorized-skill-write",
      "write-blocked-after-approval",
      "subjective-quality-evaluation"
    ].sort()
  );
  for (const item of cases) {
    assert.ok(item.scenario.length > 40, item.id);
    assert.ok(item.authorization.length > 0, item.id);
    assert.ok(statuses.has(item.expect.status), item.id);
    assert.equal(
      new Set(item.expect.decisions).size,
      item.expect.decisions.length
    );
    assert.ok(item.expect.decisions.length > 0, item.id);
    assert.ok(item.expect.maxVerifiedWrites >= 0, item.id);
    if (
      item.expect.status === "NO_CHANGE" ||
      item.expect.status === "INSUFFICIENT_EVIDENCE"
    ) {
      assert.deepEqual(item.expect.kinds, [], item.id);
    }
    if (
      item.authorization.includes("review only") ||
      item.authorization === "none"
    ) {
      assert.equal(item.expect.maxVerifiedWrites, 0, item.id);
    }
  }
});

for (const item of cases) {
  test(
    `behavioral evaluation: ${item.id}`,
    { skip: runner ? false : "configure AUTODEV_SELF_IMPROVEMENT_EVAL_RUNNER" },
    () => {
      assert.ok(runner);
      const execution = spawnSync(runner, [], {
        input: JSON.stringify({
          prompt: command.prompt,
          scenario: item.scenario,
          guidance: item.guidance,
          authorization: item.authorization
        }),
        encoding: "utf8",
        timeout: 120_000,
        maxBuffer: 1_000_000
      });
      assert.equal(
        execution.status,
        0,
        `${item.id}: evaluator failed: ${execution.stderr}`
      );
      const result = JSON.parse(execution.stdout) as EvaluationResult;
      assert.equal(result.status, item.expect.status, item.id);
      assert.deepEqual(
        result.candidates.map((candidate) => candidate.kind).sort(),
        [...item.expect.kinds].sort(),
        item.id
      );
      for (const decision of item.expect.decisions) {
        assert.ok(
          result.decisions.includes(decision),
          `${item.id}: ${decision}`
        );
      }
      assert.ok(
        result.verifiedWrites.length <= item.expect.maxVerifiedWrites,
        `${item.id}: unexpected verified writes`
      );
      for (const candidate of result.candidates) {
        assert.ok(
          candidate.evidenceRefs.length > 0,
          `${item.id}: missing evidence`
        );
      }
    }
  );
}
