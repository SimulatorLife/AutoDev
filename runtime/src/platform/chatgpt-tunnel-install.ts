import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";

import { atomicWriteSync } from "@simulatorlife/autodev-data/files";
import { writeErrorLine, writeLine } from "@simulatorlife/autodev-runtime/shared/output";

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
const healthAddress = "127.0.0.1:3311";

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

function tunnelBinary(): string {
  const installed = resolveCommandOnPath("tunnel-client");
  if (installed) return installed;
  const brew = resolveCommandOnPath("brew");
  if (!brew) throw new Error("Homebrew is required to install the OpenAI tunnel client");
  execFileSync(brew, ["install", "openai/tools/tunnel-client"], { stdio: "inherit" });
  const binary = resolveCommandOnPath("tunnel-client");
  if (!binary) throw new Error("OpenAI tunnel-client was not found after installation");
  return binary;
}

function createTunnel(binary: string, env: NodeJS.ProcessEnv): string {
  const org = env.AUTODEV_CHATGPT_ORGANIZATION_ID;
  const workspace = env.AUTODEV_CHATGPT_WORKSPACE_ID;
  if (!env.OPENAI_ADMIN_KEY || !org || !workspace)
    throw new Error("Supply CONTROL_PLANE_TUNNEL_ID or OPENAI_ADMIN_KEY, AUTODEV_CHATGPT_ORGANIZATION_ID and AUTODEV_CHATGPT_WORKSPACE_ID to create an associated tunnel");
  const result = JSON.parse(execFileSync(binary, [
    "admin", "--json", "tunnels", "create",
    "--name", "AutoDev ChatGPT",
    "--description", "Private AutoDev MCP gateway",
    "--organization-id", org, "--workspace-id", workspace
  ], { env, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })) as { id?: string; tunnel_id?: string };
  const id = result.id ?? result.tunnel_id;
  if (!id) throw new Error("Tunnel creation did not return an ID; inspect Platform before retrying");
  return id;
}

export function ensureChatgptTunnel(paths: Paths, enabled: boolean, env = process.env): void {
  const directory = path.join(paths.codexHome, "chatgpt-tunnel");
  const configFile = path.join(directory, "gateway.json");
  const supergatewayConfig = path.join(directory, "supergateway.json");
  if (!enabled && !existsSync(configFile)) return;
  if (process.platform !== "darwin") throw new Error("AutoDev ChatGPT tunnel installation currently requires macOS");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (!lstatSync(directory).isDirectory()) throw new Error("ChatGPT tunnel directory must not be a symlink");
  chmodSync(directory, 0o700);

  const oldConfig = privateRead(configFile);
  const prior = oldConfig
    ? JSON.parse(oldConfig) as { workspace: string; policyFile?: string }
    : undefined;
  const workspace = validateChatgptWorkspace(
    env.AUTODEV_CHATGPT_MCP_WORKSPACE ?? prior?.workspace ?? paths.repositoryRoot,
    paths.home, paths.codexHome
  );
  const policyFile = path.resolve(
    env.AUTODEV_CHATGPT_MCP_POLICY_FILE ?? prior?.policyFile ??
      path.join(paths.repositoryRoot, "config", "chatgpt-mcp-policy.json")
  );
  const grants: unknown = JSON.parse(readFileSync(policyFile, "utf8"));
  const generated = renderChatgptSupergatewayConfig(
    readBridgeMcpCatalogue(paths.codexHome), grants, workspace
  );

  const keyFile = path.join(directory, "runtime.key");
  const key = env.CONTROL_PLANE_API_KEY?.trim() || privateRead(keyFile);
  if (!key) throw new Error("Set CONTROL_PLANE_API_KEY to a restricted OpenAI runtime key with Tunnels Read + Use (Platform organization API keys)");
  if (/\s/u.test(key)) throw new Error("Invalid tunnel runtime key");
  if (key === env.OPENAI_ADMIN_KEY)
    throw new Error("Do not use the administrator key as a tunnel runtime key");
  const binary = tunnelBinary();
  const supergateway = ensureSupergateway(directory);
  const idFile = path.join(directory, "tunnel-id");
  const id = env.CONTROL_PLANE_TUNNEL_ID?.trim() || privateRead(idFile) || createTunnel(binary, env);
  if (!/^[a-zA-Z0-9_-]+$/u.test(id)) throw new Error("Invalid tunnel ID");
  privateWrite(idFile, id + "\n");
  privateWrite(keyFile, key + "\n");

  const node = resolveServiceNode(paths.home);
  const servicePath = [
    path.dirname(node), path.dirname(binary), path.dirname(supergateway),
    "/opt/homebrew/bin", "/usr/local/bin",
    path.join(paths.home, ".local/bin"), "/usr/bin", "/bin", "/usr/sbin", "/sbin"
  ].join(":");
  const gatewayEnv = chatgptSupergatewayEnvironment(paths, workspace, node, servicePath);
  // Check the exact generated config with the installed version before
  // replacing a live service. Never give the gateway the tunnel/admin key.
  const candidate = supergatewayConfig + ".next";
  privateWrite(candidate, generated);
  try {
    execFileSync(supergateway, ["--config", candidate, "--checkConfig"], {
      cwd: workspace,
      env: gatewayEnv,
      stdio: ["ignore", "inherit", "inherit"]
    });
  } finally {
    rmSync(candidate, { force: true });
  }
  const gatewayCommand = [
    "/usr/bin/env", "-i",
    ...Object.entries(gatewayEnv).map(([name, value]) => name + "=" + value),
    supergateway, "--config", supergatewayConfig
  ].map(shellWord).join(" ");

  const plistFile = path.join(paths.home, "Library", "LaunchAgents", label + ".plist");
  mkdirSync(path.dirname(plistFile), { recursive: true, mode: 0o700 });
  const args = [
    binary, "run",
    "--control-plane.tunnel-id", id,
    "--control-plane.api-key", "file:" + keyFile,
    "--mcp.command", gatewayCommand,
    "--health.listen-addr", healthAddress
  ];
  const serviceEnv = { HOME: paths.home, PATH: servicePath };
  const plist = '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n' +
    '<plist version="1.0"><dict>\n' +
    '<key>Label</key><string>' + label + '</string>\n' +
    '<key>ProgramArguments</key><array>' + args.map((arg) => '<string>' + xml(arg) + '</string>').join("") + '</array>\n' +
    '<key>EnvironmentVariables</key><dict>' + Object.entries(serviceEnv).map(([k,v]) => '<key>' + k + '</key><string>' + xml(v) + '</string>').join("") + '</dict>\n' +
    '<key>WorkingDirectory</key><string>' + xml(workspace) + '</string>\n' +
    '<key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>ThrottleInterval</key><integer>10</integer>\n' +
    '<key>StandardOutPath</key><string>' + xml(path.join(directory, "stdout.log")) + '</string>\n' +
    '<key>StandardErrorPath</key><string>' + xml(path.join(directory, "stderr.log")) + '</string>\n' +
    '</dict></plist>\n';

  const launchd = new LaunchdClient();
  // Stop the old client before changing its config: one active stdio client per tunnel.
  launchd.bootout(label);
  privateWrite(supergatewayConfig, generated);
  privateWrite(configFile, JSON.stringify({ workspace, policyFile }, null, 2) + "\n");
  privateWrite(plistFile, plist);
  launchd.enable(label);
  launchd.bootstrap(plistFile);

  // A running launchd job alone is not proof of tunnel readiness.
  for (let attempt = 0; attempt < 60; attempt++) {
    const probe = spawnSync("/usr/bin/curl", ["-fsS", "--max-time", "1", "http://" + healthAddress + "/readyz"], { stdio: "ignore" });
    if (probe.status === 0 && launchd.isLoaded(label)) {
      writeLine("AutoDev ChatGPT tunnel ready: " + id);
      writeLine("ChatGPT Plugins > Add custom MCP server > Tunnel > AutoDev ChatGPT");
      return;
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1000);
  }
  writeErrorLine("ChatGPT tunnel did not become ready. Check " + path.join(directory, "stderr.log"));
  throw new Error("AutoDev ChatGPT tunnel is not ready");
}
