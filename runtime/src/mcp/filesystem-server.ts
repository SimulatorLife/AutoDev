/**
 * The one file-interaction surface every provider bridge offers its CLI.
 *
 * AutoDev reads and edits files through one MCP server, `filesystem`
 * (`@modelcontextprotocol/server-filesystem`), declared once in
 * `.rulesync/mcp.jsonc`. Codex launches it from its own config; the Claude,
 * Antigravity and Copilot bridges launch it for each turn from the bridge MCP
 * catalogue the installer renders from that same declaration, so every
 * provider runs the same server with the same tools.
 *
 * What a bridge adds is the turn's own scope, because the CLI process is
 * started per turn and the catalogue entry is not:
 * - `AUTODEV_MCP_WORKSPACE`: the turn's workspace, the one directory the
 *   server allows;
 * - `AUTODEV_MCP_READ_ONLY=1` on a read-only turn, which starts the server
 *   with `--read-only` so it lists only its reading tools;
 * - `CODEX_HOME`, `HOME` and `AUTODEV_NODE_BIN`, so the launcher resolves
 *   under a CLI that isolates its own HOME.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

import {
  MCP_FILESYSTEM_READ_ONLY_ENV,
  MCP_SERVER_FILESYSTEM
} from "../shared/tool-names.ts";

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
  readonly codexHome: string;
  /** The user's own home, which a CLI's isolated HOME is not. */
  readonly userHome?: string;
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
  codexHome: string = process.env.CODEX_HOME ??
    path.join(homedir(), ".codex")
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
export function filesystemMcpServer(
  catalogue: Record<string, JsonRecord>,
  scope: FilesystemScope
): StdioMcpServerLaunch {
  const server = catalogue[MCP_SERVER_FILESYSTEM];
  if (!isJsonRecord(server) || typeof server.command !== "string")
    throw new Error(
      `MCP server ${MCP_SERVER_FILESYSTEM} is not a stdio server in the bridge MCP catalogue; rerun scripts/install.sh`
    );
  if (!path.isAbsolute(scope.workspace))
    throw new Error(
      `the ${MCP_SERVER_FILESYSTEM} MCP server needs an absolute workspace; got "${scope.workspace}"`
    );
  const args = Array.isArray(server.args)
    ? server.args.filter((arg): arg is string => typeof arg === "string")
    : [];
  const configured = isJsonRecord(server.env)
    ? Object.fromEntries(
        Object.entries(server.env).filter(
          (entry): entry is [string, string] => typeof entry[1] === "string"
        )
      )
    : {};
  return {
    command: server.command,
    args,
    env: {
      ...configured,
      CODEX_HOME: scope.codexHome,
      HOME: scope.userHome ?? process.env.HOME ?? homedir(),
      AUTODEV_NODE_BIN: process.env.AUTODEV_NODE_BIN || process.execPath,
      AUTODEV_MCP_WORKSPACE: scope.workspace,
      ...(scope.readOnly ? { [MCP_FILESYSTEM_READ_ONLY_ENV]: "1" } : {})
    }
  };
}
