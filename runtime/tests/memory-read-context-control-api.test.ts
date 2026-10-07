import assert from "node:assert/strict";
import test from "node:test";

import type {
  MemoryReadContext,
  MemoryRecordPage
} from "@simulatorlife/autodev-core";
import type { MemoryService } from "@simulatorlife/autodev-runtime/memory";

import { handleMemoryControlApiRequest } from "../src/control-api/memory.ts";
import {
  makeRequest,
  type RecordedResponse,
  responseBody,
  responseRecorder
} from "./support/control-api-harness.ts";

/**
 * `readContext` is where an HTTP query string becomes the trusted
 * `MemoryReadContext` every read runs under. It is the read-side twin of the
 * scope validator, and falsifying its guards found all nine unenforced: a
 * repeated filter, an oversized one, a control character in one, a `taskId`
 * without its `runId`, an `agentId` with no task, and — the two that matter —
 * the grants for global and task-history reads could both be deleted and
 * nothing noticed.
 *
 * The grants are the point. Global and task-history access are explicit grants,
 * not something a request may imply, and Core says so on the type itself.
 * Without the check, `includeGlobal=true` without the grant stopped being a
 * refusal and became a silently narrower read: the caller got a 200 and an
 * answer that quietly omitted what they asked for.
 */

interface ReadResult {
  readonly response: RecordedResponse;
  readonly body: Record<string, unknown> | null;
  readonly context: MemoryReadContext | null;
}

function readService(contexts: MemoryReadContext[]): MemoryService {
  return {
    listMemories: async (request: { context: MemoryReadContext }) => {
      contexts.push(request.context);
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
      } as unknown as MemoryRecordPage;
    }
  } as unknown as MemoryService;
}

async function read(
  query: Record<string, string | readonly string[]>,
  options: {
    readonly actorRole?: "viewer" | "operator";
    readonly readGlobal?: boolean;
    readonly readTaskHistory?: boolean;
  } = {}
): Promise<ReadResult> {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (typeof value === "string") search.set(key, value);
    else for (const item of value) search.append(key, item);
  }
  const suffix = search.toString();
  const request = makeRequest(
    "GET",
    suffix ? `/control/memory/records?${suffix}` : "/control/memory/records"
  );
  const response = responseRecorder();
  const contexts: MemoryReadContext[] = [];
  const previousGlobal = process.env.AUTODEV_MEMORY_READ_GLOBAL;
  const previousHistory = process.env.AUTODEV_MEMORY_READ_TASK_HISTORY;
  if (options.readGlobal === true) process.env.AUTODEV_MEMORY_READ_GLOBAL = "1";
  else delete process.env.AUTODEV_MEMORY_READ_GLOBAL;
  if (options.readTaskHistory === true)
    process.env.AUTODEV_MEMORY_READ_TASK_HISTORY = "1";
  else delete process.env.AUTODEV_MEMORY_READ_TASK_HISTORY;
  try {
    await handleMemoryControlApiRequest(
      request,
      response,
      "/control/memory/records",
      { actor: "test-operator", role: options.actorRole ?? "operator" },
      () => {},
      { createMemoryService: () => readService(contexts) }
    );
  } finally {
    if (previousGlobal === undefined)
      delete process.env.AUTODEV_MEMORY_READ_GLOBAL;
    else process.env.AUTODEV_MEMORY_READ_GLOBAL = previousGlobal;
    if (previousHistory === undefined)
      delete process.env.AUTODEV_MEMORY_READ_TASK_HISTORY;
    else process.env.AUTODEV_MEMORY_READ_TASK_HISTORY = previousHistory;
  }
  return {
    response,
    body: responseBody(response),
    context: contexts.at(-1) ?? null
  };
}

function errorCode(response: RecordedResponse): unknown {
  const body = responseBody(response) as { error?: { code?: unknown } } | null;
  return body?.error?.code;
}

test("a read filter set becomes the context the read actually runs under", async () => {
  // The positive control for every refusal below: this exact filter set is
  // accepted, so each refused case is refused by the one field it changes.
  const { response, context } = await read({
    workspaceId: "ws-1",
    repositoryId: "repo-1",
    role: "worker",
    taskId: "task-1",
    runId: "run-1",
    agentId: "agent-1"
  });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(context, {
    workspaceId: "ws-1",
    repositoryId: "repo-1",
    role: "worker",
    taskId: "task-1",
    runId: "run-1",
    agentId: "agent-1",
    canReadGlobal: false,
    canReadTaskHistory: false
  });
});

test("a global read needs the operator grant, not just the request for one", async () => {
  const refused = await read({ workspaceId: "ws-1", includeGlobal: "true" });
  assert.equal(refused.response.statusCode, 403);
  assert.equal(refused.context, null, "nothing was read");

  // The grant is the environment flag, not the query. An operator with the
  // flag is the same request answered differently.
  const granted = await read(
    { workspaceId: "ws-1", includeGlobal: "true" },
    { readGlobal: true }
  );
  assert.equal(granted.response.statusCode, 200);
  assert.equal(granted.context?.canReadGlobal, true);

  // ...and the grant is bound to the operator role, so the flag alone does not
  // extend a viewer.
  const viewer = await read(
    { workspaceId: "ws-1", includeGlobal: "true" },
    { readGlobal: true, actorRole: "viewer" }
  );
  assert.equal(viewer.response.statusCode, 403);
  assert.equal(viewer.context, null);
});

test("a task-history read needs the operator grant, not just the request for one", async () => {
  const refused = await read({
    workspaceId: "ws-1",
    includeTaskHistory: "true"
  });
  assert.equal(refused.response.statusCode, 403);
  assert.equal(refused.context, null, "nothing was read");

  const granted = await read(
    { workspaceId: "ws-1", includeTaskHistory: "true" },
    { readTaskHistory: true }
  );
  assert.equal(granted.response.statusCode, 200);
  assert.equal(granted.context?.canReadTaskHistory, true);

  const viewer = await read(
    { workspaceId: "ws-1", includeTaskHistory: "true" },
    { readTaskHistory: true, actorRole: "viewer" }
  );
  assert.equal(viewer.response.statusCode, 403);
});

test("a scope request that is not a single boolean is refused rather than ignored", async () => {
  for (const name of ["includeGlobal", "includeTaskHistory"]) {
    for (const [label, value] of [
      ["a non-boolean", "yes"],
      ["an empty value", ""],
      ["a repeated request", ["true", "false"]]
    ] as const) {
      const { response, context } = await read({
        workspaceId: "ws-1",
        [name]: value
      });
      assert.equal(
        response.statusCode,
        400,
        `${name} with ${label} is refused`
      );
      assert.equal(errorCode(response), "autodev_memory_invalid_filter");
      assert.equal(context, null, `${name} with ${label} read nothing`);
    }
  }
});

test("a filter that is repeated, oversized, or carries a control character is refused", async () => {
  for (const [label, query] of [
    ["a repeated filter", { workspaceId: ["ws-1", "ws-2"] }],
    [
      "an oversized filter",
      { workspaceId: "ws-1", repositoryId: "r".repeat(2049) }
    ],
    [
      "a filter with a control character",
      { workspaceId: "ws-1", role: "worker" }
    ]
  ] as const) {
    const { response, context } = await read(query);
    assert.equal(response.statusCode, 400, `${label} is refused`);
    assert.equal(errorCode(response), "autodev_memory_invalid_filter");
    assert.equal(context, null, `${label} read nothing`);
  }
});

test("workspaceId is required, because every read is scoped to one workspace", async () => {
  const { response, context } = await read({ repositoryId: "repo-1" });
  assert.equal(response.statusCode, 400);
  assert.equal(errorCode(response), "autodev_memory_invalid_filter");
  assert.equal(context, null, "an unscoped read is not an unscoped query");
});

test("a task scope cannot be half-supplied, and an agent cannot stand alone", async () => {
  // The context type pairs `taskId` with `runId`, and the scope builder asserts
  // `runId` is present with a non-null assertion. Supplying one without the
  // other is what that assertion would be papering over.
  for (const [label, query] of [
    ["a task without a run", { workspaceId: "ws-1", taskId: "task-1" }],
    ["a run without a task", { workspaceId: "ws-1", runId: "run-1" }],
    ["an agent with no task", { workspaceId: "ws-1", agentId: "agent-1" }]
  ] as const) {
    const { response, context } = await read(query);
    assert.equal(response.statusCode, 400, `${label} is refused`);
    assert.equal(errorCode(response), "autodev_memory_invalid_filter");
    assert.equal(context, null, `${label} read nothing`);
  }
});
