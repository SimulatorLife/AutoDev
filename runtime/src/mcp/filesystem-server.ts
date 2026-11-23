/**
 * The one file-interaction surface every provider bridge offers its CLI.
 *
 * AutoDev reads and edits files through one MCP server, `filesystem`
 * (`@modelcontextprotocol/server-filesystem`), declared in
 * `.rulesync/mcp.jsonc` and started by the typed MCP launcher
 * (`runtime/src/mcp/launcher.ts`), which owns its command line. Codex starts it
 * through `run-autodev-mcp.sh`; the Claude and Antigravity bridges start the
 * same launcher directly for each turn, so every provider runs the same server
 * with the same tools.
 *
 * What a bridge adds is the turn's own scope, because the CLI process is
 * started per turn and the catalogue entry is not:
 * - `AUTODEV_MCP_WORKSPACE`: the turn's workspace, the one directory the
 *   server allows;
 * - `AUTODEV_MCP_READ_ONLY=1` on a read-only turn, which starts the server
 *   with `--read-only` so it lists only its reading tools;
 * - `CODEX_HOME`, `HOME` and `AUTODEV_REPO_ROOT`, so the launcher resolves
 *   the server and the skill roots under a CLI that isolates its own HOME.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { resolveRuntimeSourceRoot } from "../shared/runtime-source-root.ts";
import {
  MCP_FILESYSTEM_READ_ONLY_ENV,
  MCP_SERVER_FILESYSTEM
} from "../shared/tool-names.ts";

/** The typed launcher, a sibling of this module in both runtime layouts. */
const LAUNCHER = fileURLToPath(new URL("./launcher.ts", import.meta.url));

type JsonRecord = Record<string, unknown>;

function isJsonRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A stdio MCP server launch, in the shape every bridge's CLI config takes. */
export interface StdioMcpServerLaunch {
  readonly command: string;
  readonly args: string[];
  readonly env: Record<string, string>;
}

export interface FilesystemScope {
  /** The turn's workspace: the only directory the server may touch. */
  readonly workspace: string;
  /** Whether the turn is read-only; the server then offers only its reading tools. */
  readonly readOnly: boolean;
  /** The CODEX_HOME the launcher runs from; the bridge's own by default. */
  readonly codexHome?: string;
  /** The user's own home, which a CLI's isolated HOME is not. */
  readonly userHome?: string;
}

function defaultCodexHome(): string {
  return process.env.CODEX_HOME ?? path.join(homedir(), ".codex");
}

/** Where the installer writes the bridge MCP catalogue under a CODEX_HOME. */
export function bridgeMcpCataloguePath(codexHome: string): string {
  return path.join(codexHome, "provider-runtime", "mcp-servers.json");
}

/**
 * The launch definition of every AutoDev MCP server, rendered by the
 * installer from `.rulesync/mcp.jsonc`.
 */
export function readBridgeMcpCatalogue(
  codexHome: string = defaultCodexHome()
): Record<string, JsonRecord> {
  const cataloguePath = bridgeMcpCataloguePath(codexHome);
  try {
    const catalogue: unknown = JSON.parse(readFileSync(cataloguePath, "utf8"));
    if (isJsonRecord(catalogue))
      return catalogue as Record<string, JsonRecord>;
  } catch {
    /* reported below */
  }
  throw new Error(
    `bridge MCP catalogue is missing or invalid: ${cataloguePath}; rerun scripts/install.sh`
  );
}

/** The `filesystem` server's launch for one turn, scoped to its workspace and sandbox. */
export function filesystemMcpServer(scope: FilesystemScope): StdioMcpServerLaunch {
  if (!path.isAbsolute(scope.workspace))
    throw new Error(
      `the ${MCP_SERVER_FILESYSTEM} MCP server needs an absolute workspace; got "${scope.workspace}"`
    );
  return {
    command: process.execPath,
    args: [LAUNCHER, MCP_SERVER_FILESYSTEM],
    env: {
      CODEX_HOME: scope.codexHome ?? defaultCodexHome(),
      HOME: scope.userHome ?? process.env.HOME ?? homedir(),
      AUTODEV_REPO_ROOT: resolveRuntimeSourceRoot(
        import.meta.dirname,
        process.env.AUTODEV_REPO_ROOT
      ),
      AUTODEV_MCP_WORKSPACE: scope.workspace,
      ...(scope.readOnly ? { [MCP_FILESYSTEM_READ_ONLY_ENV]: "1" } : {})
    }
  };
}
