/**
Read-only acceptance check for the installed combined gateway. Discovery
and native Tasks are independent capabilities: an advertised Tasks object
does not prove that the aggregator can route even tasks/list.
*/
import path from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";

import { supergatewayConfigSchema } from "../config/render-chatgpt-supergateway.ts";
import { privateRead } from "../shared/private-service-files.ts";
import { MCP_SERVER_COMMANDS, MCP_SERVER_XACPX } from "../shared/tool-names.ts";
import {
  generationPath,
  mcpGatewayAuthPaths,
  readMcpGatewayState
} from "./mcp-gateway-service.ts";

type TaskListingStatus =
  | "ok"
  | "not-advertised"
  | "method-not-found"
  | "listing-failed"
  | "listing-incomplete"
  | "unexpected-tasks"
  | "initialize-failed";

export interface NativeTaskListingReport {
  readonly status: TaskListingStatus;
  readonly protocolVersion?: string;
}

export interface GatewayTaskListingReport extends NativeTaskListingReport {
  readonly role: string;
}

/**
Never create or mutate tasks, supply a forged conversation identity, or
return task data. A fresh external session must not see any other owner's
tasks. Distinguish a missing method from a generic transport failure.
*/
export async function probeNativeTaskListing(
  endpoint: URL,
  key: string
): Promise<NativeTaskListingReport> {
  const client = new Client({
    name: "autodev-task-listing-check",
    version: "1.0.0"
  });
  const transport = new StreamableHTTPClientTransport(endpoint, {
    requestInit: { headers: { Authorization: `Bearer ${key}` } }
  });
  const timeout = { timeout: 10_000 };
  try {
    try {
      await client.connect(transport, timeout);
    } catch {
      return { status: "initialize-failed" };
    }
    const version = transport.protocolVersion;
    const protocol = version ? { protocolVersion: version } : {};
    if (!client.getServerCapabilities()?.tasks?.list)
      return { ...protocol, status: "not-advertised" };
    try {
      const result = await client.experimental.tasks.listTasks(
        undefined,
        timeout
      );
      return {
        ...protocol,
        status:
          result.tasks.length > 0
            ? "unexpected-tasks"
            : result.nextCursor
              ? "listing-incomplete"
              : "ok"
      };
    } catch (error) {
      return {
        ...protocol,
        status:
          error instanceof McpError && error.code === ErrorCode.MethodNotFound
            ? "method-not-found"
            : "listing-failed"
      };
    }
  } finally {
    // Bound DELETE just as the local gateway adapter does. A failed
    // termination must not prevent transport cleanup or mask the report.
    const deadline = setTimeout(() => {
      void transport.close().catch(() => {});
    }, 1000);
    deadline.unref();
    try {
      await transport.terminateSession().catch(() => {});
    } finally {
      clearTimeout(deadline);
      await Promise.allSettled([client.close(), transport.close()]);
    }
  }
}

/**
Use the installed, validated generation and private external ingress key.
Only query combined role surfaces that actually publish a task-capable
backend. An empty result is not an acceptance pass.
*/
export async function checkGatewayTaskListing(
  codexHome: string
): Promise<GatewayTaskListingReport[]> {
  const state = readMcpGatewayState(codexHome);
  if (!state) throw new Error("The AutoDev MCP gateway is not configured.");
  const { keyFile } = mcpGatewayAuthPaths(codexHome);
  const key = privateRead(keyFile);
  if (!key) throw new Error("The gateway's private ingress key is unavailable.");
  const generation = generationPath(path.dirname(keyFile), state.generation);
  // Do not propagate parse errors containing installed configuration text.
  const config = (() => {
    try {
      return supergatewayConfigSchema.parse(
        JSON.parse(privateRead(path.join(generation, "supergateway.json")))
      );
    } catch {
      throw new Error("The installed gateway configuration is unavailable or invalid.");
    }
  })();
  if (config.port !== state.mcpPort)
    throw new Error(
      "The gateway configuration does not match its installed state."
    );
  const surfaces = Object.entries(config.mcpServers).filter(
    ([, surface]) =>
      "mcpServers" in surface &&
      [MCP_SERVER_COMMANDS, MCP_SERVER_XACPX].some((server) =>
        Object.hasOwn(surface.mcpServers, server)
      )
  );
  return Promise.all(
    surfaces.map(async ([role, surface]) => {
      const endpoint = new URL(
        `http://127.0.0.1:${config.port}${surface.path}${surface.streamableHttpPath}`
      );
      return { role, ...(await probeNativeTaskListing(endpoint, key)) };
    })
  );
}
