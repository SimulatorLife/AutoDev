import assert from "node:assert/strict";
import test from "node:test";

import {
  chatgptSupergatewayEnvironment,
  renderChatgptSupergatewayConfig
} from "../../runtime/src/config/render-chatgpt-supergateway.ts";

const catalogue = {
  "future-server": { command: "example", args: ["--mcp", "a b"] },
  filesystem: { command: "bash", args: ["-lc", "exec launcher filesystem"] }
};

test("Supergateway config is generated from the canonical catalogue, not a fixed server inventory", () => {
  const result = JSON.parse(renderChatgptSupergatewayConfig(
    catalogue, { "future-server": ["search"], filesystem: ["read_text_file"] }, "/project"
  ));
  assert.deepEqual(result, {
    logLevel: "info",
    logFormat: "json",
    mcpServers: {
      autodev: {
        outputTransport: "stdio",
        mcpServers: {
          "future-server": {
            command: "example",
            args: ["--mcp", "a b"],
            cwd: "/project",
            toolPrefix: "future_server__",
            tools: ["search"]
          },
          filesystem: {
            command: "bash",
            args: ["-lc", "exec launcher filesystem"],
            cwd: "/project",
            toolPrefix: "filesystem__",
            tools: ["read_text_file"]
          }
        }
      }
    }
  });
});

test("ungranted servers, unknown names, wildcard and empty grants fail closed", () => {
  const result = JSON.parse(renderChatgptSupergatewayConfig(
    catalogue, { "future-server": ["search"] }, "/project"
  ));
  assert.deepEqual(Object.keys(result.mcpServers.autodev.mcpServers), ["future-server"]);
  assert.throws(() => renderChatgptSupergatewayConfig(catalogue, { shell: ["exec"] }, "/project"), /Unknown/);
  assert.throws(() => renderChatgptSupergatewayConfig(catalogue, { filesystem: ["*"] }, "/project"), /wildcards/);
  assert.throws(() => renderChatgptSupergatewayConfig(catalogue, { filesystem: [] }, "/project"), /Explicit/);
  assert.throws(() => renderChatgptSupergatewayConfig(catalogue, {}, "/project"), /No MCP/);
});

test("reject incompatible transports, credentials, workspace and colliding namespaces", () => {
  assert.throws(() => renderChatgptSupergatewayConfig(
    { docs: { url: "https://example.test/mcp" } }, { docs: ["search"] }, "/project"
  ), /Unsupported/);
  assert.throws(() => renderChatgptSupergatewayConfig(
    { docs: { command: "example", env: { SECRET: "x" } } }, { docs: ["search"] }, "/project"
  ), /Unsupported/);
  assert.throws(() => renderChatgptSupergatewayConfig(
    { docs: { command: "example", cwd: "/other" } }, { docs: ["search"] }, "/project"
  ), /cwd/);
  assert.throws(() => renderChatgptSupergatewayConfig(
    { "a-b": { command: "example" }, a_b: { command: "example" } },
    { "a-b": ["search"], a_b: ["search"] }, "/project"
  ), /Colliding/);
});

test("Supergateway receives an explicit credential-free process environment", () => {
  const env = chatgptSupergatewayEnvironment({
    home: "/home/test", codexHome: "/home/test/.codex", repositoryRoot: "/project"
  }, "/project", "/bin/node", "/bin");
  assert.deepEqual(env, {
    HOME: "/home/test",
    CODEX_HOME: "/home/test/.codex",
    PATH: "/bin",
    AUTODEV_REPO_ROOT: "/project",
    AUTODEV_NODE_BIN: "/bin/node",
    AUTODEV_MCP_WORKSPACE: "/project",
    AUTODEV_MCP_READ_ONLY: "1"
  });
});
