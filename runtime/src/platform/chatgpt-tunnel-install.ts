import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
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
import path from "node:path";

import { atomicWriteSync } from "@simulatorlife/autodev-data/files";
import { z } from "zod";
import { isEntryPoint } from "../shared/entry-point.ts";
import {
  deleteKeychainSecret,
  readKeychainSecret,
  secureDeleteFile,
  writeKeychainSecret
} from "../shared/runtime-secrets.ts";
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
import { externalFilesystemBackend } from "../mcp/chatgpt-filesystem-sandbox.ts";
import {
  chatgptGrantsSchema,
  chatgptSupergatewayEnvironment,
  renderChatgptSupergatewayConfig,
  validateChatgptWorkspace
} from "../config/render-chatgpt-supergateway.ts";

import { resolveServiceNode } from "./host-arch.ts";
import { homebrewInvocation } from "./dependencies.ts";
import { LaunchdClient } from "./macos/launchd.ts";
import { resolveCommandOnPath } from "./runtime-files.ts";

const label = "com.codex.autodev-chatgpt-tunnel";
const defaultPort = 3311;
export const CHATGPT_TUNNEL_API_KEY_ENV = "AUTODEV_CHATGPT_TUNNEL_API_KEY";
const CHATGPT_TUNNEL_API_KEY_REF = `env:${CHATGPT_TUNNEL_API_KEY_ENV}`;
export type ChatgptTunnelMode = "reconcile" | "enable" | "disable";
const installedStateSchema = z
  .object({
    workspace: z.string().refine(path.isAbsolute),
    policyFile: z.string().refine(path.isAbsolute),
    grants: chatgptGrantsSchema,
    generation: z.string().regex(/^generation-[a-zA-Z0-9_-]+$/u),
    port: z.number().int().min(1024).max(65535),
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

export function shellWord(value: string): string {
  return "'" + value.replaceAll("'", "'\\''") + "'";
}

export function gatewayStdioCommand(
  executable: string,
  config: string,
  env: Record<string, string>
): string {
  return [
    "/usr/bin/env",
    "-i",
    ...Object.entries(env).map(([name, value]) => name + "=" + value),
    executable,
    "--config",
    config
  ]
    .map(shellWord)
    .join(" ");
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
  if (!parsed || !/^\d+\.\d+\.\d+$/u.test(parsed)) return false;
  const [major = 0, minor = 0, patch = 0] = parsed.split(".").map(Number);
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

function reviewedPolicy(paths: Paths) {
  return chatgptGrantsSchema.parse(
    JSON.parse(
      readFileSync(
        path.join(paths.repositoryRoot, "config", "chatgpt-mcp-policy.json"),
        "utf8"
      )
    )
  );
}
function stateRevision(file: string, reviewed: unknown): string {
  return createHash("sha256")
    .update(privateRead(file))
    .update(JSON.stringify(reviewed))
    .digest("hex");
}

function stateAt(file: string): TunnelState | undefined {
  const text = privateRead(file);
  return text ? stateSchema.parse(JSON.parse(text)) : undefined;
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
  }
): Promise<boolean> {
  try {
    const pid = /^\s*pid = (\d+)$/mu.exec(launchd.print(label))?.[1];
    if (!pid) return false;
    const listeners = deps.listeners(port);
    if (listeners.length !== 1 || !listeners[0]) return false;
    const owned =
      listeners[0] === pid || deps.parentPid?.(listeners[0]) === pid;
    return owned && (await deps.probe(port));
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
    const key =
      process.env[CHATGPT_TUNNEL_API_KEY_ENV]?.trim() ||
      deps.readKey(process.env);
    return Boolean(
      key &&
      legacyRuntimeKeyPaths(directory, state).length === 0 &&
      profileText.includes(CHATGPT_TUNNEL_API_KEY_REF) &&
      !profileText.includes("file:") &&
      privateRead(path.join(generation, "supergateway.json")) &&
      launchAgentMatches(
        templatePath(paths),
        plist,
        tunnelLaunchValues(paths, state, deps.launchValues(paths))
      ) &&
      (await deps.ready(launchd, healthPort(state.port)))
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
  const reviewed = reviewedPolicy(paths);
  return {
    schema: "autodev-chatgpt-tunnel-v1",
    revision: stateRevision(stateFile, reviewed),
    configured: prior !== undefined,
    enabled: state?.enabled === true,
    ready: state?.enabled === true && (await checkChatgptTunnel(paths, deps)),
    workspace: prior?.workspace ?? null,
    tunnelId: prior?.tunnelId ?? null,
    reviewed,
    grants: prior?.grants ?? reviewed
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
  backend: typeof externalFilesystemBackend;
  launchValues(paths: Paths): LaunchAgentValues;
  metadata: typeof tunnelMetadata;
  create: typeof createTunnel;
  ready(job: TunnelLaunchd, port: number): Promise<boolean>;
  portFree(port: number): boolean;
  wait: typeof waitForProbe;
  run(
    command: string,
    args: string[],
    options: { env: NodeJS.ProcessEnv; cwd?: string; timeout: number }
  ): void;
  readKey(env: NodeJS.ProcessEnv): string | null;
  writeKey(key: string, env: NodeJS.ProcessEnv): void;
  deleteKey(env: NodeJS.ProcessEnv): boolean;
}

function defaultTunnelDependencies(): ChatgptTunnelDependencies {
  return {
    platform: process.platform,
    launchd: () => new LaunchdClient(),
    node: resolveServiceNode,
    tunnelBinary,
    supergateway: resolveSupergateway,
    backend: externalFilesystemBackend,
    launchValues: resolveLaunchAgentValues,
    metadata: tunnelMetadata,
    create: createTunnel,
    ready,
    portFree: (port) => {
      const result = spawnSync(
        "/usr/sbin/lsof",
        ["-nP", "-tiTCP:" + port, "-sTCP:LISTEN"],
        { encoding: "utf8" }
      );
      return result.status === 1 && !result.stderr?.trim();
    },
    wait: waitForProbe,
    run: (command, args, options) => {
      execFileSync(command, args, {
        ...options,
        stdio: ["ignore", "pipe", "pipe"]
      });
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
      if (!installedState(stateAt(stateFile)))
        throw new Error("Complete initial installation first");
      if (
        stateRevision(stateFile, reviewedPolicy(paths)) !==
        mutation.expectedRevision
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
        validateRuntimeKey(
          legacyKey,
          env.OPENAI_ADMIN_KEY?.trim() || undefined
        );
        deps.writeKey(legacyKey, env);
        if (deps.readKey(env) === legacyKey) {
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
  const reviewedFile = path.join(
    paths.repositoryRoot,
    "config",
    "chatgpt-mcp-policy.json"
  );
  const policyOverride = env.AUTODEV_CHATGPT_MCP_POLICY_FILE?.trim();
  const policyFile = path.resolve(
    policyOverride || prior?.policyFile || reviewedFile
  );
  const reviewed = reviewedPolicy(paths);
  const grants = chatgptGrantsSchema.parse(
    mutation?.action === "configure"
      ? mutation.grants
      : policyOverride || !prior
        ? JSON.parse(readFileSync(policyFile, "utf8"))
        : prior.grants
  );
  const node = deps.node(paths.home);
  const generated = renderChatgptSupergatewayConfig(
    readBridgeMcpCatalogue(paths.codexHome),
    grants,
    workspace,
    reviewed,
    {
      command: node,
      script: path.join(paths.codexHome, "src/mcp/tool-filter.ts")
    },
    (server) => deps.backend(server, paths.repositoryRoot, workspace, node)
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
    servicePath
  );
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
    prior.policyFile === policyFile &&
    prior.port === port &&
    prior.tunnelId === id &&
    prior.organizationId === org &&
    prior.workspaceId === workspaceId &&
    prior.binary === binary &&
    prior.node === node &&
    prior.supergateway === supergateway &&
    prior.servicePath === servicePath
  ) {
    const active = generationPath(directory, prior.generation);
    if (
      deps.readKey(env) === rawKey &&
      privateRead(path.join(active, "supergateway.json")) ===
        generated.trim() &&
      (await checkChatgptTunnel(paths, deps))
    ) {
      writeLine("AutoDev ChatGPT tunnel already ready: " + id);
      return;
    }
  }
  const generation = mkdtempSync(path.join(directory, "generation-"));
  chmodSync(generation, 0o700);
  const config = path.join(generation, "supergateway.json");
  const profile = path.join(generation, "autodev.yaml");
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
    privateWrite(config, generated);
    stage = "supergateway config check";
    deps.run(supergateway, ["--config", config, "--checkConfig"], {
      cwd: workspace,
      env: gatewayEnv,
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
    const gatewayCommand = gatewayStdioCommand(
      supergateway,
      config,
      gatewayEnv
    );
    stage = "tunnel-client init";
    deps.run(
      binary,
      [
        "init",
        "--sample",
        "sample_mcp_stdio_local",
        "--profile",
        "autodev",
        "--profile-dir",
        generation,
        "--tunnel-id",
        id,
        "--control-plane-api-key-ref",
        CHATGPT_TUNNEL_API_KEY_REF,
        "--mcp-command",
        gatewayCommand,
        "--health-listen-addr",
        `127.0.0.1:${port}`
      ],
      { env: cleanEnv, timeout: 30_000 }
    );
    chmodSync(profile, 0o600);
    // The prior service may own the desired port. Doctor can validate the
    // candidate using an ephemeral health port without interrupting it.
    stage = "tunnel-client doctor";
    deps.run(
      binary,
      [
        "doctor",
        "--profile-file",
        profile,
        "--health.listen-addr",
        "127.0.0.1:0",
        "--explain"
      ],
      {
        env: runtimeEnv,
        timeout: 60_000
      }
    );

    stage = "keychain store";
    if (previousKey !== rawKey) {
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
      policyFile,
      grants,
      generation: path.basename(generation),
      port,
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
    if (!deps.portFree(port))
      throw new Error(
        "Tunnel readiness port is already in use or could not be checked"
      );
    stage = "launchd start";
    privateWrite(plistFile, readFileSync(candidatePlist, "utf8"));
    launchd.enable(label);
    launchd.bootstrap(plistFile);
    stage = "tunnel readiness";
    if (
      !(await deps.wait(
        { probe: () => deps.ready(launchd, port), sleep },
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
    // Only remove legacy plaintext credential files after the Keychain-backed
    // service is verified ready and gateway.json is committed.
    securelyRemoveLegacyRuntimeKeys(directory, prior);
    writeLine("AutoDev ChatGPT tunnel ready: " + id);
    writeLine(
      "ChatGPT Plugins > Add custom MCP server > Tunnel > AutoDev ChatGPT"
    );
  } catch {
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
      `ChatGPT tunnel setup failed (${stage}); previous service configuration retained. Check tunnel diagnostics and ${path.join(directory, "stderr.log")}`
    );
  } finally {
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

/** Launch the supervised tunnel-client with the runtime credential injected from Keychain. */
export async function runChatgptTunnelDaemon(
  paths: Paths,
  env: NodeJS.ProcessEnv = process.env,
  deps: {
    readKey?: (environment: NodeJS.ProcessEnv) => string | null;
    spawnProcess?: typeof spawn;
  } = {}
): Promise<number> {
  const directory = path.join(paths.codexHome, "chatgpt-tunnel");
  const state = stateAt(path.join(directory, "gateway.json"));
  if (!state?.enabled) {
    process.stderr.write(
      "AutoDev ChatGPT tunnel is disabled or not configured\n"
    );
    return 1;
  }
  const generation = generationPath(directory, state.generation);
  const profile = path.join(generation, "autodev.yaml");
  if (!existsSync(profile)) {
    process.stderr.write("AutoDev ChatGPT tunnel profile is missing\n");
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
  const child = spawnProcess(state.binary, ["run", "--profile-file", profile], {
    cwd: state.workspace,
    env: {
      HOME: paths.home,
      PATH: state.servicePath,
      MCP_FORWARD_TRACE_CONTEXT: "true",
      [CHATGPT_TUNNEL_API_KEY_ENV]: runtimeKey
    },
    stdio: "inherit"
  });
  return await new Promise<number>((resolve) => {
    const forward = (signal: NodeJS.Signals): void => {
      if (child.exitCode === null && !child.killed) {
        child.kill(signal);
      }
    };
    const onSigterm = (): void => forward("SIGTERM");
    const onSigint = (): void => forward("SIGINT");
    process.once("SIGTERM", onSigterm);
    process.once("SIGINT", onSigint);
    child.once("error", () => {
      process.removeListener("SIGTERM", onSigterm);
      process.removeListener("SIGINT", onSigint);
      process.stderr.write("Failed to start tunnel-client daemon\n");
      resolve(1);
    });
    child.once("exit", (code, signal) => {
      process.removeListener("SIGTERM", onSigterm);
      process.removeListener("SIGINT", onSigint);
      resolve(code ?? (signal ? 1 : 0));
    });
  });
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
