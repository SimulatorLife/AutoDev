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
      new URL("../src/memory/mcp-main.ts", import.meta.url)
    );
    const env = Object.fromEntries(
      Object.entries(process.env).filter(
        (entry): entry is [string, string] => typeof entry[1] === "string"
      )
    );
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
      assert.ok(listed.tools.some((tool) => tool.name === "memory_research"));
      assert.ok(listed.tools.some((tool) => tool.name === "memory_propose"));

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
