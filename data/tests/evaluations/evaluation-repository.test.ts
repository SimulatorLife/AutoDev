import assert from "node:assert/strict";
import test from "node:test";

import { EvaluationRepository } from "../../src/evaluations/evaluation-repository.ts";

test("EvaluationRepository.parseEvaluationRows parses valid ClickHouse evaluation rows", () => {
  const repo = new EvaluationRepository();
  const rawJson = [
    JSON.stringify({
      id: "9b3c5a7f-1234-4567-89ab-cdef01234567",
      span_id: "span-abc",
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
      span_id: "span-def",
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
  assert.ok(results);
  assert.equal(results.length, 2);

  const first = results[0]!;
  assert.equal(first.id, "9b3c5a7f-1234-4567-89ab-cdef01234567");
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

test("EvaluationRepository.parseEvaluationRows skips blank and id-less rows but rejects unreadable output", () => {
  const repo = new EvaluationRepository();
  assert.deepEqual(repo.parseEvaluationRows("\n  \n{}\n"), []);
  assert.equal(repo.parseEvaluationRows("\n{}\nnot-valid-json\n"), null);
  // ClickHouse appends a mid-stream exception as plain text after HTTP 200.
  assert.equal(
    repo.parseEvaluationRows(
      '{"id":"e1","created_at":"2026-10-04 10:00:00"}\nCode: 241. DB::Exception: Memory limit exceeded\n'
    ),
    null
  );
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
  const read = await repo.listEvaluations(50);
  assert.equal(read.status, "available");
  const list = read.status === "available" ? read.evaluations : [];
  assert.equal(list.length, 1);
  assert.equal(list[0]?.id, "uuid-123");
  assert.equal(list[0]?.agentRole, "docs-researcher");
  assert.equal(list[0]?.model, "unknown");
});

test("EvaluationRepository.listEvaluations reports failed reads as unavailable, never as empty", async () => {
  const errorFetch: typeof fetch = async () => {
    return new Response("Table openlit.openlit_evaluation does not exist", {
      status: 404
    });
  };

  const repoError = new EvaluationRepository({ fetchImpl: errorFetch });
  assert.deepEqual(await repoError.listEvaluations(), {
    status: "unavailable",
    message: "ClickHouse rejected the evaluation query with HTTP 404."
  });

  const throwingFetch: typeof fetch = async () => {
    throw new Error("ECONNREFUSED http://user:secret@clickhouse:8123");
  };

  const repoThrowing = new EvaluationRepository({ fetchImpl: throwingFetch });
  const unreachable = await repoThrowing.listEvaluations();
  assert.deepEqual(unreachable, {
    status: "unavailable",
    message: "ClickHouse is unreachable."
  });

  const truncatedFetch: typeof fetch = async () =>
    new Response('{"id":"e1"}\nCode: 241. DB::Exception: Memory limit\n');
  assert.deepEqual(
    await new EvaluationRepository({
      fetchImpl: truncatedFetch
    }).listEvaluations(),
    {
      status: "unavailable",
      message: "ClickHouse returned an unreadable evaluation result."
    }
  );

  const emptyFetch: typeof fetch = async () =>
    new Response("", { status: 200 });
  assert.deepEqual(
    await new EvaluationRepository({ fetchImpl: emptyFetch }).listEvaluations(),
    { status: "available", evaluations: [] }
  );
});

test("EvaluationRepository.listEvaluations abandons an unresponsive ClickHouse within its timeout", async () => {
  // `AbortSignal.timeout` uses an unref'd timer, so the stub holds a handle
  // open while it hangs, as a real request's socket would.
  const hangingFetch: typeof fetch = (_input, init) =>
    new Promise((_resolve, reject) => {
      const socket = setInterval(() => {}, 1000);
      init?.signal?.addEventListener("abort", () => {
        clearInterval(socket);
        reject(init.signal?.reason);
      });
    });
  const repository = new EvaluationRepository({
    fetchImpl: hangingFetch,
    timeoutMs: 25
  });
  const startedAt = performance.now();
  assert.deepEqual(await repository.listEvaluations(), {
    status: "unavailable",
    message: "ClickHouse did not complete the evaluation query within 25ms."
  });
  assert.ok(performance.now() - startedAt < 1000);
});
