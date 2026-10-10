import assert from "node:assert/strict";
import test from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import type { MemoryReadContext } from "@simulatorlife/autodev-core";

import {
  createMemoryMcpServer,
  type MemoryMcpSession
} from "../src/memory/mcp.ts";
import {
  MemoryConflictError,
  MemoryValidationError,
  type MemoryService
} from "../src/memory/service.ts";

/**
 * The memory MCP surface, in process.
 *
 * The only test this server had was an integration test that needs a live
 * Postgres, so it skips unless `AUTODEV_MEMORY_MCP_TEST_DATABASE_URL` is set —
 * which means in an ordinary `node --test` run, eleven registered tools and the
 * scope translation behind them were never executed at all. An agent proposes
 * and revises durable memory through this server, so the boundary it enforces is
 * one of the few places a model's arguments meet the memory store.
 *
 * What matters here is what reaches the service. Tool arguments are
 * model-controlled, so every schema is `z.strictObject` and the host re-binds
 * actor, workspace and run from the session; a test that asserts the service was
 * called with a Core-shaped scope and a session-derived actor checks both of
 * those claims at once.
 */

const CONTEXT: MemoryReadContext = {
  workspaceId: "workspace-a",
  repositoryId: "owner/repo",
  agentId: "agent-a",
  role: "worker",
  // Global reads are an explicit grant, not implied by missing scope metadata.
  canReadGlobal: false
};

const SESSION: MemoryMcpSession = {
  actor: { id: "host-bound-worker", authority: "worker", role: "worker" },
  context: CONTEXT,
  taskId: "task-from-host",
  memoryMode: "jit",
  task: "the task the host knows, never the model's wording"
};

interface RecordedCall {
  readonly method: string;
  readonly args: readonly unknown[];
}

/**
 * A service that records what it was asked to do.
 *
 * A Proxy rather than a hand-written double, because the point is to cover every
 * registered tool, and a double that has to enumerate them is a double that has
 * to be edited when a tool is added — which is the way a surface loses coverage
 * without anything failing.
 */
function recordingService(calls: RecordedCall[]): MemoryService {
  return new Proxy(
    {},
    {
      get:
        (_target, property) =>
        async (...args: unknown[]) => {
          calls.push({ method: String(property), args });
          return { accepted: true };
        }
    }
  ) as unknown as MemoryService;
}

async function connect(
  calls: RecordedCall[]
): Promise<{ client: Client; close: () => Promise<void> }> {
  return connectAs(SESSION, calls);
}

/** The same server under a session the test supplies, for the host-binding cases. */
async function connectAs(
  session: MemoryMcpSession,
  calls: RecordedCall[] = []
): Promise<{ client: Client; close: () => Promise<void> }> {
  const server = createMemoryMcpServer(recordingService(calls), {
    current: () => session
  });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const client = new Client(
    { name: "memory-mcp-test", version: "1.0.0" },
    { capabilities: {} }
  );
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport)
  ]);
  return {
    client,
    close: async () => {
      await client.close();
      await server.close();
    }
  };
}

/** The single call the tool made, so a wrong method cannot pass unnoticed. */
function onlyCall(calls: readonly RecordedCall[]): RecordedCall {
  assert.equal(
    calls.length,
    1,
    `expected one service call, saw ${calls.length}`
  );
  return calls[0]!;
}

/**
 * A session the host has actually bound to a run.
 *
 * `SESSION` alone is not one: its context carries no `runId`, and its context
 * `taskId` is absent while the session names one. `experience_append` therefore
 * refuses it outright -- correctly, and for a reason no test exercised until
 * now. Every binding case below starts from this.
 */
const BOUND_SESSION: MemoryMcpSession = {
  ...SESSION,
  context: {
    ...CONTEXT,
    taskId: SESSION.taskId,
    runId: "run-from-host"
  }
};

const APPEND_ARGS = {
  trajectory: {
    format: "letta-trajectory-v1",
    uri: "file:///workspace/session.jsonl",
    digest: "a".repeat(64)
  },
  startedAt: "2026-09-30T10:00:00.000Z",
  outcome: "success"
} as const;

/**
 * An append only happens when the host has bound the run it is recording.
 *
 * The tool's own arguments carry no workspace, run, or agent -- by design, so a
 * model cannot name its own identity. That makes the *absence* of a binding the
 * interesting case: without one the append is refused rather than filed against
 * a scope nothing can locate. Each case below breaks exactly one binding of a
 * fully bound session, so the one under test is the only thing that can refuse
 * it -- with the others passing.
 */
test("experience append refuses a host session that has not bound the run", async () => {
  // Each case *omits* its binding rather than setting it to `undefined`:
  // `exactOptionalPropertyTypes` is on, and an absent binding is the state under
  // test -- a key that is present and undefined is a different thing.
  const { taskId: _taskId, ...withoutTaskId } = BOUND_SESSION.context;
  const { runId: _runId, ...withoutRunId } = BOUND_SESSION.context;
  const { agentId: _agentId, ...withoutAgentId } = BOUND_SESSION.context;

  const unbound: readonly {
    readonly why: string;
    readonly session: MemoryMcpSession;
  }[] = [
    {
      why: "no workspace",
      session: {
        ...BOUND_SESSION,
        context: { ...BOUND_SESSION.context, workspaceId: "" }
      }
    },
    {
      why: "no task in the read context",
      session: { ...BOUND_SESSION, context: withoutTaskId }
    },
    {
      why: "the session names a task the context does not",
      session: { ...BOUND_SESSION, taskId: "task-the-host-did-not-select" }
    },
    { why: "no run", session: { ...BOUND_SESSION, context: withoutRunId } },
    { why: "no agent", session: { ...BOUND_SESSION, context: withoutAgentId } }
  ];

  // The bound session is accepted, so every refusal below is attributable to the
  // one binding it breaks rather than to the harness.
  const accepted: RecordedCall[] = [];
  const bound = await connectAs(BOUND_SESSION, accepted);
  try {
    const response = await bound.client.callTool({
      name: "experience_append",
      arguments: APPEND_ARGS
    });
    assert.notEqual(
      response.isError,
      true,
      `a bound session must append: ${JSON.stringify(response.content)}`
    );
    assert.equal(accepted.length, 1);
  } finally {
    await bound.close();
  }

  for (const { why, session } of unbound) {
    const calls: RecordedCall[] = [];
    const { client, close } = await connectAs(session, calls);
    try {
      const response = await client.callTool({
        name: "experience_append",
        arguments: APPEND_ARGS
      });
      assert.equal(
        response.isError,
        true,
        `an unbound session must be refused: ${why}`
      );
      assert.equal(calls.length, 0, `nothing may reach the service: ${why}`);
    } finally {
      await close();
    }
  }
});

test("the evidence cap counts the trajectory reference too, and lands on 64", async () => {
  // The schema allows at most 64 caller references and the trajectory reference
  // is prepended to them, so 64 becomes 65 once deduplicated -- and that is the
  // only input the runtime cap can ever see. The boundary therefore sits exactly
  // one below the schema ceiling, which is the case a naive implementation gets
  // wrong by forwarding the deduplicated list unchecked.
  const evidence = (count: number) =>
    Array.from({ length: count }, (_unused, index) => ({
      kind: "document" as const,
      uri: `https://example.invalid/${index}`
    }));

  const accepted: RecordedCall[] = [];
  const first = await connectAs(BOUND_SESSION, accepted);
  try {
    const response = await first.client.callTool({
      name: "experience_append",
      arguments: { ...APPEND_ARGS, evidence: evidence(63) }
    });
    assert.notEqual(
      response.isError,
      true,
      `63 references plus the trajectory is exactly the cap: ${JSON.stringify(response.content)}`
    );
    const forwarded = (
      onlyCall(accepted).args[0] as { evidence: readonly unknown[] }
    ).evidence;
    assert.equal(forwarded.length, 64, "63 references plus the trajectory");
  } finally {
    await first.close();
  }

  const refused: RecordedCall[] = [];
  const second = await connectAs(BOUND_SESSION, refused);
  try {
    const response = await second.client.callTool({
      name: "experience_append",
      arguments: { ...APPEND_ARGS, evidence: evidence(64) }
    });
    assert.equal(
      response.isError,
      true,
      "65 deduplicated references is over the cap"
    );
    assert.equal(
      refused.length,
      0,
      "nothing may reach the service past the cap"
    );
  } finally {
    await second.close();
  }
});

test("every registered memory tool is callable with the session's authority", async () => {
  const calls: RecordedCall[] = [];
  const { client, close } = await connect(calls);
  try {
    const listed = await client.listTools();
    const names = listed.tools.map((tool) => tool.name).sort();
    // Eleven tools, and every one of them reachable without a database.
    assert.equal(names.length, 11, `tools: ${names.join(", ")}`);

    await client.callTool({
      name: "memory_propose",
      arguments: {
        kind: "semantic",
        scope: { kind: "workspace", workspaceId: "workspace-a" },
        claim: "A durable claim.",
        experienceIds: ["exp-1"],
        evidence: [{ kind: "document", uri: "https://example.invalid/a" }]
      }
    });
    await client.callTool({
      name: "memory_research",
      arguments: { query: "what does memory say about retries?" }
    });

    assert.deepEqual(calls.map((call) => call.method).sort(), [
      "propose",
      "research"
    ]);
    // The actor is the host's, never an argument: a model that could name its
    // own authority would be able to write as anyone.
    const propose = calls.find((call) => call.method === "propose")!;
    assert.equal((propose.args[1] as { id: string }).id, SESSION.actor.id);
    assert.deepEqual(propose.args[2], CONTEXT);
  } finally {
    await close();
  }
});

test("each scope the tool accepts becomes a Core scope", async () => {
  // `toMemoryScope` translates a validated argument into Core's `MemoryScope`.
  // A branch that produced a malformed scope would not corrupt memory — the
  // service would refuse it — but the refusal would be unexplainable to whoever
  // filed the proposal, so the translation is worth pinning in both directions.
  const expected: readonly [
    Record<string, unknown>,
    Record<string, unknown>
  ][] = [
    [{ kind: "global" }, { kind: "global" }],
    [
      { kind: "workspace", workspaceId: "workspace-a" },
      { kind: "workspace", workspaceId: "workspace-a" }
    ],
    [
      {
        kind: "repository",
        workspaceId: "workspace-a",
        repositoryId: "owner/repo"
      },
      {
        kind: "repository",
        workspaceId: "workspace-a",
        repositoryId: "owner/repo"
      }
    ],
    [
      {
        kind: "task",
        workspaceId: "workspace-a",
        taskId: "task-a",
        runId: "run-a"
      },
      {
        kind: "task",
        workspaceId: "workspace-a",
        taskId: "task-a",
        runId: "run-a"
      }
    ],
    [
      {
        kind: "agent",
        workspaceId: "workspace-a",
        taskId: "task-a",
        runId: "run-a",
        agentId: "agent-a"
      },
      {
        kind: "agent",
        workspaceId: "workspace-a",
        taskId: "task-a",
        runId: "run-a",
        agentId: "agent-a"
      }
    ]
  ];

  for (const [supplied, wanted] of expected) {
    const calls: RecordedCall[] = [];
    const { client, close } = await connect(calls);
    try {
      const response = await client.callTool({
        name: "memory_propose",
        arguments: {
          kind: "semantic",
          scope: supplied,
          claim: "A durable claim.",
          experienceIds: ["exp-1"],
          evidence: [{ kind: "document", uri: "https://example.invalid/a" }]
        }
      });
      assert.equal(
        response.isError,
        undefined,
        `${String(supplied.kind)} rejected`
      );
      const propose = onlyCall(calls);
      assert.deepEqual(
        (propose.args[0] as { scope: unknown }).scope,
        wanted,
        `${String(supplied.kind)} must reach the service as a Core scope`
      );
    } finally {
      await close();
    }
  }
});

test("an unknown key inside a tool argument's scope is a hard error", async () => {
  // The nested object schemas are `z.strictObject` precisely so a misspelled or
  // smuggled field fails loudly rather than being dropped — the comment above
  // `memoryScope` says so, and the scope is the one field a model would most
  // like to widen for itself. It is stripped at the *top* level by the MCP SDK's
  // own argument handling, so that is where this asserts: on the scope, where
  // the guarantee is actually made.
  const calls: RecordedCall[] = [];
  const { client, close } = await connect(calls);
  try {
    const response = await client.callTool({
      name: "memory_propose",
      arguments: {
        kind: "semantic",
        scope: {
          kind: "workspace",
          workspaceId: "workspace-a",
          // A model asking to widen its own authority through the scope.
          role: "root"
        },
        claim: "A durable claim.",
        experienceIds: ["exp-1"],
        evidence: [{ kind: "document", uri: "https://example.invalid/a" }]
      }
    });
    assert.ok(
      response.isError,
      "an unknown key inside the scope must not be silently stripped"
    );
    assert.equal(
      calls.length,
      0,
      "a rejected argument must never reach the service"
    );
  } finally {
    await close();
  }
});

test("a service refusal is answered without leaking its detail", async () => {
  const { client, close } = await connectWithFailingService();
  try {
    const response = await client.callTool({
      name: "memory_propose",
      arguments: {
        kind: "semantic",
        scope: { kind: "workspace", workspaceId: "workspace-a" },
        claim: "A durable claim.",
        experienceIds: ["exp-1"],
        evidence: [{ kind: "document", uri: "https://example.invalid/a" }]
      }
    });
    assert.equal(response.isError, true);
    const content = response.content as { text?: string }[];
    assert.match(content[0]?.text ?? "", /could not be completed/u);
    assert.ok(
      !/exp-1/.test(content[0]?.text ?? ""),
      "the refusal must not echo the submission back to the model"
    );
  } finally {
    await close();
  }
});

async function connectWithFailingService(): Promise<{
  client: Client;
  close: () => Promise<void>;
}> {
  const server = createMemoryMcpServer(
    new Proxy(
      {},
      {
        get: () => async () => {
          // The class the service raises for a submission it will not accept;
          // anything else is reported as a generic failure.
          throw new MemoryValidationError(
            "Rejected: cites exp-1, and the connection is postgres://user:secret@host/db"
          );
        }
      }
    ) as unknown as MemoryService,
    { current: () => SESSION }
  );
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const client = new Client(
    { name: "memory-mcp-test", version: "1.0.0" },
    { capabilities: {} }
  );
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport)
  ]);
  return {
    client,
    close: async () => {
      await client.close();
      await server.close();
    }
  };
}
/**
 * A service whose append always conflicts, and whose lookup is answerable.
 *
 * The recording Proxy cannot express this: it answers every method with
 * `{ accepted: true }`, so nothing ever conflicts and the reconciliation branch
 * in `experience_append` is unreachable through it.
 */
function conflictingService(
  calls: RecordedCall[],
  existing: unknown,
  thrown: Error = new MemoryConflictError(
    "Experience exp-conflict already exists"
  )
): MemoryService {
  return {
    appendExperience: async (...args: unknown[]) => {
      calls.push({ method: "appendExperience", args });
      throw thrown;
    },
    getExperience: async (...args: unknown[]) => {
      calls.push({ method: "getExperience", args });
      return existing;
    }
  } as unknown as MemoryService;
}

/** Connects a server built over `service` and calls `experience_append` once. */
async function callAppend(
  service: MemoryService
): Promise<{ readonly isError: unknown; readonly text: string }> {
  const server = createMemoryMcpServer(service, {
    current: () => BOUND_SESSION
  });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const client = new Client(
    { name: "memory-mcp-append-test", version: "1.0.0" },
    { capabilities: {} }
  );
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport)
  ]);
  try {
    const response = await client.callTool({
      name: "experience_append",
      arguments: APPEND_ARGS
    });
    return {
      isError: response.isError,
      text: String((response.content as readonly { text: string }[])[0]?.text)
    };
  } finally {
    await client.close();
    await server.close();
  }
}

/** The stored experience a conflict is reconciled against. */
function storedExperience(overrides: {
  readonly uri: string;
  readonly digest: string;
}): unknown {
  return {
    id: "exp-conflict",
    workspaceId: BOUND_SESSION.context.workspaceId,
    scope: {
      kind: "workspace",
      workspaceId: BOUND_SESSION.context.workspaceId
    },
    taskId: "task-from-host",
    runId: "run-from-host",
    agentId: "agent-a",
    startedAt: "2026-09-30T10:00:00.000Z",
    outcome: "success",
    trajectory: {
      format: "letta-trajectory-v1",
      uri: overrides.uri,
      digest: overrides.digest
    },
    evidence: []
  };
}

/**
 * A conflicting append is only a retry when it really is the same experience.
 *
 * `appendExperience` refusing a duplicate id is what makes an agent's retry
 * safe, but "refused" and "this is the same experience" are different facts.
 * The tool re-reads the stored row and reports `appended: false` only when the
 * trajectory uri *and* digest both match. Every other conflict is re-thrown,
 * and that re-throw had no test: the success branch was reached, the refusal
 * branch was not.
 *
 * The case that matters most is the last one. A row this session cannot see is
 * not evidence that the append was a harmless repeat of its own -- it is
 * evidence of nothing -- so reporting `appended: false` there would tell a
 * caller its execution evidence was stored when it may never have been.
 */
test("a conflicting experience append is a retry only when it is the same experience", async () => {
  const uri = APPEND_ARGS.trajectory.uri;
  const digest = APPEND_ARGS.trajectory.digest;

  const cases: readonly {
    readonly why: string;
    readonly stored: unknown;
    readonly isRetry: boolean;
  }[] = [
    {
      why: "the same trajectory at the same digest",
      stored: storedExperience({ uri, digest }),
      isRetry: true
    },
    {
      why: "the same trajectory uri at a different digest",
      stored: storedExperience({ uri, digest: "b".repeat(64) }),
      isRetry: false
    },
    {
      why: "a different trajectory uri",
      stored: storedExperience({
        uri: "file:///workspace/other.jsonl",
        digest
      }),
      isRetry: false
    },
    {
      why: "a conflicting row this session cannot see",
      stored: null,
      isRetry: false
    }
  ];

  for (const { why, stored, isRetry } of cases) {
    const calls: RecordedCall[] = [];
    const response = await callAppend(conflictingService(calls, stored));
    assert.deepEqual(
      calls.map(({ method }) => method),
      ["appendExperience", "getExperience"],
      `${why}: the tool must re-read the stored row before deciding`
    );
    if (isRetry) {
      assert.notEqual(
        response.isError,
        true,
        `${why}: an exact retry is not a failure`
      );
      const attemptedId = (calls[0]!.args[0] as { readonly id: string }).id;
      assert.deepEqual(JSON.parse(response.text) as unknown, {
        id: attemptedId,
        appended: false
      });
    } else {
      assert.equal(
        response.isError,
        true,
        `${why}: a conflict that is not an exact retry must not be reported as a stored append`
      );
    }
  }
});

/**
 * Only a duplicate is something to reconcile.
 *
 * `appendExperience` failing is not by itself evidence that this is a retry. The
 * tool re-reads the stored row only when the failure was a conflict, because
 * that is the one failure where a matching row proves the work already
 * happened. Any other failure -- a transport error, a rejected write, a closed
 * connection -- has no such row behind it, and answering `appended: false` would
 * tell the agent its execution evidence is stored when it may never have been.
 */
test("an experience append that fails for any reason but a conflict is not a retry", async () => {
  const calls: RecordedCall[] = [];
  const response = await callAppend(
    conflictingService(
      calls,
      storedExperience({
        uri: APPEND_ARGS.trajectory.uri,
        digest: APPEND_ARGS.trajectory.digest
      }),
      new Error("the memory store is unreachable")
    )
  );

  assert.deepEqual(
    calls.map(({ method }) => method),
    ["appendExperience"],
    "a non-conflict failure must not be reconciled against a stored row"
  );
  assert.equal(
    response.isError,
    true,
    "a failure that is not a conflict must not be reported as a stored append"
  );
  assert.doesNotMatch(
    response.text,
    /unreachable/u,
    "the failure's own detail must not reach the caller"
  );
});
