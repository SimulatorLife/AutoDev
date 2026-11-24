import { realpathSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { isPathWithin } from "@simulatorlife/autodev-data/files";
import { z } from "zod";

import {
  MCP_FILESYSTEM_READ_ONLY_ENV,
  MCP_FILESYSTEM_WORKSPACE_ONLY_ENV
} from "../shared/tool-names.ts";

type Catalogue = Record<string, Record<string, unknown>>;

const identifier = z.string().regex(/^[a-zA-Z0-9_-]+$/u);
export const chatgptGrantsSchema = z.record(identifier, z.array(identifier).min(1));
const stdioServerSchema = z.object({
  command: z.string().min(1),
  args: z.array(z.string()),
  cwd: z.string(),
  toolPrefix: identifier,
  tools: z.array(identifier).min(1)
}).strict();
export const supergatewayConfigSchema = z.object({
  logLevel: z.literal("none"),
  logFormat: z.literal("json"),
  mcpServers: z.object({
    autodev: z.object({
      outputTransport: z.literal("stdio"),
      mcpServers: z.record(identifier, stdioServerSchema)
    }).strict()
  }).strict()
}).strict();
type StdioServer = z.infer<typeof stdioServerSchema>;
export type ChatgptSupergatewayConfig = z.infer<typeof supergatewayConfigSchema>;

export function qualifiedToolNames(config: ChatgptSupergatewayConfig): string[] {
  return Object.values(config.mcpServers.autodev.mcpServers)
    .flatMap(({ toolPrefix, tools }) => tools.map((tool) => toolPrefix + tool))
    .sort();
}

/**
 * AutoDev owns grants and workspace scope, not MCP protocol mechanics.
 * Supergateway owns discovery, namespacing, dispatch and process lifecycle.
 */
export function renderChatgptSupergatewayConfig(
  catalogue: Catalogue,
  grants: unknown,
  workspace: string,
  reviewedGrants: unknown,
  filter = { command: process.execPath, script: fileURLToPath(new URL("../mcp/tool-filter.ts", import.meta.url)) }
): string {
  if (!path.isAbsolute(workspace))
    throw new Error("ChatGPT MCP workspace must be absolute");
  const reviewed = chatgptGrantsSchema.safeParse(reviewedGrants);
  if (!reviewed.success) throw new Error("Invalid reviewed ChatGPT MCP policy");
  const desired = chatgptGrantsSchema.safeParse(grants);
  if (!desired.success) throw new Error("Explicit tool grants required; wildcards are not allowed");
  const approved = reviewed.data;
  const entries: Array<[string, StdioServer]> = [];
  const prefixes = new Set<string>();
  const qualified = new Set<string>();
  for (const [name, tools] of Object.entries(desired.data)) {
    if (!/^[a-zA-Z0-9_-]+$/u.test(name) || !Object.hasOwn(catalogue, name))
      throw new Error(`Unknown MCP declaration: ${name}`);
    const reviewed = Object.hasOwn(approved, name) ? approved[name] : undefined;
    if (!Array.isArray(reviewed) || tools.some((tool) => !reviewed.includes(tool)))
      throw new Error(`MCP grant exceeds the reviewed external policy: ${name}`);
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
    for (const tool of new Set(tools)) {
      const fullName = toolPrefix + tool;
      if (fullName.length > 64)
        throw new Error(`ChatGPT MCP tool name exceeds 64 characters: ${name}`);
      if (qualified.has(fullName))
        throw new Error(`Colliding MCP qualified tool name: ${fullName}`);
      qualified.add(fullName);
    }

    entries.push([
      name,
      {
        // Supergateway interpolates ${VAR} in config strings. Preserve the
        // canonical shell argument verbatim using its literal-dollar escape.
        command: escapeInterpolation(filter.command),
        args: [filter.script, descriptor.command, JSON.stringify(args), JSON.stringify([...new Set(tools)]), "external", name].map(escapeInterpolation),
        cwd: escapeInterpolation(workspace),
        toolPrefix,
        tools: [...new Set<string>(tools)]
      }
    ]);
  }
  if (!entries.length) throw new Error("No MCP tools granted to ChatGPT");

  // A combined stdio entry deliberately creates no HTTP/SSE listener.
  return JSON.stringify(supergatewayConfigSchema.parse({
    logLevel: "none",
    logFormat: "json",
    mcpServers: {
      autodev: {
        outputTransport: "stdio",
        mcpServers: Object.fromEntries(entries)
      }
    }
  }), null, 2) + "\n";
}

function escapeInterpolation(value: string): string {
  return value.replaceAll("$", () => "$$");
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
    isPathWithin(root, realpathSync(home)) ||
    isPathWithin(root, configuration) ||
    isPathWithin(configuration, root)
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
    [MCP_FILESYSTEM_READ_ONLY_ENV]: "1",
    [MCP_FILESYSTEM_WORKSPACE_ONLY_ENV]: "1"
  };
}
