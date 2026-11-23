import { existsSync, lstatSync, readFileSync } from "node:fs";
import path from "node:path";

import { atomicWriteSync } from "@simulatorlife/autodev-data/files";
import {
  BUNDLED_PLUGIN_KEY_SUFFIX,
  listBundledPlugins
} from "@simulatorlife/autodev-runtime/shared/bundled-plugins";
import { isEntryPoint } from "@simulatorlife/autodev-runtime/shared/entry-point";
import { errorMessage } from "@simulatorlife/autodev-runtime/shared/error-message";
import {
  writeErrorLine,
  writeLine
} from "@simulatorlife/autodev-runtime/shared/output";

import { parseArgs, requiredArg } from "./cli-args.ts";
import {
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
 * declares. A role entry the source does not declare (the plugin-owned
 * `codex_app`) is not a Codex MCP server.
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
  rootRolePath: string,
  permissionsPath?: string
): TomlTable {
  const portable = parseTomlFile(portablePath, "portable source");
  if ("mcp_servers" in portable)
    throw new ConfigError(
      `portable source must not declare mcp_servers: ${portablePath} (declare MCP servers in .rulesync/mcp.jsonc)`
    );
  for (const forbidden of ["sandbox_mode", "sandbox_workspace_write"]) {
    if (forbidden in portable) {
      throw new ConfigError(
        `portable source must not declare ${forbidden}: ${portablePath}`
      );
    }
  }
  const permissions = permissionsPath
    ? parseTomlFile(permissionsPath, "permissions source")
    : {};
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
    ...permissions,
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

const MERGED_TABLE_KEYS = new Set(["skills", "shell_environment_policy"]);

/**
 * Merge the portable plugin table over the local one, then disable every
 * bundled plugin the portable source does not enable.
 *
 * The portable source stays the single authority for what is allowed: a
 * bundled plugin it enables stays enabled, and one it does not name is off
 * even when the local config turns it on. A bundled plugin Codex has
 * installed but that neither the portable source nor the local config names
 * is enabled by default, so the installed set is named here as well.
 */
function mergePlugins(
  portable: TomlTable,
  existing: TomlTable,
  bundledPlugins: readonly string[]
): TomlTable {
  const merged = mergeTable(portable, existing);
  const allowed = new Set(
    Object.entries(portable)
      .filter(([, value]) => table(value).enabled === true)
      .map(([name]) => name)
  );
  const disabled: Record<string, TomlValue> = {};
  for (const [name, value] of Object.entries(merged)) {
    if (!name.endsWith(BUNDLED_PLUGIN_KEY_SUFFIX) || allowed.has(name))
      continue;
    disabled[name] = { ...table(value), enabled: false };
  }
  for (const plugin of bundledPlugins) {
    const name = `${plugin}${BUNDLED_PLUGIN_KEY_SUFFIX}`;
    if (allowed.has(name) || name in disabled) continue;
    disabled[name] = { enabled: false };
  }
  return { ...merged, ...disabled };
}

/**
 * What the composer knows about the machine it composes for.
 */
export interface ComposeOptions {
  /**
   * The bundled OpenAI plugins Codex has installed locally, by plugin name.
   * Codex enables an installed plugin unless the config names it as disabled,
   * so every installed bundled plugin the portable source does not allow is
   * named in the composed config, disabled.
   */
  readonly bundledPlugins?: readonly string[];
  /** Path to the RuleSync-projected Codex permissions TOML (`config.toml`). */
  readonly permissionsSource?: string;
}

/** Only the user's hook trust `state` survives; hook definitions are managed. */
function hooksState(value: TomlValue | undefined): TomlTable | undefined {
  const state = table(value).state;
  return state === undefined ? undefined : { state };
}

function composedPortableValue(
  key: string,
  value: TomlValue,
  old: TomlValue | undefined,
  bundledPlugins: readonly string[]
): TomlValue | undefined {
  if (key === "hooks") return hooksState(old);
  if (key === "mcp_servers") return mergeServers(table(value), table(old));
  if (key === "plugins")
    return mergePlugins(table(value), table(old), bundledPlugins);
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
const REMOVED_PERMISSION_KEYS = new Set([
  "default_permissions",
  "permissions",
  "sandbox_mode",
  "sandbox_workspace_write"
]);

export function compose(
  portable: TomlTable,
  existing: TomlTable,
  options: ComposeOptions = {}
): TomlTable {
  const bundledPlugins = options.bundledPlugins ?? [];
  const result: TomlTable = {};
  for (const [key, value] of Object.entries(portable)) {
    const composed = composedPortableValue(
      key,
      value,
      existing[key],
      bundledPlugins
    );
    if (composed !== undefined) result[key] = composed;
  }
  for (const [key, value] of Object.entries(existing)) {
    if (key in portable || REMOVED_PERMISSION_KEYS.has(key)) continue;
    if (key === "hooks") {
      const kept = hooksState(value);
      if (kept !== undefined) result[key] = kept;
      continue;
    }
    if (key === "plugins") {
      // The portable source omits a plugins table only when it allows no
      // plugin at all, and the bundled lockdown does not depend on that
      // table: an installed bundled plugin stays disabled either way.
      const kept = mergePlugins({}, table(value), bundledPlugins);
      if (Object.keys(kept).length > 0) result[key] = kept;
      continue;
    }
    if (value !== undefined) result[key] = value;
  }
  return result;
}

export function runCompose(
  portable: string,
  mcp: string,
  rootRole: string,
  existing: string,
  output: string,
  check: boolean,
  options: ComposeOptions = {}
): number {
  const rendered = serializeToml(
    compose(
      loadPortable(portable, mcp, rootRole, options.permissionsSource),
      loadExisting(existing),
      options
    )
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
  atomicWriteSync(output, rendered, { mode: 0o644, skipUnchanged: true });
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

if (isEntryPoint(import.meta.url)) {
  try {
    const { values, flags } = parseArgs(process.argv.slice(2));
    const existingConfig = requiredArg(values, "existing-config");
    process.exitCode = runCompose(
      requiredArg(values, "portable-source"),
      requiredArg(values, "mcp-source"),
      requiredArg(values, "root-role"),
      existingConfig,
      requiredArg(values, "output"),
      flags.has("check"),
      // The plugin cache lives beside the user config, so the bundled
      // plugins Codex installed are the ones under that directory.
      {
        bundledPlugins: listBundledPlugins(path.dirname(existingConfig)),
        ...(values["permissions-source"]
          ? { permissionsSource: values["permissions-source"] }
          : {})
      }
    );
  } catch (error) {
    writeErrorLine(`compose-user-config: ${errorMessage(error)}`);
    process.exitCode = 2;
  }
}
