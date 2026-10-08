import assert from "node:assert/strict";
import test from "node:test";

import {
  memoryMcpSessionProvider,
  memoryStdioConfiguration,
  startMemoryMcpFromEnvironment,
  type MemoryMcpRuntime
} from "../src/memory/mcp-main.ts";
import type {
  PostgresMemoryHost,
  PostgresMemoryHostOptions
} from "../src/memory/postgres.ts";

const ENV = {
  AUTODEV_MEMORY_DATABASE_URL: "postgresql://localhost/memory",
  AUTODEV_MEMORY_WORKSPACE_ID: "workspace-a",
  AUTODEV_MEMORY_REPOSITORY_ID: "owner/repo",
  AUTODEV_MEMORY_REPOSITORY_ROOT: "/workspace/repo"
};

interface Harness {
  readonly runtime: MemoryMcpRuntime;
  readonly hostOptions: () => PostgresMemoryHostOptions | undefined;
  readonly hostClosed: () => number;
  readonly shutdowns: () => number;
  readonly fireShutdown: () => Promise<void>;
}

/**
 * Doubles for the two process-owned dependencies, recording what startup did
 * with them. `createService` is a no-op here: startup hands the service
 * straight to `serve`, and the one test that cares about the repository-root
 * resolver supplies its own host through `createHost`.
 */
function lifecycleHarness(
  serve: MemoryMcpRuntime["serve"],
  createHost?: (options: PostgresMemoryHostOptions) => PostgresMemoryHost
): Harness {
  let options: PostgresMemoryHostOptions | undefined;
  let hostCloses = 0;
  const handlers: (() => void)[] = [];
  const host: PostgresMemoryHost = {
    createService: (() => ({}) as never) as PostgresMemoryHost["createService"],
    probe: async () => "reachable",
    close: async () => {
      hostCloses += 1;
    }
  };
  return {
    runtime: {
      env: ENV,
      pid: 99,
      createHost: (received) => {
        options = received;
        return createHost ? createHost(received) : host;
      },
      serve,
      onShutdown: (handler) => handlers.push(handler)
    },
    hostOptions: () => options,
    hostClosed: () => hostCloses,
    shutdowns: () => handlers.length,
    fireShutdown: async () => {
      for (const handler of handlers) handler();
      // The handler fires-and-forgets its promise; let the chain settle before
      // asserting on it.
      await new Promise((resolve) => setImmediate(resolve));
    }
  };
}

test("a memory MCP host that fails to serve is closed, and the failure propagates", async () => {
  const harness = lifecycleHarness(async () => {
    throw new Error("transport unavailable");
  });

  await assert.rejects(
    startMemoryMcpFromEnvironment(undefined, harness.runtime),
    /transport unavailable/
  );
  // Without this close the process exits with an open Postgres pool, which
  // shows up as a hang rather than a crash -- the worst place to learn it.
  assert.equal(harness.hostClosed(), 1);
  assert.equal(harness.shutdowns(), 0);
});

test("memory MCP shutdown closes the server then the host, exactly once", async () => {
  let serverCloses = 0;
  const harness = lifecycleHarness(async () => ({
    close: async () => {
      serverCloses += 1;
    }
  }));

  await startMemoryMcpFromEnvironment(undefined, harness.runtime);
  assert.equal(harness.shutdowns(), 1);
  assert.equal(serverCloses, 0);

  // SIGINT and SIGTERM can both arrive, and stdin "end" fires after either.
  await harness.fireShutdown();
  await harness.fireShutdown();

  assert.equal(serverCloses, 1);
  assert.equal(harness.hostClosed(), 1);
});

test("a memory MCP server that fails to close still closes the host", async () => {
  const harness = lifecycleHarness(async () => ({
    close: async () => {
      throw new Error("transport already gone");
    }
  }));

  await startMemoryMcpFromEnvironment(undefined, harness.runtime);
  // The handler discards its promise, so a rejection here would surface as an
  // unhandled rejection that kills the process mid-shutdown.
  await harness.fireShutdown();

  assert.equal(harness.hostClosed(), 1);
});

test("memory MCP resolves a repository root only for its own workspace and repository", async () => {
  // The root is handed to the service as a repository *resolver*, so the rule
  // under test is a function of the caller's context: any other workspace or
  // repository must get null, or a tool call could be anchored to a checkout
  // that is not the caller's.
  let resolveRoot: ((context: never) => string | null) | undefined;
  const harness = lifecycleHarness(
    async () => ({ close: async () => {} }),
    () => ({
      createService: ((repositories: {
        resolve: (context: never) => string | null;
      }) => {
        resolveRoot = (context: never) => repositories.resolve(context);
        return {} as never;
      }) as PostgresMemoryHost["createService"],
      probe: async () => "reachable",
      close: async () => {}
    })
  );

  await startMemoryMcpFromEnvironment(undefined, harness.runtime);

  assert.equal(
    harness.hostOptions()?.databaseUrl,
    ENV.AUTODEV_MEMORY_DATABASE_URL
  );
  assert.equal(typeof resolveRoot, "function");
  assert.equal(
    resolveRoot!({
      workspaceId: "workspace-a",
      repositoryId: "owner/repo"
    } as never),
    "/workspace/repo"
  );
  for (const context of [
    { workspaceId: "workspace-other", repositoryId: "owner/repo" },
    { workspaceId: "workspace-a", repositoryId: "owner/other" }
  ]) {
    assert.equal(resolveRoot!(context as never), null, JSON.stringify(context));
  }
});

test("stdio MCP context is host-bound, worker-only by default, and not model-controlled", async () => {
  const configuration = memoryStdioConfiguration(
    {
      AUTODEV_MEMORY_DATABASE_URL: "postgresql://localhost/memory",
      AUTODEV_MEMORY_WORKSPACE_ID: "workspace-a",
      AUTODEV_MEMORY_REPOSITORY_ID: "owner/repo",
      AUTODEV_MEMORY_REPOSITORY_ROOT: "/workspace/repo",
      AUTODEV_MEMORY_ROLE: "worker"
    },
    42
  );
  const provider = memoryMcpSessionProvider(configuration);
  const session = await provider.current("Search current memory evidence.");

  assert.equal(session.actor.authority, "worker");
  assert.equal(session.actor.id, "memory-mcp-42");
  assert.equal(session.context.workspaceId, "workspace-a");
  assert.equal(session.context.repositoryId, "owner/repo");
  assert.equal(session.context.canReadGlobal, false);
  assert.equal(session.context.canReadTaskHistory, false);
  assert.equal(session.task, "Search current memory evidence.");
  assert.equal(session.memoryMode, "unknown");
});

test("global access requires an operator-bound root/curator configuration", () => {
  const worker = memoryStdioConfiguration(
    {
      AUTODEV_MEMORY_DATABASE_URL: "postgresql://localhost/memory",
      AUTODEV_MEMORY_WORKSPACE_ID: "workspace-a",
      AUTODEV_MEMORY_REPOSITORY_ID: "owner/repo",
      AUTODEV_MEMORY_AUTHORITY: "worker",
      AUTODEV_MEMORY_READ_GLOBAL: "1"
    },
    1
  );
  const curator = memoryStdioConfiguration(
    {
      AUTODEV_MEMORY_DATABASE_URL: "postgresql://localhost/memory",
      AUTODEV_MEMORY_WORKSPACE_ID: "workspace-a",
      AUTODEV_MEMORY_REPOSITORY_ID: "owner/repo",
      AUTODEV_MEMORY_AUTHORITY: "curator",
      AUTODEV_MEMORY_READ_GLOBAL: "1",
      AUTODEV_MEMORY_READ_TASK_HISTORY: "1"
    },
    2
  );
  assert.equal(worker.canReadGlobal, false);
  assert.equal(curator.canReadGlobal, true);
  assert.equal(curator.canReadTaskHistory, true);
});

test("MCP startup requires database and scope, and only accepts absolute repository roots", () => {
  assert.throws(() => memoryStdioConfiguration({}, 7), /database URL/);
  const configuration = memoryStdioConfiguration(
    {
      AUTODEV_MEMORY_DATABASE_URL: "postgresql://localhost/memory",
      AUTODEV_MEMORY_WORKSPACE_ID: "workspace-a",
      AUTODEV_MEMORY_REPOSITORY_ID: "owner/repo",
      AUTODEV_MEMORY_REPOSITORY_ROOT: "relative/repo"
    },
    7
  );
  assert.equal(configuration.repositoryRoot, null);
});
