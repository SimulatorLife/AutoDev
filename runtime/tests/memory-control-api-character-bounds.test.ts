import assert from "node:assert/strict";
import test from "node:test";

import type { MemoryRecord } from "@simulatorlife/autodev-core";
import type { MemoryService } from "@simulatorlife/autodev-runtime/memory";

import { handleMemoryControlApiRequest } from "../src/control-api/memory.ts";
import {
  makeRequest,
  responseBody,
  type RecordedResponse,
  responseRecorder
} from "./support/control-api-harness.ts";

/**
 * The `/control/memory/*` character bounds had no route-level test at all.
 *
 * They are the boundary where an operator's input is first measured, and they
 * restated the service's own claim and query limits under a single local
 * constant named for the claim -- so the task limit had no name of its own and
 * the claim and query limits could be edited without the service that actually
 * refuses them noticing. Pointing all three at the service's exported bounds
 * fixes the ownership; these tests are what stops the wiring from silently
 * regressing, since renaming a constant would otherwise compile cleanly.
 *
 * The lengths are written out rather than imported from the service. The
 * property worth pinning here is the number the route accepts, and reading it
 * back from the constant under test would make every case below pass for any
 * value it was given.
 */

const CALLER_QUERY = {
  workspaceId: "ws-1",
  repositoryId: "repo-1",
  taskId: "task-1",
  runId: "run-1",
  agentId: "agent-1"
} as const;

const REPOSITORY_SCOPE = {
  kind: "repository",
  workspaceId: "ws-1",
  repositoryId: "repo-1"
} as const;

function storedRecord(): MemoryRecord {
  return {
    id: "mem-1",
    workspaceId: "ws-1",
    repositoryId: "repo-1",
    scope: { ...REPOSITORY_SCOPE },
    kind: "semantic",
    claim: "A durable claim.",
    content: "A durable claim.",
    status: "active",
    confidence: 0.4,
    createdAt: "2026-10-01T10:00:00.000Z",
    updatedAt: "2026-10-02T10:00:00.000Z",
    validity: { state: "verified", evidence: [] },
    provenance: {
      experienceIds: ["exp-1"],
      evidence: [],
      createdBy: "test-operator",
      createdAt: "2026-10-01T10:00:00.000Z"
    }
  } as MemoryRecord;
}

interface CallResult {
  readonly response: RecordedResponse;
  readonly body: Record<string, unknown> | null;
  /** How many times the route reached the service -- 0 means it was refused first. */
  readonly serviceCalls: () => number;
}

/**
 * Records every service method the routes below can reach, so a refusal can be
 * distinguished from an accept. A bound that returned 400 only *after* calling
 * the service would look identical to one that refused before.
 */
function call(
  method: string,
  pathname: string,
  service: Partial<Record<keyof MemoryService, unknown>>,
  body?: Record<string, unknown>,
  query: Record<string, string> = {}
): Promise<CallResult> {
  let calls = 0;
  const counting = <T>(value: T) =>
    async (...args: unknown[]) => {
      calls += 1;
      return typeof value === "function"
        ? (value as (...a: unknown[]) => unknown)(...args)
        : value;
    };
  const resolved: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(service)) {
    resolved[name] = counting(value);
  }
  const search = new URLSearchParams({ ...CALLER_QUERY, ...query });
  const response = responseRecorder();
  const previousHistory = process.env.AUTODEV_MEMORY_READ_TASK_HISTORY;
  const previousGlobal = process.env.AUTODEV_MEMORY_READ_GLOBAL;
  process.env.AUTODEV_MEMORY_READ_TASK_HISTORY = "1";
  delete process.env.AUTODEV_MEMORY_READ_GLOBAL;
  return handleMemoryControlApiRequest(
    makeRequest(method, `${pathname}?${search.toString()}`, body),
    response,
    pathname,
    { actor: "test-operator", role: "operator" },
    () => {},
    { createMemoryService: () => resolved as unknown as MemoryService }
  )
    .then(() => ({
      response,
      body: responseBody(response),
      serviceCalls: () => calls
    }))
    .finally(() => {
      if (previousHistory === undefined) delete process.env.AUTODEV_MEMORY_READ_TASK_HISTORY;
      else process.env.AUTODEV_MEMORY_READ_TASK_HISTORY = previousHistory;
      if (previousGlobal === undefined) delete process.env.AUTODEV_MEMORY_READ_GLOBAL;
      else process.env.AUTODEV_MEMORY_READ_GLOBAL = previousGlobal;
    });
}

function listService(captured: { query?: unknown }) {
  return {
    listMemories: async (request: Record<string, unknown>) => {
      captured.query = request.query;
      return {
        items: [],
        total: 0,
        limit: 25,
        offset: 0,
        statusCounts: {
          proposed: 0,
          active: 0,
          uncertain: 0,
          superseded: 0,
          invalidated: 0
        }
      };
    }
  };
}

test("the records query filter is bounded by the filter bound, not the query bound", async () => {
  const captured: { query?: unknown } = {};

  // 256, not 4000. `oneFilter` bounds every filter value before this route sees
  // it, and the query filter used to carry a second check against the service's
  // much larger query bound that could therefore never fire -- so the bound an
  // operator actually meets was neither of the two constants involved.
  const atBound = await call(
    "GET",
    "/control/memory/records",
    listService(captured),
    undefined,
    { query: "a".repeat(256) }
  );
  assert.equal(atBound.response.statusCode, 200);
  assert.equal(atBound.serviceCalls(), 1, "a query at the bound must reach the service");
  assert.equal(captured.query, "a".repeat(256));

  captured.query = undefined;
  const pastBound = await call(
    "GET",
    "/control/memory/records",
    listService(captured),
    undefined,
    { query: "a".repeat(257) }
  );
  assert.equal(
    pastBound.response.statusCode,
    400,
    "a filter past the filter bound must be refused"
  );
  assert.equal(
    pastBound.serviceCalls(),
    0,
    "an over-long filter must be refused before the service is asked to search"
  );
});

function proposeService(): Partial<Record<keyof MemoryService, unknown>> {
  return { propose: async () => storedRecord() };
}

function proposalBody(
  claim: string,
  evidence: readonly Record<string, unknown>[] = [
    { kind: "file", uri: "runs/42/result.json" }
  ]
): Record<string, unknown> {
  return {
    kind: "semantic",
    scope: { ...REPOSITORY_SCOPE },
    claim,
    experienceIds: ["exp-1"],
    evidence
  };
}

test("a proposed claim is bounded by the same limit the service refuses", async () => {
  const atBound = await call(
    "POST",
    "/control/memory/records",
    proposeService(),
    proposalBody("c".repeat(4000))
  );
  assert.equal(atBound.response.statusCode, 200);
  assert.equal(
    atBound.serviceCalls(),
    1,
    "a claim at the bound must reach the service, or the bound is one short"
  );

  const pastBound = await call(
    "POST",
    "/control/memory/records",
    proposeService(),
    proposalBody("c".repeat(4001))
  );
  assert.equal(
    pastBound.response.statusCode,
    400,
    "a claim past the bound must be refused with 400"
  );
  assert.equal(
    pastBound.serviceCalls(),
    0,
    "an over-long claim must be refused at the route, not stored and rejected later"
  );
});

test("proposal evidence is bounded on both the uri and the revision", async () => {
  // 2048 and 256, written out rather than imported. The service measures the
  // same `EvidenceReference` type at the same two numbers
  // (`memory.test.ts` pins its own copy at 2049), and these two sites had been
  // spelling them out independently as bare literals -- so a rename in one
  // would have compiled cleanly and left the other enforcing something else.
  const uriAtBound = await call(
    "POST",
    "/control/memory/records",
    proposeService(),
    proposalBody("A durable claim.", [
      { kind: "file", uri: "u".repeat(2048) }
    ])
  );
  assert.equal(
    uriAtBound.response.statusCode,
    200,
    "an evidence uri at the bound must be accepted"
  );
  assert.equal(uriAtBound.serviceCalls(), 1);

  const uriPastBound = await call(
    "POST",
    "/control/memory/records",
    proposeService(),
    proposalBody("A durable claim.", [
      { kind: "file", uri: "u".repeat(2049) }
    ])
  );
  assert.equal(
    uriPastBound.response.statusCode,
    400,
    "an evidence uri past the bound must be refused with 400"
  );
  assert.equal(
    uriPastBound.serviceCalls(),
    0,
    "an over-long evidence uri must be refused before the memory is written"
  );

  const revisionAtBound = await call(
    "POST",
    "/control/memory/records",
    proposeService(),
    proposalBody("A durable claim.", [
      { kind: "commit", uri: "runs/42/result.json", revision: "r".repeat(256) }
    ])
  );
  assert.equal(
    revisionAtBound.response.statusCode,
    200,
    "an evidence revision at the bound must be accepted"
  );
  assert.equal(revisionAtBound.serviceCalls(), 1);

  const revisionPastBound = await call(
    "POST",
    "/control/memory/records",
    proposeService(),
    proposalBody("A durable claim.", [
      { kind: "commit", uri: "runs/42/result.json", revision: "r".repeat(257) }
    ])
  );
  assert.equal(
    revisionPastBound.response.statusCode,
    400,
    "an evidence revision past the bound must be refused with 400"
  );
  assert.equal(
    revisionPastBound.serviceCalls(),
    0,
    "an over-long evidence revision must be refused before the memory is written"
  );
});

function verifyService(): Partial<Record<keyof MemoryService, unknown>> {
  return { verifyAndPromote: async () => storedRecord() };
}

test("a research body is bounded on both the task and the query", async () => {
  const atBound = await call(
    "POST",
    "/control/memory/records/mem-1/verify",
    verifyService(),
    { task: "t".repeat(4000), query: "q".repeat(4000) }
  );
  assert.equal(atBound.response.statusCode, 200);
  assert.equal(atBound.serviceCalls(), 1);

  // The two fields share a number but not an owner: the service bounds no task
  // at all -- `research` only requires a non-empty one -- so this limit is the
  // route's own and would be silently gone if it were still folded into the
  // claim constant this replaced.
  const overLongTask = await call(
    "POST",
    "/control/memory/records/mem-1/verify",
    verifyService(),
    { task: "t".repeat(4001), query: "q".repeat(10) }
  );
  assert.equal(
    overLongTask.response.statusCode,
    400,
    "a research task past the bound must be refused with 400"
  );
  assert.equal(
    overLongTask.serviceCalls(),
    0,
    "an over-long research task must be refused before verification runs"
  );

  const overLongQuery = await call(
    "POST",
    "/control/memory/records/mem-1/verify",
    verifyService(),
    { task: "t".repeat(10), query: "q".repeat(4001) }
  );
  assert.equal(
    overLongQuery.response.statusCode,
    400,
    "a research query past the bound must be refused with 400"
  );
  assert.equal(
    overLongQuery.serviceCalls(),
    0,
    "an over-long research query must be refused before verification runs"
  );
});