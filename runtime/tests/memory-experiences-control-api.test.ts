import assert from "node:assert/strict";
import test from "node:test";

import type { ExperienceEnvelope } from "@simulatorlife/autodev-core";
import type { MemoryService } from "@simulatorlife/autodev-runtime/memory";

import { handleMemoryControlApiRequest } from "../src/control-api/memory.ts";
import {
  makeRequest,
  responseBody,
  type RecordedResponse,
  responseRecorder
} from "./support/control-api-harness.ts";

/**
 * The `/control/memory/experiences` reads — listing and detail — had no
 * route-level test. Every other memory route family does: records, cohorts,
 * session-cohorts, use-cohorts, history, status. Experiences is the one
 * execution-trace surface the Console lists and opens, and it ran uncovered.
 */

interface CallResult {
  readonly response: RecordedResponse;
  readonly body: Record<string, unknown> | null;
}

const LIST_PATH = "/control/memory/experiences";

async function callRoute(
  service: MemoryService,
  pathname: string,
  query: Record<string, string | string[]> = {},
  options: {
    readonly actorRole?: "viewer" | "operator";
    readonly method?: string;
    readonly disableTaskHistoryEnv?: boolean;
  } = {}
): Promise<CallResult> {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (Array.isArray(value)) {
      for (const item of value) search.append(key, item);
    } else {
      search.set(key, value);
    }
  }
  const suffix = search.toString();
  const request = makeRequest(
    options.method ?? "GET",
    suffix ? `${pathname}?${suffix}` : pathname
  );
  const response = responseRecorder();
  const prevEnv = process.env.AUTODEV_MEMORY_READ_TASK_HISTORY;
  if (options.disableTaskHistoryEnv) {
    delete process.env.AUTODEV_MEMORY_READ_TASK_HISTORY;
  } else {
    process.env.AUTODEV_MEMORY_READ_TASK_HISTORY = "1";
  }
  try {
    await handleMemoryControlApiRequest(
      request,
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

function experience(overrides: Partial<ExperienceEnvelope> = {}) {
  return {
    id: "exp-1",
    workspaceId: "ws-1",
    scope: { kind: "workspace", workspaceId: "ws-1" },
    taskId: "task-1",
    runId: "run-1",
    agentId: "agent-orch",
    startedAt: "2026-10-03T10:00:00.000Z",
    outcome: "success",
    memoryMode: "jit",
    validation: {
      state: "passed",
      evidence: [
        {
          kind: "test_result",
          reference: "pytest tests/test_x.py::test_y",
          observedAt: "2026-10-03T10:05:00.000Z"
        }
      ]
    },
    trajectory: { steps: [] },
    ...overrides
  } as ExperienceEnvelope;
}

function mockService(
  overrides: Partial<Record<keyof MemoryService, unknown>> = {}
): MemoryService {
  return {
    listExperiences: async () => ({
      items: [experience()],
      total: 1,
      limit: 25,
      offset: 0
    }),
    getExperience: async () => experience(),
    ...overrides
  } as unknown as MemoryService;
}

test("GET /control/memory/experiences returns the page with the store's own total", async () => {
  let captured: Record<string, unknown> | undefined;
  const service = mockService({
    listExperiences: async (req: Record<string, unknown>) => {
      captured = req;
      return { items: [experience()], total: 340, limit: 25, offset: 0 };
    }
  });

  const { response, body } = await callRoute(service, LIST_PATH, {
    workspaceId: "ws-1"
  });

  assert.equal(response.statusCode, 200);
  assert.equal(body?.schema, "autodev-memory-experiences-v1");
  // The store's own total, not the size of the returned window.
  assert.equal(body?.total, 340);
  assert.equal(body?.limit, 25);
  assert.equal((body?.items as ExperienceEnvelope[]).length, 1);
  assert.equal(captured?.context !== undefined, true);
});

test("GET /control/memory/experiences forwards mode, outcome and paging filters", async () => {
  let captured: Record<string, unknown> | undefined;
  const service = mockService({
    listExperiences: async (req: Record<string, unknown>) => {
      captured = req;
      return { items: [], total: 0, limit: 10, offset: 30 };
    }
  });

  const { response } = await callRoute(service, LIST_PATH, {
    workspaceId: "ws-1",
    memoryMode: ["jit", "disabled"],
    outcome: ["success", "failure"],
    limit: "10",
    offset: "30",
    query: "timeout"
  });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(captured?.memoryModes, ["jit", "disabled"]);
  assert.deepEqual(captured?.outcomes, ["success", "failure"]);
  assert.equal(captured?.limit, 10);
  assert.equal(captured?.offset, 30);
  assert.equal(captured?.query, "timeout");
});

test("GET /control/memory/experiences reports an empty collection as a page, not a failure", async () => {
  const { response, body } = await callRoute(
    mockService({
      listExperiences: async () => ({
        items: [],
        total: 0,
        limit: 25,
        offset: 0
      })
    }),
    LIST_PATH,
    { workspaceId: "ws-1" }
  );

  assert.equal(response.statusCode, 200);
  assert.equal(body?.schema, "autodev-memory-experiences-v1");
  assert.deepEqual(body?.items, []);
  assert.equal(body?.total, 0);
});

test("GET /control/memory/experiences rejects an unbounded outcome with 400", async () => {
  const { response } = await callRoute(mockService(), LIST_PATH, {
    workspaceId: "ws-1",
    outcome: "mostly-fine"
  });

  assert.equal(response.statusCode, 400);
});

test("GET /control/memory/experiences refuses a record-only filter with 400", async () => {
  // `kind` and `status` describe a durable record's lifecycle; an experience has
  // neither. They used to be parsed, validated and dropped on the way to the
  // service, so a caller filtering experiences by status got the whole
  // unfiltered collection under a 200 with nothing to say the filter was
  // ignored. The records route has always refused the mirror case.
  for (const query of ["status=active", "kind=semantic"]) {
    const { response } = await callRoute(mockService(), LIST_PATH, {
      workspaceId: "ws-1",
      ...Object.fromEntries(new URLSearchParams(query))
    });
    assert.equal(response.statusCode, 400, `${query} should be refused`);
  }
});

test("GET /control/memory/records still refuses an experience-only filter with 400", async () => {
  // The mirror of the case above, kept here so the pair cannot drift apart.
  const { response } = await callRoute(
    mockService(),
    "/control/memory/records",
    {
      workspaceId: "ws-1",
      repositoryId: "repo-1",
      outcome: "success"
    }
  );

  assert.equal(response.statusCode, 400);
});

test("GET /control/memory/experiences/:id returns the experience", async () => {
  const { response, body } = await callRoute(
    mockService(),
    `${LIST_PATH}/exp-1`,
    { workspaceId: "ws-1" }
  );

  assert.equal(response.statusCode, 200);
  assert.equal(body?.schema, "autodev-memory-experience-v1");
  const found = body?.experience as ExperienceEnvelope;
  assert.equal(found.id, "exp-1");
  assert.equal(found.validation?.state, "passed");
});

test("GET /control/memory/experiences/:id answers 404 for an unknown experience", async () => {
  const { response, body } = await callRoute(
    mockService({ getExperience: async () => null }),
    `${LIST_PATH}/exp-missing`,
    { workspaceId: "ws-1" }
  );

  assert.equal(response.statusCode, 404);
  const error = body?.error as { code?: unknown } | undefined;
  assert.equal(error?.code, "autodev_memory_not_found");
});

test("GET /control/memory/experiences/:id keeps a not_run validation readable", async () => {
  // `not_run` is a reported state, not a missing one: the detail page has to be
  // able to say so rather than reading the experience as having no verdict.
  const { response, body } = await callRoute(
    mockService({
      getExperience: async () =>
        experience({
          validation: { state: "not_run", evidence: [] }
        } as Partial<ExperienceEnvelope>)
    }),
    `${LIST_PATH}/exp-2`,
    { workspaceId: "ws-1" }
  );

  assert.equal(response.statusCode, 200);
  const found = body?.experience as ExperienceEnvelope;
  assert.equal(found.validation?.state, "not_run");
});
