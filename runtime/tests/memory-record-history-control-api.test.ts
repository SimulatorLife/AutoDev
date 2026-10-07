import assert from "node:assert/strict";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import test from "node:test";

import type {
  MemoryHistory,
  MemoryLifecycleEvent,
  MemoryReadContext,
  MemoryRecord
} from "@simulatorlife/autodev-core";
import type { MemoryService } from "@simulatorlife/autodev-runtime/memory";

import { handleMemoryControlApiRequest } from "../src/control-api/memory.ts";

interface RecordedResponse extends ServerResponse {
  readonly statusCode: number;
  readonly body: string;
}

class ResponseRecorder {
  statusCode = 0;
  body = "";
  headersSent = false;
  writableEnded = false;
  private readonly chunks: Buffer[] = [];

  setHeader(): this {
    return this;
  }
  writeHead(status: number): this {
    this.statusCode = status;
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

function request(method: string, url: string): IncomingMessage {
  const stream = Readable.from([]);
  return Object.assign(stream, { method, url, headers: {} }) as IncomingMessage;
}

async function callHistoryRoute(history: MemoryHistory | null): Promise<{
  readonly status: number;
  readonly body: Record<string, unknown> | null;
}> {
  const service = {
    history: async (
      _id: string,
      _context: MemoryReadContext
    ): Promise<MemoryHistory | null> => history
  } as unknown as MemoryService;
  const response = new ResponseRecorder() as unknown as RecordedResponse;
  await handleMemoryControlApiRequest(
    request("GET", "/control/memory/records/mem-1/history?workspaceId=ws-1"),
    response,
    "/control/memory/records/mem-1/history",
    { actor: "test-operator", role: "operator" },
    () => {},
    { createMemoryService: () => service }
  );
  return {
    status: response.statusCode,
    body: response.body ? JSON.parse(response.body) : null
  };
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
    status: "uncertain",
    confidence: 0.4,
    createdAt: "2026-10-01T10:00:00.000Z",
    updatedAt: "2026-10-02T10:00:00.000Z",
    validity: {
      state: "contradicted",
      checkedAt: "2026-10-02T10:00:00.000Z",
      verificationSource: "git_github_pr_supersession",
      evidence: []
    },
    provenance: {
      experienceIds: ["exp-1"],
      lastVerifiedAt: "2026-10-02T10:00:00.000Z",
      verificationSource: "git_github_pr_supersession"
    },
    ...overrides
  } as MemoryRecord;
}

/**
 * A verification whose evidence was replaced by a later pull request.
 *
 * The reason code is the only thing on the wire that says *why* this claim is
 * no longer trustworthy, so it is the thing the operator surface most needs and
 * the thing this route previously dropped.
 */
const supersededEvent: MemoryLifecycleEvent = {
  id: "event-2",
  memoryId: "mem-1",
  action: "verified",
  actorId: "curator-1",
  occurredAt: "2026-10-02T10:00:00.000Z",
  fromStatus: "proposed",
  toStatus: "uncertain",
  reasonCode: "superseded",
  evidence: [
    {
      kind: "commit",
      uri: "https://github.com/owner/repo/commit/abc123",
      revision: "abc123"
    }
  ],
  relatedMemoryIds: []
};

const proposedEvent: MemoryLifecycleEvent = {
  id: "event-1",
  memoryId: "mem-1",
  action: "proposed",
  actorId: "reporter-1",
  occurredAt: "2026-10-01T10:00:00.000Z",
  toStatus: "proposed",
  reasonCode: "candidate_submitted",
  evidence: [],
  relatedMemoryIds: []
};

test("GET /control/memory/records/:id/history emits the transitions the Console requires", async () => {
  const { status, body } = await callHistoryRoute({
    memory: record(),
    relatedMemories: [],
    events: [proposedEvent, supersededEvent]
  });

  assert.equal(status, 200);
  assert.equal(body?.schema, "autodev-memory-history-v1");
  // The Console refuses a history response without this list, so a route that
  // answers with the raw repository shape fails the record detail page
  // outright rather than degrading it.
  assert.equal(Array.isArray(body?.transitions), true);

  const transitions = (body?.transitions ?? []) as Array<
    Record<string, unknown>
  >;
  assert.equal(transitions.length, 2);
  assert.deepEqual(
    transitions.map((transition) => transition.toStatus),
    ["proposed", "uncertain"]
  );
  assert.deepEqual(
    transitions.map((transition) => transition.reasonCode),
    ["candidate_submitted", "superseded"]
  );
  // The actor and the instant are what make a transition an audit record
  // rather than a status change with no attribution.
  assert.equal(transitions[1]?.actorId, "curator-1");
  assert.equal(transitions[1]?.occurredAt, "2026-10-02T10:00:00.000Z");
});

test("GET /control/memory/records/:id/history answers an empty history with an empty list", async () => {
  const { status, body } = await callHistoryRoute({
    memory: record(),
    relatedMemories: [],
    events: []
  });

  assert.equal(status, 200);
  // No transitions is a fact about the record. A missing list is a fact about
  // the response, and the Console is right to refuse the second.
  assert.deepEqual(body?.transitions, []);
});

test("GET /control/memory/records/:id/history answers an unreadable record with 404, not an empty history", async () => {
  const { status, body } = await callHistoryRoute(null);

  assert.equal(status, 404);
  const error = body?.error as Record<string, unknown> | undefined;
  assert.equal(error?.code, "autodev_memory_not_found");
  // A record this reader cannot see and a record with no history are different
  // facts; answering the second with the first would render an unreadable
  // record as one that was never changed.
  assert.equal(body?.transitions, undefined);
});
