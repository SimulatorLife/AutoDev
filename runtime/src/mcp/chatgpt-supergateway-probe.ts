import { readFileSync } from "node:fs";
import { isEntryPoint } from "../shared/entry-point.ts";
import { qualifiedToolNames, supergatewayConfigSchema } from "../config/render-chatgpt-supergateway.ts";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

/** A real MCP round trip using the official SDK, not a proxy implementation. */
export async function probeSupergateway(
  executable: string,
  configFile: string,
  env: Record<string, string> = Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)
  )
): Promise<void> {
  const config = supergatewayConfigSchema.parse(JSON.parse(readFileSync(configFile, "utf8")));
  const expected = qualifiedToolNames(config);
  const client = new Client({ name: "autodev-install-check", version: "1.0.0" });
  try {
    await client.connect(new StdioClientTransport({
      command: executable,
      args: ["--config", configFile],
      env,
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

if (isEntryPoint(import.meta.url)) {
  const [, , executable, configFile] = process.argv;
  if (!executable || !configFile) throw new Error("Expected Supergateway executable and config");
  probeSupergateway(executable, configFile).catch(() => {
    // Never print protocol payloads, upstream arguments or file contents.
    process.stderr.write("Supergateway MCP initialize/tools/list preflight failed\n");
    process.exitCode = 1;
  });
}
