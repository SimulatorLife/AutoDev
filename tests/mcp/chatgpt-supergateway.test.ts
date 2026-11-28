import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  chatgptRoleEnvironment,
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
      [
        {
          role: "orchestrator",
          grants: {
            "future-server": ["search"],
            filesystem: ["read_text_file"]
          },
          reviewed: {
            "future-server": ["search"],
            filesystem: ["read_text_file"]
          }
        }
      ],
      "/project",
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
      orchestrator: {
        path: "/orchestrator",
        outputTransport: "streamableHttp",
        streamableHttpPath: "/mcp",
        stateful: true,
        apiKeyFile: "/var/run/autodev/supergateway.key",
        mcpServers: {
          "future-server": {
            url: "http://127.0.0.1:${AUTODEV_MCP_POOL_PORT}/mcp/orchestrator.future-server",
            type: "streamableHttp",
            oauth2Bearer: "${AUTODEV_MCP_POOL_TOKEN}",
            toolPrefix: "future_server__",
            tools: ["search"]
          },
          filesystem: {
            url: "http://127.0.0.1:${AUTODEV_MCP_POOL_PORT}/mcp/orchestrator.filesystem",
            type: "streamableHttp",
            oauth2Bearer: "${AUTODEV_MCP_POOL_TOKEN}",
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
      [
        {
          role: "orchestrator",
          grants: { "future-server": ["search"] },
          reviewed: { "future-server": ["search"] }
        }
      ],
      "/project",
      { ...http, sessionTimeout: DEFAULT_CHATGPT_SESSION_TIMEOUT_MS }
    )
  );
  assert.equal(
    withTimeout.mcpServers.orchestrator.sessionTimeout,
    DEFAULT_CHATGPT_SESSION_TIMEOUT_MS
  );
});

test("ungranted servers, unknown names, wildcard and empty grants fail closed", () => {
  const result = JSON.parse(
    renderChatgptSupergatewayConfig(
      catalogue,
      [
        {
          role: "orchestrator",
          grants: { "future-server": ["search"] },
          reviewed: { "future-server": ["search"] }
        }
      ],
      "/project",
      http
    )
  );
  assert.deepEqual(Object.keys(result.mcpServers.orchestrator.mcpServers), [
    "future-server"
  ]);
  assert.throws(
    () =>
      renderChatgptSupergatewayConfig(
        catalogue,
        [
          {
            role: "orchestrator",
            grants: { shell: ["exec"] },
            reviewed: { shell: ["exec"] }
          }
        ],
        "/project",
        http
      ),
    /Unknown/
  );
  assert.throws(
    () =>
      renderChatgptSupergatewayConfig(
        catalogue,
        [
          {
            role: "orchestrator",
            grants: { filesystem: ["*"] },
            reviewed: { filesystem: ["read_text_file"] }
          }
        ],
        "/project",
        http
      ),
    /wildcards/
  );
  assert.throws(
    () =>
      renderChatgptSupergatewayConfig(
        catalogue,
        [
          {
            role: "orchestrator",
            grants: { filesystem: [] },
            reviewed: { filesystem: ["read_text_file"] }
          }
        ],
        "/project",
        http
      ),
    /Explicit/
  );
  assert.throws(
    () =>
      renderChatgptSupergatewayConfig(
        catalogue,
        [{ role: "orchestrator", grants: {}, reviewed: {} }],
        "/project",
        http
      ),
    /No MCP/
  );
});

test("remote Streamable HTTP descriptors render credential-free pool routes and remote specs", () => {
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
  const surfaces = [
    { role: "orchestrator", grants: remoteGrants, reviewed: remoteGrants }
  ];
  const rendered = renderChatgptSupergatewayConfig(
    remoteCatalogue,
    surfaces,
    "/project",
    http
  );
  assert.doesNotMatch(rendered, /Bearer\s+[A-Za-z0-9]/u);
  assert.doesNotMatch(rendered, /CONTEXT7_API_KEY|GOOGLE_DEVELOPER_KNOWLEDGE/u);
  const servers = JSON.parse(rendered).mcpServers.orchestrator.mcpServers;
  assert.equal(
    servers.openaiDeveloperDocs.url,
    "http://127.0.0.1:${AUTODEV_MCP_POOL_PORT}/mcp/orchestrator.openaiDeveloperDocs"
  );
  assert.equal(servers.openaiDeveloperDocs.toolPrefix, "openaiDeveloperDocs__");
  // The pool resolves credentials from the named variables at call time; the
  // manifest carries only their names and header templates.
  const pool = JSON.parse(
    renderChatgptBackendPoolConfig(remoteCatalogue, surfaces, "/project")
  ).servers;
  assert.deepEqual(pool["orchestrator.openaiDeveloperDocs"], {
    kind: "remote",
    url: "https://developers.openai.com/mcp",
    tools: ["search_openai_docs"]
  });
  assert.deepEqual(pool["orchestrator.context7"], {
    kind: "remote",
    url: "https://mcp.context7.com/mcp",
    bearer_token_env_var: "CONTEXT7_API_KEY",
    tools: ["resolve-library-id", "query-docs"]
  });
  assert.deepEqual(pool["orchestrator.googleDeveloperKnowledge"].http_headers, {
    "X-Goog-Api-Key": "${GOOGLE_DEVELOPER_KNOWLEDGE_API_KEY}"
  });
});

test("reject incompatible transports, credentials, workspace, HTTP options and colliding namespaces", () => {
  assert.throws(
    () =>
      renderChatgptSupergatewayConfig(
        { docs: { url: "http://example.test/mcp" } },
        [
          {
            role: "orchestrator",
            grants: { docs: ["search"] },
            reviewed: { docs: ["search"] }
          }
        ],
        "/project",
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
        [
          {
            role: "orchestrator",
            grants: { docs: ["search"] },
            reviewed: { docs: ["search"] }
          }
        ],
        "/project",
        http
      ),
    /Unsupported/
  );
  assert.throws(
    () =>
      renderChatgptSupergatewayConfig(
        { docs: { command: "example", env: { SECRET: "x" } } },
        [
          {
            role: "orchestrator",
            grants: { docs: ["search"] },
            reviewed: { docs: ["search"] }
          }
        ],
        "/project",
        http
      ),
    /Unsupported/
  );
  assert.throws(
    () =>
      renderChatgptSupergatewayConfig(
        { docs: { command: "example", cwd: "/other" } },
        [
          {
            role: "orchestrator",
            grants: { docs: ["search"] },
            reviewed: { docs: ["search"] }
          }
        ],
        "/project",
        http
      ),
    /cwd/
  );
  assert.throws(
    () =>
      renderChatgptSupergatewayConfig(
        { "a-b": { command: "example" }, a_b: { command: "example" } },
        [
          {
            role: "orchestrator",
            grants: { "a-b": ["search"], a_b: ["search"] },
            reviewed: { "a-b": ["search"], a_b: ["search"] }
          }
        ],
        "/project",
        http
      ),
    /Colliding/
  );
  assert.throws(
    () =>
      renderChatgptSupergatewayConfig(
        catalogue,
        [
          {
            role: "orchestrator",
            grants: { filesystem: ["read_text_file"] },
            reviewed: { filesystem: ["read_text_file"] }
          }
        ],
        "/project",
        { port: 80, apiKeyFile: "/var/run/supergateway.key" }
      ),
    /port/
  );
  assert.throws(
    () =>
      renderChatgptSupergatewayConfig(
        catalogue,
        [
          {
            role: "orchestrator",
            grants: { filesystem: ["read_text_file"] },
            reviewed: { filesystem: ["read_text_file"] }
          }
        ],
        "/project",
        { port: 3312, apiKeyFile: "relative/supergateway.key" }
      ),
    /API key file/
  );
});

test("Supergateway receives an explicit credential-free role-aware process environment", () => {
  const orchestratorEnvironment = chatgptSupergatewayEnvironment(
    {
      home: "/home/test",
      codexHome: "/home/test/.codex",
      repositoryRoot: "/project"
    },
    "/project",
    "/bin/node",
    "/bin"
  );
  assert.deepEqual(orchestratorEnvironment, {
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
      "/home/test/.codex/run/xacpx-orchestration.sock"
  });
  assert.equal("AUTODEV_MCP_READ_ONLY" in orchestratorEnvironment, false);
  assert.equal("AUTODEV_MCP_WORKSPACE_ONLY" in orchestratorEnvironment, false);

  const explorerEnvironment = chatgptSupergatewayEnvironment(
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
  assert.equal(explorerEnvironment.AUTODEV_AGENT_ROLE, "explorer");
  // Read-only confinement belongs to the published surface, not to the shared
  // gateway process, so one role's read-only grant never reaches another's.
  assert.equal("AUTODEV_MCP_READ_ONLY" in explorerEnvironment, false);
  assert.deepEqual(chatgptRoleEnvironment("explorer", "/project"), {
    AUTODEV_AGENT_ROLE: "explorer",
    AUTODEV_XACPX_COORDINATOR_SESSION: "chatgpt:explorer:project",
    AUTODEV_MCP_READ_ONLY: "1"
  });
  assert.deepEqual(chatgptRoleEnvironment("orchestrator", "/project"), {
    AUTODEV_AGENT_ROLE: "orchestrator",
    AUTODEV_XACPX_COORDINATOR_SESSION: "chatgpt:orchestrator:project"
  });
});

test("local grants may narrow but not expand authorized role permissions", () => {
  const reviewed = { filesystem: ["read_text_file"] };
  assert.throws(
    () =>
      renderChatgptSupergatewayConfig(
        catalogue,
        [
          {
            role: "orchestrator",
            grants: { "future-server": ["search"] },
            reviewed: reviewed
          }
        ],
        "/project",
        http
      ),
    /authorized role policy/
  );
  assert.throws(
    () =>
      renderChatgptSupergatewayConfig(
        catalogue,
        [
          {
            role: "orchestrator",
            grants: { filesystem: ["write_file"] },
            reviewed: reviewed
          }
        ],
        "/project",
        http
      ),
    /authorized role policy/
  );
  assert.doesNotThrow(() =>
    renderChatgptSupergatewayConfig(
      catalogue,
      [
        {
          role: "orchestrator",
          grants: { filesystem: ["read_text_file"] },
          reviewed: reviewed
        }
      ],
      "/project",
      http
    )
  );
});

test("canonical shell expressions reach the pool verbatim and key paths survive Supergateway interpolation", () => {
  const shellCatalogue = {
    filesystem: {
      command: "bash",
      args: [
        "-lc",
        'exec "${CODEX_HOME:-$HOME/.codex}/hooks/run-autodev-mcp.sh" filesystem'
      ]
    }
  };
  const surfaces = [
    {
      role: "orchestrator",
      grants: { filesystem: ["read_text_file"] },
      reviewed: { filesystem: ["read_text_file"] }
    }
  ];
  const result = JSON.parse(
    renderChatgptSupergatewayConfig(shellCatalogue, surfaces, "/a$b", {
      port: 3312,
      apiKeyFile: "/a$b/supergateway.key"
    })
  );
  assert.equal(
    result.mcpServers.orchestrator.apiKeyFile,
    "/a$$b/supergateway.key"
  );
  // The pool manifest is never interpolated, so it keeps the literal shell
  // expression and workspace.
  const entry = JSON.parse(
    renderChatgptBackendPoolConfig(shellCatalogue, surfaces, "/a$b")
  ).servers["orchestrator.filesystem"];
  assert.equal(
    entry.args[1],
    'exec "${CODEX_HOME:-$HOME/.codex}/hooks/run-autodev-mcp.sh" filesystem'
  );
  assert.equal(entry.cwd, "/a$b");
});

test("missing or malformed reviewed policy fails closed", () => {
  const grants = { filesystem: ["read_text_file"] };
  assert.throws(
    () =>
      renderChatgptSupergatewayConfig(
        catalogue,
        [{ role: "orchestrator", grants: grants, reviewed: undefined }],
        "/project",
        http
      ),
    /reviewed/
  );
  assert.throws(
    () =>
      renderChatgptSupergatewayConfig(
        catalogue,
        [
          {
            role: "orchestrator",
            grants: grants,
            reviewed: {
              filesystem: ["*"]
            }
          }
        ],
        "/project",
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
        [{ role: "orchestrator", grants: grants, reviewed: grants }],
        "/project",
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
      [{ role: "orchestrator", grants: grants, reviewed: grants }],
      "/project",
      { ...http, sessionTimeout: DEFAULT_CHATGPT_SESSION_TIMEOUT_MS }
    )
  );
  assert.equal(DEFAULT_CHATGPT_SESSION_TIMEOUT_MS, 60_000);
  assert.equal(gatewayJson.mcpServers.orchestrator.sessionTimeout, 60_000);
  assert.deepEqual(gatewayJson.mcpServers.orchestrator.mcpServers, {
    filesystem: {
      url: "http://127.0.0.1:${AUTODEV_MCP_POOL_PORT}/mcp/orchestrator.filesystem",
      type: "streamableHttp",
      oauth2Bearer: "${AUTODEV_MCP_POOL_TOKEN}",
      toolPrefix: "filesystem__",
      tools: ["read_text_file"]
    },
    context7: {
      url: "http://127.0.0.1:${AUTODEV_MCP_POOL_PORT}/mcp/orchestrator.context7",
      type: "streamableHttp",
      oauth2Bearer: "${AUTODEV_MCP_POOL_TOKEN}",
      toolPrefix: "context7__",
      tools: ["query-docs"]
    }
  });

  const poolManifest = JSON.parse(
    renderChatgptBackendPoolConfig(
      mixedCatalogue,
      [{ role: "orchestrator", grants: grants, reviewed: grants }],
      "/project"
    )
  );
  assert.deepEqual(poolManifest, {
    version: 1,
    servers: {
      "orchestrator.filesystem": {
        kind: "stdio",
        server: "filesystem",
        env: {
          AUTODEV_AGENT_ROLE: "orchestrator",
          AUTODEV_XACPX_COORDINATOR_SESSION: "chatgpt:orchestrator:project"
        },
        command: "example-fs",
        args: ["--read-only"],
        cwd: "/project",
        tools: ["read_text_file"]
      },
      "orchestrator.context7": {
        kind: "remote",
        url: "https://mcp.context7.com/mcp",
        bearer_token_env_var: "CONTEXT7_API_KEY",
        tools: ["query-docs"]
      }
    }
  });
});
