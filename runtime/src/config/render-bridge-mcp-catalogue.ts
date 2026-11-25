import { existsSync, lstatSync, readFileSync } from "node:fs";

import { isRecord } from "@simulatorlife/autodev-core";
import {
  atomicWriteSync,
  parseJsoncObject
} from "@simulatorlife/autodev-data/files";
import { isEntryPoint } from "@simulatorlife/autodev-runtime/shared/entry-point";
import { errorMessage } from "@simulatorlife/autodev-runtime/shared/error-message";
import { codexEnvironmentHeaders } from "@simulatorlife/autodev-runtime/shared/mcp-headers";
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

function renderServerEntry(
  name: string,
  serverTable: Record<string, unknown>
): Record<string, unknown> {
  const launch: Record<string, unknown> = {};
  for (const key of LAUNCH_KEYS) {
    if (serverTable[key] !== undefined) launch[key] = serverTable[key];
  }
  // Canonical `.rulesync/mcp.jsonc` spells HTTP headers as `headers`; keep
  // `${VAR}` references verbatim under `http_headers` without embedding secrets.
  if (isRecord(serverTable.headers)) {
    const existingHeaders = isRecord(launch.http_headers)
      ? (launch.http_headers as Record<string, string>)
      : {};
    const canonicalHeaders: Record<string, string> = {};
    for (const [headerName, headerValue] of Object.entries(
      serverTable.headers
    )) {
      if (typeof headerValue !== "string" || !headerValue.trim()) {
        throw new ConfigError(
          `MCP source declares invalid header '${headerName}' for ${name}`
        );
      }
      canonicalHeaders[headerName] = headerValue;
    }
    launch.http_headers = { ...existingHeaders, ...canonicalHeaders };
  }
  if (serverTable.env_http_headers !== undefined) {
    const environmentHeaders = codexEnvironmentHeaders(
      serverTable.env_http_headers
    );
    if (environmentHeaders === null) {
      throw new ConfigError(
        `MCP source declares invalid env_http_headers for ${name}`
      );
    }
    const headers = launch.http_headers;
    launch.http_headers = {
      ...(isRecord(headers) ? (headers as Record<string, string>) : {}),
      ...environmentHeaders
    };
  }
  return launch;
}

/**
 * Render the canonical MCP server catalogue directly from `.rulesync/mcp.jsonc`
 * (without routing through a temporary Codex `config.toml` projection).
 */
export function renderBridgeMcpCatalogue(source: string): string {
  let servers: Record<string, unknown>;
  if (source.endsWith(".jsonc") || source.endsWith(".json")) {
    let parsed: Record<string, unknown>;
    try {
      parsed = parseJsoncObject(readFileSync(source, "utf8"), source);
    } catch (error) {
      throw new ConfigError(
        `unable to read MCP source ${source}: ${errorMessage(error)}`
      );
    }
    if (!isRecord(parsed.mcpServers) || Object.keys(parsed.mcpServers).length === 0) {
      throw new ConfigError(`MCP source declares no mcpServers: ${source}`);
    }
    const merged: Record<string, unknown> = { ...parsed.mcpServers };
    if (isRecord(parsed.codexcli) && isRecord(parsed.codexcli.mcpServers)) {
      for (const [name, override] of Object.entries(parsed.codexcli.mcpServers)) {
        if (override === null) {
          delete merged[name];
          continue;
        }
        if (!isRecord(override)) continue;
        const base = isRecord(merged[name])
          ? { ...(merged[name] as Record<string, unknown>) }
          : {};
        if (override.url !== undefined && override.command === undefined) {
          delete base.command;
          delete base.args;
          delete base.cwd;
        } else if (override.command !== undefined && override.url === undefined) {
          delete base.url;
          delete base.bearer_token_env_var;
          delete base.headers;
          delete base.http_headers;
          delete base.env_http_headers;
        }
        merged[name] = { ...base, ...override };
      }
    }
    servers = merged;
  } else {
    const parsedServers = parseTomlFile(source, "MCP source").mcp_servers;
    if (
      !parsedServers ||
      typeof parsedServers !== "object" ||
      Array.isArray(parsedServers) ||
      Object.keys(parsedServers).length === 0
    ) {
      throw new ConfigError(`MCP source declares no mcp_servers: ${source}`);
    }
    servers = parsedServers as TomlTable;
  }

  const catalogue: Record<string, Record<string, unknown>> = {};
  for (const name of Object.keys(servers).sort()) {
    const server = servers[name];
    if (!isRecord(server)) continue;
    catalogue[name] = renderServerEntry(name, server);
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
