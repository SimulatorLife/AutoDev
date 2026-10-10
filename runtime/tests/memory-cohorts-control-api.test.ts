import assert from "node:assert/strict";
import test from "node:test";

import type {
  MemoryInjectionOutcomeCohortFilter,
  MemoryInjectionOutcomeCohortPage
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
 * `GET /control/memory/cohorts` is the injection-outcome cohort read behind the
 * Cohorts tab's reported/unreported split. It had no unit test at all: the only
 * thing exercising it was `memory-outcome-control-api.integration.test.ts`,
 * which skips without a live Postgres, so on every ordinary `node --test` run
 * this route was untested while its two siblings — session-cohorts and
 * use-cohorts — had whole files.
 */
interface CallCohortResult {
  readonly response: RecordedResponse;
  readonly body: Record<string, unknown> | null;
}

const PATHNAME = "/control/memory/cohorts";

const DEFAULT_QUERY = {
  workspaceId: "ws-1",
  repositoryId: "repo-1",
  // The route requires the caller to ask for task-history-scoped data
  // explicitly; the environment grant only decides whether it is allowed.
  includeTaskHistory: "true",
  occurredFrom: "2026-09-01T00:00:00.000Z",
  occurredUntil: "2026-09-02T00:00:00.000Z"
};

async function callCohortRoute(
  service: MemoryService,
  auditRecords: Array<Record<string, unknown>>,
  query: Record<string, string | string[]>,
  options: {
    readonly actorRole?: "viewer" | "operator";
    readonly method?: string;
    readonly disableTaskHistoryEnv?: boolean;
  } = {}
): Promise<CallCohortResult> {
  const actorRole = options.actorRole ?? "operator";
  const method = options.method ?? "GET";
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (Array.isArray(value)) {
      for (const item of value) search.append(key, item);
    } else {
      search.set(key, value);
    }
  }
  const request = makeRequest(method, `${PATHNAME}?${search.toString()}`);
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
      PATHNAME,
      { actor: "test-operator", role: actorRole },
      (event) => auditRecords.push(event),
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

function mockMemoryService(
  impl?: (
    req: MemoryInjectionOutcomeCohortFilter
  ) => Promise<MemoryInjectionOutcomeCohortPage>
): MemoryService {
  return {
    aggregateInjectionOutcomeCohorts:
      impl ??
      (async (req) => ({
        schema: "autodev-memory-injection-outcome-cohorts-v1",
        workspaceId: req.context.workspaceId,
        repositoryId: req.context.repositoryId!,
        occurredFrom: req.occurredFrom,
        occurredUntil: req.occurredUntil,
        cells: [
          {
            memoryMode: "jit",
            injectionResult: "injected",
            sessionCardinality: "single",
            reportKind: "task",
            outcomeKind: "success",
            exposureCount: 3,
            reportCount: 2
          }
        ],
        exposureCount: 3,
        reportCount: 2
      }))
  } as unknown as MemoryService;
}

test("GET /control/memory/cohorts returns 200 with the page and audits the read", async () => {
  const auditRecords: Array<Record<string, unknown>> = [];
  let captured: MemoryInjectionOutcomeCohortFilter | undefined;
  const service = mockMemoryService(async (filter) => {
    captured = filter;
    return {
      schema: "autodev-memory-injection-outcome-cohorts-v1",
      workspaceId: filter.context.workspaceId,
      repositoryId: filter.context.repositoryId!,
      occurredFrom: filter.occurredFrom,
      occurredUntil: filter.occurredUntil,
      cells: [
        {
          memoryMode: "jit",
          injectionResult: "injected",
          sessionCardinality: "single",
          reportKind: "task",
          outcomeKind: "success",
          exposureCount: 5,
          reportCount: 3
        },
        // An unreported exposure: the cell exists, and its report and outcome
        // are null rather than a fabricated "no outcome".
        {
          memoryMode: "jit",
          injectionResult: "empty",
          sessionCardinality: "multiple",
          reportKind: null,
          outcomeKind: null,
          exposureCount: 2,
          reportCount: 0
        }
      ],
      exposureCount: 7,
      reportCount: 3
    };
  });

  const { response, body } = await callCohortRoute(
    service,
    auditRecords,
    DEFAULT_QUERY
  );

  assert.equal(response.statusCode, 200);
  assert.equal(body?.schema, "autodev-memory-injection-outcome-cohorts-v1");
  assert.equal(body?.workspaceId, "ws-1");
  assert.equal(body?.repositoryId, "repo-1");
  // The store's own totals, not the size of the returned window.
  assert.equal(body?.exposureCount, 7);
  assert.equal(body?.reportCount, 3);
  const cells = body?.cells as Array<Record<string, unknown>>;
  assert.equal(cells.length, 2);
  assert.equal(cells[1]?.reportKind, null);
  assert.equal(cells[1]?.outcomeKind, null);

  assert.equal(captured?.context.workspaceId, "ws-1");
  assert.equal(captured?.context.repositoryId, "repo-1");
  assert.equal(captured?.occurredFrom, DEFAULT_QUERY.occurredFrom);

  const audit = auditRecords.find((r) => r.action === "read_cohorts");
  assert.ok(audit, "the cohort read should be audited");
  assert.equal(audit?.resource, PATHNAME);
  assert.equal(audit?.outcome, "ok");
});

test("GET /control/memory/cohorts reports a bounded empty cohort as a page, not a failure", async () => {
  const service = mockMemoryService(async (filter) => ({
    schema: "autodev-memory-injection-outcome-cohorts-v1",
    workspaceId: filter.context.workspaceId,
    repositoryId: filter.context.repositoryId!,
    occurredFrom: filter.occurredFrom,
    occurredUntil: filter.occurredUntil,
    cells: [],
    exposureCount: 0,
    reportCount: 0
  }));

  const { response, body } = await callCohortRoute(service, [], DEFAULT_QUERY);

  assert.equal(response.statusCode, 200);
  // No entries is an empty, valid cohort — not "unavailable", and not a zero
  // standing in for a read that never happened.
  assert.equal(body?.schema, "autodev-memory-injection-outcome-cohorts-v1");
  assert.deepEqual(body?.cells, []);
  assert.equal(body?.exposureCount, 0);
  assert.equal(body?.reportCount, 0);
});

test("GET /control/memory/cohorts forwards bounded mode and result filters", async () => {
  let captured: MemoryInjectionOutcomeCohortFilter | undefined;
  const service = mockMemoryService(async (filter) => {
    captured = filter;
    return {
      schema: "autodev-memory-injection-outcome-cohorts-v1",
      workspaceId: filter.context.workspaceId,
      repositoryId: filter.context.repositoryId!,
      occurredFrom: filter.occurredFrom,
      occurredUntil: filter.occurredUntil,
      cells: [],
      exposureCount: 0,
      reportCount: 0
    };
  });

  const { response } = await callCohortRoute(service, [], {
    ...DEFAULT_QUERY,
    memoryMode: ["jit", "disabled"],
    injectionResult: "injected"
  });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(captured?.memoryModes, ["jit", "disabled"]);
  assert.deepEqual(captured?.injectionResults, ["injected"]);
});

test("GET /control/memory/cohorts rejects viewer role with 403", async () => {
  const { response, body } = await callCohortRoute(
    mockMemoryService(),
    [],
    DEFAULT_QUERY,
    { actorRole: "viewer" }
  );

  assert.equal(response.statusCode, 403);
});

test("GET /control/memory/cohorts rejects a missing task-history grant with 403", async () => {
  const { response } = await callCohortRoute(
    mockMemoryService(),
    [],
    DEFAULT_QUERY,
    { disableTaskHistoryEnv: true }
  );

  assert.equal(response.statusCode, 403);
});

test("GET /control/memory/cohorts rejects a missing includeTaskHistory with 403", async () => {
  // Asking is required, not merely permitted: a URL that omits it must not read
  // as the same query as one that consents to task-history scope.
  const { response } = await callCohortRoute(mockMemoryService(), [], {
    workspaceId: "ws-1",
    repositoryId: "repo-1",
    occurredFrom: DEFAULT_QUERY.occurredFrom,
    occurredUntil: DEFAULT_QUERY.occurredUntil
  });

  assert.equal(response.statusCode, 403);
});

test("GET /control/memory/cohorts rejects a missing repository with 400", async () => {
  const { response } = await callCohortRoute(mockMemoryService(), [], {
    workspaceId: "ws-1",
    includeTaskHistory: "true",
    occurredFrom: DEFAULT_QUERY.occurredFrom,
    occurredUntil: DEFAULT_QUERY.occurredUntil
  });

  assert.equal(response.statusCode, 400);
});

test("GET /control/memory/cohorts rejects a caller-selected taskId with 400", async () => {
  // The cohort is a repository-wide aggregate. Letting the URL narrow it to one
  // task would make the totals contradict every other Memory surface.
  const { response } = await callCohortRoute(mockMemoryService(), [], {
    ...DEFAULT_QUERY,
    taskId: "task-1"
  });

  assert.equal(response.statusCode, 400);
});

test("GET /control/memory/cohorts rejects an unbounded memory mode with 400", async () => {
  const { response } = await callCohortRoute(mockMemoryService(), [], {
    ...DEFAULT_QUERY,
    memoryMode: "everything"
  });

  assert.equal(response.statusCode, 400);
});

test("GET /control/memory/cohorts rejects an inverted or unbounded time window with 400", async () => {
  const inverted = await callCohortRoute(mockMemoryService(), [], {
    workspaceId: "ws-1",
    repositoryId: "repo-1",
    includeTaskHistory: "true",
    occurredFrom: "2026-09-02T00:00:00.000Z",
    occurredUntil: "2026-09-01T00:00:00.000Z"
  });
  assert.equal(inverted.response.statusCode, 400);

  // The same 365-day ceiling every other Memory read carries, so an operator
  // gets one answer for "how far back can I look".
  const overlong = await callCohortRoute(mockMemoryService(), [], {
    workspaceId: "ws-1",
    repositoryId: "repo-1",
    includeTaskHistory: "true",
    occurredFrom: "2024-01-01T00:00:00.000Z",
    occurredUntil: "2026-01-01T00:00:00.000Z"
  });
  assert.equal(overlong.response.statusCode, 400);
});

test("POST /control/memory/cohorts returns 405 Method Not Allowed", async () => {
  const { response } = await callCohortRoute(
    mockMemoryService(),
    [],
    {},
    {
      method: "POST",
      disableTaskHistoryEnv: true
    }
  );

  assert.equal(response.statusCode, 405);
});
