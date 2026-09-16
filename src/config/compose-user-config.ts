import { existsSync, lstatSync, readFileSync } from "node:fs";
import { ConfigError, atomicWrite, parseArgs, parseTomlFile, requiredArg, serializeToml, type TomlTable, type TomlValue } from "./toml.ts";

function table(value: TomlValue | undefined): TomlTable { return value && typeof value === "object" && !Array.isArray(value) && !(value instanceof Date) ? value as TomlTable : {}; }
function array(value: TomlValue | undefined): TomlValue[] { return Array.isArray(value) ? value : []; }

export function loadPortable(portablePath: string, mcpPath: string): TomlTable {
  const portable = parseTomlFile(portablePath, "portable source");
  if ("mcp_servers" in portable) throw new ConfigError(`portable source must not declare mcp_servers: ${portablePath} (declare MCP servers in .rulesync/mcp.jsonc)`);
  const mcp = parseTomlFile(mcpPath, "MCP source").mcp_servers;
  if (!mcp || typeof mcp !== "object" || Array.isArray(mcp) || Object.keys(mcp).length === 0) throw new ConfigError(`MCP source declares no mcp_servers: ${mcpPath}`);
  return { ...portable, mcp_servers: mcp };
}

export function loadExisting(path: string): TomlTable {
  if (lstatSafe(path) && lstatSync(path).isSymbolicLink() && !existsSync(path)) throw new ConfigError(`existing config symlink target is missing: ${path}; restore the legacy config target before retrying migration`);
  return parseTomlFile(path, "existing config", false);
}

function mergeEntries(portable: TomlValue[], existing: TomlValue[]): TomlValue[] {
  const names = new Set<string>(), result: TomlValue[] = [];
  for (const entry of portable) { const name = table(entry).name; if (typeof name === "string") { result.push(entry); names.add(name); } }
  for (const entry of existing) { const name = table(entry).name; if (typeof name === "string" && !names.has(name)) { result.push(entry); names.add(name); } }
  return result;
}
function mergeTable(portable: TomlTable, existing: TomlTable): TomlTable {
  const result: TomlTable = {};
  for (const [key, value] of Object.entries(portable)) {
    if (key === "config" && Array.isArray(value)) result[key] = mergeEntries(value, array(existing[key]));
    else result[key] = value;
  }
  for (const [key, value] of Object.entries(existing)) if (!(key in portable)) result[key] = value;
  return result;
}
function mergeServers(portable: TomlTable, existing: TomlTable): TomlTable {
  const result: TomlTable = { ...portable };
  for (const [key, value] of Object.entries(existing)) if (!(key in portable)) result[key] = value;
  return result;
}

export function compose(portable: TomlTable, existing: TomlTable): TomlTable {
  const result: TomlTable = {};
  for (const [key, value] of Object.entries(portable)) {
    const old = existing[key];
    if (key === "hooks") { const state = table(old).state; if (state !== undefined) result[key] = { state }; continue; }
    if (key === "mcp_servers") { result[key] = mergeServers(table(value), table(old)); continue; }
    if (key === "skills") { result[key] = mergeTable(table(value), table(old)); continue; }
    if (key === "shell_environment_policy") { result[key] = mergeTable(table(value), table(old)); continue; }
    result[key] = value;
  }
  for (const [key, value] of Object.entries(existing)) {
    if (key in portable) continue;
    if (key === "hooks") { const state = table(value).state; if (state !== undefined) result[key] = { state }; continue; }
    result[key] = value;
  }
  return result;
}

export function applyOtelIngress(config: TomlTable, ingress: string): TomlTable {
  if (ingress === "direct") return config;
  if (ingress !== "collector") throw new ConfigError(`unsupported OTLP ingress: ${ingress}`);
  const otel = table(config.otel);
  const endpoints: Record<string, string> = { exporter: "http://127.0.0.1:4318/v1/logs", trace_exporter: "http://127.0.0.1:4318/v1/traces", metrics_exporter: "http://127.0.0.1:4318/v1/metrics" };
  for (const [key, endpoint] of Object.entries(endpoints)) { const exporter = table(otel[key]); const http = table(exporter["otlp-http"]); if (!exporter["otlp-http"] || !Object.keys(http).length) throw new ConfigError(`portable config is missing [otel].${key}.otlp-http`); http.endpoint = endpoint; exporter["otlp-http"] = http; otel[key] = exporter; }
  config.otel = otel; return config;
}

export function runCompose(portable: string, mcp: string, existing: string, output: string, check: boolean, ingress: string): number {
  const rendered = serializeToml(applyOtelIngress(compose(loadPortable(portable, mcp), loadExisting(existing)), ingress));
  if (check) {
    if (!existsSync(output)) { if (lstatSafe(output)) { console.error(`drift detected: ${output} is a symlink, expected a composed regular file`); return 1; } console.log(`ok bootstrap target absent: ${output} (would be created with ${rendered.length} bytes)`); return 0; }
    if (lstatSync(output).isSymbolicLink()) { console.error(`drift detected: ${output} is a symlink, expected a composed regular file`); return 1; }
    if (readFileSync(output, "utf8") === rendered) { console.log(`ok composed config matches ${output}`); return 0; }
    console.error(`drift detected: ${output} does not match the composed portable source + existing state`); return 1;
  }
  atomicWrite(output, rendered); console.log(`composed user-level config into ${output}`); return 0;
}
function lstatSafe(path: string): boolean { try { lstatSync(path); return true; } catch { return false; } }

if (process.argv[1] === new URL(import.meta.url).pathname) {
  try { const { values, flags } = parseArgs(process.argv.slice(2)); process.exitCode = runCompose(requiredArg(values, "portable-source"), requiredArg(values, "mcp-source"), requiredArg(values, "existing-config"), requiredArg(values, "output"), flags.has("check"), values["otel-ingress"] ?? "direct"); }
  catch (error) { console.error(`compose-user-config: ${error instanceof Error ? error.message : error}`); process.exitCode = 2; }
}
