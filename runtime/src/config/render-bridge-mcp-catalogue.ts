import { existsSync, lstatSync, readFileSync } from "node:fs";

import { atomicWriteSync } from "@simulatorlife/autodev-data/files";
import { isEntryPoint } from "@simulatorlife/autodev-runtime/shared/entry-point";
import { codexEnvironmentHeaders } from "@simulatorlife/autodev-runtime/shared/mcp-headers";
import { errorMessage } from "@simulatorlife/autodev-runtime/shared/error-message";
import {
  writeErrorLine,
  writeLine
} from "@simulatorlife/autodev-runtime/shared/output";

import { parseArgs, requiredArg } from "./cli-args.ts";
import { ConfigError, parseTomlFile, type TomlTable } from "./config-files.ts";

const LAUNCH_KEYS = [
  "command",
  "args",
  "cwd",
  "url",
  "bearer_token_env_var",
  "http_headers"
] as const;

export function renderBridgeMcpCatalogue(source: string): string {
  const servers = parseTomlFile(source, "MCP source").mcp_servers;
  if (
    !servers ||
    typeof servers !== "object" ||
    Array.isArray(servers) ||
    Object.keys(servers).length === 0
  ) {
    throw new ConfigError(`MCP source declares no mcp_servers: ${source}`);
  }
  const catalogue: Record<string, TomlTable> = {};
  for (const name of Object.keys(servers as TomlTable).sort()) {
    const server = (servers as TomlTable)[name];
    if (!server || typeof server !== "object" || Array.isArray(server))
      continue;
    const launch: TomlTable = {};
    const serverTable = server as TomlTable;
    for (const key of LAUNCH_KEYS)
      if (serverTable[key] !== undefined) launch[key] = serverTable[key]!;
    // Codex spells an environment-sourced header `env_http_headers`; the
    // catalogue keeps AutoDev's `${VAR}` reference so it names the variable
    // without carrying the credential.
    if (serverTable.env_http_headers !== undefined) {
      const environmentHeaders = codexEnvironmentHeaders(
        serverTable.env_http_headers
      );
      if (environmentHeaders === null)
        throw new ConfigError(
          `MCP source declares invalid env_http_headers for ${name}`
        );
      const headers = launch.http_headers;
      launch.http_headers = {
        ...(headers && typeof headers === "object" && !Array.isArray(headers)
          ? (headers as Record<string, string>)
          : {}),
        ...environmentHeaders
      };
    }
    catalogue[name] = launch;
  }
  return `${JSON.stringify(catalogue, null, 2)}\n`;
}

export function runBridgeMcpCatalogue(
  source: string,
  output: string,
  check = false
): number {
  const rendered = renderBridgeMcpCatalogue(source);
  if (check) {
    if (
      existsSync(output) &&
      !lstatSync(output).isSymbolicLink() &&
      readFileSync(output, "utf8") === rendered
    ) {
      writeLine(`ok bridge MCP catalogue ${output}`);
      return 0;
    }
    writeLine(`missing-or-drifted bridge MCP catalogue ${output}`);
    return 1;
  }
  atomicWriteSync(output, rendered, { mode: 0o644, skipUnchanged: true });
  writeLine(`rendered bridge MCP catalogue into ${output}`);
  return 0;
}

if (isEntryPoint(import.meta.url)) {
  try {
    const { values, flags } = parseArgs(process.argv.slice(2));
    process.exitCode = runBridgeMcpCatalogue(
      requiredArg(values, "mcp-source"),
      requiredArg(values, "output"),
      flags.has("check")
    );
  } catch (error) {
    writeErrorLine(`render-bridge-mcp-catalogue: ${errorMessage(error)}`);
    process.exitCode = 2;
  }
}
