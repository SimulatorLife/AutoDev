import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { existsSync, readFileSync } from "node:fs";
import { createConnection, createServer } from "node:net";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import { isEntryPoint } from "../shared/entry-point.ts";
import { MCP_SERVER_XACPX } from "../shared/tool-names.ts";
import {
  qualifiedToolNames,
  supergatewayConfigSchema
} from "../config/render-chatgpt-supergateway.ts";
import { XacpxSessionManager } from "../xacpx/manager.ts";
import {
  startXacpxOrchestrationIpcServer,
  type XacpxOrchestrationIpcHandle
} from "../xacpx/orchestration-ipc.ts";
import {
  CHATGPT_MCP_POOL_PORT_ENV,
  CHATGPT_MCP_POOL_TOKEN_ENV,
  chatgptBackendPoolConfigSchema,
  type ChatgptBackendPoolHandle,
  startChatgptBackendPool
} from "./chatgpt-backend-pool.ts";

function isUnixSocketReachable(socketPath: string): Promise<boolean> {
  if (!socketPath || !existsSync(socketPath)) return Promise.resolve(false);
  return new Promise<boolean>((resolve) => {
    const connection = createConnection(socketPath);
    const finish = (ok: boolean): void => {
      connection.removeAllListeners();
      connection.destroy();
      resolve(ok);
    };
    connection.setTimeout(500, () => finish(false));
    connection.once("connect", () => finish(true));
    connection.once("error", () => finish(false));
  });
}

async function allocateLoopbackPort(): Promise<number> {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("Failed to allocate loopback probe port");
  }
  const { port } = address;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

async function listAllTools(client: Client): Promise<string[]> {
  const tools: string[] = [];
  let cursor: string | undefined;
  const seen = new Set<string>();
  do {
    const page = await client.listTools(cursor ? { cursor } : {}, {
      timeout: 20_000
    });
    tools.push(...page.tools.map((tool) => tool.name));
    cursor = page.nextCursor;
    if (cursor && seen.has(cursor)) throw new Error("Repeated MCP tool cursor");
    if (cursor) seen.add(cursor);
  } while (cursor);
  return tools.sort();
}

function assertApprovedCapabilities(client: Client): void {
  const capabilities = client.getServerCapabilities();
  if (
    capabilities?.prompts ||
    capabilities?.resources ||
    capabilities?.logging ||
    capabilities?.completions
  ) {
    throw new Error("Unreviewed non-tool MCP capability is exposed");
  }
}

/** A real Streamable HTTP MCP round trip using the official SDK across independent sessions. */
export async function probeSupergateway(
  executable: string,
  configFile: string,
  env: Record<string, string> = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined
    )
  )
): Promise<void> {
  const config = supergatewayConfigSchema.parse(
    JSON.parse(readFileSync(configFile, "utf8"))
  );
  const surfaces = Object.entries(config.mcpServers);
  if (!surfaces.length)
    throw new Error("Supergateway publishes no role surface");
  const apiKeyFile = surfaces[0]![1].apiKeyFile.replaceAll("$$", "$");
  const token = readFileSync(apiKeyFile, "utf8").split("\n")[0]?.trim();
  if (!token) throw new Error("Supergateway API key file is empty");

  const probePort = await allocateLoopbackPort();
  const poolConfigPath = path.join(
    path.dirname(configFile),
    "backend-pool.json"
  );
  let probeXacpxIpc: XacpxOrchestrationIpcHandle | undefined;
  let effectiveEnv = env;
  if (
    surfaces.some(([, surface]) =>
      Object.prototype.hasOwnProperty.call(surface.mcpServers, MCP_SERVER_XACPX)
    ) &&
    !(await isUnixSocketReachable(env.XACPX_ORCHESTRATION_SOCKET ?? ""))
  ) {
    const probeSocket = path.join(
      "/tmp",
      `autodev-xacpx-probe-${randomBytes(8).toString("hex")}.sock`
    );
    probeXacpxIpc = await startXacpxOrchestrationIpcServer({
      socketPath: probeSocket,
      manager: new XacpxSessionManager(),
      authorizedWorkspaceRoot: env.AUTODEV_XACPX_WORKSPACE || process.cwd(),
      repositoryRoot: env.AUTODEV_REPO_ROOT || process.cwd()
    });
    effectiveEnv = {
      ...env,
      XACPX_ORCHESTRATION_SOCKET: probeSocket,
      AUTODEV_XACPX_COORDINATOR_SESSION: "chatgpt:policy-probe"
    };
  }
  // Every gateway member is a route on the sibling backend pool.
  const pool: ChatgptBackendPoolHandle = await startChatgptBackendPool(
    chatgptBackendPoolConfigSchema.parse(
      JSON.parse(readFileSync(poolConfigPath, "utf8"))
    ),
    { gatewayEnv: effectiveEnv, secretEnv: env }
  );
  const gatewayEnv = {
    ...effectiveEnv,
    [CHATGPT_MCP_POOL_PORT_ENV]: String(pool.port),
    [CHATGPT_MCP_POOL_TOKEN_ENV]: pool.token
  };
  const child = spawn(
    executable,
    ["--config", configFile, "--port", String(probePort)],
    {
      env: gatewayEnv,
      stdio: ["pipe", "ignore", "inherit"]
    }
  );
  try {
    let ready = false;
    for (let attempt = 0; attempt < 150; attempt++) {
      if (child.exitCode !== null || child.signalCode !== null) {
        throw new Error(
          "Supergateway probe process exited before becoming ready"
        );
      }
      try {
        const response = await fetch(`http://127.0.0.1:${probePort}/readyz`, {
          signal: AbortSignal.timeout(1000)
        });
        if (response.ok) {
          ready = true;
          break;
        }
      } catch {
        /* waiting for Supergateway HTTP listener */
      }
      await delay(200);
    }
    if (!ready) throw new Error("Supergateway probe did not become ready");

    for (const [role, surface] of surfaces) {
      const endpoint = new URL(
        `http://127.0.0.1:${probePort}${surface.path}${surface.streamableHttpPath}`
      );
      const expected = qualifiedToolNames({
        ...config,
        mcpServers: { [role]: surface }
      });
      const unauthenticated = await fetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {}
        })
      });
      if (unauthenticated.status !== 401) {
        throw new Error(
          `Expected unauthenticated MCP request to return 401 for role '${role}', got ${unauthenticated.status}`
        );
      }

      const requestInit: RequestInit = {
        headers: { Authorization: `Bearer ${token}` }
      };
      const primary = new Client({
        name: "autodev-install-check",
        version: "1.0.0"
      });
      const secondary = new Client({
        name: "autodev-install-check-2",
        version: "1.0.0"
      });
      const transportA = new StreamableHTTPClientTransport(endpoint, {
        requestInit
      });
      const transportB = new StreamableHTTPClientTransport(endpoint, {
        requestInit
      });
      try {
        await primary.connect(transportA, { timeout: 20_000 });
        await secondary.connect(transportB, { timeout: 20_000 });
        if (
          !transportA.sessionId ||
          !transportB.sessionId ||
          transportA.sessionId === transportB.sessionId
        ) {
          throw new Error(
            "Supergateway failed to isolate Streamable HTTP session IDs"
          );
        }

        assertApprovedCapabilities(primary);
        assertApprovedCapabilities(secondary);

        const [toolsA, toolsB] = await Promise.all([
          listAllTools(primary),
          listAllTools(secondary)
        ]);
        if (
          JSON.stringify(toolsA) !== JSON.stringify(expected) ||
          JSON.stringify(toolsB) !== JSON.stringify(expected)
        ) {
          throw new Error(
            `Supergateway discovered tools do not match reviewed grants for role '${role}'`
          );
        }
      } finally {
        await Promise.allSettled([primary.close(), secondary.close()]);
      }
    }
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
      const exited = await Promise.race([
        once(child, "exit").then(() => true),
        delay(3000).then(() => false)
      ]);
      if (!exited && child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
        await once(child, "exit").catch(() => {});
      }
    }
    await pool.close().catch(() => {});
    if (probeXacpxIpc) await probeXacpxIpc.close().catch(() => {});
  }
}

if (isEntryPoint(import.meta.url)) {
  const [, , executable, configFile] = process.argv;
  if (!executable || !configFile)
    throw new Error("Expected Supergateway executable and config");
  probeSupergateway(executable, configFile).catch(() => {
    // Never print protocol payloads, upstream arguments or file contents.
    process.stderr.write(
      "Supergateway MCP initialize/tools/list preflight failed\n"
    );
    process.exitCode = 1;
  });
}
