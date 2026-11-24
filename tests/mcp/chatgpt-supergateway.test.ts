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

test("Supergateway config is generated from the canonical catalogue, not a fixed server inventory", () => {
  const result = JSON.parse(
    renderChatgptSupergatewayConfig(
      catalogue,
      { "future-server": ["search"], filesystem: ["read_text_file"] },
      "/project",
      { "future-server": ["search"], filesystem: ["read_text_file"] }
    )
  );
  assert.deepEqual(result, {
    logLevel: "none",
    logFormat: "json",
    mcpServers: {
      autodev: {
        outputTransport: "stdio",
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
      { "future-server": ["search"] }
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
        { shell: ["exec"] }
      ),
    /Unknown/
  );
  assert.throws(
    () =>
      renderChatgptSupergatewayConfig(
        catalogue,
        { filesystem: ["*"] },
        "/project",
        { filesystem: ["read_text_file"] }
      ),
    /wildcards/
  );
  assert.throws(
    () =>
      renderChatgptSupergatewayConfig(
        catalogue,
        { filesystem: [] },
        "/project",
        { filesystem: ["read_text_file"] }
      ),
    /Explicit/
  );
  assert.throws(
    () => renderChatgptSupergatewayConfig(catalogue, {}, "/project", {}),
    /No MCP/
  );
});

test("reject incompatible transports, credentials, workspace and colliding namespaces", () => {
  assert.throws(
    () =>
      renderChatgptSupergatewayConfig(
        { docs: { url: "https://example.test/mcp" } },
        { docs: ["search"] },
        "/project",
        { docs: ["search"] }
      ),
    /Unsupported/
  );
  assert.throws(
    () =>
      renderChatgptSupergatewayConfig(
        { docs: { command: "example", env: { SECRET: "x" } } },
        { docs: ["search"] },
        "/project",
        { docs: ["search"] }
      ),
    /Unsupported/
  );
  assert.throws(
    () =>
      renderChatgptSupergatewayConfig(
        { docs: { command: "example", cwd: "/other" } },
        { docs: ["search"] },
        "/project",
        { docs: ["search"] }
      ),
    /cwd/
  );
  assert.throws(
    () =>
      renderChatgptSupergatewayConfig(
        { "a-b": { command: "example" }, a_b: { command: "example" } },
        { "a-b": ["search"], a_b: ["search"] },
        "/project",
        { "a-b": ["search"], a_b: ["search"] }
      ),
    /Colliding/
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
        reviewed
      ),
    /reviewed external policy/
  );
  assert.throws(
    () =>
      renderChatgptSupergatewayConfig(
        catalogue,
        { filesystem: ["write_file"] },
        "/project",
        reviewed
      ),
    /reviewed external policy/
  );
  assert.doesNotThrow(() =>
    renderChatgptSupergatewayConfig(
      catalogue,
      { filesystem: ["read_text_file"] },
      "/project",
      reviewed
    )
  );
});

test("canonical shell expressions survive Supergateway interpolation", () => {
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
      { filesystem: ["read_text_file"] }
    )
  );
  const entry = result.mcpServers.autodev.mcpServers.filesystem;
  assert.equal(
    JSON.parse(entry.args[2])[1],
    'exec "$${CODEX_HOME:-$$HOME/.codex}/hooks/run-autodev-mcp.sh" filesystem'
  );
  assert.equal(entry.cwd, "/a$$b");
});

test("missing or malformed reviewed policy fails closed", () => {
  const grants = { filesystem: ["read_text_file"] };
  assert.throws(
    () =>
      renderChatgptSupergatewayConfig(catalogue, grants, "/project", undefined),
    /reviewed/
  );
  assert.throws(
    () =>
      renderChatgptSupergatewayConfig(catalogue, grants, "/project", {
        filesystem: ["*"]
      }),
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
        grants
      ),
    /Colliding MCP qualified tool name/
  );
});
