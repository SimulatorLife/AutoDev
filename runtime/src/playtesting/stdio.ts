import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

/** Run the official MCP SDK over stdio for an authorized Playtesting session. */
export async function servePlaytestMcpStdio(
  server: McpServer
): Promise<McpServer> {
  await server.connect(new StdioServerTransport());
  return server;
}
