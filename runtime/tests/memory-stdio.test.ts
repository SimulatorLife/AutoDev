import assert from "node:assert/strict";
import test from "node:test";

import {
  memoryMcpSessionProvider,
  memoryStdioConfiguration
} from "../src/memory/mcp-main.ts";

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
