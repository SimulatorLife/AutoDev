import assert from "node:assert/strict";
import test from "node:test";

import {
  type ControlApiEvaluationDetailResponse,
  type ControlApiEvaluationResultResponse,
  type ControlApiEvaluationsResponse,
  EVALUATION_CRITERION_TYPES,
  type EvaluationDefinition,
  type EvaluationResult,
  LOCAL_CONTROL_API_ACTOR
} from "@simulatorlife/autodev-core";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { EvaluationDetailView, EvaluationsView } from "../src/index.ts";
import {
  type ControlApiResult,
  fetchEvaluationDetail,
  fetchEvaluations,
  mutateControlApi
} from "../src/lib/server/control-api.ts";
import {
  createEvaluationForm,
  type EvaluationActionDependencies,
  handleEvaluationAction,
  verifyEvaluationFormToken
} from "../src/lib/server/evaluation-actions.ts";
import {
  evaluationFilterFromSearchParams,
  evaluationNoticeFromSearchParams
} from "../src/lib/server/evaluation-pages.ts";
import { isSameOriginRequest } from "../src/lib/server/request-guards.ts";

const CONFIG = {
  baseUrl: "http://127.0.0.1:4101",
  serviceToken: "test-token-123"
} as const;
const HOST = "127.0.0.1:3300";
const ORIGIN = `http://${HOST}`;
/** Next.js reports its own bound hostname in request.url, not the browser's host. */
const SERVER_URL = "http://localhost:3300";

const DEFINITION: EvaluationDefinition = {
  id: "worker-regression",
  name: "Worker regression",
  description: "Checks worker answers.",
  enabled: true,
  targets: [
    { kind: "agent", id: "worker", prompt: null },
    { kind: "model", id: "gpt-5.6-terra", prompt: "dry" }
  ],
  criteria: [{ type: "hallucination", threshold: 0.5 }],
  cases: [{ id: "case-1", input: "Summarize the README.", context: null }],
  judge: { model: "autodev/validator" }
};

const RESULT: EvaluationResult = {
  id: "9b3c5a7f-1234-4567-89ab-cdef01234567",
  source: "autodev",
  definitionId: "worker-regression",
  definitionRevision: "0123456789abcdef",
  run: {
    id: "11111111-2222-4333-8444-555555555555",
    startedAt: "2026-10-04T12:00:00.000Z",
    expectedResults: 2
  },
  caseId: "case-1",
  subject: {
    targetKey: "agent:worker",
    agent: "worker",
    model: "autodev/worker",
    prompt: null
  },
  responseModel: "gpt-5.6-terra",
  judgeModel: "autodev/validator",
  metrics: [
    {
      name: "hallucination",
      score: 0.8,
      threshold: 0.5,
      verdict: "fail",
      classification: "unsupported_claim",
      explanation: "Invents a package."
    }
  ],
  outcome: "failed",
  error: null,
  spanId: "00f067aa0ba902b7",
  traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
  createdAt: "2026-10-04T12:00:05Z"
};

const UNATTRIBUTED: EvaluationResult = {
  ...RESULT,
  id: "8a2b4c6e-5678-40ab-8def-1234567890ab",
  source: "auto",
  definitionId: null,
  definitionRevision: null,
  run: null,
  caseId: null,
  subject: { targetKey: null, agent: null, model: null, prompt: null },
  metrics: [],
  outcome: "unknown",
  spanId: null,
  traceId: null
};

function collection(
  overrides: Partial<ControlApiEvaluationsResponse> = {}
): ControlApiEvaluationsResponse {
  return {
    schema: "autodev-control-evaluations-v2",
    definitionsSource: "config/evaluations.json",
    catalogStatus: "valid",
    catalogErrors: [],
    definitions: [
      {
        definition: DEFINITION,
        revision: "0123456789abcdef",
        validation: {
          runnable: false,
          judge: "resolved",
          targets: [
            {
              key: "agent:worker",
              target: DEFINITION.targets[0]!,
              status: "resolved"
            },
            {
              key: "model:gpt-5.6-terra+prompt:dry",
              target: DEFINITION.targets[1]!,
              status: "unknown_prompt"
            }
          ]
        },
        latestRun: null
      }
    ],
    criterionTypes: EVALUATION_CRITERION_TYPES,
    resultsSource: "openlit_evaluation",
    resultsStatus: "available",
    resultsMessage: null,
    filter: {},
    results: [RESULT, UNATTRIBUTED],
    runs: [],
    ...overrides
  };
}

function detail(
  overrides: Partial<ControlApiEvaluationDetailResponse> = {}
): ControlApiEvaluationDetailResponse {
  const run = {
    runId: RESULT.run!.id,
    definitionId: DEFINITION.id,
    status: "completed" as const,
    startedAt: "2026-10-04T12:00:00.000Z",
    lastResultAt: "2026-10-04T12:00:05Z",
    expectedResults: 2,
    observedResults: 2,
    passed: 1,
    failed: 1,
    errored: 0,
    unknown: 0,
    passRate: 0.5,
    failure: null
  };
  return {
    schema: "autodev-control-evaluation-v2",
    definition: DEFINITION,
    revision: "0123456789abcdef",
    validation: {
      runnable: true,
      judge: "resolved",
      targets: DEFINITION.targets.map((target, index) => ({
        key: index === 0 ? "agent:worker" : "model:gpt-5.6-terra+prompt:dry",
        target,
        status: "resolved" as const
      }))
    },
    resultsStatus: "available",
    resultsMessage: null,
    runs: [run],
    selectedRunId: run.runId,
    comparisons: [
      {
        targetKey: "agent:worker",
        subject: RESULT.subject,
        runId: run.runId,
        passed: 0,
        failed: 1,
        errored: 0,
        unknown: 0,
        passRate: 0,
        criteria: [
          { name: "hallucination", judged: 1, failed: 1, meanScore: 0.8 }
        ],
        previous: { runId: "older", passRate: 1 },
        passRateDelta: -1
      }
    ],
    caseMatrix: {
      runId: run.runId,
      targetKeys: ["agent:worker"],
      rows: [
        {
          caseId: "case-1",
          cells: {
            "agent:worker": {
              resultId: RESULT.id,
              outcome: "failed",
              worstScore: 0.8
            }
          }
        }
      ]
    },
    results: [RESULT],
    ...overrides
  };
}

function forms() {
  return {
    run: createEvaluationForm(
      { action: "run", definitionId: DEFINITION.id, expectedRevision: "" },
      CONFIG.serviceToken
    ),
    remove: createEvaluationForm(
      {
        action: "delete",
        definitionId: DEFINITION.id,
        expectedRevision: "0123456789abcdef"
      },
      CONFIG.serviceToken
    ),
    save: createEvaluationForm(
      {
        action: "save",
        definitionId: DEFINITION.id,
        expectedRevision: "0123456789abcdef"
      },
      CONFIG.serviceToken
    )
  };
}

test("fetchEvaluations sends filters with the fixed service credential and rejects stale schemas", async () => {
  const requested: string[] = [];
  const result = await fetchEvaluations(
    { prompt: "dry", definition: "worker-regression" },
    CONFIG,
    {
      fetchImpl: async (input, init) => {
        requested.push(String(input));
        const headers = new Headers(init?.headers);
        assert.equal(headers.get("authorization"), "Bearer test-token-123");
        assert.equal(headers.get("x-autodev-actor"), LOCAL_CONTROL_API_ACTOR);
        return Response.json(collection());
      }
    }
  );
  assert.equal(result.kind, "ok");
  assert.equal(
    requested[0],
    "http://127.0.0.1:4101/control/evaluations?definition=worker-regression&prompt=dry"
  );

  const stale = await fetchEvaluations({}, CONFIG, {
    fetchImpl: async () =>
      Response.json({
        schema: "autodev-control-evaluations-v1",
        evaluations: []
      })
  });
  assert.equal(stale.kind, "http-error");
  if (stale.kind === "http-error") {
    assert.equal(stale.code, "autodev_control_api_schema_mismatch");
    assert.match(stale.message, /Reinstall and restart the Runtime/u);
  }

  const unknownPath = await fetchEvaluationDetail(
    "worker-regression",
    null,
    CONFIG,
    {
      fetchImpl: async () =>
        Response.json(
          {
            error: {
              code: "autodev_control_api_unknown_path",
              message: "Unknown Control API path."
            }
          },
          { status: 404 }
        )
    }
  );
  assert.equal(unknownPath.kind, "http-error");
});

test("mutateControlApi sends the requested method with a JSON body", async () => {
  const seen: Array<{ method: string; body: string }> = [];
  const result: ControlApiResult<unknown> = await mutateControlApi(
    "DELETE",
    "/control/evaluations/worker-regression",
    { expectedRevision: "0123456789abcdef" },
    CONFIG,
    {
      fetchImpl: async (_input, init) => {
        seen.push({ method: String(init?.method), body: String(init?.body) });
        return Response.json({ ok: true });
      }
    }
  );
  assert.equal(result.kind, "ok");
  assert.deepEqual(seen, [
    { method: "DELETE", body: '{"expectedRevision":"0123456789abcdef"}' }
  ]);
});

test("EvaluationsView lists definitions, validation, filters, and attributed results", () => {
  const markup = renderToStaticMarkup(
    React.createElement(EvaluationsView, {
      data: collection({ filter: { prompt: "dry" } }),
      notice: "Definition deleted."
    })
  );
  assert.match(markup, /data-results-status="available"/u);
  assert.match(markup, /href="\/evaluations\/worker-regression"/u);
  assert.match(markup, /Unresolved/u);
  assert.match(markup, /href="\/evaluations\/new"/u);
  assert.match(markup, /Unattributed/u);
  assert.match(markup, /data-verdict="fail"/u);
  assert.match(markup, /hallucination 0\.80/u);
  assert.match(markup, /No metrics recorded/u);
  assert.match(markup, /name="prompt" value="dry"/u);
  assert.match(markup, /Clear filters/u);
  assert.match(markup, /data-trace-linked="true"/u);
  assert.match(markup, /result=9b3c5a7f-1234-4567-89ab-cdef01234567/u);
  assert.match(markup, /Definition deleted\./u);
  // 0 passed / 1 failed among judged results: an observed 0%, not "Not observed".
  assert.match(markup, /data-evaluation-pass-rate-observed="true"/u);
  assert.match(markup, />0%</u);
});

test("EvaluationsView keeps unavailable stores and invalid catalogs explicit", () => {
  const unavailable = renderToStaticMarkup(
    React.createElement(EvaluationsView, {
      data: collection({
        resultsStatus: "unavailable",
        resultsMessage: "OpenLIT evaluation store is unreachable (timed out).",
        results: []
      })
    })
  );
  assert.match(unavailable, /data-results-status="unavailable"/u);
  assert.match(unavailable, /Evaluation results are unavailable/u);
  assert.match(unavailable, /timed out/u);
  assert.equal(
    unavailable.includes("No evaluation results have been recorded"),
    false
  );
  assert.match(unavailable, /data-evaluation-pass-rate-observed="false"/u);

  const invalid = renderToStaticMarkup(
    React.createElement(EvaluationsView, {
      data: collection({
        catalogStatus: "invalid",
        catalogErrors: ["definitions[0]: id must be a lowercase slug."],
        definitions: [],
        results: []
      })
    })
  );
  assert.match(invalid, /config\/evaluations\.json is invalid/u);
  assert.match(invalid, /id must be a lowercase slug/u);
  assert.match(invalid, /No evaluation results have been recorded/u);
  assert.match(invalid, /Not observed/u);
});

test("EvaluationDetailView renders actions, comparisons, case matrix, and trace linkage", () => {
  const selectedResult: ControlApiEvaluationResultResponse = {
    schema: "autodev-control-evaluation-result-v2",
    result: RESULT,
    traceStatus: "available",
    traceMessage: null,
    spans: [
      {
        spanId: "00f067aa0ba902b7",
        parentSpanId: null,
        name: "autodev.evaluation.case",
        serviceName: "autodev-router",
        startedAt: "2026-10-04T12:00:00Z",
        durationMs: 1200,
        status: "ok",
        provider: null,
        requestModel: "autodev/worker",
        responseModel: null,
        inputTokens: null,
        outputTokens: null
      },
      {
        spanId: "b7ad6b7169203331",
        parentSpanId: "00f067aa0ba902b7",
        name: "gen_ai.client_operation",
        serviceName: "autodev-router",
        startedAt: "2026-10-04T12:00:01Z",
        durationMs: 900,
        status: "error",
        provider: "openai",
        requestModel: "autodev/worker",
        responseModel: "gpt-5.6-terra",
        inputTokens: 120,
        outputTokens: 30
      }
    ]
  };
  const allForms = forms();
  const markup = renderToStaticMarkup(
    React.createElement(EvaluationDetailView, {
      detail: detail(),
      forms: allForms,
      criterionTypes: EVALUATION_CRITERION_TYPES,
      selectedResult
    })
  );
  assert.match(markup, /data-evaluation-definition="worker-regression"/u);
  assert.match(markup, /Run evaluation/u);
  assert.match(
    markup,
    new RegExp(
      `name="idempotencyKey" value="${allForms.run.idempotencyKey}"`,
      "u"
    )
  );
  assert.match(
    markup,
    /type="checkbox" required="" name="confirm" value="yes"/u
  );
  assert.match(markup, /href="\/prompts\/dry"/u);
  assert.match(markup, /-100 pts/u);
  assert.match(markup, /hallucination 0\.80 \(1\/1 failed\)/u);
  assert.match(markup, /data-case-matrix=/u);
  assert.match(markup, /data-trace-status="available"/u);
  assert.match(markup, /gen_ai\.client_operation/u);
  assert.match(markup, /padding-left:16px/u);
  assert.match(markup, /120 in \/ 30 out/u);
  assert.match(markup, /Invents a package\./u);
  assert.match(markup, /href="\/usage\?model=autodev%2Fworker"/u);
  assert.match(markup, /href="\/usage\?agent=worker"/u);
  assert.equal(markup.includes("data-evaluation-editor"), false);

  const blocked = renderToStaticMarkup(
    React.createElement(EvaluationDetailView, {
      detail: detail({
        definition: { ...DEFINITION, enabled: false },
        runs: [],
        selectedRunId: null,
        comparisons: [],
        caseMatrix: null,
        results: []
      }),
      forms: { ...allForms, run: null },
      criterionTypes: EVALUATION_CRITERION_TYPES,
      editing: true,
      selectedResult: {
        ...selectedResult,
        traceStatus: "not_observed",
        spans: [],
        result: { ...RESULT, traceId: null, spanId: null }
      }
    })
  );
  assert.match(blocked, /Disabled definitions cannot run\./u);
  assert.equal(blocked.includes("Run evaluation"), false);
  assert.match(blocked, /data-evaluation-editor="worker-regression"/u);
  assert.match(blocked, /This definition has not been run\./u);
  assert.match(
    blocked,
    /Trace not observed: the producer recorded no trace link\./u
  );
});

test("evaluation page helpers keep filters and notices bounded to known values", () => {
  assert.deepEqual(
    evaluationFilterFromSearchParams({
      prompt: "dry",
      agent: ["worker", "explorer"],
      model: "  ",
      unknown: "x"
    }),
    { agent: "worker", prompt: "dry" }
  );
  assert.deepEqual(
    evaluationNoticeFromSearchParams({
      notice: "run-failed",
      code: "autodev_control_api_evaluation_run_active"
    }),
    {
      notice: "The run could not be started.",
      code: "autodev_control_api_evaluation_run_active"
    }
  );
  assert.deepEqual(
    evaluationNoticeFromSearchParams({ notice: "<script>", code: "x" }),
    { notice: null, code: null }
  );
  assert.equal(
    evaluationNoticeFromSearchParams({ notice: "saved", code: "Bad Code!" })
      .code,
    null
  );
});

function formRequest(
  fields: Record<string, string>,
  headers: Record<string, string> = {}
): Request {
  return new Request(`${SERVER_URL}/api/evaluations`, {
    method: "POST",
    headers: {
      host: HOST,
      origin: ORIGIN,
      "sec-fetch-site": "same-origin",
      "content-type": "application/x-www-form-urlencoded",
      ...headers
    },
    body: new URLSearchParams(fields).toString()
  });
}

test("evaluation run and delete forms are same-origin, token-bound, and forwarded", async () => {
  const run = createEvaluationForm(
    { action: "run", definitionId: DEFINITION.id, expectedRevision: "" },
    CONFIG.serviceToken
  );
  const started: Array<{ id: string; key: string }> = [];
  const dependencies = {
    config: CONFIG,
    run: async (id: string, body: { idempotencyKey: string }) => {
      started.push({ id, key: body.idempotencyKey });
      return {
        kind: "ok" as const,
        data: {
          schema: "autodev-control-evaluation-run-v1" as const,
          result: "accepted" as const,
          run: { ...detail().runs[0]!, status: "running" as const }
        }
      };
    }
  };
  const fields = {
    action: "run",
    definitionId: run.definitionId,
    idempotencyKey: run.idempotencyKey,
    formToken: run.formToken
  };

  const crossOrigin = await handleEvaluationAction(
    formRequest(fields, { origin: "https://evil.example" }),
    dependencies
  );
  assert.equal(crossOrigin.status, 403);
  const crossSite = await handleEvaluationAction(
    formRequest(fields, { "sec-fetch-site": "cross-site" }),
    dependencies
  );
  assert.equal(crossSite.status, 403);

  const tampered = await handleEvaluationAction(
    formRequest({ ...fields, idempotencyKey: "another-key-123" }),
    dependencies
  );
  assert.equal(tampered.status, 403);
  const extra = await handleEvaluationAction(
    formRequest({ ...fields, sql: "drop" }),
    dependencies
  );
  assert.equal(extra.status, 400);
  assert.equal(started.length, 0);

  const accepted = await handleEvaluationAction(
    formRequest(fields),
    dependencies
  );
  assert.equal(accepted.status, 303);
  assert.equal(
    accepted.headers.get("location"),
    `/evaluations/worker-regression?notice=run-accepted&run=${RESULT.run!.id}`
  );
  assert.deepEqual(started, [{ id: DEFINITION.id, key: run.idempotencyKey }]);

  const expired = await handleEvaluationAction(formRequest(fields), {
    ...dependencies,
    now: () => Date.now() + 31 * 60 * 1000
  });
  assert.equal(expired.status, 403);

  const remove = createEvaluationForm(
    {
      action: "delete",
      definitionId: DEFINITION.id,
      expectedRevision: "0123456789abcdef"
    },
    CONFIG.serviceToken
  );
  const removeFields = {
    action: "delete",
    definitionId: remove.definitionId,
    expectedRevision: remove.expectedRevision,
    formToken: remove.formToken
  };
  const unconfirmed = await handleEvaluationAction(formRequest(removeFields), {
    config: CONFIG
  });
  assert.equal(unconfirmed.status, 400);
  const failedDelete = await handleEvaluationAction(
    formRequest({ ...removeFields, confirm: "yes" }),
    {
      config: CONFIG,
      remove: async () => ({
        kind: "http-error" as const,
        status: 409,
        code: "autodev_control_api_revision_conflict",
        message: "changed"
      })
    }
  );
  assert.equal(failedDelete.status, 303);
  assert.equal(
    failedDelete.headers.get("location"),
    "/evaluations/worker-regression?notice=delete-failed&code=autodev_control_api_revision_conflict"
  );
});

test("evaluation saves forward the parsed draft and surface Control API errors", async () => {
  const create = createEvaluationForm(
    { action: "save", definitionId: "", expectedRevision: "" },
    CONFIG.serviceToken
  );
  assert.equal(
    verifyEvaluationFormToken(
      create.formToken,
      {
        action: "save",
        definitionId: "",
        expectedRevision: "",
        idempotencyKey: ""
      },
      CONFIG.serviceToken,
      Date.now()
    ),
    true
  );
  const puts: Array<{ id: string; expectedRevision: string | null }> = [];
  const save = (
    definition: string,
    put: NonNullable<EvaluationActionDependencies["put"]> = async (
      id,
      body
    ) => {
      puts.push({ id, expectedRevision: body.expectedRevision });
      return {
        kind: "ok" as const,
        data: {
          schema: "autodev-control-evaluation-definition-v1" as const,
          result: "created" as const,
          definitionId: id,
          revision: "fedcba9876543210"
        }
      };
    }
  ) =>
    handleEvaluationAction(
      new Request(`${SERVER_URL}/api/evaluations`, {
        method: "POST",
        headers: {
          host: HOST,
          origin: ORIGIN,
          "sec-fetch-site": "same-origin",
          "content-type": "application/json"
        },
        body: JSON.stringify({
          action: "save",
          definitionId: "",
          expectedRevision: "",
          formToken: create.formToken,
          definition
        })
      }),
      { config: CONFIG, put }
    );

  const created = await save(JSON.stringify(DEFINITION));
  assert.equal(created.status, 200);
  assert.deepEqual(await created.json(), {
    ok: true,
    definitionId: "worker-regression",
    revision: "fedcba9876543210"
  });
  assert.deepEqual(puts, [{ id: "worker-regression", expectedRevision: null }]);

  const invalidJson = await save("{not json");
  assert.equal(invalidJson.status, 400);
  assert.match(
    ((await invalidJson.json()) as { message: string }).message,
    /not valid JSON/u
  );

  const reservedId = await save(JSON.stringify({ ...DEFINITION, id: "new" }));
  assert.equal(reservedId.status, 400);

  const rejected = await save(JSON.stringify(DEFINITION), async () => ({
    kind: "http-error" as const,
    status: 422,
    code: "autodev_control_api_unresolved_evaluation_reference",
    message:
      "Definition references unknown AutoDev resources (judge: unknown_model)."
  }));
  assert.equal(rejected.status, 422);
  assert.deepEqual(await rejected.json(), {
    ok: false,
    code: "autodev_control_api_unresolved_evaluation_reference",
    message:
      "Definition references unknown AutoDev resources (judge: unknown_model)."
  });

  const wrongType = await handleEvaluationAction(
    new Request(`${SERVER_URL}/api/evaluations`, {
      method: "POST",
      headers: {
        host: HOST,
        origin: ORIGIN,
        "sec-fetch-site": "same-origin",
        "content-type": "text/plain"
      },
      body: "x"
    }),
    { config: CONFIG }
  );
  assert.equal(wrongType.status, 415);
  const noCredential = await handleEvaluationAction(
    formRequest({ action: "run" }),
    { config: null }
  );
  assert.equal(noCredential.status, 503);
});

test("same-origin checks compare the browser Origin with the addressed host", () => {
  const check = (headers: Record<string, string>) =>
    isSameOriginRequest(
      new Request(`${SERVER_URL}/api/evaluations`, { method: "POST", headers })
    );
  const sameOrigin = {
    origin: ORIGIN,
    host: HOST,
    "sec-fetch-site": "same-origin"
  };
  assert.equal(check(sameOrigin), true);
  assert.equal(check({ ...sameOrigin, host: "localhost:3300" }), false);
  assert.equal(check({ ...sameOrigin, "sec-fetch-site": "cross-site" }), false);
  assert.equal(check({ host: HOST, "sec-fetch-site": "same-origin" }), false);
  assert.equal(check({ ...sameOrigin, origin: "null" }), false);
  assert.equal(
    check({
      origin: "https://console.example",
      host: HOST,
      "x-forwarded-host": "console.example",
      "sec-fetch-site": "same-origin"
    }),
    true
  );
});
