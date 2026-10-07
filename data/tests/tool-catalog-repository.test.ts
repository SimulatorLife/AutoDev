import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import type { RuleSyncMcpState } from "@simulatorlife/autodev-core";
import { ToolCatalogAdapter } from "@simulatorlife/autodev-data";

const MCP_FIXTURE = `{
  "mcpServers": {
    "lsp": {
      "command": "node",
      "args": ["lsp.js"]
    },
    "codex_app": {
      "command": "codex-app-mcp",
      "args": ["server.mjs"]
    }
  },
  "codexcli": {
    "mcpServers": {
      "lsp": {
        "command": "node",
        "args": ["lsp.js"],
        "enabled_tools": ["lsp_goto_definition", "lsp_hover"]
      },
      "codex_app": {
        "command": "codex-app-mcp",
        "args": ["server.mjs"],
        "disabled": true,
        "enabled_tools": ["request_user_input"]
      }
    }
  }
}`;

async function withFixture(
  body: (repositoryRoot: string) => Promise<void>
): Promise<void> {
  const repositoryRoot = await mkdtemp(
    path.join(tmpdir(), "autodev-tool-catalog-")
  );
  try {
    await mkdir(path.join(repositoryRoot, ".rulesync"), { recursive: true });
    await writeFile(
      path.join(repositoryRoot, ".rulesync", "mcp.jsonc"),
      MCP_FIXTURE,
      "utf8"
    );
    await body(repositoryRoot);
  } finally {
    await rm(repositoryRoot, { recursive: true, force: true });
  }
}

test("ToolCatalogAdapter reports unknown when the RuleSync MCP source is absent", async () => {
  const repositoryRoot = await mkdtemp(
    path.join(tmpdir(), "autodev-tool-catalog-empty-")
  );
  try {
    const adapter = new ToolCatalogAdapter({ repositoryRoot });
    const result = adapter.load();
    assert.equal(result.coverage, "unknown");
    assert.equal(result.validity, "not-observed");
    assert.equal(result.source, ".rulesync/mcp.jsonc");
    assert.equal(result.tools.length, 0);
  } finally {
    await rm(repositoryRoot, { recursive: true, force: true });
  }
});

test("ToolCatalogAdapter reports invalid when the RuleSync MCP source cannot be parsed", async () => {
  const repositoryRoot = await mkdtemp(
    path.join(tmpdir(), "autodev-tool-catalog-invalid-")
  );
  try {
    await mkdir(path.join(repositoryRoot, ".rulesync"), { recursive: true });
    await writeFile(
      path.join(repositoryRoot, ".rulesync", "mcp.jsonc"),
      "{",
      "utf8"
    );
    const adapter = new ToolCatalogAdapter({ repositoryRoot });
    const result = adapter.load();
    assert.equal(result.coverage, "unavailable");
    assert.equal(result.validity, "invalid");
    assert.equal(result.tools.length, 0);
  } finally {
    await rm(repositoryRoot, { recursive: true, force: true });
  }
});

test("ToolCatalogAdapter joins declared MCP/plugin tools with execution-contract role exposure", async () => {
  await withFixture(async (repositoryRoot) => {
    const adapter = new ToolCatalogAdapter({ repositoryRoot });
    const result = adapter.fromMcpState(
      new (await import("@simulatorlife/autodev-data")).RuleSyncRepository(
        repositoryRoot
      ).loadMcpState(),
      {
        orchestrator: {
          mcp: ["lsp", "codex_app"],
          mcpTools: {
            lsp: ["lsp_goto_definition", "lsp_hover"],
            codex_app: ["request_user_input"]
          }
        },
        explorer: {
          mcp: ["lsp"],
          mcpTools: { lsp: ["lsp_goto_definition"] }
        },
        "docs-researcher": {
          mcp: [],
          webResearch: { search: true, fetch: true }
        }
      }
    );
    assert.equal(result.coverage, "complete");
    assert.equal(result.validity, "valid");

    const goto = result.tools.find(
      (t) => t.server === "lsp" && t.name === "lsp_goto_definition"
    );
    assert.ok(goto);
    assert.equal(goto?.source, "mcp");
    assert.equal(goto?.sourceAuthority, "execution-contract");
    assert.equal(goto?.availability, "configured");
    assert.deepEqual([...(goto?.exposedRoles ?? [])].sort(), [
      "explorer",
      "orchestrator"
    ]);

    const requestUserInput = result.tools.find(
      (t) => t.server === "codex_app" && t.name === "request_user_input"
    );
    assert.ok(requestUserInput);
    assert.equal(requestUserInput?.source, "plugin");
    assert.equal(requestUserInput?.sourceAuthority, "rulesync-plugin");
    assert.deepEqual(requestUserInput?.exposedRoles, ["orchestrator"]);

    const webSearch = result.tools.find(
      (t) => t.source === "native" && t.name === "web_search"
    );
    assert.ok(webSearch);
    assert.equal(webSearch?.sourceAuthority, "codex-native");
    assert.deepEqual(webSearch?.exposedRoles, ["docs-researcher"]);

    const webFetch = result.tools.find(
      (t) => t.source === "native" && t.name === "web_fetch"
    );
    assert.ok(webFetch);
    assert.equal(webFetch?.sourceAuthority, "codex-native");
  });
});

test("ToolCatalogAdapter preserves declared tools even when no role enumerates them", async () => {
  await withFixture(async (repositoryRoot) => {
    const adapter = new ToolCatalogAdapter({ repositoryRoot });
    const mcpState = new (
      await import("@simulatorlife/autodev-data")
    ).RuleSyncRepository(repositoryRoot).loadMcpState();
    const result = adapter.fromMcpState(mcpState, {});
    // No roles enumerated, but the rulesync declaration still has the
    // codex_app plugin tool. The catalog surfaces it without an exposed role.
    const requestUserInput = result.tools.find(
      (t) => t.server === "codex_app" && t.name === "request_user_input"
    );
    assert.ok(requestUserInput);
    assert.equal(requestUserInput?.exposedRoles.length, 0);
    assert.equal(requestUserInput?.availability, "configured");
  });
});

test("ToolCatalogAdapter handles the not-observed validity without dropping the available data", () => {
  const adapter = new ToolCatalogAdapter();
  const mcpState: RuleSyncMcpState = {
    source: ".rulesync/mcp.jsonc",
    valid: null,
    // An unobserved source has no faults to report and must not invent any.
    issues: [],
    servers: []
  };
  const result = adapter.fromMcpState(mcpState);
  assert.equal(result.coverage, "unknown");
  assert.equal(result.validity, "not-observed");
  assert.equal(result.source, ".rulesync/mcp.jsonc");
  assert.deepEqual(result.tools, []);
});
