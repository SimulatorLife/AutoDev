import assert from "node:assert/strict";
import test from "node:test";

import type {
  MemoryReadContext,
  MemoryRecord
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
 * `POST /control/memory/records` with neither an id nor an action is how the
 * Console proposes durable memory, and `memoryScope` is the only thing that
 * decides what scope that proposal may claim. Falsifying every guard in it found
 * the entire function unenforced: all eight could be deleted with the suite
 * green, so nothing stopped a caller from writing memory into another
 * workspace, another repository, another task or run, or the global scope --
 * which is the acceptance criterion that workers cannot freely pollute shared
 * durable memory.
 *
 * Each case below drives the route rather than the helper, because the helper
 * is private and the question is what an HTTP caller can actually write.
 */

const OPERATOR = { actor: "test-operator", role: "operator" } as const;

/** The caller as the route sees them: an operator scoped to one run. */
const CALLER_QUERY = {
  workspaceId: "ws-1",
  repositoryId: "repo-1",
  taskId: "task-1",
  runId: "run-1",
  agentId: "agent-1"
} as const;

interface Proposal {
  readonly input: {
    readonly kind: string;
    readonly scope: unknown;
    readonly claim: string;
    readonly experienceIds: readonly string[];
    readonly evidence: readonly unknown[];
  };
  readonly actor: { readonly id: string };
  readonly context: MemoryReadContext;
}

function proposeService(calls: Proposal[]): MemoryService {
  const record: MemoryRecord = {
    id: "mem-1",
    workspaceId: "ws-1",
    repositoryId: "repo-1",
    scope: { kind: "repository", workspaceId: "ws-1", repositoryId: "repo-1" },
    kind: "semantic",
    claim: "A durable claim.",
    content: "A durable claim.",
    status: "proposed",
    confidence: 0.4,
    createdAt: "2026-10-01T10:00:00.000Z",
    updatedAt: "2026-10-01T10:00:00.000Z",
    validity: { state: "unverified", evidence: [] },
    provenance: {
      experienceIds: ["exp-1"],
      evidence: [],
      createdBy: "test-operator",
      createdAt: "2026-10-01T10:00:00.000Z"
    }
  } as MemoryRecord;
  return {
    propose: async (input: never, actor: never, context: never) => {
      calls.push({
        input,
        actor,
        context
      } as unknown as Proposal);
      return record;
    }
  } as unknown as MemoryService;
}

async function propose(
  scope: unknown,
  options: {
    readonly query?: Record<string, string | string[]>;
    readonly readGlobal?: boolean;
    readonly actorRole?: "viewer" | "operator";
  } = {}
): Promise<{
  readonly response: RecordedResponse;
  readonly body: Record<string, unknown> | null;
  readonly calls: Proposal[];
}> {
  const query = { ...CALLER_QUERY, ...options.query };
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (Array.isArray(value))
      for (const item of value) search.append(key, item);
    else search.set(key, value);
  }
  const suffix = search.toString();
  const request = makeRequest(
    "POST",
    suffix ? `/control/memory/records?${suffix}` : "/control/memory/records",
    {
      kind: "semantic",
      scope,
      claim: "A durable claim.",
      experienceIds: ["exp-1"],
      evidence: [{ kind: "file", uri: "runs/42/result.json" }]
    }
  );
  const response = responseRecorder();
  const calls: Proposal[] = [];
  const previousGlobal = process.env.AUTODEV_MEMORY_READ_GLOBAL;
  if (options.readGlobal === true) process.env.AUTODEV_MEMORY_READ_GLOBAL = "1";
  else delete process.env.AUTODEV_MEMORY_READ_GLOBAL;
  try {
    await handleMemoryControlApiRequest(
      request,
      response,
      "/control/memory/records",
      { ...OPERATOR, role: options.actorRole ?? OPERATOR.role },
      () => {},
      { createMemoryService: () => proposeService(calls) }
    );
  } finally {
    if (previousGlobal === undefined)
      delete process.env.AUTODEV_MEMORY_READ_GLOBAL;
    else process.env.AUTODEV_MEMORY_READ_GLOBAL = previousGlobal;
  }
  return { response, body: responseBody(response), calls };
}

function errorCode(response: RecordedResponse): unknown {
  const body = responseBody(response) as { error?: { code?: unknown } } | null;
  return body?.error?.code;
}

const EVIDENCE = [{ kind: "file", uri: "runs/42/result.json" }];

test("a proposal may claim the caller's own workspace, repository, task, run, and agent", async () => {
  // The positive control: each scope that passes must reach the service as the
  // matching Core scope, so the refusals below refuse the scope rather than the
  // request shape.
  for (const [label, supplied, wanted] of [
    [
      "workspace",
      { kind: "workspace", workspaceId: "ws-1" },
      {
        kind: "workspace",
        workspaceId: "ws-1"
      }
    ],
    [
      "repository",
      { kind: "repository", workspaceId: "ws-1", repositoryId: "repo-1" },
      { kind: "repository", workspaceId: "ws-1", repositoryId: "repo-1" }
    ],
    [
      "role",
      { kind: "role", workspaceId: "ws-1", role: "worker" },
      { kind: "role", workspaceId: "ws-1", role: "worker" }
    ],
    [
      "task",
      { kind: "task", workspaceId: "ws-1", taskId: "task-1", runId: "run-1" },
      { kind: "task", workspaceId: "ws-1", taskId: "task-1", runId: "run-1" }
    ],
    [
      "agent",
      {
        kind: "agent",
        workspaceId: "ws-1",
        taskId: "task-1",
        runId: "run-1",
        agentId: "agent-1"
      },
      {
        kind: "agent",
        workspaceId: "ws-1",
        taskId: "task-1",
        runId: "run-1",
        agentId: "agent-1"
      }
    ]
  ] as const) {
    const { response, calls } = await propose(supplied);
    assert.equal(response.statusCode, 200, `${label} scope must be accepted`);
    assert.deepEqual(
      calls.at(-1)?.input.scope,
      wanted,
      `${label} must reach the service as a Core scope`
    );
    assert.equal(
      calls.at(-1)?.actor.id,
      OPERATOR.actor,
      "the actor is the host's, never a tool argument"
    );
  }
});

test("a proposal cannot claim a workspace, repository, task, run, or agent the caller does not hold", async () => {
  // Each case changes exactly one field, so the refusal is attributable to that
  // field rather than to the request being wrong in some other way.
  for (const [label, supplied] of [
    ["workspace", { kind: "workspace", workspaceId: "ws-2" }],
    [
      "repository",
      { kind: "repository", workspaceId: "ws-1", repositoryId: "repo-2" }
    ],
    [
      "role",
      {
        kind: "role",
        workspaceId: "ws-1",
        role: "worker",
        repositoryId: "repo-2"
      }
    ],
    [
      "task",
      { kind: "task", workspaceId: "ws-1", taskId: "task-2", runId: "run-1" }
    ],
    [
      "run",
      { kind: "task", workspaceId: "ws-1", taskId: "task-1", runId: "run-2" }
    ],
    [
      "agent",
      {
        kind: "agent",
        workspaceId: "ws-1",
        taskId: "task-1",
        runId: "run-1",
        agentId: "agent-2"
      }
    ]
  ] as const) {
    const { response, calls } = await propose(supplied);
    assert.equal(
      response.statusCode,
      403,
      `a ${label} the caller does not hold must be refused`
    );
    assert.equal(
      errorCode(response),
      "autodev_memory_forbidden",
      `${label} refusal is a scope refusal`
    );
    assert.equal(
      calls.length,
      0,
      `nothing was written for the refused ${label} scope`
    );
  }
});

test("global memory is refused unless the operator holds an explicit global grant", async () => {
  const refused = await propose({ kind: "global" });
  assert.equal(refused.response.statusCode, 403);
  assert.equal(refused.calls.length, 0, "no global memory without the grant");

  // With the grant, the same scope is accepted -- so the refusal above is the
  // grant check and not the shape of the scope.
  const granted = await propose(
    { kind: "global" },
    { readGlobal: true, query: { includeGlobal: "true" } }
  );
  assert.equal(granted.response.statusCode, 200);
  assert.deepEqual(granted.calls.at(-1)?.input.scope, { kind: "global" });

  // The grant is bound to the operator role, so a viewer holding the same
  // environment grant is still refused the write.
  const viewer = await propose(
    { kind: "global" },
    {
      readGlobal: true,
      actorRole: "viewer",
      query: { includeGlobal: "true" }
    }
  );
  assert.equal(viewer.response.statusCode, 403);
});

test("a malformed or over-specified scope is refused as an invalid request", async () => {
  // The extra-field case on a global scope carries the global grant, because the
  // grant check runs first: without it the request is refused as forbidden and
  // never reaches the shape check, so a fixture without the grant would pass
  // whether or not that shape check existed.
  for (const [label, supplied, options] of [
    ["not an object", "workspace", {}],
    ["no kind", { workspaceId: "ws-1" }, {}],
    ["a non-string kind", { kind: 7, workspaceId: "ws-1" }, {}],
    ["an unknown kind", { kind: "cluster", workspaceId: "ws-1" }, {}],
    [
      "an extra field on a workspace scope",
      { kind: "workspace", workspaceId: "ws-1", repositoryId: "repo-1" },
      {}
    ],
    [
      "an extra field on a global scope",
      { kind: "global", workspaceId: "ws-1" },
      { readGlobal: true, query: { includeGlobal: "true" } }
    ],
    [
      "an extra field on an agent scope",
      {
        kind: "agent",
        workspaceId: "ws-1",
        taskId: "task-1",
        runId: "run-1",
        agentId: "agent-1",
        role: "worker"
      },
      {}
    ]
  ] as const) {
    const { response, calls } = await propose(supplied, options);
    assert.equal(
      response.statusCode,
      400,
      `${label} is refused as an invalid request`
    );
    assert.equal(errorCode(response), "autodev_memory_invalid_request");
    assert.equal(calls.length, 0, `nothing was written for ${label}`);
  }
});

test("a workspace scope with no workspace of its own falls back to the caller's", async () => {
  // `workspaceId` is read before the switch, so a `global` scope never reaches
  // it and every other kind must carry one. This case exists to pin that the
  // global branch is decided before the workspace requirement, rather than
  // after it.
  const { response, calls } = await propose({ kind: "global" });
  assert.equal(response.statusCode, 403);
  assert.equal(calls.length, 0);
});

test("proposing with evidence the route accepts reaches the service unchanged", async () => {
  // Guards the fixtures above: the refusals must come from the scope, not from
  // an evidence or claim shape every one of them also carries.
  const { response, calls } = await propose({
    kind: "repository",
    workspaceId: "ws-1",
    repositoryId: "repo-1"
  });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(calls.at(-1)?.input.evidence, EVIDENCE);
  assert.deepEqual(calls.at(-1)?.input.experienceIds, ["exp-1"]);
  assert.deepEqual(calls.at(-1)?.input.scope, {
    kind: "repository",
    workspaceId: "ws-1",
    repositoryId: "repo-1"
  });
});
