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
      get: (_target, property) => async (...args: unknown[]) => {
        calls.push({ method: String(property), args });
        return { accepted: true };
      }
    }
  ) as unknown as MemoryService;
}

async function connect(
  calls: RecordedCall[]
): Promise<{ client: Client; close: () => Promise<void> }> {
  const server = createMemoryMcpServer(recordingService(calls), {
    current: () => SESSION
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
  assert.equal(calls.length, 1, `expected one service call, saw ${calls.length}`);
  return calls[0]!;
}

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

    assert.deepEqual(
      calls.map((call) => call.method).sort(),
      ["propose", "research"]
    );
    // The actor is the host's, never an argument: a model that could name its
    // own authority would be able to write as anyone.
    const propose = calls.find((call) => call.method === "propose")!;
    assert.equal(
      (propose.args[1] as { id: string }).id,
      SESSION.actor.id
    );
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
  const expected: readonly [Record<string, unknown>, Record<string, unknown>][] = [
    [{ kind: "global" }, { kind: "global" }],
    [
      { kind: "workspace", workspaceId: "workspace-a" },
      { kind: "workspace", workspaceId: "workspace-a" }
    ],
    [
      { kind: "repository", workspaceId: "workspace-a", repositoryId: "owner/repo" },
      { kind: "repository", workspaceId: "workspace-a", repositoryId: "owner/repo" }
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
      assert.equal(response.isError, undefined, `${String(supplied.kind)} rejected`);
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