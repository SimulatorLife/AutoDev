import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

import { isRecord } from "@simulatorlife/autodev-core";
import {
  atomicWriteSync,
  isPathWithin,
  pathsOverlap
} from "@simulatorlife/autodev-data/files";
import { isEntryPoint } from "@simulatorlife/autodev-runtime/shared/entry-point";
import {
  isExecutable,
  resolveCocoIndexBinary,
  resolveCodeGraphContextBinary,
  resolveRuntimePackageBin,
  runtimeBinDirectory
} from "@simulatorlife/autodev-runtime/shared/executables";
import { declaredDelegatedRoleNames } from "@simulatorlife/autodev-runtime/shared/execution-contract";
import { writeErrorLine } from "@simulatorlife/autodev-runtime/shared/output";
import { resolveRuntimeSourceRoot } from "@simulatorlife/autodev-runtime/shared/runtime-source-root";
import { resolveSkillRoots } from "@simulatorlife/autodev-runtime/shared/skill-reads";
import {
  MCP_FILESYSTEM_READ_ONLY_ENV,
  MCP_FILESYSTEM_WORKSPACE_ONLY_ENV,
  MCP_SERVER_CODEGRAPHCONTEXT,
  MCP_SERVER_COMMANDS,
  MCP_SERVER_FILESYSTEM,
  MCP_SERVER_GITHUB,
  MCP_SERVER_PLAYTEST,
  MCP_SERVER_XACPX
} from "@simulatorlife/autodev-runtime/shared/tool-names";

import { resolveXacpxOrchestrationSocketPath } from "../xacpx/orchestration-ipc.ts";

/**
The Runtime source directory this launcher module belongs to.
*/
const RUNTIME_SOURCE_DIRECTORY = path.resolve(import.meta.dirname, "..");

export type McpName =
  | "lsp"
  | "playwright"
  | "cocoindex-code"
  | typeof MCP_SERVER_CODEGRAPHCONTEXT
  | typeof MCP_SERVER_COMMANDS
  | typeof MCP_SERVER_FILESYSTEM
  | typeof MCP_SERVER_GITHUB
  | typeof MCP_SERVER_PLAYTEST
  | typeof MCP_SERVER_XACPX;
/**
The physical form of `dir`, as ccc sees it: ccc resolves every path it
walks, so a symlinked spelling (`/tmp` for `/private/tmp`, an aliased home)
has to be compared in that same form or the launcher and ccc disagree about
which ancestor is the project, the repository or the home directory. A path
that does not exist has no physical form and stays as written.
*/
function physicalPath(dir: string): string {
  const resolved = path.resolve(dir);
  try {
    return realpathSync(resolved);
  } catch {
    return resolved;
  }
}

/**
`pathPrepend` holds directories the server needs ahead of the caller's PATH.
lsp-mcp-server spawns its language servers (`typescript-language-server`)
by bare name, and the environment Codex starts MCP servers in does not carry
AutoDev's `node_modules/.bin`: without it every TypeScript request fails with
ENOENT and lsp-mcp-server exits, which Codex reports as "Transport closed".
*/
export interface McpCommand {
  binary: string;
  args: string[];
  pathPrepend: string[];
}

/**
The command an MCP server runs, and the tools it is resolved from.

The tool is resolved from the launcher's own environment, so the home that
holds the user's install is the one the server runs with. A bridge that
isolates HOME -- the Antigravity bridge runs its CLI under a temporary one --
has to tell the servers it starts the user's own home, or the launcher looks
for `ccc` and `codegraphcontext` in a home that holds neither and reports
both as missing.
*/
export function resolveMcpCommand(
  name: string,
  environment: NodeJS.ProcessEnv = process.env
): McpCommand {
  const tool = name as McpName;
  // Every Node-based server runs from the Runtime's own dependency tree with
  // the current Node: the walk starts at this module, so an installed Runtime
  // runs its protected closure and no configured root or caller PATH can swap
  // the executable for one from an editable checkout.
  const node = process.execPath;
  const nodeBin = path.dirname(node);
  if (tool === "lsp") {
    const languageServers = runtimeBinDirectory("typescript-language-server");
    return {
      binary: node,
      args: [resolveRuntimePackageBin("lsp-mcp-server", "lsp-mcp-server")],
      pathPrepend: [...(languageServers ? [languageServers] : []), nodeBin]
    };
  }
  if (tool === "playwright")
    return {
      binary: node,
      args: [
        resolveRuntimePackageBin("@playwright/mcp", "playwright-mcp"),
        ...(environment.AUTODEV_PLAYWRIGHT_HEADED === "1" ? [] : ["--headless"]),
        "--no-sandbox",
        "--isolated"
      ],
      pathPrepend: []
    };
  if (tool === MCP_SERVER_FILESYSTEM)
    // The workspace is the one allowed directory; it is appended by
    // `runMcp`, which resolves it. A read-only role's server lists only the
    // tools that cannot change the filesystem.
    return {
      binary: node,
      args: [
        resolveRuntimePackageBin(
          "@modelcontextprotocol/server-filesystem",
          "mcp-server-filesystem"
        ),
        ...(environment[MCP_FILESYSTEM_READ_ONLY_ENV] === "1" ? ["--read-only"] : [])
      ],
      pathPrepend: [nodeBin]
    };
  if (tool === "cocoindex-code") {
    const binary = resolveCocoIndexBinary(environment);
    if (!binary)
      throw new Error(
        "AutoDev CocoIndex MCP binary is missing; install ccc or set AUTODEV_COCOINDEX_BIN"
      );
    return { binary, args: ["mcp"], pathPrepend: [] };
  }
  if (tool === MCP_SERVER_CODEGRAPHCONTEXT) {
    const binary = resolveCodeGraphContextBinary(environment);
    if (!binary)
      throw new Error(
        "AutoDev CodeGraphContext MCP binary is missing; install codegraphcontext or set AUTODEV_CODEGRAPHCONTEXT_BIN"
      );
    return { binary, args: ["mcp", "start"], pathPrepend: [] };
  }
  if (tool === MCP_SERVER_GITHUB) {
    return {
      binary: node,
      args: [
        resolveRuntimePackageBin(
          "@modelcontextprotocol/server-github",
          "mcp-server-github"
        )
      ],
      pathPrepend: [nodeBin]
    };
  }
  if (tool === MCP_SERVER_XACPX) {
    const arguments_ = [
      resolveRuntimePackageBin("@ganglion/xacpx", "xacpx"),
      "mcp-stdio"
    ];
    const coordinatorSession = environment.AUTODEV_XACPX_COORDINATOR_SESSION?.trim();
    if (coordinatorSession)
      arguments_.push("--coordinator-session", coordinatorSession);
    const xacpxWorkspace = environment.AUTODEV_XACPX_WORKSPACE?.trim();
    if (xacpxWorkspace) arguments_.push("--workspace", xacpxWorkspace);
    const acpBins = runtimeBinDirectory("@ganglion/xacpx");
    return {
      binary: node,
      args: arguments_,
      pathPrepend: [...(acpBins ? [acpBins] : []), nodeBin]
    };
  }
  if (tool === MCP_SERVER_COMMANDS) {
    // Runtime-owned servers are this launcher's own sibling modules, so the
    // code that runs is the tree the launcher itself was loaded from.
    return {
      binary: node,
      args: [path.join(RUNTIME_SOURCE_DIRECTORY, "mcp/commands-main.ts")],
      pathPrepend: [nodeBin]
    };
  }
  if (tool === MCP_SERVER_PLAYTEST || tool === "playtest") {
    return {
      binary: node,
      args: [path.join(RUNTIME_SOURCE_DIRECTORY, "playtesting/mcp-main.ts")],
      pathPrepend: []
    };
  }
  throw new Error(`unsupported AutoDev MCP: ${name || "<missing>"}`);
}

/**
The directories the `filesystem` server may touch: the workspace, and the
skill roots outside it.

Skills are instructions the model reads, and the user-level ones live
outside any workspace (`~/.agents/skills`, `~/.codex/skills`), so the one
file surface has to reach them to read a skill at all. They are given with
`--read-only-dir`: a turn reads a skill, it does not rewrite the user's
catalogue. A root inside the workspace is left to the workspace, so a
repository's own skills stay as editable as the rest of it.

`--confine-roots` keeps an MCP client's Roots from replacing these
directories: a client that sends its own roots can narrow them, never widen
them past the workspace.
*/
export function filesystemDirectoryArgs(
  workspace: string,
  repositoryRoot: string
): string[] {
  const root = physicalPath(workspace);
  const readOnly = [
    ...new Set(resolveSkillRoots(repositoryRoot).map(physicalPath))
  ].filter((dir) => !pathsOverlap(dir, root));
  return [
    "--confine-roots",
    ...readOnly.flatMap((dir) => ["--read-only-dir", dir]),
    "--",
    root
  ];
}

/**
The directory an MCP server runs in. `ccc mcp` binds its index to the nearest
ancestor holding `.cocoindex_code` and refuses to start without one, so a
caller that starts servers from its own process directory leaves
cocoindex-code with no project and no workspace to bind to. Callers that know
the active workspace say so through `AUTODEV_MCP_WORKSPACE`; without it the
caller's own directory stays authoritative.
*/
export function resolveMcpWorkspace(
  environment: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd()
): string {
  const configured = environment.AUTODEV_MCP_WORKSPACE?.trim();
  if (!configured) return cwd;
  if (!path.isAbsolute(configured))
    throw new Error(
      `AUTODEV_MCP_WORKSPACE must be an absolute path; got "${configured}"`
    );
  const workspace = path.resolve(configured);
  if (!existsSync(workspace))
    throw new Error(`AUTODEV_MCP_WORKSPACE does not exist: ${workspace}`);
  return workspace;
}

/**
The nearest ancestor of `startDir` that holds a cocoindex project, or null
when the directory sits outside every initialized cocoindex project.

A project is marked by `.cocoindex_code/settings.yml`, not by the directory
alone: `~/.cocoindex_code/` is ccc's user-level directory (its
`global_settings.yml` and daemon socket), so a walk that stopped at any
`.cocoindex_code` directory took the home directory for a project from every
workspace under it, skipped initialization, and left `ccc mcp` exiting with
"Not in an initialized project directory". `ccc mcp` performs this same walk
for this same marker, so the launcher has to agree with it before deciding
whether a project needs initializing.
*/
export function findCocoindexProjectRoot(startDir: string): string | null {
  let dir = physicalPath(startDir);
  for (;;) {
    if (existsSync(path.join(dir, ".cocoindex_code", "settings.yml")))
      return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
The directory `ccc init` should run in to give `workspace` a project.

`ccc init` refuses to initialize below a directory that already carries a
project marker -- a `.git` directory or a project's settings, looked for
strictly below the home directory -- and ccc's own auto-init anchors at that
marker, so a workspace inside a repository initializes the repository's root.
Without a marker the workspace itself is the project. The home directory,
its ancestors and the filesystem root are never a project: initializing one
would index everything beneath it, so a server started there is refused
rather than bound to the wrong tree.
*/
export function resolveCocoindexInitRoot(
  workspace: string,
  home: string = homedir()
): string {
  const resolvedHome = physicalPath(home);
  let root = physicalPath(workspace);
  for (let dir = root; dir !== resolvedHome;) {
    const parent = path.dirname(dir);
    if (parent === dir) break;
    if (
      existsSync(path.join(dir, ".cocoindex_code", "settings.yml")) ||
      existsSync(path.join(dir, ".git"))
    ) {
      root = dir;
      break;
    }
    dir = parent;
  }
  const coversHome = isPathWithin(root, resolvedHome);
  if (coversHome || path.dirname(root) === root)
    throw new Error(
      `AutoDev cocoindex-code will not index ${root}: it is the home directory, one of its ancestors or the filesystem root. Start the server inside a project workspace or point AUTODEV_MCP_WORKSPACE at one.`
    );
  return root;
}

export function ensureXacpxConfig(
  configPath: string,
  workspaceKey: string | undefined,
  workspaceDir: string
): void {
  let existing: Record<string, unknown> = {};
  if (existsSync(configPath)) {
    try {
      const parsed: unknown = JSON.parse(readFileSync(configPath, "utf8"));
      if (isRecord(parsed)) existing = parsed;
    } catch {
      existing = {};
    }
  }
  const transport = isRecord(existing.transport)
    ? existing.transport
    : { type: "acpx-bridge" };
  const channel = isRecord(existing.channel)
    ? existing.channel
    : { type: "weixin", replyMode: "verbose" };
  // This projection is owned by AutoDev. XACPX advertises the keys in
  // agents verbatim; retaining retired roles or provider aliases makes
  // discovery promise targets that Runtime's role admission rejects.
  const agents = Object.fromEntries(
    declaredDelegatedRoleNames().map((role) => [role, { driver: "codex" }])
  );
  const workspaces: Record<string, unknown> = isRecord(existing.workspaces)
    ? { ...existing.workspaces }
    : {};
  if (!isRecord(workspaces.home)) {
    workspaces.home = { cwd: "~", description: "home directory" };
  }
  if (workspaceKey) {
    workspaces[workspaceKey] = { cwd: workspaceDir };
  }
  const next = {
    ...existing,
    transport,
    channel,
    agents,
    workspaces
  };
  atomicWriteSync(configPath, JSON.stringify(next, null, 2) + "\n", {
    mode: 0o600,
    skipUnchanged: true
  });
}

/**
Run one AutoDev MCP server. `serverArguments` are the arguments the launcher's
caller supplied after the server name -- the trusted renderer that wrote the
launch command (the ChatGPT gateway passes the Commands MCP its role and
workspace this way); they are passed to the server unchanged.
*/
export function runMcp(
  name: string,
  repositoryRoot: string,
  environment: NodeJS.ProcessEnv = process.env,
  serverArguments: readonly string[] = []
): number {
  const command = resolveMcpCommand(name, environment);
  const workspace = resolveMcpWorkspace(environment);
  if (!isExecutable(command.binary))
    throw new Error(
      `AutoDev MCP binary is missing or not executable: ${command.binary}`
    );
  const xacpxEnvironment: Record<string, string> = {};
  if (name === MCP_SERVER_XACPX) {
    const home = environment.HOME?.trim() || homedir();
    const codexHome = environment.CODEX_HOME?.trim() || path.join(home, ".codex");
    const xacpxRunDir = path.join(codexHome, "run", "xacpx");
    if (!environment.XACPX_ORCHESTRATION_SOCKET?.trim()) {
      xacpxEnvironment.XACPX_ORCHESTRATION_SOCKET = resolveXacpxOrchestrationSocketPath(
        codexHome,
        environment
      );
    }
    const configPath =
      environment.XACPX_CONFIG?.trim() || path.join(xacpxRunDir, "config.json");
    if (!environment.XACPX_CONFIG?.trim()) {
      xacpxEnvironment.XACPX_CONFIG = configPath;
    }
    if (!environment.XACPX_STATE?.trim()) {
      xacpxEnvironment.XACPX_STATE = path.join(xacpxRunDir, "state.json");
    }
    ensureXacpxConfig(
      configPath,
      environment.AUTODEV_XACPX_WORKSPACE?.trim(),
      physicalPath(workspace)
    );
  }
  const childEnvironment =
    command.pathPrepend.length > 0 || Object.keys(xacpxEnvironment).length > 0
      ? {
          ...environment,
          ...xacpxEnvironment,
          ...((command.pathPrepend.length > 0) && {
                PATH: [...command.pathPrepend, environment.PATH ?? ""]
                  .filter(Boolean)
                  .join(path.delimiter)
              })
        }
      : environment;
  if (name === "cocoindex-code" && !findCocoindexProjectRoot(workspace)) {
    spawnSync(command.binary, ["init"], {
      cwd: resolveCocoindexInitRoot(workspace, environment.HOME || homedir()),
      env: environment,
      stdio: ["ignore", "ignore", "inherit"]
    });
    if (!findCocoindexProjectRoot(workspace))
      throw new Error(
        `AutoDev cocoindex-code has no project under ${workspace}; run \`ccc init\` there or point AUTODEV_MCP_WORKSPACE at an initialized project directory.`
      );
  }
  const arguments_ = [
    ...command.args,
    ...serverArguments,
    ...(name === MCP_SERVER_FILESYSTEM
      ? environment[MCP_FILESYSTEM_WORKSPACE_ONLY_ENV] === "1"
        ? ["--confine-roots", "--", physicalPath(workspace)]
        : filesystemDirectoryArgs(workspace, repositoryRoot)
      : [])
  ];
  const result = spawnSync(command.binary, arguments_, {
    cwd: workspace,
    env: childEnvironment,
    stdio: "inherit"
  });
  if (result.error) throw result.error;
  return result.status ?? 1;
}

if (isEntryPoint(import.meta.url)) {
  try {
    const repositoryRoot = resolveRuntimeSourceRoot(
      import.meta.dirname,
      process.env.AUTODEV_REPO_ROOT
    );
    process.exitCode = runMcp(
      process.argv[2] ?? "",
      repositoryRoot,
      process.env,
      process.argv.slice(3)
    );
  } catch (error) {
    writeErrorLine(
      `autodev mcp: ${error instanceof Error ? error.message : error}`
    );
    process.exitCode = 2;
  }
}
