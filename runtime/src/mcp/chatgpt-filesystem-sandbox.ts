/** Role-aware OS confinement for local AutoDev MCP backends served via Supergateway. */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

import { z } from "zod";

import { isReadOnlyRole } from "../shared/execution-contract.ts";
import { commandWorkspaceKey } from "./commands-execution.ts";
import { resolveSkillRoots } from "../shared/skill-reads.ts";
import {
  MCP_SERVER_COCOINDEX,
  MCP_SERVER_CODEGRAPHCONTEXT,
  MCP_SERVER_COMMANDS,
  MCP_SERVER_FILESYSTEM,
  MCP_SERVER_GITHUB,
  MCP_SERVER_LSP,
  MCP_SERVER_PLAYTEST,
  MCP_SERVER_PLAYWRIGHT,
  MCP_SERVER_XACPX
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

export interface ExternalMcpBackendOptions {
  /** Override whether the backend enforces read-only confinement; defaults to the assigned role's contract. */
  readonly readOnly?: boolean;
  /** Canonical AutoDev role governing this backend's capabilities. */
  readonly role?: string;
  /** Optional explicit read-only skill roots to mount on the filesystem MCP. */
  readonly skillRoots?: readonly string[];
}

const SUPPORTED_LOCAL_GATEWAY_SERVERS = new Set<string>([
  MCP_SERVER_FILESYSTEM,
  MCP_SERVER_LSP,
  MCP_SERVER_COCOINDEX,
  MCP_SERVER_CODEGRAPHCONTEXT,
  MCP_SERVER_XACPX,
  MCP_SERVER_PLAYWRIGHT,
  MCP_SERVER_PLAYTEST,
  MCP_SERVER_GITHUB,
  MCP_SERVER_COMMANDS
]);

export function hasExternalMcpProfile(server: string): boolean {
  return SUPPORTED_LOCAL_GATEWAY_SERVERS.has(server);
}

function physicalPath(target: string): string {
  const resolved = path.resolve(target);
  try {
    return realpathSync(resolved);
  } catch {
    return resolved;
  }
}

function isWithin(child: string, parent: string): boolean {
  const relative = path.relative(parent, child);
  return (
    relative === "" ||
    (!relative.startsWith("..") && !path.isAbsolute(relative))
  );
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

function externalSkillReadRoots(
  workspace: string,
  repositoryRoot: string,
  explicitRoots?: readonly string[]
): string[] {
  const roots = explicitRoots ?? resolveSkillRoots(repositoryRoot);
  return [
    ...new Set(
      roots
        .filter((dir) => existsSync(dir))
        .map(physicalPath)
        .filter((dir) => !isWithin(dir, workspace) && !isWithin(workspace, dir))
    )
  ];
}

/**
 * Resolve the confined launch command for a role-authorized AutoDev MCP server.
 *
 * Confinement follows the assigned role's canonical execution contract (writable
 * roles may mutate inside the confined workspace; read-only roles remain strictly
 * read-only), never a blanket provider- or external-only read-only restriction.
 */
export function externalMcpBackend(
  server: string,
  repositoryRoot: string,
  workspace: string,
  node: string,
  home: string = homedir(),
  codexHome: string = path.join(home, ".codex"),
  options: ExternalMcpBackendOptions = {}
): ExternalBackend {
  if (process.platform !== "darwin" || !existsSync(sandboxExecutable))
    throw new Error("External MCP confinement requires macOS sandbox-exec");
  const readOnly =
    options.readOnly !== undefined
      ? options.readOnly
      : options.role !== undefined
        ? isReadOnlyRole(options.role)
        : false;
  const binary = resolveDirectNodeExecutable(node, workspace);
  const physicalHome = physicalPath(home);
  const physicalCodexHome = physicalPath(codexHome);
  const physicalWorkspace = physicalPath(workspace);

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
    const skillRoots = externalSkillReadRoots(
      physicalWorkspace,
      repositoryRoot,
      options.skillRoots
    );
    return {
      command: sandboxExecutable,
      args: [
        "-p",
        filesystemSandboxProfile(
          physicalWorkspace,
          realpathSync(modules),
          binary,
          { readOnly, readOnlySkillRoots: skillRoots }
        ),
        binary,
        script,
        ...(readOnly ? ["--read-only"] : []),
        "--confine-roots",
        ...skillRoots.flatMap((dir) => ["--read-only-dir", dir]),
        "--",
        physicalWorkspace
      ]
    };
  }

  const launcher = resolveLauncherScript(repositoryRoot);

  if (server === MCP_SERVER_LSP) {
    return {
      command: sandboxExecutable,
      args: [
        "-p",
        workspaceCodeToolSandboxProfile({
          workspace: physicalWorkspace,
          home: physicalHome,
          codexHome: physicalCodexHome,
          writableSubpaths: readOnly ? [] : [physicalWorkspace]
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
  if (server === MCP_SERVER_XACPX) {
    return {
      command: sandboxExecutable,
      args: [
        "-p",
        workspaceCodeToolSandboxProfile({
          workspace: physicalWorkspace,
          home: physicalHome,
          codexHome: physicalCodexHome,
          writableSubpaths: [
            path.join(physicalCodexHome, "run"),
            path.join(physicalHome, ".xacpx")
          ],
          allowUnixSockets: true,
          allowLocalhostNetwork: true,
          allowPosixIpc: true
        }),
        binary,
        launcher,
        MCP_SERVER_XACPX
      ]
    };
  }
  if (server === MCP_SERVER_COMMANDS) {
    // The Commands MCP server itself needs to read the approved catalogue,
    // write its private scratch and cache roots, spawn the confined command
    // processes, and reach its own loopback registry proxy. The commands it
    // runs are confined again, far more tightly, by their own profile.
    const key = commandWorkspaceKey(physicalWorkspace);
    return {
      command: sandboxExecutable,
      args: [
        "-p",
        workspaceCodeToolSandboxProfile({
          workspace: physicalWorkspace,
          home: physicalHome,
          codexHome: physicalCodexHome,
          writableSubpaths: [
            path.join(physicalCodexHome, "run"),
            path.join(physicalCodexHome, "run", "command-scratch", key),
            path.join(physicalCodexHome, "run", "command-cache", key)
          ],
          allowLocalhostNetwork: true
        }),
        binary,
        launcher,
        MCP_SERVER_COMMANDS,
        // The Runtime knows the role and the workspace; the agent never
        // supplies either.
        "--role",
        options.role ?? "default",
        "--workspace",
        physicalWorkspace
      ]
    };
  }
  if (
    server === MCP_SERVER_PLAYWRIGHT ||
    server === MCP_SERVER_PLAYTEST ||
    server === MCP_SERVER_GITHUB
  ) {
    return {
      command: binary,
      args: [launcher, server]
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
 * Confinement profile for workspace code/orchestration servers (LSP, CocoIndex,
 * CodeGraphContext, XACPX): enforces role-scoped write boundaries, blocks host
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

export interface FilesystemSandboxProfileOptions {
  /** When true, deny all workspace writes; when false, permit writes strictly inside `workspace`. */
  readonly readOnly?: boolean;
  /** Additional read-only skill roots mounted outside the workspace. */
  readonly readOnlySkillRoots?: readonly string[];
}

/**
 * Default deny, including all network and arbitrary host paths.
 * Reads are limited to the workspace, optional read-only skill roots, installed
 * runtime modules, and system libraries. Writes are denied for read-only roles
 * and strictly confined to `workspace` for writable roles. Never exposes `.env*`
 * secret files (except workspace `.env.example`) or host credentials.
 */
export function filesystemSandboxProfile(
  workspace: string,
  modules: string,
  node: string,
  options: FilesystemSandboxProfileOptions = {}
): string {
  const readOnly = options.readOnly ?? false;
  const literal = (value: string) => "(literal " + JSON.stringify(value) + ")";
  const subtree = (value: string) => "(subpath " + JSON.stringify(value) + ")";
  const roots = [
    workspace,
    ...(options.readOnlySkillRoots ?? []),
    modules,
    "/System",
    "/usr/lib",
    "/usr/share",
    "/Library/Apple/System"
  ];
  const rules = [
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
    // through MCP reads; permit only .env.example inside the workspace.
    '(deny file-read-data (regex #"/\\.env(\\.[^/]*)?(/|$)"))',
    "(allow file-read-data (require-all " +
      subtree(workspace) +
      ' (regex #"/\\.env\\.example$")))',
    "(allow file-write-data " + literal("/dev/null") + ")"
  ];
  if (!readOnly) {
    // Permit workspace mutations strictly inside the confined workspace, while
    // blocking writes to .env* secret files and anything outside workspace.
    rules.push("(allow file-write* " + subtree(workspace) + ")");
    rules.push('(deny file-write* (regex #"/\\.env(\\.[^/]*)?(/|$)"))');
    rules.push(
      "(allow file-write* (require-all " +
        subtree(workspace) +
        ' (regex #"/\\.env\\.example$")))'
    );
  }
  return rules.join("\n");
}
