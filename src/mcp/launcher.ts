import { spawnSync } from "node:child_process";
import { accessSync, constants, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { writeErrorLine } from "../shared/output.ts";

export type McpName = "lsp" | "playwright" | "cocoindex-code";
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

function executable(file: string): boolean {
  try {
    accessSync(file, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function findExecutable(
  name: string,
  pathValue = process.env.PATH ?? ""
): string | null {
  for (const directory of pathValue.split(path.delimiter)) {
    if (!directory) continue;
    const candidate = path.join(directory, name);
    if (executable(candidate)) return candidate;
  }
  return null;
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
  throw new Error(`unsupported AutoDev MCP: ${name || "<missing>"}`);
}

export function runMcp(
  name: string,
  repoRoot: string,
  env: NodeJS.ProcessEnv = process.env
): number {
  const command = resolveMcpCommand(name, repoRoot, env);
  if (!existsSync(command.binary) || !executable(command.binary))
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
  if (
    name === "cocoindex-code" &&
    !existsSync(path.join(process.cwd(), ".cocoindex_code"))
  ) {
    spawnSync(command.binary, ["init"], {
      cwd: process.cwd(),
      env,
      stdio: ["ignore", "ignore", "inherit"]
    });
  }
  const result = spawnSync(command.binary, command.args, {
    cwd: process.cwd(),
    env: childEnv,
    stdio: "inherit"
  });
  if (result.error) throw result.error;
  return result.status ?? 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const repoRoot =
      process.env.AUTODEV_REPO_ROOT?.trim() ||
      fileURLToPath(new URL("../../", import.meta.url));
    process.exitCode = runMcp(process.argv[2] ?? "", repoRoot);
  } catch (error) {
    writeErrorLine(
      `autodev mcp: ${error instanceof Error ? error.message : error}`
    );
    process.exitCode = 2;
  }
}
