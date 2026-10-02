import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  computeAgentKey,
  computeVersionHash,
  loadRulesyncAgents,
  syncRulesyncAgents
} from "@simulatorlife/autodev-data/openlit";

const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));

test("computeAgentKey produces deterministic 16-character hex string matching OpenLIT key algorithm", () => {
  const key1 = computeAgentKey("default", "default", "orchestrator");
  const key2 = computeAgentKey("default", "default", "orchestrator");
  const keyExplorer = computeAgentKey("default", "default", "explorer");

  assert.equal(key1, "c55581be299bb245");
  assert.equal(
    key1,
    key2,
    "Same service name must produce identical agent_key"
  );
  assert.notEqual(
    key1,
    keyExplorer,
    "Different service names must produce distinct keys"
  );
  assert.equal(keyExplorer.length, 16);
});

test("computeVersionHash produces deterministic 16-character hex hash", () => {
  const hash1 = computeVersionHash(
    "You are a helpful agent.",
    [{ name: "find_code", type: "mcp", server: "codegraphcontext" }],
    { kind: "leaf", readOnly: true }
  );
  const hash2 = computeVersionHash(
    "You are a helpful agent.",
    [{ name: "find_code", type: "mcp", server: "codegraphcontext" }],
    { kind: "leaf", readOnly: true }
  );
  const hashModified = computeVersionHash(
    "You are an edited agent.",
    [{ name: "find_code", type: "mcp", server: "codegraphcontext" }],
    { kind: "leaf", readOnly: true }
  );

  assert.equal(hash1.length, 16);
  assert.equal(
    hash1,
    hash2,
    "Identical agent definitions must yield identical hash"
  );
  assert.notEqual(
    hash1,
    hashModified,
    "Modified definitions must yield different hash"
  );
});

test("loadRulesyncAgents extracts all roles from execution contract and role prompt files", () => {
  const catalog = loadRulesyncAgents(repositoryRoot);

  const expectedRoles = [
    "orchestrator",
    "explorer",
    "validator",
    "worker",
    "smart",
    "docs-researcher",
    "browser-tester",
    "default"
  ];

  for (const role of expectedRoles) {
    assert.ok(catalog.has(role), `Catalog must contain role "${role}"`);
    const agent = catalog.get(role)!;
    assert.equal(agent.role, role);
    assert.ok(
      agent.primaryModel.length > 0,
      `Agent "${role}" must have a primaryModel`
    );
    assert.ok(agent.models.length > 0, `Agent "${role}" must have models`);
    assert.ok(
      agent.providers.length > 0,
      `Agent "${role}" must have providers`
    );
    assert.ok(
      Array.isArray(agent.tools),
      `Agent "${role}" must have tools array`
    );
    assert.ok(
      agent.runtimeConfig !== null,
      `Agent "${role}" must have runtimeConfig`
    );

    const promptPath = join(
      repositoryRoot,
      "agents",
      "prompts",
      "roles",
      `${role}.md`
    );
    if (existsSync(promptPath)) {
      assert.ok(
        agent.systemPrompt.length > 0,
        `Agent "${role}" must have non-empty systemPrompt when file exists`
      );
    }
  }

  // Orchestrator has specific role characteristics
  const orchestrator = catalog.get("orchestrator")!;
  assert.equal(orchestrator.kind, "orchestrator");
  assert.equal(orchestrator.readOnly, false);
  assert.equal(orchestrator.primaryModel, "autodev/orchestrator");

  // Explorer is read-only leaf
  const explorer = catalog.get("explorer")!;
  assert.equal(explorer.readOnly, true);
  assert.equal(explorer.primaryModel, "autodev/subagent");
});

test("syncRulesyncAgents synchronizes agent roles idempotently against ClickHouse", async () => {
  try {
    const result1 = await syncRulesyncAgents({ repositoryRoot });
    assert.ok(
      result1.totalCatalogAgents >= 8,
      `Expected at least 8 agents, got ${result1.totalCatalogAgents}`
    );
    assert.equal(result1.removed.length, 0);

    // Second run must be completely unchanged (idempotent)
    const result2 = await syncRulesyncAgents({ repositoryRoot });
    assert.equal(result2.inserted.length, 0, "Second run should insert 0");
    assert.equal(result2.updated.length, 0, "Second run should update 0");
    assert.equal(
      result2.unchanged.length,
      result2.totalCatalogAgents,
      "All catalog agents must be unchanged on second run"
    );
  } catch (error) {
    if ((error as Error).message.includes("ECONNREFUSED")) {
      // ClickHouse container not running in this environment — skip gracefully
      return;
    }
    throw error;
  }
});
