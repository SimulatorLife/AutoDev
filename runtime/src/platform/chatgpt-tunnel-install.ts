import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";

import { atomicWriteSync } from "@simulatorlife/autodev-data/files";
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
interface TunnelState {
  enabled: boolean;
  workspace?: string;
  policyFile?: string;
  generation?: string;
  port?: number;
  organizationId?: string;
  workspaceId?: string;
  tunnelId?: string;
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

function xml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&apos;");
}

function shellWord(value: string): string {
  return "'" + value.replaceAll("'", "'\\''") + "'";
}

export function tunnelClientSupported(version: string): boolean {
  const match = /(?:^|\s)v?(\d+)\.(\d+)\.(\d+)(?:\s|$)/u.exec(version.trim());
  if (!match) return false;
  const [, major, minor, patch] = match;
  return Number(major) > 0 || Number(minor) > 0 || Number(patch) >= 21;
}

function tunnelBinary(): string {
  let binary = resolveCommandOnPath("tunnel-client");
  const supported = (candidate: string): boolean =>
    tunnelClientSupported(execFileSync(candidate, ["--version"], {
      encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 5000
    }));
  if (binary && supported(binary)) return binary;
  const brew = resolveCommandOnPath("brew");
  if (!brew) throw new Error("Homebrew is required to install OpenAI tunnel-client >= 0.0.21");
  execFileSync(brew, [binary ? "upgrade" : "install", "openai/tools/tunnel-client"], { stdio: "inherit" });
  binary = resolveCommandOnPath("tunnel-client");
  if (!binary || !supported(binary))
    throw new Error("OpenAI tunnel-client >= 0.0.21 is required");
  return binary;
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
  } catch {
    // Do not print a child-process error object containing credentials or output.
    throw new Error(`OpenAI tunnel ${args[0]} failed; verify account authorization, tunnel ID and runtime key in Platform`);
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
  return text ? JSON.parse(text) as TunnelState : undefined;
}

function ready(launchd: LaunchdClient, port: number): boolean {
  try {
    const pid = /^\s*pid = (\d+)$/mu.exec(launchd.print(label))?.[1];
    if (!pid) return false;
    const listeners = execFileSync("/usr/sbin/lsof", [
      "-nP", "-tiTCP:" + port, "-sTCP:LISTEN"
    ], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 3000 })
      .trim().split(/\s+/u);
    return listeners.length === 1 && listeners[0] === pid &&
      spawnSync("/usr/bin/curl", ["-fsS", "--max-time", "1", `http://127.0.0.1:${port}/readyz`], {
        stdio: "ignore"
      }).status === 0;
  } catch {
    return false;
  }
}

export function checkChatgptTunnel(paths: Paths): boolean {
  try {
    const directory = path.join(paths.codexHome, "chatgpt-tunnel");
    const state = stateAt(path.join(directory, "gateway.json"));
    if (!state) return true;
    const launchd = new LaunchdClient();
    if (state.enabled === false) return !launchd.isLoaded(label) &&
      !existsSync(path.join(paths.home, "Library", "LaunchAgents", label + ".plist"));
    return Boolean(state.generation && privateRead(path.join(state.generation, "runtime.key")) &&
      existsSync(path.join(state.generation, "autodev.yaml")) &&
      ready(launchd, healthPort(state.port)));
  } catch {
    return false;
  }
}

export function ensureChatgptTunnel(
  paths: Paths,
  mode: ChatgptTunnelMode,
  env = process.env
): void {
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
    reconcile(paths, directory, stateFile, mode, env);
  } finally {
    rmSync(lock, { recursive: true, force: true });
  }
}

function reconcile(paths: Paths, directory: string, stateFile: string, mode: ChatgptTunnelMode, env: NodeJS.ProcessEnv): void {
  const prior = stateAt(stateFile);
  const launchd = new LaunchdClient();
  if (mode === "disable" || (mode === "reconcile" && prior?.enabled === false)) {
    privateWrite(stateFile, JSON.stringify({ ...prior, enabled: false }, null, 2) + "\n");
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
  const generated = renderChatgptSupergatewayConfig(
    readBridgeMcpCatalogue(paths.codexHome), grants, workspace, reviewed
  );
  const org = env.AUTODEV_CHATGPT_ORGANIZATION_ID ?? prior?.organizationId;
  const workspaceId = env.AUTODEV_CHATGPT_WORKSPACE_ID ?? prior?.workspaceId;
  if (!org || !workspaceId)
    throw new Error("Set AUTODEV_CHATGPT_ORGANIZATION_ID and AUTODEV_CHATGPT_WORKSPACE_ID to verify tunnel scope");
  const rawKey = env.CONTROL_PLANE_API_KEY ??
    (prior?.generation ? privateRead(path.join(prior.generation, "runtime.key")) : privateRead(path.join(directory, "runtime.key")));
  if (!rawKey || /\s/u.test(rawKey) || rawKey === env.OPENAI_ADMIN_KEY || rawKey.startsWith("sk-admin"))
    throw new Error("Supply a restricted runtime API key with Tunnels Read + Use, not an administrator key");

  const binary = tunnelBinary();
  const supergateway = ensureSupergateway(directory);
  const port = healthPort(env.AUTODEV_CHATGPT_TUNNEL_PORT ?? prior?.port);
  const node = resolveServiceNode(paths.home);
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
  // OpenAI documents a 25–30 second propagation delay after creation.
  if (!existingId) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 30_000);
  const metadata = tunnelMetadata(binary, ["get", id], runtimeEnv);
  if ((metadata.id ?? metadata.tunnel_id) !== id ||
      metadata.organization_ids?.length !== 1 || !metadata.organization_ids.includes(org) ||
      metadata.workspace_ids?.length !== 1 || !metadata.workspace_ids.includes(workspaceId))
    throw new Error("Tunnel does not belong to the configured organization and ChatGPT workspace");

  const generation = mkdtempSync(path.join(directory, "generation-"));
  chmodSync(generation, 0o700);
  const config = path.join(generation, "supergateway.json");
  const keyFile = path.join(generation, "runtime.key");
  const profile = path.join(generation, "autodev.yaml");
  const plistFile = path.join(paths.home, "Library", "LaunchAgents", label + ".plist");
  const previousPlist = privateRead(plistFile);
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

    mkdirSync(path.dirname(plistFile), { recursive: true, mode: 0o700 });
    const args = [binary, "run", "--profile-file", profile];
    const plist = '<?xml version="1.0" encoding="UTF-8"?>\n' +
      '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n' +
      '<plist version="1.0"><dict>\n' +
      '<key>Label</key><string>' + label + '</string>\n' +
      '<key>ProgramArguments</key><array>' + args.map((arg) => '<string>' + xml(arg) + '</string>').join("") + '</array>\n' +
      '<key>EnvironmentVariables</key><dict>' + Object.entries(cleanEnv).map(([k,v]) => '<key>' + k + '</key><string>' + xml(v) + '</string>').join("") + '</dict>\n' +
      '<key>WorkingDirectory</key><string>' + xml(workspace) + '</string>\n' +
      '<key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>ThrottleInterval</key><integer>10</integer>\n' +
      '<key>ExitTimeOut</key><integer>15</integer>\n' +
      '<key>StandardOutPath</key><string>' + xml(path.join(directory, "stdout.log")) + '</string>\n' +
      '<key>StandardErrorPath</key><string>' + xml(path.join(directory, "stderr.log")) + '</string>\n' +
      '</dict></plist>\n';

    launchd.bootout(label);
    stopped = true;
    const listeners = spawnSync("/usr/sbin/lsof", ["-nP", "-tiTCP:" + port, "-sTCP:LISTEN"], { encoding: "utf8" });
    if (listeners.status === 0 || listeners.status !== 1 || listeners.stderr?.trim())
      throw new Error("Tunnel readiness port is already in use or could not be checked");
    privateWrite(plistFile, plist);
    launchd.enable(label);
    launchd.bootstrap(plistFile);
    for (let attempt = 0; attempt < 60; attempt++) {
      if (ready(launchd, port)) {
        privateWrite(stateFile, JSON.stringify({
          enabled: true, workspace, policyFile, generation, port,
          organizationId: org, workspaceId, tunnelId: id
        }, null, 2) + "\n");
        committed = true;
        writeLine("AutoDev ChatGPT tunnel ready: " + id);
        writeLine("ChatGPT Plugins > Add custom MCP server > Tunnel > AutoDev ChatGPT");
        break;
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1000);
    }
    if (!committed) throw new Error("Tunnel did not become ready");
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
  if (prior?.generation && prior.generation !== generation &&
      path.dirname(prior.generation) === directory &&
      path.basename(prior.generation).startsWith("generation-"))
    rmSync(prior.generation, { recursive: true, force: true });
}
