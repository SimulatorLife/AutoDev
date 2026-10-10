import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { parse } from "smol-toml";

const repositoryRoot = new URL("../", import.meta.url);

function readToml(relativePath: string): Record<string, unknown> {
  const text = readFileSync(new URL(relativePath, repositoryRoot), "utf8");
  return parse(text) as Record<string, unknown>;
}

function readText(relativePath: string): string {
  return readFileSync(new URL(relativePath, repositoryRoot), "utf8");
}

function mcpServers(role: Record<string, unknown>): Record<string, unknown> {
  const servers = role.mcp_servers;
  assert.ok(
    servers && typeof servers === "object" && !Array.isArray(servers),
    "role must declare [mcp_servers.*] tables"
  );
  return servers as Record<string, unknown>;
}

function serverEnabled(
  servers: Record<string, unknown>,
  name: string
): boolean {
  const server = servers[name];
  if (!server || typeof server !== "object") return false;
  return (server as Record<string, unknown>).enabled === true;
}

function enabledTools(
  servers: Record<string, unknown>,
  name: string
): string[] {
  const server = servers[name];
  assert.ok(
    server && typeof server === "object",
    `expected [mcp_servers.${name}] to be declared`
  );
  const tools = (server as Record<string, unknown>).enabled_tools;
  assert.ok(
    Array.isArray(tools),
    `[mcp_servers.${name}].enabled_tools must be an array`
  );
  return tools as string[];
}

function skillEnabled(
  role: Record<string, unknown>,
  skillName: string
): boolean | undefined {
  const skills = role.skills as
    { config?: Array<Record<string, unknown>> } | undefined;
  const entry = skills?.config?.find((cfg) => cfg.name === skillName);
  return entry?.enabled as boolean | undefined;
}

// Source-code-write-capable or delegation-capable MCP servers that neither
// new role may ever enable; both roles are source-read-only and leaf-only.
const FORBIDDEN_SERVERS = [
  "lsp",
  "cocoindex-code",
  "codegraphcontext",
  "playwright",
  "context7",
  "autodev_spawn",
  "codex_app"
];

test("playtester.toml is sandboxed read-only, leaf-only, and run/read-scoped", () => {
  const role = readToml("agents/roles/playtester.toml");
  assert.equal(role.name, "playtester");
  assert.equal(role.sandbox_mode, "read-only");
  assert.equal(typeof role.model, "string");
  assert.match(role.model as string, /^autodev\//);

  const servers = mcpServers(role);
  for (const name of FORBIDDEN_SERVERS) {
    assert.equal(
      serverEnabled(servers, name),
      false,
      `playtester must not enable [mcp_servers.${name}]`
    );
  }

  assert.equal(serverEnabled(servers, "playtest"), true);
  const tools = enabledTools(servers, "playtest");
  assert.deepEqual(
    [...tools].sort(),
    [
      "playtest.activeRuns",
      "playtest.cancel",
      "playtest.capabilities",
      "playtest.listEpisodes",
      "playtest.readEpisode",
      "playtest.readWindow",
      "playtest.run",
      "playtest.wait"
    ].sort()
  );
  // Run-only/result-read authority: never evidence-review, compare, or
  // findings/issue-write commands reserved for playtest-analyst/root.
  for (const forbidden of [
    "playtest.metrics",
    "playtest.compare",
    "playtest.submitReview",
    "playtest.branch",
    "playtest.findings"
  ]) {
    assert.equal(tools.includes(forbidden), false, forbidden);
  }

  assert.equal(skillEnabled(role, "orchestration"), false);
  assert.equal(skillEnabled(role, "game-playtesting"), true);
});

test("playtest-analyst.toml reuses autodev/smart but overrides to read-only, evidence-scoped access", () => {
  const role = readToml("agents/roles/playtest-analyst.toml");
  assert.equal(role.name, "playtest-analyst");
  assert.equal(role.sandbox_mode, "read-only");
  // Reuses the existing reasoning-capable smart model route verbatim; this
  // role never gets its own fixed model tier.
  assert.equal(role.model, "autodev/smart");

  const servers = mcpServers(role);
  for (const name of FORBIDDEN_SERVERS) {
    assert.equal(
      serverEnabled(servers, name),
      false,
      `playtest-analyst must not enable [mcp_servers.${name}]`
    );
  }
  const tools = role.tools as Record<string, unknown> | undefined;
  assert.equal(tools?.web_search, false);

  assert.equal(serverEnabled(servers, "playtest"), true);
  const playtestTools = enabledTools(servers, "playtest");
  assert.deepEqual(
    [...playtestTools].sort(),
    [
      "playtest.compare",
      "playtest.listEpisodes",
      "playtest.metrics",
      "playtest.readEpisode",
      "playtest.readWindow",
      "playtest.submitReview"
    ].sort()
  );
  // Evidence/review authority only: never run/branch gameplay or write
  // findings/issues directly.
  for (const forbidden of [
    "playtest.run",
    "playtest.branch",
    "playtest.capabilities",
    "playtest.findings"
  ]) {
    assert.equal(playtestTools.includes(forbidden), false, forbidden);
  }

  assert.equal(skillEnabled(role, "orchestration"), false);
  assert.equal(skillEnabled(role, "playtest-analysis"), true);
});

test("playtester prompt forbids code/issue writes and self-critique", () => {
  const prompt = readText("agents/prompts/roles/playtester.md");
  assert.match(prompt, /playtest\.run/);
  assert.match(prompt, /do not .*edit|source-code read-only/i);
  assert.match(prompt, /GitHub issues?/i);
  assert.match(prompt, /Do not critique your own gameplay/i);
});

test("playtest-analyst prompt forbids run/branch authority and direct issue creation", () => {
  const prompt = readText("agents/prompts/roles/playtest-analyst.md");
  assert.match(prompt, /playtest\.submitReview/);
  assert.match(prompt, /never run, branch, or extend gameplay/i);
  assert.match(prompt, /Do not create, comment on, or close a GitHub issue/i);
  assert.match(prompt, /read-only for source code/i);
});
