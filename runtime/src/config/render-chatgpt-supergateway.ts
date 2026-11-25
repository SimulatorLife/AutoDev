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

export const CANONICAL_CHATGPT_POLICY_RELATIVE = path.join(
  ".rulesync",
  "permissions.jsonc"
);

const identifier = z.string().regex(/^[a-zA-Z0-9_-]+$/u);
export const chatgptGrantsSchema = z.record(
  identifier,
  z.array(identifier).min(1)
);

export interface RulesyncExternalMcpPermissions {
  readonly allowedServers: Set<string>;
  readonly deniedServers: Set<string>;
  readonly allowedTools: Record<string, string[]>;
  readonly deniedTools: Record<string, Set<string>>;
}
const stdioServerSchema = z
  .object({
    command: z.string().min(1),
    args: z.array(z.string()),
    cwd: z.string(),
    toolPrefix: identifier,
    tools: z.array(identifier).min(1)
  })
  .strict();
export const DEFAULT_CHATGPT_MCP_PORT = 3312;

export const supergatewayConfigSchema = z
  .object({
    host: z.literal("127.0.0.1"),
    port: z.number().int().min(1024).max(65535),
    logLevel: z.literal("none"),
    logFormat: z.literal("json"),
    healthEndpoint: z.tuple([z.literal("/readyz")]),
    mcpServers: z
      .object({
        autodev: z
          .object({
            path: z.literal("/"),
            outputTransport: z.literal("streamableHttp"),
            streamableHttpPath: z.literal("/mcp"),
            stateful: z.literal(true),
            sessionTimeout: z.number().int().min(1).optional(),
            apiKeyFile: z.string().min(1),
            mcpServers: z.record(identifier, stdioServerSchema)
          })
          .strict()
      })
      .strict()
  })
  .strict();
type StdioServer = z.infer<typeof stdioServerSchema>;
export type ChatgptSupergatewayConfig = z.infer<
  typeof supergatewayConfigSchema
>;
export interface ChatgptSupergatewayHttpOptions {
  port: number;
  apiKeyFile: string;
  sessionTimeout?: number;
}

export function qualifiedToolNames(
  config: ChatgptSupergatewayConfig
): string[] {
  return Object.values(config.mcpServers.autodev.mcpServers)
    .flatMap(({ toolPrefix, tools }) => tools.map((tool) => toolPrefix + tool))
    .sort();
}

/**
 * AutoDev owns grants, workspace scope, loopback binding and local auth.
 * Supergateway owns Streamable HTTP sessions, discovery, namespacing, dispatch and process lifecycle.
 */
export function renderChatgptSupergatewayConfig(
  catalogue: Catalogue,
  grants: unknown,
  workspace: string,
  reviewedGrants: unknown,
  http: ChatgptSupergatewayHttpOptions,
  filter = {
    command: process.execPath,
    script: fileURLToPath(new URL("../mcp/tool-filter.ts", import.meta.url))
  },
  confinedBackend?: (server: string) => { command: string; args: string[] }
): string {
  if (!path.isAbsolute(workspace))
    throw new Error("ChatGPT MCP workspace must be absolute");
  if (!Number.isInteger(http.port) || http.port < 1024 || http.port > 65535)
    throw new Error(
      "ChatGPT Supergateway port must be an integer from 1024 to 65535"
    );
  if (!path.isAbsolute(http.apiKeyFile))
    throw new Error("ChatGPT Supergateway API key file must be absolute");
  const reviewed = chatgptGrantsSchema.safeParse(reviewedGrants);
  if (!reviewed.success) throw new Error("Invalid reviewed ChatGPT MCP policy");
  const desired = chatgptGrantsSchema.safeParse(grants);
  if (!desired.success)
    throw new Error("Explicit tool grants required; wildcards are not allowed");
  const approved = reviewed.data;
  const entries: Array<[string, StdioServer]> = [];
  const prefixes = new Set<string>();
  const qualified = new Set<string>();
  for (const [name, tools] of Object.entries(desired.data)) {
    if (!/^[a-zA-Z0-9_-]+$/u.test(name) || !Object.hasOwn(catalogue, name))
      throw new Error(`Unknown MCP declaration: ${name}`);
    const reviewed = Object.hasOwn(approved, name) ? approved[name] : undefined;
    if (
      !Array.isArray(reviewed) ||
      tools.some((tool) => !reviewed.includes(tool))
    )
      throw new Error(
        `MCP grant exceeds the reviewed external policy: ${name}`
      );
    const descriptor = catalogue[name]!;
    if (descriptor.env !== undefined)
      throw new Error(
        `Unsupported external MCP transport or credentials: ${name}`
      );

    const uniqueTools = [...new Set(tools)];
    const toolPrefix = name.replaceAll("-", "_") + "__";
    if (prefixes.has(toolPrefix))
      throw new Error(`Colliding MCP namespace: ${name}`);
    prefixes.add(toolPrefix);
    for (const tool of uniqueTools) {
      const fullName = toolPrefix + tool;
      if (fullName.length > 64)
        throw new Error(`ChatGPT MCP tool name exceeds 64 characters: ${name}`);
      if (qualified.has(fullName))
        throw new Error(`Colliding MCP qualified tool name: ${fullName}`);
      qualified.add(fullName);
    }

    let filterTargetCommand: string;
    let filterTargetArgs: string;
    if (descriptor.url !== undefined) {
      if (
        descriptor.command !== undefined ||
        !isApprovedRemoteUrl(descriptor.url)
      )
        throw new Error(
          `Unsupported external MCP transport or credentials: ${name}`
        );
      const bearerVar = descriptor.bearer_token_env_var;
      if (
        bearerVar !== undefined &&
        (typeof bearerVar !== "string" || !/^[A-Z0-9_]+$/u.test(bearerVar))
      )
        throw new Error(
          `Unsupported external MCP transport or credentials: ${name}`
        );
      const httpHeaders = descriptor.http_headers;
      if (httpHeaders !== undefined && !isApprovedHeaderTemplates(httpHeaders))
        throw new Error(
          `Unsupported external MCP transport or credentials: ${name}`
        );
      filterTargetCommand = "--remote";
      filterTargetArgs = JSON.stringify({
        url: descriptor.url,
        ...(bearerVar !== undefined ? { bearer_token_env_var: bearerVar } : {}),
        ...(httpHeaders !== undefined ? { http_headers: httpHeaders } : {})
      });
    } else {
      if (
        typeof descriptor.command !== "string" ||
        !descriptor.command.trim() ||
        descriptor.bearer_token_env_var !== undefined ||
        descriptor.http_headers !== undefined
      )
        throw new Error(
          `Unsupported external MCP transport or credentials: ${name}`
        );
      const args = descriptor.args ?? [];
      if (
        !Array.isArray(args) ||
        !args.every((arg): arg is string => typeof arg === "string")
      )
        throw new Error(`Invalid MCP arguments: ${name}`);
      if (descriptor.cwd !== undefined && descriptor.cwd !== workspace)
        throw new Error(
          `MCP cwd does not match the selected workspace: ${name}`
        );

      const backend = confinedBackend?.(name) ?? {
        command: descriptor.command,
        args
      };
      filterTargetCommand = backend.command;
      filterTargetArgs = JSON.stringify(backend.args);
    }

    entries.push([
      name,
      {
        // Supergateway interpolates ${VAR} in config strings. Preserve the
        // canonical shell argument and header templates using its literal-dollar escape.
        command: escapeInterpolation(filter.command),
        args: [
          filter.script,
          filterTargetCommand,
          filterTargetArgs,
          JSON.stringify(uniqueTools),
          "external",
          name
        ].map(escapeInterpolation),
        cwd: escapeInterpolation(workspace),
        toolPrefix,
        tools: uniqueTools
      }
    ]);
  }
  if (!entries.length) throw new Error("No MCP tools granted to ChatGPT");

  return (
    JSON.stringify(
      supergatewayConfigSchema.parse({
        host: "127.0.0.1",
        port: http.port,
        logLevel: "none",
        logFormat: "json",
        healthEndpoint: ["/readyz"],
        mcpServers: {
          autodev: {
            path: "/",
            outputTransport: "streamableHttp",
            streamableHttpPath: "/mcp",
            stateful: true,
            ...(http.sessionTimeout !== undefined
              ? { sessionTimeout: http.sessionTimeout }
              : {}),
            apiKeyFile: escapeInterpolation(http.apiKeyFile),
            mcpServers: Object.fromEntries(entries)
          }
        }
      }),
      null,
      2
    ) + "\n"
  );
}

function escapeInterpolation(value: string): string {
  return value.replaceAll("$", () => "$$");
}

export function isApprovedRemoteUrl(rawUrl: unknown): rawUrl is string {
  if (typeof rawUrl !== "string" || !rawUrl.trim()) return false;
  try {
    const parsed = new URL(rawUrl);
    if (parsed.username || parsed.password) return false;
    if (parsed.protocol === "https:") return true;
    return (
      parsed.protocol === "http:" &&
      (parsed.hostname === "127.0.0.1" ||
        parsed.hostname === "localhost" ||
        parsed.hostname === "::1" ||
        parsed.hostname === "[::1]")
    );
  } catch {
    return false;
  }
}

export function isApprovedHeaderTemplates(
  headers: unknown
): headers is Record<string, string> {
  if (!headers || typeof headers !== "object" || Array.isArray(headers))
    return false;
  return Object.entries(headers).every(([key, value]) => {
    if (!key.trim() || typeof value !== "string" || !value.trim()) return false;
    // Headers must reference runtime-resolved env placeholders rather than
    // embedding literal credentials in generated Supergateway configs.
    return /^\$\{[A-Z0-9_]+\}$/u.test(value);
  });
}

export function requiredRemoteSecretNames(
  descriptor: Record<string, unknown>
): string[] {
  const names = new Set<string>();
  if (typeof descriptor.bearer_token_env_var === "string") {
    names.add(descriptor.bearer_token_env_var);
  }
  if (
    descriptor.http_headers &&
    typeof descriptor.http_headers === "object" &&
    !Array.isArray(descriptor.http_headers)
  ) {
    for (const template of Object.values(descriptor.http_headers)) {
      if (typeof template !== "string") continue;
      for (const match of template.matchAll(/\$\{([A-Z0-9_]+)\}/gu)) {
        if (match[1]) names.add(match[1]);
      }
    }
  }
  return [...names];
}

function stripJsoncComments(raw: string): string {
  let out = "";
  let inString = false;
  let escaped = false;
  let inLineComment = false;
  let inBlockComment = false;
  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i]!;
    const next = raw[i + 1];
    if (inLineComment) {
      if (ch === "\n") {
        inLineComment = false;
        out += ch;
      }
      continue;
    }
    if (inBlockComment) {
      if (ch === "*" && next === "/") {
        inBlockComment = false;
        i += 1;
      } else if (ch === "\n") {
        out += ch;
      }
      continue;
    }
    if (inString) {
      out += ch;
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      continue;
    }
    if (ch === "/" && next === "/") {
      inLineComment = true;
      i += 1;
      continue;
    }
    if (ch === "/" && next === "*") {
      inBlockComment = true;
      i += 1;
      continue;
    }
    out += ch;
  }
  return out;
}

/**
 * Derive external MCP grants and denials from canonical `.rulesync/permissions.jsonc`
 * so the ChatGPT tunnel does not duplicate MCP permission declarations.
 */
export function parseRulesyncExternalMcpPermissions(
  jsoncText: string
): RulesyncExternalMcpPermissions {
  const parsed: unknown = JSON.parse(stripJsoncComments(jsoncText));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Invalid canonical .rulesync/permissions.jsonc root");
  }
  const permission = (parsed as Record<string, unknown>).permission;
  if (
    !permission ||
    typeof permission !== "object" ||
    Array.isArray(permission)
  ) {
    throw new Error(
      "Missing permission section in canonical .rulesync/permissions.jsonc"
    );
  }
  const allowedServers = new Set<string>();
  const deniedServers = new Set<string>();
  const allowedTools: Record<string, string[]> = {};
  const deniedTools: Record<string, Set<string>> = {};

  for (const [key, rule] of Object.entries(permission)) {
    if (!key.startsWith("mcp__")) continue;
    if (!rule || typeof rule !== "object" || Array.isArray(rule)) continue;
    const verdict = (rule as Record<string, unknown>)["*"];
    if (verdict !== "allow" && verdict !== "deny") continue;
    const remainder = key.slice(5);
    const separator = remainder.indexOf("__");
    if (separator === -1) {
      if (!identifier.safeParse(remainder).success) continue;
      if (verdict === "deny") {
        deniedServers.add(remainder);
        allowedServers.delete(remainder);
      } else if (!deniedServers.has(remainder)) {
        allowedServers.add(remainder);
      }
      continue;
    }
    const server = remainder.slice(0, separator);
    const tool = remainder.slice(separator + 2);
    if (
      !identifier.safeParse(server).success ||
      !identifier.safeParse(tool).success
    )
      continue;
    if (verdict === "deny") {
      (deniedTools[server] ??= new Set<string>()).add(tool);
      if (allowedTools[server]) {
        allowedTools[server] = allowedTools[server].filter((t) => t !== tool);
        if (allowedTools[server].length === 0) delete allowedTools[server];
      }
    } else if (!deniedServers.has(server) && !deniedTools[server]?.has(tool)) {
      const list = (allowedTools[server] ??= []);
      if (!list.includes(tool)) list.push(tool);
    }
  }

  return { allowedServers, deniedServers, allowedTools, deniedTools };
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
