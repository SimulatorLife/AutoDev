import assert from "node:assert/strict";
import test from "node:test";

import type {
  ExperienceEnvelope,
  MemoryInjectionOutcomeJoinPage
} from "@simulatorlife/autodev-core";
import type { MemoryService } from "@simulatorlife/autodev-runtime/memory";

import { handleMemoryControlApiRequest } from "../src/control-api/memory.ts";
import {
  makeRequest,
  responseBody,
  type RecordedResponse,
  responseRecorder
} from "./support/control-api-harness.ts";

/**
 * Two experience-side routes had no route-level test: the injection-outcome
 * join at `GET /control/memory/experiences/:id/outcomes`, whose only coverage
 * was `memory-outcome-control-api.integration.test.ts` and that skips without a
 * live Postgres; and `POST /control/memory/experiences/:id/purge`, which had
 * none at all. Their session-outcome and use-assessment siblings do have tests,
 * so the gap was the two a repository-less developer never exercises.
 */

interface CallResult {
  readonly response: RecordedResponse;
  readonly body: Record<string, unknown> | null;
}

const EXPERIENCES = "/control/memory/experiences";
const SCOPE = "workspaceId=ws-1&includeTaskHistory=true";

async function callRoute(
  service: MemoryService,
  path: string,
  body?: Record<string, unknown>,
  options: {
    readonly actorRole?: "viewer" | "operator";
    readonly method?: string;
    readonly disableTaskHistoryEnv?: boolean;
  } = {}
): Promise<CallResult> {
  const response = responseRecorder();
  const prevEnv = process.env.AUTODEV_MEMORY_READ_TASK_HISTORY;
  if (options.disableTaskHistoryEnv) {
    delete process.env.AUTODEV_MEMORY_READ_TASK_HISTORY;
  } else {
    process.env.AUTODEV_MEMORY_READ_TASK_HISTORY = "1";
  }
  const pathname = path.split("?")[0] ?? path;
  try {
    await handleMemoryControlApiRequest(
      makeRequest(options.method ?? "GET", `${path}?${SCOPE}`, body),
      response,
      pathname,
      { actor: "test-operator", role: options.actorRole ?? "operator" },
      () => {},
      { createMemoryService: () => service }
    );
  } finally {
    if (prevEnv === undefined) {
      delete process.env.AUTODEV_MEMORY_READ_TASK_HISTORY;
    } else {
      process.env.AUTODEV_MEMORY_READ_TASK_HISTORY = prevEnv;
    }
  }
  return { response, body: responseBody(response) };
}

function experience(): ExperienceEnvelope {
  return {
    id: "exp-1",
    workspaceId: "ws-1",
    scope: { kind: "workspace", workspaceId: "ws-1" },
    taskId: "task-1",
    runId: "run-1",
    agentId: "agent-orch",
    startedAt: "2026-10-03T10:00:00.000Z",
    outcome: "success",
    evidence: [],
    trajectory: { steps: [] }
  } as unknown as ExperienceEnvelope;
}

function mockService(
  overrides: Partial<Record<keyof MemoryService, unknown>> = {}
): MemoryService {
  return {
    getExperience: async () => experience(),
    listInjectionOutcomeJoins: async () => ({
      items: [
        {
          injectionId: "inj-1",
          memoryMode: "jit",
          injected: true,
          reported: true,
          reportKind: "task",
          outcomeKind: "success"
        }
      ],
      total: 1,
      limit: 25,
      offset: 0
    }) as unknown as MemoryInjectionOutcomeJoinPage,
    purgeExperience: async () => ({ purged: true }),
    ...overrides
  } as unknown as MemoryService;
}

test("GET /control/memory/experiences/:id/outcomes joins the experience to its reported outcomes", async () => {
  let captured: Record<string, unknown> | undefined;
  const service = mockService({
    listInjectionOutcomeJoins: async (req: Record<string, unknown>) => {
      captured = req;
      return {
        items: [],
        total: 0,
        limit: 25,
        offset: 0
      } as unknown as MemoryInjectionOutcomeJoinPage;
    }
  });

  const { response, body } = await callRoute(
    service,
    `${EXPERIENCES}/exp-1/outcomes`
  );

  assert.equal(response.statusCode, 200);
  assert.equal(body?.schema, "autodev-memory-injection-outcomes-v1");
  assert.equal(body?.experienceId, "exp-1");
  // Unreported exposures are part of the answer. A join that dropped them would
  // report the same cohort for an experience that was injected and never judged
  // and one that was injected and reported, and the difference is the point.
  assert.equal(captured?.includeUnreported, true);
});

test("GET /control/memory/experiences/:id/outcomes keeps an unreported exposure in the page", async () => {
  const service = mockService({
    listInjectionOutcomeJoins: async () =>
      ({
        items: [
          {
            injectionId: "inj-1",
            memoryMode: "jit",
            injected: true,
            reported: false,
            reportKind: null,
            outcomeKind: null
          }
        ],
        total: 1,
        limit: 25,
        offset: 0
      }) as unknown as MemoryInjectionOutcomeJoinPage
  });

  const { response, body } = await callRoute(
    service,
    `${EXPERIENCES}/exp-1/outcomes`
  );

  assert.equal(response.statusCode, 200);
  const items = body?.items as Array<Record<string, unknown>>;
  assert.equal(items.length, 1);
  assert.equal(items[0]?.reported, false);
  assert.equal(items[0]?.outcomeKind, null);
});

test("GET /control/memory/experiences/:id/outcomes refuses a viewer", async () => {
  const { response } = await callRoute(
    mockService(),
    `${EXPERIENCES}/exp-1/outcomes`,
    undefined,
    { actorRole: "viewer" }
  );

  assert.equal(response.statusCode, 403);
});

test("GET /control/memory/experiences/:id/outcomes refuses without the task-history grant", async () => {
  const { response, body } = await callRoute(
    mockService(),
    `${EXPERIENCES}/exp-1/outcomes`,
    undefined,
    { disableTaskHistoryEnv: true }
  );

  assert.equal(response.statusCode, 403);
  // The refusal lands at the filter gate, before the handler's own
  // `requireTaskHistoryOperator` check can run, so the code is the scope one
  // rather than `autodev_memory_task_history_forbidden`. What matters is that
  // it is refused at all: asking for a window this caller cannot see must not
  // quietly return an empty join.
  const error = body?.error as { code?: unknown } | undefined;
  assert.equal(error?.code, "autodev_memory_scope_forbidden");
});

test("GET /control/memory/experiences/:id/outcomes answers 404 for an unknown experience", async () => {
  const { response } = await callRoute(
    mockService({ getExperience: async () => null }),
    `${EXPERIENCES}/exp-missing/outcomes`
  );

  assert.equal(response.statusCode, 404);
});

test("POST /control/memory/experiences/:id/purge deletes and reports the result", async () => {
  let captured: { id?: unknown; reason?: unknown } = {};
  const service = mockService({
    purgeExperience: async (id: string, reason: string) => {
      captured = { id, reason };
      return { purged: true };
    }
  });

  const { response, body } = await callRoute(
    service,
    `${EXPERIENCES}/exp-1/purge`,
    { reason: "privacy_request" },
    { method: "POST" }
  );

  assert.equal(response.statusCode, 200);
  assert.equal(captured.id, "exp-1");
  assert.equal(captured.reason, "privacy_request");
  assert.equal(body?.schema, "autodev-memory-experience-purge-v1");
});

test("POST /control/memory/experiences/:id/purge accepts only the two governed reasons", async () => {
  // A purge is irreversible. "Because I thought so" is not a reason the audit
  // record can carry, so the route accepts exactly two and refuses the rest.
  for (const reason of ["privacy_request", "retention_expired"]) {
    const ok = await callRoute(
      mockService(),
      `${EXPERIENCES}/exp-1/purge`,
      { reason },
      { method: "POST" }
    );
    assert.equal(ok.response.statusCode, 200, `${reason} should be accepted`);
  }

  const refused = await callRoute(
    mockService(),
    `${EXPERIENCES}/exp-1/purge`,
    { reason: "no_longer_useful" },
    { method: "POST" }
  );
  assert.equal(refused.response.statusCode, 400);
});

test("POST /control/memory/experiences/:id/purge refuses when a durable memory still cites it", async () => {
  const { response, body } = await callRoute(
    mockService({ purgeExperience: async () => "referenced_by_memory" }),
    `${EXPERIENCES}/exp-1/purge`,
    { reason: "privacy_request" },
    { method: "POST" }
  );

  // 409, not 500: the experience is visible and purgable in principle, it just
  // cannot go while a record's provenance points at it. The caller has to
  // resolve the citation first.
  assert.equal(response.statusCode, 409);
  const error = body?.error as { code?: unknown } | undefined;
  assert.equal(error?.code, "autodev_memory_experience_referenced");
});

test("POST /control/memory/experiences/:id/purge reports an experience outside the caller's scope as not found", async () => {
  const { response } = await callRoute(
    mockService({ purgeExperience: async () => "not_visible" }),
    `${EXPERIENCES}/exp-1/purge`,
    { reason: "privacy_request" },
    { method: "POST" }
  );

  // 404 rather than 403: telling an unauthorised caller that the experience
  // exists would leak the very scope the purge is meant to honour.
  assert.equal(response.statusCode, 404);
});

test("POST /control/memory/experiences/:id/purge rejects an unknown body key", async () => {
  const { response } = await callRoute(
    mockService(),
    `${EXPERIENCES}/exp-1/purge`,
    { reason: "privacy_request", force: true },
    { method: "POST" }
  );

  assert.equal(response.statusCode, 400);
});

test("POST /control/memory/experiences/:id/purge refuses a viewer", async () => {
  const { response } = await callRoute(
    mockService(),
    `${EXPERIENCES}/exp-1/purge`,
    { reason: "privacy_request" },
    { method: "POST", actorRole: "viewer" }
  );

  assert.equal(response.statusCode, 403);
});