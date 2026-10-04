import assert from "node:assert/strict";
import test from "node:test";

import {
  AUTODEV_EVALUATION_SOURCE,
  EVALUATION_META,
  EvaluationRepository,
  type EvaluationResultRecord
} from "../../src/evaluations/evaluation-repository.ts";

const CLICKHOUSE = {
  clickhouseUrl: "http://clickhouse.test:8123",
  dbUser: "default",
  dbPassword: "s3cret-password",
  dbName: "openlit"
} as const;

interface CapturedRequest {
  readonly url: URL;
  readonly body: string;
  readonly redirect: RequestRedirect | undefined;
}

function capture(
  respond: (request: CapturedRequest) => Response | Promise<Response>
): { fetchImpl: typeof fetch; requests: CapturedRequest[] } {
  const requests: CapturedRequest[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const request = {
      url: new URL(String(input)),
      body: typeof init?.body === "string" ? init.body : "",
      redirect: init?.redirect
    };
    requests.push(request);
    return respond(request);
  };
  return { fetchImpl, requests };
}

function jsonLines(rows: unknown[]): string {
  return rows.map((row) => JSON.stringify(row)).join("\n");
}

const AUTODEV_ROW = {
  id: "9b3c5a7f-1234-4567-89ab-cdef01234567",
  span_id: "00f067aa0ba902b7",
  created_at: "2026-10-04T12:00:00Z",
  meta: {
    [EVALUATION_META.source]: AUTODEV_EVALUATION_SOURCE,
    [EVALUATION_META.definition]: "worker-regression",
    [EVALUATION_META.revision]: "abc123",
    [EVALUATION_META.run]: "run-1",
    [EVALUATION_META.runStartedAt]: "2026-10-04T11:59:00.000Z",
    [EVALUATION_META.runExpected]: "4",
    [EVALUATION_META.caseId]: "case-1",
    [EVALUATION_META.target]: "agent:worker",
    [EVALUATION_META.agentRole]: "worker",
    [EVALUATION_META.requestModel]: "autodev/worker",
    [EVALUATION_META.responseModel]: "gpt-5.6-terra",
    [EVALUATION_META.judgeModel]: "autodev/validator",
    [EVALUATION_META.traceId]: "4bf92f3577b34da6a3ce929d0e0e4736",
    [`${EVALUATION_META.thresholdPrefix}hallucination`]: "0.5",
    [`${EVALUATION_META.thresholdPrefix}relevance`]: "0.3"
  },
  scores: { hallucination: 0.1, relevance: 0.6 },
  evaluations: ["hallucination", "relevance"],
  classifications: ["none", "off_topic"],
  explanations: ["Grounded.", "Ignores the question."],
  // Stored verdicts are ignored when AutoDev recorded the threshold.
  verdicts: ["yes", "no"]
};

const OPENLIT_ROW = {
  id: "8a2b4c6e-5678-40ab-8def-1234567890ab",
  span_id: "a3ce929d0e0e4736",
  created_at: "2026-10-04T12:05:00Z",
  meta: { source: "auto", model: "openai/gpt-4o-mini" },
  scores: { Hallucination: 0.8, Bias: 0 },
  evaluations: ["Hallucination", "Bias"],
  classifications: ["factual_inaccuracy", "none"],
  explanations: ["Contradicts the context.", "No bias."],
  verdicts: ["yes", "no"]
};

test("listResults binds every filter as a ClickHouse parameter and excludes non-evaluation rows", async () => {
  const { fetchImpl, requests } = capture(
    () => new Response(jsonLines([AUTODEV_ROW]), { status: 200 })
  );
  const repository = new EvaluationRepository({ ...CLICKHOUSE, fetchImpl });
  const read = await repository.listResults(
    { definition: "worker-regression", agent: "worker'; DROP TABLE x;--" },
    5000
  );
  assert.equal(read.status, "available");
  const request = requests[0]!;
  assert.equal(request.redirect, "error");
  assert.equal(request.url.origin, "http://clickhouse.test:8123");
  assert.equal(
    request.url.searchParams.get("param_definition"),
    "worker-regression"
  );
  assert.equal(
    request.url.searchParams.get("param_agent"),
    "worker'; DROP TABLE x;--"
  );
  assert.equal(request.url.searchParams.get("param_limit"), "500");
  assert.equal(request.url.searchParams.get("query"), null);
  assert.ok(!request.body.includes("DROP TABLE"));
  assert.match(request.body, /\{definition:String\}/u);
  assert.match(request.body, /\{agent:String\}/u);
  assert.match(request.body, /NOT IN \('auto_skipped', 'manual_feedback'\)/u);
  assert.match(request.body, /FORMAT JSONEachRow$/u);
});

test("AutoDev rows derive verdicts from recorded thresholds and keep trace linkage", async () => {
  const { fetchImpl } = capture(
    () => new Response(jsonLines([AUTODEV_ROW, OPENLIT_ROW]), { status: 200 })
  );
  const repository = new EvaluationRepository({ ...CLICKHOUSE, fetchImpl });
  const read = await repository.listResults();
  assert.equal(read.status, "available");
  if (read.status !== "available") return;
  const [autodev, openlit] = read.value;

  assert.equal(autodev?.definitionId, "worker-regression");
  assert.deepEqual(autodev?.run, {
    id: "run-1",
    startedAt: "2026-10-04T11:59:00.000Z",
    expectedResults: 4
  });
  assert.deepEqual(autodev?.subject, {
    targetKey: "agent:worker",
    agent: "worker",
    model: "autodev/worker",
    prompt: null
  });
  assert.equal(autodev?.responseModel, "gpt-5.6-terra");
  assert.equal(autodev?.judgeModel, "autodev/validator");
  assert.deepEqual(
    autodev?.metrics.map((metric) => [
      metric.name,
      metric.score,
      metric.threshold,
      metric.verdict
    ]),
    [
      ["hallucination", 0.1, 0.5, "pass"],
      ["relevance", 0.6, 0.3, "fail"]
    ]
  );
  assert.equal(autodev?.outcome, "failed");
  assert.equal(autodev?.traceId, "4bf92f3577b34da6a3ce929d0e0e4736");
  assert.equal(autodev?.spanId, "00f067aa0ba902b7");

  // OpenLIT "yes" means the issue was detected; its `model` meta is the judge.
  assert.deepEqual(
    openlit?.metrics.map((metric) => [metric.name, metric.verdict]),
    [
      ["Hallucination", "fail"],
      ["Bias", "pass"]
    ]
  );
  assert.equal(openlit?.outcome, "failed");
  assert.equal(openlit?.judgeModel, "openai/gpt-4o-mini");
  assert.deepEqual(openlit?.subject, {
    targetKey: null,
    agent: null,
    model: null,
    prompt: null
  });
  assert.equal(openlit?.run, null);
  assert.equal(openlit?.traceId, null);
});

test("results without metrics or verdicts never become passes", async () => {
  const { fetchImpl } = capture(
    () =>
      new Response(
        jsonLines([
          {
            ...OPENLIT_ROW,
            scores: {},
            evaluations: [],
            classifications: [],
            explanations: [],
            verdicts: []
          },
          {
            ...OPENLIT_ROW,
            id: "7a2b4c6e-5678-40ab-8def-1234567890ab",
            verdicts: ["maybe", "no"]
          }
        ]),
        { status: 200 }
      )
  );
  const read = await new EvaluationRepository({
    ...CLICKHOUSE,
    fetchImpl
  }).listResults();
  assert.equal(read.status, "available");
  if (read.status !== "available") return;
  assert.equal(read.value[0]?.outcome, "unknown");
  assert.equal(read.value[1]?.metrics[0]?.verdict, "unknown");
  assert.equal(read.value[1]?.outcome, "unknown");
});

test("store failures and malformed rows fail closed with redacted diagnostics", async () => {
  const failing = new EvaluationRepository({
    ...CLICKHOUSE,
    fetchImpl: async () =>
      new Response(
        "Code: 60. DB::Exception: Table openlit.openlit_evaluation does not exist (password s3cret-password)",
        { status: 404 }
      )
  });
  const failed = await failing.listResults();
  assert.equal(failed.status, "unavailable");
  if (failed.status === "unavailable") {
    assert.match(failed.message, /HTTP 404: Code: 60/u);
    assert.ok(!failed.message.includes("s3cret-password"));
    assert.match(failed.message, /\[REDACTED\]/u);
  }

  const unreachable = await new EvaluationRepository({
    ...CLICKHOUSE,
    fetchImpl: async () => {
      throw new Error("ECONNREFUSED");
    }
  }).listRuns();
  assert.equal(unreachable.status, "unavailable");

  const malformed = await new EvaluationRepository({
    ...CLICKHOUSE,
    fetchImpl: async () =>
      new Response(`${JSON.stringify(AUTODEV_ROW)}\nnot-json\n`, {
        status: 200
      })
  }).listResults();
  assert.deepEqual(malformed, {
    status: "unavailable",
    message: "OpenLIT evaluation store returned a malformed row."
  });

  const missingId = await new EvaluationRepository({
    ...CLICKHOUSE,
    fetchImpl: async () =>
      Response.json({ ...AUTODEV_ROW, id: "" }, { status: 200 })
  }).listResults();
  assert.equal(missingId.status, "unavailable");
});

test("listRuns aggregates stored AutoDev runs with explicit expected counts", async () => {
  const { fetchImpl, requests } = capture(
    () =>
      new Response(
        jsonLines([
          {
            run_id: "run-2",
            definition_id: "worker-regression",
            started_at: "2026-10-04T12:00:00.000Z",
            last_result_at: "2026-10-04T12:03:00Z",
            expected: 4,
            observed: "3",
            passed: "2",
            failed: "1",
            errored: "0",
            unknown: "0"
          },
          {
            run_id: "run-1",
            definition_id: "worker-regression",
            started_at: "",
            last_result_at: "2026-10-03T12:03:00Z",
            expected: 0,
            observed: "1",
            passed: "0",
            failed: "0",
            errored: "1",
            unknown: "0"
          }
        ]),
        { status: 200 }
      )
  );
  const read = await new EvaluationRepository({
    ...CLICKHOUSE,
    fetchImpl
  }).listRuns({ definition: "worker-regression", limit: 10 });
  assert.equal(read.status, "available");
  if (read.status !== "available") return;
  assert.equal(read.value[0]?.observedResults, 3);
  assert.equal(read.value[0]?.expectedResults, 4);
  assert.equal(read.value[1]?.expectedResults, null);
  assert.equal(read.value[1]?.startedAt, null);
  assert.equal(
    requests[0]?.url.searchParams.get("param_definition"),
    "worker-regression"
  );
  assert.equal(requests[0]?.url.searchParams.get("param_source"), "autodev");
  assert.match(requests[0]!.body, /GROUP BY run_id/u);
});

test("getResult and listTraceSpans validate identifiers before querying", async () => {
  const { fetchImpl, requests } = capture(
    () =>
      new Response(
        jsonLines([
          {
            SpanId: "00f067aa0ba902b7",
            ParentSpanId: "",
            SpanName: "autodev.evaluation.case",
            ServiceName: "autodev-router",
            started_at: "2026-10-04T12:00:00Z",
            duration_ns: "2500000",
            status_code: "STATUS_CODE_OK",
            provider: "",
            request_model: "",
            response_model: "",
            input_tokens: "",
            output_tokens: ""
          },
          {
            SpanId: "b7ad6b7169203331",
            ParentSpanId: "00f067aa0ba902b7",
            SpanName: "gen_ai.client_operation",
            ServiceName: "autodev-router",
            started_at: "2026-10-04T12:00:01Z",
            duration_ns: "1000000",
            status_code: "Error",
            provider: "openai",
            request_model: "autodev/worker",
            response_model: "gpt-5.6-terra",
            input_tokens: "120",
            output_tokens: "30"
          }
        ]),
        { status: 200 }
      )
  );
  const repository = new EvaluationRepository({ ...CLICKHOUSE, fetchImpl });

  assert.deepEqual(await repository.getResult("not-a-uuid"), {
    status: "available",
    value: null
  });
  assert.deepEqual(
    await repository.listTraceSpans({ traceId: "nope", spanId: null }),
    { status: "available", value: [] }
  );
  assert.equal(requests.length, 0);

  const spans = await repository.listTraceSpans({
    traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
    spanId: null
  });
  assert.equal(spans.status, "available");
  if (spans.status !== "available") return;
  assert.equal(
    requests[0]?.url.searchParams.get("param_trace"),
    "4bf92f3577b34da6a3ce929d0e0e4736"
  );
  assert.equal(spans.value[0]?.status, "ok");
  assert.equal(spans.value[0]?.parentSpanId, null);
  assert.equal(spans.value[0]?.durationMs, 2.5);
  assert.equal(spans.value[0]?.inputTokens, null);
  assert.equal(spans.value[1]?.status, "error");
  assert.equal(spans.value[1]?.responseModel, "gpt-5.6-terra");
  assert.equal(spans.value[1]?.inputTokens, 120);

  await repository.listTraceSpans({
    traceId: null,
    spanId: "a3ce929d0e0e4736"
  });
  assert.equal(
    requests[1]?.url.searchParams.get("param_span"),
    "a3ce929d0e0e4736"
  );
});

test("insertResults encodes OpenLIT-compatible rows with AutoDev attribution", async () => {
  const { fetchImpl, requests } = capture(
    () => new Response("", { status: 200 })
  );
  const record: EvaluationResultRecord = {
    id: "5f1d3c2b-1234-4567-89ab-cdef01234567",
    createdAt: new Date("2026-10-04T12:00:00.000Z"),
    definitionId: "worker-regression",
    definitionRevision: "abc123",
    runId: "run-1",
    runStartedAt: "2026-10-04T11:59:00.000Z",
    runExpectedResults: 2,
    caseId: "case-1",
    subject: {
      targetKey: "model:gpt-5.6-terra+prompt:dry",
      agent: null,
      model: "gpt-5.6-terra",
      prompt: "dry"
    },
    responseModel: "gpt-5.6-terra",
    judgeModel: "autodev/validator",
    metrics: [
      {
        name: "hallucination",
        score: 0.7,
        threshold: 0.5,
        classification: "unsupported_claim",
        explanation: "Invents a package."
      }
    ],
    error: null,
    spanId: "00f067aa0ba902b7",
    traceId: "4bf92f3577b34da6a3ce929d0e0e4736"
  };
  const repository = new EvaluationRepository({ ...CLICKHOUSE, fetchImpl });
  assert.deepEqual(await repository.insertResults([]), { ok: true });
  assert.equal(requests.length, 0);
  assert.deepEqual(await repository.insertResults([record]), { ok: true });

  const request = requests[0]!;
  assert.match(
    request.url.searchParams.get("query") ?? "",
    /^INSERT INTO openlit_evaluation .* FORMAT JSONEachRow$/u
  );
  const row = JSON.parse(request.body.trim()) as Record<string, unknown>;
  const meta = row.meta as Record<string, string>;
  assert.equal(meta.source, "autodev");
  assert.equal(meta[EVALUATION_META.outcome], "failed");
  assert.equal(meta[EVALUATION_META.prompt], "dry");
  assert.equal(meta[EVALUATION_META.agentRole], undefined);
  assert.equal(meta[`${EVALUATION_META.thresholdPrefix}hallucination`], "0.5");
  assert.equal(meta[EVALUATION_META.traceId], record.traceId);
  assert.deepEqual(row["evaluationData.verdict"], ["yes"]);
  assert.deepEqual(row.scores, { hallucination: 0.7 });
  assert.equal(row.span_id, "00f067aa0ba902b7");

  const errored = await new EvaluationRepository({
    ...CLICKHOUSE,
    fetchImpl: async () =>
      new Response("Code: 241. Memory limit", { status: 500 })
  }).insertResults([{ ...record, metrics: [], error: "judge_unavailable" }]);
  assert.equal(errored.ok, false);
});
