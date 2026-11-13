import { existsSync, lstatSync, readFileSync } from "node:fs";

import { errorMessage } from "@simulatorlife/autodev-runtime/shared/error-message";
import {
  writeErrorLine,
  writeLine
} from "@simulatorlife/autodev-runtime/shared/output";

import { parseArgs, requiredArg } from "./cli-args.ts";
import {
  atomicWrite,
  ConfigError,
  parseTomlFile,
  serializeToml,
  type TomlTable,
  type TomlValue
} from "./config-files.ts";

function table(value: TomlValue | undefined): TomlTable {
  return value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    !(value instanceof Date)
    ? (value as TomlTable)
    : {};
}
function array(value: TomlValue | undefined): TomlValue[] {
  return Array.isArray(value) ? value : [];
}

/**
 * Per-server settings a role owns; launch keys stay with the MCP source. The
 * root turn is the orchestrator, so its role declaration sets these for the
 * root config exactly as a child role's TOML sets them for that child.
 */
const ROLE_SERVER_KEYS = [
  "enabled",
  "enabled_tools",
  "default_tools_approval_mode"
] as const;

/**
 * Overlay the root role's per-server settings onto the servers the MCP source
 * declares. Role entries the source does not declare (the bridge-injected
 * `autodev_spawn`, the plugin-owned `codex_app`) are not Codex MCP servers.
 */
function applyRootRole(mcp: TomlTable, rootRole: TomlTable): TomlTable {
  const roleServers = table(rootRole.mcp_servers);
  const result: TomlTable = {};
  for (const [name, server] of Object.entries(mcp)) {
    const role = table(roleServers[name]);
    const merged: TomlTable = { ...table(server) };
    for (const key of ROLE_SERVER_KEYS)
      if (key in role) merged[key] = role[key] as TomlValue;
    result[name] = merged;
  }
  return result;
}

export function loadPortable(
  portablePath: string,
  mcpPath: string,
  rootRolePath: string
): TomlTable {
  const portable = parseTomlFile(portablePath, "portable source");
  if ("mcp_servers" in portable)
    throw new ConfigError(
      `portable source must not declare mcp_servers: ${portablePath} (declare MCP servers in .rulesync/mcp.jsonc)`
    );
  const mcp = parseTomlFile(mcpPath, "MCP source").mcp_servers;
  if (
    !mcp ||
    typeof mcp !== "object" ||
    Array.isArray(mcp) ||
    Object.keys(mcp).length === 0
  )
    throw new ConfigError(`MCP source declares no mcp_servers: ${mcpPath}`);
  const rootRole = parseTomlFile(rootRolePath, "root role");
  return {
    ...portable,
    mcp_servers: applyRootRole(mcp as TomlTable, rootRole)
  };
}

export function loadExisting(path: string): TomlTable {
  if (lstatSafe(path) && lstatSync(path).isSymbolicLink() && !existsSync(path))
    throw new ConfigError(
      `existing config symlink target is missing: ${path}; restore the legacy config target before retrying migration`
    );
  return parseTomlFile(path, "existing config", false);
}

function mergeEntries(
  portable: TomlValue[],
  existing: TomlValue[]
): TomlValue[] {
  const names = new Set<string>(),
    result: TomlValue[] = [];
  for (const entry of portable) {
    const name = table(entry).name;
    if (typeof name === "string") {
      result.push(entry);
      names.add(name);
    }
  }
  for (const entry of existing) {
    const name = table(entry).name;
    if (typeof name === "string" && !names.has(name)) {
      result.push(entry);
      names.add(name);
    }
  }
  return result;
}
function mergeTable(portable: TomlTable, existing: TomlTable): TomlTable {
  const result: TomlTable = {};
  for (const [key, value] of Object.entries(portable)) {
    if (key === "config" && Array.isArray(value))
      result[key] = mergeEntries(value, array(existing[key]));
    else result[key] = value;
  }
  for (const [key, value] of Object.entries(existing))
    if (!(key in portable)) result[key] = value;
  return result;
}
function mergeServers(portable: TomlTable, existing: TomlTable): TomlTable {
  const result: TomlTable = { ...portable };
  for (const [key, value] of Object.entries(existing))
    if (!(key in portable)) result[key] = value;
  return result;
}

const MERGED_TABLE_KEYS = new Set([
  "skills",
  "shell_environment_policy",
  "plugins"
]);

/** Only the user's hook trust `state` survives; hook definitions are managed. */
function hooksState(value: TomlValue | undefined): TomlTable | undefined {
  const state = table(value).state;
  return state === undefined ? undefined : { state };
}

function composedPortableValue(
  key: string,
  value: TomlValue,
  old: TomlValue | undefined
): TomlValue | undefined {
  if (key === "hooks") return hooksState(old);
  if (key === "mcp_servers") return mergeServers(table(value), table(old));
  if (MERGED_TABLE_KEYS.has(key)) return mergeTable(table(value), table(old));
  return value;
}

/**
 * Codex permission-profile keys. Codex applies a selected profile over
 * `sandbox_mode`, `[sandbox_workspace_write]` and every role's `sandbox_mode`,
 * so a profile selected outside the portable source (a `rulesync generate
 * --features permissions` run wrote `default_permissions = "rulesync"` on
 * 2026-11-10) silently replaced the portable policy: every role ran
 * workspace-write with no network. The portable source owns the permission
 * policy, so these keys are never carried over from existing state.
 */
const PERMISSION_PROFILE_KEYS = new Set(["default_permissions", "permissions"]);

export function compose(portable: TomlTable, existing: TomlTable): TomlTable {
  const result: TomlTable = {};
  for (const [key, value] of Object.entries(portable)) {
    const composed = composedPortableValue(key, value, existing[key]);
    if (composed !== undefined) result[key] = composed;
  }
  for (const [key, value] of Object.entries(existing)) {
    if (key in portable || PERMISSION_PROFILE_KEYS.has(key)) continue;
    const kept = key === "hooks" ? hooksState(value) : value;
    if (kept !== undefined) result[key] = kept;
  }
  return result;
}

export function runCompose(
  portable: string,
  mcp: string,
  rootRole: string,
  existing: string,
  output: string,
  check: boolean
): number {
  const rendered = serializeToml(
    compose(loadPortable(portable, mcp, rootRole), loadExisting(existing))
  );
  if (check) {
    if (!existsSync(output)) {
      if (lstatSafe(output)) {
        writeErrorLine(
          `drift detected: ${output} is a symlink, expected a composed regular file`
        );
        return 1;
      }
      writeLine(
        `ok bootstrap target absent: ${output} (would be created with ${rendered.length} bytes)`
      );
      return 0;
    }
    if (lstatSync(output).isSymbolicLink()) {
      writeErrorLine(
        `drift detected: ${output} is a symlink, expected a composed regular file`
      );
      return 1;
    }
    if (readFileSync(output, "utf8") === rendered) {
      writeLine(`ok composed config matches ${output}`);
      return 0;
    }
    writeErrorLine(
      `drift detected: ${output} does not match the composed portable source + existing state`
    );
    return 1;
  }
  atomicWrite(output, rendered);
  writeLine(`composed user-level config into ${output}`);
  return 0;
}
function lstatSafe(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  try {
    const { values, flags } = parseArgs(process.argv.slice(2));
    process.exitCode = runCompose(
      requiredArg(values, "portable-source"),
      requiredArg(values, "mcp-source"),
      requiredArg(values, "root-role"),
      requiredArg(values, "existing-config"),
      requiredArg(values, "output"),
      flags.has("check")
    );
  } catch (error) {
    writeErrorLine(`compose-user-config: ${errorMessage(error)}`);
    process.exitCode = 2;
  }
}
