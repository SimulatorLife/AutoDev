import assert from "node:assert/strict";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import test from "node:test";

import type {
  MemoryInjectionUseCohortFilter,
  MemoryInjectionUseCohortPage
} from "@simulatorlife/autodev-core";
import type { MemoryService } from "@simulatorlife/autodev-runtime/memory";

import { handleMemoryControlApiRequest } from "../../runtime/src/control-api/memory.ts";

const taskHistoryEnv = "AUTODEV_MEMORY_READ_TASK_HISTORY";
const originalTaskHistoryGrant = process.env[taskHistoryEnv];

const useCohortPage: MemoryInjectionUseCohortPage = {
  schema: "autodev-memory-injection-use-cohorts-v1",
  workspaceId: "workspace-a",
  repositoryId: "owner/repo",
  occurredFrom: "2026-09-01T00:00:00.000Z",
  occurredUntil: "2026-10-01T00:00:00.000Z",
  cells: [
    {
      memoryMode: "jit",
      sessionCardinality: "multiple",
      useKind: null,
      exposureCount: 4
    },
    {
      memoryMode: "jit",
      sessionCardinality: "single",
      useKind: "used",
      exposureCount: 3
    }
  ],
  exposureCount: 7
};

class UseCohortServiceStub {
  readonly requests: MemoryInjectionUseCohortFilter[] = [];

  async aggregateInjectionUseCohorts(
    request: MemoryInjectionUseCohortFilter
  ): Promise<MemoryInjectionUseCohortPage> {
    this.requests.push(request);
    return useCohortPage;
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

async function callUseCohorts(
  service: UseCohortServiceStub,
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
    occurredFrom: useCohortPage.occurredFrom,
    occurredUntil: useCohortPage.occurredUntil,
    ...options.query
  });
  const pathname = "/control/memory/use-cohorts";
  const response = responseRecorder();
  await handleMemoryControlApiRequest(
    makeRequest(options.method ?? "GET", `${pathname}?${params}`),
    response,
    pathname,
    { actor: "memory-use-operator", role: options.role ?? "operator" },
    () => undefined,
    { createMemoryService: () => service as unknown as MemoryService }
  );
  return {
    response,
    body: response.body ? JSON.parse(response.body) : null
  };
}

test("use-cohorts GET requires explicit operator task-history authorization", async () => {
  process.env[taskHistoryEnv] = "1";
  const service = new UseCohortServiceStub();

  const viewer = await callUseCohorts(service, { role: "viewer" });
  assert.equal(viewer.response.statusCode, 403);
  assert.equal(service.requests.length, 0);

  process.env[taskHistoryEnv] = "0";
  const noGrant = await callUseCohorts(service);
  assert.equal(noGrant.response.statusCode, 403);
  assert.equal(service.requests.length, 0);

  process.env[taskHistoryEnv] = "1";
  const noExplicitHistory = await callUseCohorts(service, {
    query: { includeTaskHistory: "false" }
  });
  assert.equal(noExplicitHistory.response.statusCode, 403);
  assert.equal(service.requests.length, 0);
});

test("use-cohorts GET forwards bounded memoryMode/useKind filters without leaking IDs", async () => {
  process.env[taskHistoryEnv] = "1";
  const service = new UseCohortServiceStub();
  const { response, body } = await callUseCohorts(service, {
    query: { memoryMode: "jit", useKind: "used" }
  });
  assert.equal(response.statusCode, 200);
  assert.equal(response.headers["cache-control"], "no-store");
  assert.equal(body.schema, "autodev-memory-injection-use-cohorts-v1");
  assert.equal(body.cells[0].useKind, null);
  assert.equal(body.cells[1].useKind, "used");
  assert.deepEqual(service.requests[0], {
    context: {
      workspaceId: "workspace-a",
      repositoryId: "owner/repo",
      canReadGlobal: false,
      canReadTaskHistory: true
    },
    occurredFrom: useCohortPage.occurredFrom,
    occurredUntil: useCohortPage.occurredUntil,
    memoryModes: ["jit"],
    useKinds: ["used"]
  });
  // Cells must not leak correlation tokens, reporter IDs, or memory IDs.
  assert.doesNotMatch(
    JSON.stringify(body),
    /correlationToken|taskId|runId|agentId|reporter|usedMemoryIds|evidence/u
  );
});

test("use-cohorts GET rejects caller-selected task/run/agent identity", async () => {
  process.env[taskHistoryEnv] = "1";
  const service = new UseCohortServiceStub();
  for (const identity of ["taskId", "runId", "agentId"]) {
    const rejected = await callUseCohorts(service, {
      query: { [identity]: "caller-selected" }
    });
    assert.equal(rejected.response.statusCode, 400, identity);
  }
  assert.equal(service.requests.length, 0);
});

test("use-cohorts endpoint is read-only (POST returns 405)", async () => {
  process.env[taskHistoryEnv] = "1";
  const { response } = await callUseCohorts(new UseCohortServiceStub(), {
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
