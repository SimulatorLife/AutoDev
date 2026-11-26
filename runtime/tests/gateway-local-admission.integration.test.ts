import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import {
  chatgptSupergatewayEnvironment,
  renderChatgptBackendPoolConfig,
  renderChatgptSupergatewayConfig
} from "../src/config/render-chatgpt-supergateway.ts";
import {
  CHATGPT_MCP_POOL_PORT_ENV,
  CHATGPT_MCP_POOL_TOKEN_ENV,
  startChatgptBackendPool
} from "../src/mcp/chatgpt-backend-pool.ts";
import { externalMcpBackend } from "../src/mcp/chatgpt-filesystem-sandbox.ts";
import { probeSupergateway } from "../src/mcp/chatgpt-supergateway-probe.ts";
import {
  createGatewayAdmission,
  ensureLocalAdmission,
  localAdmissionPaths,
  readLocalAdmission
} from "../src/mcp/gateway-admission.ts";
import {
  issueSessionGrant,
  newGrantSession,
  SESSION_GRANT_META_KEY
} from "../src/mcp/session-grant.ts";
import { resolveSupergateway } from "../src/platform/mcp-gateway-service.ts";

const repository = path.resolve(import.meta.dirname, "../..");

async function loopbackPort(): Promise<number> {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  server.close();
  assert.ok(address && typeof address === "object");
  return address.port;
}

test(
  "local clients reach role servers through the real gateway in any directory, confined to their grant's workspace",
  {
    skip:
      process.env.AUTODEV_TEST_SUPERGATEWAY !== "1" ||
      process.platform !== "darwin",
    timeout: 120_000
  },
  async () => {
    const root = realpathSync(
      mkdtempSync(path.join(tmpdir(), "autodev-local-admission-"))
    );
    const home = path.join(root, "home");
    const codexHome = path.join(home, ".codex");
    const registered = path.join(root, "registered");
    const adHoc = path.join(home, "Desktop", "something");
    for (const directory of [codexHome, registered, adHoc])
      mkdirSync(directory, { recursive: true });
    mkdirSync(path.join(codexHome, "mcp-gateway"), { mode: 0o700 });
    writeFileSync(path.join(registered, "note.txt"), "registered-ok");
    writeFileSync(path.join(adHoc, "note.txt"), "ad-hoc-ok");
    const ingressKeyFile = path.join(root, "ingress.key");
    writeFileSync(ingressKeyFile, "ingress-key\n", { mode: 0o600 });
    ensureLocalAdmission(codexHome);
    const { keyFile } = localAdmissionPaths(codexHome);
    const admissionSecret = readLocalAdmission(codexHome)!.secret;

    const catalogue = {
      filesystem: {
        command: process.execPath,
        args: [
          path.join(repository, "runtime/src/mcp/launcher.ts"),
          "filesystem"
        ]
      }
    };
    const grants = {
      filesystem: ["read_text_file", "list_allowed_directories"]
    };
    const backend = (server: string, role: string) =>
      externalMcpBackend(
        server,
        repository,
        registered,
        process.execPath,
        home,
        codexHome,
        {
          role
        }
      );
    const local = {
      roles: [{ role: "worker", grants, reviewed: grants }],
      apiKeyFile: keyFile
    };
    const generation = path.join(root, "generation");
    mkdirSync(generation);
    const poolFile = path.join(generation, "backend-pool.json");
    const configFile = path.join(generation, "supergateway.json");
    const port = await loopbackPort();
    const chatgpt = [{ role: "orchestrator", grants, reviewed: grants }];
    writeFileSync(
      poolFile,
      renderChatgptBackendPoolConfig(
        catalogue,
        chatgpt,
        registered,
        backend,
        local
      )
    );
    writeFileSync(
      configFile,
      renderChatgptSupergatewayConfig(
        catalogue,
        chatgpt,
        registered,
        { port, apiKeyFile: ingressKeyFile },
        backend,
        local
      )
    );
    const environment = chatgptSupergatewayEnvironment(
      { home, codexHome, repositoryRoot: repository },
      registered,
      process.execPath,
      process.env.PATH ?? "/usr/bin:/bin"
    );
    const supergateway = resolveSupergateway(
      path.join(repository, "runtime", "src")
    );

    // The install-time probe checks the local surface exactly as served.
    await probeSupergateway(supergateway, configFile, environment);

    const pool = await startChatgptBackendPool(
      JSON.parse(readFileSync(poolFile, "utf8")),
      {
        gatewayEnv: environment,
        admission: createGatewayAdmission({
          repositoryRoot: repository,
          node: process.execPath,
          home,
          codexHome,
          catalogueWorkspace: registered,
          runtimeSource: path.join(repository, "runtime", "src")
        })
      }
    );
    const gateway = spawn(supergateway, ["--config", configFile], {
      env: {
        ...environment,
        [CHATGPT_MCP_POOL_PORT_ENV]: String(pool.port),
        [CHATGPT_MCP_POOL_TOKEN_ENV]: pool.token
      },
      stdio: ["pipe", "ignore", "inherit"]
    });
    const clients: Client[] = [];
    try {
      for (let attempt = 0; ; attempt += 1) {
        const ready = await fetch(`http://127.0.0.1:${port}/readyz`).catch(
          () => null
        );
        if (ready?.ok) break;
        assert.ok(attempt < 100, "gateway did not become ready");
        await delay(200);
      }
      const endpoint = new URL(
        `http://127.0.0.1:${port}/local/worker/filesystem/mcp`
      );
      const connect = async (key: string) => {
        const client = new Client({
          name: "local-admission-test",
          version: "1"
        });
        clients.push(client);
        await client.connect(
          new StreamableHTTPClientTransport(endpoint, {
            requestInit: { headers: { Authorization: `Bearer ${key}` } }
          })
        );
        return client;
      };
      await assert.rejects(
        connect("ingress-key"),
        "the tunnel's key never opens a local surface"
      );
      const client = await connect(readFileSync(keyFile, "utf8").trim());
      // Canonical server and tool names: no gateway prefix.
      const listed = (await client.listTools()).tools
        .map((tool) => tool.name)
        .sort();
      assert.deepEqual(listed, ["list_allowed_directories", "read_text_file"]);

      const grantFor = (workspace: string, role = "worker") =>
        issueSessionGrant(admissionSecret, {
          workspace,
          role,
          session: newGrantSession()
        });
      // A refused admission is a JSON-RPC error; a confined backend's denial
      // is a tool error result. Either way the content never arrives.
      const read = async (file: string, grant?: string) => {
        const result = await client
          .callTool({
            name: "read_text_file",
            arguments: { path: file },
            ...(grant && { _meta: { [SESSION_GRANT_META_KEY]: grant } })
          })
          .catch((error: Error) => ({
            content: [{ text: error.message }],
            isError: true
          }));
        const text =
          (result.content as Array<{ text?: string }>)[0]?.text ?? "";
        return { text, isError: result.isError === true };
      };

      // A directory nobody registered works the same as a registered one.
      assert.deepEqual(
        await read(path.join(adHoc, "note.txt"), grantFor(adHoc)),
        {
          text: "ad-hoc-ok",
          isError: false
        }
      );
      assert.deepEqual(
        await read(path.join(registered, "note.txt"), grantFor(registered)),
        { text: "registered-ok", isError: false }
      );
      // Each grant is confined to its own workspace.
      assert.equal(
        (await read(path.join(registered, "note.txt"), grantFor(adHoc)))
          .isError,
        true
      );
      // No grant, a forged grant or another role's grant is refused.
      for (const grant of [
        undefined,
        "v1.forged.grant",
        grantFor(adHoc, "orchestrator"),
        issueSessionGrant("stolen", {
          workspace: adHoc,
          role: "worker",
          session: newGrantSession()
        })
      ]) {
        const refused = await read(path.join(adHoc, "note.txt"), grant);
        assert.equal(refused.isError, true, String(grant));
        assert.notEqual(refused.text, "ad-hoc-ok");
      }

      // A real client launches the adapter in its working directory; the
      // adapter admits that directory and relays to the role's surface.
      writeFileSync(
        path.join(codexHome, "mcp-gateway", "gateway.json"),
        JSON.stringify({ mcpPort: port }),
        { mode: 0o600 }
      );
      const adapterEnvironment = {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        HOME: home,
        CODEX_HOME: codexHome,
        AUTODEV_HOME: path.join(home, ".autodev"),
        AUTODEV_AGENT_ROLE: "worker"
      };
      const adapter = (cwd: string) =>
        new StdioClientTransport({
          command: process.execPath,
          args: [
            path.join(repository, "runtime/src/mcp/gateway-client.ts"),
            "filesystem"
          ],
          cwd,
          env: adapterEnvironment,
          stderr: "pipe"
        });
      const native = new Client({ name: "native-client", version: "1" });
      clients.push(native);
      await native.connect(adapter(adHoc));
      const viaAdapter = await native.callTool({
        name: "read_text_file",
        arguments: { path: path.join(adHoc, "note.txt") }
      });
      assert.equal(
        (viaAdapter.content as Array<{ text: string }>)[0]?.text,
        "ad-hoc-ok"
      );
      const escape = await native.callTool({
        name: "read_text_file",
        arguments: { path: path.join(registered, "note.txt") }
      });
      assert.equal(
        escape.isError,
        true,
        "the adapter's session is confined to its launch directory"
      );
      // Launched in the home directory, it refuses rather than serving it.
      const atHome = new Client({ name: "native-client-home", version: "1" });
      clients.push(atHome);
      await assert.rejects(atHome.connect(adapter(home)));
    } finally {
      await Promise.allSettled(clients.map((client) => client.close()));
      gateway.kill("SIGTERM");
      await once(gateway, "exit").catch(() => {});
      await pool.close();
      rmSync(root, { recursive: true, force: true });
    }
  }
);
