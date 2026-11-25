/** OS confinement for reviewed local external MCP backends. */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

import { z } from "zod";

import {
  MCP_SERVER_COCOINDEX,
  MCP_SERVER_CODEGRAPHCONTEXT,
  MCP_SERVER_FILESYSTEM,
  MCP_SERVER_LSP
} from "../shared/tool-names.ts";

const packageName = "@modelcontextprotocol/server-filesystem";
const sandboxExecutable = "/usr/bin/sandbox-exec";
const manifestSchema = z.object({
  bin: z.union([z.string(), z.record(z.string(), z.string())])
});

export interface ExternalBackend {
  command: string;
  args: string[];
}

const CONFINED_EXTERNAL_SERVERS = new Set<string>([
  MCP_SERVER_FILESYSTEM,
  MCP_SERVER_LSP,
  MCP_SERVER_COCOINDEX,
  MCP_SERVER_CODEGRAPHCONTEXT
]);

export function hasExternalMcpProfile(server: string): boolean {
  return CONFINED_EXTERNAL_SERVERS.has(server);
}

function physicalPath(target: string): string {
  const resolved = path.resolve(target);
  try {
    return realpathSync(resolved);
  } catch {
    return resolved;
  }
}

function resolveLauncherScript(repositoryRoot: string): string {
  const checkout = path.join(repositoryRoot, "runtime/src/mcp/launcher.ts");
  if (existsSync(checkout)) return realpathSync(checkout);
  const installed = path.join(repositoryRoot, "src/mcp/launcher.ts");
  if (existsSync(installed)) return realpathSync(installed);
  throw new Error("AutoDev MCP launcher is missing");
}

function resolveDirectNodeExecutable(node: string, cwd: string): string {
  const resolved = realpathSync(node);
  if (resolved === realpathSync(process.execPath)) return resolved;
  // Version-manager/package-manager shims (such as ~/Library/pnpm/bin/node)
  // re-exec the real Node binary at runtime, which Seatbelt's closed sandbox
  // blocks. Resolve the underlying Node executable before building the profile.
  try {
    const target = execFileSync(
      resolved,
      ["-e", "process.stdout.write(process.execPath)"],
      {
        cwd,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 5000
      }
    ).trim();
    if (target && path.isAbsolute(target) && existsSync(target)) {
      return realpathSync(target);
    }
  } catch {
    /* Fall back cleanly if the supplied path cannot evaluate a JS probe. */
  }
  return resolved;
}

/** No generic sandbox claim: admit a backend only after its specific scope,
 * environment and capabilities have been implemented and reviewed. */
export function externalMcpBackend(
  server: string,
  repositoryRoot: string,
  workspace: string,
  node: string,
  home: string = homedir(),
  codexHome: string = path.join(home, ".codex")
): ExternalBackend {
  if (process.platform !== "darwin" || !existsSync(sandboxExecutable))
    throw new Error("External MCP confinement requires macOS sandbox-exec");
  const binary = resolveDirectNodeExecutable(node, workspace);
  if (server === MCP_SERVER_FILESYSTEM) {
    const modules = path.join(repositoryRoot, "node_modules");
    const packageRoot = realpathSync(path.join(modules, packageName));
    const manifest = manifestSchema.parse(
      JSON.parse(readFileSync(path.join(packageRoot, "package.json"), "utf8"))
    );
    const entry =
      typeof manifest.bin === "string"
        ? manifest.bin
        : manifest.bin["mcp-server-filesystem"];
    if (!entry) throw new Error("Filesystem MCP executable is missing");
    const script = realpathSync(path.join(packageRoot, entry));
    return {
      command: sandboxExecutable,
      args: [
        "-p",
        filesystemSandboxProfile(workspace, realpathSync(modules), binary),
        binary,
        script,
        "--read-only",
        "--confine-roots",
        "--",
        workspace
      ]
    };
  }
  const physicalHome = physicalPath(home);
  const physicalCodexHome = physicalPath(codexHome);
  const physicalWorkspace = physicalPath(workspace);
  const launcher = resolveLauncherScript(repositoryRoot);
  if (server === MCP_SERVER_LSP) {
    return {
      command: sandboxExecutable,
      args: [
        "-p",
        workspaceCodeToolSandboxProfile({
          workspace: physicalWorkspace,
          home: physicalHome,
          codexHome: physicalCodexHome
        }),
        binary,
        launcher,
        MCP_SERVER_LSP
      ]
    };
  }
  if (server === MCP_SERVER_COCOINDEX) {
    return {
      command: sandboxExecutable,
      args: [
        "-p",
        workspaceCodeToolSandboxProfile({
          workspace: physicalWorkspace,
          home: physicalHome,
          codexHome: physicalCodexHome,
          writableSubpaths: [
            path.join(physicalHome, ".cocoindex_code"),
            path.join(physicalWorkspace, ".cocoindex_code")
          ],
          allowUnixSockets: true,
          allowPosixIpc: true,
          allowSysvIpc: true
        }),
        binary,
        launcher,
        MCP_SERVER_COCOINDEX
      ]
    };
  }
  if (server === MCP_SERVER_CODEGRAPHCONTEXT) {
    const cgcDir = path.join(physicalHome, ".codegraphcontext");
    return {
      command: sandboxExecutable,
      args: [
        "-p",
        workspaceCodeToolSandboxProfile({
          workspace: physicalWorkspace,
          home: physicalHome,
          codexHome: physicalCodexHome,
          writableSubpaths: [cgcDir],
          readableEnvFiles: [path.join(cgcDir, ".env")],
          allowUnixSockets: true,
          allowLocalhostNetwork: true,
          allowPosixIpc: true
        }),
        binary,
        launcher,
        MCP_SERVER_CODEGRAPHCONTEXT
      ]
    };
  }
  throw new Error(
    "No externally confined execution profile for MCP: " + server
  );
}

interface WorkspaceToolSandboxOptions {
  workspace: string;
  home: string;
  codexHome: string;
  writableSubpaths?: string[];
  readableEnvFiles?: string[];
  allowUnixSockets?: boolean;
  allowLocalhostNetwork?: boolean;
  allowPosixIpc?: boolean;
  allowSysvIpc?: boolean;
}

/**
 * Confinement profile for read-only workspace intelligence servers (LSP,
 * CocoIndex, CodeGraphContext): forbids workspace source edits, blocks host
 * secrets/tunnels/`.env*`, and blocks outbound non-local network traffic.
 */
function workspaceCodeToolSandboxProfile(
  options: WorkspaceToolSandboxOptions
): string {
  const literal = (value: string) => "(literal " + JSON.stringify(value) + ")";
  const subtree = (value: string) => "(subpath " + JSON.stringify(value) + ")";
  const writeTargets = [
    ...(options.writableSubpaths ?? []).map(subtree),
    subtree("/private/tmp"),
    subtree("/private/var/folders"),
    literal("/dev/null")
  ];
  const deniedSecrets = [
    path.join(options.codexHome, "chatgpt-tunnel"),
    path.join(options.home, ".ssh"),
    path.join(options.home, ".aws"),
    path.join(options.home, ".gnupg")
  ].map(subtree);
  const rules = [
    "(version 1)",
    "(deny default)",
    '(import "dyld-support.sb")',
    "(allow process*)",
    // Seatbelt's `process*` omits signals; language server watchdogs (`kill -0`)
    // and in-sandbox daemon/child supervision require same-sandbox signaling.
    "(allow signal (target same-sandbox))",
    "(allow sysctl-read)",
    "(allow mach-lookup)",
    "(allow file-read*)",
    "(allow file-write* " + writeTargets.join(" ") + ")",
    '(deny file-read-data (regex #"/\\.env(\\.[^/]*)?(/|$)"))',
    "(allow file-read-data (require-all " +
      subtree(options.workspace) +
      ' (regex #"/\\.env\\.example$")))',
    ...(options.readableEnvFiles ?? []).map(
      (file) => "(allow file-read-data " + literal(file) + ")"
    ),
    "(deny file-read* " + deniedSecrets.join(" ") + ")"
  ];
  if (options.allowUnixSockets) {
    rules.push("(allow network* (remote unix-socket))");
    rules.push("(allow network* (local unix-socket))");
  }
  if (options.allowLocalhostNetwork) {
    rules.push('(allow network* (local ip "localhost:*"))');
    rules.push('(allow network* (remote ip "localhost:*"))');
  }
  if (options.allowPosixIpc) {
    rules.push("(allow ipc-posix*)");
  }
  if (options.allowSysvIpc) {
    rules.push("(allow ipc-sysv*)");
  }
  return rules.join("\n");
}

/** Default deny, including all network and writes. The only data readable
 * outside the workspace is installed code and system runtime support.
 * No shell startup, HOME/CODEX_HOME secret files or arbitrary executables. */
export function filesystemSandboxProfile(
  workspace: string,
  modules: string,
  node: string
): string {
  const literal = (value: string) => "(literal " + JSON.stringify(value) + ")";
  const subtree = (value: string) => "(subpath " + JSON.stringify(value) + ")";
  const roots = [
    workspace,
    modules,
    "/System",
    "/usr/lib",
    "/usr/share",
    "/Library/Apple/System"
  ];
  return [
    "(version 1)",
    "(deny default)",
    '(import "dyld-support.sb")',
    "(allow process-exec " + literal(node) + ")",
    "(allow sysctl-read)",
    "(allow mach-lookup)",
    "(allow file-read-metadata)",
    "(allow file-read* " +
      [
        ...roots.map(subtree),
        literal(node),
        literal("/dev/null"),
        literal("/dev/random"),
        literal("/dev/urandom"),
        literal("/private/etc/localtime")
      ].join(" ") +
      ")",
    // Never expose local .env / .env.* secret files (including via symlinks)
    // through external MCP reads; permit only .env.example inside the workspace.
    '(deny file-read-data (regex #"/\\.env(\\.[^/]*)?(/|$)"))',
    "(allow file-read-data (require-all " +
      subtree(workspace) +
      ' (regex #"/\\.env\\.example$")))',
    "(allow file-write-data " + literal("/dev/null") + ")"
  ].join("\n");
}
