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
import { dependencyEnvironment, tunnelClientSupported } from "../src/platform/chatgpt-tunnel-install.ts";

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
    writeFileSync(config, renderChatgptSupergatewayConfig(catalogue, policy, workspace, policy));
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
