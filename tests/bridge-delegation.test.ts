import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  bridgeDelegationInstruction,
  openSpawnSession,
  SpawnSessionRegistry,
  spawnShimMcpServer
} from "@simulatorlife/autodev-runtime/agents";
import {
  AUTODEV_SPAWN_BARE_TOOL,
  MCP_SERVER_AUTODEV_SPAWN
} from "@simulatorlife/autodev-runtime/shared/tool-names";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const read = (path: string): string =>
  readFileSync(new URL(path, `file://${REPO_ROOT}`), "utf8");

const DISPATCHER = { kind: "dispatcher", dispatcher: "call_mcp_tool" } as const;
const DIRECT = { kind: "direct", prefix: "mcp__" } as const;

test("a bridge tells its model the delegation call its own surface can serve", () => {
  // Antigravity reaches every MCP server through one built-in, so the call
  // names the server and the tool and carries the arguments as one object.
  const instruction = bridgeDelegationInstruction({
    mayDelegate: true,
    reach: DISPATCHER
  });
  assert.match(instruction, /## Delegation on this provider/);
  assert.match(instruction, /call_mcp_tool/);
  assert.match(instruction, new RegExp(`\`${MCP_SERVER_AUTODEV_SPAWN}\``));
  assert.match(instruction, new RegExp(`\`${AUTODEV_SPAWN_BARE_TOOL}\``));
  assert.match(instruction, /"ServerName": "autodev_spawn"/);
  assert.match(instruction, /"ToolName": "spawn_subagent"/);
  assert.match(instruction, /"agent_type": "<role>"/);
  assert.match(instruction, /"message": "<full task>"/);
  // The call must be one the model can make: a dispatcher call names both
  // halves, so a model that only reads the tool name still gets the server.
  assert.doesNotMatch(instruction, /mcp__autodev_spawn__spawn_subagent/);
  // The instruction designates this surface; it does not deny that Codex's
  // own functions are reachable somewhere else, because on Antigravity they
  // are -- inside the exec cell's `tools` global.
  assert.doesNotMatch(instruction, /are not tools you can call here/);
});

test("a bridge whose CLI advertises MCP tools directly names one tool", () => {
  const instruction = bridgeDelegationInstruction({
    mayDelegate: true,
    reach: DIRECT
  });
  assert.match(instruction, /mcp__autodev_spawn__spawn_subagent/);
  assert.doesNotMatch(instruction, /"ServerName"/);
  assert.match(instruction, /"children"/);
});

test("a turn that may not delegate is told nothing about delegating", () => {
  // Publishing the call for a turn with no spawn server would have the model
  // report a delegation failure that is not one.
  assert.equal(
    bridgeDelegationInstruction({ mayDelegate: false, reach: DISPATCHER }),
    ""
  );
  assert.equal(
    bridgeDelegationInstruction({ mayDelegate: false, reach: DIRECT }),
    ""
  );
});

test("both CLI bridges publish the delegation call in their own surface", () => {
  // The shared prompt cannot state the call: each CLI names an MCP tool
  // differently, and only the bridge that owns the surface knows which.
  const antigravity = read("runtime/src/providers/antigravity.ts");
  assert.match(antigravity, /bridgeDelegationInstruction\(/);
  assert.match(
    antigravity,
    /reach: \{ kind: "dispatcher", dispatcher: "call_mcp_tool" \}/
  );
  const copilot = read("runtime/src/providers/copilot.ts");
  assert.match(copilot, /bridgeDelegationInstruction\(/);
  assert.match(copilot, /reach: \{ kind: "direct", prefix: "mcp__" \}/);
});

test("the shared prompt no longer names the shim in a shape no CLI has", () => {
  // `tools.mcp__autodev_spawn__spawn_subagent` is how a model that reaches MCP
  // tools through Codex's `tools` global sees it. agy has no `tools` global,
  // and its MCP tools are reached through a dispatcher, so the prompt must
  // not tell a bridged model to look for that name.
  const prompt = read("agents/prompts/orchestrator.md");
  assert.doesNotMatch(prompt, /the model sees\s*`tools\.mcp__autodev_spawn/);
  assert.match(prompt, /"Delegation on this provider"/);
  // The catalog path moved; the prompt still pointed at the old one.
  assert.doesNotMatch(prompt, /scripts\/codex\/catalogs/);
  assert.match(prompt, /config\/catalogs\//);
});

test("the spawn shim is launched the one way, by the one owner", () => {
  // Three bridges write the entry, and each CLI renders it in its own schema.
  // What the shim *is* -- the path, the bridge it calls back, the turn its
  // calls belong to -- has one owner, or the three drift apart.
  const server = spawnShimMcpServer(
    { url: "http://127.0.0.1:4000", token: "bridge-token" },
    "session-a"
  );
  assert.match(server.args[0] ?? "", /mcp\/spawn-shim\.ts$/);
  assert.equal(server.env.AUTODEV_BRIDGE_URL, "http://127.0.0.1:4000");
  assert.equal(server.env.AUTODEV_BRIDGE_TOKEN, "bridge-token");
  assert.equal(server.env.AUTODEV_SPAWN_SESSION, "session-a");
  for (const sourcePath of [
    "runtime/src/providers/antigravity.ts",
    "runtime/src/providers/copilot.ts",
    "runtime/src/providers/claude.ts"
  ]) {
    const source = read(sourcePath);
    assert.match(source, /spawnShimMcpServer\(/, sourcePath);
    // No bridge may name the shim's path itself.
    assert.doesNotMatch(source, /mcp\/spawn-shim\.ts/, sourcePath);
  }
});

test("a turn holds delegation state only when the router identified its conversation", () => {
  const registry = new SpawnSessionRegistry();
  // The router's process-wide fallback names no single conversation, so a
  // turn holding it would attach one conversation's delegation to another's.
  assert.equal(
    openSpawnSession(
      {
        "x-autodev-session-id": "session-a",
        "x-autodev-session-scope": "process-fallback"
      },
      registry,
      { orchestrator: true }
    ),
    null
  );
  assert.equal(
    openSpawnSession(
      {
        "x-autodev-session-id": "session-a",
        "x-autodev-session-scope": "identified"
      },
      registry,
      { orchestrator: true }
    ),
    "session-a"
  );
  assert.equal(registry.mayDelegate("session-a"), true);
  // A leaf turn may not delegate, so its session is held but closed to it.
  const leaves = new SpawnSessionRegistry();
  openSpawnSession(
    {
      "x-autodev-session-id": "session-b",
      "x-autodev-session-scope": "identified"
    },
    leaves,
    { orchestrator: false }
  );
  assert.equal(leaves.mayDelegate("session-b"), false);
});
