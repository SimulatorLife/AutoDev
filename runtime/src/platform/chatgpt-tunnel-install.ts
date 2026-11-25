import {
  type ChildProcess,
  execFileSync,
  spawn,
  spawnSync
} from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { once } from "node:events";
import type { ChatgptTunnelStatus } from "@simulatorlife/autodev-core";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync
} from "node:fs";
import { createServer } from "node:net";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { atomicWriteSync } from "@simulatorlife/autodev-data/files";
import { z } from "zod";
import { isEntryPoint } from "../shared/entry-point.ts";
import {
  deleteKeychainSecret,
  readKeychainSecret,
  readRuntimeSecret,
  resolveManagedSecret,
  secureDeleteFile,
  writeKeychainSecret
} from "../shared/runtime-secrets.ts";
import {
  declaredRoleNames,
  roleContract
} from "../shared/execution-contract.ts";
import {
  MCP_SERVER_FILESYSTEM,
  MCP_SERVER_XACPX
} from "../shared/tool-names.ts";
import { XacpxSessionManager } from "../xacpx/manager.ts";
import {
  startXacpxOrchestrationIpcServer,
  type XacpxOrchestrationIpcHandle
} from "../xacpx/orchestration-ipc.ts";
import { httpHealthProbe } from "./health-probe.ts";
import { waitForProbe } from "./wait-for-probe.ts";
import { sleep } from "./sleep.ts";
import {
  launchAgentMatches,
  renderLaunchAgent,
  resolveLaunchAgentValues,
  type LaunchAgentValues
} from "./macos/launchagent.ts";
import { parseCliVersion } from "../providers/cli-versions.ts";
import { writeLine } from "@simulatorlife/autodev-runtime/shared/output";

import { readBridgeMcpCatalogue } from "../mcp/filesystem-server.ts";
import {
  externalMcpBackend,
  hasExternalMcpProfile
} from "../mcp/chatgpt-filesystem-sandbox.ts";
import {
  CHATGPT_MCP_POOL_PORT_ENV,
  CHATGPT_MCP_POOL_TOKEN_ENV,
  chatgptBackendPoolConfigSchema,
  type ChatgptBackendPoolHandle,
  startChatgptBackendPool
} from "../mcp/chatgpt-backend-pool.ts";
import { resolveRemoteMcpHeaders } from "../mcp/tool-filter.ts";
import {
  type ChatgptRoleSurface,
  CANONICAL_CHATGPT_POLICY_RELATIVE,
  CANONICAL_EXECUTION_CONTRACT_RELATIVE,
  chatgptGrantsSchema,
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

import { resolveServiceNode } from "./host-arch.ts";
import { homebrewInvocation } from "./dependencies.ts";
import { LaunchdClient } from "./macos/launchd.ts";
import { resolveCommandOnPath } from "./runtime-files.ts";

const label = "com.codex.autodev-chatgpt-tunnel";
const defaultPort = 3311;
const defaultMcpPort = DEFAULT_CHATGPT_MCP_PORT;
export const CHATGPT_TUNNEL_API_KEY_ENV = "AUTODEV_CHATGPT_TUNNEL_API_KEY";
export const CHATGPT_MCP_PORT_ENV = "AUTODEV_CHATGPT_MCP_PORT";
export const CHATGPT_AGENT_ROLE_ENV = "AUTODEV_CHATGPT_AGENT_ROLE";
// Comma-separated roles this tunnel publishes a surface for.
export const CHATGPT_MCP_ROLES_ENV = "AUTODEV_CHATGPT_MCP_ROLES";
const CHATGPT_TUNNEL_API_KEY_REF = `env:${CHATGPT_TUNNEL_API_KEY_ENV}`;
export type ChatgptTunnelMode = "reconcile" | "enable" | "disable";
const installedStateSchema = z
  .object({
    workspace: z.string().refine(path.isAbsolute),
    // The primary role: it owns the gateway's delegation coordinator.
    role: z.string().min(1).optional(),
    // Every role this tunnel publishes a surface for, primary role first.
    roles: z.array(z.string().min(1)).min(1).optional(),
    policyFile: z.string().refine(path.isAbsolute),
    policyDigest: z
      .string()
      .regex(/^[a-f0-9]{64}$/u)
      .optional(),
    reviewed: chatgptGrantsSchema.optional(),
    grants: chatgptGrantsSchema,
    generation: z.string().regex(/^generation-[a-zA-Z0-9_-]+$/u),
    port: z.number().int().min(1024).max(65535),
    mcpPort: z.number().int().min(1024).max(65535).optional(),
    organizationId: z.string().min(1),
    workspaceId: z.string().min(1),
    tunnelId: z.string().regex(/^tunnel_[a-zA-Z0-9_-]+$/u),
    binary: z.string().refine(path.isAbsolute),
    servicePath: z.string().min(1),
    node: z.string().refine(path.isAbsolute),
    supergateway: z.string().refine(path.isAbsolute)
  })
  .strict();
const stateSchema = z.discriminatedUnion("enabled", [
  installedStateSchema.extend({
    version: z.literal(1),
    enabled: z.literal(true)
  }),
  z
    .object({
      version: z.literal(1),
      enabled: z.literal(false),
      prior: installedStateSchema.optional()
    })
    .strict()
]);
type TunnelState = z.infer<typeof stateSchema>;
const revision = z.string().regex(/^[a-f0-9]{64}$/u);
export const tunnelMutationSchema = z.discriminatedUnion("action", [
  z
    .object({ action: z.literal("disable"), expectedRevision: revision })
    .strict(),
  z
    .object({ action: z.literal("enable"), expectedRevision: revision })
    .strict(),
  z
    .object({ action: z.literal("forget"), expectedRevision: revision })
    .strict(),
  z
    .object({
      action: z.literal("configure"),
      expectedRevision: revision,
      workspace: z.string().min(1),
      // The primary role; it owns the gateway's delegation coordinator.
      role: z.string().min(1).optional(),
      // The additional roles this tunnel publishes a surface for.
      roles: z.array(z.string().min(1)).min(1).optional(),
      // Explicit grants for the primary role.
      grants: chatgptGrantsSchema
    })
    .strict(),
  z
    .object({
      action: z.literal("rotate"),
      expectedRevision: revision,
      runtimeKey: z.string().min(1).max(4096)
    })
    .strict()
]);
type TunnelMutation = z.infer<typeof tunnelMutationSchema>;
type InstalledState = z.infer<typeof installedStateSchema>;
function installedState(
  state: TunnelState | undefined
): InstalledState | undefined {
  if (!state) return undefined;
  if (!state.enabled) return state.prior;
  const { enabled: _enabled, version: _version, ...installed } = state;
  return installed;
}
function generationPath(directory: string, generation: string): string {
  const target = path.join(directory, generation);
  const stat = lstatSync(target);
  if (
    !stat.isDirectory() ||
    (stat.mode & 0o077) !== 0 ||
    (process.getuid && stat.uid !== process.getuid())
  )
    throw new Error("Invalid private tunnel generation directory");
  return target;
}
export function dependencyEnvironment(
  env: NodeJS.ProcessEnv
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
    keys.flatMap((key) => (env[key] === undefined ? [] : [[key, env[key]]]))
  );
}

interface Paths {
  repositoryRoot: string;
  home: string;
  codexHome: string;
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
    throw new Error("Refusing non-private ChatGPT tunnel file: " + file);
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
    throw new Error(
      "ChatGPT tunnel file must be a private regular file: " + file
    );
  return readFileSync(file, "utf8").trim();
}

function legacyRuntimeKeyPaths(
  directory: string,
  prior?: InstalledState
): string[] {
  const candidates = new Set<string>([path.join(directory, "runtime.key")]);
  if (prior?.generation) {
    try {
      candidates.add(
        path.join(generationPath(directory, prior.generation), "runtime.key")
      );
    } catch {
      /* ignore missing or invalid prior generation */
    }
  }
  if (existsSync(directory)) {
    for (const entry of readdirSync(directory)) {
      if (entry.startsWith("generation-")) {
        candidates.add(path.join(directory, entry, "runtime.key"));
      }
    }
  }
  return [...candidates].filter((file) => privateFileStat(file) !== null);
}

function readLegacyRuntimeKey(
  directory: string,
  prior?: InstalledState
): string {
  if (prior?.generation) {
    try {
      const generationKey = privateRead(
        path.join(generationPath(directory, prior.generation), "runtime.key")
      );
      if (generationKey) return generationKey;
    } catch {
      /* fall through to top-level legacy key */
    }
  }
  return privateRead(path.join(directory, "runtime.key"));
}

function securelyRemoveLegacyRuntimeKeys(
  directory: string,
  prior?: InstalledState
): void {
  for (const legacyFile of legacyRuntimeKeyPaths(directory, prior)) {
    secureDeleteFile(legacyFile);
  }
}

export function validateRuntimeKey(key: string, administrator?: string): void {
  if (
    !key ||
    /[\s\x00-\x1f\x7f]/u.test(key) ||
    key === administrator ||
    key.startsWith("sk-admin")
  )
    throw new Error(
      "Supply a restricted runtime API key with Tunnels Read + Use, not an administrator key"
    );
}

function localAuthPaths(directory: string): {
  keyFile: string;
  headerFile: string;
} {
  return {
    keyFile: path.join(directory, "supergateway.key"),
    headerFile: path.join(directory, "supergateway-auth.header")
  };
}

function writeLocalAuthFiles(
  directory: string,
  token: string
): {
  keyFile: string;
  headerFile: string;
} {
  const files = localAuthPaths(directory);
  privateWrite(files.keyFile, token + "\n");
  privateWrite(files.headerFile, `Bearer ${token}\n`);
  return files;
}

export function tunnelClientMcpEnv(
  authHeaderFile: string
): Record<string, string> {
  return {
    MCP_OAUTH_DISCOVERY: "disabled",
    MCP_EXTRA_HEADERS: `Authorization: file:${authHeaderFile}`,
    MCP_DISCOVERY_EXTRA_HEADERS: `Authorization: file:${authHeaderFile}`
  };
}

async function allocateLoopbackPort(): Promise<number> {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("Failed to allocate loopback port");
  }
  const { port } = address;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

async function stopChildProcess(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  const exited = await Promise.race([
    once(child, "exit").then(() => true),
    delay(5000).then(() => false)
  ]);
  if (!exited && child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL");
    await once(child, "exit").catch(() => {});
  }
}

/** Resolve the workspace-managed dependency; package.json owns its version.
 * Never install or resolve a second dependency tree at tunnel startup. */
export function resolveSupergateway(repositoryRoot: string): string {
  const executable = path.join(
    repositoryRoot,
    "runtime",
    "node_modules",
    ".bin",
    "supergateway"
  );
  if (!resolveCommandOnPath(executable))
    throw new Error(
      "Supergateway is not installed; run pnpm install from the AutoDev repository root"
    );
  return executable;
}

export function tunnelClientSupported(version: string): boolean {
  const parsed = parseCliVersion(version);
  const match = parsed
    ? /^(\d+)\.(\d+)\.(\d+)(?:\+[\da-z.-]+)?$/iu.exec(parsed)
    : null;
  if (!match) return false;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]);
  return major > 0 || minor > 0 || patch >= 21;
}

function tunnelBinary(env: NodeJS.ProcessEnv): string {
  const searchPath = [
    env.PATH,
    process.env.PATH,
    "/opt/homebrew/bin",
    "/usr/local/bin"
  ]
    .filter((entry): entry is string => Boolean(entry))
    .join(path.delimiter);
  let binary = resolveCommandOnPath("tunnel-client", searchPath);
  const supported = (candidate: string): boolean => {
    try {
      return tunnelClientSupported(
        execFileSync(candidate, ["--version"], {
          env,
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
          timeout: 5000
        })
      );
    } catch {
      return false;
    }
  };
  if (binary && supported(binary)) return binary;
  const brew = resolveCommandOnPath("brew", searchPath);
  if (!brew)
    throw new Error(
      "Homebrew is required to install OpenAI tunnel-client >= 0.0.21"
    );
  if (!binary) {
    const tap = homebrewInvocation(brew, ["tap", "openai/tools"]);
    execFileSync(tap.command, tap.args, { env, stdio: "inherit" });
  }
  const invocation = homebrewInvocation(brew, [
    binary ? "upgrade" : "install",
    "openai/tools/tunnel-client"
  ]);
  execFileSync(invocation.command, invocation.args, { env, stdio: "inherit" });
  binary = resolveCommandOnPath("tunnel-client", searchPath);
  if (!binary || !supported(binary))
    throw new Error("OpenAI tunnel-client >= 0.0.21 is required");
  return binary;
}

class TunnelMetadataError extends Error {
  readonly transient: boolean;
  constructor(message: string, transient: boolean) {
    super(message);
    this.transient = transient;
  }
}

const tunnelMetadataSchema = z.object({
  id: z.string().optional(),
  tunnel_id: z.string().optional(),
  organization_ids: z.array(z.string()).optional(),
  workspace_ids: z.array(z.string()).optional()
});

export function tunnelMetadata(
  binary: string,
  args: string[],
  env: NodeJS.ProcessEnv
): z.infer<typeof tunnelMetadataSchema> {
  const childEnv = { ...env };
  // OpenAI's tunnel-client 0.0.21 `admin tunnels get` only reads
  // CONTROL_PLANE_API_KEY / OPENAI_API_KEY / OPENAI_ADMIN_KEY; adapt at this
  // external subprocess boundary without exposing CONTROL_PLANE_API_KEY elsewhere.
  if (args[0] === "get" && childEnv[CHATGPT_TUNNEL_API_KEY_ENV]) {
    childEnv.CONTROL_PLANE_API_KEY = childEnv[CHATGPT_TUNNEL_API_KEY_ENV];
    delete childEnv[CHATGPT_TUNNEL_API_KEY_ENV];
  }
  try {
    return tunnelMetadataSchema.parse(
      JSON.parse(
        execFileSync(binary, ["admin", "--json", "tunnels", ...args], {
          env: childEnv,
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
          timeout: 10_000
        })
      )
    );
  } catch (error) {
    // Inspect only the category; never expose the original output or argv.
    const stderr = String((error as { stderr?: unknown }).stderr ?? "");
    const status =
      /(?:HTTP|status(?: code)?)\s*[:=]?\s*(401|403|404|429|5\d\d)\b/iu.exec(
        stderr
      )?.[1];
    const reason =
      status === "401" || status === "403"
        ? "credential unauthorized"
        : status === "404"
          ? "tunnel not found"
          : status === "429"
            ? "rate limited"
            : "invalid response or transport failure";
    throw new TunnelMetadataError(
      `OpenAI tunnel ${args[0]} failed (${reason}); verify account authorization and tunnel scope in Platform`,
      status === "404"
    );
  }
}

export function assertTunnelScope(
  metadata: z.infer<typeof tunnelMetadataSchema>,
  id: string,
  org: string,
  workspace: string
): void {
  if (
    (metadata.id ?? metadata.tunnel_id) !== id ||
    metadata.organization_ids?.length !== 1 ||
    !metadata.organization_ids.includes(org) ||
    metadata.workspace_ids?.length !== 1 ||
    !metadata.workspace_ids.includes(workspace)
  )
    throw new Error(
      "Tunnel does not belong to the configured organization and ChatGPT workspace"
    );
}

export function createTunnel(
  binary: string,
  env: NodeJS.ProcessEnv,
  org: string,
  workspace: string
): string {
  if (!env.OPENAI_ADMIN_KEY)
    throw new Error(
      "Supply an existing CONTROL_PLANE_TUNNEL_ID or an OPENAI_ADMIN_KEY to create a tunnel"
    );
  const result = tunnelMetadata(
    binary,
    [
      "create",
      "--name",
      "AutoDev ChatGPT",
      "--description",
      "Private AutoDev MCP gateway",
      "--organization-id",
      org,
      "--workspace-id",
      workspace
    ],
    env
  );
  const id = result.id ?? result.tunnel_id;
  if (!id)
    throw new Error(
      "Tunnel creation did not return an ID; inspect Platform before retrying"
    );
  return id;
}

function healthPort(value: string | number | undefined): number {
  const port = Number(value ?? defaultPort);
  if (!Number.isInteger(port) || port < 1024 || port > 65535)
    throw new Error(
      "AUTODEV_CHATGPT_TUNNEL_PORT must be an integer from 1024 to 65535"
    );
  return port;
}

function resolveMcpPort(
  value: string | number | undefined,
  tunnelPort: number
): number {
  const raw = value === undefined ? "" : String(value).trim();
  const port = raw
    ? Number(raw)
    : tunnelPort === defaultMcpPort
      ? defaultMcpPort + 1
      : defaultMcpPort;
  if (!Number.isInteger(port) || port < 1024 || port > 65535)
    throw new Error(
      "AUTODEV_CHATGPT_MCP_PORT must be an integer from 1024 to 65535"
    );
  if (port === tunnelPort)
    throw new Error(
      "AUTODEV_CHATGPT_MCP_PORT must differ from AUTODEV_CHATGPT_TUNNEL_PORT"
    );
  return port;
}

function canonicalPolicyPath(paths: Paths): string {
  return path.join(paths.repositoryRoot, CANONICAL_CHATGPT_POLICY_RELATIVE);
}

function canonicalContractPath(paths: Paths): string {
  return path.join(paths.repositoryRoot, CANONICAL_EXECUTION_CONTRACT_RELATIVE);
}

function readCanonicalPolicyRaw(paths: Paths): string {
  return readFileSync(canonicalPolicyPath(paths), "utf8");
}

function readCanonicalContractRaw(paths: Paths): string {
  try {
    return readFileSync(canonicalContractPath(paths), "utf8");
  } catch {
    return "";
  }
}

/**
 * Parse the operator's published role list.
 *
 * The list is the roles the tunnel exposes to ChatGPT; the first entry is the
 * primary role the Console configures.
 */
export function parsePublishedRoles(
  raw: string | undefined
): string[] | undefined {
  const roles = (raw ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  return roles.length ? roles : undefined;
}

/**
 * Resolve the roles this tunnel publishes.
 *
 * The primary role comes first: it owns the gateway's own delegation
 * coordinator. Every published role carries its own coordinator on its
 * surface, so the order only fixes which role the shared environment names.
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
export function chatgptRoleSurfaceUrl(mcpPort: number, role: string): string {
  return `http://127.0.0.1:${mcpPort}/${role}/mcp`;
}

// The tunnel channel name that carries one published role's surface.
export function chatgptRoleChannel(role: string): string {
  return role.replace(/[^a-zA-Z0-9_-]/gu, "-");
}

/*
The channel `tunnel-client` requires every tunnel to publish.

The daemon refuses to start, and `doctor` fails, unless one MCP target is
addressed by this channel: it is the tunnel's default route, the one a
connector that names no channel of its own lands on.
*/
export const CHATGPT_TUNNEL_MAIN_CHANNEL = "main";

/*
The tunnel channel that carries each published role's surface.

`tunnel-client` requires one target on its `main` channel, so the primary
role's surface is published there and every additional published role gets a
channel named after it. The plan is the single source of both the profile's
routing table and the arguments `doctor` validates, so the two can never
disagree about which channel carries which surface.
*/
export function chatgptTunnelChannels(
  roles: readonly string[]
): { role: string; channel: string }[] {
  const plan: { role: string; channel: string }[] = [];
  const taken = new Set<string>();
  for (const [index, role] of roles.entries()) {
    const channel =
      index === 0 ? CHATGPT_TUNNEL_MAIN_CHANNEL : chatgptRoleChannel(role);
    if (taken.has(channel))
      throw new Error(
        `Two published roles share the tunnel channel "${channel}"; publish one role at a time`
      );
    taken.add(channel);
    plan.push({ role, channel });
  }
  return plan;
}

/*
The profile lines that route each channel to its surface.

The profile is the tunnel's own routing table, so each role's surface is
addressed by its own channel.
*/
export function renderTunnelProfileChannels(
  channels: ReadonlyArray<{ readonly channel: string; readonly url: string }>
): string[] {
  return [
    "mcp:",
    "  server_urls:",
    ...channels.flatMap((entry) => [
      `    - channel: ${entry.channel}`,
      `      url: "${entry.url}"`
    ])
  ];
}

/**
 * Rewrite the generated tunnel profile so it publishes one channel per role.
 *
 * `tunnel-client init` writes a single channel; the profile is the tunnel's
 * own routing table, so each role's surface is addressed by its own channel.
 */
export function withTunnelProfileChannels(
  profileText: string,
  channels: ReadonlyArray<{ readonly channel: string; readonly url: string }>
): string {
  const lines = profileText.split("\n");
  const start = lines.findIndex((line) => /^mcp:$/.test(line));
  if (start < 0) throw new Error("Tunnel profile has no mcp section");
  let end = start + 1;
  while (end < lines.length) {
    const line = lines[end]!;
    if (line.trim() === "") break;
    if (!/^\s/u.test(line)) break;
    end += 1;
  }
  const block = renderTunnelProfileChannels(channels);
  return [...lines.slice(0, start), ...block, ...lines.slice(end)].join("\n");
}

function staticRoleFallbackReviewed(
  paths: Paths,
  role: string
): Record<string, string[]> {
  const raw = readCanonicalPolicyRaw(paths);
  const parsed = parseRulesyncExternalMcpPermissions(raw);
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

function statusReviewedPolicy(
  paths: Paths,
  prior?: InstalledState
): Record<string, string[]> {
  return (
    prior?.reviewed ??
    staticRoleFallbackReviewed(paths, resolveChatgptRole(prior?.role))
  );
}

function stateRevision(
  file: string,
  reviewed: unknown,
  rawPolicy: string,
  rawContract = ""
): string {
  return createHash("sha256")
    .update(privateRead(file))
    .update(JSON.stringify(reviewed))
    .update(rawPolicy)
    .update(rawContract)
    .digest("hex");
}

function remoteSecretAvailability(
  catalogue: Record<string, Record<string, unknown>>,
  hasSecret: (name: string, currentEnv: NodeJS.ProcessEnv) => boolean,
  env: NodeJS.ProcessEnv
): Record<string, boolean> {
  const names = new Set<string>();
  for (const descriptor of Object.values(catalogue)) {
    if (descriptor.url === undefined) continue;
    for (const secretName of requiredRemoteSecretNames(descriptor)) {
      names.add(secretName);
    }
  }
  return Object.fromEntries(
    [...names].sort().map((name) => [name, hasSecret(name, env)])
  );
}

function computePolicyDigest(
  role: string,
  rawContract: string,
  rawPolicy: string,
  catalogue: Record<string, Record<string, unknown>>,
  secretAvailability: Record<string, boolean>
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
    .digest("hex");
}

async function discoverServerTools(
  server: string,
  descriptor: Record<string, unknown>,
  paths: Paths,
  workspace: string,
  node: string,
  gatewayEnv: Record<string, string>,
  env: NodeJS.ProcessEnv,
  backendResolver: typeof externalMcpBackend,
  role: string
): Promise<string[]> {
  const readOnly = roleContract(role).readOnly === true;
  const client = new Client({
    name: "autodev-chatgpt-policy-discovery",
    version: "1.0.0"
  });
  // `xacpx mcp-stdio` validates coordinator registration over its orchestration
  // Unix socket even during `tools/list`. For offline/install-time discovery,
  // bind a disposable in-process IPC server on a short temp socket so real
  // `@ganglion/xacpx` tool discovery succeeds without requiring or mutating a
  // running router daemon.
  let probeXacpxIpc: XacpxOrchestrationIpcHandle | undefined;
  let probeGatewayEnv = gatewayEnv;
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
    probeGatewayEnv = {
      ...gatewayEnv,
      XACPX_ORCHESTRATION_SOCKET: probeSocket,
      AUTODEV_XACPX_COORDINATOR_SESSION: "chatgpt:policy-probe"
    };
  }
  const transport =
    descriptor.url !== undefined
      ? new StreamableHTTPClientTransport(new URL(String(descriptor.url)), {
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
              env
            )
          }
        })
      : (() => {
          const backend = backendResolver(
            server,
            paths.repositoryRoot,
            workspace,
            node,
            paths.home,
            paths.codexHome,
            { role, readOnly }
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
                : probeGatewayEnv,
            stderr: "pipe"
          });
        })();
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
          !readOnly ||
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
  paths: Paths,
  catalogue: Record<string, Record<string, unknown>>,
  role: string,
  workspace: string,
  node: string,
  gatewayEnv: Record<string, string>,
  env: NodeJS.ProcessEnv,
  deps: ChatgptTunnelDependencies,
  prior?: InstalledState
): Promise<{
  policyFile: string;
  policyDigest: string;
  rawPolicy: string;
  reviewed: Record<string, string[]>;
}> {
  const hasSecret =
    deps.hasSecret ??
    ((name: string, currentEnv: NodeJS.ProcessEnv) =>
      Boolean(
        resolveManagedSecret(name, currentEnv) ??
        readRuntimeSecret(name, currentEnv)
      ));
  const policyFile = canonicalPolicyPath(paths);
  const rawPolicy = readCanonicalPolicyRaw(paths);
  const rawContract = readCanonicalContractRaw(paths);
  const policyDigest = computePolicyDigest(
    role,
    rawContract,
    rawPolicy,
    catalogue,
    remoteSecretAvailability(catalogue, hasSecret, env)
  );
  if (
    prior?.policyFile === policyFile &&
    prior.policyDigest === policyDigest &&
    resolveChatgptRole(prior.role) === role &&
    prior.reviewed
  ) {
    return { policyFile, policyDigest, rawPolicy, reviewed: prior.reviewed };
  }

  const contract = roleContract(role);
  const roleAllowedServers = new Set(contract.mcp);
  const roleMcpTools = (contract.mcpTools ?? {}) as Record<string, string[]>;
  const permissions = parseRulesyncExternalMcpPermissions(rawPolicy);
  const discover =
    deps.discoverTools ??
    ((
      server: string,
      descriptor: Record<string, unknown>,
      currentPaths: Paths,
      currentWorkspace: string,
      currentNode: string,
      currentGatewayEnv: Record<string, string>,
      currentEnv: NodeJS.ProcessEnv
    ) =>
      discoverServerTools(
        server,
        descriptor,
        currentPaths,
        currentWorkspace,
        currentNode,
        currentGatewayEnv,
        currentEnv,
        deps.backend,
        role
      ));

  const candidates = Object.entries(catalogue).filter(
    ([server, descriptor]) => {
      if (!roleAllowedServers.has(server)) return false;
      if (descriptor.env !== undefined) return false;
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
        const missingSecret = requiredRemoteSecretNames(descriptor).some(
          (secretName) => !hasSecret(secretName, env)
        );
        return !missingSecret;
      }
      return (
        typeof descriptor.command === "string" &&
        Boolean(descriptor.command.trim()) &&
        hasExternalMcpProfile(server)
      );
    }
  );

  const resolvedEntries = await Promise.all(
    candidates.map(async ([server, descriptor]) => {
      const denied = permissions.deniedTools[server];
      const roleExplicit = roleMcpTools[server];
      if (roleExplicit && roleExplicit.length > 0) {
        const filtered = denied
          ? roleExplicit.filter((tool) => !denied.has(tool))
          : roleExplicit;
        return filtered.length > 0 ? ([server, filtered] as const) : null;
      }
      const permissionExplicit = permissions.allowedTools[server];
      if (permissionExplicit && permissionExplicit.length > 0) {
        const filtered = denied
          ? permissionExplicit.filter((tool) => !denied.has(tool))
          : permissionExplicit;
        return filtered.length > 0 ? ([server, filtered] as const) : null;
      }
      const tools = await discover(
        server,
        descriptor,
        paths,
        workspace,
        node,
        gatewayEnv,
        env
      );
      const filtered = denied
        ? tools.filter((tool) => !denied.has(tool))
        : tools;
      return filtered.length > 0 ? ([server, filtered] as const) : null;
    })
  );

  const reviewedMap = Object.fromEntries(
    resolvedEntries.filter(
      (entry): entry is readonly [string, string[]] => entry !== null
    )
  );
  return {
    policyFile,
    policyDigest,
    rawPolicy,
    reviewed: chatgptGrantsSchema.parse(reviewedMap)
  };
}

/**
 * Read the persisted tunnel state.
 *
 * The state file is a projection of the current installation, not an
 * authority. A file whose shape no longer matches is treated as absent so the
 * next install re-projects it, while unreadable JSON still fails loudly.
 */
function stateAt(file: string): TunnelState | undefined {
  const text = privateRead(file);
  if (!text) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("ChatGPT tunnel state file is not valid JSON");
  }
  const result = stateSchema.safeParse(parsed);
  return result.success ? result.data : undefined;
}

export async function ready(
  launchd: Pick<LaunchdClient, "print">,
  port: number,
  deps: {
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
  },
  mcpPort?: number
): Promise<boolean> {
  try {
    const pid = /^\s*pid = (\d+)$/mu.exec(launchd.print(label))?.[1];
    if (!pid) return false;
    const ports = mcpPort === undefined ? [port] : [port, mcpPort];
    for (const targetPort of ports) {
      const listeners = deps.listeners(targetPort);
      if (listeners.length !== 1 || !listeners[0]) return false;
      const owned =
        listeners[0] === pid || deps.parentPid?.(listeners[0]) === pid;
      if (!owned || !(await deps.probe(targetPort))) return false;
    }
    return true;
  } catch {
    return false;
  }
}

export async function checkChatgptTunnel(
  paths: Paths,
  deps = defaultTunnelDependencies()
): Promise<boolean> {
  try {
    const directory = path.join(paths.codexHome, "chatgpt-tunnel");
    const state = stateAt(path.join(directory, "gateway.json"));
    if (!state)
      return !existsSync(
        path.join(paths.home, "Library", "LaunchAgents", label + ".plist")
      );
    const launchd = deps.launchd();
    if (state.enabled === false)
      return (
        !launchd.isLoaded(label) &&
        !existsSync(
          path.join(paths.home, "Library", "LaunchAgents", label + ".plist")
        ) &&
        legacyRuntimeKeyPaths(directory, state.prior).length === 0
      );
    if (state.mcpPort === undefined || state.mcpPort === state.port)
      return false;
    const generation = generationPath(directory, state.generation);
    const plist = path.join(
      paths.home,
      "Library",
      "LaunchAgents",
      label + ".plist"
    );
    const profileText = readFileSync(
      path.join(generation, "autodev.yaml"),
      "utf8"
    );
    const { keyFile, headerFile } = localAuthPaths(generation);
    const localKey = privateRead(keyFile);
    const localHeader = privateRead(headerFile);
    const supergatewayRaw = privateRead(
      path.join(generation, "supergateway.json")
    );
    const backendPoolRaw = privateRead(
      path.join(generation, "backend-pool.json")
    );
    if (
      !supergatewayRaw ||
      !backendPoolRaw ||
      !localKey ||
      localHeader !== `Bearer ${localKey}`
    )
      return false;
    chatgptBackendPoolConfigSchema.parse(JSON.parse(backendPoolRaw));
    const supergatewayConfig = supergatewayConfigSchema.parse(
      JSON.parse(supergatewayRaw)
    );
    const surfaces = Object.entries(supergatewayConfig.mcpServers);
    const allPooled = surfaces.every(([, surface]) =>
      Object.values(surface.mcpServers).every(
        (entry) => "type" in entry && entry.type === "streamableHttp"
      )
    );
    if (
      !surfaces.length ||
      !allPooled ||
      supergatewayConfig.host !== "127.0.0.1" ||
      supergatewayConfig.port !== state.mcpPort ||
      surfaces.some(
        ([, surface]) =>
          surface.sessionTimeout !== DEFAULT_CHATGPT_SESSION_TIMEOUT_MS ||
          surface.apiKeyFile.replaceAll("$$", "$") !== keyFile
      )
    )
      return false;
    const publishedMcpPort = state.mcpPort;
    const key =
      process.env[CHATGPT_TUNNEL_API_KEY_ENV]?.trim() ||
      deps.readKey(process.env);
    const publishedRoles = state.roles ?? [resolveChatgptRole(state.role)];
    // The profile is the tunnel's routing table: a surface published under the
    // wrong channel is a surface no connector can reach.
    const expectedRouting =
      publishedMcpPort === undefined
        ? ""
        : renderTunnelProfileChannels(
            chatgptTunnelChannels(publishedRoles).map((entry) => ({
              channel: entry.channel,
              url: chatgptRoleSurfaceUrl(publishedMcpPort, entry.role)
            }))
          ).join("\n");
    return Boolean(
      key &&
      legacyRuntimeKeyPaths(directory, state).length === 0 &&
      profileText.includes(CHATGPT_TUNNEL_API_KEY_REF) &&
      publishedMcpPort !== undefined &&
      profileText.includes(expectedRouting) &&
      !profileText.includes("commands:") &&
      !/api_key:\s*["']?file:/u.test(profileText) &&
      launchAgentMatches(
        templatePath(paths),
        plist,
        tunnelLaunchValues(paths, state, deps.launchValues(paths))
      ) &&
      (await deps.ready(launchd, healthPort(state.port), state.mcpPort))
    );
  } catch {
    return false;
  }
}

export async function chatgptTunnelStatus(
  paths: Paths,
  deps = defaultTunnelDependencies()
): Promise<ChatgptTunnelStatus> {
  const stateFile = path.join(
    paths.codexHome,
    "chatgpt-tunnel",
    "gateway.json"
  );
  const state = stateAt(stateFile);
  const prior = installedState(state);
  const role = resolveChatgptRole(prior?.role);
  const roles = prior?.roles ?? [role];
  const reviewed = statusReviewedPolicy(paths, prior);
  const grants = prior?.grants ?? reviewed;
  return {
    schema: "autodev-chatgpt-tunnel-v1",
    revision: stateRevision(
      stateFile,
      reviewed,
      readCanonicalPolicyRaw(paths),
      readCanonicalContractRaw(paths)
    ),
    configured: prior !== undefined,
    enabled: state?.enabled === true,
    ready: state?.enabled === true && (await checkChatgptTunnel(paths, deps)),
    role,
    roles,
    availableRoles: declaredRoleNames(),
    workspace: prior?.workspace ?? null,
    tunnelId: prior?.tunnelId ?? null,
    reviewed,
    grants
  };
}

type TunnelLaunchd = Pick<
  LaunchdClient,
  "isLoaded" | "bootout" | "disable" | "enable" | "bootstrap" | "print"
>;
export interface ChatgptTunnelDependencies {
  platform: NodeJS.Platform;
  launchd(): TunnelLaunchd;
  node(home: string): string;
  tunnelBinary(env: NodeJS.ProcessEnv): string;
  supergateway(repositoryRoot: string): string;
  backend: typeof externalMcpBackend;
  hasSecret?(name: string, env: NodeJS.ProcessEnv): boolean;
  discoverTools?(
    server: string,
    descriptor: Record<string, unknown>,
    paths: Paths,
    workspace: string,
    node: string,
    gatewayEnv: Record<string, string>,
    env: NodeJS.ProcessEnv
  ): Promise<string[]>;
  launchValues(paths: Paths): LaunchAgentValues;
  metadata: typeof tunnelMetadata;
  create: typeof createTunnel;
  ready(job: TunnelLaunchd, port: number, mcpPort?: number): Promise<boolean>;
  portFree(port: number): boolean;
  wait: typeof waitForProbe;
  withCandidateGateway?<T>(
    executable: string,
    config: string,
    env: NodeJS.ProcessEnv,
    workspace: string,
    fn: (mcpUrl: string) => Promise<T> | T
  ): Promise<T>;
  run(
    command: string,
    args: string[],
    options: { env: NodeJS.ProcessEnv; cwd?: string; timeout: number }
  ): void;
  readKey(env: NodeJS.ProcessEnv): string | null;
  writeKey(key: string, env: NodeJS.ProcessEnv): void;
  deleteKey(env: NodeJS.ProcessEnv): boolean;
}

/*
The failing command's own report.

`tunnel-client doctor` writes its check report to stdout, so an installer
that discards the subprocess output leaves the operator with a stage name
and nothing else to act on.
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

/*
A subprocess stream as text, whether it was read as a string or as bytes.
*/
function commandOutput(stream: unknown): string {
  if (typeof stream === "string") return stream.trim();
  if (stream instanceof Uint8Array)
    return Buffer.from(stream).toString("utf8").trim();
  return "";
}

/*
The reason a stage failed, as short as the operator can act on.

A stage's own report is the diagnosis; the stage name alone is not, and
`stderr.log` holds the running service's output rather than the installer's.
*/
function failureDetail(error: unknown): string {
  const message =
    error instanceof Error ? error.message : String(error ?? "unknown error");
  const trimmed = message.trim();
  return trimmed.length > 4000
    ? `${trimmed.slice(0, 4000)}...`
    : trimmed || "unknown error";
}

function defaultTunnelDependencies(): ChatgptTunnelDependencies {
  return {
    platform: process.platform,
    launchd: () => new LaunchdClient(),
    node: resolveServiceNode,
    tunnelBinary,
    supergateway: resolveSupergateway,
    backend: externalMcpBackend,
    launchValues: resolveLaunchAgentValues,
    metadata: tunnelMetadata,
    create: createTunnel,
    ready: (job, port, mcpPort) => ready(job, port, undefined, mcpPort),
    portFree: (port) => {
      const result = spawnSync(
        "/usr/sbin/lsof",
        ["-nP", "-tiTCP:" + port, "-sTCP:LISTEN"],
        { encoding: "utf8" }
      );
      return result.status === 1 && !result.stderr?.trim();
    },
    wait: waitForProbe,
    withCandidateGateway: async (executable, config, env, workspace, fn) => {
      const doctorPort = await allocateLoopbackPort();
      const poolConfigPath = path.join(
        path.dirname(config),
        "backend-pool.json"
      );
      const poolRaw = privateRead(poolConfigPath);
      const cleanGatewayEnv = Object.fromEntries(
        Object.entries(env).filter(
          (entry): entry is [string, string] => entry[1] !== undefined
        )
      );
      // Run the candidate backend pool in its own child process so synchronous
      // `tunnel-client doctor` checks (`execFileSync`) cannot block its HTTP
      // event loop.
      let poolChild: ChildProcess | undefined;
      let candidateEnv: NodeJS.ProcessEnv = env;
      if (poolRaw) {
        const poolToken = randomBytes(32).toString("hex");
        const poolScript = path.join(
          import.meta.dirname,
          "..",
          "mcp",
          "chatgpt-backend-pool.ts"
        );
        poolChild = spawn(process.execPath, [poolScript, poolConfigPath], {
          cwd: workspace,
          env: {
            ...process.env,
            [CHATGPT_MCP_POOL_TOKEN_ENV]: poolToken
          },
          stdio: ["pipe", "pipe", "ignore"]
        });
        poolChild.stdin?.write(
          `${JSON.stringify({ gatewayEnv: cleanGatewayEnv })}\n`
        );
        const poolPort = await new Promise<number>((resolve, reject) => {
          let buf = "";
          const timer = setTimeout(
            () => reject(new Error("Candidate MCP backend pool timed out")),
            15_000
          );
          const onData = (chunk: Buffer): void => {
            buf += chunk.toString("utf8");
            const nl = buf.indexOf("\n");
            if (nl === -1) return;
            clearTimeout(timer);
            poolChild?.stdout?.off("data", onData);
            try {
              const info = JSON.parse(buf.slice(0, nl)) as { port?: unknown };
              if (typeof info.port === "number" && info.port > 0) {
                resolve(info.port);
              } else {
                reject(new Error("Invalid candidate MCP backend pool port"));
              }
            } catch (error) {
              reject(error);
            }
          };
          poolChild?.stdout?.on("data", onData);
          poolChild?.once("exit", () => {
            clearTimeout(timer);
            reject(new Error("Candidate MCP backend pool exited early"));
          });
        });
        candidateEnv = {
          ...env,
          [CHATGPT_MCP_POOL_PORT_ENV]: String(poolPort),
          [CHATGPT_MCP_POOL_TOKEN_ENV]: poolToken
        };
      }
      const child = spawn(
        executable,
        [
          "--config",
          config,
          "--port",
          String(doctorPort),
          "--exitWithProcess",
          String(process.pid)
        ],
        {
          cwd: workspace,
          env: candidateEnv,
          stdio: ["pipe", "ignore", "pipe"]
        }
      );
      try {
        const probe = httpHealthProbe(`http://127.0.0.1:${doctorPort}/readyz`);
        const readyOk = await waitForProbe(
          {
            sleep,
            probe: async () => {
              if (child.exitCode !== null || child.signalCode !== null)
                throw new Error("Candidate Supergateway exited before ready");
              return probe();
            }
          },
          30_000
        );
        if (!readyOk)
          throw new Error("Candidate Supergateway did not become ready");
        return await fn(`http://127.0.0.1:${doctorPort}`);
      } finally {
        await stopChildProcess(child);
        if (poolChild) await stopChildProcess(poolChild);
      }
    },
    run: (command, args, options) => {
      try {
        execFileSync(command, args, {
          ...options,
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"]
        });
      } catch (error) {
        throw new Error(commandFailureReport(command, args, error), {
          cause: error
        });
      }
    },
    readKey: (env) => readKeychainSecret(CHATGPT_TUNNEL_API_KEY_ENV, env),
    writeKey: (key, env) =>
      writeKeychainSecret(CHATGPT_TUNNEL_API_KEY_ENV, key, env),
    deleteKey: (env) => deleteKeychainSecret(CHATGPT_TUNNEL_API_KEY_ENV, env)
  };
}

export async function ensureChatgptTunnel(
  paths: Paths,
  mode: ChatgptTunnelMode,
  env = process.env,
  mutation?: TunnelMutation,
  deps = defaultTunnelDependencies()
): Promise<void> {
  const directory = path.join(paths.codexHome, "chatgpt-tunnel");
  const stateFile = path.join(directory, "gateway.json");
  if (mode === "reconcile" && !existsSync(stateFile)) return;
  if (deps.platform !== "darwin")
    throw new Error(
      "AutoDev ChatGPT tunnel installation currently requires macOS"
    );
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const directoryStat = lstatSync(directory);
  if (
    !directoryStat.isDirectory() ||
    (process.getuid && directoryStat.uid !== process.getuid())
  )
    throw new Error(
      "ChatGPT tunnel directory must be an owned directory, not a symlink"
    );
  chmodSync(directory, 0o700);
  const lock = path.join(directory, "install.lock");
  try {
    mkdirSync(lock, { mode: 0o700 });
  } catch {
    throw new Error(
      "ChatGPT tunnel install is locked; check for another installer before removing install.lock"
    );
  }
  try {
    if (mutation) {
      const prior = installedState(stateAt(stateFile));
      if (!prior) throw new Error("Complete initial installation first");
      const reviewed = statusReviewedPolicy(paths, prior);
      if (
        stateRevision(
          stateFile,
          reviewed,
          readCanonicalPolicyRaw(paths),
          readCanonicalContractRaw(paths)
        ) !== mutation.expectedRevision
      )
        throw new Error("Tunnel configuration revision conflict");
    }
    await reconcile(paths, directory, stateFile, mode, env, mutation, deps);
  } finally {
    rmSync(lock, { recursive: true, force: true });
  }
}

async function reconcile(
  paths: Paths,
  directory: string,
  stateFile: string,
  mode: ChatgptTunnelMode,
  env: NodeJS.ProcessEnv,
  mutation: TunnelMutation | undefined,
  deps: ChatgptTunnelDependencies
): Promise<void> {
  const state = stateAt(stateFile);
  const prior = installedState(state);
  const launchd = deps.launchd();
  if (
    mode === "disable" ||
    (mode === "reconcile" && state?.enabled === false)
  ) {
    privateWrite(
      stateFile,
      JSON.stringify({ version: 1, enabled: false, prior }, null, 2) + "\n"
    );
    launchd.disable(label);
    launchd.bootout(label);
    rmSync(path.join(paths.home, "Library", "LaunchAgents", label + ".plist"), {
      force: true
    });
    if (mutation?.action === "forget" && prior) {
      deps.deleteKey(env);
      securelyRemoveLegacyRuntimeKeys(directory, prior);
      // Only local credentials are forgotten. Remote revocation belongs to Platform.
    } else if (prior) {
      const legacyKey = readLegacyRuntimeKey(directory, prior);
      if (legacyKey) {
        if (!deps.readKey(env)) {
          validateRuntimeKey(
            legacyKey,
            env.OPENAI_ADMIN_KEY?.trim() || undefined
          );
          deps.writeKey(legacyKey, env);
        }
        if (deps.readKey(env)) {
          securelyRemoveLegacyRuntimeKeys(directory, prior);
        }
      }
    }
    writeLine(
      "AutoDev ChatGPT tunnel disabled; normal installs will not re-enable it."
    );
    return;
  }

  const workspace = validateChatgptWorkspace(
    (mutation?.action === "configure" ? mutation.workspace : undefined) ??
      (env.AUTODEV_CHATGPT_MCP_WORKSPACE?.trim() ||
        prior?.workspace ||
        paths.repositoryRoot),
    paths.home,
    paths.codexHome
  );
  const primaryRole = resolveChatgptRole(
    (mutation?.action === "configure" ? mutation.role : undefined) ??
      (env[CHATGPT_AGENT_ROLE_ENV]?.trim() ||
        prior?.role ||
        DEFAULT_CHATGPT_ROLE)
  );
  const priorAdditionalRoles = (prior?.roles ?? []).filter(
    (published) => published !== resolveChatgptRole(prior?.role)
  );
  const roles = resolvePublishedRoles(
    primaryRole,
    (mutation?.action === "configure" ? mutation.roles : undefined) ??
      parsePublishedRoles(env[CHATGPT_MCP_ROLES_ENV]?.trim()) ??
      priorAdditionalRoles
  );
  const role = roles[0]!;
  const node = deps.node(paths.home);
  const catalogue = readBridgeMcpCatalogue(paths.codexHome);
  const filter = {
    command: node,
    script: path.join(paths.codexHome, "src/mcp/tool-filter.ts")
  };
  const backendFor = (server: string, backendRole: string) =>
    deps.backend(
      server,
      paths.repositoryRoot,
      workspace,
      node,
      paths.home,
      paths.codexHome,
      {
        role: backendRole,
        readOnly: roleContract(backendRole).readOnly === true
      }
    );
  const org =
    env.AUTODEV_CHATGPT_ORGANIZATION_ID?.trim() || prior?.organizationId;
  const workspaceId =
    env.AUTODEV_CHATGPT_WORKSPACE_ID?.trim() || prior?.workspaceId;
  if (!org || !workspaceId)
    throw new Error(
      "Set AUTODEV_CHATGPT_ORGANIZATION_ID and AUTODEV_CHATGPT_WORKSPACE_ID to verify tunnel scope"
    );
  const adminKey = env.OPENAI_ADMIN_KEY?.trim() || undefined;
  const rawKey =
    (mutation?.action === "rotate" ? mutation.runtimeKey : undefined) ||
    env[CHATGPT_TUNNEL_API_KEY_ENV]?.trim() ||
    deps.readKey(env) ||
    readLegacyRuntimeKey(directory, prior);
  validateRuntimeKey(rawKey, adminKey);

  const dependencyEnv = dependencyEnvironment(env);
  const binary = deps.tunnelBinary(dependencyEnv);
  const supergateway = deps.supergateway(paths.repositoryRoot);
  const port = healthPort(
    env.AUTODEV_CHATGPT_TUNNEL_PORT?.trim() || prior?.port
  );
  const mcpPort = resolveMcpPort(
    env[CHATGPT_MCP_PORT_ENV]?.trim() || prior?.mcpPort,
    port
  );
  const servicePath = [
    path.dirname(node),
    path.dirname(binary),
    path.dirname(supergateway),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    path.join(paths.home, ".local/bin"),
    "/usr/bin",
    "/bin",
    "/usr/sbin",
    "/sbin"
  ].join(":");
  const cleanEnv = { HOME: paths.home, PATH: servicePath };
  const gatewayEnv = chatgptSupergatewayEnvironment(
    paths,
    workspace,
    node,
    servicePath,
    { role }
  );
  const policyOverride = env.AUTODEV_CHATGPT_MCP_POLICY_FILE?.trim();
  const canonical = await resolveReviewedFromRoleContract(
    paths,
    catalogue,
    role,
    workspace,
    node,
    gatewayEnv,
    env,
    deps,
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
    mutation?.action === "configure"
      ? Object.keys(mutation.grants).length === 0
        ? reviewed
        : mutation.grants
      : policyOverride
        ? JSON.parse(readFileSync(policyFile, "utf8"))
        : !prior ||
            resolveChatgptRole(prior.role) !== role ||
            prior.policyFile !== policyFile ||
            prior.policyDigest !== policyDigest
          ? reviewed
          : prior.grants
  );
  const surfaces: ChatgptRoleSurface[] = [];
  for (const publishedRole of roles) {
    const resolved =
      publishedRole === role
        ? { reviewed, policyDigest }
        : await resolveReviewedFromRoleContract(
            paths,
            catalogue,
            publishedRole,
            workspace,
            node,
            gatewayEnv,
            env,
            deps,
            prior
          );
    surfaces.push({
      role: publishedRole,
      grants:
        publishedRole === role
          ? grants
          : chatgptGrantsSchema.parse(resolved.reviewed),
      reviewed: resolved.reviewed
    });
  }
  const runtimeEnv = { ...cleanEnv, [CHATGPT_TUNNEL_API_KEY_ENV]: rawKey };
  const idFile = path.join(directory, "tunnel-id");
  const existingId =
    env.CONTROL_PLANE_TUNNEL_ID?.trim() ||
    prior?.tunnelId ||
    privateRead(idFile);
  const id =
    existingId ||
    deps.create(
      binary,
      { ...cleanEnv, ...(adminKey ? { OPENAI_ADMIN_KEY: adminKey } : {}) },
      org,
      workspaceId
    );
  if (!/^tunnel_[a-zA-Z0-9_-]+$/u.test(id))
    throw new Error("Invalid tunnel ID");
  // Save newly created remote identity before further steps; never overwrite
  // a working tunnel ID with an unverified user-supplied replacement.
  if (!existingId) privateWrite(idFile, id + "\n");
  // Newly created metadata can take up to 30 seconds to propagate. Retry
  // only explicit transient not-found responses, not permission failures.
  const observation: { metadata?: ReturnType<typeof tunnelMetadata> } = {};
  if (
    !(await deps.wait(
      {
        sleep,
        probe: async () => {
          try {
            observation.metadata = deps.metadata(
              binary,
              ["get", id],
              runtimeEnv
            );
            return true;
          } catch (error) {
            if (
              !existingId &&
              error instanceof TunnelMetadataError &&
              error.transient
            )
              return false;
            throw error;
          }
        }
      },
      45_000
    )) ||
    !observation.metadata
  )
    throw new Error("New tunnel metadata did not become available");
  const metadata = observation.metadata;
  assertTunnelScope(metadata, id, org, workspaceId);

  const legacyFiles = legacyRuntimeKeyPaths(directory, prior);
  if (
    state?.enabled &&
    prior &&
    legacyFiles.length === 0 &&
    prior.workspace === workspace &&
    (prior.roles ?? [resolveChatgptRole(prior.role)]).join(",") ===
      roles.join(",") &&
    prior.policyFile === policyFile &&
    prior.policyDigest === policyDigest &&
    prior.port === port &&
    prior.mcpPort === mcpPort &&
    prior.tunnelId === id &&
    prior.organizationId === org &&
    prior.workspaceId === workspaceId &&
    prior.binary === binary &&
    prior.node === node &&
    prior.supergateway === supergateway &&
    prior.servicePath === servicePath
  ) {
    const active = generationPath(directory, prior.generation);
    const activeAuth = localAuthPaths(active);
    const activeKey = privateRead(activeAuth.keyFile);
    const activeHeader = privateRead(activeAuth.headerFile);
    const expectedActive = activeKey
      ? renderChatgptSupergatewayConfig(
          catalogue,
          surfaces,
          workspace,
          {
            port: mcpPort,
            apiKeyFile: activeAuth.keyFile,
            sessionTimeout: DEFAULT_CHATGPT_SESSION_TIMEOUT_MS,
            backendPool: true
          },
          filter,
          backendFor
        )
      : "";
    const expectedActivePool = activeKey
      ? renderChatgptBackendPoolConfig(
          catalogue,
          surfaces,
          workspace,
          backendFor
        )
      : "";
    if (
      deps.readKey(env) === rawKey &&
      activeKey &&
      activeHeader === `Bearer ${activeKey}` &&
      privateRead(path.join(active, "supergateway.json")) ===
        expectedActive.trim() &&
      privateRead(path.join(active, "backend-pool.json")) ===
        expectedActivePool.trim() &&
      (await checkChatgptTunnel(paths, deps))
    ) {
      writeLine("AutoDev ChatGPT tunnel already ready: " + id);
      return;
    }
  }
  const generation = mkdtempSync(path.join(directory, "generation-"));
  chmodSync(generation, 0o700);
  const config = path.join(generation, "supergateway.json");
  const poolConfig = path.join(generation, "backend-pool.json");
  const profile = path.join(generation, "autodev.yaml");
  const stagedFile = path.join(directory, "staged.json");
  const plistFile = path.join(
    paths.home,
    "Library",
    "LaunchAgents",
    label + ".plist"
  );
  const previousPlist = existsSync(plistFile)
    ? readFileSync(plistFile, "utf8")
    : "";
  const wasRunning = launchd.isLoaded(label);
  const previousKey = deps.readKey(env);
  let keyUpdated = false;
  let stopped = false;
  let committed = false;
  let rollbackFailed = false;
  let stage = "staging";
  try {
    const localToken = randomBytes(32).toString("hex");
    const authFiles = writeLocalAuthFiles(generation, localToken);
    const generatedPool = renderChatgptBackendPoolConfig(
      catalogue,
      surfaces,
      workspace,
      backendFor
    );
    const generated = renderChatgptSupergatewayConfig(
      catalogue,
      surfaces,
      workspace,
      {
        port: mcpPort,
        apiKeyFile: authFiles.keyFile,
        sessionTimeout: DEFAULT_CHATGPT_SESSION_TIMEOUT_MS,
        backendPool: true
      },
      filter,
      backendFor
    );
    privateWrite(poolConfig, generatedPool);
    privateWrite(config, generated);
    stage = "supergateway config check";
    deps.run(supergateway, ["--config", config, "--checkConfig"], {
      cwd: workspace,
      env: {
        ...gatewayEnv,
        [CHATGPT_MCP_POOL_PORT_ENV]: "1",
        [CHATGPT_MCP_POOL_TOKEN_ENV]: "check-config"
      },
      timeout: 30_000
    });
    stage = "supergateway MCP probe";
    deps.run(
      node,
      [
        path.join(paths.codexHome, "src/mcp/chatgpt-supergateway-probe.ts"),
        supergateway,
        config
      ],
      { cwd: workspace, env: gatewayEnv, timeout: 60_000 }
    );
    stage = "tunnel-client init";
    deps.run(
      binary,
      [
        "init",
        "--sample",
        "sample_mcp_remote_no_auth",
        "--profile",
        "autodev",
        "--profile-dir",
        generation,
        "--tunnel-id",
        id,
        "--control-plane-api-key-ref",
        CHATGPT_TUNNEL_API_KEY_REF,
        "--mcp-server-url",
        chatgptRoleSurfaceUrl(mcpPort, role),
        "--health-listen-addr",
        `127.0.0.1:${port}`
      ],
      { env: cleanEnv, timeout: 30_000 }
    );
    // The prior service may own the desired ports. Doctor validates the
    // candidate against an ephemeral candidate Supergateway and health port.
    const channelPlan = chatgptTunnelChannels(roles);
    privateWrite(
      profile,
      withTunnelProfileChannels(
        readFileSync(profile, "utf8"),
        channelPlan.map((entry) => ({
          channel: entry.channel,
          url: chatgptRoleSurfaceUrl(mcpPort, entry.role)
        }))
      )
    );
    chmodSync(profile, 0o600);
    stage = "tunnel-client doctor";
    const runDoctor = (doctorBaseUrl: string): void => {
      deps.run(
        binary,
        [
          "doctor",
          "--profile-file",
          profile,
          "--health.listen-addr",
          "127.0.0.1:0",
          ...channelPlan.flatMap((entry) => [
            "--mcp.server-url",
            `url=${chatgptRoleSurfaceUrl(
              Number(new URL(doctorBaseUrl).port),
              entry.role
            )},channel=${entry.channel}`
          ]),
          "--mcp.oauth-discovery=disabled",
          "--explain"
        ],
        {
          env: {
            ...runtimeEnv,
            ...tunnelClientMcpEnv(authFiles.headerFile)
          },
          timeout: 60_000
        }
      );
    };
    if (deps.withCandidateGateway) {
      await deps.withCandidateGateway(
        supergateway,
        config,
        gatewayEnv,
        workspace,
        runDoctor
      );
    } else {
      runDoctor(`http://127.0.0.1:${mcpPort}`);
    }

    stage = "keychain store";
    if (!previousKey || mutation?.action === "rotate") {
      deps.writeKey(rawKey, env);
      if (deps.readKey(env) !== rawKey) {
        throw new Error(
          "Keychain verification failed for ChatGPT tunnel credential"
        );
      }
      keyUpdated = true;
    }

    const nextState = installedStateSchema.parse({
      workspace,
      role,
      roles,
      policyFile,
      policyDigest,
      reviewed,
      grants,
      generation: path.basename(generation),
      port,
      mcpPort,
      organizationId: org,
      workspaceId,
      tunnelId: id,
      binary,
      node,
      supergateway,
      servicePath
    });
    const candidatePlist = path.join(generation, label + ".plist");
    renderLaunchAgent(
      templatePath(paths),
      candidatePlist,
      tunnelLaunchValues(paths, nextState, deps.launchValues(paths))
    );

    stage = "launchd stop";
    launchd.bootout(label);
    stopped = true;
    stage = "readiness port check";
    if (!deps.portFree(port) || !deps.portFree(mcpPort))
      throw new Error(
        "Tunnel readiness or MCP port is already in use or could not be checked"
      );
    stage = "launchd start";
    privateWrite(stagedFile, JSON.stringify(nextState, null, 2) + "\n");
    privateWrite(plistFile, readFileSync(candidatePlist, "utf8"));
    launchd.enable(label);
    launchd.bootstrap(plistFile);
    stage = "tunnel readiness";
    if (
      !(await deps.wait(
        { probe: () => deps.ready(launchd, port, mcpPort), sleep },
        60_000
      ))
    )
      throw new Error("Tunnel did not become ready");
    privateWrite(
      stateFile,
      JSON.stringify({ version: 1, enabled: true, ...nextState }, null, 2) +
        "\n"
    );
    committed = true;
    rmSync(stagedFile, { force: true });
    // Only remove legacy plaintext credential files after the Keychain-backed
    // service is verified ready and gateway.json is committed.
    securelyRemoveLegacyRuntimeKeys(directory, prior);
    writeLine("AutoDev ChatGPT tunnel ready: " + id);
    writeLine(
      "ChatGPT Plugins > Add custom MCP server > Tunnel > AutoDev ChatGPT"
    );
  } catch (error) {
    rmSync(stagedFile, { force: true });
    if (keyUpdated) {
      try {
        if (previousKey) deps.writeKey(previousKey, env);
        else deps.deleteKey(env);
      } catch {
        /* best effort rollback */
      }
    }
    if (stopped) {
      try {
        launchd.bootout(label);
        if (previousPlist) {
          privateWrite(plistFile, previousPlist);
          if (wasRunning) {
            launchd.enable(label);
            launchd.bootstrap(plistFile);
          } else launchd.disable(label);
        } else {
          rmSync(plistFile, { force: true });
          launchd.disable(label);
        }
      } catch {
        rollbackFailed = true;
        throw new Error(
          `ChatGPT tunnel setup (${stage}) and rollback failed; candidate generation retained for recovery`
        );
      }
    }
    throw new Error(
      `ChatGPT tunnel setup failed (${stage}): ${failureDetail(error)}; previous service configuration retained. Check tunnel diagnostics and ${path.join(directory, "stderr.log")}`,
      { cause: error }
    );
  } finally {
    rmSync(stagedFile, { force: true });
    if (!committed && !rollbackFailed)
      rmSync(generation, { recursive: true, force: true });
  }
  // A previous generation is not needed after the new one is ready.
  if (prior?.generation && prior.generation !== path.basename(generation)) {
    const old = path.join(directory, prior.generation);
    if (existsSync(old) && lstatSync(old).isDirectory())
      rmSync(old, { recursive: true, force: true });
  }
}

function templatePath(paths: Paths): string {
  return path.join(
    paths.repositoryRoot,
    "config",
    "launchagents",
    label + ".plist"
  );
}
function tunnelLaunchValues(
  paths: Paths,
  state: InstalledState,
  values: LaunchAgentValues
): LaunchAgentValues {
  return {
    ...values,
    tunnel: {
      node: state.node,
      runner: path.join(
        paths.codexHome,
        "src",
        "platform",
        "chatgpt-tunnel-install.ts"
      ),
      repositoryRoot: paths.repositoryRoot,
      codexHome: paths.codexHome,
      workspace: state.workspace,
      servicePath: state.servicePath,
      logDirectory: path.join(paths.codexHome, "chatgpt-tunnel")
    }
  };
}

/** Launch Supergateway (loopback Streamable HTTP) and tunnel-client with Keychain credentials. */
export async function runChatgptTunnelDaemon(
  paths: Paths,
  env: NodeJS.ProcessEnv = process.env,
  deps: {
    readKey?: (environment: NodeJS.ProcessEnv) => string | null;
    spawnProcess?: typeof spawn;
    waitForGateway?: (
      mcpPort: number,
      gateway: ChildProcess
    ) => Promise<boolean>;
  } = {}
): Promise<number> {
  const directory = path.join(paths.codexHome, "chatgpt-tunnel");
  const stagedRaw = privateRead(path.join(directory, "staged.json"));
  const state = stagedRaw
    ? {
        enabled: true as const,
        ...installedStateSchema.parse(JSON.parse(stagedRaw))
      }
    : stateAt(path.join(directory, "gateway.json"));
  if (!state?.enabled) {
    process.stderr.write(
      "AutoDev ChatGPT tunnel is disabled or not configured\n"
    );
    return 1;
  }
  if (state.mcpPort === undefined) {
    process.stderr.write(
      "AutoDev ChatGPT tunnel requires Streamable HTTP migration; rerun scripts/install.sh --enable-chatgpt-tunnel\n"
    );
    return 1;
  }
  const generation = generationPath(directory, state.generation);
  const profile = path.join(generation, "autodev.yaml");
  const supergatewayConfig = path.join(generation, "supergateway.json");
  const authFiles = localAuthPaths(generation);
  if (
    !existsSync(profile) ||
    !existsSync(supergatewayConfig) ||
    !privateRead(authFiles.keyFile) ||
    !privateRead(authFiles.headerFile)
  ) {
    process.stderr.write(
      "AutoDev ChatGPT tunnel configuration or local auth files are missing\n"
    );
    return 1;
  }
  const readKey =
    deps.readKey ??
    ((environment: NodeJS.ProcessEnv) =>
      readKeychainSecret(CHATGPT_TUNNEL_API_KEY_ENV, environment));
  const runtimeKey = env[CHATGPT_TUNNEL_API_KEY_ENV]?.trim() || readKey(env);
  if (!runtimeKey) {
    process.stderr.write(
      "AutoDev ChatGPT tunnel runtime key is unavailable in macOS Keychain; rerun scripts/install.sh --enable-chatgpt-tunnel\n"
    );
    return 1;
  }
  const spawnProcess = deps.spawnProcess ?? spawn;
  const gatewayEnv = chatgptSupergatewayEnvironment(
    paths,
    state.workspace,
    state.node,
    state.servicePath,
    { role: resolveChatgptRole(state.role ?? DEFAULT_CHATGPT_ROLE) }
  );
  const backendPoolRaw = privateRead(
    path.join(generation, "backend-pool.json")
  );
  let backendPool: ChatgptBackendPoolHandle | undefined;
  if (backendPoolRaw) {
    backendPool = await startChatgptBackendPool(
      chatgptBackendPoolConfigSchema.parse(JSON.parse(backendPoolRaw)),
      { gatewayEnv, secretEnv: env }
    );
  }
  const supergatewayEnv = backendPool
    ? {
        ...gatewayEnv,
        [CHATGPT_MCP_POOL_PORT_ENV]: String(backendPool.port),
        [CHATGPT_MCP_POOL_TOKEN_ENV]: backendPool.token
      }
    : gatewayEnv;
  const gateway = spawnProcess(
    state.supergateway,
    ["--config", supergatewayConfig, "--exitWithProcess", String(process.pid)],
    {
      cwd: state.workspace,
      env: supergatewayEnv,
      stdio: ["pipe", "inherit", "inherit"]
    }
  );
  let gatewayExited = false;
  let gatewayStartError = false;
  gateway.once("error", () => {
    gatewayStartError = true;
  });
  gateway.once("exit", () => {
    gatewayExited = true;
  });

  const waitForGateway =
    deps.waitForGateway ??
    (async (mcpPort: number) => {
      const probe = httpHealthProbe(`http://127.0.0.1:${mcpPort}/readyz`);
      return waitForProbe(
        {
          sleep,
          probe: async () => {
            if (gatewayStartError || gatewayExited) return false;
            return probe();
          }
        },
        30_000
      );
    });

  let stopping = false;
  const terminateBoth = async (
    signal: NodeJS.Signals,
    tunnel?: ChildProcess
  ): Promise<void> => {
    stopping = true;
    const stopTarget = async (
      proc: ChildProcess | undefined
    ): Promise<void> => {
      if (!proc || proc.exitCode !== null || proc.killed) return;
      proc.kill(signal);
    };
    await stopTarget(tunnel);
    await stopTarget(gateway);
  };

  let tunnel: ChildProcess | undefined;
  const onSigterm = (): void => {
    void terminateBoth("SIGTERM", tunnel);
  };
  const onSigint = (): void => {
    void terminateBoth("SIGINT", tunnel);
  };
  process.once("SIGTERM", onSigterm);
  process.once("SIGINT", onSigint);
  const cleanupListeners = (): void => {
    process.removeListener("SIGTERM", onSigterm);
    process.removeListener("SIGINT", onSigint);
  };

  try {
    const gatewayReady = await waitForGateway(state.mcpPort, gateway);
    if (!gatewayReady || gatewayStartError || gatewayExited || stopping) {
      process.stderr.write(
        "Failed to start Supergateway Streamable HTTP server\n"
      );
      await stopChildProcess(gateway);
      return 1;
    }

    tunnel = spawnProcess(state.binary, ["run", "--profile-file", profile], {
      cwd: state.workspace,
      env: {
        HOME: paths.home,
        PATH: state.servicePath,
        MCP_FORWARD_TRACE_CONTEXT: "true",
        ...tunnelClientMcpEnv(authFiles.headerFile),
        [CHATGPT_TUNNEL_API_KEY_ENV]: runtimeKey
      },
      stdio: "inherit"
    });

    return await new Promise<number>((resolve) => {
      let settled = false;
      const settle = (
        code: number,
        stopSibling: ChildProcess | undefined
      ): void => {
        if (settled) return;
        settled = true;
        cleanupListeners();
        void (
          stopSibling ? stopChildProcess(stopSibling) : Promise.resolve()
        ).finally(() => resolve(code));
      };
      gateway.once("error", () => {
        process.stderr.write("Supergateway process failed\n");
        settle(1, tunnel);
      });
      gateway.once("exit", (code) => {
        if (!stopping)
          process.stderr.write("Supergateway exited unexpectedly\n");
        settle(stopping ? 0 : code && code !== 0 ? code : 1, tunnel);
      });
      tunnel!.once("error", () => {
        process.stderr.write("Failed to start tunnel-client daemon\n");
        settle(1, gateway);
      });
      tunnel!.once("exit", (code, signal) => {
        settle(code ?? (signal ? 1 : 0), gateway);
      });
    });
  } finally {
    cleanupListeners();
    if (backendPool) await backendPool.close().catch(() => {});
  }
}

if (isEntryPoint(import.meta.url)) {
  const [mode, repositoryRoot, home, codexHome] = process.argv.slice(2);
  if (!repositoryRoot || !home || !codexHome)
    throw new Error("Expected tunnel mode and install paths");
  const paths = { repositoryRoot, home, codexHome };
  if (mode === "control") {
    // The authorized Control API passes mutations via stdin, never argv or logs.
    try {
      const mutation = tunnelMutationSchema.parse(
        JSON.parse(readFileSync(0, "utf8"))
      );
      await ensureChatgptTunnel(
        paths,
        mutation.action === "disable" || mutation.action === "forget"
          ? "disable"
          : "enable",
        dependencyEnvironment(process.env),
        mutation
      );
    } catch {
      process.stderr.write(
        "ChatGPT tunnel mutation refused or failed; reload status before retrying\n"
      );
      process.exitCode = 1;
    }
  } else if (mode === "run") {
    process.exitCode = await runChatgptTunnelDaemon(paths);
  } else if (mode === "check") {
    process.exitCode = (await checkChatgptTunnel(paths)) ? 0 : 1;
  } else if (mode === "reconcile" || mode === "enable" || mode === "disable") {
    try {
      await ensureChatgptTunnel(paths, mode);
    } catch (error) {
      // Only locally constructed errors are printed; subprocess failures may contain sensitive output.
      const safe =
        error instanceof Error &&
        !("stdout" in error) &&
        !("stderr" in error) &&
        !(error instanceof z.ZodError);
      process.stderr.write(
        (safe
          ? error.message
          : "ChatGPT tunnel setup failed; inspect local configuration") + "\n"
      );
      process.exitCode = 1;
    }
  } else throw new Error("Invalid ChatGPT tunnel mode");
}
