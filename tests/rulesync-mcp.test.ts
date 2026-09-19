import assert from "node:assert/strict";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { parse } from "smol-toml";

type JsonObject = Record<string, unknown>;
type McpServer = JsonObject;
type RunResult = SpawnSyncReturns<string>;

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const sourceRoot = join(repositoryRoot, ".rulesync");
const mcpSource = join(sourceRoot, "mcp.jsonc");
const portableConfig = join(repositoryRoot, "config/config.autodev.toml");
const packageJson = join(repositoryRoot, "package.json");
const rulesync = join(repositoryRoot, "node_modules/.bin/rulesync");
const launchCommand =
  'exec "${CODEX_HOME:-$HOME/.codex}/hooks/run-autodev-mcp.sh" ';
const userLevelFiles: Record<string, string> = {
  claudecode: ".claude.json",
  copilotcli: ".copilot/mcp-config.json",
  "antigravity-cli": ".gemini/config/mcp_config.json"
};
const urlKeys: Record<string, string> = { "antigravity-cli": "serverUrl" };
const forbiddenServers = new Set(["node_repl", "cua_repl"]);

function readJson(path: string): JsonObject {
  return JSON.parse(readFileSync(path, "utf8")) as JsonObject;
}
function source(): JsonObject {
  return readJson(mcpSource);
}
function serverMap(value: unknown): Record<string, McpServer> {
  assert.ok(value && typeof value === "object" && !Array.isArray(value));
  return value as Record<string, McpServer>;
}
function declared(target: string): Record<string, McpServer> {
  const document = source();
  const servers = { ...serverMap(document.mcpServers) };
  const targetSection = document[target];
  const targetConfig =
    targetSection &&
    typeof targetSection === "object" &&
    !Array.isArray(targetSection)
      ? serverMap((targetSection as JsonObject).mcpServers ?? {})
      : {};
  for (const [name, override] of Object.entries(targetConfig)) {
    if (override === null) delete servers[name];
    else servers[name] = override;
  }
  return servers;
}
function runRulesync(args: readonly string[], home?: string): RunResult {
  return spawnSync(
    rulesync,
    [
      "generate",
      "--input-roots",
      sourceRoot,
      "--features",
      "mcp",
      ...args,
      "--silent"
    ],
    {
      cwd: repositoryRoot,
      encoding: "utf8",
      timeout: 60_000,
      env: home === undefined ? process.env : { ...process.env, HOME: home }
    }
  );
}
function generateUserLevel(home: string, ...extra: string[]): RunResult {
  return runRulesync(
    ["--global", "--targets", Object.keys(userLevelFiles).join(","), ...extra],
    home
  );
}
function readMcpFile(path: string): Record<string, McpServer> {
  return serverMap(readJson(path).mcpServers);
}

const temporaryRoot = mkdtempSync(join(tmpdir(), "autodev-rulesync-mcp-"));
const codexRoot = join(temporaryRoot, "codex");
const home = join(temporaryRoot, "home");
mkdirSync(home, { recursive: true });
writeFileSync(
  join(home, ".claude.json"),
  JSON.stringify({
    numStartups: 3,
    mcpServers: { stale: { command: "stale" } }
  })
);
const portableBefore = readFileSync(portableConfig);
for (const result of [
  runRulesync(["--targets", "codexcli", "--output-roots", codexRoot]),
  generateUserLevel(home)
]) {
  assert.equal(
    result.status,
    0,
    `Rulesync MCP generation failed:\n${result.stdout}\n${result.stderr}`
  );
}

test.after(() => rmSync(temporaryRoot, { recursive: true, force: true }));

test("Rulesync is pinned to an exact version", () => {
  const dependencies = serverMap(readJson(packageJson).devDependencies);
  assert.match(String(dependencies.rulesync), /^\d+\.\d+\.\d+$/);
});

test("portable Codex config declares no MCP servers", () => {
  const config = parse(readFileSync(portableConfig, "utf8")) as Record<
    string,
    unknown
  >;
  assert.equal(Object.hasOwn(config, "mcp_servers"), false);
});

test("source declares each launch definition consistently", () => {
  const document = source();
  const shared = serverMap(document.mcpServers);
  assert.deepEqual(
    Object.keys(document).sort(),
    [
      "$schema",
      "antigravity-cli",
      "codexcli",
      "copilotcli",
      "mcpServers"
    ].sort()
  );
  assert.deepEqual(Object.keys(shared).sort(), [
    "cocoindex-code",
    "lsp",
    "openaiDeveloperDocs"
  ]);
  for (const target of [
    "codexcli",
    "claudecode",
    "copilotcli",
    "antigravity-cli"
  ]) {
    const targetServers = declared(target);
    assert.deepEqual(
      [...forbiddenServers].filter((name) =>
        Object.hasOwn(targetServers, name)
      ),
      []
    );
    assert.equal(
      Object.hasOwn(targetServers, "autodev_spawn"),
      target === "antigravity-cli"
    );
    for (const [name, server] of Object.entries(targetServers)) {
      if (name === "autodev_spawn") {
        assert.equal(server.command, "bash");
        assert.ok(Array.isArray(server.args));
        assert.equal(
          String(server.args[1]).endsWith('/src/mcp/spawn-shim.ts"'),
          true
        );
      } else if (Object.hasOwn(server, "command")) {
        assert.equal(server.command, "bash");
        assert.deepEqual(server.args, ["-lc", `${launchCommand}${name}`]);
      }
      if (Object.hasOwn(shared, name)) {
        for (const key of ["command", "args", "url"])
          assert.deepEqual(server[key], shared[name]?.[key]);
      }
    }
  }
});

test("Codex projection matches the Codex declaration without mutating the portable source", () => {
  const files: string[] = [];
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile()) files.push(relative(codexRoot, path));
    }
  };
  walk(codexRoot);
  assert.deepEqual(files, [".codex/config.toml"]);
  const generated = serverMap(
    (
      parse(
        readFileSync(join(codexRoot, ".codex/config.toml"), "utf8")
      ) as Record<string, unknown>
    ).mcp_servers
  );
  const expected = declared("codexcli");
  assert.deepEqual(Object.keys(generated).sort(), Object.keys(expected).sort());
  for (const [name, server] of Object.entries(expected)) {
    const projected: JsonObject = {};
    for (const key of ["command", "args", "url", "default_tools_approval_mode"])
      if (Object.hasOwn(server, key)) projected[key] = server[key];
    if (server.disabled) projected.enabled = false;
    assert.deepEqual(generated[name], projected);
  }
  assert.deepEqual(readFileSync(portableConfig), portableBefore);
});

test("user-level files list exactly each target declaration and preserve non-MCP keys", () => {
  for (const [target, relativePath] of Object.entries(userLevelFiles)) {
    const servers = readMcpFile(join(home, relativePath));
    const expected = declared(target);
    assert.deepEqual(
      Object.keys(servers).sort(),
      Object.keys(expected).sort(),
      target
    );
    const urlKey = urlKeys[target] ?? "url";
    for (const [name, server] of Object.entries(expected)) {
      const projected = servers[name];
      assert.ok(projected, `${target}/${name} missing`);
      assert.deepEqual(projected.command, server.command);
      assert.deepEqual(projected.args, server.args);
      assert.deepEqual(projected[urlKey], server.url);
      assert.equal(
        Object.hasOwn(projected, "default_tools_approval_mode"),
        false
      );
    }
  }
  const claude = readJson(join(home, ".claude.json"));
  assert.equal(claude.numStartups, 3);
  assert.equal(Object.hasOwn(serverMap(claude.mcpServers), "stale"), false);
});

test("Rulesync check catches edited and extra user-level servers", () => {
  assert.equal(generateUserLevel(home, "--check").status, 0);
  const editAntigravity = (targetHome: string): void => {
    const path = join(targetHome, userLevelFiles["antigravity-cli"]!);
    const document = readJson(path);
    const servers = serverMap(document.mcpServers);
    servers.lsp = { ...servers.lsp, args: ["-lc", "drifted"] };
    writeFileSync(path, JSON.stringify(document));
  };
  const addCopilotServer = (targetHome: string): void => {
    const path = join(targetHome, userLevelFiles.copilotcli!);
    const document = readJson(path);
    const servers = serverMap(document.mcpServers);
    servers.mine = { type: "stdio", command: "mine" };
    writeFileSync(path, JSON.stringify(document));
  };
  for (const [label, damage] of [
    ["edited", editAntigravity],
    ["extra", addCopilotServer]
  ] as const) {
    const targetHome = join(temporaryRoot, label);
    mkdirSync(targetHome);
    assert.equal(generateUserLevel(targetHome).status, 0);
    damage(targetHome);
    assert.notEqual(generateUserLevel(targetHome, "--check").status, 0, label);
  }
});
