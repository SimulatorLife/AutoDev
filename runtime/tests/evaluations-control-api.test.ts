import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { context, propagation } from "@opentelemetry/api";
import { InMemorySpanExporter } from "@opentelemetry/sdk-trace-base";
import {
  evaluationCriterionVerdict,
  type EvaluationDefinition,
  type EvaluationMetric,
  evaluationOutcome,
  type EvaluationResult,
  type EvaluationResultsFilter,
  type EvaluationTraceSpan
} from "@simulatorlife/autodev-core";
import {
  EvaluationDefinitionRepository,
  type EvaluationResultRecord,
  type EvaluationStoreRead
} from "@simulatorlife/autodev-data";

import {
  type EvaluationControlApiDependencies,
  handleEvaluationsControlApiRequest,
  setEvaluationControlApiDependenciesForTests
} from "../src/control-api/evaluations.ts";
import { handleControlApiRequest } from "../src/control-api/index.ts";
import {
  EVALUATION_JUDGE_INSTRUCTIONS,
  EvaluationRunner,
  parseJudgement
} from "../src/evaluations/runner.ts";
import type {
  RoutedResponseRequest,
  RoutedResponseResult
} from "../src/router/routed-responses.ts";
import {
  resetTelemetryExporter,
  setTelemetryExporter
} from "../src/router/telemetry.ts";

const spanExporter = new InMemorySpanExporter();
setTelemetryExporter(spanExporter);
test.after(() => resetTelemetryExporter());

const DEFINITION: EvaluationDefinition = {
  id: "worker-regression",
  name: "Worker regression",
  description: null,
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
    { id: "case-1", input: "Summarize the README.", context: "README text" },
    { id: "case-2", input: "List the packages.", context: null }
  ],
  judge: { model: "autodev/validator" }
};

class ResponseRecorder {
  statusCode = 0;
  headers: Record<string, string | number> = {};
  body = "";
  headersSent = false;
  writableEnded = false;
  private readonly chunks: Buffer[] = [];

  setHeader(name: string, value: string | number): this {
    this.headers[name.toLowerCase()] = value;
    return this;
  }

  writeHead(status: number, headers?: Record<string, string | number>): this {
    this.statusCode = status;
    if (headers) {
      for (const [name, value] of Object.entries(headers))
        this.headers[name.toLowerCase()] = value;
    }
    this.headersSent = true;
    return this;
  }

  write(chunk: string | Buffer): boolean {
    this.chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    return true;
  }

  end(chunk?: string | Buffer): this {
    if (chunk)
      this.chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    this.body = Buffer.concat(this.chunks).toString("utf8");
    this.writableEnded = true;
    return this;
  }

  json(): Record<string, any> {
    return JSON.parse(this.body) as Record<string, any>;
  }
}

function request(
  method: string,
  url: string,
  body?: unknown,
  headers: Record<string, string> = {}
): IncomingMessage {
  const payload =
    body === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify(body));
  return {
    method,
    url,
    headers: {
      host: "127.0.0.1",
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...headers
    },
    socket: { remoteAddress: "127.0.0.1" },
    async *[Symbol.asyncIterator]() {
      if (payload.length > 0) yield payload;
    }
  } as unknown as IncomingMessage;
}

function toResult(record: EvaluationResultRecord): EvaluationResult {
  const metrics: EvaluationMetric[] = record.metrics.map((metric) => ({
    ...metric,
    verdict: evaluationCriterionVerdict(metric.score, metric.threshold)
  }));
  return {
    id: record.id,
    source: "autodev",
    definitionId: record.definitionId,
    definitionRevision: record.definitionRevision,
    run: {
      id: record.runId,
      startedAt: record.runStartedAt,
      expectedResults: record.runExpectedResults
    },
    caseId: record.caseId,
    subject: record.subject,
    responseModel: record.responseModel,
    judgeModel: record.judgeModel,
    metrics,
    outcome: evaluationOutcome(metrics, record.error),
    error: record.error,
    spanId: record.spanId,
    traceId: record.traceId,
    createdAt: record.createdAt.toISOString()
  };
}

class FakeStore {
  records: EvaluationResultRecord[] = [];
  available = true;
  failInserts = false;
  spans: EvaluationTraceSpan[] = [];

  private unavailable<T>(): EvaluationStoreRead<T> {
    return { status: "unavailable", message: "ClickHouse is down." };
  }

  async listResults(
    filter: EvaluationResultsFilter = {},
    limit = 100
  ): Promise<EvaluationStoreRead<EvaluationResult[]>> {
    if (!this.available) return this.unavailable();
    return {
      status: "available",
      value: this.records
        .filter(
          (record) =>
            (!filter.definition || record.definitionId === filter.definition) &&
            (!filter.run || record.runId === filter.run) &&
            (!filter.agent || record.subject.agent === filter.agent) &&
            (!filter.model || record.subject.model === filter.model) &&
            (!filter.prompt || record.subject.prompt === filter.prompt)
        )
        .slice(0, limit)
        .map(toResult)
    };
  }

  async listRuns(options: { definition?: string } = {}) {
    if (!this.available) return this.unavailable<never[]>();
    const byRun = new Map<string, EvaluationResultRecord[]>();
    for (const record of this.records) {
      if (options.definition && record.definitionId !== options.definition)
        continue;
      byRun.set(record.runId, [...(byRun.get(record.runId) ?? []), record]);
    }
    return {
      status: "available" as const,
      value: Array.from(byRun.entries(), ([runId, records]) => {
        const results = records.map(toResult);
        return {
          runId,
          definitionId: records[0]!.definitionId,
          startedAt: records[0]!.runStartedAt,
          lastResultAt: records.at(-1)!.createdAt.toISOString(),
          expectedResults: records[0]!.runExpectedResults,
          observedResults: records.length,
          passed: results.filter((r) => r.outcome === "passed").length,
          failed: results.filter((r) => r.outcome === "failed").length,
          errored: results.filter((r) => r.outcome === "error").length,
          unknown: results.filter((r) => r.outcome === "unknown").length
        };
      })
    };
  }

  async getResult(id: string) {
    if (!this.available) return this.unavailable<EvaluationResult | null>();
    const record = this.records.find((candidate) => candidate.id === id);
    return {
      status: "available" as const,
      value: record ? toResult(record) : null
    };
  }

  async listTraceSpans() {
    if (!this.available) return this.unavailable<EvaluationTraceSpan[]>();
    return { status: "available" as const, value: this.spans };
  }

  async insertResults(records: readonly EvaluationResultRecord[]) {
    if (this.failInserts) return { ok: false as const, message: "down" };
    this.records.push(...records);
    return { ok: true as const };
  }
}

interface Fixture {
  readonly root: string;
  readonly store: FakeStore;
  readonly runner: EvaluationRunner;
  readonly calls: Array<{
    request: RoutedResponseRequest;
    purpose: "target" | "judge";
    traceparent: string | null;
  }>;
  readonly audits: Array<Record<string, unknown>>;
  readonly dependencies: EvaluationControlApiDependencies;
  respond: (
    request: RoutedResponseRequest,
    purpose: "target" | "judge"
  ) => RoutedResponseResult;
  cleanup(): void;
}

function judgeText(scores: Record<string, number>): string {
  return JSON.stringify({
    results: Object.entries(scores).map(([criterion, score]) => ({
      criterion,
      score,
      classification: score > 0.5 ? "Off Topic!" : "none",
      explanation: `Score ${score}.`
    }))
  });
}

function fixture(definitions: readonly EvaluationDefinition[] = []): Fixture {
  const root = mkdtempSync(path.join(tmpdir(), "autodev-eval-control-"));
  mkdirSync(path.join(root, "config", "catalogs"), { recursive: true });
  mkdirSync(path.join(root, "agents", "prompts", "roles"), { recursive: true });
  mkdirSync(path.join(root, ".rulesync", "commands"), { recursive: true });
  writeFileSync(
    path.join(root, "config", "catalogs", "codex-model-catalog.json"),
    JSON.stringify({
      models: [
        { slug: "gpt-5.6-terra" },
        { slug: "autodev/worker" },
        { slug: "autodev/validator" }
      ]
    })
  );
  writeFileSync(
    path.join(root, "agents", "prompts", "roles", "worker.md"),
    "You are the worker role.\n"
  );
  writeFileSync(
    path.join(root, ".rulesync", "commands", "dry.md"),
    "---\ndescription: dry\n---\n\nRemove duplication.\n"
  );
  writeFileSync(
    path.join(root, "config", "evaluations.json"),
    JSON.stringify({ schema: "autodev-evaluations-v1", definitions })
  );
  const store = new FakeStore();
  const calls: Fixture["calls"] = [];
  const audits: Fixture["audits"] = [];
  const state: Fixture = {
    root,
    store,
    calls,
    audits,
    respond: (_request, purpose) =>
      purpose === "target"
        ? { ok: true, text: "An answer.", responseModel: "gpt-5.6-terra" }
        : {
            ok: true,
            text: judgeText({ hallucination: 0.1, relevance: 0.2 }),
            responseModel: null
          },
    runner: undefined as unknown as EvaluationRunner,
    dependencies: undefined as unknown as EvaluationControlApiDependencies,
    cleanup: () => {
      setEvaluationControlApiDependenciesForTests(null);
      rmSync(root, { recursive: true, force: true });
    }
  };
  const runner = new EvaluationRunner({
    createResponse: async (routed, purpose) => {
      const carrier: Record<string, string> = {};
      propagation.inject(context.active(), carrier);
      calls.push({
        request: routed,
        purpose,
        traceparent: carrier.traceparent ?? null
      });
      return state.respond(routed, purpose);
    },
    insertResults: (records) => store.insertResults(records)
  });
  const dependencies: EvaluationControlApiDependencies = {
    repositoryRoot: root,
    definitions: new EvaluationDefinitionRepository(root),
    store,
    runner,
    agentRoles: () => ["worker", "validator"]
  };
  Object.assign(state, { runner, dependencies });
  setEvaluationControlApiDependenciesForTests(dependencies);
  return state;
}

async function call(
  state: Fixture,
  method: string,
  url: string,
  body?: unknown,
  role: "viewer" | "operator" = "operator"
): Promise<ResponseRecorder> {
  const response = new ResponseRecorder();
  const handled = await handleEvaluationsControlApiRequest(
    request(method, url, body),
    response as unknown as ServerResponse,
    new URL(url, "http://127.0.0.1").pathname,
    { actor: "autodev-local", role },
    (event) => state.audits.push({ ...event }),
    state.root
  );
  assert.equal(handled, true);
  return response;
}

test("the Control API dispatches /control/evaluations behind service authentication", async () => {
  const state = fixture([DEFINITION]);
  const saved = process.env.AUTODEV_CONTROL_API_TOKEN;
  process.env.AUTODEV_CONTROL_API_TOKEN = "evaluation-test-token-0123456789";
  try {
    const unauthenticated = new ResponseRecorder();
    await handleControlApiRequest(
      request("GET", "/control/evaluations"),
      unauthenticated as unknown as ServerResponse,
      "/control/evaluations"
    );
    assert.equal(unauthenticated.statusCode, 401);

    const authenticated = new ResponseRecorder();
    await handleControlApiRequest(
      request("GET", "/control/evaluations", undefined, {
        authorization: "Bearer evaluation-test-token-0123456789",
        "x-autodev-actor": "autodev-local"
      }),
      authenticated as unknown as ServerResponse,
      "/control/evaluations"
    );
    assert.equal(authenticated.statusCode, 200);
    assert.equal(authenticated.json().schema, "autodev-control-evaluations-v2");
  } finally {
    if (saved === undefined) delete process.env.AUTODEV_CONTROL_API_TOKEN;
    else process.env.AUTODEV_CONTROL_API_TOKEN = saved;
    state.cleanup();
  }
});

test("collection reports definitions, reference validation, and explicit store availability", async () => {
  const state = fixture([
    DEFINITION,
    {
      ...DEFINITION,
      id: "broken",
      targets: [{ kind: "agent", id: "ghost", prompt: "missing" }],
      judge: { model: "unknown-model" }
    }
  ]);
  try {
    const ok = await call(state, "GET", "/control/evaluations?prompt=dry");
    assert.equal(ok.statusCode, 200);
    const body = ok.json();
    assert.equal(body.catalogStatus, "valid");
    assert.equal(body.resultsStatus, "available");
    assert.deepEqual(body.filter, { prompt: "dry" });
    assert.equal(body.criterionTypes.length, 11);
    const broken = body.definitions.find(
      (entry: any) => entry.definition.id === "broken"
    );
    assert.equal(broken.validation.runnable, false);
    assert.equal(broken.validation.targets[0].status, "unknown_agent");
    assert.equal(broken.validation.judge, "unknown_model");
    const worker = body.definitions.find(
      (entry: any) => entry.definition.id === "worker-regression"
    );
    assert.equal(worker.validation.runnable, true);
    assert.equal(worker.latestRun, null);
    assert.match(worker.revision, /^[0-9a-f]{16}$/u);

    state.store.available = false;
    const down = (await call(state, "GET", "/control/evaluations")).json();
    assert.equal(down.resultsStatus, "unavailable");
    assert.equal(down.resultsMessage, "ClickHouse is down.");
    assert.deepEqual(down.results, []);

    const invalidFilter = await call(
      state,
      "GET",
      "/control/evaluations?sql=select"
    );
    assert.equal(invalidFilter.statusCode, 400);
    assert.equal(
      (await call(state, "GET", "/control/evaluations?limit=9999")).statusCode,
      400
    );
  } finally {
    state.cleanup();
  }
});

test("definition writes are operator-only, validated, resolved, and revision-checked", async () => {
  const state = fixture();
  try {
    const viewer = await call(
      state,
      "PUT",
      "/control/evaluations/worker-regression",
      { definition: DEFINITION, expectedRevision: null },
      "viewer"
    );
    assert.equal(viewer.statusCode, 403);
    assert.equal(state.audits.at(-1)?.reason, "viewer_cannot_mutate");

    const invalid = await call(
      state,
      "PUT",
      "/control/evaluations/worker-regression",
      { definition: { ...DEFINITION, cases: [] }, expectedRevision: null }
    );
    assert.equal(invalid.statusCode, 400);
    assert.equal(
      invalid.json().error.code,
      "autodev_control_api_invalid_evaluation"
    );

    const mismatch = await call(state, "PUT", "/control/evaluations/other", {
      definition: DEFINITION,
      expectedRevision: null
    });
    assert.equal(mismatch.statusCode, 400);

    const unresolved = await call(
      state,
      "PUT",
      "/control/evaluations/worker-regression",
      {
        definition: {
          ...DEFINITION,
          targets: [{ kind: "model", id: "not-in-catalog", prompt: null }]
        },
        expectedRevision: null
      }
    );
    assert.equal(unresolved.statusCode, 422);
    assert.match(unresolved.json().error.message, /unknown_model/u);

    const extraField = await call(
      state,
      "PUT",
      "/control/evaluations/worker-regression",
      { definition: DEFINITION, expectedRevision: null, force: true }
    );
    assert.equal(extraField.statusCode, 400);

    // Definitions within the 128 KiB bound exceed the default 64 KiB body cap.
    const large = await call(state, "PUT", "/control/evaluations/large", {
      definition: {
        ...DEFINITION,
        id: "large",
        cases: Array.from({ length: 12 }, (_, index) => ({
          id: `case-${index}`,
          input: "x".repeat(4000),
          context: "y".repeat(4000)
        }))
      },
      expectedRevision: null
    });
    assert.equal(large.statusCode, 201);

    const created = await call(
      state,
      "PUT",
      "/control/evaluations/worker-regression",
      { definition: DEFINITION, expectedRevision: null }
    );
    assert.equal(created.statusCode, 201);
    const revision = created.json().revision as string;
    assert.equal(state.audits.at(-1)?.outcome, "ok");
    assert.equal(state.audits.at(-1)?.action, "put_evaluation_definition");

    const conflict = await call(
      state,
      "PUT",
      "/control/evaluations/worker-regression",
      { definition: DEFINITION, expectedRevision: null }
    );
    assert.equal(conflict.statusCode, 409);
    assert.equal(
      conflict.json().error.code,
      "autodev_control_api_revision_conflict"
    );

    const updated = await call(
      state,
      "PUT",
      "/control/evaluations/worker-regression",
      {
        definition: { ...DEFINITION, name: "Renamed" },
        expectedRevision: revision
      }
    );
    assert.equal(updated.statusCode, 200);
    assert.equal(updated.json().result, "updated");
    const persisted = JSON.parse(
      readFileSync(path.join(state.root, "config", "evaluations.json"), "utf8")
    ) as { definitions: EvaluationDefinition[] };
    assert.equal(
      persisted.definitions.find((entry) => entry.id === "worker-regression")
        ?.name,
      "Renamed"
    );

    const deleted = await call(
      state,
      "DELETE",
      "/control/evaluations/worker-regression",
      { expectedRevision: updated.json().revision }
    );
    assert.equal(deleted.statusCode, 200);
    assert.equal(deleted.json().result, "deleted");

    const patch = await call(
      state,
      "PATCH",
      "/control/evaluations/worker-regression",
      {}
    );
    assert.equal(patch.statusCode, 405);
    assert.equal(patch.headers.allow, "GET, PUT, DELETE");
    assert.equal(state.audits.at(-1)?.reason, "method_not_allowed");
  } finally {
    state.cleanup();
  }
});

test("runs execute every target and case through the router with trace-linked results", async () => {
  const state = fixture([DEFINITION]);
  try {
    state.respond = (routed, purpose) => {
      if (purpose === "target" && routed.model === "gpt-5.6-terra") {
        return { ok: false, reason: "timeout", status: null };
      }
      return purpose === "target"
        ? { ok: true, text: "An answer.", responseModel: "gpt-5.6-terra" }
        : {
            ok: true,
            text: `\`\`\`json\n${judgeText({ hallucination: 0.7, relevance: 0.1 })}\n\`\`\``,
            responseModel: null
          };
    };
    const accepted = await call(
      state,
      "POST",
      "/control/evaluations/worker-regression/runs",
      { idempotencyKey: "run-key-0001" }
    );
    assert.equal(accepted.statusCode, 202);
    const run = accepted.json().run;
    assert.equal(run.status, "running");
    assert.equal(run.expectedResults, 4);

    const replay = await call(
      state,
      "POST",
      "/control/evaluations/worker-regression/runs",
      { idempotencyKey: "run-key-0001" }
    );
    assert.equal(replay.statusCode, 200);
    assert.equal(replay.json().result, "replayed");
    assert.equal(replay.json().run.runId, run.runId);

    await state.runner.idle();
    assert.equal(state.store.records.length, 4);

    const targetCalls = state.calls.filter(
      (entry) => entry.purpose === "target"
    );
    assert.deepEqual(
      targetCalls.map((entry) => entry.request.model),
      ["autodev/worker", "autodev/worker", "gpt-5.6-terra", "gpt-5.6-terra"]
    );
    assert.equal(
      targetCalls[0]?.request.instructions,
      "You are the worker role."
    );
    assert.equal(targetCalls[2]?.request.instructions, "Remove duplication.");
    assert.deepEqual(targetCalls[0]?.request.input, [
      { role: "user", text: "Summarize the README." }
    ]);
    const judgeCall = state.calls.find((entry) => entry.purpose === "judge")!;
    assert.equal(judgeCall.request.model, "autodev/validator");
    assert.equal(judgeCall.request.instructions, EVALUATION_JUDGE_INSTRUCTIONS);
    assert.equal(judgeCall.request.input[0]?.role, "developer");
    const judgePayload = JSON.parse(judgeCall.request.input[0]!.text) as {
      context: string | null;
      response: string;
    };
    assert.equal(judgePayload.context, "README text");
    assert.equal(judgePayload.response, "An answer.");

    const [first, , failedTarget] = state.store.records;
    assert.equal(first?.error, null);
    assert.deepEqual(
      first?.metrics.map((metric) => [
        metric.name,
        metric.score,
        metric.threshold
      ]),
      [
        ["hallucination", 0.7, 0.5],
        ["relevance", 0.1, 0.3]
      ]
    );
    assert.equal(first?.metrics[0]?.classification, "off_topic");
    assert.equal(first?.subject.targetKey, "agent:worker");
    assert.equal(failedTarget?.error, "target_timeout");
    assert.deepEqual(failedTarget?.metrics, []);
    assert.equal(
      failedTarget?.subject.targetKey,
      "model:gpt-5.6-terra+prompt:dry"
    );

    // Every target and judge request carried the case span's W3C context.
    assert.match(first?.traceId ?? "", /^[0-9a-f]{32}$/u);
    assert.match(
      targetCalls[0]?.traceparent ?? "",
      new RegExp(`^00-${first?.traceId}-${first?.spanId}-`, "u")
    );
    const caseSpans = spanExporter
      .getFinishedSpans()
      .filter((span) => span.name === "autodev.evaluation.case");
    assert.ok(
      caseSpans.some((span) => span.spanContext().spanId === first?.spanId)
    );
    const failedSpan = caseSpans.find(
      (span) => span.spanContext().spanId === failedTarget?.spanId
    );
    assert.equal(failedSpan?.attributes["error.type"], "target_timeout");

    const detail = await call(
      state,
      "GET",
      "/control/evaluations/worker-regression"
    );
    assert.equal(detail.statusCode, 200);
    const body = detail.json();
    assert.equal(body.selectedRunId, run.runId);
    assert.equal(body.runs[0].status, "completed");
    assert.equal(body.runs[0].failed, 2);
    assert.equal(body.runs[0].errored, 2);
    assert.equal(body.runs[0].passRate, 0);
    assert.equal(body.results.length, 4);
    assert.deepEqual(
      body.comparisons.map((entry: any) => [entry.targetKey, entry.errored]),
      [
        ["agent:worker", 0],
        ["model:gpt-5.6-terra+prompt:dry", 2]
      ]
    );
    assert.deepEqual(body.caseMatrix.targetKeys, [
      "agent:worker",
      "model:gpt-5.6-terra+prompt:dry"
    ]);

    state.store.spans = [
      {
        spanId: first!.spanId!,
        parentSpanId: null,
        name: "autodev.evaluation.case",
        serviceName: "autodev-router",
        startedAt: "2026-10-04T12:00:00Z",
        durationMs: 12,
        status: "ok",
        provider: null,
        requestModel: null,
        responseModel: null,
        inputTokens: null,
        outputTokens: null
      }
    ];
    const result = await call(
      state,
      "GET",
      `/control/evaluations/results/${first!.id}`
    );
    assert.equal(result.statusCode, 200);
    assert.equal(result.json().traceStatus, "available");
    assert.equal(result.json().result.outcome, "failed");

    state.store.spans = [];
    assert.equal(
      (
        await call(state, "GET", `/control/evaluations/results/${first!.id}`)
      ).json().traceStatus,
      "not_observed"
    );
    assert.equal(
      (
        await call(
          state,
          "GET",
          "/control/evaluations/results/00000000-0000-4000-8000-000000000000"
        )
      ).statusCode,
      404
    );
    assert.equal(
      (
        await call(
          state,
          "GET",
          "/control/evaluations/worker-regression?run=00000000-0000-4000-8000-000000000000"
        )
      ).statusCode,
      404
    );
  } finally {
    state.cleanup();
  }
});

test("runs fail closed when results cannot be stored and respect enablement", async () => {
  const state = fixture([
    DEFINITION,
    { ...DEFINITION, id: "disabled", enabled: false }
  ]);
  try {
    const disabled = await call(
      state,
      "POST",
      "/control/evaluations/disabled/runs",
      { idempotencyKey: "run-key-0002" }
    );
    assert.equal(disabled.statusCode, 409);
    assert.equal(
      disabled.json().error.code,
      "autodev_control_api_evaluation_disabled"
    );

    const viewer = await call(
      state,
      "POST",
      "/control/evaluations/worker-regression/runs",
      { idempotencyKey: "run-key-0003" },
      "viewer"
    );
    assert.equal(viewer.statusCode, 403);

    state.store.failInserts = true;
    const accepted = await call(
      state,
      "POST",
      "/control/evaluations/worker-regression/runs",
      { idempotencyKey: "run-key-0004" }
    );
    assert.equal(accepted.statusCode, 202);
    await state.runner.idle();
    const summary = state.runner.summaries("worker-regression")[0];
    assert.equal(summary?.status, "failed");
    assert.equal(summary?.failure, "storage_unavailable");
    assert.equal(summary?.observedResults, 0);
    assert.equal(summary?.passRate, null);
    // Execution stopped at the first unstored result.
    assert.equal(
      state.calls.filter((entry) => entry.purpose === "target").length,
      1
    );

    const get = await call(
      state,
      "GET",
      "/control/evaluations/worker-regression/runs"
    );
    assert.equal(get.statusCode, 405);
    assert.equal(get.headers.allow, "POST");
    assert.equal(
      (await call(state, "GET", "/control/evaluations/unknown-id")).statusCode,
      404
    );
    assert.equal(
      (await call(state, "GET", "/control/evaluations/a/b/c")).statusCode,
      404
    );
  } finally {
    state.cleanup();
  }
});

test("parseJudgement accepts only one well-formed entry per configured criterion", () => {
  const definition = { criteria: DEFINITION.criteria };
  assert.deepEqual(
    parseJudgement(
      judgeText({ hallucination: 0, relevance: 1 }),
      definition
    )?.map((metric) => [metric.name, metric.score]),
    [
      ["hallucination", 0],
      ["relevance", 1]
    ]
  );
  for (const text of [
    "not json",
    judgeText({ hallucination: 0.1 }),
    judgeText({ hallucination: 0.1, relevance: 1.5 }),
    judgeText({ hallucination: 0.1, bias: 0.1 }),
    JSON.stringify({ results: [], extra: true }),
    JSON.stringify({
      results: [
        { criterion: "hallucination", score: 0.1, verdict: "no" },
        { criterion: "relevance", score: 0.1 }
      ]
    }),
    `Here you go: ${judgeText({ hallucination: 0, relevance: 0 })}`
  ]) {
    assert.equal(parseJudgement(text, definition), null, text);
  }
});
