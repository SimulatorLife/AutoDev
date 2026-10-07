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
    const query = decodeURIComponent(String(input));
    // The read issues two statements against one table: the rows, and the count
    // of everything the table holds. Answering both is what lets a caller tell a
    // bounded window from the whole history.
    if (/COUNT\(\*\)/u.test(query)) {
      return new Response(JSON.stringify({ total: "1" }), { status: 200 });
    }
    assert.match(query, /FROM openlit\.openlit_evaluation/);
    return new Response(sampleRow, { status: 200 });
  };

  const repo = new EvaluationRepository({ fetchImpl: mockFetch });
  const page = await repo.listEvaluations(50);
  assert.equal(page.results.length, 1);
  assert.equal(page.total, 1);
  assert.equal(page.results[0]?.id, "uuid-123");
  assert.equal(page.results[0]?.agentRole, "docs-researcher");
  assert.equal(page.results[0]?.model, "unknown");
});

test("EvaluationRepository reports the table's own size, not the size of the window", async () => {
  // The read is capped. A page that reported `results.length` as the total would
  // tell a caller the table holds 2 evaluations when it holds 5,000, and the
  // consumer of that number has no way to recover the difference.
  const rows = [
    JSON.stringify({
      id: "uuid-1",
      created_at: "2026-10-04 10:00:00",
      meta: { agent: "worker" }
    }),
    JSON.stringify({
      id: "uuid-2",
      created_at: "2026-10-04 09:00:00",
      meta: { agent: "worker" }
    })
  ].join("\n");

  const mockFetch: typeof fetch = async (input) => {
    const query = decodeURIComponent(String(input));
    if (/COUNT\(\*\)/u.test(query)) {
      return new Response(JSON.stringify({ total: "5000" }), { status: 200 });
    }
    return new Response(rows, { status: 200 });
  };

  const repo = new EvaluationRepository({ fetchImpl: mockFetch });
  const page = await repo.listEvaluations(2);
  assert.equal(page.results.length, 2);
  assert.equal(page.total, 5000);
});

test("EvaluationRepository fails the read rather than reporting an unreadable count as zero", async () => {
  // Zero is a claim -- "this table holds no evaluations" -- and a count that
  // cannot be parsed is no such claim. Defaulting would turn a broken count into
  // a page asserting an empty store while rows sit right above it.
  for (const body of [
    "",
    "not json",
    JSON.stringify({ total: "many" }),
    JSON.stringify({ rows: "1" })
  ]) {
    const mockFetch: typeof fetch = async (input) => {
      const query = decodeURIComponent(String(input));
      if (/COUNT\(\*\)/u.test(query)) {
        return new Response(body, { status: 200 });
      }
      return new Response("", { status: 200 });
    };
    const repo = new EvaluationRepository({ fetchImpl: mockFetch });
    await assert.rejects(
      repo.listEvaluations(),
      EvaluationSourceUnavailableError,
      `count body ${JSON.stringify(body)} must not read as a total`
    );
  }
});

test("EvaluationRepository never reports a total below the rows it returned", async () => {
  // The two statements are separate reads of one table, so a write between them
  // can make the count smaller than the rows already in hand. The rows are the
  // smaller, truthful number to report.
  const rows = JSON.stringify({
    id: "uuid-1",
    created_at: "2026-10-04 10:00:00",
    meta: { agent: "worker" }
  });

  const mockFetch: typeof fetch = async (input) => {
    const query = decodeURIComponent(String(input));
    if (/COUNT\(\*\)/u.test(query)) {
      return new Response(JSON.stringify({ total: "0" }), { status: 200 });
    }
    return new Response(rows, { status: 200 });
  };

  const repo = new EvaluationRepository({ fetchImpl: mockFetch });
  const page = await repo.listEvaluations();
  assert.equal(page.results.length, 1);
  assert.equal(page.total, 1);
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

test("EvaluationRepository refuses a score that is not a finite number", () => {
  // The repository refuses the whole read when a score is not a finite number,
  // and until now no test fed it one. Both of its branches are reachable from
  // what ClickHouse sends: `typeof value !== "number"` fires on a score stored
  // or written as a string, a boolean or null, and `!Number.isFinite(value)`
  // fires on an overflowing JSON number -- `1e400` is valid JSON and
  // `JSON.parse` turns it into Infinity, which is how a Float64 that has run
  // past its range reaches this code as something that is *not* refused for
  // being unparseable.
  //
  // Without these, deleting the guard is invisible: every other test feeds a
  // well-formed score, so a repository that passed NaN, Infinity and "0.9"
  // straight through to a metric cell would pass the file.
  const repo = new EvaluationRepository();
  // Written by hand rather than through `JSON.stringify`: `JSON.stringify`
  // turns Infinity into null and NaN into null, so serialising the very values
  // under test would produce a fixture that does not contain them.
  const rowWithScore = (scoreLiteral: string): string =>
    [
      '{"id":"9b3c5a7f-1234-4567-89ab-cdef01234567",',
      '"span_id":"0123456789abcdef",',
      '"created_at":"2026-10-04 12:00:00",',
      '"evaluationData.evaluation":["quality"],',
      '"evaluationData.verdict":["pass"],',
      `"scores":{"quality":${scoreLiteral}}}`
    ].join("");

  // The positive control first, so a version that refuses everything cannot
  // pass this file by accident.
  const accepted = repo.parseEvaluationRows(rowWithScore("0.9"));
  assert.equal(accepted.length, 1);
  assert.deepEqual(accepted[0]?.metrics[0], {
    name: "quality",
    value: 0.9,
    pass: true
  });

  for (const [label, literal] of [
    ["a JSON number past the finite range", "1e400"],
    ["a negative overflow", "-1e400"],
    ["a string", '"0.9"'],
    ["an empty string", '""'],
    ["a boolean", "true"],
    ["null", "null"]
  ] as const) {
    assert.throws(
      () => repo.parseEvaluationRows(rowWithScore(literal)),
      EvaluationSourceUnavailableError,
      `${label} is refused rather than becoming a metric cell`
    );
  }

  // And the reason the message must not leak the value: it is the only place
  // an operator learns the read failed rather than that a score was zero.
  assert.throws(
    () => repo.parseEvaluationRows(rowWithScore("1e400")),
    (error: unknown) => {
      assert.ok(error instanceof EvaluationSourceUnavailableError);
      assert.doesNotMatch(error.message, /1e400/u);
      return true;
    }
  );
});
