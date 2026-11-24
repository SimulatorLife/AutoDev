import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import { chatgptSupergatewayEnvironment, renderChatgptSupergatewayConfig } from "../src/config/render-chatgpt-supergateway.ts";
import { probeSupergateway } from "../src/mcp/chatgpt-supergateway-probe.ts";
import { ensureSupergateway } from "../src/platform/supergateway-install.ts";
import { externalFilesystemBackend, filesystemSandboxProfile } from "../src/mcp/chatgpt-filesystem-sandbox.ts";
import { createTunnel, dependencyEnvironment, privateRead, privateWrite, ready, shellWord, tunnelClientSupported, tunnelMetadata, validateRuntimeKey } from "../src/platform/chatgpt-tunnel-install.ts";

const repo = fileURLToPath(new URL("../../", import.meta.url));

test("supported tunnel-client version floor", () => {
  assert.equal(tunnelClientSupported("tunnel-client version v0.0.21"), true);
  assert.equal(tunnelClientSupported("tunnel-client version 0.1.0"), true);
  assert.equal(tunnelClientSupported("tunnel-client version 0.0.20"), false);
  assert.equal(tunnelClientSupported("unknown"), false);
});

test("pinned Supergateway and actual AutoDev filesystem server enforce external grants", {
  skip: process.env.AUTODEV_TEST_SUPERGATEWAY !== "1",
  timeout: 180_000
}, async () => {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "autodev-supergateway-")));
  const workspace = path.join(root, "workspace");
  const client = new Client({ name: "autodev-supergateway-test", version: "1.0.0" });
  const env = chatgptSupergatewayEnvironment(
    { home: root, codexHome: path.join(root, ".codex"), repositoryRoot: repo },
    workspace, process.execPath, process.env.PATH ?? "/usr/bin:/bin"
  );
  try {
    mkdirSync(workspace);
    const inside = path.join(workspace, "inside.txt");
    const outside = path.join(root, "outside.txt");
    writeFileSync(inside, "expected-value");
    writeFileSync(outside, "outside-value");
    symlinkSync(outside, path.join(workspace, "escape.txt"));
    const executable = ensureSupergateway(root);
    const config = path.join(root, "supergateway.json");
    const catalogue = {
      filesystem: {
        command: process.execPath,
        args: [path.join(repo, "runtime/src/mcp/launcher.ts"), "filesystem"]
      }
    };
    const policy = { filesystem: ["read_text_file", "list_allowed_directories"] };
    writeFileSync(config, renderChatgptSupergatewayConfig(catalogue, policy, workspace, policy, undefined, (server) => externalFilesystemBackend(server, repo, workspace, process.execPath)));
    await client.connect(new StdioClientTransport({
      command: executable,
      args: ["--config", config],
      cwd: workspace,
      env,
      stderr: "inherit"
    }));
    const tools = await client.listTools();
    assert.deepEqual(tools.tools.map((tool) => tool.name).sort(), [
      "filesystem__list_allowed_directories", "filesystem__read_text_file"
    ]);
    assert.ok(tools.tools.every((tool) => tool.annotations?.readOnlyHint === true && tool.annotations.destructiveHint === false));
    const read = await client.callTool({
      name: "filesystem__read_text_file", arguments: { path: inside }
    });
    assert.match(JSON.stringify(read), /expected-value/);
    for (const target of [outside, path.join(workspace, "escape.txt")]) {
      const response = await client.callTool({
        name: "filesystem__read_text_file", arguments: { path: target }
      });
      assert.equal(response.isError, true);
      assert.doesNotMatch(JSON.stringify(response), /outside-value/);
    }
    await assert.rejects(async () => {
      const result = await client.callTool({
        name: "filesystem__write_file", arguments: { path: inside, content: "modified" }
      });
      if (result.isError) throw new Error("tool denied");
    });
    assert.equal(readFileSync(inside, "utf8"), "expected-value");
    // The same exact inventory check used by the installer must succeed.
    await probeSupergateway(executable, config, env);
  } finally {
    await client.close();
    rmSync(root, { recursive: true, force: true });
  }
});


test("dependency setup excludes both OpenAI credentials", () => {
  assert.deepEqual(dependencyEnvironment({ HOME: "/home/test", PATH: "/bin", OPENAI_ADMIN_KEY: "test", CONTROL_PLANE_API_KEY: "test", OPENAI_API_KEY: "test" }), { HOME: "/home/test", PATH: "/bin" });
});
test("MCP probe executes when started through the installed source symlink", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "autodev-probe-link-"));
  try {
    const link = path.join(directory, "probe.ts");
    symlinkSync(path.join(repo, "runtime/src/mcp/chatgpt-supergateway-probe.ts"), link);
    const result = spawnSync(process.execPath, [link], { encoding: "utf8" });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Expected Supergateway executable and config/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("external sandbox rejects every backend without a reviewed confinement profile", () => {
  for (const server of ["playwright", "playtest", "lsp", "codegraphcontext", "cocoindex-code"])
    assert.throws(() => externalFilesystemBackend(server, repo, repo, process.execPath), /No externally confined/);
});

test("OS sandbox denies protected file reads and loopback network", { skip: process.platform !== "darwin" }, async () => {
  const { createServer } = await import("node:net");
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "external-mcp-sandbox-")));
  const workspace = path.join(root, "workspace");
  mkdirSync(workspace);
  const protectedFile = path.join(root, "private-key");
  writeFileSync(protectedFile, "private", { mode: 0o600 });
  const inside = path.join(workspace, "inside");
  writeFileSync(inside, "inside");
  const server = createServer();
  try {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const addr = server.address();
    assert.ok(addr && typeof addr !== "string");
    const node = realpathSync(process.execPath);
    const profile = filesystemSandboxProfile(workspace, realpathSync(path.join(repo, "node_modules")), node);
    const result = spawnSync("/usr/bin/sandbox-exec", ["-p", profile, node, "-e",
      'const fs = require("node:fs"); const net = require("node:net"); if (fs.readFileSync(process.argv[1], "utf8") !== "inside") process.exit(2); try { fs.readFileSync(process.argv[2]); process.exit(3); } catch {} const s = net.connect(Number(process.argv[3]), "127.0.0.1"); s.on("connect", () => process.exit(4)); s.on("error", () => process.exit(0)); setTimeout(() => process.exit(5), 2000);',
      inside, protectedFile, String(addr.port)], { cwd: workspace, encoding: "utf8", timeout: 10_000 });
    assert.equal(result.status, 0, result.stderr);
  } finally {
    server.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("credential validation, private file ownership and symlinks fail closed", () => {
  const root = mkdtempSync(path.join(tmpdir(), "external-mcp-keys-"));
  try {
    for (const key of ["", "sk-admin-test", "key\nsecond", "key with space", "same"])
      assert.throws(() => validateRuntimeKey(key, "same"), /restricted runtime/);
    assert.doesNotThrow(() => validateRuntimeKey("test-runtime-key", "test-admin-key"));
    const keyFile = path.join(root, "key");
    privateWrite(keyFile, "test-runtime-key\n");
    assert.equal(privateRead(keyFile), "test-runtime-key");
    const link = path.join(root, "link");
    symlinkSync(keyFile, link);
    assert.throws(() => privateRead(link), /private regular file/);
    assert.throws(() => privateWrite(link, "new"), /non-private/);
    const dangling = path.join(root, "dangling");
    symlinkSync(path.join(root, "missing"), dangling);
    assert.throws(() => privateWrite(dangling, "new"), /non-private/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("tunnel listener must belong to the actual launchd job", async () => {
  const launchd = { print: () => "\tpid = 123\n" };
  let probes = 0;
  const probe = async () => { probes++; return true; };
  assert.equal(await ready(launchd, 3311, { listeners: () => ["456"], probe }), false);
  assert.equal(probes, 0);
  assert.equal(await ready(launchd, 3311, { listeners: () => ["123", "456"], probe }), false);
  assert.equal(await ready(launchd, 3311, { listeners: () => ["123"], probe }), true);
  assert.equal(await ready(launchd, 3311, { listeners: () => ["123"], probe: async () => false }), false);
});

test("official CLI argv, scope and sanitized authorization failure", () => {
  const root = mkdtempSync(path.join(tmpdir(), "external-mcp-cli-"));
  try {
    const cli = path.join(root, "tunnel client 'fixture'");
    writeFileSync(cli, "#!/bin/sh\n" + [
      'test "$1" = admin && test "$2" = --json && test "$3" = tunnels || exit 8',
      'if [ "$4" = create ]; then',
      '  test "$OPENAI_ADMIN_KEY" = test-admin && test -z "$CONTROL_PLANE_API_KEY" || exit 9',
      '  test "$9" = --organization-id && test "${10}" = org_test && test "${11}" = --workspace-id && test "${12}" = ws_test || exit 10',
      '  printf \'{"id":"tunnel_test"}\\n\'',
      'elif [ "$4" = get ]; then',
      '  test -z "$OPENAI_ADMIN_KEY" || exit 11',
      '  if [ "$CONTROL_PLANE_API_KEY" != test-runtime ]; then printf "HTTP 403 private-fixture-secret\\n" >&2; exit 12; fi',
      '  printf \'{"id":"tunnel_test","organization_ids":["org_test"],"workspace_ids":["ws_test"]}\\n\'',
      'else exit 13; fi'
    ].join("\n"), { mode: 0o700 });
    assert.equal(createTunnel(cli, { OPENAI_ADMIN_KEY: "test-admin" }, "org_test", "ws_test"), "tunnel_test");
    assert.deepEqual(tunnelMetadata(cli, ["get", "tunnel_test"], { CONTROL_PLANE_API_KEY: "test-runtime" }), { id: "tunnel_test", organization_ids: ["org_test"], workspace_ids: ["ws_test"] });
    assert.throws(() => tunnelMetadata(cli, ["get", "tunnel_test"], { CONTROL_PLANE_API_KEY: "bad" }), (error: unknown) => error instanceof Error && /unauthorized/.test(error.message) && !error.message.includes("private-fixture-secret"));
    const value = "directory with 'quote' and $dollar";
    const quoted = spawnSync("/bin/sh", ["-c", "printf %s " + shellWord(value)], { encoding: "utf8" });
    assert.equal(quoted.stdout, value);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
