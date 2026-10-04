import assert from "node:assert/strict";
import test from "node:test";

import {
  buildEvaluationCaseMatrix,
  compareEvaluationTargets,
  deriveEvaluationRunStatus,
  EVALUATION_CRITERION_TYPES,
  evaluationCriterionVerdict,
  type EvaluationMetric,
  evaluationOutcome,
  evaluationPassRate,
  type EvaluationResult,
  evaluationTargetKey,
  evaluationTargetModel,
  isEvaluationDefinitionId,
  parseEvaluationDefinition
} from "../src/index.ts";

const VALID_DEFINITION = {
  id: "worker-regression",
  name: "Worker regression",
  description: "Checks worker answers.",
  enabled: true,
  targets: [
    { kind: "agent", id: "worker", prompt: null },
    { kind: "model", id: "gpt-5.6-terra", prompt: "dry" }
  ],
  criteria: [
    { type: "hallucination", threshold: 0.5 },
    { type: "relevance", threshold: 0.3 }
  ],
  cases: [
    { id: "case-1", input: "Summarize the README.", context: null },
    { id: "case-2", input: "List the packages.", context: "core, data" }
  ],
  judge: { model: "autodev/validator" }
};

function metric(
  name: string,
  score: number | null,
  verdict: EvaluationMetric["verdict"]
): EvaluationMetric {
  return {
    name,
    score,
    threshold: 0.5,
    verdict,
    classification: null,
    explanation: null
  };
}

function result(
  id: string,
  runId: string,
  targetKey: string,
  caseId: string,
  metrics: EvaluationMetric[],
  error: string | null = null
): EvaluationResult {
  return {
    id,
    source: "autodev",
    definitionId: "worker-regression",
    definitionRevision: "rev",
    run: { id: runId, startedAt: null, expectedResults: 4 },
    caseId,
    subject: { targetKey, agent: null, model: "m", prompt: null },
    responseModel: null,
    judgeModel: null,
    metrics,
    outcome: evaluationOutcome(metrics, error),
    error,
    spanId: null,
    traceId: null,
    createdAt: "2026-10-04T00:00:00.000Z"
  };
}

test("parseEvaluationDefinition accepts a canonical definition with explicit targets", () => {
  const parsed = parseEvaluationDefinition(VALID_DEFINITION);
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.equal(parsed.definition.id, "worker-regression");
  assert.equal(parsed.definition.targets.length, 2);
  assert.equal(parsed.definition.cases[1]?.context, "core, data");
  assert.equal(
    evaluationTargetKey(parsed.definition.targets[1]!),
    "model:gpt-5.6-terra+prompt:dry"
  );
  assert.equal(
    evaluationTargetModel(parsed.definition.targets[0]!),
    "autodev/worker"
  );
});

test("parseEvaluationDefinition rejects unbounded, ambiguous, and unknown shapes", () => {
  const cases: Array<[string, unknown]> = [
    ["not an object", []],
    ["reserved id", { ...VALID_DEFINITION, id: "results" }],
    ["uppercase id", { ...VALID_DEFINITION, id: "Worker" }],
    ["extra field", { ...VALID_DEFINITION, schedule: "hourly" }],
    ["empty targets", { ...VALID_DEFINITION, targets: [] }],
    [
      "alias model target",
      {
        ...VALID_DEFINITION,
        targets: [{ kind: "model", id: "autodev/worker", prompt: null }]
      }
    ],
    [
      "duplicate target",
      {
        ...VALID_DEFINITION,
        targets: [VALID_DEFINITION.targets[0], VALID_DEFINITION.targets[0]]
      }
    ],
    [
      "unknown criterion",
      {
        ...VALID_DEFINITION,
        criteria: [{ type: "vibes", threshold: 0.5 }]
      }
    ],
    [
      "threshold out of range",
      {
        ...VALID_DEFINITION,
        criteria: [{ type: "bias", threshold: 1.5 }]
      }
    ],
    [
      "oversized input",
      {
        ...VALID_DEFINITION,
        cases: [{ id: "c", input: "x".repeat(4001), context: null }]
      }
    ],
    ["missing judge", { ...VALID_DEFINITION, judge: {} }],
    [
      "serialized definition over the byte bound",
      {
        ...VALID_DEFINITION,
        cases: Array.from({ length: 20 }, (_, index) => ({
          id: `case-${index}`,
          input: "x".repeat(4000),
          context: "y".repeat(4000)
        }))
      }
    ],
    ["reserved console route id", { ...VALID_DEFINITION, id: "new" }],
    ["non-boolean enabled", { ...VALID_DEFINITION, enabled: "yes" }]
  ];
  for (const [label, value] of cases) {
    const parsed = parseEvaluationDefinition(value);
    assert.equal(parsed.ok, false, label);
    if (!parsed.ok) assert.ok(parsed.errors.length > 0, label);
  }
  assert.equal(isEvaluationDefinitionId("runs"), false);
  assert.equal(EVALUATION_CRITERION_TYPES.includes("hallucination"), true);
});

test("criterion verdicts use OpenLIT severity semantics and never synthesize a pass", () => {
  assert.equal(evaluationCriterionVerdict(0.2, 0.5), "pass");
  assert.equal(evaluationCriterionVerdict(0.5, 0.5), "pass");
  assert.equal(evaluationCriterionVerdict(0.51, 0.5), "fail");
  assert.equal(evaluationCriterionVerdict(null, 0.5), "unknown");
  assert.equal(evaluationCriterionVerdict(0.1, null), "unknown");

  assert.equal(evaluationOutcome([], null), "unknown");
  assert.equal(evaluationOutcome([metric("a", 0.1, "pass")], null), "passed");
  assert.equal(
    evaluationOutcome(
      [metric("a", 0.1, "pass"), metric("b", null, "unknown")],
      null
    ),
    "unknown"
  );
  assert.equal(
    evaluationOutcome(
      [metric("a", 0.9, "fail"), metric("b", null, "unknown")],
      null
    ),
    "failed"
  );
  assert.equal(
    evaluationOutcome([metric("a", 0.1, "pass")], "judge_invalid_response"),
    "error"
  );
});

test("pass rate and run status remain unavailable without evidence", () => {
  assert.equal(evaluationPassRate({ passed: 0, failed: 0 }), null);
  assert.equal(evaluationPassRate({ passed: 3, failed: 1 }), 0.75);
  assert.equal(
    deriveEvaluationRunStatus({
      active: true,
      failure: null,
      observedResults: 0,
      expectedResults: 4
    }),
    "running"
  );
  assert.equal(
    deriveEvaluationRunStatus({
      active: false,
      failure: "storage_unavailable",
      observedResults: 0,
      expectedResults: 4
    }),
    "failed"
  );
  assert.equal(
    deriveEvaluationRunStatus({
      active: false,
      failure: null,
      observedResults: 3,
      expectedResults: 4
    }),
    "incomplete"
  );
  assert.equal(
    deriveEvaluationRunStatus({
      active: false,
      failure: null,
      observedResults: 4,
      expectedResults: 4
    }),
    "completed"
  );
  assert.equal(
    deriveEvaluationRunStatus({
      active: false,
      failure: null,
      observedResults: 4,
      expectedResults: null
    }),
    "incomplete"
  );
});

test("compareEvaluationTargets compares targets side by side and run over run", () => {
  const latest = [
    result("l1", "run-2", "agent:worker", "case-1", [
      metric("hallucination", 0.1, "pass")
    ]),
    result("l2", "run-2", "agent:worker", "case-2", [
      metric("hallucination", 0.9, "fail")
    ]),
    result("l3", "run-2", "model:gpt", "case-1", [
      metric("hallucination", 0.2, "pass")
    ]),
    result("l4", "run-2", "model:gpt", "case-2", [], "target_unavailable")
  ];
  const previous = [
    result("p1", "run-1", "agent:worker", "case-1", [
      metric("hallucination", 0.8, "fail")
    ]),
    result("p2", "run-1", "agent:worker", "case-2", [
      metric("hallucination", 0.9, "fail")
    ])
  ];
  const comparisons = compareEvaluationTargets({
    latestRunId: "run-2",
    latest,
    previousRunId: "run-1",
    previous
  });
  assert.deepEqual(
    comparisons.map((entry) => entry.targetKey),
    ["agent:worker", "model:gpt"]
  );
  const worker = comparisons[0]!;
  assert.equal(worker.passRate, 0.5);
  assert.deepEqual(worker.previous, { runId: "run-1", passRate: 0 });
  assert.equal(worker.passRateDelta, 0.5);
  assert.deepEqual(worker.criteria, [
    { name: "hallucination", judged: 2, failed: 1, meanScore: 0.5 }
  ]);
  const model = comparisons[1]!;
  assert.equal(model.errored, 1);
  assert.equal(model.passRate, 1);
  assert.equal(model.previous, null);
  assert.equal(model.passRateDelta, null);

  const matrix = buildEvaluationCaseMatrix("run-2", latest);
  assert.deepEqual(matrix.targetKeys, ["agent:worker", "model:gpt"]);
  assert.equal(matrix.rows.length, 2);
  assert.deepEqual(matrix.rows[1]?.cells["model:gpt"], {
    resultId: "l4",
    outcome: "error",
    worstScore: null
  });
  assert.equal(matrix.rows[0]?.cells["agent:worker"]?.worstScore, 0.1);
});
