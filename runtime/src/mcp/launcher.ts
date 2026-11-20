import { spawnSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  isExecutable,
  resolveCocoIndexBinary,
  resolveCodeGraphContextBinary
} from "@simulatorlife/autodev-runtime/shared/executables";
import { writeErrorLine } from "@simulatorlife/autodev-runtime/shared/output";
import {
  resolveRuntimeSourcePath,
  resolveRuntimeSourceRoot
} from "@simulatorlife/autodev-runtime/shared/runtime-source-root";
import {
  MCP_SERVER_CODEGRAPHCONTEXT,
  MCP_SERVER_PLAYTEST
} from "@simulatorlife/autodev-runtime/shared/tool-names";

export type McpName =
  | "lsp"
  | "playwright"
  | "cocoindex-code"
  | typeof MCP_SERVER_CODEGRAPHCONTEXT
  | typeof MCP_SERVER_PLAYTEST;
/**
 * The physical form of `dir`, as ccc sees it: ccc resolves every path it
 * walks, so a symlinked spelling (`/tmp` for `/private/tmp`, an aliased home)
 * has to be compared in that same form or the launcher and ccc disagree about
 * which ancestor is the project, the repository or the home directory. A path
 * that does not exist has no physical form and stays as written.
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
 * `pathPrepend` holds directories the server needs ahead of the caller's PATH.
 * lsp-mcp-server spawns its language servers (`typescript-language-server`)
 * by bare name, and the environment Codex starts MCP servers in does not carry
 * AutoDev's `node_modules/.bin`: without it every TypeScript request fails with
 * ENOENT and lsp-mcp-server exits, which Codex reports as "Transport closed".
 */
export interface McpCommand {
  binary: string;
  args: string[];
  pathPrepend: string[];
}

/**
 * The command an MCP server runs, and the tools it is resolved from.
 *
 * The tool is resolved from the launcher's own environment, so the home that
 * holds the user's install is the one the server runs with. A bridge that
 * isolates HOME -- the Antigravity bridge runs its CLI under a temporary one --
 * has to tell the servers it starts the user's own home, or the launcher looks
 * for `ccc` and `codegraphcontext` in a home that holds neither and reports
 * both as missing.
 */
export function resolveMcpCommand(
  name: string,
  repoRoot: string,
  env: NodeJS.ProcessEnv = process.env
): McpCommand {
  const tool = name as McpName;
  if (tool === "lsp")
    return {
      binary: path.join(repoRoot, "node_modules/.bin/lsp-mcp-server"),
      args: [],
      pathPrepend: [
        path.join(repoRoot, "node_modules/.bin"),
        path.dirname(process.execPath)
      ]
    };
  if (tool === "playwright")
    return {
      binary: path.join(repoRoot, "node_modules/.bin/playwright-mcp"),
      args: [
        ...(env.AUTODEV_PLAYWRIGHT_HEADED === "1" ? [] : ["--headless"]),
        "--no-sandbox",
        "--isolated"
      ],
      pathPrepend: []
    };
  if (tool === "cocoindex-code") {
    const binary = resolveCocoIndexBinary(env);
    if (!binary)
      throw new Error(
        "AutoDev CocoIndex MCP binary is missing; install ccc or set AUTODEV_COCOINDEX_BIN"
      );
    return { binary, args: ["mcp"], pathPrepend: [] };
  }
  if (tool === MCP_SERVER_CODEGRAPHCONTEXT) {
    const binary = resolveCodeGraphContextBinary(env);
    if (!binary)
      throw new Error(
        "AutoDev CodeGraphContext MCP binary is missing; install codegraphcontext or set AUTODEV_CODEGRAPHCONTEXT_BIN"
      );
    return { binary, args: ["mcp", "start"], pathPrepend: [] };
  }
  if (tool === MCP_SERVER_PLAYTEST || tool === "playtest") {
    return {
      binary: process.execPath,
      // The Runtime lives at <root>/runtime/src in a checkout and at
      // <root>/src once it is materialized into CODEX_HOME. The root alone does
      // not say which layout it is, so the module path has to come from the
      // resolver that knows both; joining "runtime/src" onto the root points
      // the server at a path that does not exist in the installed tree, and the
      // MCP server dies on startup instead of serving the playtest tools.
      args: [resolveRuntimeSourcePath(repoRoot, "playtesting/mcp-main.ts")],
      pathPrepend: []
    };
  }
  throw new Error(`unsupported AutoDev MCP: ${name || "<missing>"}`);
}

/**
 * The directory an MCP server runs in. `ccc mcp` binds its index to the nearest
 * ancestor holding `.cocoindex_code` and refuses to start without one, so a
 * caller that starts servers from its own process directory leaves
 * cocoindex-code with no project and no workspace to bind to. Callers that know
 * the active workspace say so through `AUTODEV_MCP_WORKSPACE`; without it the
 * caller's own directory stays authoritative.
 */
export function resolveMcpWorkspace(
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd()
): string {
  const configured = env.AUTODEV_MCP_WORKSPACE?.trim();
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
 * The nearest ancestor of `startDir` that holds a cocoindex project, or null
 * when the directory sits outside every initialized cocoindex project.
 *
 * A project is marked by `.cocoindex_code/settings.yml`, not by the directory
 * alone: `~/.cocoindex_code/` is ccc's user-level directory (its
 * `global_settings.yml` and daemon socket), so a walk that stopped at any
 * `.cocoindex_code` directory took the home directory for a project from every
 * workspace under it, skipped initialization, and left `ccc mcp` exiting with
 * "Not in an initialized project directory". `ccc mcp` performs this same walk
 * for this same marker, so the launcher has to agree with it before deciding
 * whether a project needs initializing.
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
 * The directory `ccc init` should run in to give `workspace` a project.
 *
 * `ccc init` refuses to initialize below a directory that already carries a
 * project marker -- a `.git` directory or a project's settings, looked for
 * strictly below the home directory -- and ccc's own auto-init anchors at that
 * marker, so a workspace inside a repository initializes the repository's root.
 * Without a marker the workspace itself is the project. The home directory,
 * its ancestors and the filesystem root are never a project: initializing one
 * would index everything beneath it, so a server started there is refused
 * rather than bound to the wrong tree.
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
  const relativeToRoot = path.relative(root, resolvedHome);
  const coversHome =
    !relativeToRoot.startsWith("..") && !path.isAbsolute(relativeToRoot);
  if (coversHome || path.dirname(root) === root)
    throw new Error(
      `AutoDev cocoindex-code will not index ${root}: it is the home directory, one of its ancestors or the filesystem root. Start the server inside a project workspace or point AUTODEV_MCP_WORKSPACE at one.`
    );
  return root;
}

export function runMcp(
  name: string,
  repoRoot: string,
  env: NodeJS.ProcessEnv = process.env
): number {
  const command = resolveMcpCommand(name, repoRoot, env);
  const workspace = resolveMcpWorkspace(env);
  if (!isExecutable(command.binary))
    throw new Error(
      `AutoDev MCP binary is missing or not executable: ${command.binary}`
    );
  const childEnv =
    command.pathPrepend.length > 0
      ? {
          ...env,
          PATH: [...command.pathPrepend, env.PATH ?? ""]
            .filter(Boolean)
            .join(path.delimiter)
        }
      : env;
  if (name === "cocoindex-code" && !findCocoindexProjectRoot(workspace)) {
    spawnSync(command.binary, ["init"], {
      cwd: resolveCocoindexInitRoot(workspace, env.HOME || homedir()),
      env,
      stdio: ["ignore", "ignore", "inherit"]
    });
    if (!findCocoindexProjectRoot(workspace))
      throw new Error(
        `AutoDev cocoindex-code has no project under ${workspace}; run \`ccc init\` there or point AUTODEV_MCP_WORKSPACE at an initialized project directory.`
      );
  }
  const result = spawnSync(command.binary, command.args, {
    cwd: workspace,
    env: childEnv,
    stdio: "inherit"
  });
  if (result.error) throw result.error;
  return result.status ?? 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const repoRoot = resolveRuntimeSourceRoot(
      import.meta.dirname,
      process.env.AUTODEV_REPO_ROOT
    );
    process.exitCode = runMcp(process.argv[2] ?? "", repoRoot);
  } catch (error) {
    writeErrorLine(
      `autodev mcp: ${error instanceof Error ? error.message : error}`
    );
    process.exitCode = 2;
  }
}
