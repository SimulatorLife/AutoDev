import assert from "node:assert/strict";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import test from "node:test";

import type {
  ExperienceEnvelope,
  MemoryInjectionEvent,
  MemoryInjectionUseCohortCell,
  MemoryInjectionUseCohortFilter,
  MemoryInjectionUseCohortPage,
  MemoryInjectionUseJoin,
  MemoryInjectionUseJoinPage,
  MemoryInjectionUseJoinRequest,
  MemoryReadContext,
  MemoryRecordUseReportInput,
  MemoryUseReport
} from "@simulatorlife/autodev-core";
import {
  MemoryConflictError,
  type MemoryService
} from "@simulatorlife/autodev-runtime/memory";

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
  errorMessage: string | null = null;
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

interface CallRouteResult {
  readonly response: RecordedResponse;
  readonly body: Record<string, unknown> | null;
}

async function callRoute(
  service: MemoryService,
  auditRecords: Array<Record<string, unknown>>,
  pathname: string,
  query: Record<string, string | string[]>,
  options: {
    readonly actorRole?: "viewer" | "operator";
    readonly method?: string;
    readonly body?: Record<string, unknown>;
    readonly disableTaskHistoryEnv?: boolean;
  } = {}
): Promise<CallRouteResult> {
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
  const request = makeRequest(
    method,
    `${pathname}?${search.toString()}`,
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

function mockExperience(id = "exp-1"): ExperienceEnvelope {
  return {
    id,
    workspaceId: "ws-1",
    repositoryId: "repo-1",
    scope: {
      kind: "task",
      workspaceId: "ws-1",
      taskId: "task-1",
      runId: "run-1"
    },
    taskId: "task-1",
    runId: "run-1",
    agentId: "agent-1",
    startedAt: "2026-09-01T10:00:00.000Z",
    completedAt: "2026-09-01T10:05:00.000Z",
    outcome: "success",
    memoryMode: "jit",
    trajectory: {
      recordCount: 1,
      format: "text",
      uri: "codex://captured/exp-1"
    },
    evidence: []
  };
}

function mockInjectionEvent(
  id = "event-1",
  overrides: Partial<MemoryInjectionEvent> = {}
): MemoryInjectionEvent {
  return {
    id,
    workspaceId: "ws-1",
    repositoryId: "repo-1",
    scope: {
      kind: "task",
      workspaceId: "ws-1",
      taskId: "task-1",
      runId: "run-1"
    },
    taskId: "task-1",
    runId: "run-1",
    agentId: "agent-1",
    correlationToken: `token-${id}`,
    memoryMode: "jit",
    injectionResult: "injected",
    packetCharacterCount: 64,
    packetTokenCount: 16,
    memoryIds: ["mem-1", "mem-2"],
    occurredAt: "2026-09-01T10:00:00.000Z",
    reasonCode: "packet_attached",
    evidence: [],
    recordedBy: "test-recorder",
    ...overrides
  };
}

function mockUseReport(
  event: MemoryInjectionEvent,
  overrides: Partial<MemoryUseReport> = {}
): MemoryUseReport {
  const useKind = overrides.useKind ?? "used";
  return {
    id: `report-${event.id}`,
    injectionEventId: event.id,
    workspaceId: event.workspaceId,
    repositoryId: event.repositoryId ?? "repo-1",
    scope: event.scope,
    taskId: event.taskId,
    runId: event.runId,
    agentId: event.agentId,
    correlationToken: event.correlationToken,
    useKind,
    usedMemoryIds:
      useKind === "used"
        ? [...event.memoryIds]
        : useKind === "partially_used"
          ? event.memoryIds.slice(0, 1)
          : [],
    reportedAt: "2026-09-01T10:00:30.000Z",
    reporterId: "mock-reporter",
    reporterAuthority: "curator",
    reasonCode:
      useKind === "unobservable"
        ? "reporter_unobservable"
        : "reporter_supplied",
    evidence:
      useKind === "unobservable"
        ? []
        : [{ kind: "trajectory", uri: mockExperience().trajectory.uri }],
    ...overrides
  };
}

interface BuildMockServiceOptions {
  readonly experience?: ExperienceEnvelope;
  readonly injectionEvents?: readonly MemoryInjectionEvent[];
  readonly useReports?: readonly MemoryUseReport[];
  readonly recordError?: Error;
}
function buildMockService(
  options: BuildMockServiceOptions = {}
): MemoryService {
  const exp = options.experience ?? mockExperience();
  const events = options.injectionEvents ?? [];
  const reports = options.useReports ?? [];
  const joins: MemoryInjectionUseJoin[] = events.map((event) => {
    const report = reports.find((r) => r.injectionEventId === event.id);
    return {
      injection: event,
      use: report ?? null,
      sessionInjectionCount: events.length
    };
  });
  const aggregateCells: MemoryInjectionUseCohortCell[] = events
    .filter((event) => event.injectionResult === "injected")
    .map((event) => {
      const report = reports.find((r) => r.injectionEventId === event.id);
      return {
        memoryMode: "jit",
        sessionCardinality: events.length > 1 ? "multiple" : "single",
        useKind: report?.useKind ?? null,
        exposureCount: 1
      };
    });

  return {
    getExperience: async (id: string, _ctx: MemoryReadContext) =>
      id === exp.id ? exp : null,
    recordInjectionUseReport: async (
      input: MemoryRecordUseReportInput
    ): Promise<{ readonly appended: boolean; readonly id: string }> => {
      if (options.recordError) throw options.recordError;
      const existing = reports.find(
        (r) => r.correlationToken === input.report.correlationToken
      );
      if (existing) {
        if (
          existing.useKind === input.report.useKind &&
          existing.usedMemoryIds.length === input.report.usedMemoryIds.length
        ) {
          return { appended: false, id: existing.id };
        }
        throw new MemoryConflictError(
          "Injection use report conflicts with previously recorded report."
        );
      }
      return { appended: true, id: "mock-report-id" };
    },
    listInjectionUseJoins: async (
      request: MemoryInjectionUseJoinRequest
    ): Promise<MemoryInjectionUseJoinPage> => {
      const items = joins.filter(
        (join) =>
          request.context.workspaceId === join.injection.workspaceId &&
          (request.context.repositoryId === undefined ||
            request.context.repositoryId === join.injection.repositoryId) &&
          (request.context.taskId === undefined ||
            request.context.taskId === join.injection.taskId) &&
          (request.includeUnassessed !== false || join.use !== null)
      );
      return { items, total: items.length, limit: 50, offset: 0 };
    },
    aggregateInjectionUseCohorts: async (
      request: MemoryInjectionUseCohortFilter
    ): Promise<MemoryInjectionUseCohortPage> => {
      void request;
      return {
        schema: "autodev-memory-injection-use-cohorts-v1",
        workspaceId: "ws-1",
        repositoryId: "repo-1",
        occurredFrom: "2026-09-01T00:00:00.000Z",
        occurredUntil: "2026-09-30T00:00:00.000Z",
        cells: aggregateCells,
        exposureCount: aggregateCells.reduce(
          (sum, cell) => sum + cell.exposureCount,
          0
        )
      };
    }
  } as unknown as MemoryService;
}

test("GET /control/memory/experiences/:id/use-assessments returns only safe fields (no correlation token, reporter, or report id)", async () => {
  const auditRecords: Array<Record<string, unknown>> = [];
  const exp = mockExperience();
  const event = mockInjectionEvent("event-1");
  const useReport = mockUseReport(event);
  const service = buildMockService({
    experience: exp,
    injectionEvents: [event],
    useReports: [useReport]
  });

  const result = await callRoute(
    service,
    auditRecords,
    `/control/memory/experiences/${encodeURIComponent(exp.id)}/use-assessments`,
    {
      workspaceId: "ws-1",
      repositoryId: "repo-1",
      includeTaskHistory: "true"
    }
  );

  assert.equal(result.response.statusCode, 200);
  assert.equal(
    result.body?.schema,
    "autodev-memory-injection-use-assessments-v1"
  );
  const items = (result.body?.items as Array<Record<string, unknown>>) ?? [];
  assert.equal(items.length, 1);
  const first = items[0] ?? {};
  const injection = (first.injection ?? {}) as Record<string, unknown>;
  const use = (first.use ?? {}) as Record<string, unknown>;

  // The Control API response must not leak correlation tokens, reporter IDs,
  // report IDs, or task/run/agent IDs onto the wire.
  assert.equal("correlationToken" in injection, false);
  assert.equal("taskId" in injection, false);
  assert.equal("runId" in injection, false);
  assert.equal("agentId" in injection, false);
  assert.equal("workspaceId" in injection, false);
  assert.equal("repositoryId" in injection, false);
  assert.equal("recordedBy" in injection, false);

  assert.equal("id" in use, false);
  assert.equal("reporterId" in use, false);
  assert.equal("reporterAuthority" in use, false);
  assert.equal("correlationToken" in use, false);
  assert.equal("injectionEventId" in use, false);

  // Only the safe bounded fields surface.
  assert.equal(typeof injection.id, "string");
  assert.equal(typeof injection.memoryMode, "string");
  assert.equal(typeof injection.injectionResult, "string");
  assert.equal(typeof injection.packetCharacterCount, "number");
  assert.equal(typeof injection.occurredAt, "string");
  assert.ok(Array.isArray(injection.memoryIds));

  assert.equal(use.useKind, "used");
  assert.ok(Array.isArray(use.usedMemoryIds));
  assert.ok(Array.isArray(use.evidence));
});

test("POST /control/memory/experiences/:id/use-assessments accepts only the bounded body and rejects caller-supplied scope/token fields", async () => {
  const auditRecords: Array<Record<string, unknown>> = [];
  const exp = mockExperience();
  const service = buildMockService({ experience: exp });

  // Extra keys rejected as schema violation.
  const tooMany = await callRoute(
    service,
    auditRecords,
    `/control/memory/experiences/${encodeURIComponent(exp.id)}/use-assessments`,
    {
      workspaceId: "ws-1",
      repositoryId: "repo-1",
      includeTaskHistory: "true"
    },
    {
      method: "POST",
      body: {
        injectionEventId: "event-1",
        useKind: "used",
        usedMemoryIds: ["mem-1", "mem-2"],
        evidence: [{ kind: "trajectory", uri: exp.trajectory.uri }],
        correlationToken: "caller-supplied-correlation-token",
        callerScope: { workspaceId: "ws-1" }
      }
    }
  );
  assert.equal(tooMany.response.statusCode, 400);

  // Valid request returns schema and 200.
  const valid = await callRoute(
    service,
    auditRecords,
    `/control/memory/experiences/${encodeURIComponent(exp.id)}/use-assessments`,
    {
      workspaceId: "ws-1",
      repositoryId: "repo-1",
      includeTaskHistory: "true"
    },
    {
      method: "POST",
      body: {
        injectionEventId: "event-1",
        useKind: "used",
        usedMemoryIds: ["mem-1", "mem-2"],
        evidence: [{ kind: "trajectory", uri: exp.trajectory.uri }]
      }
    }
  );
  assert.equal(valid.response.statusCode, 200);
  assert.equal(valid.body?.schema, "autodev-memory-injection-use-report-v1");
  assert.equal(valid.body?.appended, true);
});

test("GET /control/memory/experiences/:id/use-assessments rejects viewer role with 403", async () => {
  const auditRecords: Array<Record<string, unknown>> = [];
  const exp = mockExperience();
  const service = buildMockService({ experience: exp });

  const result = await callRoute(
    service,
    auditRecords,
    `/control/memory/experiences/${encodeURIComponent(exp.id)}/use-assessments`,
    {
      workspaceId: "ws-1",
      repositoryId: "repo-1",
      includeTaskHistory: "true"
    },
    { actorRole: "viewer" }
  );

  assert.equal(result.response.statusCode, 403);
});

test("GET /control/memory/experiences/:id/use-assessments rejects missing includeTaskHistory with 403", async () => {
  const auditRecords: Array<Record<string, unknown>> = [];
  const exp = mockExperience();
  const service = buildMockService({ experience: exp });

  const result = await callRoute(
    service,
    auditRecords,
    `/control/memory/experiences/${encodeURIComponent(exp.id)}/use-assessments`,
    {
      workspaceId: "ws-1",
      repositoryId: "repo-1"
    }
  );

  assert.equal(result.response.statusCode, 403);
});

test("GET /control/memory/experiences/:id/use-assessments rejects missing repository with 400", async () => {
  const auditRecords: Array<Record<string, unknown>> = [];
  const exp = mockExperience();
  const service = buildMockService({ experience: exp });

  const result = await callRoute(
    service,
    auditRecords,
    `/control/memory/experiences/${encodeURIComponent(exp.id)}/use-assessments`,
    {
      workspaceId: "ws-1",
      includeTaskHistory: "true"
    }
  );

  assert.equal(result.response.statusCode, 400);
});

test("GET /control/memory/use-cohorts returns counts and cells only (no IDs/tokens)", async () => {
  const auditRecords: Array<Record<string, unknown>> = [];
  const service = buildMockService();

  const result = await callRoute(
    service,
    auditRecords,
    "/control/memory/use-cohorts",
    {
      workspaceId: "ws-1",
      repositoryId: "repo-1",
      includeTaskHistory: "true",
      occurredFrom: "2026-09-01T00:00:00.000Z",
      occurredUntil: "2026-09-30T00:00:00.000Z"
    }
  );

  assert.equal(result.response.statusCode, 200);
  assert.equal(result.body?.schema, "autodev-memory-injection-use-cohorts-v1");
  const cells = (result.body?.cells as Array<Record<string, unknown>>) ?? [];
  for (const cell of cells) {
    assert.equal("correlationToken" in cell, false);
    assert.equal("reporterId" in cell, false);
    assert.equal("usedMemoryIds" in cell, false);
    assert.equal("injectionEventId" in cell, false);
    assert.equal("taskId" in cell, false);
    assert.equal("runId" in cell, false);
    assert.equal("agentId" in cell, false);
  }
  assert.equal(typeof result.body?.exposureCount, "number");
});

test("GET /control/memory/use-cohorts rejects viewer role with 403", async () => {
  const auditRecords: Array<Record<string, unknown>> = [];
  const service = buildMockService();

  const result = await callRoute(
    service,
    auditRecords,
    "/control/memory/use-cohorts",
    {
      workspaceId: "ws-1",
      repositoryId: "repo-1",
      includeTaskHistory: "true",
      occurredFrom: "2026-09-01T00:00:00.000Z",
      occurredUntil: "2026-09-30T00:00:00.000Z"
    },
    { actorRole: "viewer" }
  );

  assert.equal(result.response.statusCode, 403);
});

test("GET /control/memory/use-cohorts rejects caller-selected taskId/runId/agentId with 400", async () => {
  const auditRecords: Array<Record<string, unknown>> = [];
  const service = buildMockService();

  const result = await callRoute(
    service,
    auditRecords,
    "/control/memory/use-cohorts",
    {
      workspaceId: "ws-1",
      repositoryId: "repo-1",
      includeTaskHistory: "true",
      occurredFrom: "2026-09-01T00:00:00.000Z",
      occurredUntil: "2026-09-30T00:00:00.000Z",
      taskId: "task-1"
    }
  );

  assert.equal(result.response.statusCode, 400);
});

test("POST /control/memory/use-cohorts returns 405 Method Not Allowed", async () => {
  const auditRecords: Array<Record<string, unknown>> = [];
  const service = buildMockService();

  const result = await callRoute(
    service,
    auditRecords,
    "/control/memory/use-cohorts",
    {
      workspaceId: "ws-1",
      repositoryId: "repo-1",
      includeTaskHistory: "true",
      occurredFrom: "2026-09-01T00:00:00.000Z",
      occurredUntil: "2026-09-30T00:00:00.000Z"
    },
    { method: "POST", body: {} }
  );

  assert.equal(result.response.statusCode, 405);
});
