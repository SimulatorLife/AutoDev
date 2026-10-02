import assert from "node:assert/strict";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import test from "node:test";

import type {
  MemoryInjectionOutcomeCohortFilter,
  MemoryInjectionOutcomeCohortPage
} from "@simulatorlife/autodev-core";
import type { MemoryService } from "@simulatorlife/autodev-runtime/memory";

import { handleMemoryControlApiRequest } from "../../runtime/src/control-api/memory.ts";

const taskHistoryEnv = "AUTODEV_MEMORY_READ_TASK_HISTORY";
const originalTaskHistoryGrant = process.env[taskHistoryEnv];

const cohortPage: MemoryInjectionOutcomeCohortPage = {
  schema: "autodev-memory-injection-outcome-cohorts-v1",
  workspaceId: "workspace-a",
  repositoryId: "owner/repo",
  occurredFrom: "2026-09-01T00:00:00.000Z",
  occurredUntil: "2026-10-01T00:00:00.000Z",
  cells: [
    {
      memoryMode: "jit",
      injectionResult: "injected",
      sessionCardinality: "multiple",
      reportKind: null,
      outcomeKind: null,
      exposureCount: 4,
      reportCount: 0
    },
    {
      memoryMode: "jit",
      injectionResult: "injected",
      sessionCardinality: "single",
      reportKind: "pull_request",
      outcomeKind: "success",
      exposureCount: 3,
      reportCount: 3
    }
  ],
  exposureCount: 7,
  reportCount: 3
};

class CohortServiceStub {
  readonly requests: MemoryInjectionOutcomeCohortFilter[] = [];

  async aggregateInjectionOutcomeCohorts(
    request: MemoryInjectionOutcomeCohortFilter
  ): Promise<MemoryInjectionOutcomeCohortPage> {
    this.requests.push(request);
    return cohortPage;
  }
}

function makeRequest(method: string, url: string): IncomingMessage {
  return Object.assign(Readable.from([]), { method, url }) as IncomingMessage;
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

async function callCohorts(
  service: CohortServiceStub,
  options: {
    readonly role?: "viewer" | "operator";
    readonly query?: Readonly<Record<string, string>>;
    readonly method?: string;
  } = {}
) {
  const params = new URLSearchParams({
    workspaceId: "workspace-a",
    repositoryId: "owner/repo",
    includeTaskHistory: "true",
    occurredFrom: cohortPage.occurredFrom,
    occurredUntil: cohortPage.occurredUntil,
    ...options.query
  });
  const pathname = "/control/memory/cohorts";
  const response = responseRecorder();
  await handleMemoryControlApiRequest(
    makeRequest(options.method ?? "GET", `${pathname}?${params}`),
    response,
    pathname,
    { actor: "memory-operator", role: options.role ?? "operator" },
    audit,
    { createMemoryService: () => service as unknown as MemoryService }
  );
  return { response, body: response.body ? JSON.parse(response.body) : null };
}

test("cohort GET requires explicit operator task-history authorization", async () => {
  process.env[taskHistoryEnv] = "1";
  const service = new CohortServiceStub();
  const viewer = await callCohorts(service, { role: "viewer" });
  assert.equal(viewer.response.statusCode, 403);
  assert.equal(service.requests.length, 0);

  process.env[taskHistoryEnv] = "0";
  const noGrant = await callCohorts(service);
  assert.equal(noGrant.response.statusCode, 403);
  assert.equal(service.requests.length, 0);

  process.env[taskHistoryEnv] = "1";
  const noExplicitHistory = await callCohorts(service, {
    query: { includeTaskHistory: "false" }
  });
  assert.equal(noExplicitHistory.response.statusCode, 403);
  assert.equal(service.requests.length, 0);
});

test("cohort GET returns bounded scoped groups including unreported exposures", async () => {
  process.env[taskHistoryEnv] = "1";
  auditRecords.length = 0;
  const service = new CohortServiceStub();
  const { response, body } = await callCohorts(service, {
    query: {
      memoryMode: "jit",
      injectionResult: "injected"
    }
  });
  assert.equal(response.statusCode, 200);
  assert.equal(response.headers["cache-control"], "no-store");
  assert.equal(body.schema, "autodev-memory-injection-outcome-cohorts-v1");
  assert.equal(body.cells[0].reportKind, null);
  assert.equal(body.cells[0].outcomeKind, null);
  assert.equal(body.cells[0].reportCount, 0);
  // The cardinality dimension passes through untouched: it is derived at
  // the Data layer from each cell's full session event set, not recomputed
  // or stripped by the Control API route.
  assert.equal(body.cells[0].sessionCardinality, "multiple");
  assert.equal(body.cells[1].sessionCardinality, "single");
  assert.deepEqual(service.requests[0], {
    context: {
      workspaceId: "workspace-a",
      repositoryId: "owner/repo",
      canReadGlobal: false,
      canReadTaskHistory: true
    },
    occurredFrom: cohortPage.occurredFrom,
    occurredUntil: cohortPage.occurredUntil,
    memoryModes: ["jit"],
    injectionResults: ["injected"]
  });
  assert.deepEqual(auditRecords.at(-1), {
    action: "read_cohorts",
    resource: "/control/memory/cohorts",
    outcome: "ok",
    changes: null
  });
  assert.doesNotMatch(
    JSON.stringify(body),
    /correlationToken|taskId|runId|agentId|evidence|reporter/u
  );
});

test("cohort GET forwards bounded reporter-supplied report and outcome filters", async () => {
  process.env[taskHistoryEnv] = "1";
  const service = new CohortServiceStub();
  await callCohorts(service, {
    query: { reportKind: "pull_request", outcomeKind: "success" }
  });
  assert.deepEqual(service.requests[0]?.reportKinds, ["pull_request"]);
  assert.deepEqual(service.requests[0]?.outcomeKinds, ["success"]);
});

test("cohort GET rejects missing scope, unbounded windows, and caller-selected task identities", async () => {
  process.env[taskHistoryEnv] = "1";
  const service = new CohortServiceStub();
  const missingRepository = await callCohorts(service, {
    query: { repositoryId: "" }
  });
  assert.equal(missingRepository.response.statusCode, 400);

  const missingWindowBound = await callCohorts(service, {
    query: { occurredFrom: "" }
  });
  assert.equal(missingWindowBound.response.statusCode, 400);

  const invalidWindow = await callCohorts(service, {
    query: {
      occurredFrom: "2024-01-01T00:00:00.000Z",
      occurredUntil: "2026-10-01T00:00:00.000Z"
    }
  });
  assert.equal(invalidWindow.response.statusCode, 400);

  for (const identity of ["taskId", "runId", "agentId"]) {
    const rejected = await callCohorts(service, {
      query: { [identity]: "caller-selected" }
    });
    assert.equal(rejected.response.statusCode, 400, identity);
  }
  assert.equal(service.requests.length, 0);
});

test("cohort endpoint is read-only", async () => {
  process.env[taskHistoryEnv] = "1";
  const { response } = await callCohorts(new CohortServiceStub(), {
    method: "POST"
  });
  assert.equal(response.statusCode, 405);
  assert.equal(response.headers.allow, "GET");
});

test.after(() => {
  if (originalTaskHistoryGrant === undefined)
    delete process.env[taskHistoryEnv];
  else process.env[taskHistoryEnv] = originalTaskHistoryGrant;
});
