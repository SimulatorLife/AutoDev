import assert from "node:assert/strict";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import test from "node:test";

import type {
  MemorySessionOutcomeCohortFilter,
  MemorySessionOutcomeCohortPage
} from "@simulatorlife/autodev-core";
import type { MemoryService } from "@simulatorlife/autodev-runtime/memory";

import { handleMemoryControlApiRequest } from "../src/control-api/memory.ts";

interface RecordedResponse extends ServerResponse {
  readonly statusCode: number;
  readonly headers: Record<string, string | number>;
  readonly body: string;
}

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
    if (headers) Object.assign(this.headers, headers);
    this.headersSent = true;
    return this;
  }

  write(chunk: string | Buffer): boolean {
    this.chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    return true;
  }

  end(chunk?: string | Buffer): this {
    if (chunk) {
      this.chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    this.body = Buffer.concat(this.chunks).toString("utf8");
    this.writableEnded = true;
    return this;
  }
}

function responseRecorder(): RecordedResponse {
  return new ResponseRecorder() as unknown as RecordedResponse;
}

function responseBody(
  response: RecordedResponse
): Record<string, unknown> | null {
  if (!response.body) return null;
  try {
    return JSON.parse(response.body) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function makeRequest(
  method: string,
  url: string,
  body?: Record<string, unknown>
): IncomingMessage {
  const stream = Readable.from(body ? [JSON.stringify(body)] : []);
  return Object.assign(stream, {
    method,
    url,
    headers: body ? { "content-type": "application/json" } : {}
  }) as IncomingMessage;
}

interface CallCohortResult {
  readonly response: RecordedResponse;
  readonly body: Record<string, unknown> | null;
}

async function callSessionCohortRoute(
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
  const pathname = "/control/memory/session-cohorts";
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (Array.isArray(value)) {
      for (const item of value) search.append(key, item);
    } else {
      search.set(key, value);
    }
  }
  const request = makeRequest(method, `${pathname}?${search.toString()}`);
  const response = responseRecorder();
  const prevEnv = process.env.AUTODEV_MEMORY_READ_TASK_HISTORY;
  if (!options.disableTaskHistoryEnv) {
    process.env.AUTODEV_MEMORY_READ_TASK_HISTORY = "1";
  } else {
    delete process.env.AUTODEV_MEMORY_READ_TASK_HISTORY;
  }
  try {
    await handleMemoryControlApiRequest(
      request,
      response,
      pathname,
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
    req: MemorySessionOutcomeCohortFilter
  ) => Promise<MemorySessionOutcomeCohortPage>
): MemoryService {
  const defaultPage: MemorySessionOutcomeCohortPage = {
    schema: "autodev-memory-session-outcome-cohorts-v1",
    workspaceId: "ws-1",
    repositoryId: "repo-1",
    occurredFrom: "2026-09-01T00:00:00.000Z",
    occurredUntil: "2026-09-02T00:00:00.000Z",
    cells: [
      {
        memoryMode: "jit",
        outcomeKind: "success",
        sessionCount: 1
      }
    ],
    sessionCount: 1,
    reportedSessionCount: 1,
    unreportedSessionCount: 0,
    conflictingOutcomeSessionCount: 0,
    mixedModeSessionCount: 0
  };
  return {
    aggregateSessionOutcomeCohorts:
      impl ??
      (async (req) => ({
        ...defaultPage,
        workspaceId: req.context.workspaceId,
        repositoryId: req.context.repositoryId!,
        occurredFrom: req.occurredFrom,
        occurredUntil: req.occurredUntil
      }))
  } as unknown as MemoryService;
}

test("GET /control/memory/session-cohorts returns 200 with session page and audits read", async () => {
  const auditRecords: Array<Record<string, unknown>> = [];
  let capturedFilter: MemorySessionOutcomeCohortFilter | undefined;
  const service = mockMemoryService(async (filter) => {
    capturedFilter = filter;
    return {
      schema: "autodev-memory-session-outcome-cohorts-v1",
      workspaceId: filter.context.workspaceId,
      repositoryId: filter.context.repositoryId!,
      occurredFrom: filter.occurredFrom,
      occurredUntil: filter.occurredUntil,
      cells: [
        {
          memoryMode: "jit",
          outcomeKind: "success",
          sessionCount: 3
        },
        {
          memoryMode: "jit",
          outcomeKind: null,
          sessionCount: 1
        }
      ],
      sessionCount: 4,
      reportedSessionCount: 3,
      unreportedSessionCount: 1,
      conflictingOutcomeSessionCount: 2,
      mixedModeSessionCount: 1
    };
  });

  const result = await callSessionCohortRoute(service, auditRecords, {
    workspaceId: "ws-1",
    repositoryId: "repo-1",
    includeTaskHistory: "true",
    occurredFrom: "2026-09-01T00:00:00.000Z",
    occurredUntil: "2026-09-02T00:00:00.000Z",
    memoryMode: "jit"
  });

  assert.equal(result.response.statusCode, 200);
  assert.equal(
    result.body?.schema,
    "autodev-memory-session-outcome-cohorts-v1"
  );
  assert.equal(result.body?.sessionCount, 4);
  assert.equal(result.body?.reportedSessionCount, 3);
  assert.equal(result.body?.unreportedSessionCount, 1);
  assert.equal(result.body?.conflictingOutcomeSessionCount, 2);
  assert.equal(result.body?.mixedModeSessionCount, 1);
  assert.deepEqual(capturedFilter?.memoryModes, ["jit"]);

  const audit = auditRecords.find((r) => r.action === "read_session_cohorts");
  assert.ok(audit);
  assert.equal(audit?.resource, "/control/memory/session-cohorts");
  assert.equal(audit?.outcome, "ok");
});

test("GET /control/memory/session-cohorts rejects viewer role with 403", async () => {
  const auditRecords: Array<Record<string, unknown>> = [];
  const service = mockMemoryService();
  const result = await callSessionCohortRoute(
    service,
    auditRecords,
    {
      workspaceId: "ws-1",
      repositoryId: "repo-1",
      includeTaskHistory: "true",
      occurredFrom: "2026-09-01T00:00:00.000Z",
      occurredUntil: "2026-09-02T00:00:00.000Z"
    },
    { actorRole: "viewer" }
  );

  assert.equal(result.response.statusCode, 403);
});

test("GET /control/memory/session-cohorts rejects missing includeTaskHistory with 403", async () => {
  const auditRecords: Array<Record<string, unknown>> = [];
  const service = mockMemoryService();
  const result = await callSessionCohortRoute(service, auditRecords, {
    workspaceId: "ws-1",
    repositoryId: "repo-1",
    occurredFrom: "2026-09-01T00:00:00.000Z",
    occurredUntil: "2026-09-02T00:00:00.000Z"
  });

  assert.equal(result.response.statusCode, 403);
});

test("GET /control/memory/session-cohorts rejects missing repository with 400", async () => {
  const auditRecords: Array<Record<string, unknown>> = [];
  const service = mockMemoryService();
  const result = await callSessionCohortRoute(service, auditRecords, {
    workspaceId: "ws-1",
    includeTaskHistory: "true",
    occurredFrom: "2026-09-01T00:00:00.000Z",
    occurredUntil: "2026-09-02T00:00:00.000Z"
  });

  assert.equal(result.response.statusCode, 400);
});

test("GET /control/memory/session-cohorts rejects caller-selected taskId/runId/agentId with 400", async () => {
  const auditRecords: Array<Record<string, unknown>> = [];
  const service = mockMemoryService();

  for (const extraKey of ["taskId", "runId", "agentId", "role"]) {
    const result = await callSessionCohortRoute(service, auditRecords, {
      workspaceId: "ws-1",
      repositoryId: "repo-1",
      includeTaskHistory: "true",
      occurredFrom: "2026-09-01T00:00:00.000Z",
      occurredUntil: "2026-09-02T00:00:00.000Z",
      [extraKey]: "caller-selected"
    });
    assert.equal(
      result.response.statusCode,
      400,
      `expected 400 for ${extraKey}`
    );
  }
});

test("GET /control/memory/session-cohorts rejects non-assigned modes with 400", async () => {
  const auditRecords: Array<Record<string, unknown>> = [];
  const service = mockMemoryService();

  for (const mode of ["invalid", "unknown", "mixed", "other"]) {
    const result = await callSessionCohortRoute(service, auditRecords, {
      workspaceId: "ws-1",
      repositoryId: "repo-1",
      includeTaskHistory: "true",
      occurredFrom: "2026-09-01T00:00:00.000Z",
      occurredUntil: "2026-09-02T00:00:00.000Z",
      memoryMode: mode
    });
    assert.equal(
      result.response.statusCode,
      400,
      `expected 400 for mode=${mode}`
    );
  }
});

test("GET /control/memory/session-cohorts rejects invalid time window with 400", async () => {
  const auditRecords: Array<Record<string, unknown>> = [];
  const service = mockMemoryService();

  // until < from
  const inverted = await callSessionCohortRoute(service, auditRecords, {
    workspaceId: "ws-1",
    repositoryId: "repo-1",
    includeTaskHistory: "true",
    occurredFrom: "2026-09-02T00:00:00.000Z",
    occurredUntil: "2026-09-01T00:00:00.000Z"
  });
  assert.equal(inverted.response.statusCode, 400);

  // > 365 days
  const overlong = await callSessionCohortRoute(service, auditRecords, {
    workspaceId: "ws-1",
    repositoryId: "repo-1",
    includeTaskHistory: "true",
    occurredFrom: "2024-01-01T00:00:00.000Z",
    occurredUntil: "2026-01-01T00:00:00.000Z"
  });
  assert.equal(overlong.response.statusCode, 400);
});

test("POST /control/memory/session-cohorts returns 405 Method Not Allowed", async () => {
  const auditRecords: Array<Record<string, unknown>> = [];
  const service = mockMemoryService();
  const result = await callSessionCohortRoute(
    service,
    auditRecords,
    {
      workspaceId: "ws-1",
      repositoryId: "repo-1",
      includeTaskHistory: "true",
      occurredFrom: "2026-09-01T00:00:00.000Z",
      occurredUntil: "2026-09-02T00:00:00.000Z"
    },
    { method: "POST" }
  );

  assert.equal(result.response.statusCode, 405);
  assert.equal(result.response.headers["allow"], "GET");
});
