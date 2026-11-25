import assert from "node:assert/strict";
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { createServer as createHttpServer } from "node:http";
import { createServer as createNetServer } from "node:net";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
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
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ToolListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";

import {
  chatgptSupergatewayEnvironment,
  renderChatgptSupergatewayConfig
} from "../src/config/render-chatgpt-supergateway.ts";
import { probeSupergateway } from "../src/mcp/chatgpt-supergateway-probe.ts";
import {
  externalMcpBackend,
  filesystemSandboxProfile
} from "../src/mcp/chatgpt-filesystem-sandbox.ts";
import {
  assertTunnelScope,
  chatgptTunnelStatus,
  checkChatgptTunnel,
  createTunnel,
  dependencyEnvironment,
  ensureChatgptTunnel,
  type ChatgptTunnelDependencies,
  privateRead,
  privateWrite,
  ready,
  resolveSupergateway,
  runChatgptTunnelDaemon,
  tunnelClientMcpEnv,
  tunnelClientSupported,
  tunnelMetadata,
  validateRuntimeKey
} from "../src/platform/chatgpt-tunnel-install.ts";
import { resolveCocoIndexBinary } from "../src/shared/executables.ts";
import { resolveCommandOnPath } from "../src/platform/runtime-files.ts";

const repo = fileURLToPath(new URL("../../", import.meta.url));

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
  if (!exited && proc.exitCode === null && proc.signalCode === null) {
    proc.kill("SIGKILL");
    await once(proc, "exit").catch(() => {});
  }
}

async function startSupergatewayServer(
  executable: string,
  config: string,
  cwd: string,
  env: Record<string, string>,
  port: number
): Promise<ChildProcess> {
  let logs = "";
  const child = spawn(
    executable,
    ["--config", config, "--exitWithProcess", String(process.pid)],
    { cwd, env, stdio: ["pipe", "pipe", "pipe"] }
  );
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
      /* waiting for Supergateway */
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
    const env = chatgptSupergatewayEnvironment(
      {
        home: root,
        codexHome: path.join(root, ".codex"),
        repositoryRoot: repo
      },
      workspace,
      process.execPath,
      process.env.PATH ?? "/usr/bin:/bin"
    );
    let gateway: ChildProcess | undefined;
    try {
      mkdirSync(workspace);
      const inside = path.join(workspace, "inside.txt");
      const outside = path.join(root, "outside.txt");
      const secretEnv = path.join(workspace, ".env");
      const exampleEnv = path.join(workspace, ".env.example");
      writeFileSync(inside, "expected-value");
      writeFileSync(outside, "outside-value");
      writeFileSync(secretEnv, "OPENAI_ADMIN_KEY=super-secret-value\n");
      writeFileSync(exampleEnv, "OPENAI_ADMIN_KEY=\n");
      symlinkSync(outside, path.join(workspace, "escape.txt"));
      const executable = resolveSupergateway(repo);
      const config = path.join(root, "supergateway.json");
      const keyFile = path.join(root, "supergateway.key");
      const localToken = "fixture-supergateway-token";
      privateWrite(keyFile, localToken + "\n");
      const mcpPort = await allocateLoopbackPort();
      const catalogue = {
        filesystem: {
          command: process.execPath,
          args: [path.join(repo, "runtime/src/mcp/launcher.ts"), "filesystem"]
        }
      };
      const policy = {
        filesystem: ["read_text_file", "list_allowed_directories"]
      };
      writeFileSync(
        config,
        renderChatgptSupergatewayConfig(
          catalogue,
          policy,
          workspace,
          policy,
          { port: mcpPort, apiKeyFile: keyFile },
          undefined,
          (server) =>
            externalMcpBackend(server, repo, workspace, process.execPath)
        )
      );
      gateway = await startSupergatewayServer(
        executable,
        config,
        workspace,
        env,
        mcpPort
      );
      const endpoint = new URL(`http://127.0.0.1:${mcpPort}/mcp`);
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
        arguments: { path: exampleEnv }
      });
      assert.match(JSON.stringify(readExample), /OPENAI_ADMIN_KEY=/);
      for (const target of [
        outside,
        path.join(workspace, "escape.txt"),
        secretEnv
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
      await probeSupergateway(executable, config, env);
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
      path.join(repo, "runtime/src/mcp/chatgpt-supergateway-probe.ts"),
      link
    );
    const result = spawnSync(process.execPath, [link], { encoding: "utf8" });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Expected Supergateway executable and config/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("external sandbox admits reviewed workspace backends under Seatbelt and rejects unreviewed servers", () => {
  const lspBackend = externalMcpBackend("lsp", repo, repo, process.execPath);
  assert.equal(lspBackend.command, "/usr/bin/sandbox-exec");
  assert.match(lspBackend.args[1]!, /\(allow signal \(target same-sandbox\)\)/);
  assert.doesNotMatch(lspBackend.args[1]!, /\(allow ipc-sysv\*\)/);

  const cccBackend = externalMcpBackend(
    "cocoindex-code",
    repo,
    repo,
    process.execPath
  );
  assert.equal(cccBackend.command, "/usr/bin/sandbox-exec");
  assert.match(cccBackend.args[1]!, /\(allow signal \(target same-sandbox\)\)/);
  assert.match(cccBackend.args[1]!, /\(allow ipc-posix\*\)/);
  assert.match(cccBackend.args[1]!, /\(allow ipc-sysv\*\)/);

  for (const reviewed of ["filesystem", "codegraphcontext"]) {
    const backend = externalMcpBackend(reviewed, repo, repo, process.execPath);
    assert.equal(backend.command, "/usr/bin/sandbox-exec");
  }
  for (const server of [
    "playwright",
    "playtest",
    "github",
    "xacpx",
    "codex_app"
  ])
    assert.throws(
      () => externalMcpBackend(server, repo, repo, process.execPath),
      /No externally confined/
    );
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
    const backend = externalMcpBackend("filesystem", repo, repo, shim);
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
    const envFile = path.join(workspace, ".env");
    writeFileSync(envFile, "SECRET=1", { mode: 0o600 });
    const envLocal = path.join(nested, ".env.local");
    writeFileSync(envLocal, "SECRET=2", { mode: 0o600 });
    const envExampleBak = path.join(workspace, ".env.example.bak");
    writeFileSync(envExampleBak, "SECRET=3", { mode: 0o600 });
    const envSymlink = path.join(workspace, "env-alias.txt");
    symlinkSync(envFile, envSymlink);
    const envExample = path.join(workspace, ".env.example");
    writeFileSync(envExample, "EXAMPLE=1");
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
        realpathSync(path.join(repo, "node_modules")),
        node
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
          envExample,
          protectedFile,
          outsideExample,
          envFile,
          envLocal,
          envExampleBak,
          envSymlink,
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

test("tunnel listener must belong to the actual launchd job or its spawned tunnel child", async () => {
  const launchd = { print: () => "\tpid = 123\n" };
  let probes = 0;
  const probe = async () => {
    probes++;
    return true;
  };
  assert.equal(
    await ready(launchd, 3311, {
      listeners: () => ["456"],
      probe,
      parentPid: () => "1"
    }),
    false
  );
  assert.equal(probes, 0);
  assert.equal(
    await ready(launchd, 3311, { listeners: () => ["123", "456"], probe }),
    false
  );
  assert.equal(
    await ready(launchd, 3311, { listeners: () => ["123"], probe }),
    true
  );
  assert.equal(
    await ready(launchd, 3311, {
      listeners: () => ["456"],
      probe,
      parentPid: (pid) => (pid === "456" ? "123" : null)
    }),
    true
  );
  assert.equal(
    await ready(launchd, 3311, {
      listeners: () => ["123"],
      probe: async () => false
    }),
    false
  );
  assert.equal(
    await ready(
      launchd,
      3311,
      {
        listeners: (target) => (target === 3311 ? ["456"] : ["789"]),
        probe,
        parentPid: (pid) => (pid === "456" || pid === "789" ? "123" : null)
      },
      3312
    ),
    true
  );
  assert.equal(
    await ready(
      launchd,
      3311,
      {
        listeners: (target) => (target === 3311 ? ["456"] : ["789"]),
        probe,
        parentPid: (pid) => (pid === "456" ? "123" : "1")
      },
      3312
    ),
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
        /unauthorized/.test(error.message) &&
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
      const executable = resolveSupergateway(repo);
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
        renderChatgptSupergatewayConfig(catalogue, grants, root, grants, {
          port: mcpPort,
          apiKeyFile: keyFile
        })
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
      const endpoint = new URL(`http://127.0.0.1:${mcpPort}/mcp`);
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
      // A fresh session starts its own backends; the formerly unavailable
      // backend now recovers, while the original session's state is unchanged.
      const recovered = await connect();
      assert.deepEqual(await names(recovered), [
        "conditional__read",
        "stable__image",
        "stable__read",
        "stable__slow"
      ]);
      assert.ok(!(await names(client)).includes("conditional__read"));
      await recovered.callTool({
        name: "stable__read",
        arguments: { exit: true }
      });
      for (let attempt = 0; attempt < 30; attempt++) {
        if (!(await names(recovered)).includes("stable__read")) break;
        await delay(100);
      }
      assert.deepEqual(await names(recovered), ["conditional__read"]);
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
          ...(request.headers.authorization
            ? { authorization: request.headers.authorization }
            : {})
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
  assert.deepEqual(tunnelClientMcpEnv(headerFile), {
    MCP_OAUTH_DISCOVERY: "disabled",
    MCP_EXTRA_HEADERS: `Authorization: file:${headerFile}`,
    MCP_DISCOVERY_EXTRA_HEADERS: `Authorization: file:${headerFile}`
  });
});

test(
  "mocked installer lifecycle stores credential in Keychain, migrates legacy stdio/runtime.key, and supports disable and rotation",
  { timeout: 30_000 },
  async () => {
    const root = realpathSync(
      mkdtempSync(path.join(tmpdir(), "external-mcp-install-"))
    );
    const home = path.join(root, "home");
    const codexHome = path.join(home, ".codex");
    const workspace = path.join(home, "project");
    const paths = { home, codexHome, repositoryRoot: repo };
    const events: string[] = [];
    let running = false;
    let failReady = false;
    let wrongScope = false;
    let rejectKey = false;
    let keychainValue: string | null = null;
    const launchd = {
      isLoaded: () => running,
      print: () => "pid = 123",
      bootout: () => {
        events.push("stop");
        running = false;
      },
      disable: () => {
        events.push("disable");
      },
      enable: () => {
        events.push("enable");
      },
      bootstrap: () => {
        events.push("start");
        running = true;
      }
    };
    const deps: ChatgptTunnelDependencies = {
      platform: "darwin",
      launchd: () => launchd,
      node: () => process.execPath,
      tunnelBinary: () => "/fixture/tunnel-client",
      supergateway: () => "/fixture/supergateway",
      backend: () => ({ command: "/fixture/filesystem", args: [] }),
      hasSecret: (name) => name === "CONTEXT7_API_KEY",
      discoverTools: async (server) =>
        server === "filesystem"
          ? ["read_text_file", "list_allowed_directories"]
          : server === "lsp"
            ? ["lsp_find_symbol", "lsp_workspace_diagnostics"]
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
      metadata: (_binary, _args, env) => {
        if (rejectKey || !env.AUTODEV_CHATGPT_TUNNEL_API_KEY)
          throw new Error("unauthorized");
        return {
          id: "tunnel_fixture",
          organization_ids: ["org_fixture"],
          workspace_ids: [wrongScope ? "ws_wrong" : "ws_fixture"]
        };
      },
      create: () => {
        events.push("create");
        return "tunnel_fixture";
      },
      ready: async (_job, _port, mcpPort) => {
        assert.equal(mcpPort, 3312);
        return running && !failReady;
      },
      portFree: () => true,
      wait: async ({ probe }) => probe(),
      withCandidateGateway: async (_exec, _config, env, _cwd, fn) => {
        assert.equal(env.AUTODEV_CHATGPT_TUNNEL_API_KEY, undefined);
        return fn("http://127.0.0.1:49999/mcp");
      },
      run: (_command, args, options) => {
        assert.ok(!options.env.OPENAI_ADMIN_KEY);
        events.push(args[0] ?? "command");
        if (args[0] === "init") {
          assert.ok(!options.env.AUTODEV_CHATGPT_TUNNEL_API_KEY);
          const generation = args[args.indexOf("--profile-dir") + 1]!;
          assert.equal(
            args[args.indexOf("--sample") + 1],
            "sample_mcp_remote_no_auth"
          );
          assert.equal(
            args[args.indexOf("--mcp-server-url") + 1],
            "http://127.0.0.1:3312/mcp"
          );
          assert.equal(
            args[args.indexOf("--control-plane-api-key-ref") + 1],
            "env:AUTODEV_CHATGPT_TUNNEL_API_KEY"
          );
          writeFileSync(
            path.join(generation, "autodev.yaml"),
            [
              "control_plane:",
              '  api_key: "env:AUTODEV_CHATGPT_TUNNEL_API_KEY"',
              "health:",
              '  listen_addr: "127.0.0.1:3311"',
              '  # url_file: "/tmp/tunnel-client-health.url"',
              "mcp:",
              "  server_urls:",
              "    - channel: main",
              '      url: "http://127.0.0.1:3312/mcp"'
            ].join("\n") + "\n"
          );
        } else if (args[0] === "doctor") {
          assert.ok(options.env.AUTODEV_CHATGPT_TUNNEL_API_KEY);
          assert.equal(options.env.MCP_OAUTH_DISCOVERY, "disabled");
          assert.match(
            options.env.MCP_EXTRA_HEADERS ?? "",
            /^Authorization: file:/
          );
          assert.match(
            options.env.MCP_DISCOVERY_EXTRA_HEADERS ?? "",
            /^Authorization: file:/
          );
          assert.equal(
            args[args.indexOf("--mcp.server-url") + 1],
            "url=http://127.0.0.1:49999/mcp,channel=main"
          );
        }
      },
      readKey: () => keychainValue,
      writeKey: (key) => {
        keychainValue = key;
      },
      deleteKey: () => {
        const had = keychainValue !== null;
        keychainValue = null;
        return had;
      }
    };
    const env = {
      HOME: home,
      PATH: "/bin",
      AUTODEV_CHATGPT_MCP_WORKSPACE: workspace,
      AUTODEV_CHATGPT_ORGANIZATION_ID: "org_fixture",
      AUTODEV_CHATGPT_WORKSPACE_ID: "ws_fixture",
      OPENAI_ADMIN_KEY: "fixture-admin",
      AUTODEV_CHATGPT_TUNNEL_API_KEY: "fixture-runtime"
    };
    const directory = path.join(codexHome, "chatgpt-tunnel");
    const stateFile = path.join(directory, "gateway.json");
    const plistFile = path.join(
      home,
      "Library",
      "LaunchAgents",
      "com.codex.autodev-chatgpt-tunnel.plist"
    );
    try {
      mkdirSync(workspace, { recursive: true });
      mkdirSync(path.join(codexHome, "provider-runtime"), { recursive: true });
      writeFileSync(
        path.join(codexHome, "provider-runtime", "mcp-servers.json"),
        JSON.stringify({
          filesystem: { command: "/fixture/filesystem", args: [] },
          lsp: { command: "/fixture/lsp", args: [] },
          "cocoindex-code": { command: "/fixture/ccc", args: [] },
          codegraphcontext: { command: "/fixture/cgc", args: [] },
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
      await ensureChatgptTunnel(paths, "reconcile", env, undefined, deps);
      assert.ok(!existsSync(stateFile));
      await ensureChatgptTunnel(paths, "enable", env, undefined, deps);
      const first = privateRead(stateFile);
      const firstState = JSON.parse(first);
      assert.equal(firstState.mcpPort, 3312);
      assert.equal(keychainValue, "fixture-runtime");
      assert.ok(
        !existsSync(path.join(directory, firstState.generation, "runtime.key"))
      );
      assert.ok(!existsSync(path.join(directory, "runtime.key")));
      assert.ok(
        privateRead(
          path.join(directory, firstState.generation, "supergateway.key")
        )
      );
      assert.match(
        privateRead(
          path.join(
            directory,
            firstState.generation,
            "supergateway-auth.header"
          )
        ),
        /^Bearer /
      );
      assert.match(
        readFileSync(plistFile, "utf8"),
        /chatgpt-tunnel-install\.ts/
      );
      assert.match(
        readFileSync(plistFile, "utf8"),
        /<key>ProcessType<\/key>\s*<string>Interactive<\/string>/
      );
      assert.equal((await chatgptTunnelStatus(paths, deps)).ready, true);
      assert.equal(events.filter((event) => event === "create").length, 1);
      const count = events.length;
      await ensureChatgptTunnel(paths, "reconcile", env, undefined, deps);
      assert.equal(events.length, count);
      assert.equal(privateRead(stateFile), first);
      await ensureChatgptTunnel(
        paths,
        "reconcile",
        {
          HOME: home,
          PATH: "/bin",
          OPENAI_ADMIN_KEY: "",
          AUTODEV_CHATGPT_TUNNEL_API_KEY: "",
          AUTODEV_CHATGPT_TUNNEL_PORT: "",
          AUTODEV_CHATGPT_MCP_WORKSPACE: "",
          AUTODEV_CHATGPT_MCP_POLICY_FILE: "",
          AUTODEV_CHATGPT_ORGANIZATION_ID: "",
          AUTODEV_CHATGPT_WORKSPACE_ID: ""
        },
        undefined,
        deps
      );
      assert.equal(events.length, count);
      assert.equal(privateRead(stateFile), first);
      // Simulate a legacy stdio installation (no mcpPort, stdio supergateway.json,
      // plaintext runtime.key, and commands:/file: profile): reconcile must migrate
      // cleanly to Streamable HTTP + Keychain + env:AUTODEV_CHATGPT_TUNNEL_API_KEY.
      const legacyKeyFile = path.join(
        directory,
        firstState.generation,
        "runtime.key"
      );
      privateWrite(legacyKeyFile, "fixture-runtime\n");
      writeFileSync(
        path.join(directory, firstState.generation, "autodev.yaml"),
        `api_key: file:${legacyKeyFile}\nmcp:\n  commands:\n    - channel: main\n      command: supergateway\n`
      );
      const { mcpPort: _legacyMcpPort, ...legacyStateWithoutMcpPort } =
        firstState;
      privateWrite(
        stateFile,
        JSON.stringify(legacyStateWithoutMcpPort, null, 2) + "\n"
      );
      assert.equal(await checkChatgptTunnel(paths, deps), false);
      keychainValue = null;
      await ensureChatgptTunnel(
        paths,
        "reconcile",
        { HOME: home, PATH: "/bin" },
        undefined,
        deps
      );
      assert.equal(keychainValue, "fixture-runtime");
      assert.ok(!existsSync(legacyKeyFile));
      const migratedState = JSON.parse(privateRead(stateFile));
      assert.equal(migratedState.mcpPort, 3312);
      assert.equal(await checkChatgptTunnel(paths, deps), true);
      // An older installation without policyDigest must automatically pick up
      // newly approved servers/tools from checked-in chatgpt-mcp-policy.json.
      const { policyDigest: _droppedDigest, ...staleGrantState } =
        migratedState;
      privateWrite(
        stateFile,
        JSON.stringify(
          {
            ...staleGrantState,
            grants: { filesystem: ["read_text_file"] }
          },
          null,
          2
        ) + "\n"
      );
      await ensureChatgptTunnel(
        paths,
        "reconcile",
        { HOME: home, PATH: "/bin" },
        undefined,
        deps
      );
      const policyUpgraded = JSON.parse(privateRead(stateFile));
      assert.ok(policyUpgraded.policyDigest);
      assert.match(
        policyUpgraded.policyFile,
        /\.rulesync\/permissions\.jsonc$/u
      );
      assert.deepEqual(Object.keys(policyUpgraded.grants).sort(), [
        "cocoindex-code",
        "codegraphcontext",
        "context7",
        "filesystem",
        "lsp",
        "openaiDeveloperDocs"
      ]);
      assert.match(
        readFileSync(
          path.join(directory, policyUpgraded.generation, "autodev.yaml"),
          "utf8"
        ),
        /env:AUTODEV_CHATGPT_TUNNEL_API_KEY/
      );
      // Daemon runner starts Supergateway (clean env) then tunnel-client (Keychain + auth header),
      // honoring staged candidates and explicit env overrides without plaintext tunnel files.
      assert.ok(!existsSync(path.join(directory, "staged.json")));
      const seenSpawns: Array<{
        cmd: string;
        args: string[];
        env: NodeJS.ProcessEnv;
      }> = [];
      const fakeSpawn = ((
        cmd: string,
        args: string[],
        opts: { env: NodeJS.ProcessEnv }
      ) => {
        seenSpawns.push({ cmd, args, env: opts.env });
        const listeners = new Map<
          string,
          Array<(code: number | null) => void>
        >();
        const proc = {
          exitCode: null as number | null,
          killed: false,
          kill: () => {
            proc.killed = true;
            queueMicrotask(() => {
              proc.exitCode = 0;
              for (const cb of listeners.get("exit") ?? []) cb(0);
            });
            return true;
          },
          once: (event: string, cb: (code: number | null) => void) => {
            const list = listeners.get(event) ?? [];
            list.push(cb);
            listeners.set(event, list);
            if (event === "exit" && cmd === "/fixture/tunnel-client") {
              queueMicrotask(() => {
                proc.exitCode = 0;
                cb(0);
              });
            }
          }
        };
        return proc;
      }) as unknown as typeof spawn;
      const stagedGen = path.join(directory, "generation-staged");
      mkdirSync(stagedGen, { recursive: true, mode: 0o700 });
      writeFileSync(
        path.join(stagedGen, "autodev.yaml"),
        "api_key: env:AUTODEV_CHATGPT_TUNNEL_API_KEY\n",
        { mode: 0o600 }
      );
      writeFileSync(path.join(stagedGen, "supergateway.json"), "{}\n", {
        mode: 0o600
      });
      privateWrite(path.join(stagedGen, "supergateway.key"), "staged-token\n");
      privateWrite(
        path.join(stagedGen, "supergateway-auth.header"),
        "Bearer staged-token\n"
      );
      const {
        version: _version,
        enabled: _enabled,
        ...stagedBase
      } = migratedState;
      privateWrite(
        path.join(directory, "staged.json"),
        JSON.stringify({
          ...stagedBase,
          generation: "generation-staged"
        })
      );
      assert.equal(
        await runChatgptTunnelDaemon(
          paths,
          { HOME: home },
          {
            readKey: () => keychainValue,
            spawnProcess: fakeSpawn,
            waitForGateway: async () => true
          }
        ),
        0
      );
      assert.equal(seenSpawns[0]?.cmd, "/fixture/supergateway");
      assert.equal(
        seenSpawns[0]?.args[1],
        path.join(stagedGen, "supergateway.json")
      );
      assert.equal(
        seenSpawns[0]?.env.AUTODEV_CHATGPT_TUNNEL_API_KEY,
        undefined
      );
      assert.equal(seenSpawns[1]?.cmd, "/fixture/tunnel-client");
      assert.equal(
        seenSpawns[1]?.args[2],
        path.join(stagedGen, "autodev.yaml")
      );
      assert.equal(seenSpawns[1]?.env.MCP_OAUTH_DISCOVERY, "disabled");
      assert.equal(
        seenSpawns[1]?.env.MCP_EXTRA_HEADERS,
        `Authorization: file:${path.join(stagedGen, "supergateway-auth.header")}`
      );
      rmSync(path.join(directory, "staged.json"), { force: true });
      rmSync(stagedGen, { recursive: true, force: true });
      assert.equal(
        await runChatgptTunnelDaemon(
          paths,
          { HOME: home },
          {
            readKey: () => keychainValue,
            spawnProcess: fakeSpawn,
            waitForGateway: async () => true
          }
        ),
        0
      );
      assert.equal(
        seenSpawns[3]?.env.AUTODEV_CHATGPT_TUNNEL_API_KEY,
        "fixture-runtime"
      );
      assert.equal(
        await runChatgptTunnelDaemon(
          paths,
          {
            HOME: home,
            AUTODEV_CHATGPT_TUNNEL_API_KEY: "explicit-daemon-override"
          },
          {
            readKey: () => keychainValue,
            spawnProcess: fakeSpawn,
            waitForGateway: async () => true
          }
        ),
        0
      );
      assert.equal(
        seenSpawns[5]?.env.AUTODEV_CHATGPT_TUNNEL_API_KEY,
        "explicit-daemon-override"
      );
      wrongScope = true;
      await assert.rejects(
        ensureChatgptTunnel(paths, "reconcile", env, undefined, deps),
        /does not belong/
      );
      wrongScope = false;
      rejectKey = true;
      await assert.rejects(
        ensureChatgptTunnel(paths, "reconcile", env, undefined, deps),
        /unauthorized/
      );
      rejectKey = false;
      const status = await chatgptTunnelStatus(paths, deps);
      const oldPlist = readFileSync(plistFile, "utf8");
      failReady = true;
      await assert.rejects(
        ensureChatgptTunnel(
          paths,
          "enable",
          env,
          {
            action: "rotate",
            expectedRevision: status.revision,
            runtimeKey: "fixture-new"
          },
          deps
        ),
        /previous service configuration retained/
      );
      failReady = false;
      assert.equal(keychainValue, "fixture-runtime");
      assert.equal(readFileSync(plistFile, "utf8"), oldPlist);
      assert.equal(running, true);
      await ensureChatgptTunnel(
        paths,
        "enable",
        env,
        {
          action: "rotate",
          expectedRevision: status.revision,
          runtimeKey: "fixture-new"
        },
        deps
      );
      assert.equal(keychainValue, "fixture-new");
      const rotated = await chatgptTunnelStatus(paths, deps);
      assert.notEqual(rotated.revision, status.revision);
      assert.ok(!JSON.stringify(rotated).includes("fixture-new"));
      await assert.rejects(
        ensureChatgptTunnel(
          paths,
          "disable",
          {},
          { action: "disable", expectedRevision: status.revision },
          deps
        ),
        /revision conflict/
      );
      await ensureChatgptTunnel(
        paths,
        "disable",
        {},
        { action: "disable", expectedRevision: rotated.revision },
        deps
      );
      assert.equal(running, false);
      assert.ok(!existsSync(plistFile));
      await ensureChatgptTunnel(paths, "reconcile", env, undefined, deps);
      assert.equal(running, false);
      const disabled = await chatgptTunnelStatus(paths, deps);
      await ensureChatgptTunnel(
        paths,
        "disable",
        {},
        { action: "forget", expectedRevision: disabled.revision },
        deps
      );
      assert.equal(keychainValue, null);
      const persisted = JSON.parse(privateRead(stateFile));
      assert.ok(
        !existsSync(
          path.join(directory, persisted.prior.generation, "runtime.key")
        )
      );
      await assert.rejects(
        ensureChatgptTunnel(paths, "enable", {}, undefined, deps),
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
    const envSpyPath = path.join(root, "local-env-keys.json");
    const envSpyScript = path.join(root, "local-code-tool.mjs");
    writeFileSync(
      envSpyScript,
      [
        'import { createInterface } from "node:readline";',
        'import { writeFileSync } from "node:fs";',
        `writeFileSync(${JSON.stringify(envSpyPath)}, JSON.stringify(Object.keys(process.env).sort()));`,
        "const rl = createInterface({ input: process.stdin });",
        'rl.on("line", (line) => {',
        "  const m = JSON.parse(line);",
        '  if (m.method === "initialize") {',
        '    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: m.params.protocolVersion, capabilities: { tools: {}, prompts: {}, resources: {} }, serverInfo: { name: "local-code", version: "1" } } }) + "\\n");',
        '  } else if (m.method === "ping") {',
        '    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: m.id, result: {} }) + "\\n");',
        '  } else if (m.method === "tools/list") {',
        '    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: m.id, result: { tools: [{ name: "find_symbol", inputSchema: { type: "object" } }, { name: "mutate", inputSchema: { type: "object" } }] } }) + "\\n");',
        '  } else if (m.method === "tools/call") {',
        '    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: m.id, result: { content: [{ type: "text", text: "symbol:" + (m.params.arguments?.name ?? "") }] } }) + "\\n");',
        "  }",
        "});"
      ].join("\n")
    );

    const remoteSessions = new Set<string>();
    const remoteServer = createHttpServer((req, res) => {
      if (req.headers.authorization !== "Bearer remote-context7-token") {
        res.writeHead(401).end("unauthorized");
        return;
      }
      if (req.method === "GET") {
        res.writeHead(405).end();
        return;
      }
      if (req.method === "DELETE") {
        res.writeHead(200).end();
        return;
      }
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        const msg = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        const sessionId =
          (typeof req.headers["mcp-session-id"] === "string" &&
            req.headers["mcp-session-id"]) ||
          "remote-sess-" + (remoteSessions.size + 1);
        remoteSessions.add(sessionId);
        if (msg.id === undefined) {
          res.writeHead(202, { "mcp-session-id": sessionId }).end();
          return;
        }
        let result: unknown = {};
        if (msg.method === "initialize") {
          result = {
            protocolVersion: msg.params.protocolVersion,
            capabilities: { tools: {}, prompts: {}, resources: {} },
            serverInfo: { name: "remote-docs", version: "1" }
          };
        } else if (msg.method === "tools/list") {
          result = {
            tools: [
              { name: "query-docs", inputSchema: { type: "object" } },
              { name: "hidden-admin", inputSchema: { type: "object" } }
            ]
          };
        } else if (msg.method === "tools/call") {
          result = {
            content: [
              { type: "text", text: "docs:" + (msg.params.arguments?.q ?? "") }
            ]
          };
        }
        res
          .writeHead(200, {
            "content-type": "application/json",
            "mcp-session-id": sessionId
          })
          .end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }));
      });
    });

    const client = new Client({ name: "multi-e2e", version: "1" });
    let gateway: ChildProcess | undefined;
    try {
      remoteServer.listen(0, "127.0.0.1");
      await once(remoteServer, "listening");
      const remoteAddr = remoteServer.address();
      assert.ok(remoteAddr && typeof remoteAddr !== "string");
      const executable = resolveSupergateway(repo);
      const config = path.join(root, "supergateway.json");
      const keyFile = path.join(root, "supergateway.key");
      const localToken = "multi-gateway-token";
      privateWrite(keyFile, localToken + "\n");
      const mcpPort = await allocateLoopbackPort();
      const catalogue = {
        filesystem: {
          command: process.execPath,
          args: [path.join(repo, "runtime/src/mcp/launcher.ts"), "filesystem"]
        },
        lsp: {
          command: process.execPath,
          args: [envSpyScript]
        },
        context7: {
          url: `http://127.0.0.1:${remoteAddr.port}/mcp`,
          bearer_token_env_var: "CONTEXT7_API_KEY"
        }
      };
      const policy = {
        filesystem: ["read_text_file"],
        lsp: ["find_symbol"],
        context7: ["query-docs"]
      };
      writeFileSync(
        config,
        renderChatgptSupergatewayConfig(
          catalogue,
          policy,
          workspace,
          policy,
          { port: mcpPort, apiKeyFile: keyFile },
          undefined,
          (server) =>
            server === "filesystem"
              ? externalMcpBackend(server, repo, workspace, process.execPath)
              : catalogue[server as "lsp"]
        )
      );
      const env = {
        ...chatgptSupergatewayEnvironment(
          { home: root, codexHome: root, repositoryRoot: repo },
          workspace,
          process.execPath,
          process.env.PATH ?? "/usr/bin:/bin"
        ),
        CONTEXT7_API_KEY: "remote-context7-token"
      };
      gateway = await startSupergatewayServer(
        executable,
        config,
        workspace,
        env,
        mcpPort
      );
      await client.connect(
        new StreamableHTTPClientTransport(
          new URL(`http://127.0.0.1:${mcpPort}/mcp`),
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
        "lsp__find_symbol"
      ]);
      const remoteTool = listed.tools.find(
        (t) => t.name === "context7__query-docs"
      );
      const localTool = listed.tools.find((t) => t.name === "lsp__find_symbol");
      assert.equal(remoteTool?.annotations?.openWorldHint, true);
      assert.equal(remoteTool?.annotations?.readOnlyHint, true);
      assert.equal(localTool?.annotations?.openWorldHint, false);

      const [fsRes, lspRes, c7Res] = await Promise.all([
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
        })
      ]);
      assert.match(JSON.stringify(fsRes), /multi-server-ok/);
      assert.match(JSON.stringify(lspRes), /symbol:Chatgpt/);
      assert.match(JSON.stringify(c7Res), /docs:supergateway/);

      await assert.rejects(async () => {
        const denied = await client.callTool({
          name: "context7__hidden-admin",
          arguments: {}
        });
        if (denied.isError) throw new Error("denied");
      });
      // Probe must confirm exact multi-server aggregation without capability leaks.
      await probeSupergateway(executable, config, env);
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

    const supergateway = resolveSupergateway(repo);
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
        args: [path.join(repo, "runtime/src/mcp/launcher.ts"), "filesystem"]
      }
    };
    const policy = {
      filesystem: ["read_text_file", "list_allowed_directories"]
    };
    writeFileSync(
      config,
      renderChatgptSupergatewayConfig(
        catalogue,
        policy,
        workspace,
        policy,
        { port: mcpPort, apiKeyFile: keyFile },
        undefined,
        (server) =>
          externalMcpBackend(server, repo, workspace, process.execPath)
      )
    );
    const gatewayEnv = chatgptSupergatewayEnvironment(
      { home: root, codexHome, repositoryRoot: repo },
      workspace,
      process.execPath,
      process.env.PATH ?? "/usr/bin:/bin"
    );
    let gateway: ChildProcess | undefined = await startSupergatewayServer(
      supergateway,
      config,
      workspace,
      gatewayEnv,
      mcpPort
    );
    const proxy = spawn(
      resolveCommandOnPath("tunnel-client")!,
      [
        "dev",
        "proxy",
        "--mcp-server-url",
        `http://127.0.0.1:${mcpPort}/mcp`,
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
          ...tunnelClientMcpEnv(headerFile)
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
          /* waiting for proxy readiness */
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
        gatewayEnv,
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
      path.join(repo, "node_modules"),
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
    writeFileSync(
      greeterFile,
      "export function formatGreeting(name: string): string {\n  return `Hello, ${name}`;\n}\n"
    );
    writeFileSync(
      mainFile,
      'import { formatGreeting } from "./greeter.ts";\nexport const banner = formatGreeting("AutoDev");\n'
    );

    const cccBinary = resolveCocoIndexBinary(process.env);
    const userHome = homedir();
    const userCccSettings = path.join(
      userHome,
      ".cocoindex_code",
      "global_settings.yml"
    );
    const userHfCache = path.join(userHome, ".cache", "huggingface");
    const includeCocoindex = Boolean(
      cccBinary && existsSync(userCccSettings) && existsSync(userHfCache)
    );
    if (includeCocoindex) {
      mkdirSync(path.join(home, ".cocoindex_code"), { recursive: true });
      cpSync(
        userCccSettings,
        path.join(home, ".cocoindex_code", "global_settings.yml")
      );
      mkdirSync(path.join(home, ".cache"), { recursive: true });
      symlinkSync(userHfCache, path.join(home, ".cache", "huggingface"));
    }

    const supergateway = resolveSupergateway(repo);
    const config = path.join(root, "supergateway.json");
    const keyFile = path.join(root, "supergateway.key");
    const headerFile = path.join(root, "supergateway-auth.header");
    const localToken = "code-tools-e2e-token";
    privateWrite(keyFile, localToken + "\n");
    privateWrite(headerFile, `Bearer ${localToken}\n`);
    const mcpPort = await allocateLoopbackPort();
    const catalogue: Record<string, Record<string, unknown>> = {
      lsp: {
        command: process.execPath,
        args: [path.join(repo, "runtime/src/mcp/launcher.ts"), "lsp"]
      },
      ...(includeCocoindex
        ? {
            "cocoindex-code": {
              command: process.execPath,
              args: [
                path.join(repo, "runtime/src/mcp/launcher.ts"),
                "cocoindex-code"
              ]
            }
          }
        : {})
    };
    const policy: Record<string, string[]> = {
      lsp: [
        "lsp_server_status",
        "lsp_document_symbols",
        "lsp_hover",
        "lsp_goto_definition",
        "lsp_workspace_symbols"
      ],
      ...(includeCocoindex ? { "cocoindex-code": ["search"] } : {})
    };
    writeFileSync(
      config,
      renderChatgptSupergatewayConfig(
        catalogue,
        policy,
        workspace,
        policy,
        { port: mcpPort, apiKeyFile: keyFile },
        undefined,
        (server) =>
          externalMcpBackend(
            server,
            repo,
            workspace,
            process.execPath,
            home,
            codexHome
          )
      )
    );
    const servicePath = [
      path.dirname(process.execPath),
      path.join(repo, "node_modules/.bin"),
      ...(cccBinary ? [path.dirname(cccBinary)] : []),
      process.env.PATH ?? "/usr/bin:/bin"
    ].join(":");
    const gatewayEnv = chatgptSupergatewayEnvironment(
      { home, codexHome, repositoryRoot: repo },
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
        gatewayEnv,
        mcpPort
      );

      let mcpEndpoint = new URL(`http://127.0.0.1:${mcpPort}/mcp`);
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
            `http://127.0.0.1:${mcpPort}/mcp`,
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
            env: { ...process.env, ...tunnelClientMcpEnv(headerFile) },
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
            /* waiting for proxy readiness */
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

      const symbols = await client.callTool({
        name: "lsp__lsp_document_symbols",
        arguments: { file_path: mainFile }
      });
      assert.equal(symbols.isError, undefined);
      assert.match(JSON.stringify(symbols), /banner/);

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
      if (includeCocoindex) {
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
        /* daemon may not have been started */
      }
      rmSync(root, { recursive: true, force: true });
    }
  }
);
