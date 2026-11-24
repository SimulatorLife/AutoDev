import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";

import { atomicWriteSync } from "@simulatorlife/autodev-data/files";
import { z } from "zod";
import { isEntryPoint } from "../shared/entry-point.ts";
import { httpHealthProbe } from "./health-probe.ts";
import { waitForProbe } from "./wait-for-probe.ts";
import { sleep } from "./sleep.ts";
import { launchAgentMatches, renderLaunchAgent, resolveLaunchAgentValues, type LaunchAgentValues } from "./macos/launchagent.ts";
import { parseCliVersion } from "../providers/cli-versions.ts";
import { writeLine } from "@simulatorlife/autodev-runtime/shared/output";

import { readBridgeMcpCatalogue } from "../mcp/filesystem-server.ts";
import {
  chatgptSupergatewayEnvironment,
  renderChatgptSupergatewayConfig,
  validateChatgptWorkspace
} from "../config/render-chatgpt-supergateway.ts";
import { ensureSupergateway } from "./supergateway-install.ts";
import { resolveServiceNode } from "./host-arch.ts";
import { LaunchdClient } from "./macos/launchd.ts";
import { resolveCommandOnPath } from "./runtime-files.ts";

const label = "com.codex.autodev-chatgpt-tunnel";
const defaultPort = 3311;
export type ChatgptTunnelMode = "reconcile" | "enable" | "disable";
const installedStateSchema = z.object({
  workspace: z.string().refine(path.isAbsolute),
  policyFile: z.string().refine(path.isAbsolute),
  generation: z.string().regex(/^generation-[a-zA-Z0-9_-]+$/u),
  port: z.number().int().min(1024).max(65535),
  organizationId: z.string().min(1),
  workspaceId: z.string().min(1),
  tunnelId: z.string().regex(/^tunnel_[a-zA-Z0-9_-]+$/u),
  binary: z.string().refine(path.isAbsolute),
  servicePath: z.string().min(1),
  node: z.string().refine(path.isAbsolute),
  supergateway: z.string().refine(path.isAbsolute)
}).strict();
const stateSchema = z.discriminatedUnion("enabled", [
  installedStateSchema.extend({ version: z.literal(1), enabled: z.literal(true) }),
  z.object({ version: z.literal(1), enabled: z.literal(false), prior: installedStateSchema.optional() }).strict()
]);
type TunnelState = z.infer<typeof stateSchema>;
type InstalledState = z.infer<typeof installedStateSchema>;
function installedState(state: TunnelState | undefined): InstalledState | undefined {
  if (!state) return undefined;
  if (!state.enabled) return state.prior;
  const { enabled: _enabled, version: _version, ...installed } = state;
  return installed;
}
function generationPath(directory: string, generation: string): string {
  const target = path.join(directory, generation);
  if (!lstatSync(target).isDirectory()) throw new Error("Invalid tunnel generation directory");
  return target;
}
export function dependencyEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const keys = ["HOME", "PATH", "USER", "LOGNAME", "TMPDIR", "LANG", "LC_ALL", "PNPM_HOME", "HOMEBREW_PREFIX", "HOMEBREW_CELLAR", "HOMEBREW_REPOSITORY"];
  return Object.fromEntries(keys.flatMap((key) => env[key] === undefined ? [] : [[key, env[key]]]));
}

interface Paths {
  repositoryRoot: string;
  home: string;
  codexHome: string;
}

function privateWrite(file: string, content: string): void {
  if (existsSync(file) && !lstatSync(file).isFile())
    throw new Error("Refusing non-regular ChatGPT tunnel file: " + file);
  atomicWriteSync(file, content, { mode: 0o600, skipUnchanged: true });
  chmodSync(file, 0o600);
}

function privateRead(file: string): string {
  if (!existsSync(file)) return "";
  const stat = lstatSync(file);
  if (!stat.isFile() || (stat.mode & 0o077) !== 0)
    throw new Error("ChatGPT tunnel file must be a private regular file: " + file);
  return readFileSync(file, "utf8").trim();
}

function shellWord(value: string): string {
  return "'" + value.replaceAll("'", "'\\''") + "'";
}

export function tunnelClientSupported(version: string): boolean {
  const parsed = parseCliVersion(version);
  if (!parsed || !/^\d+\.\d+\.\d+$/u.test(parsed)) return false;
  const [major = 0, minor = 0, patch = 0] = parsed.split(".").map(Number);
  return major > 0 || minor > 0 || patch >= 21;
}

function tunnelBinary(env: NodeJS.ProcessEnv): string {
  let binary = resolveCommandOnPath("tunnel-client");
  const supported = (candidate: string): boolean =>
    tunnelClientSupported(execFileSync(candidate, ["--version"], {
      env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 5000
    }));
  if (binary && supported(binary)) return binary;
  const brew = resolveCommandOnPath("brew");
  if (!brew) throw new Error("Homebrew is required to install OpenAI tunnel-client >= 0.0.21");
  execFileSync(brew, [binary ? "upgrade" : "install", "openai/tools/tunnel-client"], { env, stdio: "inherit" });
  binary = resolveCommandOnPath("tunnel-client");
  if (!binary || !supported(binary))
    throw new Error("OpenAI tunnel-client >= 0.0.21 is required");
  return binary;
}

class TunnelMetadataError extends Error {
  constructor(message: string, readonly transient: boolean) { super(message); }
}

function tunnelMetadata(
  binary: string,
  args: string[],
  env: NodeJS.ProcessEnv
): { id?: string; tunnel_id?: string; organization_ids?: string[]; workspace_ids?: string[] } {
  try {
    return JSON.parse(execFileSync(binary, ["admin", "--json", "tunnels", ...args], {
      env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 45_000
    }));
  } catch (error) {
    // Inspect only the category; never expose the original output or argv.
    const stderr = String((error as { stderr?: unknown }).stderr ?? "");
    const transient = /(?:HTTP|status(?: code)?)\s*[:=]?\s*404\b/iu.test(stderr);
    throw new TunnelMetadataError(`OpenAI tunnel ${args[0]} failed; verify account authorization, tunnel ID and runtime key in Platform`, transient);
  }
}

function createTunnel(binary: string, env: NodeJS.ProcessEnv, org: string, workspace: string): string {
  if (!env.OPENAI_ADMIN_KEY)
    throw new Error("Supply an existing CONTROL_PLANE_TUNNEL_ID or an OPENAI_ADMIN_KEY to create a tunnel");
  const result = tunnelMetadata(binary, [
    "create", "--name", "AutoDev ChatGPT",
    "--description", "Private AutoDev MCP gateway",
    "--organization-id", org, "--workspace-id", workspace
  ], env);
  const id = result.id ?? result.tunnel_id;
  if (!id) throw new Error("Tunnel creation did not return an ID; inspect Platform before retrying");
  return id;
}

function healthPort(value: string | number | undefined): number {
  const port = Number(value ?? defaultPort);
  if (!Number.isInteger(port) || port < 1024 || port > 65535)
    throw new Error("AUTODEV_CHATGPT_TUNNEL_PORT must be an integer from 1024 to 65535");
  return port;
}

function stateAt(file: string): TunnelState | undefined {
  const text = privateRead(file);
  return text ? stateSchema.parse(JSON.parse(text)) : undefined;
}

async function ready(launchd: LaunchdClient, port: number): Promise<boolean> {
  try {
    const pid = /^\s*pid = (\d+)$/mu.exec(launchd.print(label))?.[1];
    if (!pid) return false;
    const listeners = execFileSync("/usr/sbin/lsof", [
      "-nP", "-tiTCP:" + port, "-sTCP:LISTEN"
    ], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 3000 })
      .trim().split(/\s+/u);
    return listeners.length === 1 && listeners[0] === pid &&
      await httpHealthProbe(`http://127.0.0.1:${port}/readyz`)();
  } catch {
    return false;
  }
}

export async function checkChatgptTunnel(paths: Paths): Promise<boolean> {
  try {
    const directory = path.join(paths.codexHome, "chatgpt-tunnel");
    const state = stateAt(path.join(directory, "gateway.json"));
    if (!state) return true;
    const launchd = new LaunchdClient();
    if (state.enabled === false) return !launchd.isLoaded(label) &&
      !existsSync(path.join(paths.home, "Library", "LaunchAgents", label + ".plist"));
    const generation = generationPath(directory, state.generation);
    const plist = path.join(paths.home, "Library", "LaunchAgents", label + ".plist");
    return Boolean(privateRead(path.join(generation, "runtime.key")) &&
      existsSync(path.join(generation, "autodev.yaml")) &&
      launchAgentMatches(templatePath(paths), plist, tunnelLaunchValues(paths, state, generation)) &&
      await ready(launchd, healthPort(state.port)));
  } catch {
    return false;
  }
}

export async function ensureChatgptTunnel(
  paths: Paths,
  mode: ChatgptTunnelMode,
  env = process.env
): Promise<void> {
  const directory = path.join(paths.codexHome, "chatgpt-tunnel");
  const stateFile = path.join(directory, "gateway.json");
  if (mode === "reconcile" && !existsSync(stateFile)) return;
  if (process.platform !== "darwin") throw new Error("AutoDev ChatGPT tunnel installation currently requires macOS");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (!lstatSync(directory).isDirectory()) throw new Error("ChatGPT tunnel directory must not be a symlink");
  chmodSync(directory, 0o700);
  const lock = path.join(directory, "install.lock");
  try {
    mkdirSync(lock, { mode: 0o700 });
  } catch {
    throw new Error("ChatGPT tunnel install is locked; check for another installer before removing install.lock");
  }
  try {
    await reconcile(paths, directory, stateFile, mode, env);
  } finally {
    rmSync(lock, { recursive: true, force: true });
  }
}

async function reconcile(paths: Paths, directory: string, stateFile: string, mode: ChatgptTunnelMode, env: NodeJS.ProcessEnv): Promise<void> {
  const state = stateAt(stateFile);
  const prior = installedState(state);
  const launchd = new LaunchdClient();
  if (mode === "disable" || (mode === "reconcile" && state?.enabled === false)) {
    privateWrite(stateFile, JSON.stringify({ version: 1, enabled: false, prior }, null, 2) + "\n");
    launchd.bootout(label);
    rmSync(path.join(paths.home, "Library", "LaunchAgents", label + ".plist"), { force: true });
    writeLine("AutoDev ChatGPT tunnel disabled; normal installs will not re-enable it.");
    return;
  }

  const workspace = validateChatgptWorkspace(
    env.AUTODEV_CHATGPT_MCP_WORKSPACE ?? prior?.workspace ?? paths.repositoryRoot,
    paths.home, paths.codexHome
  );
  const reviewedFile = path.join(paths.repositoryRoot, "config", "chatgpt-mcp-policy.json");
  const policyFile = path.resolve(env.AUTODEV_CHATGPT_MCP_POLICY_FILE ?? prior?.policyFile ?? reviewedFile);
  const reviewed: unknown = JSON.parse(readFileSync(reviewedFile, "utf8"));
  const grants: unknown = JSON.parse(readFileSync(policyFile, "utf8"));
  const node = resolveServiceNode(paths.home);
  const generated = renderChatgptSupergatewayConfig(
    readBridgeMcpCatalogue(paths.codexHome), grants, workspace, reviewed,
    { command: node, script: path.join(paths.codexHome, "src/mcp/tool-filter.ts") }
  );
  const org = env.AUTODEV_CHATGPT_ORGANIZATION_ID ?? prior?.organizationId;
  const workspaceId = env.AUTODEV_CHATGPT_WORKSPACE_ID ?? prior?.workspaceId;
  if (!org || !workspaceId)
    throw new Error("Set AUTODEV_CHATGPT_ORGANIZATION_ID and AUTODEV_CHATGPT_WORKSPACE_ID to verify tunnel scope");
  const rawKey = env.CONTROL_PLANE_API_KEY ??
    (prior?.generation ? privateRead(path.join(generationPath(directory, prior.generation), "runtime.key")) : privateRead(path.join(directory, "runtime.key")));
  if (!rawKey || /\s/u.test(rawKey) || rawKey === env.OPENAI_ADMIN_KEY || rawKey.startsWith("sk-admin"))
    throw new Error("Supply a restricted runtime API key with Tunnels Read + Use, not an administrator key");

  const dependencyEnv = dependencyEnvironment(env);
  const binary = tunnelBinary(dependencyEnv);
  const supergateway = ensureSupergateway(directory, dependencyEnv);
  const port = healthPort(env.AUTODEV_CHATGPT_TUNNEL_PORT ?? prior?.port);
  const servicePath = [
    path.dirname(node), path.dirname(binary), path.dirname(supergateway),
    "/opt/homebrew/bin", "/usr/local/bin",
    path.join(paths.home, ".local/bin"), "/usr/bin", "/bin", "/usr/sbin", "/sbin"
  ].join(":");
  const cleanEnv = { HOME: paths.home, PATH: servicePath };
  const gatewayEnv = chatgptSupergatewayEnvironment(paths, workspace, node, servicePath);
  const runtimeEnv = { ...cleanEnv, CONTROL_PLANE_API_KEY: rawKey };
  const idFile = path.join(directory, "tunnel-id");
  const existingId = env.CONTROL_PLANE_TUNNEL_ID?.trim() || prior?.tunnelId || privateRead(idFile);
  const id = existingId || createTunnel(binary, { ...cleanEnv, OPENAI_ADMIN_KEY: env.OPENAI_ADMIN_KEY }, org, workspaceId);
  if (!/^tunnel_[a-zA-Z0-9_-]+$/u.test(id)) throw new Error("Invalid tunnel ID");
  // Save newly created remote identity before further steps; never overwrite
  // a working tunnel ID with an unverified user-supplied replacement.
  if (!existsSync(idFile) && !env.CONTROL_PLANE_TUNNEL_ID) privateWrite(idFile, id + "\n");
  // Newly created metadata can take up to 30 seconds to propagate. Retry
  // only explicit transient not-found responses, not permission failures.
  const observation: { metadata?: ReturnType<typeof tunnelMetadata> } = {};
  if (!await waitForProbe({
    sleep,
    probe: async () => {
      try {
        observation.metadata = tunnelMetadata(binary, ["get", id], runtimeEnv);
        return true;
      } catch (error) {
        if (!existingId && error instanceof TunnelMetadataError && error.transient) return false;
        throw error;
      }
    }
  }, 45_000) || !observation.metadata) throw new Error("New tunnel metadata did not become available");
  const metadata = observation.metadata;
  if ((metadata.id ?? metadata.tunnel_id) !== id ||
      metadata.organization_ids?.length !== 1 || !metadata.organization_ids.includes(org) ||
      metadata.workspace_ids?.length !== 1 || !metadata.workspace_ids.includes(workspaceId))
    throw new Error("Tunnel does not belong to the configured organization and ChatGPT workspace");

  if (state?.enabled && prior &&
      prior.workspace === workspace && prior.policyFile === policyFile &&
      prior.port === port && prior.tunnelId === id &&
      prior.organizationId === org && prior.workspaceId === workspaceId &&
      prior.binary === binary && prior.node === node && prior.supergateway === supergateway &&
      prior.servicePath === servicePath) {
    const active = generationPath(directory, prior.generation);
    if (privateRead(path.join(active, "runtime.key")) === rawKey &&
        privateRead(path.join(active, "supergateway.json")) === generated.trim() &&
        await checkChatgptTunnel(paths)) {
      writeLine("AutoDev ChatGPT tunnel already ready: " + id);
      return;
    }
  }
  const generation = mkdtempSync(path.join(directory, "generation-"));
  chmodSync(generation, 0o700);
  const config = path.join(generation, "supergateway.json");
  const keyFile = path.join(generation, "runtime.key");
  const profile = path.join(generation, "autodev.yaml");
  const plistFile = path.join(paths.home, "Library", "LaunchAgents", label + ".plist");
  const previousPlist = existsSync(plistFile) ? readFileSync(plistFile, "utf8") : "";
  const wasRunning = launchd.isLoaded(label);
  let stopped = false;
  let committed = false;
  try {
    privateWrite(config, generated);
    privateWrite(keyFile, rawKey + "\n");
    execFileSync(supergateway, ["--config", config, "--checkConfig"], {
      cwd: workspace, env: gatewayEnv, stdio: ["ignore", "inherit", "inherit"], timeout: 30_000
    });
    execFileSync(node, [
      path.join(paths.codexHome, "src/mcp/chatgpt-supergateway-probe.ts"),
      supergateway, config
    ], { cwd: workspace, env: gatewayEnv, stdio: ["ignore", "inherit", "inherit"], timeout: 60_000 });
    const gatewayCommand = [
      "/usr/bin/env", "-i",
      ...Object.entries(gatewayEnv).map(([name, value]) => name + "=" + value),
      supergateway, "--config", config
    ].map(shellWord).join(" ");
    execFileSync(binary, [
      "init", "--sample", "sample_mcp_stdio_local", "--profile", "autodev",
      "--profile-dir", generation, "--tunnel-id", id,
      "--control-plane-api-key-ref", "file:" + keyFile,
      "--mcp-command", gatewayCommand,
      "--health-listen-addr", `127.0.0.1:${port}`
    ], { env: cleanEnv, stdio: ["ignore", "pipe", "pipe"], timeout: 30_000 });
    chmodSync(profile, 0o600);
    // The prior service may own the desired port. Doctor can validate the
    // candidate using an ephemeral health port without interrupting it.
    execFileSync(binary, ["doctor", "--profile-file", profile, "--health.listen-addr", "127.0.0.1:0", "--explain"], {
      env: cleanEnv, stdio: ["ignore", "pipe", "pipe"], timeout: 60_000
    });

    const nextState = installedStateSchema.parse({
      workspace, policyFile, generation: path.basename(generation), port,
      organizationId: org, workspaceId, tunnelId: id, binary, node, supergateway, servicePath
    });
    const candidatePlist = path.join(generation, label + ".plist");
    renderLaunchAgent(templatePath(paths), candidatePlist, tunnelLaunchValues(paths, nextState, generation));

    launchd.bootout(label);
    stopped = true;
    const listeners = spawnSync("/usr/sbin/lsof", ["-nP", "-tiTCP:" + port, "-sTCP:LISTEN"], { encoding: "utf8" });
    if (listeners.status === 0 || listeners.status !== 1 || listeners.stderr?.trim())
      throw new Error("Tunnel readiness port is already in use or could not be checked");
    privateWrite(plistFile, readFileSync(candidatePlist, "utf8"));
    launchd.enable(label);
    launchd.bootstrap(plistFile);
    if (!await waitForProbe({ probe: () => ready(launchd, port), sleep }, 60_000))
      throw new Error("Tunnel did not become ready");
    privateWrite(stateFile, JSON.stringify({ version: 1, enabled: true, ...nextState }, null, 2) + "\n");
    committed = true;
    writeLine("AutoDev ChatGPT tunnel ready: " + id);
    writeLine("ChatGPT Plugins > Add custom MCP server > Tunnel > AutoDev ChatGPT");
  } catch {
    if (stopped) {
      launchd.bootout(label);
      if (previousPlist) {
        privateWrite(plistFile, previousPlist + "\n");
        if (wasRunning) launchd.bootstrap(plistFile);
      } else {
        rmSync(plistFile, { force: true });
      }
    }
    throw new Error("ChatGPT tunnel setup failed; previous service configuration retained. Check tunnel diagnostics and " + path.join(directory, "stderr.log"));
  } finally {
    if (!committed) rmSync(generation, { recursive: true, force: true });
  }
  // A previous generation is not needed after the new one is ready. Retain
  // only the active runtime credential; never remove an arbitrary state path.
  if (prior?.generation && prior.generation !== path.basename(generation)) {
    const old = path.join(directory, prior.generation);
    if (existsSync(old) && lstatSync(old).isDirectory())
      rmSync(old, { recursive: true, force: true });
  }
}

function templatePath(paths: Paths): string {
  return path.join(paths.repositoryRoot, "config", "launchagents", label + ".plist");
}
function tunnelLaunchValues(paths: Paths, state: InstalledState, generation: string): LaunchAgentValues {
  return {
    ...resolveLaunchAgentValues(paths),
    tunnel: {
      binary: state.binary,
      profile: path.join(generation, "autodev.yaml"),
      workspace: state.workspace,
      servicePath: state.servicePath,
      logDirectory: path.join(paths.codexHome, "chatgpt-tunnel")
    }
  };
}
if (isEntryPoint(import.meta.url)) {
  const [mode, repositoryRoot, home, codexHome] = process.argv.slice(2);
  if (!repositoryRoot || !home || !codexHome)
    throw new Error("Expected tunnel mode and install paths");
  const paths = { repositoryRoot, home, codexHome };
  if (mode === "check") {
    process.exitCode = await checkChatgptTunnel(paths) ? 0 : 1;
  } else if (mode === "reconcile" || mode === "enable" || mode === "disable") {
    try {
      await ensureChatgptTunnel(paths, mode);
    } catch (error) {
      process.stderr.write((error instanceof Error ? error.message : "ChatGPT tunnel setup failed") + "\n");
      process.exitCode = 1;
    }
  } else throw new Error("Invalid ChatGPT tunnel mode");
}
