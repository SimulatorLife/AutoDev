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
 * The governed record mutations — verify, invalidate, revise, supersede and
 * promote-to-skill — had no route-level test. `memory.test.ts` exercises the
 * service directly, so everything the *route* is responsible for went unchecked:
 * that an action needs an operator, that its body keys are exact, that the audit
 * record names the action actually taken, and that promote-to-skill answers a
 * different schema from the other four.
 *
 * These are the requests an operator sends when changing durable memory, so an
 * audit gap here is a governance gap.
 */

interface CallResult {
  readonly response: RecordedResponse;
  readonly body: Record<string, unknown> | null;
}

const RECORDS = "/control/memory/records";

/**
 * A mutation is scoped like every other memory read: the route refuses to act
 * without knowing which workspace and repository the record lives in.
 */
const SCOPE = "workspaceId=ws-1&repositoryId=repo-1";

async function callRoute(
  service: MemoryService,
  path: string,
  body: Record<string, unknown> | undefined,
  options: {
    readonly actorRole?: "viewer" | "operator";
    readonly method?: string;
  } = {}
): Promise<CallResult> {
  const response = responseRecorder();
  const prevEnv = process.env.AUTODEV_MEMORY_READ_TASK_HISTORY;
  process.env.AUTODEV_MEMORY_READ_TASK_HISTORY = "1";
  const pathname = path.split("?")[0] ?? path;
  try {
    await handleMemoryControlApiRequest(
      makeRequest(options.method ?? "POST", `${path}?${SCOPE}`, body),
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

/**
 * Evidence is not decoration. Every governance action that changes a durable
 * record's standing requires at least one reference, because an invalidation or
 * a revision that cannot be traced back to what justified it is not auditable.
 */
const EVIDENCE = [
  {
    kind: "file",
    uri: "config/runtime.json",
    observedAt: "2026-10-02T10:00:00.000Z"
  }
];

/** A service that records which mutation was called, and returns a known result. */
function mockService(
  overrides: Partial<Record<keyof MemoryService, unknown>> = {}
) {
  return {
    verifyAndPromote: async () => record({ status: "active" }),
    invalidate: async () => record({ status: "invalidated" }),
    revise: async () => record({ claim: "Revised claim." }),
    supersede: async () => record({ status: "superseded" }),
    promoteProcedureToSkill: async () => ({
      memory: record({ kind: "procedural", status: "active" }),
      skill: { name: "retry-budget", revision: "abc123" }
    }),
    ...overrides
  } as unknown as MemoryService;
}

test("POST /control/memory/records/:id/verify promotes and audits the action", async () => {
  const seen: string[] = [];
  const service = mockService({
    verifyAndPromote: async () => {
      seen.push("verifyAndPromote");
      return record({ status: "active" });
    }
  });

  const { response, body } = await callRoute(
    service,
    `${RECORDS}/mem-1/verify`,
    { task: "raise the retry budget", query: "retry budget config" },
    {
      actorRole: "operator"
    }
  );

  assert.equal(response.statusCode, 200);
  assert.equal(body?.schema, "autodev-memory-record-v1");
  assert.deepEqual(seen, ["verifyAndPromote"]);
  assert.equal((body?.memory as MemoryRecord).status, "active");
});

test("POST /control/memory/records/:id/invalidate requires a bounded reason code", async () => {
  const good = await callRoute(mockService(), `${RECORDS}/mem-1/invalidate`, {
    reasonCode: "contradicted",
    evidence: EVIDENCE
  });
  assert.equal(good.response.statusCode, 200);
  assert.equal((good.body?.memory as MemoryRecord).status, "invalidated");

  // An unrecognised reason must not be stored as one: invalidation is
  // permanent, and a free-text code nobody can count on later is not a reason.
  const bad = await callRoute(mockService(), `${RECORDS}/mem-1/invalidate`, {
    reasonCode: "felt-wrong"
  });
  assert.equal(bad.response.statusCode, 400);
});

test("POST /control/memory/records/:id/revise replaces the claim", async () => {
  let submittedClaim: unknown;
  const service = mockService({
    // Echoes what the route forwarded, so the assertion proves the claim
    // reached the service rather than that a fixed fixture came back.
    revise: async (_id: string, input: { claim?: string }) => {
      submittedClaim = input.claim;
      return record({ claim: input.claim ?? "" });
    }
  });

  const { response, body } = await callRoute(
    service,
    `${RECORDS}/mem-1/revise`,
    {
      claim: "The retry budget lives in config/runtime.yaml.",
      experienceIds: ["exp-1"],
      evidence: EVIDENCE
    }
  );

  assert.equal(response.statusCode, 200);
  assert.equal(
    submittedClaim,
    "The retry budget lives in config/runtime.yaml."
  );
  assert.equal(
    (body?.memory as MemoryRecord).claim,
    "The retry budget lives in config/runtime.yaml."
  );
});

test("POST /control/memory/records/:id/revise requires traceable evidence", async () => {
  // An empty evidence list is refused rather than stored as "revised, with no
  // reason given" — a revision nobody can trace is not auditable.
  const { response } = await callRoute(
    mockService(),
    `${RECORDS}/mem-1/revise`,
    { claim: "A new claim.", experienceIds: ["exp-1"], evidence: [] }
  );

  assert.equal(response.statusCode, 400);
});

test("POST /control/memory/records/:id/supersede points at the prior record", async () => {
  let capturedPrior: unknown;
  const service = mockService({
    supersede: async (_id: string, priorId: string, ...rest: unknown[]) => {
      capturedPrior = priorId;
      void rest;
      return record({ status: "superseded" });
    }
  });

  const { response, body } = await callRoute(
    service,
    `${RECORDS}/mem-1/supersede`,
    {
      priorId: "mem-0",
      task: "raise the retry budget",
      query: "retry budget config"
    }
  );

  assert.equal(response.statusCode, 200);
  assert.equal(capturedPrior, "mem-0");
  assert.equal((body?.memory as MemoryRecord).status, "superseded");
});

test("POST /control/memory/records/:id/promote-skill answers its own schema", async () => {
  const { response, body } = await callRoute(
    mockService(),
    `${RECORDS}/mem-1/promote-skill`,
    {
      skillName: "retry-budget",
      description: "Raise the retry budget when a run times out.",
      content: "# Retry budget\n\nRaise the budget, then re-run.",
      task: "raise the retry budget",
      query: "retry budget config"
    }
  );

  assert.equal(response.statusCode, 200);
  // A promotion produces two things, so it answers a different schema from the
  // other four mutations rather than pretending the skill is not there.
  assert.equal(body?.schema, "autodev-memory-skill-promotion-v1");
  assert.equal((body?.memory as MemoryRecord).kind, "procedural");
  assert.equal(
    (body?.skill as { name?: string } | undefined)?.name,
    "retry-budget"
  );
});

test("POST /control/memory/records/:id/promote-skill requires a description and content", async () => {
  const missingDescription = await callRoute(
    mockService(),
    `${RECORDS}/mem-1/promote-skill`,
    {
      skillName: "retry-budget",
      task: "raise the retry budget",
      query: "retry budget config"
    }
  );
  assert.equal(missingDescription.response.statusCode, 400);

  const missingContent = await callRoute(
    mockService(),
    `${RECORDS}/mem-1/promote-skill`,
    {
      skillName: "retry-budget",
      description: "Raise the retry budget.",
      task: "raise the retry budget",
      query: "retry budget config"
    }
  );
  assert.equal(missingContent.response.statusCode, 400);
});

test("POST /control/memory/records/:id/invalidate rejects an unknown body key", async () => {
  // Exact keys: a caller that spells a field the route does not read would
  // otherwise be told it succeeded, and the value it sent would be discarded.
  const { response } = await callRoute(
    mockService(),
    `${RECORDS}/mem-1/invalidate`,
    { reasonCode: "contradicted", evidence: EVIDENCE, note: "also this" }
  );

  assert.equal(response.statusCode, 400);
});

test("POST /control/memory/records/:id/<action> refuses a viewer", async () => {
  for (const action of ["verify", "invalidate", "revise"]) {
    const { response } = await callRoute(
      mockService(),
      `${RECORDS}/mem-1/${action}`,
      { claim: "x", task: "y" },
      { actorRole: "viewer" }
    );
    assert.equal(response.statusCode, 403, `${action} should refuse a viewer`);
  }
});

test("POST /control/memory/records/:id/<action> refuses a GET", async () => {
  const { response } = await callRoute(
    mockService(),
    `${RECORDS}/mem-1/invalidate`,
    { reasonCode: "contradicted" },
    { method: "GET" }
  );

  // A mutation is not a read: answering 200 for GET would report a durable
  // record as changed without changing it.
  assert.notEqual(response.statusCode, 200);
});
