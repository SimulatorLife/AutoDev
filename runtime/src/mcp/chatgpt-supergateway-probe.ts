import { readFileSync } from "node:fs";
import path from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

interface GatewayConfig {
  mcpServers: {
    autodev: {
      mcpServers: Record<string, { toolPrefix: string; tools: string[] }>;
    };
  };
}

/** A real MCP round trip using the official SDK, not a proxy implementation. */
export async function probeSupergateway(
  executable: string,
  configFile: string
): Promise<void> {
  const config = JSON.parse(
    readFileSync(configFile, "utf8")
  ) as GatewayConfig;
  const expected = Object.values(config.mcpServers.autodev.mcpServers)
    .flatMap(({ toolPrefix, tools }) => tools.map((tool) => toolPrefix + tool))
    .sort();
  const client = new Client({ name: "autodev-install-check", version: "1.0.0" });
  try {
    await client.connect(new StdioClientTransport({
      command: executable,
      args: ["--config", configFile],
      env: Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)),
      stderr: "inherit"
    }), { timeout: 20_000 });
    const capabilities = client.getServerCapabilities();
    if (capabilities?.prompts || capabilities?.resources || capabilities?.logging ||
        capabilities?.completions)
      throw new Error("Unreviewed non-tool MCP capability is exposed");
    const tools: string[] = [];
    let cursor: string | undefined;
    const seen = new Set<string>();
    do {
      const page = await client.listTools(cursor ? { cursor } : {}, { timeout: 20_000 });
      tools.push(...page.tools.map((tool) => tool.name));
      cursor = page.nextCursor;
      if (cursor && seen.has(cursor)) throw new Error("Repeated MCP tool cursor");
      if (cursor) seen.add(cursor);
    } while (cursor);
    if (JSON.stringify(tools.sort()) !== JSON.stringify(expected))
      throw new Error("Supergateway discovered tools do not match reviewed grants");
  } finally {
    await client.close();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename) {
  const [, , executable, configFile] = process.argv;
  if (!executable || !configFile) throw new Error("Expected Supergateway executable and config");
  probeSupergateway(executable, configFile).catch(() => {
    // Never print protocol payloads, upstream arguments or file contents.
    process.stderr.write("Supergateway MCP initialize/tools/list preflight failed\n");
    process.exitCode = 1;
  });
}
