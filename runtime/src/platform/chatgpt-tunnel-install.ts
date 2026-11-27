/**
The optional ChatGPT tunnel: OpenAI's `tunnel-client` publishing the shared
AutoDev MCP gateway's role surfaces to ChatGPT.

The tunnel is only a client of the gateway (`mcp-gateway-service.ts`). It
owns the OpenAI tunnel identity, the runtime credential, and its own
LaunchAgent; it never starts, configures or stops the gateway, so disabling
or losing the tunnel leaves local MCP access untouched.
*/
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync
} from "node:fs";
import path from "node:path";

import type { ChatgptTunnelStatus } from "@simulatorlife/autodev-core";
import { writeLine } from "@simulatorlife/autodev-runtime/shared/output";
import { z } from "zod";

import { parseCliVersion } from "../providers/cli-versions.ts";
import { isEntryPoint } from "../shared/entry-point.ts";
import {
  deleteKeychainSecret,
  readKeychainSecret,
  writeKeychainSecret
} from "../shared/runtime-secrets.ts";
import { homebrewInvocation } from "./dependencies.ts";
import {
  launchAgentMatches,
  type LaunchAgentValues,
  renderLaunchAgent
} from "./macos/launchagent.ts";
import {
  defaultMcpGatewayDependencies,
  dependencyEnvironment,
  ensurePrivateDirectory,
  failureDetail,
  generationPath,
  installedServiceRunner,
  mcpGatewayAuthPaths,
  type McpGatewayDependencies,
  mcpGatewayRoleSurfaceUrl,
  type McpGatewayState,
  mcpGatewaySurfaceStatus,
  privateRead,
  privateWrite,
  readCanonicalContractRaw,
  readCanonicalPolicyRaw,
  readMcpGatewayState,
  readMcpGatewayStateRaw,
  serviceLaunchAgentPath,
  type ServicePaths,
  servicePort,
  serviceSearchPath,
  serviceTemplatePath,
  superviseChild,
  waitForMcpGateway,
  withInstallLock
} from "./mcp-gateway-service.ts";
import { resolveCommandOnPath } from "./runtime-files.ts";
import { sleep } from "./sleep.ts";

const label = "com.codex.autodev-chatgpt-tunnel";
const defaultPort = 3311;
export const CHATGPT_TUNNEL_API_KEY_ENV = "AUTODEV_CHATGPT_TUNNEL_API_KEY";
export const CHATGPT_TUNNEL_PORT_ENV = "AUTODEV_CHATGPT_TUNNEL_PORT";
const CHATGPT_TUNNEL_API_KEY_REF = `env:${CHATGPT_TUNNEL_API_KEY_ENV}`;
export type ChatgptTunnelMode = "reconcile" | "enable" | "disable";

// Unknown keys are stripped: the tunnel state only records what the tunnel
// itself owns.
const installedStateSchema = z.object({
  // The private directory holding the generated tunnel-client profile.
  generation: z.string().regex(/^generation-[a-zA-Z0-9_-]+$/u),
  port: z.number().int().min(1024).max(65_535),
  organizationId: z.string().min(1),
  workspaceId: z.string().min(1),
  tunnelId: z.string().regex(/^tunnel_[a-zA-Z0-9_-]+$/u),
  binary: z.string().refine(path.isAbsolute),
  servicePath: z.string().min(1),
  node: z.string().refine(path.isAbsolute)
});
const stateSchema = z.discriminatedUnion("enabled", [
  installedStateSchema.extend({
    version: z.literal(1),
    enabled: z.literal(true)
  }),
  z.object({
    version: z.literal(1),
    enabled: z.literal(false),
    prior: installedStateSchema.optional()
  })
]);
type TunnelState = z.infer<typeof stateSchema>;
type InstalledState = z.infer<typeof installedStateSchema>;
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
      action: z.literal("rotate"),
      expectedRevision: revision,
      runtimeKey: z.string().min(1).max(4096)
    })
    .strict()
]);
type TunnelMutation = z.infer<typeof tunnelMutationSchema>;

function installedState(
  state: TunnelState | undefined
): InstalledState | undefined {
  if (!state) return undefined;
  if (!state.enabled) return state.prior;
  const { enabled: _enabled, version: _version, ...installed } = state;
  return installed;
}

function tunnelDirectory(codexHome: string): string {
  return path.join(codexHome, "chatgpt-tunnel");
}

function tunnelStateFile(codexHome: string): string {
  return path.join(tunnelDirectory(codexHome), "gateway.json");
}

export function validateRuntimeKey(key: string, administrator?: string): void {
  if (
    !key ||
    /[\s\u{0}-\u{1F}\u{7F}]/u.test(key) ||
    key === administrator ||
    key.startsWith("sk-admin")
  )
    throw new Error(
      "Supply a restricted runtime API key with Tunnels Read + Use, not an administrator key"
    );
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

function tunnelBinary(environment: NodeJS.ProcessEnv): string {
  const searchPath = [
    environment.PATH,
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
          env: environment,
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
    execFileSync(tap.command, tap.args, { env: environment, stdio: "inherit" });
  }
  const invocation = homebrewInvocation(brew, [
    binary ? "upgrade" : "install",
    "openai/tools/tunnel-client"
  ]);
  execFileSync(invocation.command, invocation.args, { env: environment, stdio: "inherit" });
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
  arguments_: string[],
  environment: NodeJS.ProcessEnv
): z.infer<typeof tunnelMetadataSchema> {
  const childEnvironment = { ...environment };
  // OpenAI's tunnel-client 0.0.21 `admin tunnels get` only reads
  // CONTROL_PLANE_API_KEY / OPENAI_API_KEY / OPENAI_ADMIN_KEY; adapt at this
  // external subprocess boundary without exposing CONTROL_PLANE_API_KEY elsewhere.
  if (arguments_[0] === "get" && childEnvironment[CHATGPT_TUNNEL_API_KEY_ENV]) {
    childEnvironment.CONTROL_PLANE_API_KEY = childEnvironment[CHATGPT_TUNNEL_API_KEY_ENV];
    delete childEnvironment[CHATGPT_TUNNEL_API_KEY_ENV];
  }
  try {
    return tunnelMetadataSchema.parse(
      JSON.parse(
        execFileSync(binary, ["admin", "--json", "tunnels", ...arguments_], {
          env: childEnvironment,
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
      /(?:HTTP|status(?: code)?)\s*(?:[:=]\s*)?(401|403|404|429|5\d\d)\b/iu.exec(
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
      `OpenAI tunnel ${arguments_[0]} failed (${reason}); verify account authorization and tunnel scope in Platform`,
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
  environment: NodeJS.ProcessEnv,
  org: string,
  workspace: string
): string {
  if (!environment.OPENAI_ADMIN_KEY)
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
    environment
  );
  const id = result.id ?? result.tunnel_id;
  if (!id)
    throw new Error(
      "Tunnel creation did not return an ID; inspect Platform before retrying"
    );
  return id;
}

// The tunnel channel name that carries one published role's surface.
export function chatgptRoleChannel(role: string): string {
  return role.replaceAll(/[^a-zA-Z0-9_-]/gu, "-");
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
Rewrite the generated tunnel profile so it publishes one channel per role.

`tunnel-client init` writes a single channel; the profile is the tunnel's
own routing table, so each role's surface is addressed by its own channel.
*/
export function withTunnelProfileChannels(
  profileText: string,
  channels: ReadonlyArray<{ readonly channel: string; readonly url: string }>
): string {
  const lines = profileText.split("\n");
  const start = lines.indexOf("mcp:");
  if (start === -1) throw new Error("Tunnel profile has no mcp section");
  let end = start + 1;
  while (end < lines.length) {
    const line = lines[end]!;
    if ((line.trim() === "") || !/^\s/u.test(line)) break;
    end += 1;
  }
  const block = renderTunnelProfileChannels(channels);
  return [...lines.slice(0, start), ...block, ...lines.slice(end)].join("\n");
}

/*
The tunnel channels and local surface URLs for the gateway's published roles.
*/
function gatewayChannels(
  gateway: McpGatewayState
): { channel: string; url: string; role: string }[] {
  return chatgptTunnelChannels(gateway.roles).map((entry) => ({
    ...entry,
    url: mcpGatewayRoleSurfaceUrl(gateway.mcpPort, entry.role)
  }));
}

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

/*
The revision a Control API mutation must name: it changes whenever the
tunnel, the gateway, or the reviewed policy they derive from changes.
*/
function controlRevision(paths: ServicePaths, reviewed: unknown): string {
  return createHash("sha256")
    .update(privateRead(tunnelStateFile(paths.codexHome)))
    .update("\n")
    .update(readMcpGatewayStateRaw(paths.codexHome))
    .update("\n")
    .update(JSON.stringify(reviewed))
    .update(readCanonicalPolicyRaw(paths))
    .update(readCanonicalContractRaw(paths))
    .digest("hex");
}

type TunnelLaunchd = ReturnType<McpGatewayDependencies["launchd"]>;

export interface ChatgptTunnelDependencies extends McpGatewayDependencies {
  tunnelBinary(environment: NodeJS.ProcessEnv): string;
  metadata: typeof tunnelMetadata;
  create: typeof createTunnel;
  readKey(environment: NodeJS.ProcessEnv): string | null;
  writeKey(key: string, environment: NodeJS.ProcessEnv): void;
  deleteKey(environment: NodeJS.ProcessEnv): boolean;
}

function defaultTunnelDependencies(): ChatgptTunnelDependencies {
  return {
    ...defaultMcpGatewayDependencies(),
    tunnelBinary,
    metadata: tunnelMetadata,
    create: createTunnel,
    readKey: (environment) => readKeychainSecret(CHATGPT_TUNNEL_API_KEY_ENV, environment),
    writeKey: (key, environment) =>
      writeKeychainSecret(CHATGPT_TUNNEL_API_KEY_ENV, key, environment),
    deleteKey: (environment) => deleteKeychainSecret(CHATGPT_TUNNEL_API_KEY_ENV, environment)
  };
}

function tunnelLaunchValues(
  paths: ServicePaths,
  state: InstalledState,
  values: LaunchAgentValues
): LaunchAgentValues {
  const directory = tunnelDirectory(paths.codexHome);
  return {
    ...values,
    service: {
      node: state.node,
      runner: installedServiceRunner(paths, "chatgpt-tunnel-install.ts"),
      repositoryRoot: paths.repositoryRoot,
      codexHome: paths.codexHome,
      workingDirectory: directory,
      servicePath: state.servicePath,
      logDirectory: directory
    }
  };
}

export async function checkChatgptTunnel(
  paths: ServicePaths,
  dependencies: ChatgptTunnelDependencies = defaultTunnelDependencies()
): Promise<boolean> {
  try {
    const directory = tunnelDirectory(paths.codexHome);
    const plist = serviceLaunchAgentPath(paths, label);
    const state = stateAt(tunnelStateFile(paths.codexHome));
    if (!state) return !existsSync(plist);
    const launchd = dependencies.launchd();
    if (state.enabled === false)
      return !launchd.isLoaded(label) && !existsSync(plist);
    const gateway = readMcpGatewayState(paths.codexHome);
    if (!gateway || gateway.mcpPort === state.port) return false;
    const profileText = readFileSync(
      path.join(generationPath(directory, state.generation), "autodev.yaml"),
      "utf8"
    );
    const key =
      process.env[CHATGPT_TUNNEL_API_KEY_ENV]?.trim() ||
      dependencies.readKey(process.env);
    // The profile is the tunnel's routing table: a surface published under the
    // wrong channel is a surface no connector can reach.
    const expectedRouting = renderTunnelProfileChannels(
      gatewayChannels(gateway)
    ).join("\n");
    return Boolean(
      key &&
      profileText.includes(CHATGPT_TUNNEL_API_KEY_REF) &&
      profileText.includes(expectedRouting) &&
      !profileText.includes("commands:") &&
      !/api_key:\s*["']?file:/u.test(profileText) &&
      launchAgentMatches(
        serviceTemplatePath(paths, label),
        plist,
        tunnelLaunchValues(paths, state, dependencies.launchValues(paths))
      ) &&
      (await dependencies.ready(launchd, label, state.port))
    );
  } catch {
    return false;
  }
}

export async function chatgptTunnelStatus(
  paths: ServicePaths,
  dependencies: ChatgptTunnelDependencies = defaultTunnelDependencies()
): Promise<ChatgptTunnelStatus> {
  const state = stateAt(tunnelStateFile(paths.codexHome));
  const prior = installedState(state);
  const surfaces = mcpGatewaySurfaceStatus(
    paths,
    readMcpGatewayState(paths.codexHome)
  );
  // Tunnel facts only. The gateway's role surfaces and grants are published
  // once, on the MCP catalog (`GET /control/mcps`); the tunnel reports which
  // of those roles it carries as channels.
  return {
    schema: "autodev-chatgpt-tunnel-v2",
    revision: controlRevision(paths, surfaces.reviewed),
    configured: prior !== undefined,
    enabled: state?.enabled === true,
    ready: state?.enabled === true && (await checkChatgptTunnel(paths, dependencies)),
    roles: surfaces.roles,
    tunnelId: prior?.tunnelId ?? null
  };
}

/**
Apply an installer mode or an authorized Control API mutation.

Every mutation acts on the tunnel alone. The gateway's published roles and
grants are repository-owned (the canonical role contract, narrowed only by
the installer's private policy file), so no tunnel mutation reconfigures them.
*/
export async function ensureChatgptTunnel(
  paths: ServicePaths,
  mode: ChatgptTunnelMode,
  environment = process.env,
  mutation?: TunnelMutation,
  dependencies: ChatgptTunnelDependencies = defaultTunnelDependencies()
): Promise<void> {
  const directory = tunnelDirectory(paths.codexHome);
  const stateFile = tunnelStateFile(paths.codexHome);
  if (mutation) {
    const gateway = readMcpGatewayState(paths.codexHome);
    if (
      controlRevision(
        paths,
        mcpGatewaySurfaceStatus(paths, gateway).reviewed
      ) !== mutation.expectedRevision
    )
      throw new Error("Tunnel configuration revision conflict");
    if (!installedState(stateAt(stateFile)))
      throw new Error("Complete initial tunnel installation first");
  }
  if (mode === "reconcile" && !existsSync(stateFile)) return;
  if (dependencies.platform !== "darwin")
    throw new Error(
      "AutoDev ChatGPT tunnel installation currently requires macOS"
    );
  ensurePrivateDirectory(directory);
  await withInstallLock(directory, () =>
    reconcile(paths, directory, stateFile, mode, environment, mutation, dependencies)
  );
}

function disable(
  paths: ServicePaths,
  stateFile: string,
  prior: InstalledState | undefined,
  forget: boolean,
  environment: NodeJS.ProcessEnv,
  dependencies: ChatgptTunnelDependencies
): void {
  const launchd = dependencies.launchd();
  privateWrite(
    stateFile,
    JSON.stringify({ version: 1, enabled: false, prior }, null, 2) + "\n"
  );
  launchd.disable(label);
  launchd.bootout(label);
  rmSync(serviceLaunchAgentPath(paths, label), { force: true });
  // Only local credentials are forgotten. Remote revocation belongs to Platform.
  if (forget && prior) dependencies.deleteKey(environment);
  writeLine(
    "AutoDev ChatGPT tunnel disabled; normal installs will not re-enable it. The MCP gateway keeps serving local clients."
  );
}

async function reconcile(
  paths: ServicePaths,
  directory: string,
  stateFile: string,
  mode: ChatgptTunnelMode,
  environment: NodeJS.ProcessEnv,
  mutation: TunnelMutation | undefined,
  dependencies: ChatgptTunnelDependencies
): Promise<void> {
  const state = stateAt(stateFile);
  const prior = installedState(state);
  if (
    mode === "disable" ||
    (mode === "reconcile" && state?.enabled === false)
  ) {
    disable(paths, stateFile, prior, mutation?.action === "forget", environment, dependencies);
    return;
  }
  const gateway = readMcpGatewayState(paths.codexHome);
  if (!gateway)
    throw new Error(
      "The AutoDev MCP gateway is not installed; run pnpm run install:autodev first"
    );
  const launchd = dependencies.launchd();
  const org =
    environment.AUTODEV_CHATGPT_ORGANIZATION_ID?.trim() || prior?.organizationId;
  const workspaceId =
    environment.AUTODEV_CHATGPT_WORKSPACE_ID?.trim() || prior?.workspaceId;
  if (!org || !workspaceId)
    throw new Error(
      "Set AUTODEV_CHATGPT_ORGANIZATION_ID and AUTODEV_CHATGPT_WORKSPACE_ID to verify tunnel scope"
    );
  const adminKey = environment.OPENAI_ADMIN_KEY?.trim() || undefined;
  const rawKey =
    (mutation?.action === "rotate" ? mutation.runtimeKey : undefined) ||
    environment[CHATGPT_TUNNEL_API_KEY_ENV]?.trim() ||
    dependencies.readKey(environment) ||
    "";
  validateRuntimeKey(rawKey, adminKey);

  const binary = dependencies.tunnelBinary(dependencyEnvironment(environment));
  const node = dependencies.node(paths.home);
  const port = servicePort(
    environment[CHATGPT_TUNNEL_PORT_ENV]?.trim() || prior?.port,
    defaultPort,
    CHATGPT_TUNNEL_PORT_ENV
  );
  if (port === gateway.mcpPort)
    throw new Error(
      `${CHATGPT_TUNNEL_PORT_ENV} must differ from the MCP gateway port`
    );
  const servicePath = serviceSearchPath(paths.home, [node, binary]);
  const cleanEnvironment = { HOME: paths.home, PATH: servicePath };
  const runtimeEnvironment = { ...cleanEnvironment, [CHATGPT_TUNNEL_API_KEY_ENV]: rawKey };
  const idFile = path.join(directory, "tunnel-id");
  const existingId =
    environment.CONTROL_PLANE_TUNNEL_ID?.trim() ||
    prior?.tunnelId ||
    privateRead(idFile);
  const id =
    existingId ||
    dependencies.create(
      binary,
      { ...cleanEnvironment, ...(adminKey && { OPENAI_ADMIN_KEY: adminKey }) },
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
    !(await dependencies.wait(
      {
        sleep,
        probe: async () => {
          try {
            observation.metadata = dependencies.metadata(
              binary,
              ["get", id],
              runtimeEnvironment
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
  assertTunnelScope(observation.metadata, id, org, workspaceId);

  if (
    state?.enabled &&
    prior &&
    prior.port === port &&
    prior.tunnelId === id &&
    prior.organizationId === org &&
    prior.workspaceId === workspaceId &&
    prior.binary === binary &&
    prior.node === node &&
    prior.servicePath === servicePath &&
    dependencies.readKey(environment) === rawKey &&
    (await checkChatgptTunnel(paths, dependencies))
  ) {
    writeLine("AutoDev ChatGPT tunnel already ready: " + id);
    return;
  }
  const channels = gatewayChannels(gateway);
  const { headerFile } = mcpGatewayAuthPaths(paths.codexHome);
  const generation = mkdtempSync(path.join(directory, "generation-"));
  chmodSync(generation, 0o700);
  const profile = path.join(generation, "autodev.yaml");
  const stagedFile = path.join(directory, "staged.json");
  const plistFile = serviceLaunchAgentPath(paths, label);
  const previousPlist = existsSync(plistFile)
    ? readFileSync(plistFile, "utf8")
    : "";
  const wasRunning = launchd.isLoaded(label);
  const previousKey = dependencies.readKey(environment);
  const nextState = installedStateSchema.parse({
    generation: path.basename(generation),
    port,
    organizationId: org,
    workspaceId,
    tunnelId: id,
    binary,
    node,
    servicePath
  });
  let isKeyUpdated = false;
  let isStopped = false;
  let isCommitted = false;
  let isRollbackFailed = false;
  let stage = "tunnel-client init";
  try {
    dependencies.run(
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
        channels[0]!.url,
        "--health-listen-addr",
        `127.0.0.1:${port}`
      ],
      { env: cleanEnvironment, timeout: 30_000 }
    );
    privateWrite(
      profile,
      withTunnelProfileChannels(readFileSync(profile, "utf8"), channels)
    );
    chmodSync(profile, 0o600);
    // The gateway is a separate, already-reconciled service: doctor checks
    // the candidate profile against the live gateway the tunnel will reach.
    stage = "tunnel-client doctor";
    dependencies.run(
      binary,
      [
        "doctor",
        "--profile-file",
        profile,
        "--health.listen-addr",
        "127.0.0.1:0",
        ...channels.flatMap((entry) => [
          "--mcp.server-url",
          `url=${entry.url},channel=${entry.channel}`
        ]),
        "--mcp.oauth-discovery=disabled",
        "--explain"
      ],
      {
        env: { ...runtimeEnvironment, ...tunnelClientMcpEnv(headerFile) },
        timeout: 60_000
      }
    );

    stage = "keychain store";
    if (!previousKey || mutation?.action === "rotate") {
      dependencies.writeKey(rawKey, environment);
      if (dependencies.readKey(environment) !== rawKey)
        throw new Error(
          "Keychain verification failed for ChatGPT tunnel credential"
        );
      isKeyUpdated = true;
    }

    const candidatePlist = path.join(generation, label + ".plist");
    renderLaunchAgent(
      serviceTemplatePath(paths, label),
      candidatePlist,
      tunnelLaunchValues(paths, nextState, dependencies.launchValues(paths))
    );

    stage = "launchd stop";
    launchd.bootout(label);
    isStopped = true;
    stage = "readiness port check";
    if (!dependencies.portFree(port))
      throw new Error(
        "Tunnel readiness port is already in use or could not be checked"
      );
    stage = "launchd start";
    privateWrite(stagedFile, JSON.stringify(nextState, null, 2) + "\n");
    privateWrite(plistFile, readFileSync(candidatePlist, "utf8"));
    launchd.enable(label);
    launchd.bootstrap(plistFile);
    stage = "tunnel readiness";
    if (
      !(await dependencies.wait(
        { probe: () => dependencies.ready(launchd, label, port), sleep },
        60_000
      ))
    )
      throw new Error("Tunnel did not become ready");
    privateWrite(
      stateFile,
      JSON.stringify({ version: 1, enabled: true, ...nextState }, null, 2) +
        "\n"
    );
    isCommitted = true;
    writeLine("AutoDev ChatGPT tunnel ready: " + id);
    writeLine(
      "ChatGPT Plugins > Add custom MCP server > Tunnel > AutoDev ChatGPT"
    );
  } catch (error) {
    if (isKeyUpdated) {
      try {
        if (previousKey) dependencies.writeKey(previousKey, environment);
        else dependencies.deleteKey(environment);
      } catch {
        /*
        best effort rollback
        */
      }
    }
    if (isStopped) {
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
        isRollbackFailed = true;
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
    if (!isCommitted && !isRollbackFailed)
      rmSync(generation, { recursive: true, force: true });
  }
  // A previous generation is not needed after the new one is ready.
  if (prior?.generation && prior.generation !== nextState.generation)
    rmSync(path.join(directory, prior.generation), {
      recursive: true,
      force: true
    });
}

/**
Run `tunnel-client` against the live gateway with the Keychain credential.
*/
export async function runChatgptTunnelDaemon(
  paths: ServicePaths,
  environment: NodeJS.ProcessEnv = process.env,
  dependencies: {
    readKey?: (environment: NodeJS.ProcessEnv) => string | null;
    spawnProcess?: typeof spawn;
    waitForGateway?: (mcpPort: number) => Promise<boolean>;
  } = {}
): Promise<number> {
  const directory = tunnelDirectory(paths.codexHome);
  const stagedRaw = privateRead(path.join(directory, "staged.json"));
  const state = stagedRaw
    ? {
        enabled: true as const,
        ...installedStateSchema.parse(JSON.parse(stagedRaw))
      }
    : stateAt(tunnelStateFile(paths.codexHome));
  if (!state?.enabled) {
    process.stderr.write(
      "AutoDev ChatGPT tunnel is disabled or not configured\n"
    );
    return 1;
  }
  const gateway = readMcpGatewayState(paths.codexHome);
  const profile = path.join(
    generationPath(directory, state.generation),
    "autodev.yaml"
  );
  const { headerFile } = mcpGatewayAuthPaths(paths.codexHome);
  if (!gateway || !existsSync(profile) || !privateRead(headerFile)) {
    process.stderr.write(
      "AutoDev ChatGPT tunnel profile or MCP gateway auth files are missing\n"
    );
    return 1;
  }
  const runtimeKey =
    environment[CHATGPT_TUNNEL_API_KEY_ENV]?.trim() ||
    (
      dependencies.readKey ??
      ((environment: NodeJS.ProcessEnv) =>
        readKeychainSecret(CHATGPT_TUNNEL_API_KEY_ENV, environment))
    )(environment);
  if (!runtimeKey) {
    process.stderr.write(
      "AutoDev ChatGPT tunnel runtime key is unavailable in macOS Keychain; rerun scripts/install.sh --enable-chatgpt-tunnel\n"
    );
    return 1;
  }
  if (!(await (dependencies.waitForGateway ?? waitForMcpGateway)(gateway.mcpPort))) {
    process.stderr.write("AutoDev MCP gateway is not ready\n");
    return 1;
  }
  const tunnel = (dependencies.spawnProcess ?? spawn)(
    state.binary,
    ["run", "--profile-file", profile],
    {
      cwd: directory,
      env: {
        HOME: paths.home,
        PATH: state.servicePath,
        MCP_FORWARD_TRACE_CONTEXT: "true",
        ...tunnelClientMcpEnv(headerFile),
        [CHATGPT_TUNNEL_API_KEY_ENV]: runtimeKey
      },
      stdio: "inherit"
    }
  );
  return superviseChild(tunnel, "tunnel-client");
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
      const isSafe =
        error instanceof Error &&
        !("stdout" in error) &&
        !("stderr" in error) &&
        !(error instanceof z.ZodError);
      process.stderr.write(
        (isSafe
          ? error.message
          : "ChatGPT tunnel setup failed; inspect local configuration") + "\n"
      );
      process.exitCode = 1;
    }
  } else throw new Error("Invalid ChatGPT tunnel mode");
}
