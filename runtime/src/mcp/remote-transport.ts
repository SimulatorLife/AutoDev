import {
  StreamableHTTPClientTransport,
  StreamableHTTPError
} from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  isJSONRPCErrorResponse,
  type JSONRPCMessage
} from "@modelcontextprotocol/sdk/types.js";

import {
  type RemoteBackendSpec,
  resolveRemoteMcpHeaders
} from "../shared/mcp-headers.ts";

/**
The SDK owns the remote transport and its redirect/session behavior.
Resolve credentials only at connection creation; never publish a raw URL
parser exception, which may include the configured endpoint.
*/
export function createRemoteMcpTransport(
  spec: RemoteBackendSpec,
  server: string,
  environment: NodeJS.ProcessEnv
): StreamableHTTPClientTransport {
  let url: URL;
  try {
    url = new URL(spec.url);
    if (
      (url.protocol !== "https:" && url.protocol !== "http:") ||
      url.username ||
      url.password ||
      url.hash
    ) {
      throw new Error();
    }
  } catch {
    throw new Error("Invalid remote MCP endpoint.");
  }
  return new StreamableHTTPClientTransport(url, {
    requestInit: { headers: resolveRemoteMcpHeaders(spec, server, environment) }
  });
}

/**
SDK HTTP errors can contain the complete upstream response body.
Preserve a bounded HTTP status, never the body, URL, cause or stack.
*/
export function remoteTransportErrorMessage(error: unknown): string {
  if (
    error instanceof StreamableHTTPError &&
    typeof error.code === "number" &&
    Number.isInteger(error.code) &&
    error.code >= 400 &&
    error.code <= 599
  ) {
    return `Remote MCP request failed (HTTP ${error.code}).`;
  }
  return "Remote MCP request failed.";
}

/**
JSON-RPC error messages and data are also upstream-controlled diagnostics.
Keep the SDK's response identity and numeric code, not arbitrary text.
Successful responses (including tool-level isError results) are unchanged.
*/
export function publicRemoteMcpMessage(
  message: JSONRPCMessage
): JSONRPCMessage {
  if (!isJSONRPCErrorResponse(message)) return message;
  return {
    jsonrpc: "2.0",
    id: message.id,
    error: {
      code: message.error.code,
      message: "Remote MCP server returned a JSON-RPC error."
    }
  };
}
