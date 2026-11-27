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
import {
  InitializeResultSchema,
  isInitializeRequest,
  type JSONRPCMessage,
  type RequestId
} from "@modelcontextprotocol/sdk/types.js";
import { isRecord } from "@simulatorlife/autodev-core";

import { isEntryPoint } from "../shared/entry-point.ts";
import { writeErrorLine } from "../shared/output.ts";
import {
  issueLaunchGrant,
  localSurfaceUrl,
  readLocalAdmission
} from "./gateway-admission.ts";
import { remoteTransportErrorMessage } from "./remote-transport.ts";
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
Attach the grant to tool calls, task requests and cancellation notifications
so the gateway resolves the same scope for execution and cancellation.
*/
export function withGrant(
  message: JSONRPCMessage,
  grant: string
): JSONRPCMessage {
  if (!("method" in message)) return message;
  const scopedRequest =
    "id" in message &&
    (message.method === "tools/call" || message.method.startsWith("tasks/"));
  if (!scopedRequest && message.method !== "notifications/cancelled") {
    return message;
  }
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
  let isStopping = false;
  let initializeId: RequestId | undefined;
  const { promise: closed, resolve: resolveClosed } =
    Promise.withResolvers<void>();
  const stop = (): void => {
    isStopping = true;
    resolveClosed();
  };
  const sendLocal = (message: JSONRPCMessage): void => {
    if (!isStopping) {
      void Promise.resolve()
        .then(() => {
          if (!isStopping) return local.send(message);
        })
        .catch(stop);
    }
  };
  upstream.addEventListener('close', stop);
  local.addEventListener('close', stop);
  local.onerror = stop;
  upstream.onerror = (error) => {
    if (!isStopping) {
      writeErrorLine(
        `autodev mcp gateway: ${remoteTransportErrorMessage(error)}`
      );
    }
  };
  upstream.onmessage = (message) => {
    // Only the correlated initialize response can negotiate a version.
    if ("result" in message && message.id === initializeId) {
      const parsed = InitializeResultSchema.safeParse(message.result);
      if (parsed.success) {
        upstream.setProtocolVersion(parsed.data.protocolVersion);
      }
      initializeId = undefined;
    }
    sendLocal(message);
  };
  local.onmessage = (message) => {
    if (isStopping) return;
    if (isInitializeRequest(message) && "id" in message) {
      initializeId = message.id as RequestId;
    }
    // A synchronous grant-renewal failure belongs to the same request error
    // path as an asynchronous SDK send failure. Never replay an uncertain call.
    void Promise.resolve()
      .then(() => upstream.send(withGrant(message, grant())))
      .catch((error: unknown) => {
        if ("id" in message && "method" in message) {
          sendLocal({
            jsonrpc: "2.0",
            id: message.id,
            error: {
              code: -32_603,
              message: remoteTransportErrorMessage(error)
            }
          });
        }
      });
  };
  // The pinned SDK's stdio transport listens to data/error, not stdin EOF.
  process.stdin.once("end", stop);
  process.stdin.once("close", stop);
  process.stdout.once("error", stop);
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    await upstream.start();
    await local.start();
    if (process.stdin.readableEnded || process.stdin.destroyed) stop();
    await closed;
  } finally {
    isStopping = true;
    process.stdin.off("end", stop);
    process.stdin.off("close", stop);
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
    await local.close().catch(() => {});
    // DELETE is the SDK's native explicit session termination. Bound the
    // cleanup even when a stale or unreachable gateway does not respond.
    const deadline = setTimeout(() => {
      void upstream.close().catch(() => {});
    }, 1000);
    deadline.unref();
    try {
      await upstream.terminateSession().catch(() => {});
    } finally {
      clearTimeout(deadline);
      await upstream.close().catch(() => {});
      process.stdout.off("error", stop);
    }
  }
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
