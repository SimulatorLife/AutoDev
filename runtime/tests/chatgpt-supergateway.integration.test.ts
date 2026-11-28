import assert from "node:assert/strict";
import {
  type ChildProcess,
  execFileSync,
  spawn,
  spawnSync
} from "node:child_process";
import { once } from "node:events";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { createServer as createNetServer } from "node:net";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import {
  AGENT_METHODS,
  AgentApp,
  CLIENT_METHODS,
  PROTOCOL_VERSION
} from "@agentclientprotocol/sdk";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ToolListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";

import {
  chatgptSupergatewayEnvironment,
  DEFAULT_CHATGPT_SESSION_TIMEOUT_MS,
  renderChatgptBackendPoolConfig,
  renderChatgptSupergatewayConfig
} from "../src/config/render-chatgpt-supergateway.ts";
import {
  CHATGPT_MCP_POOL_PORT_ENV,
  CHATGPT_MCP_POOL_TOKEN_ENV,
  startChatgptBackendPool
} from "../src/mcp/chatgpt-backend-pool.ts";
import {
  externalMcpBackend,
  filesystemSandboxProfile
} from "../src/mcp/chatgpt-filesystem-sandbox.ts";
import { probeSupergateway } from "../src/mcp/chatgpt-supergateway-probe.ts";
import {
  assertTunnelScope,
  chatgptTunnelChannels,
  type ChatgptTunnelDependencies,
  chatgptTunnelStatus,
  checkChatgptTunnel,
  createTunnel,
  ensureChatgptTunnel,
  runChatgptTunnelDaemon,
  tunnelClientMcpEnv as tunnelClientMcpEnvironment,
  tunnelClientSupported,
  tunnelMetadata,
  tunnelMutationSchema,
  validateRuntimeKey
} from "../src/platform/chatgpt-tunnel-install.ts";
import {
  checkMcpGateway,
  commandFailureReport,
  dependencyEnvironment,
  ensureMcpGateway,
  MCP_GATEWAY_LABEL,
  type McpGatewayDependencies,
  privateRead,
  privateWrite,
  readMcpGatewayState,
  resolveSupergateway,
  runMcpGatewayDaemon,
  serviceReady
} from "../src/platform/mcp-gateway-service.ts";
import { resolveCommandOnPath } from "../src/platform/runtime-files.ts";
import { resolveCocoIndexBinary } from "../src/shared/executables.ts";
import { roleContract } from "../src/shared/execution-contract.ts";
import { XacpxSessionManager } from "../src/xacpx/manager.ts";
import {
  resolveXacpxOrchestrationSocketPath,
  startXacpxOrchestrationIpcServer
} from "../src/xacpx/orchestration-ipc.ts";

const repository = fileURLToPath(new URL("../../", import.meta.url));

async function allocateLoopbackPort(): Promise<number> {
  const server = createNetServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const { port } = address;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

async function stopProcess(proc: ChildProcess | undefined): Promise<void> {
  if (!proc || proc.exitCode !== null || proc.signalCode !== null) return;
  proc.kill("SIGTERM");
  const exited = await Promise.race([
    once(proc, "exit").then(() => true),
    delay(5000).then(() => false)
  ]);
  if (exited || proc.exitCode !== null || proc.signalCode !== null) {
    return;
  }

  proc.kill("SIGKILL");
  await once(proc, "exit").catch(() => {});
}

/*
Render a gateway the way the installer does: the Supergateway config and its
sibling backend-pool manifest, which every member routes through.
*/
function renderGatewayConfig(
  directory: string,
  catalogue: Parameters<typeof renderChatgptSupergatewayConfig>[0],
  surfaces: Parameters<typeof renderChatgptSupergatewayConfig>[1],
  workspace: string,
  http: Parameters<typeof renderChatgptSupergatewayConfig>[3],
  confinedBackend?: Parameters<typeof renderChatgptSupergatewayConfig>[4]
): string {
  writeFileSync(
    path.join(directory, "backend-pool.json"),
    renderChatgptBackendPoolConfig(
      catalogue,
      surfaces,
      workspace,
      confinedBackend
    ),
    { mode: 0o600 }
  );
  return renderChatgptSupergatewayConfig(
    catalogue,
    surfaces,
    workspace,
    http,
    confinedBackend
  );
}

/*
Start Supergateway with its backend pool, as the gateway service does. The
pool runs in-process and closes when Supergateway exits; a caller that runs
its own pool passes its address in `env`.
*/
async function startSupergatewayServer(
  executable: string,
  config: string,
  cwd: string,
  environment: Record<string, string>,
  port: number
): Promise<ChildProcess> {
  let logs = "";
  const pool = environment[CHATGPT_MCP_POOL_PORT_ENV]
    ? undefined
    : await startChatgptBackendPool(
        JSON.parse(
          readFileSync(
            path.join(path.dirname(config), "backend-pool.json"),
            "utf8"
          )
        ),
        { gatewayEnv: environment, secretEnv: environment }
      );
  const child = spawn(
    executable,
    ["--config", config, "--exitWithProcess", String(process.pid)],
    {
      cwd,
      env: pool
        ? {
            ...environment,
            [CHATGPT_MCP_POOL_PORT_ENV]: String(pool.port),
            [CHATGPT_MCP_POOL_TOKEN_ENV]: pool.token
          }
        : environment,
      stdio: ["pipe", "pipe", "pipe"]
    }
  );
  child.once("exit", () => {
    void pool?.close();
  });
  child.stdout?.on("data", (chunk) => {
    logs += String(chunk);
  });
  child.stderr?.on("data", (chunk) => {
    logs += String(chunk);
  });
  for (let attempt = 0; attempt < 150; attempt++) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`Supergateway exited early: ${logs}`);
    }
    try {
      const response = await fetch(`http://127.0.0.1:${port}/readyz`, {
        signal: AbortSignal.timeout(1000)
      });
      if (response.ok) return child;
    } catch {
      /*
      waiting for Supergateway
      */
    }
    await delay(200);
  }
  await stopProcess(child);
  throw new Error(`Supergateway did not become ready on port ${port}: ${logs}`);
}

test("supported tunnel-client version floor", () => {
  assert.equal(tunnelClientSupported("tunnel-client version v0.0.21"), true);
  assert.equal(
    tunnelClientSupported(
      "0.0.21+714f2d67844b660af25754f1d19b0360b346b13b (git sha: 714f2d67844b660af25754f1d19b0360b346b13b)"
    ),
    true
  );
  assert.equal(tunnelClientSupported("tunnel-client version 0.1.0"), true);
  assert.equal(tunnelClientSupported("tunnel-client version 0.0.20"), false);
  assert.equal(
    tunnelClientSupported("0.0.20+714f2d67844b660af25754f1d19b0360b346b13b"),
    false
  );
  assert.equal(tunnelClientSupported("0.0.21-rc.1"), false);
  assert.equal(tunnelClientSupported("unknown"), false);
});

test(
  "pinned Supergateway and actual AutoDev filesystem server enforce external grants over authenticated Streamable HTTP",
  {
    skip: process.env.AUTODEV_TEST_SUPERGATEWAY !== "1",
    timeout: 180_000
  },
  async () => {
    const root = realpathSync(
      mkdtempSync(path.join(tmpdir(), "autodev-supergateway-"))
    );
    const workspace = path.join(root, "workspace");
    const client = new Client({
      name: "autodev-supergateway-test",
      version: "1.0.0"
    });
    const secondClient = new Client({
      name: "autodev-supergateway-test-2",
      version: "1.0.0"
    });
    const environment = chatgptSupergatewayEnvironment(
      {
        home: root,
        codexHome: path.join(root, ".codex"),
        repositoryRoot: repository
      },
      workspace,
      process.execPath,
      process.env.PATH ?? "/usr/bin:/bin",
      { role: "explorer" }
    );
    let gateway: ChildProcess | undefined;
    try {
      mkdirSync(workspace);
      const inside = path.join(workspace, "inside.txt");
      const outside = path.join(root, "outside.txt");
      const secretEnvironment = path.join(workspace, ".env");
      const exampleEnvironment = path.join(workspace, ".env.example");
      writeFileSync(inside, "expected-value");
      writeFileSync(outside, "outside-value");
      writeFileSync(secretEnvironment, "OPENAI_ADMIN_KEY=super-secret-value\n");
      writeFileSync(exampleEnvironment, "OPENAI_ADMIN_KEY=\n");
      symlinkSync(outside, path.join(workspace, "escape.txt"));
      const executable = resolveSupergateway(path.join(repository, "runtime", "src"));
      const config = path.join(root, "supergateway.json");
      const keyFile = path.join(root, "supergateway.key");
      const localToken = "fixture-supergateway-token";
      privateWrite(keyFile, localToken + "\n");
      const mcpPort = await allocateLoopbackPort();
      const catalogue = {
        filesystem: {
          command: process.execPath,
          args: [path.join(repository, "runtime/src/mcp/launcher.ts"), "filesystem"]
        }
      };
      const policy = {
        filesystem: ["read_text_file", "list_allowed_directories"]
      };
      writeFileSync(
        config,
        renderGatewayConfig(
          path.dirname(config),
          catalogue,
          [{ role: "orchestrator", grants: policy, reviewed: policy }],
          workspace,
          { port: mcpPort, apiKeyFile: keyFile },
          (server) =>
            externalMcpBackend(
              server,
              repository,
              workspace,
              process.execPath,
              root,
              path.join(root, ".codex"),
              { role: "explorer", readOnly: true }
            )
        )
      );
      gateway = await startSupergatewayServer(
        executable,
        config,
        workspace,
        environment,
        mcpPort
      );
      const endpoint = new URL(`http://127.0.0.1:${mcpPort}/orchestrator/mcp`);
      const unauth = await fetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {}
        })
      });
      assert.equal(unauth.status, 401);

      const authHeaders = { Authorization: `Bearer ${localToken}` };
      const transportA = new StreamableHTTPClientTransport(endpoint, {
        requestInit: { headers: authHeaders }
      });
      const transportB = new StreamableHTTPClientTransport(endpoint, {
        requestInit: { headers: authHeaders }
      });
      await client.connect(transportA);
      await secondClient.connect(transportB);
      assert.ok(transportA.sessionId);
      assert.ok(transportB.sessionId);
      assert.notEqual(transportA.sessionId, transportB.sessionId);

      const tools = await client.listTools();
      assert.deepEqual(tools.tools.map((tool) => tool.name).sort(), [
        "filesystem__list_allowed_directories",
        "filesystem__read_text_file"
      ]);
      assert.ok(
        tools.tools.every(
          (tool) =>
            tool.annotations?.readOnlyHint === true &&
            tool.annotations.destructiveHint === false
        )
      );
      const [read, readSecond] = await Promise.all([
        client.callTool({
          name: "filesystem__read_text_file",
          arguments: { path: inside }
        }),
        secondClient.callTool({
          name: "filesystem__read_text_file",
          arguments: { path: inside }
        })
      ]);
      assert.match(JSON.stringify(read), /expected-value/);
      assert.match(JSON.stringify(readSecond), /expected-value/);
      const readExample = await client.callTool({
        name: "filesystem__read_text_file",
        arguments: { path: exampleEnvironment }
      });
      assert.match(JSON.stringify(readExample), /OPENAI_ADMIN_KEY=/);
      for (const target of [
        outside,
        path.join(workspace, "escape.txt"),
        secretEnvironment
      ]) {
        const response = await client.callTool({
          name: "filesystem__read_text_file",
          arguments: { path: target }
        });
        assert.equal(response.isError, true);
        assert.doesNotMatch(
          JSON.stringify(response),
          /outside-value|super-secret-value/
        );
      }
      await assert.rejects(async () => {
        const result = await client.callTool({
          name: "filesystem__write_file",
          arguments: { path: inside, content: "modified" }
        });
        if (result.isError) throw new Error("tool denied");
      });
      assert.equal(readFileSync(inside, "utf8"), "expected-value");
      await Promise.all([client.close(), secondClient.close()]);
      // The same exact inventory check used by the installer must succeed.
      await probeSupergateway(executable, config, environment);
    } finally {
      await Promise.allSettled([client.close(), secondClient.close()]);
      await stopProcess(gateway);
      rmSync(root, { recursive: true, force: true });
    }
  }
);

test("dependency setup excludes both OpenAI credentials", () => {
  assert.deepEqual(
    dependencyEnvironment({
      HOME: "/home/test",
      PATH: "/bin",
      OPENAI_ADMIN_KEY: "test",
      AUTODEV_CHATGPT_TUNNEL_API_KEY: "test",
      OPENAI_API_KEY: "test"
    }),
    { HOME: "/home/test", PATH: "/bin" }
  );
});
test("MCP probe executes when started through the installed source symlink", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "autodev-probe-link-"));
  try {
    const link = path.join(directory, "probe.ts");
    symlinkSync(
      path.join(repository, "runtime/src/mcp/chatgpt-supergateway-probe.ts"),
      link
    );
    const result = spawnSync(process.execPath, [link], { encoding: "utf8" });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Expected Supergateway executable and config/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("role-aware sandbox admits canonical AutoDev local MCP backends and enforces role read-only vs writable confinement", () => {
  const roFs = externalMcpBackend(
    "filesystem",
    repository,
    repository,
    process.execPath,
    undefined,
    undefined,
    { role: "explorer" }
  );
  assert.equal(roFs.command, "/usr/bin/sandbox-exec");
  assert.ok(roFs.args.includes("--read-only"));
  assert.doesNotMatch(roFs.args[1]!, /\(allow file-write\*/);

  const rwFs = externalMcpBackend(
    "filesystem",
    repository,
    repository,
    process.execPath,
    undefined,
    undefined,
    { role: "orchestrator" }
  );
  assert.equal(rwFs.command, "/usr/bin/sandbox-exec");
  assert.ok(!rwFs.args.includes("--read-only"));
  assert.match(rwFs.args[1]!, /\(allow file-write\*/);

  const lspRo = externalMcpBackend(
    "lsp",
    repository,
    repository,
    process.execPath,
    undefined,
    undefined,
    { role: "explorer" }
  );
  assert.equal(lspRo.command, "/usr/bin/sandbox-exec");
  assert.match(lspRo.args[1]!, /\(allow signal \(target same-sandbox\)\)/);
  assert.doesNotMatch(lspRo.args[1]!, /\(allow ipc-sysv\*\)/);
  // Code tools never read the gateway's bearer key or the tunnel profile.
  const deniedReads =
    /\(deny file-read\* ([^\n]*)\)/u.exec(lspRo.args[1]!)?.[1] ?? "";
  assert.match(deniedReads, /\/mcp-gateway"\)/u);
  assert.match(deniedReads, /\/chatgpt-tunnel"\)/u);

  const cccBackend = externalMcpBackend(
    "cocoindex-code",
    repository,
    repository,
    process.execPath
  );
  assert.equal(cccBackend.command, "/usr/bin/sandbox-exec");
  assert.match(cccBackend.args[1]!, /\(allow signal \(target same-sandbox\)\)/);
  assert.match(cccBackend.args[1]!, /\(allow ipc-posix\*\)/);
  assert.match(cccBackend.args[1]!, /\(allow ipc-sysv\*\)/);

  const xacpxBackend = externalMcpBackend(
    "xacpx",
    repository,
    repository,
    process.execPath,
    undefined,
    undefined,
    { role: "orchestrator" }
  );
  assert.equal(xacpxBackend.command, "/usr/bin/sandbox-exec");
  assert.match(
    xacpxBackend.args[1]!,
    /\(allow network\* \(remote unix-socket\)\)/
  );

  for (const canonical of [
    "filesystem",
    "codegraphcontext",
    "playwright",
    "github"
  ]) {
    const backend = externalMcpBackend(canonical, repository, repository, process.execPath);
    assert.ok(backend.command.length > 0);
  }
  // A Playtesting run's server is bound to that run by the Runtime, never a
  // gateway backend.
  for (const unconfined of ["codex_app", "playtest"])
    assert.throws(
      () => externalMcpBackend(unconfined, repository, repository, process.execPath),
      /No externally confined/
    );
});

test("externalMcpBackend runs backends from the Runtime tree it is given, not the caller's checkout", () => {
  // The installer runs from the editable checkout; the gateway it renders must
  // run the installed tree. A tree is a `src` link to a generation, as
  // installed: backends pin the generation's physical launcher.
  const root = realpathSync(
    mkdtempSync(path.join(tmpdir(), "autodev-runtime-tree-"))
  );
  try {
    const generation = path.join(root, ".src-0000000000000000");
    const packageDirectory = path.join(
      generation,
      "node_modules",
      "@modelcontextprotocol",
      "server-filesystem"
    );
    mkdirSync(path.join(generation, "mcp"), { recursive: true });
    mkdirSync(path.join(packageDirectory, "dist"), { recursive: true });
    writeFileSync(path.join(generation, "mcp", "launcher.ts"), "");
    writeFileSync(
      path.join(packageDirectory, "package.json"),
      JSON.stringify({ bin: { "mcp-server-filesystem": "dist/index.js" } })
    );
    writeFileSync(path.join(packageDirectory, "dist", "index.js"), "");
    const runtimeSource = path.join(root, "src");
    symlinkSync(generation, runtimeSource);

    for (const server of ["commands", "lsp", "xacpx", "github"]) {
      const backend = externalMcpBackend(
        server,
        repository,
        repository,
        process.execPath,
        undefined,
        undefined,
        { runtimeSource }
      );
      assert.ok(
        backend.args.includes(path.join(generation, "mcp", "launcher.ts")),
        server
      );
      assert.ok(
        backend.args.every((argument) =>
          !argument.startsWith(path.join(repository, "runtime") + path.sep)
        ),
        server
      );
    }
    const filesystem = externalMcpBackend(
      "filesystem",
      repository,
      repository,
      process.execPath,
      undefined,
      undefined,
      { runtimeSource }
    );
    assert.ok(
      filesystem.args.includes(path.join(packageDirectory, "dist", "index.js"))
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("externalMcpBackend resolves wrapper Node shims to the direct Node binary for sandbox-exec", () => {
  const root = mkdtempSync(path.join(tmpdir(), "autodev-node-shim-"));
  try {
    const shim = path.join(root, "node");
    writeFileSync(
      shim,
      `#!/usr/bin/env bash\nexec ${JSON.stringify(process.execPath)} "$@"\n`,
      { mode: 0o700 }
    );
    const backend = externalMcpBackend("filesystem", repository, repository, shim);
    assert.equal(backend.command, "/usr/bin/sandbox-exec");
    assert.equal(backend.args[2], realpathSync(process.execPath));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test(
  "OS sandbox denies protected file reads and loopback network",
  { skip: process.platform !== "darwin" },
  async () => {
    const { createServer } = await import("node:net");
    const root = realpathSync(
      mkdtempSync(path.join(tmpdir(), "external-mcp-sandbox-"))
    );
    const workspace = path.join(root, "workspace");
    const nested = path.join(workspace, "console");
    mkdirSync(nested, { recursive: true });
    const protectedFile = path.join(root, "private-key");
    writeFileSync(protectedFile, "private", { mode: 0o600 });
    const outsideExample = path.join(root, ".env.example");
    writeFileSync(outsideExample, "outside-example", { mode: 0o600 });
    const inside = path.join(workspace, "inside");
    writeFileSync(inside, "inside");
    const environmentFile = path.join(workspace, ".env");
    writeFileSync(environmentFile, "SECRET=1", { mode: 0o600 });
    const environmentLocal = path.join(nested, ".env.local");
    writeFileSync(environmentLocal, "SECRET=2", { mode: 0o600 });
    const environmentExampleBak = path.join(workspace, ".env.example.bak");
    writeFileSync(environmentExampleBak, "SECRET=3", { mode: 0o600 });
    const environmentSymlink = path.join(workspace, "env-alias.txt");
    symlinkSync(environmentFile, environmentSymlink);
    const environmentExample = path.join(workspace, ".env.example");
    writeFileSync(environmentExample, "EXAMPLE=1");
    const server = createServer();
    try {
      await new Promise<void>((resolve) =>
        server.listen(0, "127.0.0.1", resolve)
      );
      const addr = server.address();
      assert.ok(addr && typeof addr !== "string");
      const node = realpathSync(process.execPath);
      const profile = filesystemSandboxProfile(
        workspace,
        realpathSync(path.join(repository, "node_modules")),
        node,
        { readOnly: true }
      );
      const result = spawnSync(
        "/usr/bin/sandbox-exec",
        [
          "-p",
          profile,
          node,
          "-e",
          [
            'const fs = require("node:fs");',
            'const net = require("node:net");',
            'if (fs.readFileSync(process.argv[1], "utf8") !== "inside") process.exit(2);',
            'if (fs.readFileSync(process.argv[2], "utf8") !== "EXAMPLE=1") process.exit(6);',
            "for (const blocked of process.argv.slice(3, -1)) {",
            "  try { fs.readFileSync(blocked); process.exit(3); } catch {}",
            "}",
            'const s = net.connect(Number(process.argv.at(-1)), "127.0.0.1");',
            's.on("connect", () => process.exit(4));',
            's.on("error", () => process.exit(0));',
            "setTimeout(() => process.exit(5), 2000);"
          ].join(" "),
          inside,
          environmentExample,
          protectedFile,
          outsideExample,
          environmentFile,
          environmentLocal,
          environmentExampleBak,
          environmentSymlink,
          String(addr.port)
        ],
        { cwd: workspace, encoding: "utf8", timeout: 10_000 }
      );
      assert.equal(result.status, 0, result.stderr);
    } finally {
      server.close();
      rmSync(root, { recursive: true, force: true });
    }
  }
);

test("credential validation, private file ownership and symlinks fail closed", () => {
  const root = mkdtempSync(path.join(tmpdir(), "external-mcp-keys-"));
  try {
    for (const key of [
      "",
      "sk-admin-test",
      "key\nsecond",
      "key with space",
      "same"
    ])
      assert.throws(
        () => validateRuntimeKey(key, "same"),
        /restricted runtime/
      );
    assert.doesNotThrow(() =>
      validateRuntimeKey("test-runtime-key", "test-admin-key")
    );
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

test("a service listener must belong to the actual launchd job or its spawned child", async () => {
  const launchd = { print: () => "\tpid = 123\n" };
  const label = "com.codex.fixture";
  let probes = 0;
  const probe = async () => {
    probes++;
    return true;
  };
  assert.equal(
    await serviceReady(launchd, label, [3311], {
      listeners: () => ["456"],
      probe,
      parentPid: () => "1"
    }),
    false
  );
  assert.equal(probes, 0);
  assert.equal(
    await serviceReady(launchd, label, [3311], {
      listeners: () => ["123", "456"],
      probe
    }),
    false
  );
  assert.equal(
    await serviceReady(launchd, label, [3311], {
      listeners: () => ["123"],
      probe
    }),
    true
  );
  assert.equal(
    await serviceReady(launchd, label, [3311], {
      listeners: () => ["456"],
      probe,
      parentPid: (pid) => (pid === "456" ? "123" : null)
    }),
    true
  );
  assert.equal(
    await serviceReady(launchd, label, [3311], {
      listeners: () => ["123"],
      probe: async () => false
    }),
    false
  );
  assert.equal(
    await serviceReady(launchd, label, [3311, 3312], {
      listeners: (target) => ([target === 3311 ? "456" : "789"]),
      probe,
      parentPid: (pid) => (pid === "456" ? "123" : "1")
    }),
    false
  );
});

test("official CLI argv, scope and sanitized authorization failure", () => {
  const root = mkdtempSync(path.join(tmpdir(), "external-mcp-cli-"));
  try {
    const cli = path.join(root, "tunnel client 'fixture'");
    writeFileSync(
      cli,
      "#!/bin/sh\n" +
        [
          'test "$1" = admin && test "$2" = --json && test "$3" = tunnels || exit 8',
          'if [ "$4" = create ]; then',
          '  test "$OPENAI_ADMIN_KEY" = test-admin && test -z "$CONTROL_PLANE_API_KEY" && test -z "$AUTODEV_CHATGPT_TUNNEL_API_KEY" || exit 9',
          '  test "$9" = --organization-id && test "${10}" = org_test && test "${11}" = --workspace-id && test "${12}" = ws_test || exit 10',
          '  printf \'{"id":"tunnel_test"}\\n\'',
          'elif [ "$4" = get ]; then',
          '  test -z "$OPENAI_ADMIN_KEY" && test -z "$AUTODEV_CHATGPT_TUNNEL_API_KEY" || exit 11',
          '  if [ "$CONTROL_PLANE_API_KEY" != test-runtime ]; then printf "HTTP 403 private-fixture-secret\\n" >&2; exit 12; fi',
          '  printf \'{"id":"tunnel_test","organization_ids":["org_test"],"workspace_ids":["ws_test"]}\\n\'',
          "else exit 13; fi"
        ].join("\n"),
      { mode: 0o700 }
    );
    assert.equal(
      createTunnel(
        cli,
        { OPENAI_ADMIN_KEY: "test-admin" },
        "org_test",
        "ws_test"
      ),
      "tunnel_test"
    );
    assert.deepEqual(
      tunnelMetadata(cli, ["get", "tunnel_test"], {
        AUTODEV_CHATGPT_TUNNEL_API_KEY: "test-runtime"
      }),
      {
        id: "tunnel_test",
        organization_ids: ["org_test"],
        workspace_ids: ["ws_test"]
      }
    );
    assert.throws(
      () =>
        tunnelMetadata(cli, ["get", "tunnel_test"], {
          AUTODEV_CHATGPT_TUNNEL_API_KEY: "bad"
        }),
      (error: unknown) =>
        error instanceof Error &&
        error.message.includes("unauthorized") &&
        !error.message.includes("private-fixture-secret")
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

const fixtureSource = String.raw`
import { createInterface } from "node:readline";
import { existsSync, appendFileSync } from "node:fs";
const [mode, marker] = process.argv.slice(2);
if (mode === "conditional" && !existsSync(marker)) process.exit(12);
const lines = createInterface({ input: process.stdin });
const send = message => process.stdout.write(JSON.stringify({jsonrpc:"2.0", ...message}) + "\n");
const reply = (id, result) => send({id, result});
const tool = name => ({name, inputSchema:{type:"object"}, annotations:{readOnlyHint:false,destructiveHint:true}});
const timers = new Map();
let changed = false;
let initialized = false;
lines.on("line", line => {
  const m = JSON.parse(line);
  if (m.method === "initialize") {
    if (initialized) return send({id:m.id, error:{code:-32600, message:"McpServerError: The session is already initialized"}});
    initialized = true;
    reply(m.id, {protocolVersion:m.params.protocolVersion, capabilities:{tools:{listChanged:true},resources:{},prompts:{}},serverInfo:{name:"fixture",version:"1"}});
  }
  else if (m.method === "ping") reply(m.id,{});
  else if (m.method === "tools/list") {
    if (m.params?.cursor === "page2") reply(m.id,{tools:[tool("image"),tool("unapproved")]});
    else reply(m.id,{tools:[tool("read"),tool("slow"),...(changed ? [tool("changed")] : [])],nextCursor:"page2"});
  } else if (m.method === "tools/call") {
    if (m.params.name === "slow") {
      timers.set(m.id, setTimeout(() => reply(m.id,{content:[{type:"text",text:"late"}]}),3000));
    } else if (m.params.name === "image") {
      reply(m.id,{content:[{type:"image",data:"aGVsbG8=",mimeType:"image/png"}],structuredContent:{value:42}});
    } else {
      reply(m.id,{content:[{type:"text",text:mode}]});
      if (m.params.arguments?.change) { changed = true; send({method:"notifications/tools/list_changed"}); }
      if (m.params.arguments?.exit) setTimeout(() => process.exit(0),30);
    }
  } else if (m.method === "notifications/cancelled") {
    const id = m.params.requestId;
    clearTimeout(timers.get(id));
    appendFileSync(marker,"cancelled\n");
    // A deliberately late reply must not satisfy any future request.
    setTimeout(() => reply(id,{content:[{type:"text",text:"late"}]}),20);
  }
});
`;

test(
  "real combined MCP protocol: pagination, images, cancellation, list changes and backend failure/recovery",
  {
    skip: process.env.AUTODEV_TEST_SUPERGATEWAY !== "1",
    timeout: 180_000
  },
  async () => {
    const root = realpathSync(
      mkdtempSync(path.join(tmpdir(), "external-mcp-fixtures-"))
    );
    const fixture = path.join(root, "fixture.mjs");
    const marker = path.join(root, "backend-marker");
    writeFileSync(fixture, fixtureSource);
    const clients: Client[] = [];
    let gateway: ChildProcess | undefined;
    try {
      const executable = resolveSupergateway(path.join(repository, "runtime", "src"));
      const config = path.join(root, "gateway.json");
      const keyFile = path.join(root, "supergateway.key");
      const localToken = "fixture-combined-token";
      privateWrite(keyFile, localToken + "\n");
      const mcpPort = await allocateLoopbackPort();
      const grants = {
        stable: ["read", "slow", "image", "changed"],
        conditional: ["read"]
      };
      const catalogue = {
        stable: {
          command: process.execPath,
          args: [fixture, "stable", marker]
        },
        conditional: {
          command: process.execPath,
          args: [fixture, "conditional", marker]
        }
      };
      writeFileSync(
        config,
        renderGatewayConfig(
          path.dirname(config),
          catalogue,
          [{ role: "orchestrator", grants: grants, reviewed: grants }],
          root,
          {
            port: mcpPort,
            apiKeyFile: keyFile
          }
        )
      );
      gateway = await startSupergatewayServer(
        executable,
        config,
        root,
        {
          HOME: root,
          PATH: process.env.PATH ?? "/usr/bin:/bin",
          CODEX_HOME: root
        },
        mcpPort
      );
      const endpoint = new URL(`http://127.0.0.1:${mcpPort}/orchestrator/mcp`);
      const connect = async () => {
        const client = new Client({
          name: "external-mcp-fixture",
          version: "1"
        });
        clients.push(client);
        await client.connect(
          new StreamableHTTPClientTransport(endpoint, {
            requestInit: { headers: { Authorization: `Bearer ${localToken}` } }
          }),
          { timeout: 20_000 }
        );
        return client;
      };
      const client = await connect();
      const names = async (current: Client) =>
        (await current.listTools({}, { timeout: 20_000 })).tools
          .map((tool) => tool.name)
          .sort();
      assert.deepEqual(await names(client), [
        "stable__image",
        "stable__read",
        "stable__slow"
      ]);
      const capabilities = client.getServerCapabilities();
      assert.equal(capabilities?.resources, undefined);
      assert.equal(capabilities?.prompts, undefined);
      const image = await client.callTool({
        name: "stable__image",
        arguments: {}
      });
      assert.deepEqual(image.content, [
        { type: "image", data: "aGVsbG8=", mimeType: "image/png" }
      ]);
      assert.deepEqual(image.structuredContent, { value: 42 });
      await assert.rejects(async () => {
        const result = await client.callTool({
          name: "stable__unapproved",
          arguments: {}
        });
        if (result.isError) throw new Error("tool denied");
      });
      const controller = new AbortController();
      const call = client.callTool(
        { name: "stable__slow", arguments: {} },
        undefined,
        { signal: controller.signal }
      );
      const cancelled = assert.rejects(call);
      await delay(100);
      controller.abort();
      await cancelled;
      for (let attempt = 0; attempt < 30 && !readFileExists(marker); attempt++)
        await delay(100);
      assert.match(readFileSync(marker, "utf8"), /cancelled/);
      assert.match(
        JSON.stringify(
          await client.callTool({ name: "stable__read", arguments: {} })
        ),
        /stable/
      );
      let notify!: () => void;
      const notification = new Promise<void>((resolve) => {
        notify = resolve;
      });
      client.setNotificationHandler(
        ToolListChangedNotificationSchema,
        async () => {
          notify();
        }
      );
      await client.callTool({
        name: "stable__read",
        arguments: { change: true }
      });
      await Promise.race([
        notification,
        delay(5000).then(() => {
          throw new Error("Missing tools/list_changed");
        })
      ]);
      const overlapping = await Promise.all([names(client), names(client)]);
      assert.ok(overlapping.every((list) => list.includes("stable__changed")));
      // A fresh session shares the pooled backends, so it sees the changed
      // tool list; the formerly unavailable backend now recovers for it, while
      // the original session's membership is unchanged.
      const recovered = await connect();
      assert.deepEqual(await names(recovered), [
        "conditional__read",
        "stable__changed",
        "stable__image",
        "stable__read",
        "stable__slow"
      ]);
      assert.ok(!(await names(client)).includes("conditional__read"));
      await recovered.callTool({
        name: "stable__read",
        arguments: { exit: true }
      });
      // The pool replaces a backend that exits: the session keeps serving
      // its tools from a fresh process, which starts without the change.
      for (let attempt = 0; attempt < 30; attempt++) {
        if (!(await names(recovered)).includes("stable__changed")) break;
        await delay(100);
      }
      assert.deepEqual(await names(recovered), [
        "conditional__read",
        "stable__image",
        "stable__read",
        "stable__slow"
      ]);
      assert.match(
        JSON.stringify(
          await recovered.callTool({ name: "stable__read", arguments: {} })
        ),
        /stable/
      );
      assert.match(
        JSON.stringify(
          await recovered.callTool({ name: "conditional__read", arguments: {} })
        ),
        /conditional/
      );
    } finally {
      await Promise.allSettled(clients.map((client) => client.close()));
      await stopProcess(gateway);
      rmSync(root, { recursive: true, force: true });
    }
  }
);

function readFileExists(file: string): boolean {
  try {
    readFileSync(file);
    return true;
  } catch {
    return false;
  }
}

test(
  "external tool traces use the actual OTLP HTTP exporter and omit payloads",
  { timeout: 20_000 },
  async () => {
    const {
      configureExternalMcpTelemetry,
      recordToolCallSpan,
      shutdownTelemetry,
      shutdownTelemetryForTest
    } = await import("../src/mcp/mcp-telemetry.ts");
    // Earlier tests run backend pools in this process, and a pool initializes
    // the process-wide tracer; this test owns a fresh one.
    await shutdownTelemetryForTest();
    const observed: { body: string; authorization?: string }[] = [];
    const receiver = createHttpServer((request, response) => {
      let body = "";
      request.setEncoding("utf8");
      request.on("data", (chunk) => {
        body += chunk;
      });
      request.on("end", () => {
        observed.push({
          body,
          ...(request.headers.authorization && { authorization: request.headers.authorization })
        });
        response.setHeader("content-type", "application/json");
        response.end("{}");
      });
    });
    try {
      receiver.listen(0, "127.0.0.1");
      await once(receiver, "listening");
      const addr = receiver.address();
      assert.ok(addr && typeof addr !== "string");
      configureExternalMcpTelemetry(
        "filesystem",
        "http://127.0.0.1:" + addr.port + "/v1/traces",
        { Authorization: "Bearer fixture-collector-token" }
      );
      await recordToolCallSpan(
        "read_text_file",
        async () => ({ status: "ok" }),
        { unapproved: "private-fixture-arguments" }
      );
      await recordToolCallSpan("read_text_file", async () => ({
        status: "error",
        errorType: "cancelled"
      }));
      await shutdownTelemetry();
      assert.ok(observed.length > 0);
      assert.ok(
        observed.every(
          (entry) => entry.authorization === "Bearer fixture-collector-token"
        )
      );
      const payload = observed.map((entry) => entry.body).join("\n");
      for (const expected of [
        "autodev-chatgpt-mcp",
        "filesystem",
        "read_text_file",
        "cancelled"
      ])
        assert.ok(payload.includes(expected));
      assert.ok(
        !payload.includes("fixture-collector-token") &&
          !payload.includes("private-fixture-arguments")
      );
    } finally {
      await shutdownTelemetryForTest();
      receiver.close();
    }
  }
);

test("verified metadata must match the exact intended tunnel and scope", () => {
  const valid = {
    id: "tunnel_one",
    organization_ids: ["org_one"],
    workspace_ids: ["ws_one"]
  };
  assert.doesNotThrow(() =>
    assertTunnelScope(valid, "tunnel_one", "org_one", "ws_one")
  );
  for (const metadata of [
    { ...valid, id: "tunnel_two" },
    { ...valid, workspace_ids: ["ws_two"] },
    { ...valid, organization_ids: ["org_one", "org_other"] }
  ])
    assert.throws(
      () => assertTunnelScope(metadata, "tunnel_one", "org_one", "ws_one"),
      /does not belong/
    );
});
test("tunnelClientMcpEnv references private auth header file without exposing secrets", () => {
  const headerFile = "/tmp/autodev-test/generation-1/supergateway-auth.header";
  assert.deepEqual(tunnelClientMcpEnvironment(headerFile), {
    MCP_OAUTH_DISCOVERY: "disabled",
    MCP_EXTRA_HEADERS: `Authorization: file:${headerFile}`,
    MCP_DISCOVERY_EXTRA_HEADERS: `Authorization: file:${headerFile}`
  });
});

test("a failing command's own report reaches the installer instead of being discarded", () => {
  // `tunnel-client doctor` writes its check report to stdout, so an installer
  // that only kept stderr would leave the operator with a stage name and no
  // reason.
  const report = [
    "CHECK config_source            PASS profile file: /tmp/autodev.yaml",
    "CHECK mcp_target               FAIL main channel is required; add channel=main to one --mcp.server-url or --mcp.command entry",
    "RESULT fail"
  ].join("\n");
  let failure: unknown;
  try {
    execFileSync(
      process.execPath,
      [
        "-e",
        `process.stdout.write(${JSON.stringify(report)}); process.exit(2)`
      ],
      { stdio: ["ignore", "pipe", "pipe"] }
    );
  } catch (error) {
    failure = error;
  }
  assert.ok(failure, "the fixture command must fail");
  const detail = commandFailureReport("tunnel-client", ["doctor"], failure);
  assert.match(detail, /exit 2/u);
  assert.match(detail, /main channel is required/u);
});

test("published roles map onto tunnel channels that keep the required main channel", () => {
  // tunnel-client refuses to validate or start a tunnel whose MCP targets
  // carry no `main` channel, so the primary role has to be published there.
  assert.deepEqual(chatgptTunnelChannels(["orchestrator"]), [
    { role: "orchestrator", channel: "main" }
  ]);
  assert.deepEqual(chatgptTunnelChannels(["orchestrator", "explorer"]), [
    { role: "orchestrator", channel: "main" },
    { role: "explorer", channel: "explorer" }
  ]);
  // A role name that is not a usable channel name is spelled out instead.
  assert.deepEqual(chatgptTunnelChannels(["orchestrator", "role.with.dots"]), [
    { role: "orchestrator", channel: "main" },
    { role: "role.with.dots", channel: "role-with-dots" }
  ]);
  // Two roles that would claim one channel are a configuration error, never a
  // silently dropped route.
  assert.throws(
    () => chatgptTunnelChannels(["orchestrator", "a-b", "a.b"]),
    /share the tunnel channel/u
  );
});

/*
A launchd double that tracks each label's job independently, and the mocked
dependencies the gateway and tunnel installers share.
*/
function serviceFixture(root: string) {
  const home = path.join(root, "home");
  const codexHome = path.join(home, ".codex");
  const workspace = path.join(home, "project");
  const paths = { home, codexHome, repositoryRoot: repository };
  const events: string[] = [];
  const running = new Set<string>();
  const failReady = new Set<string>();
  const launchd = {
    isLoaded: (label: string) => running.has(label),
    print: () => "pid = 123",
    bootout: (label: string) => {
      events.push(`stop ${label}`);
      running.delete(label);
    },
    disable: (label: string) => {
      events.push(`disable ${label}`);
    },
    enable: (label: string) => {
      events.push(`enable ${label}`);
    },
    bootstrap: (plist: string) => {
      const label = path.basename(plist, ".plist");
      events.push(`start ${label}`);
      running.add(label);
    }
  };
  const gatewayDependencies: McpGatewayDependencies = {
    platform: "darwin",
    launchd: () => launchd,
    node: () => process.execPath,
    supergateway: () => "/fixture/supergateway",
    backend: () => ({ command: "/fixture/filesystem", args: [] }),
    hasSecret: (name) => name === "CONTEXT7_API_KEY",
    discoverTools: async (
      server,
      _descriptor,
      _paths,
      _workspace,
      _node,
      environment
    ) =>
      server === "commands"
        ? [...(roleContract(environment.AUTODEV_AGENT_ROLE!).mcpTools?.commands ?? [])]
        : server === "filesystem"
          ? [
              "read_text_file",
              "write_file",
              "edit_file",
              "list_allowed_directories"
            ]
          : server === "lsp"
            ? ["lsp_find_symbol", "lsp_workspace_diagnostics"]
            : server === "xacpx"
              ? ["delegate_request", "task_get", "task_list", "task_cancel"]
              : server === "openaiDeveloperDocs"
                ? ["search_openai_docs", "list_openai_docs"]
                : server === "context7"
                  ? ["resolve-library-id", "query-docs"]
                  : [],
    launchValues: () => ({
      ...paths,
      nodeBin: process.execPath,
      codexBin: "",
      consolePort: "3300"
    }),
    ready: async (_job, label, port) => {
      assert.equal(
        port,
        label === MCP_GATEWAY_LABEL ? 3312 : 3311,
        `${label} readiness port`
      );
      return running.has(label) && !failReady.has(label);
    },
    portFree: () => true,
    wait: async ({ probe }) => probe(),
    run: (command, arguments_) => {
      events.push(
        `${path.basename(command)} ${arguments_.at(-1) === "--checkConfig" ? "checkConfig" : (arguments_[0] ?? "")}`
      );
    }
  };
  mkdirSync(workspace, { recursive: true });
  // The services run from the installed Runtime generation `$CODEX_HOME/src`
  // resolves to.
  mkdirSync(codexHome, { recursive: true });
  symlinkSync(path.join(repository, "runtime", "src"), path.join(codexHome, "src"));
  mkdirSync(path.join(codexHome, "provider-runtime"), { recursive: true });
  writeFileSync(
    path.join(codexHome, "provider-runtime", "mcp-servers.json"),
    JSON.stringify({
      filesystem: { command: "/fixture/filesystem", args: [] },
      lsp: { command: "/fixture/lsp", args: [] },
      "cocoindex-code": { command: "/fixture/ccc", args: [] },
      codegraphcontext: { command: "/fixture/cgc", args: [] },
      xacpx: { command: "/fixture/xacpx", args: [] },
      commands: { command: "/fixture/commands", args: [] },
      playwright: { command: "/fixture/playwright", args: [] },
      openaiDeveloperDocs: { url: "https://example.test/openai/mcp" },
      context7: {
        url: "https://example.test/context7/mcp",
        bearer_token_env_var: "CONTEXT7_API_KEY"
      },
      googleDeveloperKnowledge: {
        url: "https://example.test/google/mcp",
        http_headers: {
          "X-Goog-Api-Key": "${GOOGLE_DEVELOPER_KNOWLEDGE_API_KEY}"
        }
      }
    })
  );
  return {
    home,
    codexHome,
    workspace,
    paths,
    events,
    running,
    failReady,
    gatewayDeps: gatewayDependencies
  };
}

/*
A spawned-process double that exits cleanly once it is told to stop, or at
once when `exitImmediately` names its command.
*/
function fakeSpawner(exitImmediately: string) {
  const seen: Array<{
    cmd: string;
    args: string[];
    env: NodeJS.ProcessEnv;
    cwd: string | undefined;
  }> = [];
  const spawnProcess = ((
    command: string,
    arguments_: string[],
    options: { env: NodeJS.ProcessEnv; cwd?: string }
  ) => {
    seen.push({ cmd: command, args: arguments_, env: options.env, cwd: options.cwd });
    const listeners = new Map<string, Array<(code: number | null) => void>>();
    const proc = {
      exitCode: null as number | null,
      signalCode: null as string | null,
      kill: () => {
        queueMicrotask(() => {
          proc.exitCode = 0;
          for (const callback of listeners.get("exit") ?? []) callback(0);
        });
        return true;
      },
      once: (event: string, callback: (code: number | null) => void) => {
        listeners.set(event, [...(listeners.get(event) ?? []), callback]);
        if (event === "exit" && command === exitImmediately)
          queueMicrotask(() => {
            proc.exitCode = 0;
            callback(0);
          });
      }
    };
    return proc;
  }) as unknown as typeof spawn;
  return { seen, spawnProcess };
}

test(
  "the MCP gateway service reviews role surfaces, reconciles idempotently, and runs without the tunnel",
  { timeout: 30_000 },
  async () => {
    const root = realpathSync(
      mkdtempSync(path.join(tmpdir(), "mcp-gateway-install-"))
    );
    try {
      const { codexHome, workspace, paths, events, running, gatewayDeps } =
        serviceFixture(root);
      const directory = path.join(codexHome, "mcp-gateway");
      const stateFile = path.join(directory, "gateway.json");
      const plistFile = path.join(
        paths.home,
        "Library",
        "LaunchAgents",
        `${MCP_GATEWAY_LABEL}.plist`
      );
      const environment = {
        HOME: paths.home,
        PATH: "/bin",
        AUTODEV_MCP_GATEWAY_WORKSPACE: workspace
      };
      const first = await ensureMcpGateway(paths, environment, undefined, gatewayDeps);
      assert.equal(first.mcpPort, 3312);
      assert.equal(first.workspace, workspace);
      assert.equal(first.role, "orchestrator");
      assert.deepEqual(first.roles, ["orchestrator"]);
      assert.ok(running.has(MCP_GATEWAY_LABEL));
      assert.deepEqual(
        events.filter((event) => !event.startsWith("enable")),
        [
          "supergateway checkConfig",
          `${path.basename(process.execPath)} ${path.join(codexHome, "src/mcp/chatgpt-supergateway-probe.ts")}`,
          `stop ${MCP_GATEWAY_LABEL}`,
          `start ${MCP_GATEWAY_LABEL}`
        ]
      );
      // The gateway owns one stable bearer key at its directory's root, so a
      // regeneration never invalidates the header file its clients hold.
      const key = privateRead(path.join(directory, "supergateway.key"));
      assert.match(key, /^[a-f0-9]{64}$/u);
      assert.equal(
        privateRead(path.join(directory, "supergateway-auth.header")),
        `Bearer ${key}`
      );
      const config = JSON.parse(
        privateRead(path.join(directory, first.generation, "supergateway.json"))
      );
      assert.equal(config.port, 3312);
      assert.equal(
        config.mcpServers.orchestrator.apiKeyFile.replaceAll("$$", "$"),
        path.join(directory, "supergateway.key")
      );
      const poolManifest = JSON.parse(
        privateRead(path.join(directory, first.generation, "backend-pool.json"))
      );
      // Every role with MCP grants also gets a surface per server for local
      // clients, locked by a local-only key the tunnel never holds and served
      // in whatever workspace each session grant names.
      const localKey = privateRead(path.join(directory, "local.key"));
      assert.match(localKey, /^[a-f0-9]{64}$/u);
      assert.notEqual(localKey, key);
      assert.match(
        privateRead(path.join(directory, "admission.key")),
        /^[a-f0-9]{64}$/u
      );
      const workerFilesystem = config.mcpServers["local-worker-filesystem"];
      assert.equal(workerFilesystem.path, "/local/worker/filesystem");
      assert.equal(
        workerFilesystem.apiKeyFile.replaceAll("$$", "$"),
        path.join(directory, "local.key")
      );
      assert.match(workerFilesystem.url, /\/mcp\/local\.worker\.filesystem$/u);
      assert.deepEqual(
        { ...poolManifest.servers["local.worker.filesystem"], tools: [] },
        { kind: "admitted", role: "worker", server: "filesystem", tools: [] }
      );
      assert.equal(
        config.mcpServers["local-explorer-xacpx"],
        undefined,
        "a leaf role never gets delegation"
      );
      // The LaunchAgent runs the gateway from the resolved Runtime generation,
      // with interactive QoS for its sandboxed MCP children.
      const plist = readFileSync(plistFile, "utf8");
      assert.ok(
        plist.includes(
          path.join(
            repository,
            "runtime",
            "src",
            "platform",
            "mcp-gateway-service.ts"
          )
        )
      );
      assert.match(
        plist,
        /<key>ProcessType<\/key>\s*<string>Interactive<\/string>/u
      );
      assert.deepEqual(Object.keys(first.grants).sort(), [
        "cocoindex-code",
        "codegraphcontext",
        "filesystem",
        "lsp",
        "xacpx"
      ]);
      assert.ok(first.grants.filesystem!.includes("write_file"));
      assert.ok(first.grants.xacpx!.includes("delegate_request"));
      assert.match(first.policyFile, /\.rulesync\/permissions\.jsonc$/u);
      assert.equal(await checkMcpGateway(paths, gatewayDeps), true);

      // A second reconcile with an unchanged policy restarts nothing.
      const count = events.length;
      const unchanged = privateRead(stateFile);
      await ensureMcpGateway(
        paths,
        { HOME: paths.home, PATH: "/bin" },
        undefined,
        gatewayDeps
      );
      assert.equal(events.length, count);
      assert.equal(privateRead(stateFile), unchanged);

      // The Commands MCP refuses to start without an approved catalogue in
      // the Runtime home it runs from, so until the operator approves one it
      // is left out of the gateway rather than failing its preflight. An
      // approval is a policy input: it re-reviews the grants.
      const approvedHomes: string[] = [];
      const approved = await ensureMcpGateway(
        paths,
        { HOME: paths.home },
        undefined,
        {
          ...gatewayDeps,
          commandCatalogue: (runtimeHome) => {
            approvedHomes.push(runtimeHome);
            return "sha256:approved-fixture";
          }
        }
      );
      assert.deepEqual([...new Set(approvedHomes)], [codexHome]);
      assert.notEqual(approved.policyDigest, first.policyDigest);
      // Once approved, the gateway grants the orchestrator role's canonical
      // Commands tools exactly as the execution contract declares them.
      assert.deepEqual(
        approved.grants.commands,
        roleContract("orchestrator").mcpTools?.commands
      );
      // The new generation replaces the old one.
      assert.ok(!existsSync(path.join(directory, first.generation)));

      // While the checkout proposes a catalogue revision the operator has not
      // approved, the role contract can name commands the approved revision
      // lacks. The gateway grants only what the Commands backend serves, so
      // its preflight matches the backend instead of failing the install.
      const pending = await ensureMcpGateway(
        paths,
        { HOME: paths.home },
        undefined,
        {
          ...gatewayDeps,
          commandCatalogue: () => "sha256:previously-approved-fixture",
          discoverTools: async (server, ...rest) =>
            server === "commands"
              ? ["git_status", "test", "not_in_role_contract"]
              : gatewayDeps.discoverTools!(server, ...rest)
        }
      );
      assert.deepEqual(pending.grants.commands, ["git_status", "test"]);

      // Switching to the `smart` role (googleDeveloperKnowledge and playwright,
      // no xacpx) with GOOGLE_DEVELOPER_KNOWLEDGE_API_KEY available admits the
      // exact smart-role MCP servers.
      const smart = await ensureMcpGateway(
        paths,
        { HOME: paths.home, AUTODEV_MCP_GATEWAY_ROLE: "smart" },
        undefined,
        {
          ...gatewayDeps,
          hasSecret: (name) =>
            name === "CONTEXT7_API_KEY" ||
            name === "GOOGLE_DEVELOPER_KNOWLEDGE_API_KEY",
          discoverTools: async (server, ...rest) =>
            server === "googleDeveloperKnowledge"
              ? ["search_documents", "get_documents", "answer_query"]
              : gatewayDeps.discoverTools!(server, ...rest)
        }
      );
      assert.equal(smart.role, "smart");
      assert.equal(smart.grants.xacpx, undefined);
      assert.deepEqual(smart.grants.googleDeveloperKnowledge, [
        "search_documents",
        "get_documents",
        "answer_query"
      ]);
      const smartConfig = JSON.parse(
        privateRead(path.join(directory, smart.generation, "supergateway.json"))
      );
      assert.equal(
        smartConfig.mcpServers.smart.sessionTimeout,
        DEFAULT_CHATGPT_SESSION_TIMEOUT_MS
      );
      // The key survives regeneration.
      assert.equal(privateRead(path.join(directory, "supergateway.key")), key);

      // A failed candidate leaves the previous service running.
      const before = readFileSync(plistFile, "utf8");
      await assert.rejects(
        ensureMcpGateway(
          paths,
          { HOME: paths.home, AUTODEV_MCP_GATEWAY_ROLE: "orchestrator" },
          undefined,
          {
            ...gatewayDeps,
            run: (command, arguments_, options) => {
              if (arguments_.at(-1) === "--checkConfig")
                throw new Error("fixture config rejected");
              gatewayDeps.run(command, arguments_, options);
            }
          }
        ),
        /MCP gateway setup failed \(supergateway config check\): fixture config rejected; previous service configuration retained/u
      );
      assert.equal(readFileSync(plistFile, "utf8"), before);
      assert.equal(readMcpGatewayState(codexHome)?.role, "smart");

      // The daemon runs the backend pool in-process and Supergateway with the
      // pool's address and token but no tunnel credential.
      const { seen, spawnProcess } = fakeSpawner("/fixture/supergateway");
      assert.equal(
        await runMcpGatewayDaemon(
          paths,
          {
            HOME: paths.home,
            AUTODEV_CHATGPT_TUNNEL_API_KEY: "never-forwarded"
          },
          { spawnProcess, backend: gatewayDeps.backend }
        ),
        1,
        "an unexpected Supergateway exit fails the job so launchd restarts it"
      );
      assert.equal(seen[0]?.cmd, "/fixture/supergateway");
      assert.equal(
        seen[0]?.args[1],
        path.join(directory, smart.generation, "supergateway.json")
      );
      assert.equal(seen[0]?.cwd, workspace);
      assert.ok(seen[0]?.env[CHATGPT_MCP_POOL_PORT_ENV]);
      assert.ok(seen[0]?.env[CHATGPT_MCP_POOL_TOKEN_ENV]);
      assert.equal(seen[0]?.env.AUTODEV_CHATGPT_TUNNEL_API_KEY, undefined);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
);

test(
  "gateway rediscovery follows Runtime generation and workspace without widening explicit grants",
  { timeout: 30_000 },
  async () => {
    const root = realpathSync(
      mkdtempSync(path.join(tmpdir(), "mcp-gateway-discovery-"))
    );
    try {
      const { codexHome, workspace, paths, gatewayDeps, events } =
        serviceFixture(root);
      const environment = { HOME: paths.home };
      const link = path.join(codexHome, "src");
      const selectGeneration = (id: string) => {
        const generation = path.join(codexHome, ".src-" + id);
        mkdirSync(generation, { recursive: true });
        rmSync(link);
        symlinkSync(generation, link);
      };
      let xacpxTools: string[] = [];
      let xacpxDiscoveries = 0;
      const commandRoles = new Set<string>();
      const dependencies: McpGatewayDependencies = {
        ...gatewayDeps,
        commandCatalogue: () => "sha256:approved-fixture",
        discoverTools: async (server, ...rest) => {
          if (server === "xacpx") {
            xacpxDiscoveries += 1;
            return xacpxTools;
          }
          if (server === "commands") {
            const role = rest[4].AUTODEV_AGENT_ROLE!;
            commandRoles.add(role);
          }
          return gatewayDeps.discoverTools!(server, ...rest);
        }
      };
      const reconcile = () =>
        ensureMcpGateway(paths, environment, undefined, dependencies);
      // A fresh install cannot publish a supposedly healthy orchestrator
      // with no delegation surface.
      await assert.rejects(
        reconcile(),
        /required XACPX delegation inventory is empty/u
      );
      assert.equal(readMcpGatewayState(codexHome), undefined);
      assert.equal(events.length, 0);

      xacpxTools = ["delegate_request", "task_watch"];
      const initial = await reconcile();
      assert.deepEqual(initial.reviewed.xacpx, xacpxTools);
      assert.ok(commandRoles.has("orchestrator"));
      assert.ok(commandRoles.has("validator"));
      assert.ok(commandRoles.has("worker"));
      const discoveries = xacpxDiscoveries;
      await reconcile();
      assert.equal(xacpxDiscoveries, discoveries, "unchanged context is cached");

      // Model an already-installed degraded review, with the same policy
      // digest. It must not qualify as ready or be reused on reconciliation.
      const stateFile = path.join(codexHome, "mcp-gateway", "gateway.json");
      const degradedReviewed = { ...initial.reviewed };
      const degradedGrants = { ...initial.grants };
      delete degradedReviewed.xacpx;
      delete degradedGrants.xacpx;
      const degraded = {
        ...initial,
        reviewed: degradedReviewed,
        grants: degradedGrants
      };
      privateWrite(stateFile, JSON.stringify(degraded) + "\n");
      assert.equal(await checkMcpGateway(paths, dependencies), false);
      const beforeFailure = events.length;
      xacpxTools = [];
      await assert.rejects(
        reconcile(),
        /required XACPX delegation inventory is empty/u
      );
      assert.equal(events.length, beforeFailure);
      assert.deepEqual(readMcpGatewayState(codexHome), degraded);

      // Recovery needs no policy, workspace or generation change.
      xacpxTools = ["delegate_request", "task_watch"];
      const recovered = await reconcile();
      assert.equal(recovered.policyDigest, initial.policyDigest);
      assert.deepEqual(recovered.reviewed.xacpx, xacpxTools);
      assert.equal(await checkMcpGateway(paths, dependencies), true);

      // No policy or catalogue change: only the installed backend changes.
      selectGeneration("new");
      const upgraded = await reconcile();
      assert.notEqual(upgraded.policyDigest, initial.policyDigest);
      assert.deepEqual(upgraded.grants.xacpx, xacpxTools);

      const selection = {
        filesystem: ["read_text_file"],
        xacpx: ["delegate_request"]
      };
      const narrowed = await ensureMcpGateway(
        paths,
        environment,
        { workspace, grants: { filesystem: ["read_text_file"] } },
        dependencies
      );
      assert.equal(narrowed.grants.xacpx, undefined);
      assert.deepEqual(narrowed.reviewed.xacpx, xacpxTools);
      assert.equal(await checkMcpGateway(paths, dependencies), true);
      const manifestFile = path.join(
        codexHome, "mcp-gateway", narrowed.generation, "backend-pool.json"
      );
      const originalManifest = privateRead(manifestFile);
      const incomplete = JSON.parse(originalManifest);
      delete incomplete.servers["local.orchestrator.xacpx"];
      privateWrite(manifestFile, JSON.stringify(incomplete));
      assert.equal(await checkMcpGateway(paths, dependencies), false);
      privateWrite(manifestFile, originalManifest + "\n");
      assert.equal(await checkMcpGateway(paths, dependencies), true);

      await ensureMcpGateway(
        paths,
        environment,
        { workspace, grants: selection },
        dependencies
      );

      // An unavailable selected tool disappears from the effective surface,
      // but not from the operator's persisted selection.
      xacpxTools = ["task_watch"];
      selectGeneration("without-delegate");
      const reduced = await reconcile();
      assert.deepEqual(reduced.grants, { filesystem: ["read_text_file"] });
      assert.deepEqual(reduced.grantSelection, selection);

      // A different workspace must also rediscover the backend, even with
      // the same installed release and policy.
      xacpxTools = ["delegate_request", "task_watch", "task_get"];
      const otherWorkspace = path.join(paths.home, "another-project");
      mkdirSync(otherWorkspace);
      const moved = await ensureMcpGateway(
        paths,
        { ...environment, AUTODEV_MCP_GATEWAY_WORKSPACE: otherWorkspace },
        undefined,
        dependencies
      );
      assert.notEqual(moved.policyDigest, reduced.policyDigest);
      assert.deepEqual(moved.reviewed.xacpx, xacpxTools);
      assert.deepEqual(moved.grants, selection);
      assert.deepEqual(moved.grantSelection, selection);

      const reset = await ensureMcpGateway(
        paths,
        environment,
        { workspace: otherWorkspace, grants: {} },
        dependencies
      );
      assert.deepEqual(reset.grants, reset.reviewed);
      assert.equal(reset.grantSelection, undefined);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
);

test(
  "the ChatGPT tunnel publishes the live gateway, stores its credential in Keychain, and disabling it leaves the gateway serving",
  { timeout: 30_000 },
  async () => {
    const root = realpathSync(
      mkdtempSync(path.join(tmpdir(), "external-mcp-install-"))
    );
    try {
      const {
        codexHome,
        workspace,
        paths,
        events,
        running,
        failReady,
        gatewayDeps
      } = serviceFixture(root);
      let isWrongScope = false;
      let isRejectKey = false;
      let keychainValue: string | null = null;
      const gatewayHeader = path.join(
        codexHome,
        "mcp-gateway",
        "supergateway-auth.header"
      );
      const dependencies: ChatgptTunnelDependencies = {
        ...gatewayDeps,
        tunnelBinary: () => "/fixture/tunnel-client",
        metadata: (_binary, _arguments, environment) => {
          if (isRejectKey || !environment.AUTODEV_CHATGPT_TUNNEL_API_KEY)
            throw new Error("unauthorized");
          return {
            id: "tunnel_fixture",
            organization_ids: ["org_fixture"],
            workspace_ids: [isWrongScope ? "ws_wrong" : "ws_fixture"]
          };
        },
        create: () => {
          events.push("create");
          return "tunnel_fixture";
        },
        run: (command, arguments_, options) => {
          assert.ok(!options.env.OPENAI_ADMIN_KEY);
          if (command !== "/fixture/tunnel-client")
            return gatewayDeps.run(command, arguments_, options);
          events.push(`tunnel-client ${arguments_[0]}`);
          if (arguments_[0] === "init") {
            assert.ok(!options.env.AUTODEV_CHATGPT_TUNNEL_API_KEY);
            const generation = arguments_[arguments_.indexOf("--profile-dir") + 1]!;
            assert.equal(
              arguments_[arguments_.indexOf("--sample") + 1],
              "sample_mcp_remote_no_auth"
            );
            assert.equal(
              arguments_[arguments_.indexOf("--control-plane-api-key-ref") + 1],
              "env:AUTODEV_CHATGPT_TUNNEL_API_KEY"
            );
            writeFileSync(
              path.join(generation, "autodev.yaml"),
              [
                "control_plane:",
                '  api_key: "env:AUTODEV_CHATGPT_TUNNEL_API_KEY"',
                "health:",
                '  listen_addr: "127.0.0.1:3311"',
                "mcp:",
                "  server_urls:",
                "    - channel: main",
                `      url: "${arguments_[arguments_.indexOf("--mcp-server-url") + 1]}"`
              ].join("\n") + "\n"
            );
          } else if (arguments_[0] === "doctor") {
            assert.ok(options.env.AUTODEV_CHATGPT_TUNNEL_API_KEY);
            assert.equal(options.env.MCP_OAUTH_DISCOVERY, "disabled");
            // Doctor validates against the live gateway with its stable header.
            assert.equal(
              options.env.MCP_EXTRA_HEADERS,
              `Authorization: file:${gatewayHeader}`
            );
            const serverUrls = arguments_.filter(
              (_, index) => arguments_[index - 1] === "--mcp.server-url"
            );
            // The real tunnel-client fails `doctor` when no target is published
            // on its `main` channel.
            assert.ok(
              serverUrls.includes(
                "url=http://127.0.0.1:3312/orchestrator/mcp,channel=main"
              )
            );
          }
        },
        readKey: () => keychainValue,
        writeKey: (key) => {
          keychainValue = key;
        },
        deleteKey: () => {
          const isHad = keychainValue !== null;
          keychainValue = null;
          return isHad;
        }
      };
      const environment = {
        HOME: paths.home,
        PATH: "/bin",
        AUTODEV_MCP_GATEWAY_WORKSPACE: workspace,
        AUTODEV_CHATGPT_ORGANIZATION_ID: "org_fixture",
        AUTODEV_CHATGPT_WORKSPACE_ID: "ws_fixture",
        OPENAI_ADMIN_KEY: "fixture-admin",
        AUTODEV_CHATGPT_TUNNEL_API_KEY: "fixture-runtime"
      };
      const directory = path.join(codexHome, "chatgpt-tunnel");
      const stateFile = path.join(directory, "gateway.json");
      const plistFile = path.join(
        paths.home,
        "Library",
        "LaunchAgents",
        "com.codex.autodev-chatgpt-tunnel.plist"
      );

      // A tunnel never installs without the gateway it publishes.
      await ensureChatgptTunnel(paths, "reconcile", environment, undefined, dependencies);
      assert.ok(!existsSync(stateFile));
      await assert.rejects(
        ensureChatgptTunnel(paths, "enable", environment, undefined, dependencies),
        /MCP gateway is not installed/u
      );
      await ensureMcpGateway(paths, environment, undefined, gatewayDeps);
      await ensureChatgptTunnel(paths, "enable", environment, undefined, dependencies);
      const first = privateRead(stateFile);
      const firstState = JSON.parse(first);
      assert.equal(firstState.port, 3311);
      assert.equal(firstState.mcpPort, undefined);
      assert.equal(keychainValue, "fixture-runtime");
      assert.ok(running.has("com.codex.autodev-chatgpt-tunnel"));
      const plist = readFileSync(plistFile, "utf8");
      assert.ok(
        plist.includes(
          path.join(
            repository,
            "runtime",
            "src",
            "platform",
            "chatgpt-tunnel-install.ts"
          )
        )
      );
      // The tunnel's routing table publishes the primary role's surface on
      // tunnel-client's required `main` channel.
      assert.match(
        readFileSync(
          path.join(directory, firstState.generation, "autodev.yaml"),
          "utf8"
        ),
        /- channel: main\n\s+url: "http:\/\/127\.0\.0\.1:3312\/orchestrator\/mcp"/u
      );
      const status = await chatgptTunnelStatus(paths, dependencies);
      assert.equal(status.ready, true);
      assert.deepEqual(status.roles, ["orchestrator"]);
      // Gateway grants and workspace are the MCP catalog's, not the tunnel's.
      assert.equal("grants" in status, false);
      assert.equal("workspace" in status, false);
      assert.equal(events.filter((event) => event === "create").length, 1);
      const count = events.length;
      await ensureChatgptTunnel(paths, "reconcile", environment, undefined, dependencies);
      await ensureChatgptTunnel(
        paths,
        "reconcile",
        {
          HOME: paths.home,
          PATH: "/bin",
          OPENAI_ADMIN_KEY: "",
          AUTODEV_CHATGPT_TUNNEL_API_KEY: "",
          AUTODEV_CHATGPT_TUNNEL_PORT: "",
          AUTODEV_CHATGPT_ORGANIZATION_ID: "",
          AUTODEV_CHATGPT_WORKSPACE_ID: ""
        },
        undefined,
        dependencies
      );
      assert.equal(events.length, count);
      assert.equal(privateRead(stateFile), first);

      // The daemon waits for the gateway, then runs only tunnel-client with the
      // Keychain credential and the gateway's header file.
      const { seen, spawnProcess } = fakeSpawner("/fixture/tunnel-client");
      let gatewayWaits = 0;
      const daemonDependencies = {
        readKey: () => keychainValue,
        spawnProcess,
        waitForGateway: async (mcpPort: number) => {
          assert.equal(mcpPort, 3312);
          gatewayWaits++;
          return true;
        }
      };
      assert.equal(
        await runChatgptTunnelDaemon(paths, { HOME: paths.home }, daemonDependencies),
        1,
        "an unexpected tunnel-client exit fails the job so launchd restarts it"
      );
      assert.equal(gatewayWaits, 1);
      assert.equal(seen.length, 1);
      assert.equal(seen[0]?.cmd, "/fixture/tunnel-client");
      assert.equal(
        seen[0]?.args[2],
        path.join(directory, firstState.generation, "autodev.yaml")
      );
      assert.equal(
        seen[0]?.env.AUTODEV_CHATGPT_TUNNEL_API_KEY,
        "fixture-runtime"
      );
      assert.equal(
        seen[0]?.env.MCP_EXTRA_HEADERS,
        `Authorization: file:${gatewayHeader}`
      );
      await runChatgptTunnelDaemon(
        paths,
        {
          HOME: paths.home,
          AUTODEV_CHATGPT_TUNNEL_API_KEY: "explicit-daemon-override"
        },
        daemonDependencies
      );
      assert.equal(
        seen[1]?.env.AUTODEV_CHATGPT_TUNNEL_API_KEY,
        "explicit-daemon-override"
      );
      assert.equal(
        await runChatgptTunnelDaemon(
          paths,
          { HOME: paths.home },
          {
            ...daemonDependencies,
            waitForGateway: async () => false
          }
        ),
        1
      );
      assert.equal(seen.length, 2, "no tunnel-client without a ready gateway");

      isWrongScope = true;
      await assert.rejects(
        ensureChatgptTunnel(paths, "reconcile", environment, undefined, dependencies),
        /does not belong/
      );
      isWrongScope = false;
      isRejectKey = true;
      await assert.rejects(
        ensureChatgptTunnel(paths, "reconcile", environment, undefined, dependencies),
        /unauthorized/
      );
      isRejectKey = false;

      // A rotation whose candidate never becomes ready restores the previous
      // credential and service.
      const before = await chatgptTunnelStatus(paths, dependencies);
      const oldPlist = readFileSync(plistFile, "utf8");
      failReady.add("com.codex.autodev-chatgpt-tunnel");
      await assert.rejects(
        ensureChatgptTunnel(
          paths,
          "enable",
          environment,
          {
            action: "rotate",
            expectedRevision: before.revision,
            runtimeKey: "fixture-new"
          },
          dependencies
        ),
        /previous service configuration retained/
      );
      failReady.clear();
      assert.equal(keychainValue, "fixture-runtime");
      assert.equal(readFileSync(plistFile, "utf8"), oldPlist);
      assert.ok(running.has("com.codex.autodev-chatgpt-tunnel"));
      await ensureChatgptTunnel(
        paths,
        "enable",
        environment,
        {
          action: "rotate",
          expectedRevision: before.revision,
          runtimeKey: "fixture-new"
        },
        dependencies
      );
      assert.equal(keychainValue, "fixture-new");
      const rotated = await chatgptTunnelStatus(paths, dependencies);
      assert.notEqual(rotated.revision, before.revision);
      assert.ok(!JSON.stringify(rotated).includes("fixture-new"));

      // The tunnel never reconfigures the gateway: published roles and grants
      // are repository-owned. When the installer republishes the gateway's
      // roles, reconciling the tunnel re-projects one channel per role.
      assert.equal(
        tunnelMutationSchema.safeParse({
          action: "configure",
          expectedRevision: rotated.revision,
          workspace,
          roles: ["explorer"],
          grants: {}
        }).success,
        false
      );
      await ensureMcpGateway(
        paths,
        environment,
        { workspace, roles: ["explorer"], grants: {} },
        dependencies
      );
      await ensureChatgptTunnel(paths, "reconcile", environment, undefined, dependencies);
      const configured = await chatgptTunnelStatus(paths, dependencies);
      assert.deepEqual(configured.roles, ["orchestrator", "explorer"]);
      const reprojected = JSON.parse(privateRead(stateFile));
      assert.match(
        readFileSync(
          path.join(directory, reprojected.generation, "autodev.yaml"),
          "utf8"
        ),
        /- channel: explorer\n\s+url: "http:\/\/127\.0\.0\.1:3312\/explorer\/mcp"/u
      );
      assert.equal(await checkChatgptTunnel(paths, dependencies), true);

      await assert.rejects(
        ensureChatgptTunnel(
          paths,
          "disable",
          {},
          { action: "disable", expectedRevision: rotated.revision },
          dependencies
        ),
        /revision conflict/
      );
      await ensureChatgptTunnel(
        paths,
        "disable",
        {},
        { action: "disable", expectedRevision: configured.revision },
        dependencies
      );
      assert.ok(!running.has("com.codex.autodev-chatgpt-tunnel"));
      assert.ok(!existsSync(plistFile));
      // Disabling the tunnel never touches the gateway.
      assert.ok(running.has(MCP_GATEWAY_LABEL));
      assert.equal(await checkMcpGateway(paths, gatewayDeps), true);
      await ensureChatgptTunnel(paths, "reconcile", environment, undefined, dependencies);
      assert.ok(!running.has("com.codex.autodev-chatgpt-tunnel"));
      const disabled = await chatgptTunnelStatus(paths, dependencies);
      assert.equal(disabled.enabled, false);
      assert.equal(disabled.configured, true);
      await ensureChatgptTunnel(
        paths,
        "disable",
        {},
        { action: "forget", expectedRevision: disabled.revision },
        dependencies
      );
      assert.equal(keychainValue, null);
      await assert.rejects(
        ensureChatgptTunnel(paths, "enable", {}, undefined, dependencies),
        /restricted runtime/
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
);

test(
  "real combined gateway exposes local confined and authenticated remote Streamable HTTP MCPs with credential isolation",
  {
    skip: process.env.AUTODEV_TEST_SUPERGATEWAY !== "1",
    timeout: 180_000
  },
  async () => {
    const root = realpathSync(
      mkdtempSync(path.join(tmpdir(), "autodev-multi-mcp-"))
    );
    const workspace = path.join(root, "workspace");
    mkdirSync(workspace);
    const inside = path.join(workspace, "readme.txt");
    writeFileSync(inside, "multi-server-ok");
    const environmentSpyPath = path.join(root, "local-env-keys.json");
    const environmentSpyScript = path.join(root, "local-code-tool.mjs");
    writeFileSync(
      environmentSpyScript,
      [
        'import { createInterface } from "node:readline";',
        'import { writeFileSync } from "node:fs";',
        `writeFileSync(${JSON.stringify(environmentSpyPath)}, JSON.stringify(Object.keys(process.env).sort()));`,
        "const rl = createInterface({ input: process.stdin });",
        'rl.on("line", (line) => {',
        "  const m = JSON.parse(line);",
        '  if (m.method === "initialize") {',
        '    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: m.params.protocolVersion, capabilities: { tools: {}, prompts: {}, resources: {} }, serverInfo: { name: "local-code", version: "1" } } }) + "\\n");',
        '  } else if (m.method === "ping") {',
        '    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: m.id, result: {} }) + "\\n");',
        '  } else if (m.method === "tools/list") {',
        '    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: m.id, result: { tools: [{ name: "find_symbol", inputSchema: { type: "object" }, annotations: { readOnlyHint: true, openWorldHint: false } }, { name: "mutate", inputSchema: { type: "object" }, annotations: { readOnlyHint: false, destructiveHint: true } }] } }) + "\\n");',
        '  } else if (m.method === "tools/call") {',
        '    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: m.id, result: { content: [{ type: "text", text: "symbol:" + (m.params.arguments?.name ?? "") }] } }) + "\\n");',
        "  }",
        "});"
      ].join("\n")
    );

    const remoteSessions = new Set<string>();
    const remoteServer = createHttpServer((request, res) => {
      const isGoogle = request.url?.startsWith("/google");
      const isAuthorized = isGoogle
        ? request.headers["x-goog-api-key"] === "remote-gdev-token"
        : request.headers.authorization === "Bearer remote-context7-token";
      if (!isAuthorized) {
        res.writeHead(401).end("unauthorized");
        return;
      }
      if (request.method === "GET") {
        res.writeHead(405).end();
        return;
      }
      if (request.method === "DELETE") {
        res.writeHead(200).end();
        return;
      }
      const chunks: Buffer[] = [];
      request.on("data", (c) => chunks.push(c));
      request.on("end", () => {
        const message = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        const sessionId =
          (typeof request.headers["mcp-session-id"] === "string" &&
            request.headers["mcp-session-id"]) ||
          "remote-sess-" + (remoteSessions.size + 1);
        remoteSessions.add(sessionId);
        if (message.id === undefined) {
          res.writeHead(202, { "mcp-session-id": sessionId }).end();
          return;
        }
        let result: unknown = {};
        if (message.method === "initialize") {
          result = {
            protocolVersion: message.params.protocolVersion,
            capabilities: { tools: {}, prompts: {}, resources: {} },
            serverInfo: { name: "remote-docs", version: "1" }
          };
        } else if (message.method === "tools/list") {
          result = {
            tools: [
              {
                name: "query-docs",
                inputSchema: { type: "object" },
                annotations: { readOnlyHint: true, openWorldHint: true }
              },
              { name: "hidden-admin", inputSchema: { type: "object" } }
            ]
          };
        } else if (message.method === "tools/call") {
          result = {
            content: [
              { type: "text", text: "docs:" + (message.params.arguments?.q ?? "") }
            ]
          };
        }
        res
          .writeHead(200, {
            "content-type": "application/json",
            "mcp-session-id": sessionId
          })
          .end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
      });
    });

    const client = new Client({ name: "multi-e2e", version: "1" });
    let gateway: ChildProcess | undefined;
    try {
      remoteServer.listen(0, "127.0.0.1");
      await once(remoteServer, "listening");
      const remoteAddr = remoteServer.address();
      assert.ok(remoteAddr && typeof remoteAddr !== "string");
      const executable = resolveSupergateway(path.join(repository, "runtime", "src"));
      const config = path.join(root, "supergateway.json");
      const keyFile = path.join(root, "supergateway.key");
      const localToken = "multi-gateway-token";
      privateWrite(keyFile, localToken + "\n");
      const mcpPort = await allocateLoopbackPort();
      const catalogue = {
        filesystem: {
          command: process.execPath,
          args: [path.join(repository, "runtime/src/mcp/launcher.ts"), "filesystem"]
        },
        lsp: {
          command: process.execPath,
          args: [environmentSpyScript]
        },
        context7: {
          url: `http://127.0.0.1:${remoteAddr.port}/mcp`,
          bearer_token_env_var: "CONTEXT7_API_KEY"
        },
        googleDeveloperKnowledge: {
          url: `http://127.0.0.1:${remoteAddr.port}/google/mcp`,
          http_headers: {
            "X-Goog-Api-Key": "${GOOGLE_DEVELOPER_KNOWLEDGE_API_KEY}"
          }
        }
      };
      const policy = {
        filesystem: ["read_text_file"],
        lsp: ["find_symbol"],
        context7: ["query-docs"],
        googleDeveloperKnowledge: ["query-docs"]
      };
      writeFileSync(
        config,
        renderGatewayConfig(
          path.dirname(config),
          catalogue,
          [{ role: "orchestrator", grants: policy, reviewed: policy }],
          workspace,
          { port: mcpPort, apiKeyFile: keyFile },
          (server) =>
            server === "filesystem"
              ? externalMcpBackend(server, repository, workspace, process.execPath)
              : catalogue[server as "lsp"]
        )
      );
      const environment = {
        ...chatgptSupergatewayEnvironment(
          { home: root, codexHome: root, repositoryRoot: repository },
          workspace,
          process.execPath,
          process.env.PATH ?? "/usr/bin:/bin"
        ),
        CONTEXT7_API_KEY: "remote-context7-token",
        GOOGLE_DEVELOPER_KNOWLEDGE_API_KEY: "remote-gdev-token"
      };
      gateway = await startSupergatewayServer(
        executable,
        config,
        workspace,
        environment,
        mcpPort
      );
      await client.connect(
        new StreamableHTTPClientTransport(
          new URL(`http://127.0.0.1:${mcpPort}/orchestrator/mcp`),
          {
            requestInit: { headers: { Authorization: `Bearer ${localToken}` } }
          }
        )
      );
      const caps = client.getServerCapabilities();
      assert.equal(caps?.prompts, undefined);
      assert.equal(caps?.resources, undefined);

      const listed = await client.listTools();
      assert.deepEqual(listed.tools.map((t) => t.name).sort(), [
        "context7__query-docs",
        "filesystem__read_text_file",
        "googleDeveloperKnowledge__query-docs",
        "lsp__find_symbol"
      ]);
      const remoteTool = listed.tools.find(
        (t) => t.name === "context7__query-docs"
      );
      const localTool = listed.tools.find((t) => t.name === "lsp__find_symbol");
      assert.equal(remoteTool?.annotations?.openWorldHint, true);
      assert.equal(remoteTool?.annotations?.readOnlyHint, true);
      assert.equal(localTool?.annotations?.openWorldHint, false);

      const [fsRes, lspRes, c7Res, gdevRes] = await Promise.all([
        client.callTool({
          name: "filesystem__read_text_file",
          arguments: { path: inside }
        }),
        client.callTool({
          name: "lsp__find_symbol",
          arguments: { name: "Chatgpt" }
        }),
        client.callTool({
          name: "context7__query-docs",
          arguments: { q: "supergateway" }
        }),
        client.callTool({
          name: "googleDeveloperKnowledge__query-docs",
          arguments: { q: "gdev" }
        })
      ]);
      assert.match(JSON.stringify(fsRes), /multi-server-ok/);
      assert.match(JSON.stringify(lspRes), /symbol:Chatgpt/);
      assert.match(JSON.stringify(c7Res), /docs:supergateway/);
      assert.match(JSON.stringify(gdevRes), /docs:gdev/);
      const localEnvironmentKeys = JSON.parse(
        readFileSync(environmentSpyPath, "utf8")
      ) as string[];
      assert.ok(!localEnvironmentKeys.includes("CONTEXT7_API_KEY"));
      assert.ok(!localEnvironmentKeys.includes("GOOGLE_DEVELOPER_KNOWLEDGE_API_KEY"));

      await assert.rejects(async () => {
        const denied = await client.callTool({
          name: "context7__hidden-admin",
          arguments: {}
        });
        if (denied.isError) throw new Error("denied");
      });
      // Probe must confirm exact multi-server aggregation without capability leaks.
      await probeSupergateway(executable, config, environment);
    } finally {
      await client.close().catch(() => {});
      await stopProcess(gateway);
      remoteServer.closeAllConnections();
      remoteServer.close();
      rmSync(root, { recursive: true, force: true });
    }
  }
);

test(
  "real tunnel-client dev proxy routes Streamable HTTP MCP sessions through Supergateway with session isolation, reconnection, and service restarts",
  {
    skip:
      process.env.AUTODEV_TEST_SUPERGATEWAY !== "1" ||
      !resolveCommandOnPath("tunnel-client"),
    timeout: 180_000
  },
  async () => {
    const root = realpathSync(
      mkdtempSync(path.join(tmpdir(), "autodev-tunnel-e2e-"))
    );
    const workspace = path.join(root, "workspace");
    const codexHome = path.join(root, ".codex");
    const urlFile = path.join(root, "proxy.json");
    const healthUrlFile = path.join(root, "health.url");
    mkdirSync(workspace);
    mkdirSync(codexHome);
    const inside = path.join(workspace, "allowed.txt");
    const outside = path.join(root, "secret.txt");
    writeFileSync(inside, "tunnel-roundtrip-ok");
    writeFileSync(outside, "forbidden-secret");
    symlinkSync(outside, path.join(workspace, "escape.txt"));

    const supergateway = resolveSupergateway(path.join(repository, "runtime", "src"));
    const config = path.join(root, "supergateway.json");
    const keyFile = path.join(root, "supergateway.key");
    const headerFile = path.join(root, "supergateway-auth.header");
    const localToken = "e2e-supergateway-token";
    privateWrite(keyFile, localToken + "\n");
    privateWrite(headerFile, `Bearer ${localToken}\n`);
    const mcpPort = await allocateLoopbackPort();
    const catalogue = {
      filesystem: {
        command: process.execPath,
        args: [path.join(repository, "runtime/src/mcp/launcher.ts"), "filesystem"]
      }
    };
    const policy = {
      filesystem: ["read_text_file", "list_allowed_directories"]
    };
    writeFileSync(
      config,
      renderGatewayConfig(
        path.dirname(config),
        catalogue,
        [{ role: "orchestrator", grants: policy, reviewed: policy }],
        workspace,
        { port: mcpPort, apiKeyFile: keyFile },
        (server) =>
          externalMcpBackend(
            server,
            repository,
            workspace,
            process.execPath,
            root,
            codexHome,
            { role: "explorer", readOnly: true }
          )
      )
    );
    const gatewayEnvironment = chatgptSupergatewayEnvironment(
      { home: root, codexHome, repositoryRoot: repository },
      workspace,
      process.execPath,
      process.env.PATH ?? "/usr/bin:/bin"
    );
    let gateway: ChildProcess | undefined = await startSupergatewayServer(
      supergateway,
      config,
      workspace,
      gatewayEnvironment,
      mcpPort
    );
    const proxy = spawn(
      resolveCommandOnPath("tunnel-client")!,
      [
        "dev",
        "proxy",
        "--mcp-server-url",
        `http://127.0.0.1:${mcpPort}/orchestrator/mcp`,
        "--url-file",
        urlFile,
        "--health-url-file",
        healthUrlFile,
        "--readiness-timeout",
        "30s"
      ],
      {
        env: {
          ...process.env,
          ...tunnelClientMcpEnvironment(headerFile)
        },
        stdio: ["ignore", "pipe", "pipe"]
      }
    );
    let proxyLogs = "";
    proxy.stdout.on("data", (chunk) => {
      proxyLogs += String(chunk);
    });
    proxy.stderr.on("data", (chunk) => {
      proxyLogs += String(chunk);
    });
    const openClients: Client[] = [];
    const connectClient = async (name: string) => {
      const client = new Client({ name, version: "1.0.0" });
      openClients.push(client);
      const transport = new StreamableHTTPClientTransport(
        new URL(proxyInfo!.mcp_url!)
      );
      await client.connect(transport, { timeout: 45_000 });
      return { client, transport };
    };
    let proxyInfo: { mcp_url?: string } | null = null;
    try {
      for (let attempt = 0; attempt < 150; attempt++) {
        await delay(200);
        try {
          const raw = readFileSync(urlFile, "utf8").trim();
          if (raw) {
            proxyInfo = JSON.parse(raw) as { mcp_url?: string };
            break;
          }
        } catch {
          /*
          waiting for proxy readiness
          */
        }
      }
      assert.ok(
        proxyInfo?.mcp_url,
        `tunnel-client dev proxy did not report mcp_url: ${proxyLogs}`
      );
      const healthUrl = readFileSync(healthUrlFile, "utf8").trim();
      const readyz = await fetch(healthUrl + "/readyz");
      assert.equal(readyz.ok, true);
      assert.match((await readyz.text()).trim(), /^ready/);

      // 1. Discovery followed by invocation, plus sandbox confinement.
      const { client: primary, transport: primaryTransport } =
        await connectClient("autodev-tunnel-primary");
      assert.ok(primaryTransport.sessionId);
      const capabilities = primary.getServerCapabilities();
      assert.equal(capabilities?.resources, undefined);
      assert.equal(capabilities?.prompts, undefined);
      const listed = await primary.listTools({}, { timeout: 45_000 });
      assert.deepEqual(listed.tools.map((tool) => tool.name).sort(), [
        "filesystem__list_allowed_directories",
        "filesystem__read_text_file"
      ]);
      const read = await primary.callTool({
        name: "filesystem__read_text_file",
        arguments: { path: inside }
      });
      assert.match(JSON.stringify(read), /tunnel-roundtrip-ok/);
      for (const target of [outside, path.join(workspace, "escape.txt")]) {
        const denied = await primary.callTool({
          name: "filesystem__read_text_file",
          arguments: { path: target }
        });
        assert.equal(denied.isError, true);
        assert.doesNotMatch(JSON.stringify(denied), /forbidden-secret/);
      }
      await assert.rejects(async () => {
        const result = await primary.callTool({
          name: "filesystem__write_file",
          arguments: { path: inside, content: "mutated" }
        });
        if (result.isError) throw new Error("write denied");
      });
      assert.equal(readFileSync(inside, "utf8"), "tunnel-roundtrip-ok");

      // 2. Concurrent independent sessions & repeated initialization against the same running tunnel.
      const [second, third] = await Promise.all([
        connectClient("autodev-tunnel-concurrent-1"),
        connectClient("autodev-tunnel-concurrent-2")
      ]);
      assert.ok(second.transport.sessionId);
      assert.ok(third.transport.sessionId);
      assert.notEqual(primaryTransport.sessionId, second.transport.sessionId);
      assert.notEqual(second.transport.sessionId, third.transport.sessionId);
      const [r1, r2, r3] = await Promise.all([
        primary.callTool({
          name: "filesystem__read_text_file",
          arguments: { path: inside }
        }),
        second.client.callTool({
          name: "filesystem__read_text_file",
          arguments: { path: inside }
        }),
        third.client.callTool({
          name: "filesystem__list_allowed_directories",
          arguments: {}
        })
      ]);
      assert.match(JSON.stringify(r1), /tunnel-roundtrip-ok/);
      assert.match(JSON.stringify(r2), /tunnel-roundtrip-ok/);
      assert.match(
        JSON.stringify(r3),
        new RegExp(workspace.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"))
      );

      // 3. Reconnection after closing a previous session.
      await second.client.close();
      const reconnected = await connectClient("autodev-tunnel-reconnect");
      assert.notEqual(
        reconnected.transport.sessionId,
        second.transport.sessionId
      );
      const reconnectedTools = await reconnected.client.listTools(
        {},
        { timeout: 45_000 }
      );
      assert.equal(reconnectedTools.tools.length, 2);
      const reconnectedRead = await reconnected.client.callTool({
        name: "filesystem__read_text_file",
        arguments: { path: inside }
      });
      assert.match(JSON.stringify(reconnectedRead), /tunnel-roundtrip-ok/);

      // 4. Service restart behind the same running tunnel: stale sessions get 404,
      // and new sessions initialize and invoke tools cleanly.
      await stopProcess(gateway);
      gateway = await startSupergatewayServer(
        supergateway,
        config,
        workspace,
        gatewayEnvironment,
        mcpPort
      );
      await assert.rejects(
        () =>
          primary.callTool({
            name: "filesystem__read_text_file",
            arguments: { path: inside }
          }),
        /404|Not Found|session/i
      );
      const postRestart = await connectClient("autodev-tunnel-post-restart");
      const postRestartTools = await postRestart.client.listTools(
        {},
        { timeout: 45_000 }
      );
      assert.equal(postRestartTools.tools.length, 2);
      const postRestartRead = await postRestart.client.callTool({
        name: "filesystem__read_text_file",
        arguments: { path: inside }
      });
      assert.match(JSON.stringify(postRestartRead), /tunnel-roundtrip-ok/);
    } finally {
      await Promise.allSettled(openClients.map((client) => client.close()));
      await stopProcess(proxy);
      await stopProcess(gateway);
      rmSync(root, { recursive: true, force: true });
    }
  }
);

test(
  "pinned Supergateway and tunnel-client proxy serve Seatbelt-confined LSP (past watchdog) and CocoIndex semantic search",
  {
    skip: process.env.AUTODEV_TEST_SUPERGATEWAY !== "1",
    timeout: 180_000
  },
  async () => {
    const root = realpathSync(
      mkdtempSync(path.join(tmpdir(), "autodev-code-tools-e2e-"))
    );
    const home = path.join(root, "home");
    const codexHome = path.join(home, ".codex");
    const workspace = path.join(root, "workspace");
    mkdirSync(path.join(workspace, "src"), { recursive: true });
    mkdirSync(codexHome, { recursive: true });
    // Mirror the host node_modules so workspace tsc/tsserver resolution works inside the temp root.
    symlinkSync(
      path.join(repository, "node_modules"),
      path.join(workspace, "node_modules")
    );
    writeFileSync(
      path.join(workspace, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: { target: "ES2022", module: "NodeNext", strict: true },
        include: ["src/**/*.ts"]
      })
    );
    const greeterFile = path.join(workspace, "src", "greeter.ts");
    const mainFile = path.join(workspace, "src", "main.ts");
    const brokenFile = path.join(workspace, "src", "broken.ts");
    writeFileSync(
      greeterFile,
      "export function formatGreeting(name: string): string {\n  return `Hello, ${name}`;\n}\n"
    );
    writeFileSync(
      mainFile,
      'import { formatGreeting } from "./greeter.ts";\nexport const banner = formatGreeting("AutoDev");\n'
    );
    writeFileSync(
      brokenFile,
      'export const brokenCount: number = "not-a-number";\n'
    );

    const cccBinary = resolveCocoIndexBinary(process.env);
    const userHome = homedir();
    const userCccSettings = path.join(
      userHome,
      ".cocoindex_code",
      "global_settings.yml"
    );
    const userHfCache = path.join(userHome, ".cache", "huggingface");
    const isIncludeCocoindex = Boolean(
      cccBinary && existsSync(userCccSettings) && existsSync(userHfCache)
    );
    if (isIncludeCocoindex) {
      mkdirSync(path.join(home, ".cocoindex_code"), { recursive: true });
      cpSync(
        userCccSettings,
        path.join(home, ".cocoindex_code", "global_settings.yml")
      );
      mkdirSync(path.join(home, ".cache"), { recursive: true });
      symlinkSync(userHfCache, path.join(home, ".cache", "huggingface"));
    }

    const supergateway = resolveSupergateway(path.join(repository, "runtime", "src"));
    const config = path.join(root, "supergateway.json");
    const keyFile = path.join(root, "supergateway.key");
    const headerFile = path.join(root, "supergateway-auth.header");
    const localToken = "code-tools-e2e-token";
    privateWrite(keyFile, localToken + "\n");
    privateWrite(headerFile, `Bearer ${localToken}\n`);
    const mcpPort = await allocateLoopbackPort();
    const catalogue: Record<string, Record<string, unknown>> = {
      filesystem: {
        command: process.execPath,
        args: [path.join(repository, "runtime/src/mcp/launcher.ts"), "filesystem"]
      },
      lsp: {
        command: process.execPath,
        args: [path.join(repository, "runtime/src/mcp/launcher.ts"), "lsp"]
      },
      ...(isIncludeCocoindex && {
            "cocoindex-code": {
              command: process.execPath,
              args: [
                path.join(repository, "runtime/src/mcp/launcher.ts"),
                "cocoindex-code"
              ]
            }
          })
    };
    const policy: Record<string, string[]> = {
      filesystem: ["read_text_file"],
      lsp: [
        "lsp_server_status",
        "lsp_document_symbols",
        "lsp_hover",
        "lsp_goto_definition",
        "lsp_find_references",
        "lsp_diagnostics",
        "lsp_workspace_symbols"
      ],
      ...(isIncludeCocoindex && { "cocoindex-code": ["search"] })
    };
    writeFileSync(
      config,
      renderGatewayConfig(
        path.dirname(config),
        catalogue,
        [{ role: "orchestrator", grants: policy, reviewed: policy }],
        workspace,
        { port: mcpPort, apiKeyFile: keyFile },
        (server) =>
          externalMcpBackend(
            server,
            repository,
            workspace,
            process.execPath,
            home,
            codexHome
          )
      )
    );
    const servicePath = [
      path.dirname(process.execPath),
      path.join(repository, "node_modules/.bin"),
      ...(cccBinary ? [path.dirname(cccBinary)] : []),
      process.env.PATH ?? "/usr/bin:/bin"
    ].join(":");
    const gatewayEnvironment = chatgptSupergatewayEnvironment(
      { home, codexHome, repositoryRoot: repository },
      workspace,
      process.execPath,
      servicePath
    );

    let gateway: ChildProcess | undefined;
    let proxy: ChildProcess | undefined;
    const client = new Client({
      name: "autodev-code-tools-e2e",
      version: "1.0.0"
    });
    try {
      gateway = await startSupergatewayServer(
        supergateway,
        config,
        workspace,
        gatewayEnvironment,
        mcpPort
      );

      let mcpEndpoint = new URL(`http://127.0.0.1:${mcpPort}/orchestrator/mcp`);
      let requestInit: RequestInit = {
        headers: { Authorization: `Bearer ${localToken}` }
      };
      const tunnelBin = resolveCommandOnPath("tunnel-client");
      if (tunnelBin) {
        const urlFile = path.join(root, "proxy.json");
        const healthUrlFile = path.join(root, "health.url");
        proxy = spawn(
          tunnelBin,
          [
            "dev",
            "proxy",
            "--mcp-server-url",
            `http://127.0.0.1:${mcpPort}/orchestrator/mcp`,
            "--url-file",
            urlFile,
            "--health-url-file",
            healthUrlFile,
            "--readiness-timeout",
            "30s",
            "--response-timeout",
            "60s"
          ],
          {
            env: { ...process.env, ...tunnelClientMcpEnvironment(headerFile) },
            stdio: ["ignore", "pipe", "pipe"]
          }
        );
        let proxyUrl: string | undefined;
        for (let attempt = 0; attempt < 150; attempt++) {
          await delay(200);
          try {
            const raw = readFileSync(urlFile, "utf8").trim();
            if (raw) {
              proxyUrl = (JSON.parse(raw) as { mcp_url?: string }).mcp_url;
              if (proxyUrl) break;
            }
          } catch {
            /*
            waiting for proxy readiness
            */
          }
        }
        assert.ok(proxyUrl, "tunnel-client dev proxy did not report mcp_url");
        mcpEndpoint = new URL(proxyUrl);
        requestInit = {};
      }

      await client.connect(
        new StreamableHTTPClientTransport(mcpEndpoint, { requestInit }),
        { timeout: 45_000 }
      );

      const firstText = (result: unknown): string => {
        const content =
          result && typeof result === "object"
            ? (result as { content?: unknown }).content
            : undefined;
        const items = Array.isArray(content)
          ? (content as Array<{ text?: string }>)
          : [];
        return items[0]?.text ?? "";
      };

      // 1. LSP lazy startup is initially empty, then initializes and survives >4s (past the 3s watchdog).
      const initialStatus = await client.callTool({
        name: "lsp__lsp_server_status",
        arguments: {}
      });
      assert.deepEqual(JSON.parse(firstText(initialStatus)), { servers: [] });

      const readRes = await client.callTool({
        name: "filesystem__read_text_file",
        arguments: { path: greeterFile }
      });
      assert.equal(readRes.isError, undefined);
      assert.match(firstText(readRes), /formatGreeting/);

      const symbols = await client.callTool({
        name: "lsp__lsp_document_symbols",
        arguments: { file_path: mainFile }
      });
      assert.equal(symbols.isError, undefined);
      assert.match(JSON.stringify(symbols), /banner/);

      // A separate client session (mirroring per-call ChatGPT sessions) shares the
      // pooled lsp-mcp-server, so the language server the first session started is
      // already warm for it.
      const isolatedClient = new Client({
        name: "autodev-code-tools-isolated-session",
        version: "1.0.0"
      });
      try {
        await isolatedClient.connect(
          new StreamableHTTPClientTransport(mcpEndpoint, { requestInit }),
          { timeout: 45_000 }
        );
        const isolatedStatus = await isolatedClient.callTool({
          name: "lsp__lsp_server_status",
          arguments: {}
        });
        assert.equal(
          (JSON.parse(firstText(isolatedStatus)) as { servers: unknown[] })
            .servers.length,
          1
        );
      } finally {
        await isolatedClient.close().catch(() => {});
      }

      // Wait past typescript-language-server's 3-second watchDog (`process.kill(parentPid, 0)`).
      await delay(4200);

      const hover = await client.callTool({
        name: "lsp__lsp_hover",
        arguments: { file_path: mainFile, line: 2, column: 14 }
      });
      assert.equal(hover.isError, undefined);
      assert.match(JSON.stringify(hover), /banner/);

      const definition = await client.callTool({
        name: "lsp__lsp_goto_definition",
        arguments: { file_path: mainFile, line: 2, column: 23 }
      });
      assert.equal(definition.isError, undefined);
      assert.match(JSON.stringify(definition), /greeter\.ts/);

      const references = await client.callTool({
        name: "lsp__lsp_find_references",
        arguments: { file_path: greeterFile, line: 1, column: 17 }
      });
      assert.equal(references.isError, undefined);
      assert.match(JSON.stringify(references), /main\.ts/);

      const diagnostics = JSON.parse(
        firstText(
          await client.callTool({
            name: "lsp__lsp_diagnostics",
            arguments: { file_path: brokenFile }
          })
        )
      ) as {
        diagnostics: Array<{ severity: string; message: string }>;
        summary: { errors: number };
      };
      assert.ok(diagnostics.summary.errors >= 1);
      assert.ok(
        diagnostics.diagnostics.some((entry) => entry.severity === "error")
      );

      const workspaceSymbols = await client.callTool({
        name: "lsp__lsp_workspace_symbols",
        arguments: { query: "formatGreeting" }
      });
      assert.equal(workspaceSymbols.isError, undefined);
      assert.match(JSON.stringify(workspaceSymbols), /formatGreeting/);

      const activeStatus = JSON.parse(
        firstText(
          await client.callTool({
            name: "lsp__lsp_server_status",
            arguments: {}
          })
        )
      ) as { servers: Array<{ id: string; status: string }> };
      assert.equal(activeStatus.servers.length, 1);
      assert.equal(activeStatus.servers[0]?.id, "typescript");
      assert.equal(activeStatus.servers[0]?.status, "running");

      // 2. CocoIndex cold-starts daemon inside Seatbelt, initializes env, indexes, and searches.
      if (isIncludeCocoindex) {
        const searchResult = await client.callTool(
          {
            name: "cocoindex_code__search",
            arguments: { query: "formatGreeting", limit: 3 }
          },
          undefined,
          { timeout: 60_000 }
        );
        assert.ok(
          !searchResult.isError,
          `CocoIndex search returned MCP error: ${JSON.stringify(searchResult)}`
        );
        const parsedSearch = JSON.parse(firstText(searchResult)) as {
          success: boolean;
          results: Array<{ file_path: string; content: string }>;
          message?: string | null;
        };
        assert.equal(
          parsedSearch.success,
          true,
          `CocoIndex search failed: ${parsedSearch.message ?? ""}`
        );
        assert.ok(
          parsedSearch.results.some((entry) =>
            entry.file_path.endsWith("greeter.ts")
          )
        );
      }
    } finally {
      await client.close().catch(() => {});
      await stopProcess(proxy);
      await stopProcess(gateway);
      try {
        const daemonPid = Number(
          readFileSync(
            path.join(home, ".cocoindex_code", "daemon.pid"),
            "utf8"
          ).trim()
        );
        if (Number.isInteger(daemonPid) && daemonPid > 0) {
          process.kill(daemonPid, "SIGKILL");
        }
      } catch {
        /*
        daemon may not have been started
        */
      }
      rmSync(root, { recursive: true, force: true });
    }
  }
);

test(
  "ChatGPT writable role performs authorized workspace mutations, reads skills read-only, preserves truthful tool annotations, and enforces workspace/secret confinement over Supergateway",
  {
    skip: process.env.AUTODEV_TEST_SUPERGATEWAY !== "1",
    timeout: 180_000
  },
  async () => {
    const root = realpathSync(
      mkdtempSync(path.join(tmpdir(), "autodev-chatgpt-rw-e2e-"))
    );
    const home = path.join(root, "home");
    const codexHome = path.join(home, ".codex");
    const workspace = path.join(root, "workspace");
    const skillRoot = path.join(root, "skills-root");
    mkdirSync(path.join(skillRoot, "demo-skill"), { recursive: true });
    mkdirSync(workspace, { recursive: true });
    mkdirSync(codexHome, { recursive: true });

    const insideFile = path.join(workspace, "notes.txt");
    const createdFile = path.join(workspace, "sub", "created.txt");
    const outsideFile = path.join(root, "outside.txt");
    const secretEnvironment = path.join(workspace, ".env");
    const skillFile = path.join(skillRoot, "demo-skill", "SKILL.md");
    writeFileSync(insideFile, "initial-line\n");
    writeFileSync(outsideFile, "outside-secret");
    writeFileSync(secretEnvironment, "SECRET_TOKEN=never-leak\n");
    writeFileSync(skillFile, "# Demo Skill\nUse canonical tools.\n");
    symlinkSync(outsideFile, path.join(workspace, "escape-link.txt"));

    const executable = resolveSupergateway(path.join(repository, "runtime", "src"));
    const config = path.join(root, "supergateway.json");
    const keyFile = path.join(root, "supergateway.key");
    const localToken = "rw-gateway-token";
    privateWrite(keyFile, localToken + "\n");
    const mcpPort = await allocateLoopbackPort();
    const catalogue = {
      filesystem: {
        command: process.execPath,
        args: [path.join(repository, "runtime/src/mcp/launcher.ts"), "filesystem"]
      }
    };
    const grants = {
      filesystem: [
        "read_text_file",
        "write_file",
        "edit_file",
        "create_directory",
        "list_allowed_directories"
      ]
    };
    writeFileSync(
      config,
      renderGatewayConfig(
        path.dirname(config),
        catalogue,
        [{ role: "orchestrator", grants: grants, reviewed: grants }],
        workspace,
        { port: mcpPort, apiKeyFile: keyFile },
        (server) =>
          externalMcpBackend(
            server,
            repository,
            workspace,
            process.execPath,
            home,
            codexHome,
            { role: "orchestrator", skillRoots: [skillRoot] }
          )
      )
    );
    const environment = chatgptSupergatewayEnvironment(
      { home, codexHome, repositoryRoot: repository },
      workspace,
      process.execPath,
      process.env.PATH ?? "/usr/bin:/bin",
      { role: "orchestrator" }
    );
    let gateway: ChildProcess | undefined;
    const client = new Client({ name: "chatgpt-rw-e2e", version: "1.0.0" });
    try {
      gateway = await startSupergatewayServer(
        executable,
        config,
        workspace,
        environment,
        mcpPort
      );
      await client.connect(
        new StreamableHTTPClientTransport(
          new URL(`http://127.0.0.1:${mcpPort}/orchestrator/mcp`),
          {
            requestInit: { headers: { Authorization: `Bearer ${localToken}` } }
          }
        )
      );

      // 1. Truthful tool annotations: write_file must NOT carry a forged readOnlyHint: true.
      const listed = await client.listTools();
      const writeTool = listed.tools.find(
        (tool) => tool.name === "filesystem__write_file"
      );
      assert.ok(writeTool, "writable role must expose filesystem__write_file");
      assert.notEqual(writeTool.annotations?.readOnlyHint, true);

      // 2. Authorized mutations inside workspace succeed.
      const mkdirRes = await client.callTool({
        name: "filesystem__create_directory",
        arguments: { path: path.join(workspace, "sub") }
      });
      assert.equal(mkdirRes.isError, undefined);

      const writeRes = await client.callTool({
        name: "filesystem__write_file",
        arguments: { path: createdFile, content: "written-by-chatgpt\n" }
      });
      assert.equal(writeRes.isError, undefined);
      assert.equal(readFileSync(createdFile, "utf8"), "written-by-chatgpt\n");

      const editRes = await client.callTool({
        name: "filesystem__edit_file",
        arguments: {
          path: insideFile,
          edits: [{ oldText: "initial-line", newText: "edited-by-chatgpt" }]
        }
      });
      assert.equal(editRes.isError, undefined);
      assert.equal(readFileSync(insideFile, "utf8"), "edited-by-chatgpt\n");

      // 3. Mounted skill root is readable but read-only (cannot be mutated).
      const skillRead = await client.callTool({
        name: "filesystem__read_text_file",
        arguments: { path: skillFile }
      });
      assert.equal(skillRead.isError, undefined);
      assert.match(JSON.stringify(skillRead), /Demo Skill/);

      const skillWrite = await client.callTool({
        name: "filesystem__write_file",
        arguments: { path: skillFile, content: "tampered" }
      });
      assert.equal(skillWrite.isError, true);
      assert.match(readFileSync(skillFile, "utf8"), /Demo Skill/);

      // 4. Out-of-workspace, symlink escape, and .env secrets remain denied for both reads and writes.
      for (const blockedPath of [
        outsideFile,
        path.join(workspace, "escape-link.txt"),
        secretEnvironment
      ]) {
        const readBlocked = await client.callTool({
          name: "filesystem__read_text_file",
          arguments: { path: blockedPath }
        });
        assert.equal(readBlocked.isError, true);
        assert.doesNotMatch(
          JSON.stringify(readBlocked),
          /outside-secret|never-leak/
        );

        const writeBlocked = await client.callTool({
          name: "filesystem__write_file",
          arguments: { path: blockedPath, content: "pwned" }
        });
        assert.equal(writeBlocked.isError, true);
      }
      assert.equal(readFileSync(outsideFile, "utf8"), "outside-secret");
      assert.equal(
        readFileSync(secretEnvironment, "utf8"),
        "SECRET_TOKEN=never-leak\n"
      );
    } finally {
      await client.close().catch(() => {});
      await stopProcess(gateway);
      rmSync(root, { recursive: true, force: true });
    }
  }
);

test(
  "ChatGPT orchestrator delegates and manages child agents end-to-end through Supergateway + XACPX MCP with role isolation, workspace confinement, and cross-session denial",
  {
    skip: process.env.AUTODEV_TEST_SUPERGATEWAY !== "1",
    timeout: 180_000
  },
  async () => {
    const root = realpathSync(
      mkdtempSync(path.join(tmpdir(), "autodev-chatgpt-xacpx-e2e-"))
    );
    const home = path.join(root, "home");
    const codexHome = path.join(home, ".codex");
    const workspace = path.join(root, "workspace");
    const outsideDir = path.join(root, "outside");
    mkdirSync(workspace, { recursive: true });
    mkdirSync(outsideDir, { recursive: true });
    mkdirSync(path.join(codexHome, "run", "xacpx"), { recursive: true });

    const socketPath = resolveXacpxOrchestrationSocketPath(codexHome, {});
    const recordedLaunches: Array<{
      role: string;
      cwd: string;
      systemPrompt: string;
      permissions: Record<string, string>;
    }> = [];

    const createMockAgentForLaunch = (launch: {
      role: string;
      cwd: string;
      systemPrompt: string;
    }) => {
      const permissions: Record<string, string> = {};
      recordedLaunches.push({
        role: launch.role,
        cwd: launch.cwd,
        systemPrompt: launch.systemPrompt,
        permissions
      });
      let isCancelled = false;
      return new AgentApp({ name: `mock-${launch.role}` })
        .onRequest(AGENT_METHODS.initialize, async () => ({
          protocolVersion: PROTOCOL_VERSION,
          agentCapabilities: { loadSession: false }
        }))
        .onRequest(AGENT_METHODS.session_new, async () => ({
          sessionId: `acp-${launch.role}-${recordedLaunches.length}`
        }))
        .onRequest(AGENT_METHODS.session_prompt, async ({ params, client }) => {
          const text = params.prompt
            .map((block) => (block.type === "text" ? block.text : ""))
            .join("");
          if (text.includes("HOLD_OPEN")) {
            for (let index = 0; index < 60 && !isCancelled; index++) {
              await delay(50);
            }
            return { stopReason: isCancelled ? "cancelled" : "end_turn" };
          }
          for (const toolName of [
            "mcp__filesystem__read_text_file",
            "mcp__filesystem__write_file",
            "mcp__playwright__browser_navigate"
          ]) {
            const resp = await client.request(
              CLIENT_METHODS.session_request_permission,
              {
                sessionId: params.sessionId,
                toolCall: {
                  toolCallId: `tc-${toolName}`,
                  name: toolName,
                  rawInput: { path: path.join(launch.cwd, "demo.ts") }
                },
                options: [
                  { optionId: "allow", name: "Allow", kind: "allow_once" },
                  { optionId: "reject", name: "Reject", kind: "reject_once" }
                ]
              }
            );
            permissions[toolName] =
              resp.outcome.outcome === "selected"
                ? resp.outcome.optionId
                : resp.outcome.outcome;
          }
          await client.notify("session/update", {
            sessionId: params.sessionId,
            update: {
              sessionUpdate: "agent_message_chunk",
              content: {
                type: "text",
                text: `role=${launch.role} reply=${text}`
              }
            }
          });
          return { stopReason: "end_turn" };
        })
        .onNotification(AGENT_METHODS.session_cancel, () => {
          isCancelled = true;
        })
        .onRequest(AGENT_METHODS.session_close, async () => ({}));
    };

    const manager = new XacpxSessionManager({
      acpTransportFactory: (launch) => ({
        target: createMockAgentForLaunch(launch)
      })
    });
    const ipcServer = await startXacpxOrchestrationIpcServer({
      socketPath,
      manager,
      authorizedWorkspaceRoot: workspace,
      maxConcurrentChildrenPerCoordinator: 2,
      repositoryRoot: repository
    });

    const executable = resolveSupergateway(path.join(repository, "runtime", "src"));
    const keyFileA = path.join(root, "supergateway-a.key");
    const keyFileB = path.join(root, "supergateway-b.key");
    const headerFileA = path.join(root, "supergateway-a.header");
    const tokenA = "xacpx-coord-a-token";
    const tokenB = "xacpx-coord-b-token";
    privateWrite(keyFileA, tokenA + "\n");
    privateWrite(headerFileA, `Bearer ${tokenA}\n`);
    privateWrite(keyFileB, tokenB + "\n");
    const portA = await allocateLoopbackPort();
    const portB = await allocateLoopbackPort();

    const catalogue = {
      filesystem: {
        command: process.execPath,
        args: [path.join(repository, "runtime/src/mcp/launcher.ts"), "filesystem"]
      },
      xacpx: {
        command: process.execPath,
        args: [path.join(repository, "runtime/src/mcp/launcher.ts"), "xacpx"]
      }
    };
    const grants = {
      filesystem: ["read_text_file", "write_file"],
      xacpx: [
        "delegate_request",
        "task_get",
        "task_list",
        "task_watch",
        "task_cancel",
        "agent_list",
        "agent_send"
      ]
    };
    const configA = path.join(root, "supergateway-a.json");
    const configB = path.join(root, "supergateway-b.json");
    const makeConfig = (port: number, keyFile: string) =>
      renderGatewayConfig(
        path.dirname(configA),
        catalogue,
        [{ role: "orchestrator", grants: grants, reviewed: grants }],
        workspace,
        { port, apiKeyFile: keyFile },
        (server) =>
          externalMcpBackend(
            server,
            repository,
            workspace,
            process.execPath,
            home,
            codexHome,
            { role: "orchestrator" }
          )
      );
    writeFileSync(configA, makeConfig(portA, keyFileA));
    writeFileSync(configB, makeConfig(portB, keyFileB));

    const environmentA = chatgptSupergatewayEnvironment(
      { home, codexHome, repositoryRoot: repository },
      workspace,
      process.execPath,
      process.env.PATH ?? "/usr/bin:/bin",
      {
        role: "orchestrator",
        coordinatorSession: "chatgpt-coord-a",
        xacpxSocketPath: socketPath
      }
    );
    const environmentB = chatgptSupergatewayEnvironment(
      { home, codexHome, repositoryRoot: repository },
      workspace,
      process.execPath,
      process.env.PATH ?? "/usr/bin:/bin",
      {
        role: "orchestrator",
        coordinatorSession: "chatgpt-coord-b",
        xacpxSocketPath: socketPath
      }
    );

    let gatewayA: ChildProcess | undefined;
    let gatewayB: ChildProcess | undefined;
    let proxyA: ChildProcess | undefined;
    const clientA = new Client({ name: "chatgpt-orch-a", version: "1.0.0" });
    const clientB = new Client({ name: "chatgpt-orch-b", version: "1.0.0" });
    // ChatGPT names the conversation on every tool call; delegation acts for
    // that conversation alone.
    const inConversation =
      (client: Client, conversation: string) =>
      (parameters: Parameters<Client["callTool"]>[0]) =>
        client.callTool({
          ...parameters,
          _meta: { "openai/session": conversation }
        });
    const callA = inConversation(clientA, "conversation-a");
    const callB = inConversation(clientB, "conversation-b");
    try {
      [gatewayA, gatewayB] = await Promise.all([
        startSupergatewayServer(executable, configA, workspace, environmentA, portA),
        startSupergatewayServer(executable, configB, workspace, environmentB, portB)
      ]);

      // Route coordinator A through real tunnel-client dev proxy when installed.
      let endpointA = new URL(`http://127.0.0.1:${portA}/orchestrator/mcp`);
      let requestInitA: RequestInit = {
        headers: { Authorization: `Bearer ${tokenA}` }
      };
      const tunnelBin = resolveCommandOnPath("tunnel-client");
      if (tunnelBin) {
        const urlFile = path.join(root, "proxy-a.json");
        const healthUrlFile = path.join(root, "health-a.url");
        proxyA = spawn(
          tunnelBin,
          [
            "dev",
            "proxy",
            "--mcp-server-url",
            `http://127.0.0.1:${portA}/orchestrator/mcp`,
            "--url-file",
            urlFile,
            "--health-url-file",
            healthUrlFile,
            "--readiness-timeout",
            "30s"
          ],
          {
            env: { ...process.env, ...tunnelClientMcpEnvironment(headerFileA) },
            stdio: ["ignore", "pipe", "pipe"]
          }
        );
        let proxyUrl: string | undefined;
        for (let attempt = 0; attempt < 150; attempt++) {
          await delay(200);
          try {
            const raw = readFileSync(urlFile, "utf8").trim();
            if (raw) {
              proxyUrl = (JSON.parse(raw) as { mcp_url?: string }).mcp_url;
              if (proxyUrl) break;
            }
          } catch {
            /*
            waiting for proxy readiness
            */
          }
        }
        assert.ok(proxyUrl, "tunnel-client dev proxy did not report mcp_url");
        endpointA = new URL(proxyUrl);
        requestInitA = {};
      }

      await clientA.connect(
        new StreamableHTTPClientTransport(endpointA, {
          requestInit: requestInitA
        }),
        { timeout: 45_000 }
      );
      await clientB.connect(
        new StreamableHTTPClientTransport(
          new URL(`http://127.0.0.1:${portB}/orchestrator/mcp`),
          {
            requestInit: { headers: { Authorization: `Bearer ${tokenB}` } }
          }
        ),
        { timeout: 45_000 }
      );

      // 1. Delegate writable worker and read-only explorer through canonical xacpx MCP.
      const workerDelegate = await callA({
        name: "xacpx__delegate_request",
        arguments: {
          targetAgent: "worker",
          role: "worker",
          workingDirectory: workspace,
          task: "implement-feature"
        }
      });
      assert.ok(
        !workerDelegate.isError,
        `worker delegation failed: ${JSON.stringify(workerDelegate)}`
      );
      const workerTaskId = (
        workerDelegate.structuredContent as { taskId?: string } | undefined
      )?.taskId;
      assert.ok(workerTaskId, "delegate_request must return taskId");

      const workerWatch = await callA({
        name: "xacpx__task_watch",
        arguments: { taskId: workerTaskId, timeoutMs: 10_000 }
      });
      assert.ok(!workerWatch.isError);
      assert.match(JSON.stringify(workerWatch), /completed/);

      const workerGet = await callA({
        name: "xacpx__task_get",
        arguments: { taskId: workerTaskId }
      });
      const workerGetText = JSON.stringify(workerGet);
      assert.match(workerGetText, /role=worker reply=/);
      assert.match(workerGetText, /<system_instructions>/);
      assert.match(workerGetText, /implement-feature/);

      const explorerDelegate = await callA({
        name: "xacpx__delegate_request",
        arguments: {
          targetAgent: "explorer",
          role: "explorer",
          workingDirectory: workspace,
          task: "inspect-module"
        }
      });
      assert.ok(!explorerDelegate.isError);
      const explorerTaskId = (
        explorerDelegate.structuredContent as { taskId?: string } | undefined
      )?.taskId;
      assert.ok(explorerTaskId);
      await callA({
        name: "xacpx__task_watch",
        arguments: { taskId: explorerTaskId, timeoutMs: 10_000 }
      });

      // Verify delegated role permissions and canonical role prompts!
      const workerLaunch = recordedLaunches.find((l) => l.role === "worker");
      const explorerLaunch = recordedLaunches.find(
        (l) => l.role === "explorer"
      );
      assert.ok(workerLaunch && explorerLaunch);
      assert.equal(
        workerLaunch.permissions.mcp__filesystem__write_file,
        "allow"
      );
      assert.equal(
        workerLaunch.permissions.mcp__playwright__browser_navigate,
        "reject"
      );
      assert.equal(
        explorerLaunch.permissions.mcp__filesystem__read_text_file,
        "allow"
      );
      assert.equal(
        explorerLaunch.permissions.mcp__filesystem__write_file,
        "reject"
      );
      assert.equal(
        explorerLaunch.permissions.mcp__playwright__browser_navigate,
        "reject"
      );
      assert.ok(workerLaunch.systemPrompt.length > 0);
      assert.ok(explorerLaunch.systemPrompt.length > 0);
      assert.notEqual(workerLaunch.systemPrompt, explorerLaunch.systemPrompt);

      // 2. Follow-up message to owned pinned child via agent_list + agent_send.
      const agentsA = await callA({
        name: "xacpx__agent_list",
        arguments: {}
      });
      const agentListA = (
        agentsA.structuredContent as
          { agents?: Array<{ handle: string; agent: string }> } | undefined
      )?.agents;
      assert.ok(agentListA && agentListA.length === 2);
      const workerHandle = agentListA.find((a) => a.agent === "worker")!.handle;

      const sendRes = await callA({
        name: "xacpx__agent_send",
        arguments: { to: workerHandle, message: "follow-up-step" }
      });
      assert.ok(!sendRes.isError);
      assert.match(JSON.stringify(sendRes), /injected/);

      // 3. Role escalation (orchestrator as child) and unknown role are denied.
      const escalate = await callA({
        name: "xacpx__delegate_request",
        arguments: {
          targetAgent: "orchestrator",
          role: "orchestrator",
          workingDirectory: workspace,
          task: "escalate"
        }
      });
      assert.equal(escalate.isError, true);
      assert.match(JSON.stringify(escalate), /escalation/i);

      const unknownRole = await callA({
        name: "xacpx__delegate_request",
        arguments: {
          targetAgent: "root-admin",
          role: "root-admin",
          workingDirectory: workspace,
          task: "unknown"
        }
      });
      assert.equal(unknownRole.isError, true);

      // 4. Out-of-workspace delegation is denied.
      const outsideDelegate = await callA({
        name: "xacpx__delegate_request",
        arguments: {
          targetAgent: "worker",
          role: "worker",
          workingDirectory: outsideDir,
          task: "escape-workspace"
        }
      });
      assert.equal(outsideDelegate.isError, true);
      assert.match(JSON.stringify(outsideDelegate), /confinement/i);

      // 5. Cross-session isolation: coordinator B cannot see, cancel, or message coordinator A's children.
      const listB = await callB({
        name: "xacpx__task_list",
        arguments: {}
      });
      assert.deepEqual(
        (listB.structuredContent as { tasks?: unknown[] } | undefined)?.tasks,
        []
      );
      const getFromB = await callB({
        name: "xacpx__task_get",
        arguments: { taskId: workerTaskId }
      });
      assert.equal(
        (getFromB.structuredContent as { task?: unknown } | undefined)?.task,
        null
      );
      const cancelFromB = await callB({
        name: "xacpx__task_cancel",
        arguments: { taskId: workerTaskId }
      });
      assert.equal(cancelFromB.isError, true);
      const sendFromB = await callB({
        name: "xacpx__agent_send",
        arguments: { to: workerHandle, message: "cross-session-hijack" }
      });
      assert.equal(sendFromB.isError, true);

      // 6. Lifecycle cancellation of an active child task.
      const runningDelegate = await callA({
        name: "xacpx__delegate_request",
        arguments: {
          targetAgent: "worker",
          role: "worker",
          workingDirectory: workspace,
          task: "HOLD_OPEN"
        }
      });
      assert.ok(!runningDelegate.isError);
      const runningTaskId = (
        runningDelegate.structuredContent as { taskId?: string } | undefined
      )?.taskId;
      assert.ok(runningTaskId);
      const cancelled = await callA({
        name: "xacpx__task_cancel",
        arguments: { taskId: runningTaskId }
      });
      assert.ok(!cancelled.isError);
      assert.match(JSON.stringify(cancelled), /cancelled/);
    } finally {
      await Promise.allSettled([clientA.close(), clientB.close()]);
      await stopProcess(proxyA);
      await stopProcess(gatewayA);
      await stopProcess(gatewayB);
      await ipcServer.close();
      await manager.closeAllSessions();
      rmSync(root, { recursive: true, force: true });
    }
  }
);

test(
  "a conversation-scoped pooled backend gives each ChatGPT conversation its own coordinator and refuses calls without one",
  { timeout: 30_000 },
  async () => {
    const root = realpathSync(
      mkdtempSync(path.join(tmpdir(), "autodev-conversation-pool-"))
    );
    const serverScript = path.join(root, "coordinator-fixture.mjs");
    writeFileSync(
      serverScript,
      String.raw`import { createInterface } from "node:readline";
const lines = createInterface({ input: process.stdin });
const send = (m) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...m }) + "\n");
lines.on("line", (line) => {
  const m = JSON.parse(line);
  if (m.method === "initialize") {
    send({ id: m.id, result: { protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "coordinator-fixture", version: "1" } } });
  } else if (m.method === "tools/list") {
    send({ id: m.id, result: { tools: [{ name: "whoami", inputSchema: { type: "object" } }] } });
  } else if (m.method === "tools/call") {
    send({ id: m.id, result: { content: [{ type: "text", text: process.env.AUTODEV_XACPX_COORDINATOR_SESSION + "|" + process.argv.slice(2).join(" ") }] } });
  }
});
`,
      { mode: 0o600 }
    );
    const pool = await startChatgptBackendPool(
      {
        version: 1,
        servers: {
          "orchestrator.xacpx": {
            kind: "stdio",
            server: "xacpx",
            env: {
              AUTODEV_AGENT_ROLE: "orchestrator",
              AUTODEV_XACPX_COORDINATOR_SESSION: "chatgpt:orchestrator:project"
            },
            conversationScopedEnv: "AUTODEV_XACPX_COORDINATOR_SESSION",
            command: process.execPath,
            args: [serverScript],
            cwd: root,
            tools: ["whoami"]
          }
        }
      },
      {
        gatewayEnv: { HOME: root, PATH: process.env.PATH ?? "/usr/bin:/bin" },
        idleTimeoutMs: 60_000,
        maxConversations: 2
      }
    );
    try {
      const url = `http://127.0.0.1:${pool.port}/mcp/orchestrator.xacpx`;
      const headers = {
        "content-type": "application/json",
        authorization: `Bearer ${pool.token}`
      };
      const post = async (sessionId: string | null, body: unknown) => {
        const response = await fetch(url, {
          method: "POST",
          headers: sessionId
            ? { ...headers, "mcp-session-id": sessionId }
            : headers,
          body: JSON.stringify(body)
        });
        return {
          sessionId: response.headers.get("mcp-session-id"),
          body: (await response.json()) as {
            result?: { content: Array<{ text: string }>; tools?: unknown[] };
            error?: { message: string };
          }
        };
      };
      // ChatGPT opens a fresh MCP session per tool call; only the
      // conversation identity in the call's metadata ties calls together.
      const call = async (meta: Record<string, unknown> | undefined) => {
        const init = await post(null, {
          jsonrpc: "2.0",
          id: 0,
          method: "initialize",
          params: { protocolVersion: "2025-03-26", capabilities: {} }
        });
        assert.ok(init.sessionId);
        assert.ok(init.body.result, JSON.stringify(init.body));
        return (
          await post(init.sessionId, {
            jsonrpc: "2.0",
            id: 1,
            method: "tools/call",
            params: {
              name: "whoami",
              arguments: {},
              ...(meta && { _meta: meta })
            }
          })
        ).body;
      };
      const identity = (body: Awaited<ReturnType<typeof call>>) =>
        body.result?.content[0]?.text.split("|", 1)[0];

      const a1 = await call({ "openai/session": "conversation-A" });
      const a2 = await call({
        "openai/session": "conversation-A",
        "openai/locale": "en"
      });
      const b = await call({ "openai/session": "conversation-B" });
      assert.ok(identity(a1), JSON.stringify(a1));
      assert.equal(identity(a1), identity(a2));
      assert.notEqual(identity(a1), identity(b));
      for (const body of [a1, b]) {
        assert.match(
          identity(body)!,
          /^chatgpt:orchestrator:project:conversation-[0-9a-f]{24}$/u
        );
        // The raw platform identifier never reaches the backend.
        assert.doesNotMatch(
          body.result!.content[0]!.text,
          /conversation-[AB]/u
        );
      }
      // Discovery never needs a conversation; delegation always does.
      const listed = await post(
        (
          await post(null, {
            jsonrpc: "2.0",
            id: 0,
            method: "initialize",
            params: { protocolVersion: "2025-03-26", capabilities: {} }
          })
        ).sessionId,
        { jsonrpc: "2.0", id: 1, method: "tools/list" }
      );
      assert.equal(listed.body.result?.tools?.length, 1);
      for (const meta of [
        undefined,
        {},
        { "openai/session": "" },
        { "openai/session": 7 }
      ]) {
        const refused = await call(meta);
        assert.equal(refused.result, undefined);
        assert.match(refused.error?.message ?? "", /conversation identity/u);
      }
      assert.equal(pool.stats()["orchestrator.xacpx"]?.conversations, 2);
      // A third conversation evicts the least recently used idle one.
      const c = await call({ "openai/session": "conversation-C" });
      assert.notEqual(identity(c), identity(a1));
      assert.equal(pool.stats()["orchestrator.xacpx"]?.conversations, 2);
    } finally {
      await pool.close();
      rmSync(root, { recursive: true, force: true });
    }
  }
);

test(
  "pooled loopback backend host coalesces many one-shot sessions onto one backend process, enforces auth/grants, reaps idle backends, and cleans up process groups",
  { timeout: 30_000 },
  async () => {
    const root = realpathSync(
      mkdtempSync(path.join(tmpdir(), "autodev-backend-pool-"))
    );
    const spawnLog = path.join(root, "spawns.log");
    const grandchildPidFile = path.join(root, "grandchild.pid");
    const serverScript = path.join(root, "pooled-fixture.mjs");
    writeFileSync(
      serverScript,
      String.raw`import { spawn } from "node:child_process";
import { appendFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
appendFileSync(${JSON.stringify(spawnLog)}, process.pid + "\n");
const gc = spawn(process.execPath, ["-e", "setInterval(() => {}, 60_000)"], { stdio: "ignore" });
writeFileSync(${JSON.stringify(grandchildPidFile)}, String(gc.pid));
let changed = false;
const lines = createInterface({ input: process.stdin });
const send = (m) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...m }) + "\n");
lines.on("line", (line) => {
  const m = JSON.parse(line);
  if (m.method === "initialize") {
    send({ id: m.id, result: { protocolVersion: "2025-03-26", capabilities: { tools: { listChanged: true }, resources: {}, prompts: {} }, serverInfo: { name: "pooled-fixture", version: "1" } } });
  } else if (m.method === "tools/list") {
    const tools = [{ name: "echo", inputSchema: { type: "object" } }, { name: "hidden", inputSchema: { type: "object" } }];
    if (changed) tools.push({ name: "extra", inputSchema: { type: "object" } });
    send({ id: m.id, result: { tools } });
  } else if (m.method === "tools/call") {
    if (m.params?.arguments?.change) {
      changed = true;
      send({ method: "notifications/tools/list_changed" });
    }
    send({ id: m.id, result: { content: [{ type: "text", text: "ok:" + (m.params?.arguments?.n ?? "") }] } });
  }
});
`,
      { mode: 0o600 }
    );

    const pool = await startChatgptBackendPool(
      {
        version: 1,
        servers: {
          "orchestrator.demo": {
            kind: "stdio",
            server: "demo",
            env: {
              AUTODEV_AGENT_ROLE: "orchestrator",
              AUTODEV_XACPX_COORDINATOR_SESSION: "chatgpt:orchestrator:project"
            },
            command: process.execPath,
            args: [serverScript],
            cwd: root,
            tools: ["echo", "extra"]
          }
        }
      },
      {
        gatewayEnv: {
          HOME: root,
          PATH: process.env.PATH ?? "/usr/bin:/bin"
        },
        idleTimeoutMs: 250
      }
    );

    let grandchildPid = 0;
    try {
      const url = `http://127.0.0.1:${pool.port}/mcp/orchestrator.demo`;
      // Unauthenticated request is rejected with 401.
      const unauth = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" })
      });
      assert.equal(unauth.status, 401);
      await unauth.text();

      const authHeaders = {
        "content-type": "application/json",
        authorization: `Bearer ${pool.token}`
      };
      const runOneShotSession = async (n: number) => {
        const initRes = await fetch(url, {
          method: "POST",
          headers: authHeaders,
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 0,
            method: "initialize",
            params: { protocolVersion: "2025-03-26", capabilities: {} }
          })
        });
        assert.equal(initRes.status, 200);
        const sid = initRes.headers.get("mcp-session-id");
        assert.ok(sid);
        const initBody = (await initRes.json()) as {
          result: { capabilities: Record<string, unknown> };
        };
        assert.equal(initBody.result.capabilities.resources, undefined);
        assert.equal(initBody.result.capabilities.prompts, undefined);

        const listRes = await fetch(url, {
          method: "POST",
          headers: { ...authHeaders, "mcp-session-id": sid },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" })
        });
        const listBody = (await listRes.json()) as {
          result: { tools: Array<{ name: string }> };
        };
        assert.ok(listBody.result.tools.every((t) => t.name !== "hidden"));

        const callRes = await fetch(url, {
          method: "POST",
          headers: { ...authHeaders, "mcp-session-id": sid },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 2,
            method: "tools/call",
            params: { name: "echo", arguments: { n } }
          })
        });
        const callBody = (await callRes.json()) as {
          result: { content: Array<{ text: string }> };
        };
        assert.equal(callBody.result.content[0]?.text, `ok:${n}`);

        // Denied tool fails closed without touching backend.
        const deniedRes = await fetch(url, {
          method: "POST",
          headers: { ...authHeaders, "mcp-session-id": sid },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 3,
            method: "tools/call",
            params: { name: "hidden", arguments: {} }
          })
        });
        const deniedBody = (await deniedRes.json()) as {
          error?: { code: number; message: string };
        };
        assert.equal(deniedBody.error?.code, -32_601);
        // Deliberately do NOT send DELETE — mirroring ChatGPT's abandoned one-shot sessions.
      };

      // Burst 15 concurrent one-shot sessions + 5 sequential ones -> must coalesce onto 1 process!
      await Promise.all(
        Array.from({ length: 15 }, (_, index) => runOneShotSession(index))
      );
      for (let index = 15; index < 20; index++) {
        await runOneShotSession(index);
      }
      assert.equal(pool.stats()["orchestrator.demo"]?.spawns, 1);
      const spawnedPids = readFileSync(spawnLog, "utf8")
        .trim()
        .split("\n")
        .filter(Boolean);
      assert.equal(spawnedPids.length, 1);

      // Wait for idle reaping (>250ms): process stops cleanly, yet cached
      // initialize + tools/list still serve without respawning!
      await delay(450);
      assert.equal(pool.stats()["orchestrator.demo"]?.running, false);
      const initCached = await fetch(url, {
        method: "POST",
        headers: authHeaders,
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 0,
          method: "initialize",
          params: { protocolVersion: "2025-03-26", capabilities: {} }
        })
      });
      assert.equal(initCached.status, 200);
      const cachedSid = initCached.headers.get("mcp-session-id")!;
      await initCached.text();
      const listCached = await fetch(url, {
        method: "POST",
        headers: { ...authHeaders, "mcp-session-id": cachedSid },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" })
      });
      assert.equal(listCached.status, 200);
      await listCached.text();
      assert.equal(pool.stats()["orchestrator.demo"]?.spawns, 1);
      assert.equal(pool.stats()["orchestrator.demo"]?.running, false);

      // Next real tools/call lazily respawns exactly once and records grandchild PID.
      await runOneShotSession(99);
      assert.equal(pool.stats()["orchestrator.demo"]?.spawns, 2);
      grandchildPid = Number(readFileSync(grandchildPidFile, "utf8").trim());
      assert.ok(Number.isInteger(grandchildPid) && grandchildPid > 0);
      process.kill(grandchildPid, 0);
    } finally {
      await pool.close();
      if (grandchildPid > 0) {
        let isDead = false;
        for (let index = 0; index < 40; index++) {
          try {
            process.kill(grandchildPid, 0);
          } catch {
            isDead = true;
            break;
          }
          await delay(50);
        }
        if (!isDead) {
          try {
            process.kill(grandchildPid, "SIGKILL");
          } catch {
            /*
            ignore
            */
          }
        }
        assert.equal(
          isDead,
          true,
          `Pooled backend grandchild ${grandchildPid} survived pool.close()`
        );
      }
      rmSync(root, { recursive: true, force: true });
    }
  }
);

test(
  "pinned Supergateway with pooled loopback backend serves 15 abandoned one-shot sessions with a single backend spawn",
  {
    skip: process.env.AUTODEV_TEST_SUPERGATEWAY !== "1",
    timeout: 180_000
  },
  async () => {
    const root = realpathSync(
      mkdtempSync(path.join(tmpdir(), "autodev-supergateway-pooled-"))
    );
    const workspace = path.join(root, "workspace");
    mkdirSync(workspace);
    const spawnLog = path.join(root, "spawns.log");
    const backendScript = path.join(root, "pooled-mcp.mjs");
    writeFileSync(
      backendScript,
      String.raw`import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";
appendFileSync(${JSON.stringify(spawnLog)}, process.pid + "\n");
const lines = createInterface({ input: process.stdin });
const send = (m) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...m }) + "\n");
lines.on("line", (line) => {
  const m = JSON.parse(line);
  if (m.method === "initialize") {
    send({ id: m.id, result: { protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "pooled-mcp", version: "1" } } });
  } else if (m.method === "tools/list") {
    send({ id: m.id, result: { tools: [{ name: "ping_tool", inputSchema: { type: "object" } }] } });
  } else if (m.method === "tools/call") {
    send({ id: m.id, result: { content: [{ type: "text", text: "pong:" + (m.params?.arguments?.i ?? "") }] } });
  }
});
`,
      { mode: 0o600 }
    );

    const executable = resolveSupergateway(path.join(repository, "runtime", "src"));
    const configPath = path.join(root, "supergateway.json");
    const poolConfigPath = path.join(root, "backend-pool.json");
    const keyFile = path.join(root, "supergateway.key");
    const localToken = "pooled-supergateway-token";
    privateWrite(keyFile, localToken + "\n");
    const mcpPort = await allocateLoopbackPort();
    const catalogue = {
      demo: { command: process.execPath, args: [backendScript] }
    };
    const grants = { demo: ["ping_tool"] };
    const poolJson = renderChatgptBackendPoolConfig(
      catalogue,
      [{ role: "orchestrator", grants: grants, reviewed: grants }],
      workspace
    );
    writeFileSync(poolConfigPath, poolJson);
    writeFileSync(
      configPath,
      renderGatewayConfig(
        path.dirname(configPath),
        catalogue,
        [{ role: "orchestrator", grants: grants, reviewed: grants }],
        workspace,
        {
          port: mcpPort,
          apiKeyFile: keyFile,
          sessionTimeout: DEFAULT_CHATGPT_SESSION_TIMEOUT_MS
        }
      )
    );
    const baseEnvironment = {
      HOME: root,
      CODEX_HOME: root,
      PATH: process.env.PATH ?? "/usr/bin:/bin"
    };

    // 1. Installer probe passes end-to-end against pooled config + sibling backend-pool.json.
    await probeSupergateway(executable, configPath, baseEnvironment);

    // Clear spawn log after probe to measure steady-state one-shot session bursts.
    writeFileSync(spawnLog, "");
    const pool = await startChatgptBackendPool(JSON.parse(poolJson), {
      gatewayEnv: baseEnvironment
    });
    let gateway: ChildProcess | undefined;
    try {
      gateway = await startSupergatewayServer(
        executable,
        configPath,
        workspace,
        {
          ...baseEnvironment,
          [CHATGPT_MCP_POOL_PORT_ENV]: String(pool.port),
          [CHATGPT_MCP_POOL_TOKEN_ENV]: pool.token
        },
        mcpPort
      );
      const endpoint = new URL(`http://127.0.0.1:${mcpPort}/orchestrator/mcp`);
      const sessionIds = new Set<string>();
      await Promise.all(
        Array.from({ length: 15 }, async (_, index) => {
          const client = new Client({ name: `burst-${index}`, version: "1.0.0" });
          const transport = new StreamableHTTPClientTransport(endpoint, {
            requestInit: {
              headers: { Authorization: `Bearer ${localToken}` }
            }
          });
          await client.connect(transport, { timeout: 20_000 });
          assert.ok(transport.sessionId);
          sessionIds.add(transport.sessionId);
          const listed = await client.listTools();
          assert.deepEqual(
            listed.tools.map((t) => t.name),
            ["demo__ping_tool"]
          );
          const res = await client.callTool({
            name: "demo__ping_tool",
            arguments: { i: index }
          });
          assert.match(JSON.stringify(res), new RegExp(`pong:${index}`));
          // Deliberately abandon without client.close() / DELETE (ChatGPT behavior).
        })
      );
      assert.equal(sessionIds.size, 15);
      const spawns = readFileSync(spawnLog, "utf8")
        .trim()
        .split("\n")
        .filter(Boolean);
      assert.equal(
        spawns.length,
        1,
        `Expected 1 coalesced backend spawn across 15 sessions, saw ${spawns.length}`
      );
    } finally {
      await stopProcess(gateway);
      await pool.close();
      rmSync(root, { recursive: true, force: true });
    }
  }
);
