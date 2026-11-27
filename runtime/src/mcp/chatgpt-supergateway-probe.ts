import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { existsSync, readFileSync } from "node:fs";
import { createConnection, createServer } from "node:net";
import { availableParallelism } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import { isEntryPoint } from "../shared/entry-point.ts";
import { MCP_SERVER_XACPX } from "../shared/tool-names.ts";
import {
  localPoolServerKey,
  qualifiedToolNames,
  supergatewayConfigSchema
} from "../config/render-chatgpt-supergateway.ts";
import { XacpxSessionManager } from "../xacpx/manager.ts";
import { createGatewayAdmission } from "./gateway-admission.ts";
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

function requiredEnv(env: Record<string, string>, name: string): string {
  const value = env[name];
  if (!value) throw new Error(`The gateway probe needs ${name}`);
  return value;
}

/**
A local surface refuses requests without its own key -- including the
ChatGPT ingress key -- and lists exactly its role's granted tools.
*/
async function probeLocalSurface(
  endpoint: URL,
  keyFile: string,
  ingressKey: string,
  expected: readonly string[],
  reportPhase: (phase: string) => void
): Promise<void> {
  reportPhase("local endpoint authentication");
  const key = readFileSync(keyFile, "utf8").trim();
  for (const presented of [null, ingressKey]) {
    const refused = await fetch(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(presented ? { authorization: `Bearer ${presented}` } : {})
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {}
      })
    });
    if (refused.status !== 401)
      throw new Error(
        `Expected local surface ${endpoint.pathname} to refuse ${presented ? "the ingress key" : "no key"}, got ${refused.status}`
      );
  }
  const client = new Client({
    name: "autodev-install-check",
    version: "1.0.0"
  });
  try {
    reportPhase("local endpoint initialize");
    await client.connect(
      new StreamableHTTPClientTransport(endpoint, {
        requestInit: { headers: { Authorization: `Bearer ${key}` } }
      }),
      { timeout: 20_000 }
    );
    reportPhase("local endpoint tools/list and capability validation");
    assertApprovedCapabilities(client);
    const tools = await listAllTools(client);
    if (JSON.stringify(tools) !== JSON.stringify([...expected].sort()))
      throw new Error(
        `Local surface ${endpoint.pathname} does not list its role's granted tools`
      );
  } finally {
    await client.close().catch(() => {});
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
  ),
  reportPhase: (phase: string) => void = () => {}
): Promise<void> {
  reportPhase("read staged gateway configuration");
  const config = supergatewayConfigSchema.parse(
    JSON.parse(readFileSync(configFile, "utf8"))
  );
  const surfaces = Object.entries(config.mcpServers).flatMap(
    ([name, surface]) =>
      "mcpServers" in surface ? [[name, surface] as const] : []
  );
  const localSurfaces = Object.values(config.mcpServers).flatMap((surface) =>
    "mcpServers" in surface ? [] : [surface]
  );
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
  reportPhase("prepare XACPX discovery coordinator");
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
  // Every gateway member is a route on the sibling backend pool, admitting
  // local sessions exactly as the service does.
  reportPhase("start admitted backend pool");
  const poolConfig = chatgptBackendPoolConfigSchema.parse(
    JSON.parse(readFileSync(poolConfigPath, "utf8"))
  );
  const pool: ChatgptBackendPoolHandle = await startChatgptBackendPool(
    poolConfig,
    {
      gatewayEnv: effectiveEnv,
      secretEnv: env,
      ...(localSurfaces.length > 0
        ? {
            admission: createGatewayAdmission({
              repositoryRoot: requiredEnv(env, "AUTODEV_REPO_ROOT"),
              node: requiredEnv(env, "AUTODEV_NODE_BIN"),
              home: requiredEnv(env, "HOME"),
              codexHome: requiredEnv(env, "CODEX_HOME"),
              catalogueWorkspace: requiredEnv(env, "AUTODEV_MCP_WORKSPACE"),
              runtimeSource: path.resolve(import.meta.dirname, "..")
            })
          }
        : {})
    }
  );
  const gatewayEnv = {
    ...effectiveEnv,
    [CHATGPT_MCP_POOL_PORT_ENV]: String(pool.port),
    [CHATGPT_MCP_POOL_TOKEN_ENV]: pool.token
  };
  reportPhase("start Supergateway and wait for readiness");
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
      const label = /^[a-z0-9-]+$/u.test(role) ? role : "unknown";
      reportPhase(`external role ${label}: authentication`);
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
        reportPhase(`external role ${label}: initialize`);
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

        reportPhase(
          `external role ${label}: tools/list and capability validation`
        );
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
    // Each local surface starts its own catalogue backend, so probing them
    // one after another made the install's probe as slow as the sum of every
    // backend's startup. A few workers share one queue instead.
    const queue = localSurfaces.values();
    // The reported phase names the failure, so once a surface fails the other
    // workers stop reporting and that surface's phase is the one that stands.
    let failed = false;
    const probeNext = async (): Promise<void> => {
      for (const surface of queue) {
        const label = /^\/local\/[a-z0-9-]+\/[a-zA-Z0-9_.-]+$/u.test(
          surface.path
        )
          ? surface.path
          : "unknown local surface";
        let current = `${label}: start`;
        try {
          await probeLocalSurface(
            new URL(
              `http://127.0.0.1:${probePort}${surface.path}${surface.streamableHttpPath}`
            ),
            surface.apiKeyFile.replaceAll("$$", "$"),
            token,
            poolConfig.servers[
              localPoolServerKey(
                ...(surface.path.split("/").slice(2) as [string, string])
              )
            ]?.tools ?? [],
            (phase) => {
              current = `${label}: ${phase}`;
              if (!failed) reportPhase(current);
            }
          );
        } catch (error) {
          if (!failed) reportPhase(current);
          failed = true;
          throw error;
        }
        if (failed) return;
      }
    };
    await Promise.all(
      Array.from(
        { length: Math.min(localSurfaces.length, availableParallelism()) },
        probeNext
      )
    );
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
  let phase = "startup";
  probeSupergateway(executable, configFile, undefined, (current) => {
    phase = current;
  }).catch(() => {
    // Only locally constructed phase labels; never print upstream errors,
    // protocol payloads, arguments, credential values or file contents.
    process.stderr.write(`Supergateway MCP preflight failed (${phase})\n`);
    process.exitCode = 1;
  });
}
