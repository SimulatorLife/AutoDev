/**
The shared AutoDev MCP gateway service.

One LaunchAgent (`com.codex.autodev-mcp-gateway`) runs the backend pool and
Supergateway on loopback, serving one authenticated Streamable HTTP surface
per published agent role at `http://127.0.0.1:<port>/<role>/mcp`. The
installer always reconciles it; it does not depend on the optional ChatGPT
tunnel, which is only one client of it. Disabling or losing the tunnel never
touches this service.

The gateway's bearer key lives at the service directory's root and survives
reconfiguration, so clients that hold the header file keep working across
regenerations.
*/
import {
  type ChildProcess,
  execFileSync,
  spawn,
  spawnSync
} from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync
} from "node:fs";
import path from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { atomicWriteSync } from "@simulatorlife/autodev-data/files";
import {
  writeErrorLine,
  writeLine
} from "@simulatorlife/autodev-runtime/shared/output";
import { z } from "zod";

import {
  CANONICAL_CHATGPT_POLICY_RELATIVE,
  CANONICAL_EXECUTION_CONTRACT_RELATIVE,
  chatgptGrantsSchema,
  type ChatgptRoleSurface,
  chatgptSupergatewayEnvironment,
  DEFAULT_CHATGPT_MCP_PORT,
  DEFAULT_CHATGPT_ROLE,
  DEFAULT_CHATGPT_SESSION_TIMEOUT_MS,
  isApprovedHeaderTemplates,
  isApprovedRemoteUrl,
  parseRulesyncExternalMcpPermissions,
  renderChatgptBackendPoolConfig,
  renderChatgptSupergatewayConfig,
  requiredRemoteSecretNames,
  resolveChatgptRole,
  supergatewayConfigSchema,
  validateChatgptWorkspace
} from "../config/render-chatgpt-supergateway.ts";
import {
  CHATGPT_MCP_POOL_PORT_ENV,
  CHATGPT_MCP_POOL_TOKEN_ENV,
  chatgptBackendPoolConfigSchema,
  type ChatgptBackendPoolHandle,
  startChatgptBackendPool
} from "../mcp/chatgpt-backend-pool.ts";
import {
  externalMcpBackend,
  hasExternalMcpProfile
} from "../mcp/chatgpt-filesystem-sandbox.ts";
import { readBridgeMcpCatalogue } from "../mcp/filesystem-server.ts";
import { isEntryPoint } from "../shared/entry-point.ts";
import { runtimeBinDirectory } from "../shared/executables.ts";
import {
  declaredRoleNames,
  roleContract
} from "../shared/execution-contract.ts";
import { resolveRemoteMcpHeaders } from "../shared/mcp-headers.ts";
import {
  readRuntimeSecret,
  resolveManagedSecret
} from "../shared/runtime-secrets.ts";
import {
  MCP_SERVER_COMMANDS,
  MCP_SERVER_FILESYSTEM,
  MCP_SERVER_XACPX
} from "../shared/tool-names.ts";
import { XacpxSessionManager } from "../xacpx/manager.ts";
import {
  startXacpxOrchestrationIpcServer,
  type XacpxOrchestrationIpcHandle
} from "../xacpx/orchestration-ipc.ts";
import {
  approvedCommandCataloguePath,
  installedCommandCatalogueDigest
} from "./command-catalogue-approval.ts";
import { httpHealthProbe } from "./health-probe.ts";
import { resolveServiceNode } from "./host-arch.ts";
import {
  launchAgentMatches,
  type LaunchAgentValues,
  renderLaunchAgent,
  resolveLaunchAgentValues
} from "./macos/launchagent.ts";
import { LaunchdClient } from "./macos/launchd.ts";
import { resolveCommandOnPath } from "./runtime-files.ts";
import { RUNTIME_SOURCE_LINK } from "./runtime-source-generation.ts";
import { sleep } from "./sleep.ts";
import { waitForProbe } from "./wait-for-probe.ts";

export const MCP_GATEWAY_LABEL = "com.codex.autodev-mcp-gateway";
export const MCP_GATEWAY_DIRECTORY = "mcp-gateway";
export const MCP_GATEWAY_WORKSPACE_ENV = "AUTODEV_MCP_GATEWAY_WORKSPACE";
export const MCP_GATEWAY_PORT_ENV = "AUTODEV_MCP_GATEWAY_PORT";
// The primary role: it owns the gateway's delegation coordinator.
export const MCP_GATEWAY_ROLE_ENV = "AUTODEV_MCP_GATEWAY_ROLE";
// Comma-separated additional roles the gateway publishes a surface for.
export const MCP_GATEWAY_ROLES_ENV = "AUTODEV_MCP_GATEWAY_ROLES";
export const MCP_GATEWAY_POLICY_FILE_ENV = "AUTODEV_MCP_GATEWAY_POLICY_FILE";

export interface ServicePaths {
  repositoryRoot: string;
  home: string;
  codexHome: string;
}

const gatewayStateSchema = z
  .object({
    version: z.literal(1),
    workspace: z.string().refine(path.isAbsolute),
    role: z.string().min(1),
    // Every role the gateway publishes a surface for, primary role first.
    roles: z.array(z.string().min(1)).min(1),
    policyFile: z.string().refine(path.isAbsolute),
    policyDigest: z.string().regex(/^[a-f0-9]{64}$/u),
    reviewed: chatgptGrantsSchema,
    grants: chatgptGrantsSchema,
    generation: z.string().regex(/^generation-[a-zA-Z0-9_-]+$/u),
    mcpPort: z.number().int().min(1024).max(65_535),
    node: z.string().refine(path.isAbsolute),
    supergateway: z.string().refine(path.isAbsolute),
    servicePath: z.string().min(1)
  })
  .strict();
export type McpGatewayState = z.infer<typeof gatewayStateSchema>;

/**
An operator's reconfiguration of the published surfaces. An empty `grants`
record restores the reviewed grants.
*/
export const mcpGatewayConfigurationSchema = z
  .object({
    workspace: z.string().min(1),
    role: z.string().min(1).optional(),
    roles: z.array(z.string().min(1)).min(1).optional(),
    grants: chatgptGrantsSchema
  })
  .strict();
export type McpGatewayConfiguration = z.infer<
  typeof mcpGatewayConfigurationSchema
>;

// ---------------------------------------------------------------------------
// Private files shared by the gateway and its clients.
// ---------------------------------------------------------------------------

/**
The process environment a service subprocess may inherit: locale, paths and
the Keychain overrides, never a credential.
*/
export function dependencyEnvironment(
  environment: NodeJS.ProcessEnv
): NodeJS.ProcessEnv {
  const keys = [
    "HOME",
    "PATH",
    "USER",
    "LOGNAME",
    "TMPDIR",
    "LANG",
    "LC_ALL",
    "PNPM_HOME",
    "HOMEBREW_PREFIX",
    "HOMEBREW_CELLAR",
    "HOMEBREW_REPOSITORY",
    "AUTODEV_DISABLE_KEYCHAIN",
    "AUTODEV_KEYCHAIN_FILE"
  ];
  return Object.fromEntries(
    keys.flatMap((key) =>
      environment[key] === undefined ? [] : [[key, environment[key]]]
    )
  );
}

function privateFileStat(file: string) {
  try {
    return lstatSync(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export function privateWrite(file: string, content: string): void {
  const stat = privateFileStat(file);
  if (
    stat &&
    (!stat.isFile() ||
      stat.nlink !== 1 ||
      (process.getuid && stat.uid !== process.getuid()))
  )
    throw new Error("Refusing non-private service file: " + file);
  atomicWriteSync(file, content, { mode: 0o600, skipUnchanged: true });
  chmodSync(file, 0o600);
}

export function privateRead(file: string): string {
  const stat = privateFileStat(file);
  if (!stat) return "";
  if (
    !stat.isFile() ||
    stat.nlink !== 1 ||
    (stat.mode & 0o077) !== 0 ||
    (process.getuid && stat.uid !== process.getuid())
  )
    throw new Error("Service file must be a private regular file: " + file);
  return readFileSync(file, "utf8").trim();
}

/**
Create (or verify) a private, owned service directory.
*/
export function ensurePrivateDirectory(directory: string): void {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = lstatSync(directory);
  if (!stat.isDirectory() || (process.getuid && stat.uid !== process.getuid()))
    throw new Error(
      "Service directory must be an owned directory, not a symlink: " +
        directory
    );
  chmodSync(directory, 0o700);
}

export function generationPath(directory: string, generation: string): string {
  const target = path.join(directory, generation);
  const stat = lstatSync(target);
  if (
    !stat.isDirectory() ||
    (stat.mode & 0o077) !== 0 ||
    (process.getuid && stat.uid !== process.getuid())
  )
    throw new Error("Invalid private service generation directory");
  return target;
}

/**
Hold a service's install lock for the duration of `fn`.
*/
export async function withInstallLock<T>(
  directory: string,
  function_: () => Promise<T>
): Promise<T> {
  const lock = path.join(directory, "install.lock");
  try {
    mkdirSync(lock, { mode: 0o700 });
  } catch {
    throw new Error(
      `${directory} install is locked; check for another installer before removing install.lock`
    );
  }
  try {
    return await function_();
  } finally {
    rmSync(lock, { recursive: true, force: true });
  }
}

export function mcpGatewayDirectory(codexHome: string): string {
  return path.join(codexHome, MCP_GATEWAY_DIRECTORY);
}

/**
The gateway's bearer key and the matching `Authorization` header file that
clients (the tunnel, local providers) present.
*/
export function mcpGatewayAuthPaths(codexHome: string): {
  keyFile: string;
  headerFile: string;
} {
  const directory = mcpGatewayDirectory(codexHome);
  return {
    keyFile: path.join(directory, "supergateway.key"),
    headerFile: path.join(directory, "supergateway-auth.header")
  };
}

function ensureGatewayAuth(codexHome: string): {
  keyFile: string;
  headerFile: string;
} {
  const files = mcpGatewayAuthPaths(codexHome);
  const key = privateRead(files.keyFile);
  if (key && privateRead(files.headerFile) === `Bearer ${key}`) return files;
  const token = key || randomBytes(32).toString("hex");
  privateWrite(files.keyFile, token + "\n");
  privateWrite(files.headerFile, `Bearer ${token}\n`);
  return files;
}

function gatewayAuthValid(codexHome: string): boolean {
  const files = mcpGatewayAuthPaths(codexHome);
  const key = privateRead(files.keyFile);
  return Boolean(key) && privateRead(files.headerFile) === `Bearer ${key}`;
}

/**
Supergateway's bin shim from the Runtime dependency tree that `sourceRoot`
(a Runtime source tree) resolves through; the Runtime package manifest owns
its version. The installer passes the installed tree, `$CODEX_HOME/src`, so
the service runs the protected closure and never the editable checkout.
Never install or resolve a second dependency tree at service startup.
*/
export function resolveSupergateway(sourceRoot: string): string {
  const binDirectory = runtimeBinDirectory("supergateway", sourceRoot);
  const executable = binDirectory
    ? path.join(binDirectory, "supergateway")
    : null;
  if (!executable || !resolveCommandOnPath(executable))
    throw new Error(
      "Supergateway is not in the Runtime dependency tree; reinstall AutoDev"
    );
  return executable;
}

/**
The installed Runtime tree the gateway and its backends run from. The
installer itself runs from the editable checkout; nothing it renders for
the service may point back there.
*/
export function installedRuntimeSource(paths: ServicePaths): string {
  return path.join(paths.codexHome, RUNTIME_SOURCE_LINK);
}

/**
A service entry point in the resolved installed Runtime generation. The
LaunchAgent names the generation, not the `src` link, so installing a new
Runtime changes the job definition and reconciliation restarts the service
instead of leaving it running superseded code.
*/
export function installedServiceRunner(
  paths: ServicePaths,
  module: string
): string {
  return path.join(
    realpathSync(installedRuntimeSource(paths)),
    "platform",
    module
  );
}

/**
A loopback service port from its environment override or persisted value.
*/
export function servicePort(
  value: string | number | undefined,
  fallback: number,
  name: string
): number {
  const raw = value === undefined ? "" : String(value).trim();
  const port = raw ? Number(raw) : fallback;
  if (!Number.isInteger(port) || port < 1024 || port > 65_535)
    throw new Error(`${name} must be an integer from 1024 to 65535`);
  return port;
}

/**
The search path a service runs with: its own binaries first, then the
standard system locations.
*/
export function serviceSearchPath(
  home: string,
  binaries: readonly string[]
): string {
  return [
    ...binaries.map((binary) => path.dirname(binary)),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    path.join(home, ".local/bin"),
    "/usr/bin",
    "/bin",
    "/usr/sbin",
    "/sbin"
  ].join(":");
}

// ---------------------------------------------------------------------------
// Role surfaces and reviewed policy.
// ---------------------------------------------------------------------------

/**
Parse an operator's comma-separated role list.
*/
export function parsePublishedRoles(
  raw: string | undefined
): string[] | undefined {
  const roles = (raw ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  return roles.length > 0 ? roles : undefined;
}

/**
Resolve the roles the gateway publishes.

The primary role comes first: it owns the gateway's own delegation
coordinator. Every published role carries its own coordinator on its
surface, so the order only fixes which role the shared environment names.
*/
export function resolvePublishedRoles(
  primary: string,
  requested: string[] | undefined
): string[] {
  const roles: string[] = [];
  for (const candidate of [primary, ...(requested ?? [])]) {
    const role = resolveChatgptRole(candidate);
    if (!roles.includes(role)) roles.push(role);
  }
  return roles;
}

// The local gateway URL that serves one published role's surface.
export function mcpGatewayRoleSurfaceUrl(
  mcpPort: number,
  role: string
): string {
  return `http://127.0.0.1:${mcpPort}/${role}/mcp`;
}

function canonicalPolicyPath(paths: ServicePaths): string {
  return path.join(paths.repositoryRoot, CANONICAL_CHATGPT_POLICY_RELATIVE);
}

export function readCanonicalPolicyRaw(paths: ServicePaths): string {
  return readFileSync(canonicalPolicyPath(paths), "utf8");
}

export function readCanonicalContractRaw(paths: ServicePaths): string {
  try {
    return readFileSync(
      path.join(paths.repositoryRoot, CANONICAL_EXECUTION_CONTRACT_RELATIVE),
      "utf8"
    );
  } catch {
    return "";
  }
}

function staticRoleFallbackReviewed(
  paths: ServicePaths,
  role: string
): Record<string, string[]> {
  const parsed = parseRulesyncExternalMcpPermissions(
    readCanonicalPolicyRaw(paths)
  );
  const contract = roleContract(role);
  const roleTools = (contract.mcpTools ?? {}) as Record<string, string[]>;
  const entries: Array<[string, string[]]> = [];
  for (const server of contract.mcp) {
    const denied = parsed.deniedTools[server];
    const explicit = roleTools[server] ?? parsed.allowedTools[server];
    if (!explicit?.length) continue;
    const filtered = denied
      ? explicit.filter((tool) => !denied.has(tool))
      : explicit;
    if (filtered.length > 0) entries.push([server, filtered]);
  }
  return entries.length > 0
    ? chatgptGrantsSchema.parse(Object.fromEntries(entries))
    : {};
}

/**
The gateway's published surfaces as the Control API reports them: the
installed state when there is one, otherwise the primary role's static
reviewed policy.
*/
export function mcpGatewaySurfaceStatus(
  paths: ServicePaths,
  state: McpGatewayState | undefined
): {
  role: string;
  roles: string[];
  availableRoles: string[];
  workspace: string | null;
  reviewed: Record<string, string[]>;
  grants: Record<string, string[]>;
} {
  const role = resolveChatgptRole(state?.role);
  const reviewed = state?.reviewed ?? staticRoleFallbackReviewed(paths, role);
  return {
    role,
    roles: state?.roles ?? [role],
    availableRoles: declaredRoleNames(),
    workspace: state?.workspace ?? null,
    reviewed,
    grants: state?.grants ?? reviewed
  };
}

function remoteSecretAvailability(
  catalogue: Record<string, Record<string, unknown>>,
  hasSecret: (name: string, currentEnvironment: NodeJS.ProcessEnv) => boolean,
  environment: NodeJS.ProcessEnv
): Record<string, boolean> {
  const names = new Set<string>();
  for (const descriptor of Object.values(catalogue)) {
    if (descriptor.url === undefined) continue;
    for (const secretName of requiredRemoteSecretNames(descriptor)) {
      names.add(secretName);
    }
  }
  return Object.fromEntries(
    [...names].sort().map((name) => [name, hasSecret(name, environment)])
  );
}

function computePolicyDigest(
  role: string,
  rawContract: string,
  rawPolicy: string,
  catalogue: Record<string, Record<string, unknown>>,
  secretAvailability: Record<string, boolean>,
  commandCatalogue: string | null
): string {
  return createHash("sha256")
    .update(role)
    .update("\n")
    .update(rawContract)
    .update("\n")
    .update(rawPolicy)
    .update("\n")
    .update(JSON.stringify(catalogue))
    .update("\n")
    .update(JSON.stringify(secretAvailability))
    .update("\n")
    .update(commandCatalogue ?? "")
    .digest("hex");
}

type ServiceLaunchd = Pick<
  LaunchdClient,
  "isLoaded" | "bootout" | "disable" | "enable" | "bootstrap" | "print"
>;

export interface McpGatewayDependencies {
  platform: NodeJS.Platform;
  launchd(): ServiceLaunchd;
  node(home: string): string;
  supergateway(sourceRoot: string): string;
  backend: typeof externalMcpBackend;
  hasSecret?(name: string, environment: NodeJS.ProcessEnv): boolean;
  // The approved command catalogue digest installed in a Runtime home.
  commandCatalogue?(runtimeHome: string): string | null;
  discoverTools?(
    server: string,
    descriptor: Record<string, unknown>,
    paths: ServicePaths,
    workspace: string,
    node: string,
    gatewayEnvironment: Record<string, string>,
    environment: NodeJS.ProcessEnv
  ): Promise<string[]>;
  launchValues(paths: ServicePaths): LaunchAgentValues;
  // Whether a LaunchAgent's own process owns and serves `port`.
  ready(job: ServiceLaunchd, label: string, port: number): Promise<boolean>;
  portFree(port: number): boolean;
  wait: typeof waitForProbe;
  run(
    command: string,
    arguments_: string[],
    options: { env: NodeJS.ProcessEnv; cwd?: string; timeout: number }
  ): void;
}

async function discoverServerTools(
  server: string,
  descriptor: Record<string, unknown>,
  paths: ServicePaths,
  workspace: string,
  node: string,
  gatewayEnvironment: Record<string, string>,
  environment: NodeJS.ProcessEnv,
  backendResolver: typeof externalMcpBackend,
  role: string
): Promise<string[]> {
  const isReadOnly = roleContract(role).readOnly === true;
  const client = new Client({
    name: "autodev-mcp-gateway-policy-discovery",
    version: "1.0.0"
  });
  // `xacpx mcp-stdio` validates coordinator registration over its orchestration
  // Unix socket even during `tools/list`. For offline/install-time discovery,
  // bind a disposable in-process IPC server on a short temp socket so real
  // `@ganglion/xacpx` tool discovery succeeds without requiring or mutating a
  // running router daemon.
  let probeXacpxIpc: XacpxOrchestrationIpcHandle | undefined;
  let probeGatewayEnvironment = gatewayEnvironment;
  if (server === MCP_SERVER_XACPX && descriptor.url === undefined) {
    const probeSocket = path.join(
      "/tmp",
      `autodev-xacpx-probe-${randomBytes(8).toString("hex")}.sock`
    );
    probeXacpxIpc = await startXacpxOrchestrationIpcServer({
      socketPath: probeSocket,
      manager: new XacpxSessionManager(),
      authorizedWorkspaceRoot: workspace,
      repositoryRoot: paths.repositoryRoot
    });
    probeGatewayEnvironment = {
      ...gatewayEnvironment,
      XACPX_ORCHESTRATION_SOCKET: probeSocket,
      AUTODEV_XACPX_COORDINATOR_SESSION: "gateway:policy-probe"
    };
  }
  const transport =
    descriptor.url === undefined
      ? (() => {
          const backend = backendResolver(
            server,
            paths.repositoryRoot,
            workspace,
            node,
            paths.home,
            paths.codexHome,
            {
              role,
              readOnly: isReadOnly,
              runtimeSource: installedRuntimeSource(paths)
            }
          );
          return new StdioClientTransport({
            command: backend.command,
            args: backend.args,
            cwd: workspace,
            env:
              server === MCP_SERVER_FILESYSTEM
                ? {
                    HOME: workspace,
                    PATH: "/usr/bin:/bin",
                    LANG: "en_US.UTF-8"
                  }
                : probeGatewayEnvironment,
            stderr: "pipe"
          });
        })()
      : new StreamableHTTPClientTransport(new URL(String(descriptor.url)), {
          requestInit: {
            headers: resolveRemoteMcpHeaders(
              {
                url: String(descriptor.url),
                ...(typeof descriptor.bearer_token_env_var === "string"
                  ? { bearer_token_env_var: descriptor.bearer_token_env_var }
                  : {}),
                ...(descriptor.http_headers &&
                typeof descriptor.http_headers === "object" &&
                !Array.isArray(descriptor.http_headers)
                  ? {
                      http_headers: descriptor.http_headers as Record<
                        string,
                        string
                      >
                    }
                  : {})
              },
              server,
              environment
            )
          }
        });
  try {
    await client.connect(transport, { timeout: 20_000 });
    const discovered: string[] = [];
    let cursor: string | undefined;
    const seenCursors = new Set<string>();
    do {
      const page = await client.listTools(cursor ? { cursor } : {}, {
        timeout: 20_000
      });
      for (const tool of page.tools) {
        if (
          !isReadOnly ||
          server === MCP_SERVER_FILESYSTEM ||
          tool.annotations?.readOnlyHint === true
        ) {
          discovered.push(tool.name);
        }
      }
      cursor = page.nextCursor;
      if (cursor && seenCursors.has(cursor)) break;
      if (cursor) seenCursors.add(cursor);
    } while (cursor);
    return [...new Set(discovered)];
  } finally {
    await Promise.allSettled([
      client.close(),
      transport.close(),
      ...(probeXacpxIpc ? [probeXacpxIpc.close()] : [])
    ]);
  }
}

async function resolveReviewedFromRoleContract(
  paths: ServicePaths,
  catalogue: Record<string, Record<string, unknown>>,
  role: string,
  workspace: string,
  node: string,
  gatewayEnvironment: Record<string, string>,
  environment: NodeJS.ProcessEnv,
  dependencies: McpGatewayDependencies,
  prior?: McpGatewayState
): Promise<{
  policyFile: string;
  policyDigest: string;
  reviewed: Record<string, string[]>;
}> {
  const hasSecret =
    dependencies.hasSecret ??
    ((name: string, currentEnvironment: NodeJS.ProcessEnv) =>
      Boolean(
        resolveManagedSecret(name, currentEnvironment) ??
        readRuntimeSecret(name, currentEnvironment)
      ));
  // The Commands backend serves only the operator-approved catalogue of the
  // Runtime home it runs from, and refuses to start without one. Its revision
  // is part of the reviewed policy, so approving one re-reviews the grants.
  const commandCatalogue = (
    dependencies.commandCatalogue ?? installedCommandCatalogueDigest
  )(paths.codexHome);
  const policyFile = canonicalPolicyPath(paths);
  const rawPolicy = readCanonicalPolicyRaw(paths);
  const policyDigest = computePolicyDigest(
    role,
    readCanonicalContractRaw(paths),
    rawPolicy,
    catalogue,
    remoteSecretAvailability(catalogue, hasSecret, environment),
    commandCatalogue
  );
  if (
    prior?.policyFile === policyFile &&
    prior.policyDigest === policyDigest &&
    prior.role === role
  ) {
    return { policyFile, policyDigest, reviewed: prior.reviewed };
  }

  const contract = roleContract(role);
  const roleAllowedServers = new Set(contract.mcp);
  const roleMcpTools = (contract.mcpTools ?? {}) as Record<string, string[]>;
  const permissions = parseRulesyncExternalMcpPermissions(rawPolicy);
  const discover =
    dependencies.discoverTools ??
    ((
      server: string,
      descriptor: Record<string, unknown>,
      currentPaths: ServicePaths,
      currentWorkspace: string,
      currentNode: string,
      currentGatewayEnvironment: Record<string, string>,
      currentEnvironment: NodeJS.ProcessEnv
    ) =>
      discoverServerTools(
        server,
        descriptor,
        currentPaths,
        currentWorkspace,
        currentNode,
        currentGatewayEnvironment,
        currentEnvironment,
        dependencies.backend,
        role
      ));

  const candidates = Object.entries(catalogue).filter(
    ([server, descriptor]) => {
      if (!roleAllowedServers.has(server) || descriptor.env !== undefined)
        return false;
      if (descriptor.url !== undefined) {
        if (
          descriptor.command !== undefined ||
          !isApprovedRemoteUrl(descriptor.url)
        )
          return false;
        if (
          descriptor.http_headers !== undefined &&
          !isApprovedHeaderTemplates(descriptor.http_headers)
        )
          return false;
        return requiredRemoteSecretNames(descriptor).every((secretName) =>
          hasSecret(secretName, environment)
        );
      }
      if (server === MCP_SERVER_COMMANDS && commandCatalogue === null)
        return false;
      return (
        typeof descriptor.command === "string" &&
        Boolean(descriptor.command.trim()) &&
        hasExternalMcpProfile(server)
      );
    }
  );
  if (
    commandCatalogue === null &&
    roleAllowedServers.has(MCP_SERVER_COMMANDS) &&
    catalogue[MCP_SERVER_COMMANDS] !== undefined
  )
    writeErrorLine(
      `MCP gateway (${role}): Commands MCP unavailable -- no approved command catalogue in ${approvedCommandCataloguePath(paths.codexHome)}.`
    );

  const resolvedEntries = await Promise.all(
    candidates.map(async ([server, descriptor]) => {
      const denied = permissions.deniedTools[server];
      const explicit = roleMcpTools[server]?.length
        ? roleMcpTools[server]
        : permissions.allowedTools[server];
      const tools = explicit?.length
        ? explicit
        : await discover(
            server,
            descriptor,
            paths,
            workspace,
            node,
            gatewayEnvironment,
            environment
          );
      const filtered = denied
        ? tools.filter((tool) => !denied.has(tool))
        : tools;
      return filtered.length > 0 ? ([server, filtered] as const) : null;
    })
  );

  return {
    policyFile,
    policyDigest,
    reviewed: chatgptGrantsSchema.parse(
      Object.fromEntries(
        resolvedEntries.filter(
          (entry): entry is readonly [string, string[]] => entry !== null
        )
      )
    )
  };
}

// ---------------------------------------------------------------------------
// Service state, readiness and lifecycle.
// ---------------------------------------------------------------------------

function gatewayStateFile(codexHome: string): string {
  return path.join(mcpGatewayDirectory(codexHome), "gateway.json");
}

/**
Read the installed gateway state.

The state file is a projection of the current installation, not an
authority. A file whose shape no longer matches is treated as absent so the
next install re-projects it, while unreadable JSON still fails loudly.
*/
export function readMcpGatewayState(
  codexHome: string
): McpGatewayState | undefined {
  const text = privateRead(gatewayStateFile(codexHome));
  if (!text) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("MCP gateway state file is not valid JSON");
  }
  const result = gatewayStateSchema.safeParse(parsed);
  return result.success ? result.data : undefined;
}

/**
The raw installed gateway state, for revision digests.
*/
export function readMcpGatewayStateRaw(codexHome: string): string {
  return privateRead(gatewayStateFile(codexHome));
}

/**
Whether the LaunchAgent `label` owns the single listener on each port (or
its direct child does) and each port answers `/readyz`.
*/
export async function serviceReady(
  launchd: Pick<LaunchdClient, "print">,
  label: string,
  ports: readonly number[],
  dependencies: {
    listeners: (value: number) => string[];
    probe: (value: number) => Promise<boolean>;
    parentPid?: (pid: string) => string | null;
  } = {
    listeners: (value: number) =>
      execFileSync(
        "/usr/sbin/lsof",
        ["-nP", "-tiTCP:" + value, "-sTCP:LISTEN"],
        { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 3000 }
      )
        .trim()
        .split(/\s+/u),
    probe: (value: number) =>
      httpHealthProbe(`http://127.0.0.1:${value}/readyz`)(),
    parentPid: (pid: string) =>
      execFileSync("/bin/ps", ["-o", "ppid=", "-p", pid], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 3000
      }).trim() || null
  }
): Promise<boolean> {
  try {
    const pid = /^\s*pid = (\d+)$/mu.exec(launchd.print(label))?.[1];
    if (!pid) return false;
    for (const port of ports) {
      const listeners = dependencies.listeners(port);
      if (listeners.length !== 1 || !listeners[0]) return false;
      const isOwned =
        listeners[0] === pid || dependencies.parentPid?.(listeners[0]) === pid;
      if (!isOwned || !(await dependencies.probe(port))) return false;
    }
    return true;
  } catch {
    return false;
  }
}

export function portFree(port: number): boolean {
  const result = spawnSync(
    "/usr/sbin/lsof",
    ["-nP", "-tiTCP:" + port, "-sTCP:LISTEN"],
    { encoding: "utf8" }
  );
  return result.status === 1 && !result.stderr?.trim();
}

/*
The failing command's own report.

`tunnel-client doctor` and the gateway probe write their check reports to
stdout, so an installer that discards the subprocess output leaves the
operator with a stage name and nothing else to act on.
*/
export function commandFailureReport(
  command: string,
  argv: string[],
  error: unknown
): string {
  const failure = error as {
    stdout?: unknown;
    stderr?: unknown;
    status?: number;
  };
  const report = [failure.stdout, failure.stderr]
    .map(commandOutput)
    .filter(Boolean)
    .join("\n");
  return [
    `Command failed (exit ${failure.status ?? "unknown"}): ${command} ${argv.join(" ")}`,
    report
  ]
    .filter(Boolean)
    .join("\n");
}

function commandOutput(stream: unknown): string {
  if (typeof stream === "string") return stream.trim();
  if (stream instanceof Uint8Array)
    return Buffer.from(stream).toString("utf8").trim();
  return "";
}

/*
The reason a stage failed, as short as the operator can act on.
*/
export function failureDetail(error: unknown): string {
  const message =
    error instanceof Error ? error.message : String(error ?? "unknown error");
  const trimmed = message.trim();
  return trimmed.length > 4000
    ? `${trimmed.slice(0, 4000)}...`
    : trimmed || "unknown error";
}

export function runCommand(
  command: string,
  arguments_: string[],
  options: { env: NodeJS.ProcessEnv; cwd?: string; timeout: number }
): void {
  try {
    execFileSync(command, arguments_, {
      ...options,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"]
    });
  } catch (error) {
    throw new Error(commandFailureReport(command, arguments_, error), {
      cause: error
    });
  }
}

export function defaultMcpGatewayDependencies(): McpGatewayDependencies {
  return {
    platform: process.platform,
    launchd: () => new LaunchdClient(),
    node: resolveServiceNode,
    supergateway: resolveSupergateway,
    backend: externalMcpBackend,
    launchValues: resolveLaunchAgentValues,
    ready: (job, label, port) => serviceReady(job, label, [port]),
    portFree,
    wait: waitForProbe,
    run: runCommand
  };
}

/**
The LaunchAgent template a service label renders from.
*/
export function serviceTemplatePath(
  paths: ServicePaths,
  label: string
): string {
  return path.join(
    paths.repositoryRoot,
    "config",
    "launchagents",
    label + ".plist"
  );
}

export function serviceLaunchAgentPath(
  paths: ServicePaths,
  label: string
): string {
  return path.join(paths.home, "Library", "LaunchAgents", label + ".plist");
}

function gatewayLaunchValues(
  paths: ServicePaths,
  state: McpGatewayState,
  values: LaunchAgentValues
): LaunchAgentValues {
  return {
    ...values,
    service: {
      node: state.node,
      runner: installedServiceRunner(paths, "mcp-gateway-service.ts"),
      repositoryRoot: paths.repositoryRoot,
      codexHome: paths.codexHome,
      workingDirectory: state.workspace,
      servicePath: state.servicePath,
      logDirectory: mcpGatewayDirectory(paths.codexHome)
    }
  };
}

interface RenderedGateway {
  supergateway: string;
  pool: string;
}

function renderGateway(
  paths: ServicePaths,
  catalogue: Record<string, Record<string, unknown>>,
  surfaces: ChatgptRoleSurface[],
  workspace: string,
  node: string,
  mcpPort: number,
  dependencies: McpGatewayDependencies
): RenderedGateway {
  const backendFor = (server: string, backendRole: string) =>
    dependencies.backend(
      server,
      paths.repositoryRoot,
      workspace,
      node,
      paths.home,
      paths.codexHome,
      {
        role: backendRole,
        readOnly: roleContract(backendRole).readOnly === true,
        runtimeSource: installedRuntimeSource(paths)
      }
    );
  return {
    pool: renderChatgptBackendPoolConfig(
      catalogue,
      surfaces,
      workspace,
      backendFor
    ),
    supergateway: renderChatgptSupergatewayConfig(
      catalogue,
      surfaces,
      workspace,
      {
        port: mcpPort,
        apiKeyFile: mcpGatewayAuthPaths(paths.codexHome).keyFile,
        sessionTimeout: DEFAULT_CHATGPT_SESSION_TIMEOUT_MS
      },
      backendFor
    )
  };
}

/**
Whether the installed gateway service matches its state and serves.
*/
export async function checkMcpGateway(
  paths: ServicePaths,
  dependencies = defaultMcpGatewayDependencies()
): Promise<boolean> {
  try {
    const state = readMcpGatewayState(paths.codexHome);
    if (!state) return false;
    const directory = mcpGatewayDirectory(paths.codexHome);
    const generation = generationPath(directory, state.generation);
    const supergatewayRaw = privateRead(
      path.join(generation, "supergateway.json")
    );
    const poolRaw = privateRead(path.join(generation, "backend-pool.json"));
    if (!supergatewayRaw || !poolRaw || !gatewayAuthValid(paths.codexHome))
      return false;
    chatgptBackendPoolConfigSchema.parse(JSON.parse(poolRaw));
    const config = supergatewayConfigSchema.parse(JSON.parse(supergatewayRaw));
    const { keyFile } = mcpGatewayAuthPaths(paths.codexHome);
    const surfaces = Object.entries(config.mcpServers);
    if (
      surfaces.length === 0 ||
      config.host !== "127.0.0.1" ||
      config.port !== state.mcpPort ||
      surfaces.some(
        ([role, surface]) =>
          !state.roles.includes(role) ||
          surface.sessionTimeout !== DEFAULT_CHATGPT_SESSION_TIMEOUT_MS ||
          surface.apiKeyFile.replaceAll("$$", "$") !== keyFile
      )
    )
      return false;
    return (
      launchAgentMatches(
        serviceTemplatePath(paths, MCP_GATEWAY_LABEL),
        serviceLaunchAgentPath(paths, MCP_GATEWAY_LABEL),
        gatewayLaunchValues(paths, state, dependencies.launchValues(paths))
      ) &&
      (await dependencies.ready(
        dependencies.launchd(),
        MCP_GATEWAY_LABEL,
        state.mcpPort
      ))
    );
  } catch {
    return false;
  }
}

/**
Reconcile the gateway service: render the reviewed surfaces, verify the
candidate, and (re)start the LaunchAgent only when something changed. A
failed candidate leaves the previous service running.
*/
export async function ensureMcpGateway(
  paths: ServicePaths,
  environment: NodeJS.ProcessEnv = process.env,
  config?: McpGatewayConfiguration,
  dependencies = defaultMcpGatewayDependencies()
): Promise<McpGatewayState> {
  if (dependencies.platform !== "darwin")
    throw new Error("The AutoDev MCP gateway service currently requires macOS");
  const directory = mcpGatewayDirectory(paths.codexHome);
  ensurePrivateDirectory(directory);
  return withInstallLock(directory, () =>
    reconcileGateway(paths, directory, environment, config, dependencies)
  );
}

async function reconcileGateway(
  paths: ServicePaths,
  directory: string,
  environment: NodeJS.ProcessEnv,
  config_: McpGatewayConfiguration | undefined,
  dependencies: McpGatewayDependencies
): Promise<McpGatewayState> {
  const prior = readMcpGatewayState(paths.codexHome);
  const launchd = dependencies.launchd();
  const workspace = validateChatgptWorkspace(
    config_?.workspace ??
      (environment[MCP_GATEWAY_WORKSPACE_ENV]?.trim() ||
        prior?.workspace ||
        paths.repositoryRoot),
    paths.home,
    paths.codexHome
  );
  const primaryRole = resolveChatgptRole(
    config_?.role ??
      (environment[MCP_GATEWAY_ROLE_ENV]?.trim() ||
        prior?.role ||
        DEFAULT_CHATGPT_ROLE)
  );
  const roles = resolvePublishedRoles(
    primaryRole,
    config_?.roles ??
      parsePublishedRoles(environment[MCP_GATEWAY_ROLES_ENV]?.trim()) ??
      prior?.roles.filter((published) => published !== prior.role)
  );
  const role = roles[0]!;
  const node = dependencies.node(paths.home);
  const catalogue = readBridgeMcpCatalogue(paths.codexHome);
  const supergateway = dependencies.supergateway(installedRuntimeSource(paths));
  const mcpPort = servicePort(
    environment[MCP_GATEWAY_PORT_ENV]?.trim() || prior?.mcpPort,
    DEFAULT_CHATGPT_MCP_PORT,
    MCP_GATEWAY_PORT_ENV
  );
  const servicePath = serviceSearchPath(paths.home, [node, supergateway]);
  const gatewayEnvironment = chatgptSupergatewayEnvironment(
    paths,
    workspace,
    node,
    servicePath,
    { role }
  );
  const policyOverride = environment[MCP_GATEWAY_POLICY_FILE_ENV]?.trim();
  const canonical = await resolveReviewedFromRoleContract(
    paths,
    catalogue,
    role,
    workspace,
    node,
    gatewayEnvironment,
    environment,
    dependencies,
    prior
  );
  const policyFile = policyOverride
    ? path.resolve(policyOverride)
    : canonical.policyFile;
  const policyDigest = policyOverride
    ? createHash("sha256")
        .update(readFileSync(policyFile, "utf8"))
        .update("\n")
        .update(canonical.policyDigest)
        .digest("hex")
    : canonical.policyDigest;
  const reviewed = canonical.reviewed;
  const grants = chatgptGrantsSchema.parse(
    config_
      ? Object.keys(config_.grants).length === 0
        ? reviewed
        : config_.grants
      : policyOverride
        ? JSON.parse(readFileSync(policyFile, "utf8"))
        : prior &&
            prior.role === role &&
            prior.policyFile === policyFile &&
            prior.policyDigest === policyDigest
          ? prior.grants
          : reviewed
  );
  const surfaces: ChatgptRoleSurface[] = [];
  for (const publishedRole of roles) {
    if (publishedRole === role) {
      surfaces.push({ role, grants, reviewed });
      continue;
    }
    const resolved = await resolveReviewedFromRoleContract(
      paths,
      catalogue,
      publishedRole,
      workspace,
      node,
      gatewayEnvironment,
      environment,
      dependencies
    );
    surfaces.push({
      role: publishedRole,
      grants: resolved.reviewed,
      reviewed: resolved.reviewed
    });
  }
  ensureGatewayAuth(paths.codexHome);
  const rendered = renderGateway(
    paths,
    catalogue,
    surfaces,
    workspace,
    node,
    mcpPort,
    dependencies
  );
  const nextState = (generation: string): McpGatewayState =>
    gatewayStateSchema.parse({
      version: 1,
      workspace,
      role,
      roles,
      policyFile,
      policyDigest,
      reviewed,
      grants,
      generation,
      mcpPort,
      node,
      supergateway,
      servicePath
    });

  if (prior) {
    const isUnchanged =
      JSON.stringify(nextState(prior.generation)) === JSON.stringify(prior);
    let active: string | undefined;
    try {
      active = generationPath(directory, prior.generation);
    } catch {
      active = undefined;
    }
    if (
      isUnchanged &&
      active &&
      privateRead(path.join(active, "supergateway.json")) ===
        rendered.supergateway.trim() &&
      privateRead(path.join(active, "backend-pool.json")) ===
        rendered.pool.trim() &&
      (await checkMcpGateway(paths, dependencies))
    ) {
      writeLine(
        `AutoDev MCP gateway already ready: ${mcpGatewayRoleSurfaceUrl(mcpPort, role)}`
      );
      return prior;
    }
  }

  const generation = mkdtempSync(path.join(directory, "generation-"));
  chmodSync(generation, 0o700);
  const config = path.join(generation, "supergateway.json");
  const stagedFile = path.join(directory, "staged.json");
  const plistFile = serviceLaunchAgentPath(paths, MCP_GATEWAY_LABEL);
  const stateFile = gatewayStateFile(paths.codexHome);
  const previousPlist = existsSync(plistFile)
    ? readFileSync(plistFile, "utf8")
    : "";
  const wasRunning = launchd.isLoaded(MCP_GATEWAY_LABEL);
  const state = nextState(path.basename(generation));
  let isStopped = false;
  let isCommitted = false;
  let isRollbackFailed = false;
  let stage = "staging";
  try {
    privateWrite(path.join(generation, "backend-pool.json"), rendered.pool);
    privateWrite(config, rendered.supergateway);
    stage = "supergateway config check";
    dependencies.run(supergateway, ["--config", config, "--checkConfig"], {
      cwd: workspace,
      env: {
        ...gatewayEnvironment,
        [CHATGPT_MCP_POOL_PORT_ENV]: "1",
        [CHATGPT_MCP_POOL_TOKEN_ENV]: "check-config"
      },
      timeout: 30_000
    });
    stage = "supergateway MCP probe";
    dependencies.run(
      node,
      [
        path.join(paths.codexHome, "src/mcp/chatgpt-supergateway-probe.ts"),
        supergateway,
        config
      ],
      { cwd: workspace, env: gatewayEnvironment, timeout: 60_000 }
    );
    const candidatePlist = path.join(generation, MCP_GATEWAY_LABEL + ".plist");
    renderLaunchAgent(
      serviceTemplatePath(paths, MCP_GATEWAY_LABEL),
      candidatePlist,
      gatewayLaunchValues(paths, state, dependencies.launchValues(paths))
    );

    stage = "launchd stop";
    launchd.bootout(MCP_GATEWAY_LABEL);
    isStopped = true;
    stage = "gateway port check";
    if (!dependencies.portFree(mcpPort))
      throw new Error(
        `MCP gateway port ${mcpPort} is already in use or could not be checked`
      );
    stage = "launchd start";
    privateWrite(stagedFile, JSON.stringify(state, null, 2) + "\n");
    privateWrite(plistFile, readFileSync(candidatePlist, "utf8"));
    launchd.enable(MCP_GATEWAY_LABEL);
    launchd.bootstrap(plistFile);
    stage = "gateway readiness";
    if (
      !(await dependencies.wait(
        {
          probe: () => dependencies.ready(launchd, MCP_GATEWAY_LABEL, mcpPort),
          sleep
        },
        60_000
      ))
    )
      throw new Error("MCP gateway did not become ready");
    privateWrite(stateFile, JSON.stringify(state, null, 2) + "\n");
    isCommitted = true;
    writeLine(
      `AutoDev MCP gateway ready: ${roles.map((published) => mcpGatewayRoleSurfaceUrl(mcpPort, published)).join(", ")}`
    );
  } catch (error) {
    if (isStopped) {
      try {
        launchd.bootout(MCP_GATEWAY_LABEL);
        if (previousPlist) {
          privateWrite(plistFile, previousPlist);
          if (wasRunning) {
            launchd.enable(MCP_GATEWAY_LABEL);
            launchd.bootstrap(plistFile);
          } else launchd.disable(MCP_GATEWAY_LABEL);
        } else {
          rmSync(plistFile, { force: true });
          launchd.disable(MCP_GATEWAY_LABEL);
        }
      } catch {
        isRollbackFailed = true;
        throw new Error(
          `MCP gateway setup (${stage}) and rollback failed; candidate generation retained for recovery`
        );
      }
    }
    throw new Error(
      `MCP gateway setup failed (${stage}): ${failureDetail(error)}; previous service configuration retained. Check ${path.join(directory, "stderr.log")}`,
      { cause: error }
    );
  } finally {
    rmSync(stagedFile, { force: true });
    if (!isCommitted && !isRollbackFailed)
      rmSync(generation, { recursive: true, force: true });
  }
  // A previous generation is not needed after the new one is ready.
  if (prior?.generation && prior.generation !== state.generation)
    rmSync(path.join(directory, prior.generation), {
      recursive: true,
      force: true
    });
  return state;
}

/**
Run the gateway: the backend pool in-process and Supergateway as a child,
until Supergateway exits or launchd stops the service.
*/
export async function runMcpGatewayDaemon(
  paths: ServicePaths,
  environment: NodeJS.ProcessEnv = process.env,
  dependencies: { spawnProcess?: typeof spawn } = {}
): Promise<number> {
  const directory = mcpGatewayDirectory(paths.codexHome);
  const stagedRaw = privateRead(path.join(directory, "staged.json"));
  const state = stagedRaw
    ? gatewayStateSchema.parse(JSON.parse(stagedRaw))
    : readMcpGatewayState(paths.codexHome);
  if (!state) {
    process.stderr.write("AutoDev MCP gateway is not configured\n");
    return 1;
  }
  const generation = generationPath(directory, state.generation);
  const config = path.join(generation, "supergateway.json");
  const poolRaw = privateRead(path.join(generation, "backend-pool.json"));
  if (!existsSync(config) || !poolRaw || !gatewayAuthValid(paths.codexHome)) {
    process.stderr.write(
      "AutoDev MCP gateway configuration or local auth files are missing\n"
    );
    return 1;
  }
  const gatewayEnvironment = chatgptSupergatewayEnvironment(
    paths,
    state.workspace,
    state.node,
    state.servicePath,
    { role: state.role }
  );
  const backendPool: ChatgptBackendPoolHandle = await startChatgptBackendPool(
    chatgptBackendPoolConfigSchema.parse(JSON.parse(poolRaw)),
    { gatewayEnv: gatewayEnvironment, secretEnv: environment }
  );
  const gateway = (dependencies.spawnProcess ?? spawn)(
    state.supergateway,
    ["--config", config, "--exitWithProcess", String(process.pid)],
    {
      cwd: state.workspace,
      env: {
        ...gatewayEnvironment,
        [CHATGPT_MCP_POOL_PORT_ENV]: String(backendPool.port),
        [CHATGPT_MCP_POOL_TOKEN_ENV]: backendPool.token
      },
      stdio: ["pipe", "inherit", "inherit"]
    }
  );
  return superviseChild(gateway, "Supergateway", () => backendPool.close());
}

/**
Forward launchd's stop signals to a service's child and resolve with its
exit code, then release `cleanup`.
*/
export async function superviseChild(
  child: ChildProcess,
  name: string,
  cleanup: () => Promise<void> = async () => {}
): Promise<number> {
  let isStopping = false;
  const forward = (signal: NodeJS.Signals) => (): void => {
    isStopping = true;
    if (child.exitCode === null && child.signalCode === null)
      child.kill(signal);
  };
  const onSigterm = forward("SIGTERM");
  const onSigint = forward("SIGINT");
  process.once("SIGTERM", onSigterm);
  process.once("SIGINT", onSigint);
  try {
    return await new Promise<number>((resolve) => {
      child.once("error", () => {
        process.stderr.write(`${name} failed to start\n`);
        resolve(1);
      });
      child.once("exit", (code) => {
        if (isStopping) return resolve(0);
        process.stderr.write(`${name} exited unexpectedly\n`);
        resolve(code || 1);
      });
    });
  } finally {
    process.removeListener("SIGTERM", onSigterm);
    process.removeListener("SIGINT", onSigint);
    await cleanup().catch(() => {});
  }
}

/**
Wait until the gateway answers `/readyz`.
*/
export function waitForMcpGateway(
  mcpPort: number,
  timeoutMs = 30_000
): Promise<boolean> {
  const probe = httpHealthProbe(`http://127.0.0.1:${mcpPort}/readyz`);
  return waitForProbe({ sleep, probe }, timeoutMs);
}

if (isEntryPoint(import.meta.url)) {
  const [mode, repositoryRoot, home, codexHome] = process.argv.slice(2);
  if (!repositoryRoot || !home || !codexHome)
    throw new Error("Expected gateway mode and install paths");
  const paths = { repositoryRoot, home, codexHome };
  if (mode === "run") {
    process.exitCode = await runMcpGatewayDaemon(paths);
  } else if (mode === "check") {
    process.exitCode = (await checkMcpGateway(paths)) ? 0 : 1;
  } else if (mode === "reconcile") {
    try {
      await ensureMcpGateway(paths);
    } catch (error) {
      // Only locally constructed errors are printed; subprocess failures may
      // carry sensitive output.
      const isSafe =
        error instanceof Error &&
        !("stdout" in error) &&
        !("stderr" in error) &&
        !(error instanceof z.ZodError);
      process.stderr.write(
        (isSafe
          ? error.message
          : "MCP gateway setup failed; inspect local configuration") + "\n"
      );
      process.exitCode = 1;
    }
  } else throw new Error("Invalid MCP gateway mode");
}
