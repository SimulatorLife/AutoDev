import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  chatgptSupergatewayEnvironment,
  renderChatgptSupergatewayConfig
} from "../../runtime/src/config/render-chatgpt-supergateway.ts";

const catalogue = {
  "future-server": { command: "example", args: ["--mcp", "a b"] },
  filesystem: { command: "bash", args: ["-lc", "exec launcher filesystem"] }
};
const http = { port: 3312, apiKeyFile: "/var/run/autodev/supergateway.key" };

test("Supergateway config is generated from the canonical catalogue with loopback stateful Streamable HTTP", () => {
  const result = JSON.parse(
    renderChatgptSupergatewayConfig(
      catalogue,
      { "future-server": ["search"], filesystem: ["read_text_file"] },
      "/project",
      { "future-server": ["search"], filesystem: ["read_text_file"] },
      http
    )
  );
  assert.deepEqual(result, {
    host: "127.0.0.1",
    port: 3312,
    logLevel: "none",
    logFormat: "json",
    healthEndpoint: ["/readyz"],
    mcpServers: {
      autodev: {
        path: "/",
        outputTransport: "streamableHttp",
        streamableHttpPath: "/mcp",
        stateful: true,
        apiKeyFile: "/var/run/autodev/supergateway.key",
        mcpServers: {
          "future-server": {
            command: process.execPath,
            args: [
              fileURLToPath(
                new URL("../../runtime/src/mcp/tool-filter.ts", import.meta.url)
              ),
              "example",
              JSON.stringify(["--mcp", "a b"]),
              JSON.stringify(["search"]),
              "external",
              "future-server"
            ],
            cwd: "/project",
            toolPrefix: "future_server__",
            tools: ["search"]
          },
          filesystem: {
            command: process.execPath,
            args: [
              fileURLToPath(
                new URL("../../runtime/src/mcp/tool-filter.ts", import.meta.url)
              ),
              "bash",
              JSON.stringify(["-lc", "exec launcher filesystem"]),
              JSON.stringify(["read_text_file"]),
              "external",
              "filesystem"
            ],
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
  const result = JSON.parse(
    renderChatgptSupergatewayConfig(
      catalogue,
      { "future-server": ["search"] },
      "/project",
      { "future-server": ["search"] },
      http
    )
  );
  assert.deepEqual(Object.keys(result.mcpServers.autodev.mcpServers), [
    "future-server"
  ]);
  assert.throws(
    () =>
      renderChatgptSupergatewayConfig(
        catalogue,
        { shell: ["exec"] },
        "/project",
        { shell: ["exec"] },
        http
      ),
    /Unknown/
  );
  assert.throws(
    () =>
      renderChatgptSupergatewayConfig(
        catalogue,
        { filesystem: ["*"] },
        "/project",
        { filesystem: ["read_text_file"] },
        http
      ),
    /wildcards/
  );
  assert.throws(
    () =>
      renderChatgptSupergatewayConfig(
        catalogue,
        { filesystem: [] },
        "/project",
        { filesystem: ["read_text_file"] },
        http
      ),
    /Explicit/
  );
  assert.throws(
    () => renderChatgptSupergatewayConfig(catalogue, {}, "/project", {}, http),
    /No MCP/
  );
});

test("reject incompatible transports, credentials, workspace, HTTP options and colliding namespaces", () => {
  assert.throws(
    () =>
      renderChatgptSupergatewayConfig(
        { docs: { url: "https://example.test/mcp" } },
        { docs: ["search"] },
        "/project",
        { docs: ["search"] },
        http
      ),
    /Unsupported/
  );
  assert.throws(
    () =>
      renderChatgptSupergatewayConfig(
        { docs: { command: "example", env: { SECRET: "x" } } },
        { docs: ["search"] },
        "/project",
        { docs: ["search"] },
        http
      ),
    /Unsupported/
  );
  assert.throws(
    () =>
      renderChatgptSupergatewayConfig(
        { docs: { command: "example", cwd: "/other" } },
        { docs: ["search"] },
        "/project",
        { docs: ["search"] },
        http
      ),
    /cwd/
  );
  assert.throws(
    () =>
      renderChatgptSupergatewayConfig(
        { "a-b": { command: "example" }, a_b: { command: "example" } },
        { "a-b": ["search"], a_b: ["search"] },
        "/project",
        { "a-b": ["search"], a_b: ["search"] },
        http
      ),
    /Colliding/
  );
  assert.throws(
    () =>
      renderChatgptSupergatewayConfig(
        catalogue,
        { filesystem: ["read_text_file"] },
        "/project",
        { filesystem: ["read_text_file"] },
        { port: 80, apiKeyFile: "/var/run/supergateway.key" }
      ),
    /port/
  );
  assert.throws(
    () =>
      renderChatgptSupergatewayConfig(
        catalogue,
        { filesystem: ["read_text_file"] },
        "/project",
        { filesystem: ["read_text_file"] },
        { port: 3312, apiKeyFile: "relative/supergateway.key" }
      ),
    /API key file/
  );
});

test("Supergateway receives an explicit credential-free process environment", () => {
  const env = chatgptSupergatewayEnvironment(
    {
      home: "/home/test",
      codexHome: "/home/test/.codex",
      repositoryRoot: "/project"
    },
    "/project",
    "/bin/node",
    "/bin"
  );
  assert.deepEqual(env, {
    HOME: "/home/test",
    CODEX_HOME: "/home/test/.codex",
    PATH: "/bin",
    AUTODEV_REPO_ROOT: "/project",
    AUTODEV_NODE_BIN: "/bin/node",
    AUTODEV_MCP_WORKSPACE: "/project",
    AUTODEV_MCP_READ_ONLY: "1",
    AUTODEV_MCP_WORKSPACE_ONLY: "1"
  });
});

test("local grants may narrow but not expand reviewed external permissions", () => {
  const reviewed = { filesystem: ["read_text_file"] };
  assert.throws(
    () =>
      renderChatgptSupergatewayConfig(
        catalogue,
        { "future-server": ["search"] },
        "/project",
        reviewed,
        http
      ),
    /reviewed external policy/
  );
  assert.throws(
    () =>
      renderChatgptSupergatewayConfig(
        catalogue,
        { filesystem: ["write_file"] },
        "/project",
        reviewed,
        http
      ),
    /reviewed external policy/
  );
  assert.doesNotThrow(() =>
    renderChatgptSupergatewayConfig(
      catalogue,
      { filesystem: ["read_text_file"] },
      "/project",
      reviewed,
      http
    )
  );
});

test("canonical shell expressions and key paths survive Supergateway interpolation", () => {
  const result = JSON.parse(
    renderChatgptSupergatewayConfig(
      {
        filesystem: {
          command: "bash",
          args: [
            "-lc",
            'exec "${CODEX_HOME:-$HOME/.codex}/hooks/run-autodev-mcp.sh" filesystem'
          ]
        }
      },
      { filesystem: ["read_text_file"] },
      "/a$b",
      { filesystem: ["read_text_file"] },
      { port: 3312, apiKeyFile: "/a$b/supergateway.key" }
    )
  );
  const entry = result.mcpServers.autodev.mcpServers.filesystem;
  assert.equal(
    JSON.parse(entry.args[2])[1],
    'exec "$${CODEX_HOME:-$$HOME/.codex}/hooks/run-autodev-mcp.sh" filesystem'
  );
  assert.equal(entry.cwd, "/a$$b");
  assert.equal(result.mcpServers.autodev.apiKeyFile, "/a$$b/supergateway.key");
});

test("missing or malformed reviewed policy fails closed", () => {
  const grants = { filesystem: ["read_text_file"] };
  assert.throws(
    () =>
      renderChatgptSupergatewayConfig(
        catalogue,
        grants,
        "/project",
        undefined,
        http
      ),
    /reviewed/
  );
  assert.throws(
    () =>
      renderChatgptSupergatewayConfig(
        catalogue,
        grants,
        "/project",
        {
          filesystem: ["*"]
        },
        http
      ),
    /reviewed/
  );
});

test("different prefixes cannot produce identical qualified names", () => {
  const grants = { a: ["b__c"], a__b: ["c"] };
  assert.throws(
    () =>
      renderChatgptSupergatewayConfig(
        { a: { command: "example" }, a__b: { command: "example" } },
        grants,
        "/project",
        grants,
        http
      ),
    /Colliding MCP qualified tool name/
  );
});
