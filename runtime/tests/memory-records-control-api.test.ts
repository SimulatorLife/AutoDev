import assert from "node:assert/strict";
import test from "node:test";

import type {
  ExperienceEnvelope,
  MemoryHistory,
  MemoryRecord,
  MemoryRecordPage,
  MemoryStatusCounts,
  MemoryWhyResult
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
 * The `/control/memory/records` family — listing, detail, and `why` — had no
 * route-level test. `memory.test.ts` exercises the service directly and
 * `memory-record-history-control-api.test.ts` covers only the `history`
 * subresource, so every one of these three routes ran uncovered on an ordinary
 * `node --test`. The records listing is the Console's primary Memory read, so
 * that gap sat under the surface operators use most.
 */

interface CallResult {
  readonly response: RecordedResponse;
  readonly body: Record<string, unknown> | null;
}

async function callRoute(
  service: MemoryService,
  pathname: string,
  query: Record<string, string | string[]> = {},
  options: {
    readonly actorRole?: "viewer" | "operator";
    readonly method?: string;
    readonly body?: Record<string, unknown>;
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
    suffix ? `${pathname}?${suffix}` : pathname,
    options.body
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

/** Every lifecycle state present, zeros included — the Console cannot derive it. */
const ALL_STATUSES: MemoryStatusCounts = {
  proposed: 1,
  active: 2,
  uncertain: 0,
  superseded: 1,
  invalidated: 0
};

function record(overrides: Partial<MemoryRecord> = {}): MemoryRecord {
  return {
    id: "mem-1",
    workspaceId: "ws-1",
    repositoryId: "repo-1",
    scope: { kind: "repository", workspaceId: "ws-1", repositoryId: "repo-1" },
    kind: "semantic",
    claim: "The retry budget lives in config/runtime.json.",
    content: "The retry budget lives in config/runtime.json.",
    status: "active",
    confidence: 0.4,
    createdAt: "2026-10-01T10:00:00.000Z",
    updatedAt: "2026-10-02T10:00:00.000Z",
    validity: { state: "verified", evidence: [] },
    provenance: {
      experienceIds: [],
      evidence: [],
      createdBy: "operator",
      createdAt: "2026-10-01T10:00:00.000Z"
    },
    ...overrides
  } as MemoryRecord;
}

function page(items: readonly MemoryRecord[], total: number): MemoryRecordPage {
  return {
    items,
    total,
    limit: items.length,
    offset: 0
  } as MemoryRecordPage;
}

function mockService(
  overrides: Partial<Record<keyof MemoryService, unknown>> = {}
): MemoryService {
  return {
    listMemories: async () => ({
      ...page([record()], 1),
      statusCounts: ALL_STATUSES
    }),
    get: async () => record(),
    why: async () =>
      ({
        memory: record(),
        relatedMemories: [],
        sourceExperiences: []
      }) as unknown as MemoryWhyResult,
    history: async () => null as MemoryHistory | null,
    ...overrides
  } as unknown as MemoryService;
}

test("GET /control/memory/records returns the page with a whole-collection status breakdown", async () => {
  let captured: Record<string, unknown> | undefined;
  const service = mockService({
    listMemories: async (req: Record<string, unknown>) => {
      captured = req;
      return {
        items: [record()],
        total: 1204,
        limit: 25,
        offset: 0,
        statusCounts: ALL_STATUSES
      };
    }
  });

  const { response, body } = await callRoute(
    service,
    "/control/memory/records",
    {
      workspaceId: "ws-1",
      repositoryId: "repo-1"
    }
  );

  assert.equal(response.statusCode, 200);
  assert.equal(body?.schema, "autodev-memory-records-v1");
  // The store's own total, not the size of the returned window.
  assert.equal(body?.total, 1204);
  assert.equal(body?.limit, 25);
  // Every status present, zeros included — counting off the page would report
  // at most `limit` active claims beside a total of 1,204 and read as a share.
  assert.deepEqual(body?.statusCounts, ALL_STATUSES);
  assert.equal(captured?.workspaceId, undefined);
});

test("GET /control/memory/records forwards kind, status and paging filters", async () => {
  let captured: Record<string, unknown> | undefined;
  const service = mockService({
    listMemories: async (req: Record<string, unknown>) => {
      captured = req;
      return {
        items: [],
        total: 0,
        limit: 25,
        offset: 0,
        statusCounts: ALL_STATUSES
      };
    }
  });

  const { response } = await callRoute(service, "/control/memory/records", {
    workspaceId: "ws-1",
    repositoryId: "repo-1",
    kind: "semantic",
    status: ["active", "uncertain"],
    limit: "10",
    offset: "20",
    query: "retry budget"
  });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(captured?.kinds, ["semantic"]);
  assert.deepEqual(captured?.statuses, ["active", "uncertain"]);
  assert.equal(captured?.limit, 10);
  assert.equal(captured?.offset, 20);
  assert.equal(captured?.query, "retry budget");
});

test("GET /control/memory/records reports an empty collection as a page, not a failure", async () => {
  const service = mockService({
    listMemories: async () => ({
      items: [],
      total: 0,
      limit: 25,
      offset: 0,
      statusCounts: ALL_STATUSES
    })
  });

  const { response, body } = await callRoute(
    service,
    "/control/memory/records",
    {
      workspaceId: "ws-1",
      repositoryId: "repo-1"
    }
  );

  assert.equal(response.statusCode, 200);
  assert.equal(body?.schema, "autodev-memory-records-v1");
  assert.deepEqual(body?.items, []);
  assert.equal(body?.total, 0);
});

test("GET /control/memory/records rejects an unbounded status with 400", async () => {
  const { response } = await callRoute(
    serviceOrEmpty(),
    "/control/memory/records",
    {
      workspaceId: "ws-1",
      repositoryId: "repo-1",
      status: "everything"
    }
  );

  assert.equal(response.statusCode, 400);
});

function serviceOrEmpty(): MemoryService {
  return mockService();
}

test("GET /control/memory/records is readable by a viewer, who cannot mutate", async () => {
  // Reads are not role-gated here: `viewer` is the read-only role, and the
  // Console's records surface is a read. Only mutations refuse a viewer, which
  // is a separate assertion below — writing a test that a viewer is refused a
  // read would have "fixed" a restriction the design does not have.
  const { response } = await callRoute(
    mockService(),
    "/control/memory/records",
    { workspaceId: "ws-1", repositoryId: "repo-1" },
    { actorRole: "viewer" }
  );

  assert.equal(response.statusCode, 200);
});

test("POST /control/memory/records refuses a viewer with 403", async () => {
  const { response } = await callRoute(
    mockService(),
    "/control/memory/records",
    { workspaceId: "ws-1", repositoryId: "repo-1" },
    { actorRole: "viewer", method: "POST" }
  );

  assert.equal(response.statusCode, 403);
  assert.equal(errorCode(response), "autodev_memory_viewer_forbidden");
});

/** `errorBody` nests the machine-readable code one level down. */
function errorCode(response: RecordedResponse): unknown {
  const body = responseBody(response) as { error?: { code?: unknown } } | null;
  return body?.error?.code;
}

test("GET /control/memory/records/:id returns the record", async () => {
  const { response, body } = await callRoute(
    mockService(),
    "/control/memory/records/mem-1",
    { workspaceId: "ws-1", repositoryId: "repo-1" }
  );

  assert.equal(response.statusCode, 200);
  assert.equal(body?.schema, "autodev-memory-record-v1");
  const memory = body?.memory as MemoryRecord;
  assert.equal(memory.id, "mem-1");
});

test("GET /control/memory/records/:id answers 404 for an unknown record", async () => {
  const { response } = await callRoute(
    mockService({ get: async () => null }),
    "/control/memory/records/mem-missing",
    { workspaceId: "ws-1", repositoryId: "repo-1" }
  );

  assert.equal(response.statusCode, 404);
  assert.equal(errorCode(response), "autodev_memory_not_found");
});

test("GET /control/memory/records/:id/why explains the claim and names its source experiences", async () => {
  const experience = {
    id: "exp-1",
    workspaceId: "ws-1",
    scope: { kind: "workspace", workspaceId: "ws-1" },
    taskId: "task-1",
    runId: "run-1",
    agentId: "agent-orch",
    startedAt: "2026-10-03T10:00:00.000Z",
    outcome: "success",
    trajectory: { steps: [] }
  } as unknown as ExperienceEnvelope;

  const { response, body } = await callRoute(
    mockService({
      // `events` is present and non-empty on purpose. The route must not carry
      // it onto this response, and an assertion that `transitions` is absent
      // only has teeth if the value it would leak is one `JSON.stringify`
      // actually writes -- an `undefined` here is dropped before parsing and
      // the check would pass no matter what the route did.
      why: async () => ({
        memory: record(),
        relatedMemories: [record({ id: "mem-2" })],
        sourceExperiences: [experience],
        events: [
          {
            memoryId: "mem-1",
            actorId: "operator",
            occurredAt: "2026-10-02T10:00:00.000Z",
            fromStatus: "uncertain",
            toStatus: "active"
          }
        ]
      })
    }),
    "/control/memory/records/mem-1/why",
    { workspaceId: "ws-1", repositoryId: "repo-1" }
  );

  assert.equal(response.statusCode, 200);
  assert.equal(body?.schema, "autodev-memory-why-v1");
  assert.equal((body?.memory as MemoryRecord).id, "mem-1");
  assert.equal((body?.relatedMemories as MemoryRecord[]).length, 1);
  // The explanation names what this reader can still resolve; transitions have
  // their own response and must not leak onto this one.
  assert.equal((body?.sourceExperiences as ExperienceEnvelope[]).length, 1);
  assert.equal("transitions" in body!, false);
  assert.equal("events" in body!, false);
});

test("GET /control/memory/records/:id/why answers 404 for an unknown record", async () => {
  const { response } = await callRoute(
    mockService({ why: async () => null }),
    "/control/memory/records/mem-missing/why",
    { workspaceId: "ws-1", repositoryId: "repo-1" }
  );

  assert.equal(response.statusCode, 404);
  assert.equal(errorCode(response), "autodev_memory_not_found");
});

test("GET /control/memory/records/:id is readable by a viewer", async () => {
  const { response } = await callRoute(
    mockService(),
    "/control/memory/records/mem-1",
    { workspaceId: "ws-1", repositoryId: "repo-1" },
    { actorRole: "viewer" }
  );

  assert.equal(response.statusCode, 200);
});

test("POST /control/memory/records is refused by the body checks before the method gate", async () => {
  // The body is read before the method is rejected, so neither of these reaches
  // the 405: a POST carrying nothing fails on media type, and one carrying a
  // JSON object fails validation. Asserting 405 here would have documented an
  // order the route does not have.
  const withoutBody = await callRoute(
    mockService(),
    "/control/memory/records",
    { workspaceId: "ws-1", repositoryId: "repo-1" },
    { method: "POST" }
  );
  assert.equal(withoutBody.response.statusCode, 415);
  assert.equal(
    errorCode(withoutBody.response),
    "autodev_control_api_content_type"
  );

  const withBody = await callRoute(
    mockService(),
    "/control/memory/records",
    { workspaceId: "ws-1", repositoryId: "repo-1" },
    { method: "POST", body: {} }
  );
  assert.equal(withBody.response.statusCode, 400);
  assert.equal(errorCode(withBody.response), "autodev_memory_invalid_request");
});
