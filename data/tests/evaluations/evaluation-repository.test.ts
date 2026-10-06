import assert from "node:assert/strict";
import test from "node:test";

import {
  EvaluationRepository,
  EvaluationSourceUnavailableError
} from "../../src/evaluations/evaluation-repository.ts";

test("EvaluationRepository.parseEvaluationRows parses valid ClickHouse evaluation rows", () => {
  const repo = new EvaluationRepository();
  const rawJson = [
    JSON.stringify({
      id: "9b3c5a7f-1234-4567-89ab-cdef01234567",
      span_id: "0123456789abcdef",
      created_at: "2026-10-04 12:00:00",
      meta: {
        agentRole: "orchestrator",
        promptName: "dry",
        model: "gpt-5.6-terra"
      },
      "evaluationData.evaluation": ["hallucination", "relevance"],
      "evaluationData.classification": ["faithfulness", "quality"],
      "evaluationData.explanation": ["No hallucinations", "Directly relevant"],
      "evaluationData.verdict": ["pass", "pass"],
      scores: {
        hallucination: 0.1,
        relevance: 0.95
      }
    }),
    JSON.stringify({
      id: "8a2b4c6e-5678-90ab-cdef-1234567890ab",
      span_id: "fedcba9876543210",
      created_at: "2026-10-04 12:05:00",
      meta: {
        role: "worker",
        model: "claude-3-5-sonnet"
      },
      "evaluationData.evaluation": ["accuracy"],
      "evaluationData.verdict": ["fail"],
      scores: {
        accuracy: 0.3
      }
    })
  ].join("\n");

  const results = repo.parseEvaluationRows(rawJson);
  assert.equal(results.length, 2);

  const first = results[0]!;
  assert.equal(first.id, "9b3c5a7f-1234-4567-89ab-cdef01234567");
  assert.equal(first.spanId, "0123456789abcdef");
  assert.equal(first.agentRole, "orchestrator");
  assert.equal(first.promptName, "dry");
  assert.equal(first.model, "gpt-5.6-terra");
  assert.equal(first.timestamp, "2026-10-04 12:00:00");
  assert.equal(first.passed, true);
  assert.equal(first.metrics.length, 2);
  assert.deepEqual(first.metrics[0], {
    name: "hallucination",
    value: 0.1,
    pass: true
  });
  assert.deepEqual(first.metrics[1], {
    name: "relevance",
    value: 0.95,
    pass: true
  });

  const second = results[1]!;
  assert.equal(second.id, "8a2b4c6e-5678-90ab-cdef-1234567890ab");
  assert.equal(second.spanId, "fedcba9876543210");
  assert.equal(second.agentRole, "worker");
  assert.equal(second.promptName, undefined);
  assert.equal(second.model, "claude-3-5-sonnet");
  assert.equal(second.passed, false);
  assert.equal(second.metrics.length, 1);
  assert.deepEqual(second.metrics[0], {
    name: "accuracy",
    value: 0.3,
    pass: false
  });
});

test("EvaluationRepository distinguishes empty history from malformed rows", () => {
  const repo = new EvaluationRepository();
  assert.deepEqual(repo.parseEvaluationRows("\n  \n"), []);
  assert.throws(
    () => repo.parseEvaluationRows("not-valid-json"),
    EvaluationSourceUnavailableError
  );
  assert.throws(
    () =>
      repo.parseEvaluationRows(
        [
          JSON.stringify({ id: "valid-row", created_at: "2026-10-04" }),
          "not-valid-json"
        ].join("\n")
      ),
    EvaluationSourceUnavailableError
  );
  assert.throws(
    () => repo.parseEvaluationRows(JSON.stringify({ id: "missing-time" })),
    EvaluationSourceUnavailableError
  );
  assert.throws(
    () =>
      repo.parseEvaluationRows(
        JSON.stringify({
          id: "invalid-meta",
          created_at: "2026-10-04",
          meta: []
        })
      ),
    EvaluationSourceUnavailableError
  );
  assert.throws(
    () =>
      repo.parseEvaluationRows(
        JSON.stringify({
          id: "invalid-span-id",
          created_at: "2026-10-04",
          span_id: 42
        })
      ),
    EvaluationSourceUnavailableError
  );
  assert.throws(
    () =>
      repo.parseEvaluationRows(
        JSON.stringify({
          id: "oversized-span-id",
          created_at: "2026-10-04",
          span_id: "x".repeat(257)
        })
      ),
    EvaluationSourceUnavailableError
  );
});

test("EvaluationRepository does not infer verdicts from scores or missing metrics", () => {
  const repo = new EvaluationRepository();
  const results = repo.parseEvaluationRows(
    [
      JSON.stringify({
        id: "score-without-verdict",
        created_at: "2026-10-04 10:00:00",
        "evaluationData.evaluation": ["quality"],
        scores: { quality: 0.99 }
      }),
      JSON.stringify({
        id: "no-metrics",
        created_at: "2026-10-04 10:01:00"
      })
    ].join("\n")
  );
  assert.equal(results[0]?.metrics[0]?.pass, null);
  assert.equal(results[0]?.passed, null);
  assert.equal(results[1]?.metrics.length, 0);
  assert.equal(results[1]?.passed, null);
});

test("EvaluationRepository reads the documented verdict vocabulary", () => {
  const repo = new EvaluationRepository();
  const rowWithVerdict = (verdict: string) =>
    JSON.stringify({
      id: "verdict-row",
      created_at: "2026-10-04 11:00:00",
      "evaluationData.evaluation": ["quality"],
      "evaluationData.verdict": [verdict],
      scores: { quality: 0.5 }
    });

  // The passing and failing labels now live in two named sets rather than a
  // ternary written out inside a loop, so they are worth pinning one by one.
  // An alias quietly dropped is the kind of change that otherwise surfaces as
  // an unexplained "not observed" on a row an operator cannot explain.
  for (const [verdict, expected] of [
    ["pass", true],
    ["passed", true],
    ["yes", true],
    ["PASS", true],
    ["  pass  ", true],
    ["fail", false],
    ["failed", false],
    ["no", false],
    ["No", false],
    ["maybe", null],
    ["", null]
  ] as const) {
    const label = JSON.stringify(verdict);
    const [result] = repo.parseEvaluationRows(rowWithVerdict(verdict));
    assert.equal(result?.metrics[0]?.pass, expected, `verdict ${label}`);
    assert.equal(result?.passed, expected, `row passed for ${label}`);
  }
});

test("EvaluationRepository.listEvaluations returns parsed rows with custom fetchImpl", async () => {
  const sampleRow = JSON.stringify({
    id: "uuid-123",
    created_at: "2026-10-04 10:00:00",
    meta: { agent: "docs-researcher" },
    scores: { quality: 0.9 }
  });

  const mockFetch: typeof fetch = async (input) => {
    assert.match(
      decodeURIComponent(String(input)),
      /FROM openlit\.openlit_evaluation/
    );
    return new Response(sampleRow, { status: 200 });
  };

  const repo = new EvaluationRepository({ fetchImpl: mockFetch });
  const list = await repo.listEvaluations(50);
  assert.equal(list.length, 1);
  assert.equal(list[0]?.id, "uuid-123");
  assert.equal(list[0]?.agentRole, "docs-researcher");
  assert.equal(list[0]?.model, "unknown");
});

test("EvaluationRepository reports fetch failure and non-ok response as unavailable", async () => {
  const errorFetch: typeof fetch = async () => {
    return new Response("Table openlit.openlit_evaluation does not exist", {
      status: 404
    });
  };

  const repoError = new EvaluationRepository({ fetchImpl: errorFetch });
  await assert.rejects(
    repoError.listEvaluations(),
    EvaluationSourceUnavailableError
  );

  const throwingFetch: typeof fetch = async () => {
    throw new Error("ECONNREFUSED");
  };

  const repoThrowing = new EvaluationRepository({ fetchImpl: throwingFetch });
  await assert.rejects(repoThrowing.listEvaluations(), (error: unknown) => {
    assert.ok(error instanceof EvaluationSourceUnavailableError);
    assert.doesNotMatch(error.message, /ECONNREFUSED/u);
    return true;
  });
});
