import { existsSync, lstatSync, readFileSync } from "node:fs";
import { ConfigError, atomicWrite, parseArgs, parseTomlFile, requiredArg, type TomlTable } from "./toml.ts";

const LAUNCH_KEYS = ["command", "args", "url"] as const;

export function renderBridgeMcpCatalogue(source: string): string {
  const servers = parseTomlFile(source, "MCP source").mcp_servers;
  if (!servers || typeof servers !== "object" || Array.isArray(servers) || Object.keys(servers).length === 0) {
    throw new ConfigError(`MCP source declares no mcp_servers: ${source}`);
  }
  const catalogue: Record<string, TomlTable> = {};
  for (const name of Object.keys(servers as TomlTable).sort()) {
    const server = (servers as TomlTable)[name];
    if (!server || typeof server !== "object" || Array.isArray(server)) continue;
    const launch: TomlTable = {};
    const serverTable = server as TomlTable;
    for (const key of LAUNCH_KEYS) if (serverTable[key] !== undefined) launch[key] = serverTable[key]!;
    catalogue[name] = launch;
  }
  return `${JSON.stringify(catalogue, null, 2)}\n`;
}

export function runBridgeMcpCatalogue(source: string, output: string, check = false): number {
  const rendered = renderBridgeMcpCatalogue(source);
  if (check) {
    if (existsSync(output) && !lstatSync(output).isSymbolicLink() && readFileSync(output, "utf8") === rendered) {
      console.log(`ok bridge MCP catalogue ${output}`); return 0;
    }
    console.log(`missing-or-drifted bridge MCP catalogue ${output}`); return 1;
  }
  atomicWrite(output, rendered);
  console.log(`rendered bridge MCP catalogue into ${output}`); return 0;
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  try { const { values, flags } = parseArgs(process.argv.slice(2)); process.exitCode = runBridgeMcpCatalogue(requiredArg(values, "mcp-source"), requiredArg(values, "output"), flags.has("check")); }
  catch (error) { console.error(`render-bridge-mcp-catalogue: ${error instanceof Error ? error.message : error}`); process.exitCode = 2; }
}
