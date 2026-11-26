/**
The gateway-facing adapter every local MCP client launches (through
`run-autodev-mcp.sh <server>`): it serves one AutoDev MCP server over stdio
and relays it to that role's surface on the shared MCP gateway.

Clients with only static, global MCP registration (Codex, Claude Code, the
CLIs) cannot say which workspace they run in. The adapter can: the client
starts it in its launch directory, so the Runtime admits that directory as
the workspace (`session-grant.ts`) and signs a grant for it, unless the
Runtime that launched the client already handed it one (an ACP session's
grant, in `AUTODEV_MCP_GRANT`). Every relayed call carries the grant; the
gateway runs it in backends confined to that workspace. Nothing else about
the traffic changes, so the client sees the server's own name and tools.
*/
import { homedir } from "node:os";
import path from "node:path";

import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { isRecord } from "@simulatorlife/autodev-core";

import { isEntryPoint } from "../shared/entry-point.ts";
import { writeErrorLine } from "../shared/output.ts";
import {
  issueLaunchGrant,
  localSurfaceUrl,
  readLocalAdmission
} from "./gateway-admission.ts";
import {
  SESSION_GRANT_META_KEY,
  SESSION_GRANT_TTL_MS,
  verifySessionGrant
} from "./session-grant.ts";

/**
A grant the launching Runtime issued for this session.
*/
export const MCP_GRANT_ENV = "AUTODEV_MCP_GRANT";
// A root client (one no Runtime launched) acts as the orchestrator.
const ROOT_ROLE = "orchestrator";
const RENEW_BEFORE_EXPIRY_MS = 60 * 60 * 1000;

export interface GatewayClientContext {
  readonly server: string;
  readonly env: NodeJS.ProcessEnv;
  readonly cwd: string;
}

/**
Where this client's calls go and the grant they carry. A grant handed over by
the launching Runtime is used as is; otherwise the launch directory is
admitted and a renewable grant is signed for it.
*/
export function resolveGatewayClient(context: GatewayClientContext): {
  url: URL;
  key: string;
  grant: () => string;
} {
  const home = context.env.HOME?.trim() || homedir();
  const codexHome = context.env.CODEX_HOME?.trim() || path.join(home, ".codex");
  const admission = readLocalAdmission(codexHome);
  if (!admission)
    throw new Error(
      "The AutoDev MCP gateway is not installed; run `pnpm run install:autodev`."
    );
  const handedOver = context.env[MCP_GRANT_ENV]?.trim();
  const role = handedOver
    ? (verifySessionGrant(admission.secret, handedOver)?.role ?? null)
    : context.env.AUTODEV_AGENT_ROLE?.trim() || ROOT_ROLE;
  if (!role) throw new Error(`${MCP_GRANT_ENV} is not a valid session grant.`);
  const url = localSurfaceUrl(codexHome, role, context.server);
  if (!url) throw new Error("The AutoDev MCP gateway has no installed state.");
  if (handedOver) return { url, key: admission.key, grant: () => handedOver };

  const issued = issueLaunchGrant({
    env: context.env,
    launchDirectory: context.env.AUTODEV_MCP_WORKSPACE?.trim() || context.cwd,
    role
  });
  let grant = issued.grant;
  let expiresAt = Date.now() + SESSION_GRANT_TTL_MS;
  return {
    url,
    key: admission.key,
    grant: () => {
      if (expiresAt - Date.now() < RENEW_BEFORE_EXPIRY_MS) {
        grant = issued.renew();
        expiresAt = Date.now() + SESSION_GRANT_TTL_MS;
      }
      return grant;
    }
  };
}

/**
The message with the grant attached when it is a tool call or task request,
the requests the gateway runs in a workspace's backends.
*/
export function withGrant(
  message: JSONRPCMessage,
  grant: string
): JSONRPCMessage {
  if (
    !("method" in message) ||
    !("id" in message) ||
    (message.method !== "tools/call" && !message.method.startsWith("tasks/"))
  )
    return message;
  const parameters = isRecord(message.params) ? message.params : {};
  const meta = isRecord(parameters._meta) ? parameters._meta : {};
  return {
    ...message,
    params: {
      ...parameters,
      _meta: { ...meta, [SESSION_GRANT_META_KEY]: grant }
    }
  } as JSONRPCMessage;
}

/**
Relay stdio to the gateway until either side closes.
*/
export async function runGatewayClient(
  context: GatewayClientContext
): Promise<void> {
  const { url, key, grant } = resolveGatewayClient(context);
  const upstream = new StreamableHTTPClientTransport(url, {
    requestInit: { headers: { Authorization: `Bearer ${key}` } }
  });
  const local = new StdioServerTransport();
  const closed = new Promise<void>((resolve) => {
    upstream.onclose = resolve;
    local.onclose = resolve;
  });
  upstream.onerror = (error) =>
    writeErrorLine(`autodev mcp gateway: ${error.message}`);
  upstream.onmessage = (message) => {
    // Later requests carry the protocol version the server negotiated.
    if ("result" in message && isRecord(message.result)) {
      const version = message.result.protocolVersion;
      if (typeof version === "string") upstream.setProtocolVersion(version);
    }
    void local.send(message);
  };
  local.onmessage = (message) => {
    void upstream.send(withGrant(message, grant())).catch((error: unknown) => {
      if ("id" in message && "method" in message)
        void local.send({
          jsonrpc: "2.0",
          id: message.id,
          error: {
            code: -32_603,
            message: `AutoDev MCP gateway unavailable: ${error instanceof Error ? error.message : String(error)}`
          }
        });
    });
  };
  await upstream.start();
  await local.start();
  await closed;
  await Promise.allSettled([upstream.close(), local.close()]);
}

if (isEntryPoint(import.meta.url)) {
  runGatewayClient({
    server: process.argv[2] ?? "",
    env: process.env,
    cwd: process.cwd()
  }).catch((error: unknown) => {
    writeErrorLine(
      `autodev mcp: ${error instanceof Error ? error.message : String(error)}`
    );
    process.exitCode = 2;
  });
}
