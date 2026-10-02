import assert from "node:assert/strict";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import test from "node:test";

import {
  type ExperienceEnvelope,
  type MemoryInjectionEvent,
  type MemoryInjectionOutcomeJoinRequest,
  type MemoryOutcomeReport,
  type MemoryReadContext,
  type MemoryRecordOutcomeReportInput
} from "@simulatorlife/autodev-core";
import {
  MemoryConflictError,
  type MemoryService,
  MemoryValidationError
} from "@simulatorlife/autodev-runtime/memory";

import { handleMemoryControlApiRequest } from "../../runtime/src/control-api/memory.ts";

const taskHistoryEnv = "AUTODEV_MEMORY_READ_TASK_HISTORY";
const originalTaskHistoryGrant = process.env[taskHistoryEnv];

const experience: ExperienceEnvelope = {
  id: "codex-session-experience",
  workspaceId: "workspace-a",
  repositoryId: "owner/repo",
  scope: {
    kind: "task",
    workspaceId: "workspace-a",
    taskId: "session-a",
    runId: "session-a"
  },
  taskId: "session-a",
  runId: "session-a",
  agentId: "session-a",
  agentRole: "orchestrator",
  startedAt: "2026-10-01T00:00:00.000Z",
  outcome: "unknown",
  trajectory: {
    format: "letta-trajectory-v1",
    uri: "codex://session/session-a"
  },
  evidence: [{ kind: "trajectory", uri: "codex://session/session-a" }]
};

const injection: MemoryInjectionEvent = {
  id: "injection-a",
  workspaceId: "workspace-a",
  repositoryId: "owner/repo",
  scope: {
    kind: "task",
    workspaceId: "workspace-a",
    taskId: "session-a",
    runId: "router-request-a"
  },
  taskId: "session-a",
  runId: "router-request-a",
  agentId: "thread-a",
  correlationToken: "opaque-injection-token-a",
  memoryMode: "jit",
  injectionResult: "injected",
  packetCharacterCount: 241,
  memoryIds: ["memory-a"],
  occurredAt: "2026-10-01T00:01:00.000Z",
  reasonCode: "packet_attached",
  evidence: [],
  recordedBy: "autodev-router-memory-injection"
};

class OutcomeControlServiceStub {
  readonly reportInputs: MemoryRecordOutcomeReportInput[] = [];
  readonly listRequests: MemoryInjectionOutcomeJoinRequest[] = [];
  readonly experienceContexts: MemoryReadContext[] = [];
  private storedReport: MemoryOutcomeReport | null = null;

  async getExperience(
    id: string,
    context: MemoryReadContext
  ): Promise<ExperienceEnvelope | null> {
    this.experienceContexts.push(context);
    if (
      id !== experience.id ||
      context.workspaceId !== experience.workspaceId ||
      context.repositoryId !== experience.repositoryId
    ) {
      return null;
    }
    return experience;
  }

  async listInjectionOutcomeJoins(request: MemoryInjectionOutcomeJoinRequest) {
    this.listRequests.push(request);
    const outcome = this.storedReport;
    return {
      items: [{ injection, outcome }],
      total: 1,
      limit: request.limit ?? 50,
      offset: request.offset ?? 0
    };
  }

  async recordOutcomeReport(input: MemoryRecordOutcomeReportInput) {
    this.reportInputs.push(input);
    if (
      input.context.taskId !== experience.taskId ||
      input.context.workspaceId !== experience.workspaceId ||
      input.context.repositoryId !== experience.repositoryId ||
      input.report.correlationToken !== injection.correlationToken
    ) {
      throw new MemoryValidationError(
        "Outcome report targets a correlationToken that has no scope-aligned injection event."
      );
    }
    if (this.storedReport) {
      const same =
        this.storedReport.outcomeKind === input.report.outcomeKind &&
        this.storedReport.reportKind === input.report.reportKind &&
        JSON.stringify(this.storedReport.evidence) ===
          JSON.stringify(input.report.evidence);
      if (same) return { appended: false, id: this.storedReport.id };
      throw new MemoryConflictError(
        "Outcome report conflicts with a previously recorded report."
      );
    }
    this.storedReport = input.report;
    return { appended: true, id: input.report.id };
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

type RecordedResponse = ServerResponse & {
  statusCode: number;
  headers: Record<string, string | number>;
  body: string;
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
    Object.assign(this.headers, headers ?? {});
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
}

function responseRecorder(): RecordedResponse {
  return new ResponseRecorder() as unknown as RecordedResponse;
}

const auditRecords: Array<Record<string, unknown>> = [];
const audit = (event: Record<string, unknown>) => auditRecords.push(event);

async function callOutcomeRoute(
  service: OutcomeControlServiceStub,
  method: string,
  body?: Record<string, unknown>,
  options: {
    actor?: "viewer" | "operator";
    experienceId?: string;
    query?: string;
  } = {}
) {
  const url = new URLSearchParams({
    workspaceId: "workspace-a",
    repositoryId: "owner/repo",
    includeTaskHistory: "true",
    ...(options.query
      ? Object.fromEntries(new URLSearchParams(options.query))
      : {})
  });
  const response = responseRecorder();
  await handleMemoryControlApiRequest(
    makeRequest(
      method,
      `/control/memory/experiences/${encodeURIComponent(options.experienceId ?? experience.id)}/outcomes?${url}`,
      body
    ),
    response,
    `/control/memory/experiences/${encodeURIComponent(options.experienceId ?? experience.id)}/outcomes`,
    { actor: "memory-operator", role: options.actor ?? "operator" },
    audit,
    { createMemoryService: () => service as unknown as MemoryService }
  );
  return { response, body: response.body ? JSON.parse(response.body) : null };
}

test("outcome GET exposes request-level injection tokens only in an authorized session view", async () => {
  process.env[taskHistoryEnv] = "1";
  const service = new OutcomeControlServiceStub();
  const { response, body } = await callOutcomeRoute(service, "GET", undefined, {
    actor: "operator"
  });
  assert.equal(response.statusCode, 200);
  assert.equal(body.schema, "autodev-memory-injection-outcomes-v1");
  assert.equal(body.experienceId, experience.id);
  assert.equal(
    body.items[0].injection.correlationToken,
    injection.correlationToken
  );
  assert.equal(service.listRequests[0]?.context.taskId, "session-a");
  assert.equal(service.listRequests[0]?.context.runId, "session-a");
  assert.equal(service.listRequests[0]?.context.agentId, "session-a");
  assert.equal(service.listRequests[0]?.includeUnreported, true);
});

test("outcome GET requires operator task-history authorization and a visible experience", async () => {
  process.env[taskHistoryEnv] = "1";
  const service = new OutcomeControlServiceStub();
  const viewer = await callOutcomeRoute(service, "GET", undefined, {
    actor: "viewer"
  });
  assert.equal(viewer.response.statusCode, 403);

  process.env[taskHistoryEnv] = "0";
  const noGrant = await callOutcomeRoute(service, "GET", undefined, {
    actor: "operator"
  });
  assert.equal(noGrant.response.statusCode, 403);

  process.env[taskHistoryEnv] = "1";
  const missing = await callOutcomeRoute(service, "GET", undefined, {
    experienceId: "experience-from-another-repository"
  });
  assert.equal(missing.response.statusCode, 404);
});

test("outcome POST derives scope and reporter identity from the captured experience and operator", async () => {
  process.env[taskHistoryEnv] = "1";
  auditRecords.length = 0;
  const service = new OutcomeControlServiceStub();
  const { response, body } = await callOutcomeRoute(service, "POST", {
    correlationToken: injection.correlationToken,
    outcomeKind: "success",
    reportKind: "pull_request",
    evidence: [
      {
        kind: "pull_request",
        uri: "https://github.com/owner/repo/pull/123"
      }
    ]
  });
  assert.equal(response.statusCode, 200);
  assert.equal(body.appended, true);
  const input = service.reportInputs[0]!;
  assert.equal(input.report.reporterId, "memory-operator");
  assert.equal(input.report.reporterAuthority, "root");
  assert.deepEqual(input.context, {
    workspaceId: "workspace-a",
    repositoryId: "owner/repo",
    role: "orchestrator",
    taskId: "session-a",
    runId: "session-a",
    agentId: "session-a",
    canReadGlobal: false,
    canReadTaskHistory: true
  });
  const changes = auditRecords.at(-1)?.changes as Record<string, unknown>;
  assert.deepEqual(changes, {
    outcomeKind: "success",
    reportKind: "pull_request",
    appended: true
  });
  assert.doesNotMatch(
    JSON.stringify(auditRecords.at(-1)),
    /opaque-injection-token|pull\/123|owner\/repo/u
  );
});

test("outcome POST requires evidence and rejects caller-selected session identity", async () => {
  process.env[taskHistoryEnv] = "1";
  const service = new OutcomeControlServiceStub();
  const missingEvidence = await callOutcomeRoute(service, "POST", {
    correlationToken: injection.correlationToken,
    outcomeKind: "success",
    reportKind: "task"
  });
  assert.equal(missingEvidence.response.statusCode, 400);
  assert.equal(service.reportInputs.length, 0);

  const callerScope = await callOutcomeRoute(
    service,
    "POST",
    {
      correlationToken: injection.correlationToken,
      outcomeKind: "success",
      reportKind: "task",
      evidence: [{ kind: "commit", uri: "git://repo/commit/abc" }]
    },
    { query: "taskId=attacker-task&runId=attacker-run" }
  );
  assert.equal(callerScope.response.statusCode, 400);
  assert.equal(service.reportInputs.length, 0);
});

test("outcome POST rejects cross-session tokens and duplicate conflicting reports", async () => {
  process.env[taskHistoryEnv] = "1";
  const service = new OutcomeControlServiceStub();
  const body = {
    correlationToken: "token-from-another-session",
    outcomeKind: "success",
    reportKind: "task",
    evidence: [{ kind: "commit", uri: "git://repo/commit/abc" }]
  };
  const mismatch = await callOutcomeRoute(service, "POST", body);
  assert.equal(mismatch.response.statusCode, 400);

  const first = await callOutcomeRoute(service, "POST", {
    ...body,
    correlationToken: injection.correlationToken
  });
  assert.equal(first.response.statusCode, 200);
  const retry = await callOutcomeRoute(service, "POST", {
    ...body,
    correlationToken: injection.correlationToken
  });
  assert.equal(retry.response.statusCode, 200);
  assert.equal(retry.body.appended, false);
  const conflict = await callOutcomeRoute(service, "POST", {
    ...body,
    correlationToken: injection.correlationToken,
    outcomeKind: "failure"
  });
  assert.equal(conflict.response.statusCode, 409);
});

test("outcome routes reject unsupported methods and ensure audit contains no reporter tokens", async () => {
  process.env[taskHistoryEnv] = "1";
  auditRecords.length = 0;
  const service = new OutcomeControlServiceStub();
  const { response } = await callOutcomeRoute(service, "DELETE", undefined, {
    actor: "operator"
  });
  assert.equal(response.statusCode, 405);
  assert.equal(response.headers.allow, "GET, POST");
  assert.doesNotMatch(JSON.stringify(auditRecords), /opaque-injection-token/);
});

test.after(() => {
  if (originalTaskHistoryGrant === undefined)
    delete process.env[taskHistoryEnv];
  else process.env[taskHistoryEnv] = originalTaskHistoryGrant;
});
