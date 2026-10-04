import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  applyMemoryMigrations,
  createPgMemoryPool
} from "@simulatorlife/autodev-data";

const databaseUrl = process.env.AUTODEV_MEMORY_MCP_TEST_DATABASE_URL;

test(
  "official stdio MCP launch binds an external client to the configured worker scope",
  { skip: !databaseUrl },
  async () => {
    const migrationPool = createPgMemoryPool({
      connectionString: databaseUrl!
    });
    await applyMemoryMigrations(migrationPool);
    await migrationPool.end();

    const serverPath = fileURLToPath(
      new URL("../src/router/memory-mcp-main.ts", import.meta.url)
    );
    const env: Record<string, string> = Object.fromEntries(
      Object.entries(process.env).filter(
        (entry): entry is [string, string] => typeof entry[1] === "string"
      )
    );
    delete env.AUTODEV_MEMORY_MODE;
    delete env.AUTODEV_MEMORY_ABLATION;
    Object.assign(env, {
      AUTODEV_MEMORY_DATABASE_URL: databaseUrl!,
      AUTODEV_MEMORY_WORKSPACE_ID: "mcp-integration-workspace",
      AUTODEV_MEMORY_REPOSITORY_ID: "mcp-integration-repository",
      AUTODEV_MEMORY_REPOSITORY_ROOT: process.cwd(),
      AUTODEV_MEMORY_ACTOR_ID: "mcp-integration-worker",
      AUTODEV_MEMORY_ROLE: "worker",
      AUTODEV_MEMORY_AUTHORITY: "worker"
    });

    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [serverPath],
      cwd: process.cwd(),
      env,
      stderr: "pipe"
    });
    const client = new Client(
      { name: "autodev-memory-stdio-integration", version: "1.0.0" },
      { capabilities: {} }
    );
    try {
      await client.connect(transport);
      const listed = await client.listTools();
      assert.ok(listed.tools.some((tool) => tool.name === "experience_append"));
      assert.ok(listed.tools.some((tool) => tool.name === "memory_research"));
      assert.ok(listed.tools.some((tool) => tool.name === "memory_propose"));

      const appended = await client.callTool({
        name: "experience_append",
        arguments: {
          trajectory: {
            format: "claude-code-native-jsonl",
            uri: "https://example.invalid/session/trajectory.jsonl?token=private",
            digest: "c".repeat(64),
            recordCount: 4
          },
          startedAt: "2026-10-01T12:00:00.000Z",
          completedAt: "2026-10-01T12:05:00.000Z",
          outcome: "unknown",
          evidence: [
            {
              kind: "pull_request",
              uri: "https://github.com/owner/repo/pull/17"
            }
          ]
        }
      });
      assert.equal(appended.isError, undefined);
      const appendedValue = JSON.parse(
        (appended.content as Array<{ text?: string }>)[0]?.text ?? "null"
      ) as { id: string; appended: boolean };
      assert.equal(appendedValue.appended, true);

      const retrieved = await client.callTool({
        name: "experience_get",
        arguments: { id: appendedValue.id }
      });
      assert.equal(retrieved.isError, undefined);
      const experience = JSON.parse(
        (retrieved.content as Array<{ text?: string }>)[0]?.text ?? "null"
      ) as {
        workspaceId: string;
        repositoryId?: string;
        taskId: string;
        runId: string;
        agentId: string;
        memoryMode: string;
        trajectory: { uri: string; digest?: string };
      };
      assert.equal(experience.workspaceId, "mcp-integration-workspace");
      assert.equal(experience.repositoryId, "mcp-integration-repository");
      assert.match(experience.taskId, /^mcp-task-\d+$/u);
      assert.match(experience.runId, /^mcp-run-\d+$/u);
      assert.equal(experience.agentId, "mcp-integration-worker");
      assert.equal(experience.memoryMode, "unknown");
      assert.equal(
        experience.trajectory.uri,
        "https://example.invalid/session/trajectory.jsonl"
      );
      assert.equal(experience.trajectory.digest, "c".repeat(64));

      const research = await client.callTool({
        name: "memory_research",
        arguments: { query: "inspect file ownership" }
      });
      assert.equal(research.isError, undefined);

      const denied = await client.callTool({
        name: "memory_propose",
        arguments: {
          kind: "semantic",
          scope: {
            kind: "workspace",
            workspaceId: "attacker-selected-workspace"
          },
          claim: "Attempt to write outside the configured workspace.",
          experienceIds: ["does-not-exist"],
          evidence: [
            { kind: "document", uri: "https://example.invalid/source" }
          ]
        }
      });
      assert.equal(denied.isError, true);
      const response = denied.content as Array<{ type: string; text?: string }>;
      assert.match(response[0]?.text ?? "", /not authorized/);
    } finally {
      await client.close();
    }
  }
);
