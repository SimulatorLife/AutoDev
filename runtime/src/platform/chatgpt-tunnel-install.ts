import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

import { atomicWriteSync } from "@simulatorlife/autodev-data/files";
import { writeErrorLine, writeLine } from "@simulatorlife/autodev-runtime/shared/output";

import { defaultGatewayPolicy, parseGatewayPolicy, validateWorkspace } from "../mcp/chatgpt-gateway.ts";
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
  if (!enabled && !existsSync(configFile)) return;
  if (process.platform !== "darwin") throw new Error("AutoDev ChatGPT tunnel installation currently requires macOS");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (!lstatSync(directory).isDirectory()) throw new Error("ChatGPT tunnel directory must not be a symlink");
  chmodSync(directory, 0o700);

  const oldConfig = privateRead(configFile);
  const prior = oldConfig ? JSON.parse(oldConfig) as { workspace: string; policy: unknown } : undefined;
  const workspace = validateWorkspace(
    env.AUTODEV_CHATGPT_MCP_WORKSPACE ?? prior?.workspace ?? paths.repositoryRoot,
    paths.home, paths.codexHome
  );
  const policy = parseGatewayPolicy(env.AUTODEV_CHATGPT_MCP_POLICY
    ? JSON.parse(env.AUTODEV_CHATGPT_MCP_POLICY)
    : prior?.policy ?? defaultGatewayPolicy);

  const keyFile = path.join(directory, "runtime.key");
  const key = env.CONTROL_PLANE_API_KEY?.trim() || privateRead(keyFile);
  if (!key) throw new Error("Set CONTROL_PLANE_API_KEY to a restricted OpenAI runtime key with Tunnels Read + Use (Platform organization API keys)");
  if (/\\s/u.test(key)) throw new Error("Invalid tunnel runtime key");
  const binary = tunnelBinary();
  const idFile = path.join(directory, "tunnel-id");
  const id = env.CONTROL_PLANE_TUNNEL_ID?.trim() || privateRead(idFile) || createTunnel(binary, env);
  if (!/^[a-zA-Z0-9_-]+$/u.test(id)) throw new Error("Invalid tunnel ID");
  privateWrite(idFile, id + "\n");
  privateWrite(keyFile, key + "\n");

  const launcher = path.join(paths.repositoryRoot, "scripts", "run-autodev-mcp.sh");
  const gateway = path.join(paths.repositoryRoot, "runtime", "src", "mcp", "chatgpt-gateway.ts");
  const node = resolveServiceNode(paths.home);
  if (!statSync(launcher).isFile() || !statSync(gateway).isFile())
    throw new Error("AutoDev MCP launcher or gateway is missing");

  const plistFile = path.join(paths.home, "Library", "LaunchAgents", label + ".plist");
  mkdirSync(path.dirname(plistFile), { recursive: true, mode: 0o700 });
  const args = [
    binary, "run",
    "--control-plane.tunnel-id", id,
    "--control-plane.api-key", "file:" + keyFile,
    "--mcp.command", [node, gateway].map(shellWord).join(" "),
    "--health.listen-addr", healthAddress
  ];
  const servicePath = [path.dirname(node), path.dirname(binary), "/opt/homebrew/bin", "/usr/local/bin", path.join(paths.home, ".local/bin"), "/usr/bin", "/bin", "/usr/sbin", "/sbin"].join(":");
  const serviceEnv = {
    HOME: paths.home,
    PATH: servicePath,
    CODEX_HOME: paths.codexHome,
    AUTODEV_REPO_ROOT: paths.repositoryRoot,
    AUTODEV_NODE_BIN: node,
    AUTODEV_CHATGPT_GATEWAY_CONFIG: configFile
  };
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
  privateWrite(configFile, JSON.stringify({ workspace, launcher, policy }, null, 2) + "\n");
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
