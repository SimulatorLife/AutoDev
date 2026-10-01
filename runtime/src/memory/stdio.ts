import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { createMemoryMcpServer, type MemoryMcpSessionProvider } from "./mcp.ts";
import type { MemoryService } from "./service.ts";

/** Run the official MCP SDK over stdio for a host that has already authorized a session. */
export async function serveMemoryMcpStdio(
  service: MemoryService,
  sessionProvider: MemoryMcpSessionProvider
): Promise<McpServer> {
  const server = createMemoryMcpServer(service, sessionProvider);
  await server.connect(new StdioServerTransport());
  return server;
}
