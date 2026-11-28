import { realpathSync, statSync } from "node:fs";
import path from "node:path";

import {
  isPathWithin,
  parseJsoncObject
} from "@simulatorlife/autodev-data/files";
import { z } from "zod";

import {
  CHATGPT_MCP_POOL_PORT_ENV,
  CHATGPT_MCP_POOL_TOKEN_ENV,
  type ChatgptBackendPoolConfig,
  chatgptBackendPoolConfigSchema,
  type PooledBackendSpec
} from "../mcp/chatgpt-backend-pool.ts";
import { hasRoleContract, roleContract } from "../shared/execution-contract.ts";
import {
  MCP_FILESYSTEM_READ_ONLY_ENV,
  MCP_SERVER_XACPX
} from "../shared/tool-names.ts";
import { resolveXacpxOrchestrationSocketPath } from "../xacpx/orchestration-ipc.ts";

/**
The variable carrying the XACPX delegation coordinator identity to `xacpx
mcp-stdio` (the launcher turns it into `--coordinator-session`).
*/
const XACPX_COORDINATOR_SESSION_ENV = "AUTODEV_XACPX_COORDINATOR_SESSION";

type Catalogue = Record<string, Record<string, unknown>>;

export const CANONICAL_CHATGPT_POLICY_RELATIVE = path.join(
  ".rulesync",
  "permissions.jsonc"
);
export const CANONICAL_EXECUTION_CONTRACT_RELATIVE = path.join(
  "config",
  "execution-contract.json"
);
export const DEFAULT_CHATGPT_ROLE = "orchestrator" as const;

const identifier = z.string().regex(/^[a-zA-Z0-9_-]+$/u);
const toolIdentifier = z.string().regex(/^[a-zA-Z0-9_.-]+$/u);
export const chatgptGrantsSchema = z.record(
  identifier,
  z.array(toolIdentifier).min(1)
);

export function resolveChatgptRole(role?: string | null): string {
  const normalized = role?.trim().toLowerCase() || DEFAULT_CHATGPT_ROLE;
  if (!hasRoleContract(normalized)) {
    throw new Error(`Unknown AutoDev agent role for ChatGPT: ${normalized}`);
  }
  return normalized;
}

export interface RulesyncExternalMcpPermissions {
  readonly allowedServers: Set<string>;
  readonly deniedServers: Set<string>;
  readonly allowedTools: Record<string, string[]>;
  readonly deniedTools: Record<string, Set<string>>;
}
// Every gateway member is a backend-pool route.
const streamableHttpServerSchema = z
  .object({
    url: z.string().min(1),
    type: z.literal("streamableHttp"),
    oauth2Bearer: z.string().min(1),
    toolPrefix: identifier,
    tools: z.array(toolIdentifier).min(1)
  })
  .strict();
const gatewayServerSchema = streamableHttpServerSchema;
/**
One role's published surface.

Every role the tunnel publishes gets its own named server at its own path,
so a conversation that binds to one surface can only ever reach that role's
tools.
*/
const chatgptRoleSurfaceSchema = z
  .object({
    path: z.string().regex(/^(\/[a-zA-Z0-9_-]+)+$/u),
    outputTransport: z.literal("streamableHttp"),
    streamableHttpPath: z.literal("/mcp"),
    stateful: z.literal(true),
    sessionTimeout: z.number().int().min(1).optional(),
    apiKeyFile: z.string().min(1),
    mcpServers: z.record(identifier, gatewayServerSchema)
  })
  .strict();
/**
One role's server for local clients, at `/local/<role>/<server>`: a single
pool route under the server's own identity, so local clients keep canonical
server and tool names. It accepts only the local key, which the ChatGPT tunnel
never holds, and every call must carry a session grant.
*/
const localServerSurfaceSchema = z
  .object({
    path: z.string().regex(/^\/local\/[a-z0-9-]+\/[a-zA-Z0-9_-]+$/u),
    url: z.string().min(1),
    type: z.literal("streamableHttp"),
    oauth2Bearer: z.string().min(1),
    outputTransport: z.literal("streamableHttp"),
    streamableHttpPath: z.literal("/mcp"),
    stateful: z.literal(true),
    apiKeyFile: z.string().min(1)
  })
  .strict();
export const DEFAULT_CHATGPT_MCP_PORT = 3312;
/**
Bound idle stateful sessions (Supergateway defaults to 30m) because external
clients such as ChatGPT open a fresh session per tool call without DELETE.
Supergateway's SessionAccessCounter starts this countdown only after all
in-flight HTTP responses finish, so active long-running calls are unaffected.
*/
export const DEFAULT_CHATGPT_SESSION_TIMEOUT_MS = 60_000;

export const supergatewayConfigSchema = z
  .object({
    host: z.literal("127.0.0.1"),
    port: z.number().int().min(1024).max(65_535),
    logLevel: z.literal("none"),
    logFormat: z.literal("json"),
    healthEndpoint: z.tuple([z.literal("/readyz")]),
    mcpServers: z.record(
      identifier,
      z.union([chatgptRoleSurfaceSchema, localServerSurfaceSchema])
    )
  })
  .strict();
type GatewayServer = z.infer<typeof gatewayServerSchema>;
export type ChatgptSupergatewayConfig = z.infer<
  typeof supergatewayConfigSchema
>;
export interface ChatgptSupergatewayHttpOptions {
  port: number;
  apiKeyFile: string;
  sessionTimeout?: number;
}

/**
The role surfaces local clients reach with session grants: each role's full
authorized grants, served in whatever workspace a grant names.
*/
export interface LocalGatewaySurfaces {
  readonly roles: ChatgptRoleSurface[];
  /**
  The local-only key file every local surface requires.
  */
  readonly apiKeyFile: string;
}

/**
The pooled route that serves one role's server to local clients.
*/
export function localPoolServerKey(role: string, server: string): string {
  return `local.${role}.${server}`;
}

/**
The gateway path of one role's server for local clients.
*/
function localSurfacePath(role: string, server: string): string {
  return `/local/${role}/${server}`;
}

export function localSurfaceName(role: string, server: string): string {
  return `local-${role}-${server}`;
}

export function qualifiedToolNames(
  config: ChatgptSupergatewayConfig
): string[] {
  return [
    ...new Set(
      Object.values(config.mcpServers)
        .flatMap((surface) =>
          "mcpServers" in surface ? Object.values(surface.mcpServers) : []
        )
        .flatMap(({ toolPrefix, tools }) =>
          tools.map((tool) => toolPrefix + tool)
        )
    )
  ].sort();
}

interface ValidatedExternalServer {
  readonly name: string;
  readonly toolPrefix: string;
  readonly tools: string[];
  readonly poolSpec: PooledBackendSpec;
}

/**
One role's published MCP surface.

`grants` are the role's authorized grants and `reviewed` the policy they may
not exceed. Both are the role's own, so each surface enforces exactly that
role's contract and never another role's.
*/
export interface ChatgptRoleSurface {
  readonly role: string;
  readonly grants: unknown;
  readonly reviewed: unknown;
}

/**
Builds the confined backend command for one role's MCP server.
*/
export type ChatgptConfinedBackend = (
  server: string,
  role: string
) => { command: string; args: string[] };

function resolveValidatedExternalServers(
  catalogue: Catalogue,
  grants: unknown,
  workspace: string,
  reviewedGrants: unknown,
  confinedBackend?: ChatgptConfinedBackend,
  role: string = DEFAULT_CHATGPT_ROLE
): ValidatedExternalServer[] {
  if (!path.isAbsolute(workspace))
    throw new Error("ChatGPT MCP workspace must be absolute");
  const reviewed = chatgptGrantsSchema.safeParse(reviewedGrants);
  if (!reviewed.success) throw new Error("Invalid reviewed ChatGPT MCP policy");
  const desired = chatgptGrantsSchema.safeParse(grants);
  if (!desired.success)
    throw new Error("Explicit tool grants required; wildcards are not allowed");
  const approved = reviewed.data;
  const resolved: ValidatedExternalServer[] = [];
  const prefixes = new Set<string>();
  const qualified = new Set<string>();
  for (const [name, tools] of Object.entries(desired.data)) {
    if (!/^[a-zA-Z0-9_-]+$/u.test(name) || !Object.hasOwn(catalogue, name))
      throw new Error(`Unknown MCP declaration: ${name}`);
    const allowedByPolicy = Object.hasOwn(approved, name)
      ? approved[name]
      : undefined;
    if (
      !Array.isArray(allowedByPolicy) ||
      tools.some((tool) => !allowedByPolicy.includes(tool))
    )
      throw new Error(`MCP grant exceeds the authorized role policy: ${name}`);
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

    if (descriptor.url === undefined) {
      if (
        typeof descriptor.command !== "string" ||
        !descriptor.command.trim() ||
        descriptor.bearer_token_env_var !== undefined ||
        descriptor.http_headers !== undefined
      )
        throw new Error(
          `Unsupported external MCP transport or credentials: ${name}`
        );
      const arguments_ = descriptor.args ?? [];
      if (
        !Array.isArray(arguments_) ||
        !arguments_.every((argument): argument is string => typeof argument === "string")
      )
        throw new Error(`Invalid MCP arguments: ${name}`);
      if (descriptor.cwd !== undefined && descriptor.cwd !== workspace)
        throw new Error(
          `MCP cwd does not match the selected workspace: ${name}`
        );

      const backend = confinedBackend?.(name, role) ?? {
        command: descriptor.command,
        args: arguments_
      };
      resolved.push({
        name,
        toolPrefix,
        tools: uniqueTools,
        poolSpec: {
          kind: "stdio",
          server: name,
          command: backend.command,
          args: backend.args,
          cwd: workspace,
          tools: uniqueTools,
          env: chatgptRoleEnvironment(role, workspace),
          // Delegation acts for one ChatGPT conversation: each conversation
          // gets its own coordinator, so it can see and steer only the
          // children it delegated.
          ...((name === MCP_SERVER_XACPX) && { conversationScopedEnv: XACPX_COORDINATOR_SESSION_ENV })
        }
      });
    } else {
      if (
        descriptor.command !== undefined ||
        !isApprovedRemoteUrl(descriptor.url)
      )
        throw new Error(
          `Unsupported external MCP transport or credentials: ${name}`
        );
      const bearerVariable = descriptor.bearer_token_env_var;
      if (
        bearerVariable !== undefined &&
        (typeof bearerVariable !== "string" || !/^[A-Z0-9_]+$/u.test(bearerVariable))
      )
        throw new Error(
          `Unsupported external MCP transport or credentials: ${name}`
        );
      const httpHeaders = descriptor.http_headers;
      if (httpHeaders !== undefined && !isApprovedHeaderTemplates(httpHeaders))
        throw new Error(
          `Unsupported external MCP transport or credentials: ${name}`
        );
      resolved.push({
        name,
        toolPrefix,
        tools: uniqueTools,
        poolSpec: {
          kind: "remote",
          url: descriptor.url,
          ...((bearerVariable !== undefined) && { bearer_token_env_var: bearerVariable }),
          ...((httpHeaders !== undefined) && { http_headers: httpHeaders }),
          tools: uniqueTools
        }
      });
    }
  }
  if (resolved.length === 0) throw new Error("No MCP tools granted to ChatGPT");
  return resolved;
}

/**
Render the private loopback backend-pool manifest paired with pooled
Supergateway configs. Contains only role-approved commands/URLs and env var
references — never literal credentials.

Each published role gets its own pooled backends, so a role's tool
allowlist and its role-scoped environment are enforced independently of every
other role sharing the gateway.
*/
export function renderChatgptBackendPoolConfig(
  catalogue: Catalogue,
  surfaces: ChatgptRoleSurface[],
  workspace: string,
  confinedBackend?: ChatgptConfinedBackend,
  local?: LocalGatewaySurfaces
): string {
  const servers: ChatgptBackendPoolConfig["servers"] = {};
  for (const surface of local?.roles ?? []) {
    for (const entry of resolveValidatedExternalServers(
      catalogue,
      surface.grants,
      workspace,
      surface.reviewed,
      confinedBackend,
      surface.role
    )) {
      // A local backend is provisioned per admitted workspace; a remote one
      // has no workspace and is shared.
      servers[localPoolServerKey(surface.role, entry.name)] =
        entry.poolSpec.kind === "stdio"
          ? {
              kind: "admitted",
              role: surface.role,
              server: entry.name,
              tools: entry.tools
            }
          : entry.poolSpec;
    }
  }
  for (const surface of surfaces) {
    const resolved = resolveValidatedExternalServers(
      catalogue,
      surface.grants,
      workspace,
      surface.reviewed,
      confinedBackend,
      surface.role
    );
    for (const entry of resolved) {
      servers[chatgptPoolServerKey(surface.role, entry.name)] = entry.poolSpec;
    }
  }
  const manifest: ChatgptBackendPoolConfig =
    chatgptBackendPoolConfigSchema.parse({
      version: 1,
      servers
    });
  return JSON.stringify(manifest, null, 2) + "\n";
}

/**
The pooled backend key that carries one role's instance of one MCP server.
*/
function chatgptPoolServerKey(role: string, server: string): string {
  return `${role}.${server}`;
}

/**
AutoDev owns grants, workspace scope, loopback binding and local auth.
Supergateway owns Streamable HTTP sessions, discovery, namespacing, dispatch and process lifecycle.

One named server is published per role, each at its own path, so a
conversation that binds to one role's surface can only reach that role's
contracted tools.
*/
export function renderChatgptSupergatewayConfig(
  catalogue: Catalogue,
  surfaces: ChatgptRoleSurface[],
  workspace: string,
  http: ChatgptSupergatewayHttpOptions,
  confinedBackend?: ChatgptConfinedBackend,
  local?: LocalGatewaySurfaces
): string {
  if (!path.isAbsolute(workspace))
    throw new Error("ChatGPT MCP workspace must be absolute");
  if (local && !path.isAbsolute(local.apiKeyFile))
    throw new Error("Local gateway API key file must be absolute");
  if (!Number.isInteger(http.port) || http.port < 1024 || http.port > 65_535)
    throw new Error(
      "ChatGPT Supergateway port must be an integer from 1024 to 65535"
    );
  if (!path.isAbsolute(http.apiKeyFile))
    throw new Error("ChatGPT Supergateway API key file must be absolute");
  if (surfaces.length === 0)
    throw new Error("No ChatGPT MCP role surface to publish");
  const published = Object.fromEntries(
    surfaces.map((surface) => {
      const resolvedServers = resolveValidatedExternalServers(
        catalogue,
        surface.grants,
        workspace,
        surface.reviewed,
        confinedBackend,
        surface.role
      );
      // Every member is served by the loopback backend pool: one backend
      // per role and server, shared by every Supergateway session.
      const entries: Array<[string, GatewayServer]> = resolvedServers.map(
        (entry) => [
          entry.name,
          {
            url: `http://127.0.0.1:\${${CHATGPT_MCP_POOL_PORT_ENV}}/mcp/${chatgptPoolServerKey(surface.role, entry.name)}`,
            type: "streamableHttp",
            oauth2Bearer: `\${${CHATGPT_MCP_POOL_TOKEN_ENV}}`,
            toolPrefix: entry.toolPrefix,
            tools: entry.tools
          }
        ]
      );
      return [
        surface.role,
        {
          path: `/${surface.role}`,
          outputTransport: "streamableHttp",
          streamableHttpPath: "/mcp",
          stateful: true,
          ...((http.sessionTimeout !== undefined) && { sessionTimeout: http.sessionTimeout }),
          apiKeyFile: escapeInterpolation(http.apiKeyFile),
          mcpServers: Object.fromEntries(entries)
        }
      ];
    })
  );

  return (
    JSON.stringify(
      supergatewayConfigSchema.parse({
        host: "127.0.0.1",
        port: http.port,
        logLevel: "none",
        logFormat: "json",
        healthEndpoint: ["/readyz"],
        mcpServers: {
          ...published,
          ...localSurfaces(catalogue, workspace, local, confinedBackend)
        }
      }),
      null,
      2
    ) + "\n"
  );
}

function localSurfaces(
  catalogue: Catalogue,
  workspace: string,
  local: LocalGatewaySurfaces | undefined,
  confinedBackend: ChatgptConfinedBackend | undefined
): Record<string, z.infer<typeof localServerSurfaceSchema>> {
  const entries: Array<[string, z.infer<typeof localServerSurfaceSchema>]> = [];
  for (const surface of local?.roles ?? []) {
    for (const entry of resolveValidatedExternalServers(
      catalogue,
      surface.grants,
      workspace,
      surface.reviewed,
      confinedBackend,
      surface.role
    )) {
      entries.push([
        localSurfaceName(surface.role, entry.name),
        {
          path: localSurfacePath(surface.role, entry.name),
          url: `http://127.0.0.1:\${${CHATGPT_MCP_POOL_PORT_ENV}}/mcp/${localPoolServerKey(surface.role, entry.name)}`,
          type: "streamableHttp",
          oauth2Bearer: `\${${CHATGPT_MCP_POOL_TOKEN_ENV}}`,
          outputTransport: "streamableHttp",
          streamableHttpPath: "/mcp",
          stateful: true,
          apiKeyFile: escapeInterpolation(local!.apiKeyFile)
        }
      ]);
    }
  }
  return Object.fromEntries(entries);
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

/**
Derive external MCP grants and denials from canonical `.rulesync/permissions.jsonc`
so the ChatGPT tunnel does not duplicate MCP permission declarations.
*/
export function parseRulesyncExternalMcpPermissions(
  jsoncText: string
): RulesyncExternalMcpPermissions {
  const parsed = parseJsoncObject(
    jsoncText,
    "canonical .rulesync/permissions.jsonc"
  );
  const permission = parsed.permission;
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
    if (!key.startsWith("mcp__") || !rule || typeof rule !== "object" || Array.isArray(rule)) continue;
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
      !toolIdentifier.safeParse(tool).success
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
  const config = realpathSync(codexHome);
  if (
    isPathWithin(root, realpathSync(home)) ||
    isPathWithin(root, config) ||
    isPathWithin(config, root)
  )
    throw new Error("ChatGPT workspace overlaps home or AutoDev configuration");
  return root;
}

export interface ChatgptSupergatewayEnvironmentOptions {
  /**
  Canonical AutoDev role governing this gateway's capabilities. Defaults to `orchestrator`.
  */
  readonly role?: string;
  /**
  Coordinator session identifier bound to XACPX delegation for this gateway.
  */
  readonly coordinatorSession?: string;
  /**
  Optional explicit XACPX orchestration Unix socket path.
  */
  readonly xacpxSocketPath?: string;
}

/**
The environment one role's backends run with.

The role identity is role-scoped, so the backends of one published surface
report the role they actually served and a read-only role's backends keep
their read-only confinement. The delegation coordinator stays on the shared
gateway environment: only the orchestrator surface carries the `xacpx`
server, so the gateway's own coordinator is the one that owns children.
*/
export function chatgptRoleEnvironment(
  role: string,
  workspace: string
): Record<string, string> {
  const normalized = resolveChatgptRole(role);
  const workspaceName = path.basename(workspace) || "workspace";
  return {
    AUTODEV_AGENT_ROLE: normalized,
    // Each surface owns its own coordinator, so a conversation bound to one
    // role delegates under that role's identity and never another's.
    [XACPX_COORDINATOR_SESSION_ENV]: `chatgpt:${normalized}:${workspaceName}`,
    ...((roleContract(normalized).readOnly === true) && { [MCP_FILESYSTEM_READ_ONLY_ENV]: "1" })
  };
}

/**
Pass this as the entire environment of the Supergateway process, not a
delta merged with the tunnel client's environment. Its children inherit
only these values. Read-only mode is set strictly from the assigned role's
canonical execution contract, never hardcoded for ChatGPT.
*/
export function chatgptSupergatewayEnvironment(
  paths: { home: string; codexHome: string; repositoryRoot: string },
  workspace: string,
  node: string,
  servicePath: string,
  options: ChatgptSupergatewayEnvironmentOptions = {}
): Record<string, string> {
  const role = resolveChatgptRole(options.role);
  const workspaceName = path.basename(workspace) || "workspace";
  const coordinatorSession =
    options.coordinatorSession?.trim() || `chatgpt:${role}:${workspaceName}`;
  const xacpxSocketPath =
    options.xacpxSocketPath?.trim() ||
    resolveXacpxOrchestrationSocketPath(paths.codexHome, {});
  return {
    HOME: paths.home,
    CODEX_HOME: paths.codexHome,
    PATH: servicePath,
    AUTODEV_REPO_ROOT: paths.repositoryRoot,
    AUTODEV_NODE_BIN: node,
    AUTODEV_MCP_WORKSPACE: workspace,
    AUTODEV_AGENT_ROLE: role,
    AUTODEV_XACPX_WORKSPACE: workspace,
    AUTODEV_XACPX_COORDINATOR_SESSION: coordinatorSession,
    XACPX_ORCHESTRATION_SOCKET: xacpxSocketPath
  };
}
