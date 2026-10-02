import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import test from "node:test";

import {
  type ExperienceEnvelope,
  type MemoryActor,
  type MemoryInjectionEvent,
  type MemoryInjectionOutcomeCohortPage,
  type MemoryInjectionOutcomeJoin,
  type MemoryReadContext,
  type MemoryRecordInjectionEventInput
} from "@simulatorlife/autodev-core";
import {
  applyMemoryMigrations,
  createPgMemoryPool
} from "@simulatorlife/autodev-data";
import type { MemoryService } from "@simulatorlife/autodev-runtime/memory";

import { handleMemoryControlApiRequest } from "../src/control-api/memory.ts";
import {
  createPostgresMemoryHost,
  type PostgresMemoryHost
} from "../src/memory/postgres.ts";

const databaseUrl = process.env.AUTODEV_MEMORY_RUNTIME_TEST_DATABASE_URL;
const TASK_HISTORY_ENV = "AUTODEV_MEMORY_READ_TASK_HISTORY";

interface OutcomeRouteResponse {
  readonly response: ServerResponse;
  readonly body: Record<string, unknown> | null;
}

async function callOutcomeRoute(
  service: MemoryService,
  method: "GET" | "POST",
  body: Record<string, unknown> | undefined,
  auditRecords: Array<Record<string, unknown>>,
  experienceId: string,
  workspaceId: string,
  repositoryId: string,
  options: { readonly actorRole?: "viewer" | "operator" } = {}
): Promise<OutcomeRouteResponse> {
  const actorRole = options.actorRole ?? "operator";
  const actorId =
    actorRole === "operator"
      ? "memory-outcome-integration-operator"
      : "memory-outcome-integration-viewer";
  const search = new URLSearchParams({
    workspaceId,
    repositoryId,
    includeTaskHistory: "true"
  });
  const pathname = `/control/memory/experiences/${encodeURIComponent(experienceId)}/outcomes`;
  const request = makeRequest(method, `${pathname}?${search.toString()}`, body);
  const response = responseRecorder();
  const audit = (event: Record<string, unknown>) => {
    auditRecords.push(event);
  };
  const dependencies = {
    createMemoryService: () => service
  };
  await handleMemoryControlApiRequest(
    request,
    response,
    pathname,
    { actor: actorId, role: actorRole },
    audit,
    dependencies
  );
  return { response, body: responseBody(response) };
}

async function callCohortRoute(
  service: MemoryService,
  auditRecords: Array<Record<string, unknown>>,
  workspaceId: string,
  repositoryId: string,
  occurredFrom: string,
  occurredUntil: string
): Promise<OutcomeRouteResponse> {
  const pathname = "/control/memory/cohorts";
  const search = new URLSearchParams({
    workspaceId,
    repositoryId,
    includeTaskHistory: "true",
    occurredFrom,
    occurredUntil
  });
  const request = makeRequest("GET", `${pathname}?${search.toString()}`);
  const response = responseRecorder();
  await handleMemoryControlApiRequest(
    request,
    response,
    pathname,
    { actor: "memory-outcome-integration-operator", role: "operator" },
    (event) => auditRecords.push(event),
    { createMemoryService: () => service }
  );
  return { response, body: responseBody(response) };
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

function randomSuffix(): string {
  return randomUUID();
}

function buildTranscript(startedAt: string, completedAt: string): string {
  return [
    {
      type: "response_item",
      payload: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "Inspect the integration seam." }]
      },
      timestamp: startedAt
    },
    {
      type: "response_item",
      payload: {
        type: "message",
        role: "assistant",
        content: [
          { type: "output_text", text: "Integration seam looks intact." }
        ]
      },
      timestamp: completedAt
    }
  ]
    .map((event) => JSON.stringify(event))
    .join("\n");
}

test(
  "PostgreSQL Control API appends a request-level MemoryInjectionEvent to its session-scoped experience and joins an evidence-backed outcome report",
  { skip: !databaseUrl },
  async () => {
    const originalTaskHistoryGrant = process.env[TASK_HISTORY_ENV];
    process.env[TASK_HISTORY_ENV] = "1";

    const repositoryId = `owner/integration-repo-${randomSuffix()}`;
    const workspaceId = `workspace-integration-${randomSuffix()}`;
    const sessionTaskId = `session-${randomSuffix()}`;
    const sessionRunId = sessionTaskId;
    const sessionAgentId = sessionTaskId;
    const requestRunId = `router-request-${randomSuffix()}`;
    const requestAgentId = `thread-${randomSuffix()}`;
    const correlationToken = `opaque-integration-token-${randomSuffix()}`;
    const startedAt = "2026-10-01T12:00:00.000Z";
    const completedAt = "2026-10-01T12:05:00.000Z";

    let migrationPool: ReturnType<typeof createPgMemoryPool> | undefined;
    let host: PostgresMemoryHost | undefined;
    const auditRecords: Array<Record<string, unknown>> = [];

    try {
      migrationPool = createPgMemoryPool({ connectionString: databaseUrl! });
      await applyMemoryMigrations(migrationPool);

      host = createPostgresMemoryHost({ databaseUrl: databaseUrl! });
      const service = host.createService({
        resolve: async () => null
      });

      const sessionActor: MemoryActor = {
        id: sessionAgentId,
        authority: "worker",
        role: "worker"
      };
      const sessionContext: MemoryReadContext = {
        workspaceId,
        repositoryId,
        role: "worker",
        taskId: sessionTaskId,
        runId: sessionRunId,
        agentId: sessionAgentId,
        canReadGlobal: false,
        canReadTaskHistory: true
      };

      const experienceId = `experience-${randomSuffix()}`;
      const trajectoryUri = `codex://integration/${experienceId}/trajectory`;
      const experience: Omit<ExperienceEnvelope, "trajectory"> = {
        id: experienceId,
        workspaceId,
        repositoryId,
        scope: {
          kind: "task",
          workspaceId,
          taskId: sessionTaskId,
          runId: sessionRunId
        },
        taskId: sessionTaskId,
        runId: sessionRunId,
        agentId: sessionAgentId,
        agentRole: "worker",
        startedAt,
        completedAt,
        outcome: "unknown",
        evidence: [{ kind: "trajectory", uri: trajectoryUri }]
      };

      await service.captureExperience(
        {
          source: "codex",
          transcript: buildTranscript(startedAt, completedAt),
          trajectoryUri,
          experience
        },
        sessionActor,
        sessionContext
      );

      const injectionEvent: MemoryInjectionEvent = {
        id: `inj-${randomSuffix()}`,
        workspaceId,
        repositoryId,
        scope: {
          kind: "task",
          workspaceId,
          taskId: sessionTaskId,
          runId: requestRunId
        },
        taskId: sessionTaskId,
        runId: requestRunId,
        agentId: requestAgentId,
        agentRole: "worker",
        correlationToken,
        memoryMode: "jit",
        injectionResult: "injected",
        packetCharacterCount: 320,
        packetTokenCount: 80,
        memoryIds: ["memory-integration-1"],
        occurredAt: "2026-10-01T12:01:00.000Z",
        reasonCode: "packet_attached",
        evidence: [],
        recordedBy: "autodev-integration-test"
      };

      const requestContext: MemoryReadContext = {
        workspaceId,
        repositoryId,
        role: "worker",
        taskId: sessionTaskId,
        runId: requestRunId,
        agentId: requestAgentId,
        canReadGlobal: false
      };

      const injectionActor: MemoryActor = {
        id: "autodev-integration-test",
        authority: "system"
      };

      const injectionInput: MemoryRecordInjectionEventInput = {
        event: injectionEvent,
        actor: injectionActor,
        context: requestContext
      };

      const injectionAppend =
        await service.recordInjectionEvent(injectionInput);
      assert.equal(injectionAppend.appended, true);
      assert.equal(injectionAppend.id, injectionEvent.id);

      const initial = await callOutcomeRoute(
        service,
        "GET",
        undefined,
        auditRecords,
        experienceId,
        workspaceId,
        repositoryId
      );
      assert.equal(initial.response.statusCode, 200);
      assert.equal(
        initial.body?.schema,
        "autodev-memory-injection-outcomes-v1"
      );
      assert.equal(initial.body?.experienceId, experienceId);
      const initialBody = initial.body as {
        readonly items?: ReadonlyArray<MemoryInjectionOutcomeJoin>;
        readonly total?: number;
      };
      const initialItems = initialBody.items ?? [];
      assert.equal(initialBody.total, 1);
      assert.equal(initialItems.length, 1);
      const initialJoin = initialItems[0]!;
      assert.equal(initialJoin.outcome, null);
      assert.equal(initialJoin.injection.correlationToken, correlationToken);
      // Only one injection has been recorded for this session so far.
      assert.equal(initialJoin.sessionInjectionCount, 1);
      assert.equal(initialJoin.injection.runId, requestRunId);
      assert.equal(initialJoin.injection.agentId, requestAgentId);
      assert.notEqual(initialJoin.injection.runId, sessionRunId);
      assert.notEqual(initialJoin.injection.agentId, sessionAgentId);

      const evidenceUri = `https://github.com/${repositoryId}/pull/${randomSuffix()}`;
      const postBody = {
        correlationToken,
        outcomeKind: "success" as const,
        reportKind: "pull_request" as const,
        evidence: [{ kind: "pull_request" as const, uri: evidenceUri }]
      };
      const posted = await callOutcomeRoute(
        service,
        "POST",
        postBody,
        auditRecords,
        experienceId,
        workspaceId,
        repositoryId
      );
      assert.equal(posted.response.statusCode, 200);
      assert.equal(posted.body?.schema, "autodev-memory-outcome-report-v1");
      assert.equal(posted.body?.appended, true);
      assert.equal(posted.body?.experienceId, experienceId);

      const joined = await callOutcomeRoute(
        service,
        "GET",
        undefined,
        auditRecords,
        experienceId,
        workspaceId,
        repositoryId
      );
      assert.equal(joined.response.statusCode, 200);
      const joinedBody = joined.body as {
        readonly items?: ReadonlyArray<MemoryInjectionOutcomeJoin>;
        readonly total?: number;
      };
      const joinedItems = joinedBody.items ?? [];
      assert.equal(joinedBody.total, 1);
      assert.equal(joinedItems.length, 1);
      const joinedJoin = joinedItems[0]!;
      assert.notEqual(joinedJoin.outcome, null);
      assert.equal(joinedJoin.outcome?.correlationToken, correlationToken);
      // Reporting an outcome does not add a second injection event, so the
      // session-wide count is unchanged.
      assert.equal(joinedJoin.sessionInjectionCount, 1);
      assert.equal(joinedJoin.outcome?.outcomeKind, "success");
      assert.equal(joinedJoin.outcome?.reportKind, "pull_request");
      assert.equal(joinedJoin.outcome?.reporterAuthority, "root");
      assert.equal(joinedJoin.outcome?.evidence[0]?.uri, evidenceUri);
      assert.equal(joinedJoin.injection.runId, requestRunId);
      assert.equal(joinedJoin.injection.agentId, requestAgentId);
      assert.notEqual(joinedJoin.injection.runId, sessionRunId);
      assert.notEqual(joinedJoin.injection.agentId, sessionAgentId);
      assert.equal(joinedJoin.outcome?.taskId, sessionTaskId);
      assert.equal(joinedJoin.outcome?.runId, sessionRunId);
      assert.equal(joinedJoin.outcome?.agentId, sessionAgentId);
      assert.equal(joinedJoin.outcome?.workspaceId, workspaceId);
      assert.equal(joinedJoin.outcome?.repositoryId, repositoryId);

      const unreportedToken = `opaque-unreported-token-${randomSuffix()}`;
      const unreportedRunId = `router-request-${randomSuffix()}`;
      const unreportedAgentId = `thread-${randomSuffix()}`;
      await service.recordInjectionEvent({
        event: {
          id: `inj-${randomSuffix()}`,
          workspaceId,
          repositoryId,
          scope: {
            kind: "task",
            workspaceId,
            taskId: sessionTaskId,
            runId: unreportedRunId
          },
          taskId: sessionTaskId,
          runId: unreportedRunId,
          agentId: unreportedAgentId,
          agentRole: "worker",
          correlationToken: unreportedToken,
          memoryMode: "disabled",
          injectionResult: "skipped",
          packetCharacterCount: 0,
          memoryIds: [],
          occurredAt: "2026-10-01T12:02:00.000Z",
          reasonCode: "memory_mode_disabled",
          evidence: [],
          recordedBy: "autodev-integration-test"
        },
        actor: injectionActor,
        context: {
          ...requestContext,
          runId: unreportedRunId,
          agentId: unreportedAgentId
        }
      });

      const cohorts = await callCohortRoute(
        service,
        auditRecords,
        workspaceId,
        repositoryId,
        "2026-10-01T00:00:00.000Z",
        "2026-10-01T23:59:59.999Z"
      );
      assert.equal(cohorts.response.statusCode, 200);
      const cohortPage =
        cohorts.body as unknown as MemoryInjectionOutcomeCohortPage;
      assert.equal(
        cohortPage.schema,
        "autodev-memory-injection-outcome-cohorts-v1"
      );
      assert.equal(cohortPage.exposureCount, 2);
      assert.equal(cohortPage.reportCount, 1);
      // Both cells belong to the same session, which captured exactly two
      // injection events in total, so both are 'multiple' regardless of
      // the per-cell memoryMode/injectionResult/reportKind grouping.
      assert.deepEqual(cohortPage.cells, [
        {
          memoryMode: "disabled",
          injectionResult: "skipped",
          sessionCardinality: "multiple",
          reportKind: null,
          outcomeKind: null,
          exposureCount: 1,
          reportCount: 0
        },
        {
          memoryMode: "jit",
          injectionResult: "injected",
          sessionCardinality: "multiple",
          reportKind: "pull_request",
          outcomeKind: "success",
          exposureCount: 1,
          reportCount: 1
        }
      ]);
      const serializedCohorts = JSON.stringify(cohortPage);
      assert.doesNotMatch(
        serializedCohorts,
        /correlationToken|sessionTaskId|requestRunId|requestAgentId|evidence|reporter/u
      );

      const stored = await service.getExperience(experienceId, {
        ...sessionContext
      });
      assert.notEqual(stored, null);
      assert.equal(stored?.runId, sessionRunId);
      assert.equal(stored?.agentId, sessionAgentId);
      assert.equal(stored?.taskId, sessionTaskId);

      const reportAudit = [...auditRecords]
        .reverse()
        .find((entry) => entry.action === "report_outcome");
      assert.ok(reportAudit, "expected a recorded audit entry for the POST");
      const auditChanges = (reportAudit.changes ?? {}) as Record<
        string,
        unknown
      >;
      assert.deepEqual(auditChanges, {
        outcomeKind: "success",
        reportKind: "pull_request",
        appended: true
      });
      const auditSerialized = JSON.stringify(auditRecords);
      assert.doesNotMatch(auditSerialized, new RegExp(correlationToken));
      assert.doesNotMatch(auditSerialized, new RegExp(evidenceUri));
      assert.doesNotMatch(
        auditSerialized,
        /pull\/[0-9]+|injection-outcome-integration-operator/u
      );
    } finally {
      if (originalTaskHistoryGrant === undefined)
        delete process.env[TASK_HISTORY_ENV];
      else process.env[TASK_HISTORY_ENV] = originalTaskHistoryGrant;
      try {
        await host?.close();
      } finally {
        await migrationPool?.end();
      }
    }
  }
);
