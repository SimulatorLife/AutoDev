import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  chatgptSupergatewayEnvironment,
  DEFAULT_CHATGPT_SESSION_TIMEOUT_MS,
  parseRulesyncExternalMcpPermissions,
  renderChatgptBackendPoolConfig,
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
  const withTimeout = JSON.parse(
    renderChatgptSupergatewayConfig(
      catalogue,
      { "future-server": ["search"] },
      "/project",
      { "future-server": ["search"] },
      { ...http, sessionTimeout: DEFAULT_CHATGPT_SESSION_TIMEOUT_MS }
    )
  );
  assert.equal(
    withTimeout.mcpServers.autodev.sessionTimeout,
    DEFAULT_CHATGPT_SESSION_TIMEOUT_MS
  );
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

test("remote Streamable HTTP descriptors render parameterized --remote filter entries without leaking secrets", () => {
  const remoteCatalogue = {
    ...catalogue,
    openaiDeveloperDocs: { url: "https://developers.openai.com/mcp" },
    context7: {
      url: "https://mcp.context7.com/mcp",
      bearer_token_env_var: "CONTEXT7_API_KEY"
    },
    googleDeveloperKnowledge: {
      url: "https://developerknowledge.googleapis.com/mcp",
      http_headers: {
        "X-Goog-Api-Key": "${GOOGLE_DEVELOPER_KNOWLEDGE_API_KEY}"
      }
    }
  };
  const remoteGrants = {
    filesystem: ["read_text_file"],
    openaiDeveloperDocs: ["search_openai_docs"],
    context7: ["resolve-library-id", "query-docs"],
    googleDeveloperKnowledge: ["search_documents"]
  };
  const rendered = renderChatgptSupergatewayConfig(
    remoteCatalogue,
    remoteGrants,
    "/project",
    remoteGrants,
    http
  );
  assert.doesNotMatch(rendered, /Bearer\s+[A-Za-z0-9]/u);
  const parsed = JSON.parse(rendered);
  const servers = parsed.mcpServers.autodev.mcpServers;
  assert.equal(servers.openaiDeveloperDocs.args[1], "--remote");
  assert.deepEqual(JSON.parse(servers.openaiDeveloperDocs.args[2]), {
    url: "https://developers.openai.com/mcp"
  });
  assert.equal(servers.openaiDeveloperDocs.toolPrefix, "openaiDeveloperDocs__");
  assert.equal(servers.context7.args[1], "--remote");
  assert.deepEqual(JSON.parse(servers.context7.args[2]), {
    url: "https://mcp.context7.com/mcp",
    bearer_token_env_var: "CONTEXT7_API_KEY"
  });
  assert.equal(
    servers.googleDeveloperKnowledge.args[2],
    JSON.stringify({
      url: "https://developerknowledge.googleapis.com/mcp",
      http_headers: {
        "X-Goog-Api-Key": "$${GOOGLE_DEVELOPER_KNOWLEDGE_API_KEY}"
      }
    })
  );
});

test("reject incompatible transports, credentials, workspace, HTTP options and colliding namespaces", () => {
  assert.throws(
    () =>
      renderChatgptSupergatewayConfig(
        { docs: { url: "http://example.test/mcp" } },
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
        {
          docs: {
            url: "https://example.test/mcp",
            http_headers: { Authorization: "Bearer literal-secret" }
          }
        },
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

test("Supergateway receives an explicit credential-free role-aware process environment", () => {
  const orchestratorEnv = chatgptSupergatewayEnvironment(
    {
      home: "/home/test",
      codexHome: "/home/test/.codex",
      repositoryRoot: "/project"
    },
    "/project",
    "/bin/node",
    "/bin"
  );
  assert.deepEqual(orchestratorEnv, {
    HOME: "/home/test",
    CODEX_HOME: "/home/test/.codex",
    PATH: "/bin",
    AUTODEV_REPO_ROOT: "/project",
    AUTODEV_NODE_BIN: "/bin/node",
    AUTODEV_MCP_WORKSPACE: "/project",
    AUTODEV_AGENT_ROLE: "orchestrator",
    AUTODEV_XACPX_WORKSPACE: "/project",
    AUTODEV_XACPX_COORDINATOR_SESSION: "chatgpt:orchestrator:project",
    XACPX_ORCHESTRATION_SOCKET:
      "/home/test/.codex/run/xacpx-orchestration.sock",
    XACPX_CONFIG: "/home/test/.codex/run/xacpx/config.json",
    XACPX_STATE: "/home/test/.codex/run/xacpx/state.json"
  });
  assert.equal("AUTODEV_MCP_READ_ONLY" in orchestratorEnv, false);
  assert.equal("AUTODEV_MCP_WORKSPACE_ONLY" in orchestratorEnv, false);

  const explorerEnv = chatgptSupergatewayEnvironment(
    {
      home: "/home/test",
      codexHome: "/home/test/.codex",
      repositoryRoot: "/project"
    },
    "/project",
    "/bin/node",
    "/bin",
    { role: "explorer" }
  );
  assert.equal(explorerEnv.AUTODEV_AGENT_ROLE, "explorer");
  assert.equal(explorerEnv.AUTODEV_MCP_READ_ONLY, "1");
});

test("local grants may narrow but not expand authorized role permissions", () => {
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
    /authorized role policy/
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
    /authorized role policy/
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

test("canonical .rulesync/permissions.jsonc derives reviewed ChatGPT MCP permissions without duplication", () => {
  const permissionsUrl = new URL(
    "../../.rulesync/permissions.jsonc",
    import.meta.url
  );
  const summary = parseRulesyncExternalMcpPermissions(
    readFileSync(permissionsUrl, "utf8")
  );
  assert.deepEqual([...summary.allowedServers].sort(), [
    "context7",
    "filesystem",
    "googleDeveloperKnowledge",
    "lsp",
    "openaiDeveloperDocs",
    "xacpx"
  ]);
  assert.deepEqual([...summary.deniedServers].sort(), [
    "playtest",
    "playwright"
  ]);
  assert.deepEqual(summary.allowedTools, {
    "cocoindex-code": ["search"],
    codegraphcontext: [
      "list_indexed_repositories",
      "find_code",
      "analyze_code_relationships",
      "get_repository_stats"
    ]
  });
});

test("pooled Supergateway config renders loopback Streamable HTTP upstreams paired with backend-pool manifest", () => {
  const mixedCatalogue = {
    filesystem: { command: "example-fs", args: ["--read-only"] },
    context7: {
      url: "https://mcp.context7.com/mcp",
      bearer_token_env_var: "CONTEXT7_API_KEY"
    }
  };
  const grants = {
    filesystem: ["read_text_file"],
    context7: ["query-docs"]
  };
  const gatewayJson = JSON.parse(
    renderChatgptSupergatewayConfig(
      mixedCatalogue,
      grants,
      "/project",
      grants,
      {
        ...http,
        sessionTimeout: DEFAULT_CHATGPT_SESSION_TIMEOUT_MS,
        backendPool: true
      }
    )
  );
  assert.equal(DEFAULT_CHATGPT_SESSION_TIMEOUT_MS, 60_000);
  assert.equal(gatewayJson.mcpServers.autodev.sessionTimeout, 60_000);
  assert.deepEqual(gatewayJson.mcpServers.autodev.mcpServers, {
    filesystem: {
      url: "http://127.0.0.1:${AUTODEV_MCP_POOL_PORT}/mcp/filesystem",
      type: "streamableHttp",
      oauth2Bearer: "${AUTODEV_MCP_POOL_TOKEN}",
      toolPrefix: "filesystem__",
      tools: ["read_text_file"]
    },
    context7: {
      url: "http://127.0.0.1:${AUTODEV_MCP_POOL_PORT}/mcp/context7",
      type: "streamableHttp",
      oauth2Bearer: "${AUTODEV_MCP_POOL_TOKEN}",
      toolPrefix: "context7__",
      tools: ["query-docs"]
    }
  });

  const poolManifest = JSON.parse(
    renderChatgptBackendPoolConfig(
      mixedCatalogue,
      grants,
      "/project",
      grants
    )
  );
  assert.deepEqual(poolManifest, {
    version: 1,
    servers: {
      filesystem: {
        kind: "stdio",
        command: "example-fs",
        args: ["--read-only"],
        cwd: "/project",
        tools: ["read_text_file"]
      },
      context7: {
        kind: "remote",
        url: "https://mcp.context7.com/mcp",
        bearer_token_env_var: "CONTEXT7_API_KEY",
        tools: ["query-docs"]
      }
    }
  });
});
