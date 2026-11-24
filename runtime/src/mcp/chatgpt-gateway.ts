import path from "node:path";
import { readFileSync, realpathSync, statSync } from "node:fs";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  CallToolResultSchema,
  ListToolsRequestSchema,
  type Tool
} from "@modelcontextprotocol/sdk/types.js";

const servers = [
  "filesystem",
  "playwright",
  "codegraphcontext",
  "cocoindex-code",
  "lsp",
  "playtest"
] as const;
type ServerName = (typeof servers)[number];
export type GatewayPolicy = Partial<Record<ServerName, string[]>>;

const filesystemReads = [
  "read_file",
  "read_text_file",
  "read_media_file",
  "read_multiple_files",
  "list_directory",
  "list_directory_with_sizes",
  "directory_tree",
  "search_files",
  "get_file_info",
  "list_allowed_directories"
];

export const defaultGatewayPolicy: GatewayPolicy = {
  filesystem: filesystemReads
};

export interface GatewayConfig {
  workspace: string;
  launcher: string;
  policy: GatewayPolicy;
}

export function parseGatewayPolicy(value: unknown): GatewayPolicy {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("ChatGPT MCP policy must be an object");
  const policy: GatewayPolicy = {};
  for (const [name, tools] of Object.entries(value)) {
    if (!servers.includes(name as ServerName))
      throw new Error("Unknown ChatGPT MCP server: " + name);
    if (
      !Array.isArray(tools) ||
      !tools.length ||
      tools.some((tool) => typeof tool !== "string" || !/^(?:\\*|[a-zA-Z0-9_-]+)$/u.test(tool))
    )
      throw new Error("Expected an explicit tool allowlist for " + name);
    if (name === "filesystem" && tools.some((tool) => !filesystemReads.includes(tool)))
      throw new Error("ChatGPT filesystem access is read-only");
    policy[name as ServerName] = [...new Set<string>(tools)];
  }
  if (!Object.keys(policy).length) throw new Error("Empty ChatGPT MCP policy");
  return policy;
}

export function validateWorkspace(workspace: string, home: string, codexHome: string): string {
  if (!path.isAbsolute(workspace)) throw new Error("ChatGPT workspace must be absolute");
  const root = realpathSync(workspace);
  if (!statSync(root).isDirectory()) throw new Error("ChatGPT workspace must be a directory");
  for (const sensitive of [home, codexHome]) {
    const resolved = realpathSync(sensitive);
    const relative = path.relative(root, resolved);
    if (relative === "" || (!relative.startsWith(".." + path.sep) && relative !== ".." && !path.isAbsolute(relative)))
      throw new Error("ChatGPT workspace cannot contain home or AutoDev configuration");
    if (resolved === realpathSync(codexHome)) {
      const inside = path.relative(resolved, root);
      if (inside === "" || (!inside.startsWith(".." + path.sep) && inside !== ".." && !path.isAbsolute(inside)))
        throw new Error("ChatGPT workspace cannot be inside AutoDev configuration");
    }
  }
  return root;
}

export function allowedTool(policy: GatewayPolicy, server: ServerName, tool: string): boolean {
  const allowed = policy[server] ?? [];
  return allowed.includes(tool) || allowed.includes("*");
}

export function gatewayToolName(server: string, name: string): string {
  const result = server.replaceAll("-", "_") + "__" + name;
  if (!/^[a-zA-Z0-9_-]{1,64}$/u.test(result))
    throw new Error("Unsupported gateway tool name: " + result);
  return result;
}

// Do not forward the tunnel runtime key, admin key, or arbitrary provider secrets.
export function downstreamEnv(env: NodeJS.ProcessEnv, workspace: string): Record<string, string> {
  const result: Record<string, string> = {
    AUTODEV_MCP_WORKSPACE: workspace,
    AUTODEV_MCP_READ_ONLY: "1"
  };
  for (const key of ["HOME", "PATH", "USER", "LOGNAME", "TMPDIR", "LANG", "LC_ALL", "CODEX_HOME", "AUTODEV_NODE_BIN", "AUTODEV_REPO_ROOT", "AUTODEV_COCOINDEX_BIN", "AUTODEV_CODEGRAPHCONTEXT_BIN"]) {
    if (env[key] !== undefined) result[key] = env[key]!;
  }
  return result;
}

interface Route {
  client: Client;
  server: ServerName;
  name: string;
  tool: Tool;
}

export async function runGateway(config: GatewayConfig): Promise<void> {
  const policy = parseGatewayPolicy(config.policy);
  const routes = new Map<string, Route>();
  const clients = new Map<ServerName, Promise<Client>>();
  const server = new Server(
    { name: "autodev-chatgpt", version: "1.0.0" },
    { capabilities: { tools: {} } }
  );

  function connect(name: ServerName): Promise<Client> {
    const existing = clients.get(name);
    if (existing) return existing;
    const client = new Client({ name: "autodev-chatgpt", version: "1.0.0" });
    const transport = new StdioClientTransport({
      command: "/bin/bash",
      args: [config.launcher, name],
      cwd: config.workspace,
      env: downstreamEnv(process.env, config.workspace),
      stderr: "inherit"
    });
    const connected = client.connect(transport).then(() => client).catch(async (error: unknown) => {
      clients.delete(name);
      await client.close().catch(() => undefined);
      throw error;
    });
    clients.set(name, connected);
    client.onclose = () => {
      if (clients.get(name) === connected) clients.delete(name);
      for (const [key, route] of routes) if (route.client === client) routes.delete(key);
    };
    return connected;
  }

  async function discover(): Promise<Tool[]> {
    const entries = await Promise.all(
      (Object.keys(policy) as ServerName[]).map(async (name) => {
        const client = await connect(name);
        const found: Route[] = [];
        let cursor: string | undefined;
        const seen = new Set<string>();
        do {
          const page = await client.listTools(cursor ? { cursor } : {});
          for (const tool of page.tools) {
            if (!allowedTool(policy, name, tool.name)) continue;
            const alias = gatewayToolName(name, tool.name);
            found.push({ client, server: name, name: tool.name, tool: {
              ...tool,
              name: alias,
              description: "[" + name + "] " + (tool.description ?? tool.name),
              // Do not trust arbitrary upstream claims of read-only behavior.
              annotations: { ...tool.annotations, readOnlyHint: name === "filesystem" }
            } });
          }
          cursor = page.nextCursor;
          if (cursor && seen.has(cursor)) throw new Error("Repeated MCP tool cursor: " + name);
          if (cursor) seen.add(cursor);
        } while (cursor);
        return found;
      })
    );
    const next = new Map<string, Route>();
    for (const route of entries.flat()) {
      if (next.has(route.tool.name)) throw new Error("Duplicate gateway tool: " + route.tool.name);
      next.set(route.tool.name, route);
    }
    routes.clear();
    for (const [name, route] of next) routes.set(name, route);
    return [...routes.values()].map((route) => route.tool);
  }

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: await discover() }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    let route = routes.get(request.params.name);
    if (!route) {
      await discover();
      route = routes.get(request.params.name);
    }
    if (!route || !allowedTool(policy, route.server, route.name))
      throw new Error("Tool is not allowed by the ChatGPT MCP policy");
    const result = await route.client.callTool({
      name: route.name,
      arguments: request.params.arguments ?? {}
    }, CallToolResultSchema, { timeout: 100_000 });
    return CallToolResultSchema.parse(result);
  });

  let closing = false;
  const close = async (): Promise<void> => {
    if (closing) return;
    closing = true;
    await Promise.allSettled([...clients.values()].map(async (client) => (await client).close()));
    await server.close();
  };
  server.onclose = () => { void close(); };
  for (const signal of ["SIGINT", "SIGTERM"] as const)
    process.once(signal, () => { void close().finally(() => process.exit(0)); });
  await server.connect(new StdioServerTransport());
}

if (process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename) {
  const file = process.env.AUTODEV_CHATGPT_GATEWAY_CONFIG;
  if (!file) throw new Error("AUTODEV_CHATGPT_GATEWAY_CONFIG is required");
  const config = JSON.parse(readFileSync(file, "utf8")) as GatewayConfig;
  runGateway(config).catch((error: unknown) => {
    process.stderr.write("AutoDev ChatGPT gateway: " + String(error) + "\n");
    process.exitCode = 1;
  });
}
