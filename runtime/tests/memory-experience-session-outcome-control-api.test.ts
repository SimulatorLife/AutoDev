import assert from "node:assert/strict";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import test from "node:test";

import type {
  ExperienceEnvelope,
  MemoryReadContext,
  MemoryRecordSessionOutcomeReportInput,
  MemorySessionOutcomeReport
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

async function callExperienceSessionOutcomeRoute(
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
      runId: "task-1"
    },
    taskId: "task-1",
    runId: "task-1",
    agentId: "agent-1",
    startedAt: "2026-09-01T10:00:00.000Z",
    completedAt: "2026-09-01T10:05:00.000Z",
    outcome: "success",
    memoryMode: "jit",
    trajectory: {
      recordCount: 1,
      format: "text",
      uri: "https://example.com/traj"
    },
    evidence: []
  };
}

test("POST and GET /control/memory/experiences/:id/session-outcomes lifecycle", async () => {
  const auditRecords: Array<Record<string, unknown>> = [];
  const exp = mockExperience("exp-1");
  let storedReport: MemorySessionOutcomeReport | null = null;

  const mockService = {
    getExperience: async (id: string, _ctx: MemoryReadContext) => {
      return id === exp.id ? exp : null;
    },
    recordSessionOutcomeReport: async (
      input: MemoryRecordSessionOutcomeReportInput
    ) => {
      if (storedReport) {
        if (
          storedReport.outcomeKind === input.report.outcomeKind &&
          storedReport.reportKind === input.report.reportKind
        ) {
          return { appended: false, id: storedReport.id };
        }
        throw new MemoryConflictError(
          "Session outcome report conflicts with previously recorded report."
        );
      }
      storedReport = input.report;
      return { appended: true, id: input.report.id };
    },
    getSessionOutcomeReport: async (
      ws: string,
      repo: string,
      task: string,
      _ctx: MemoryReadContext
    ) => {
      if (
        storedReport &&
        storedReport.workspaceId === ws &&
        storedReport.repositoryId === repo &&
        storedReport.taskId === task
      ) {
        return storedReport;
      }
      return null;
    }
  } as unknown as MemoryService;

  const validBody = {
    outcomeKind: "success",
    reportKind: "pull_request",
    evidence: [
      {
        kind: "pull_request",
        uri: "https://github.com/owner/repo/pull/123"
      }
    ]
  };

  // 1. Initial POST succeeds (appended: true)
  const postResult = await callExperienceSessionOutcomeRoute(
    mockService,
    auditRecords,
    "/control/memory/experiences/exp-1/session-outcomes",
    {
      workspaceId: "ws-1",
      repositoryId: "repo-1",
      includeTaskHistory: "true"
    },
    {
      method: "POST",
      body: validBody
    }
  );

  assert.equal(postResult.response.statusCode, 200);
  assert.equal(
    postResult.body?.schema,
    "autodev-memory-session-outcome-report-v1"
  );
  assert.equal(postResult.body?.experienceId, "exp-1");
  assert.equal(postResult.body?.appended, true);

  const postAudit = auditRecords.find(
    (r) => r.action === "report_session_outcome"
  );
  assert.ok(postAudit);
  assert.equal(postAudit?.outcome, "ok");

  // 2. Same-body POST retry is idempotent (appended: false)
  const retryResult = await callExperienceSessionOutcomeRoute(
    mockService,
    auditRecords,
    "/control/memory/experiences/exp-1/session-outcomes",
    {
      workspaceId: "ws-1",
      repositoryId: "repo-1",
      includeTaskHistory: "true"
    },
    {
      method: "POST",
      body: validBody
    }
  );
  assert.equal(retryResult.response.statusCode, 200);
  assert.equal(retryResult.body?.appended, false);

  // 3. GET /session-outcomes succeeds and returns stored report
  const getResult = await callExperienceSessionOutcomeRoute(
    mockService,
    auditRecords,
    "/control/memory/experiences/exp-1/session-outcomes",
    {
      workspaceId: "ws-1",
      repositoryId: "repo-1",
      includeTaskHistory: "true"
    },
    {
      method: "GET"
    }
  );
  assert.equal(getResult.response.statusCode, 200);
  assert.equal(
    getResult.body?.schema,
    "autodev-memory-session-outcome-report-v1"
  );
  assert.equal(getResult.body?.experienceId, "exp-1");
  const retrieved = getResult.body?.report as Record<string, unknown>;
  assert.equal(retrieved.outcomeKind, "success");
  assert.equal(retrieved.reportKind, "pull_request");

  const getAudit = auditRecords.find(
    (r) => r.action === "read_session_outcome"
  );
  assert.ok(getAudit);

  // 4. Conflicting body returns 409 Conflict
  const conflictResult = await callExperienceSessionOutcomeRoute(
    mockService,
    auditRecords,
    "/control/memory/experiences/exp-1/session-outcomes",
    {
      workspaceId: "ws-1",
      repositoryId: "repo-1",
      includeTaskHistory: "true"
    },
    {
      method: "POST",
      body: {
        outcomeKind: "failure",
        reportKind: "pull_request",
        evidence: [
          {
            kind: "issue",
            uri: "https://github.com/owner/repo/issues/123"
          }
        ]
      }
    }
  );
  assert.equal(conflictResult.response.statusCode, 409);

  // 5. Singular alias `/session-outcome` also works for GET
  const singularGetResult = await callExperienceSessionOutcomeRoute(
    mockService,
    auditRecords,
    "/control/memory/experiences/exp-1/session-outcome",
    {
      workspaceId: "ws-1",
      repositoryId: "repo-1",
      includeTaskHistory: "true"
    },
    {
      method: "GET"
    }
  );
  assert.equal(singularGetResult.response.statusCode, 200);
});

test("POST /control/memory/experiences/:id/session-outcomes rejects caller-selected id", async () => {
  const auditRecords: Array<Record<string, unknown>> = [];
  const exp = mockExperience("exp-1");
  const mockService = {
    getExperience: async () => exp
  } as unknown as MemoryService;

  const result = await callExperienceSessionOutcomeRoute(
    mockService,
    auditRecords,
    "/control/memory/experiences/exp-1/session-outcomes",
    {
      workspaceId: "ws-1",
      repositoryId: "repo-1",
      includeTaskHistory: "true"
    },
    {
      method: "POST",
      body: {
        id: "caller-selected-id",
        outcomeKind: "success",
        reportKind: "pull_request",
        evidence: [{ kind: "pull_request", uri: "https://example.com" }]
      }
    }
  );

  assert.equal(result.response.statusCode, 400);
});
