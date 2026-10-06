import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  findExecutable,
  isExecutable,
  resolveCodeGraphContextBinary
} from "@simulatorlife/autodev-runtime/shared/executables";
import { writeErrorLine } from "@simulatorlife/autodev-runtime/shared/output";
import { resolveRuntimeSourceRoot } from "@simulatorlife/autodev-runtime/shared/runtime-source-root";
import { MCP_SERVER_CODEGRAPHCONTEXT } from "@simulatorlife/autodev-runtime/shared/tool-names";

export type McpName =
  "lsp" | "playwright" | "cocoindex-code" | typeof MCP_SERVER_CODEGRAPHCONTEXT;
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
      pathPrepend: [path.join(repoRoot, "node_modules/.bin")]
    };
  if (tool === "playwright")
    return {
      binary: path.join(repoRoot, "node_modules/.bin/playwright-mcp"),
      args: [],
      pathPrepend: []
    };
  if (tool === "cocoindex-code") {
    const configured = env.AUTODEV_COCOINDEX_BIN;
    const binary =
      configured ??
      (env.HOME ? path.join(env.HOME, ".local/bin/ccc") : null) ??
      findExecutable("ccc", env.PATH);
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
 * The nearest ancestor of `startDir` that holds a `.cocoindex_code` project, or
 * null when the directory sits outside every initialized cocoindex project.
 * `ccc mcp` performs this same ancestor walk, so the launcher has to agree with
 * it before deciding whether a project needs initializing.
 */
export function findCocoindexProjectRoot(startDir: string): string | null {
  let dir = path.resolve(startDir);
  for (;;) {
    if (existsSync(path.join(dir, ".cocoindex_code"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
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
      cwd: workspace,
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
