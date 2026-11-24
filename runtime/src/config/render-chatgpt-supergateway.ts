import { realpathSync, statSync } from "node:fs";
import path from "node:path";

import { MCP_FILESYSTEM_READ_ONLY_ENV } from "../shared/tool-names.ts";

type Catalogue = Record<string, Record<string, unknown>>;

interface StdioServer {
  command: string;
  args: string[];
  cwd: string;
  toolPrefix: string;
  tools: string[];
}

/**
 * AutoDev owns grants and workspace scope, not MCP protocol mechanics.
 * Supergateway owns discovery, namespacing, dispatch and process lifecycle.
 */
export function renderChatgptSupergatewayConfig(
  catalogue: Catalogue,
  grants: unknown,
  workspace: string
): string {
  if (!grants || typeof grants !== "object" || Array.isArray(grants))
    throw new Error("ChatGPT MCP grants must be an object");
  if (!path.isAbsolute(workspace))
    throw new Error("ChatGPT MCP workspace must be absolute");

  const entries: Array<[string, StdioServer]> = [];
  const prefixes = new Set<string>();
  for (const [name, tools] of Object.entries(grants)) {
    if (!/^[a-zA-Z0-9_-]+$/u.test(name) || !Object.hasOwn(catalogue, name))
      throw new Error(`Unknown MCP declaration: ${name}`);
    if (
      !Array.isArray(tools) ||
      tools.length === 0 ||
      !tools.every(
        (tool): tool is string =>
          typeof tool === "string" && /^[a-zA-Z0-9_-]+$/u.test(tool)
      )
    )
      throw new Error(`Explicit tool grants required for ${name}; wildcards are not allowed`);

    const descriptor = catalogue[name]!;
    // The external gateway initially supports local, credential-free stdio
    // descriptors only. Do not silently translate remote/authenticated MCPs.
    if (
      typeof descriptor.command !== "string" ||
      !descriptor.command.trim() ||
      descriptor.url !== undefined ||
      descriptor.bearer_token_env_var !== undefined ||
      descriptor.http_headers !== undefined ||
      descriptor.env !== undefined
    )
      throw new Error(`Unsupported external MCP transport or credentials: ${name}`);
    const args = descriptor.args ?? [];
    if (
      !Array.isArray(args) ||
      !args.every((arg): arg is string => typeof arg === "string")
    )
      throw new Error(`Invalid MCP arguments: ${name}`);
    if (descriptor.cwd !== undefined && descriptor.cwd !== workspace)
      throw new Error(`MCP cwd does not match the selected workspace: ${name}`);

    const toolPrefix = name.replaceAll("-", "_") + "__";
    if (prefixes.has(toolPrefix))
      throw new Error(`Colliding MCP namespace: ${name}`);
    prefixes.add(toolPrefix);
    if (tools.some((tool) => toolPrefix.length + tool.length > 64))
      throw new Error(`ChatGPT MCP tool name exceeds 64 characters: ${name}`);

    entries.push([
      name,
      {
        command: descriptor.command,
        args,
        cwd: workspace,
        toolPrefix,
        tools: [...new Set<string>(tools)]
      }
    ]);
  }
  if (!entries.length) throw new Error("No MCP tools granted to ChatGPT");

  // A combined stdio entry deliberately creates no HTTP/SSE listener.
  return JSON.stringify({
    logLevel: "info",
    logFormat: "json",
    mcpServers: {
      autodev: {
        outputTransport: "stdio",
        mcpServers: Object.fromEntries(entries)
      }
    }
  }, null, 2) + "\n";
}

function contains(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === "" || (
    relative !== ".." &&
    !relative.startsWith(".." + path.sep) &&
    !path.isAbsolute(relative)
  );
}

export function validateChatgptWorkspace(
  workspace: string,
  home: string,
  codexHome: string
): string {
  if (!path.isAbsolute(workspace))
    throw new Error("ChatGPT workspace must be absolute");
  const root = realpathSync(workspace);
  if (!statSync(root).isDirectory())
    throw new Error("ChatGPT workspace must be a directory");
  const configuration = realpathSync(codexHome);
  if (
    contains(root, realpathSync(home)) ||
    contains(root, configuration) ||
    contains(configuration, root)
  )
    throw new Error("ChatGPT workspace overlaps home or AutoDev configuration");
  return root;
}

/**
 * Pass this as the entire environment of the Supergateway process, not a
 * delta merged with the tunnel client's environment. Its children inherit
 * only these values. This is environment isolation, not an OS sandbox.
 */
export function chatgptSupergatewayEnvironment(
  paths: { home: string; codexHome: string; repositoryRoot: string },
  workspace: string,
  node: string,
  servicePath: string
): Record<string, string> {
  return {
    HOME: paths.home,
    CODEX_HOME: paths.codexHome,
    PATH: servicePath,
    AUTODEV_REPO_ROOT: paths.repositoryRoot,
    AUTODEV_NODE_BIN: node,
    AUTODEV_MCP_WORKSPACE: workspace,
    [MCP_FILESYSTEM_READ_ONLY_ENV]: "1"
  };
}
