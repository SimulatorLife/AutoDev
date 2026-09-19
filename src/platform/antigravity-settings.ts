import { randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeSync
} from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

import { writeErrorLine, writeLine } from "../shared/output.ts";

export type JsonValue =
  null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

export const REQUIRED_MCP_PERMISSIONS = [
  "mcp(cocoindex-code)",
  "mcp(cocoindex-code/search)",
  "mcp(lsp)",
  "mcp(lsp/*)",
  "read_url(*)",
  "mcp(openaiDeveloperDocs)",
  "mcp(openaiDeveloperDocs/*)",
  "mcp(autodev_spawn)",
  "mcp(autodev_spawn/*)",
  "unsandboxed(pwd)",
  "unsandboxed(pnpm test)",
  "unsandboxed(python3 -m unittest discover -s tests -p 'test_*.py')"
] as const;
export const DISABLED_MCP_PERMISSIONS = [
  "mcp(playwright)",
  "mcp(playwright/*)"
] as const;
export const DENIED_COMMAND_PERMISSIONS = [
  "run_command(ccc *)",
  "run_command(ccc)",
  "unsandboxed(ccc *)",
  "unsandboxed(ccc)"
] as const;
export const MANAGED_CODE_SKILLS = [
  "ccc",
  "lsp-mcp-server",
  "orchestration"
] as const;

type JsonMap = { [key: string]: JsonValue };
function asObject(value: JsonValue | undefined): JsonMap {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonMap)
    : {};
}

function readObject(filePath: string): JsonObject {
  if (!existsSync(filePath)) return {};
  const value: unknown = JSON.parse(readFileSync(filePath, "utf8"));
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new Error(`JSON object expected: ${filePath}`);
  return value as JsonObject;
}

function writeObject(filePath: string, value: JsonObject): void {
  const directory = path.dirname(filePath);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temporary = path.join(
    directory,
    `.autodev-${randomBytes(8).toString("hex")}.json`
  );
  const fd = openSync(temporary, "wx", 0o600);
  try {
    writeSync(fd, `${JSON.stringify(value, null, 2)}\n`, undefined, "utf8");
  } finally {
    closeSync(fd);
  }
  try {
    chmodSync(temporary, 0o600);
    renameSync(temporary, filePath);
    chmodSync(filePath, 0o600);
  } finally {
    try {
      unlinkSync(temporary);
    } catch {
      /* already renamed */
    }
  }
}

function expandHome(value: string, home: string): string {
  return value === "~"
    ? home
    : value.startsWith("~/")
      ? path.join(home, value.slice(2))
      : value;
}

export function normalizedReadRoots(
  readRoots: readonly string[],
  home = process.env.HOME?.trim() || homedir()
): string[] {
  return [
    ...new Set(
      readRoots
        .map((root) => expandHome(root, home))
        .filter(Boolean)
        .map((root) => path.resolve(root))
    )
  ];
}

export function expectedPermissionGrants(
  readRoots: readonly string[],
  home = process.env.HOME?.trim() || homedir()
): string[] {
  const grants: string[] = [...REQUIRED_MCP_PERMISSIONS];
  for (const root of normalizedReadRoots(readRoots, home))
    grants.push(`read_file(${root})`, `read_file(${root}/**)`);
  for (const shared of [path.join(home, ".agents"), path.join(home, ".codex")])
    grants.push(`read_file(${shared})`, `read_file(${shared}/**)`);
  return grants;
}

function permissionList(config: JsonObject): JsonValue[] {
  const allow = asObject(config.permissions).allow;
  if (allow === undefined) return [];
  if (!Array.isArray(allow))
    throw new Error("Antigravity permissions.allow must be an array");
  return [...allow];
}

export function updateAntigravityPermissions(
  filePath: string,
  readRoots: readonly string[],
  home = process.env.HOME?.trim() || homedir()
): void {
  const config = readObject(filePath);
  const permissions = asObject(config.permissions);
  const allow = permissionList(config).filter(
    (entry) =>
      typeof entry !== "string" ||
      !DISABLED_MCP_PERMISSIONS.includes(
        entry as (typeof DISABLED_MCP_PERMISSIONS)[number]
      )
  );
  for (const grant of expectedPermissionGrants(readRoots, home))
    if (!allow.includes(grant)) allow.push(grant);
  permissions.allow = allow;
  const deny = Array.isArray(permissions.deny) ? [...permissions.deny] : [];
  for (const denial of DENIED_COMMAND_PERMISSIONS)
    if (!deny.includes(denial)) deny.push(denial);
  permissions.deny = deny;
  config.permissions = permissions;
  writeObject(filePath, config);
}

export function missingAntigravityPermissions(
  filePath: string,
  readRoots: readonly string[],
  home = process.env.HOME?.trim() || homedir()
): string[] {
  const obj = readObject(filePath);
  const allow = permissionList(obj);
  const missingAllow = expectedPermissionGrants(readRoots, home).filter(
    (grant) => !allow.includes(grant)
  );
  const deny = Array.isArray(asObject(obj.permissions).deny)
    ? (asObject(obj.permissions).deny as JsonValue[])
    : [];
  const missingDeny = DENIED_COMMAND_PERMISSIONS.filter(
    (denial) => !deny.includes(denial)
  );
  return [...missingAllow, ...missingDeny];
}

function entryPath(entry: JsonValue): string | null {
  if (entry === null || typeof entry !== "object" || Array.isArray(entry))
    return null;
  const filePath = (entry as JsonMap).path;
  return typeof filePath === "string" ? filePath : null;
}

export function updateAntigravitySkills(
  filePath: string,
  expectedPath: string,
  obsoletePaths: readonly string[]
): void {
  const config = readObject(filePath);
  const entriesValue = config.entries;
  if (entriesValue !== undefined && !Array.isArray(entriesValue))
    throw new Error("Antigravity skills entries must be an array");
  const entries = entriesValue === undefined ? [] : entriesValue;
  const replaced = new Set([expectedPath, ...obsoletePaths]);
  config.entries = [
    ...entries.filter((entry) => !replaced.has(entryPath(entry) ?? "")),
    { path: expectedPath, include_only: [...MANAGED_CODE_SKILLS] }
  ];
  writeObject(filePath, config);
}

export function antigravitySkillsStatus(
  filePath: string,
  expectedPath: string,
  obsoletePaths: readonly string[]
): { missing: boolean; stale: string[] } {
  const entriesValue = readObject(filePath).entries;
  const entries = Array.isArray(entriesValue) ? entriesValue : [];
  const obsolete = new Set(obsoletePaths);
  const stale = entries
    .flatMap((entry) => {
      const registered = entryPath(entry);
      return registered && obsolete.has(registered) ? [registered] : [];
    })
    .sort();
  const managed = entries.some((entry) => {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry))
      return false;
    const value = entry as JsonMap;
    return (
      value.path === expectedPath &&
      Array.isArray(value.include_only) &&
      JSON.stringify(value.include_only) === JSON.stringify(MANAGED_CODE_SKILLS)
    );
  });
  return { missing: !managed, stale };
}

function runPermissions(
  filePath: string,
  check: boolean,
  rest: string[]
): number {
  if (!check) {
    updateAntigravityPermissions(filePath, rest);
    writeErrorLine("ok Antigravity CLI permissions granted (MCP and read_file)");
    return 0;
  }
  const missing = missingAntigravityPermissions(filePath, rest);
  if (missing.length === 0) {
    writeLine("ok Antigravity CLI permission grants (MCP and read_file)");
    return 0;
  }
  writeLine(`missing Antigravity CLI permission grants: ${missing.join(", ")}`);
  return 1;
}

function runSkills(
  filePath: string,
  check: boolean,
  rest: string[]
): number {
  const expected = rest.shift();
  if (!expected)
    throw new Error(
      "usage: antigravity-settings skills [--check] <path> <expected> [obsolete...]"
    );
  if (!check) {
    updateAntigravitySkills(filePath, expected, rest);
    writeErrorLine("ok agy code skills registered (ccc, lsp-mcp-server)");
    return 0;
  }
  const status = antigravitySkillsStatus(filePath, expected, rest);
  if (status.stale.length > 0) {
    writeLine(`obsolete agy skill registration ${status.stale.join(", ")}`);
    return 1;
  }
  if (status.missing) {
    writeLine("missing agy global ccc/lsp skill registration");
    return 1;
  }
  writeLine("ok agy code skills (ccc, lsp-mcp-server)");
  return 0;
}

function cli(argv: string[]): number {
  const [kind, modeOrPath, ...rest] = argv;
  const check = modeOrPath === "--check";
  const filePath = check ? rest.shift() : modeOrPath;
  if (!filePath)
    throw new Error(
      "usage: antigravity-settings permissions|skills [--check] <path> ..."
    );
  if (kind === "permissions") return runPermissions(filePath, check, rest);
  if (kind === "skills") return runSkills(filePath, check, rest);
  throw new Error(
    "usage: antigravity-settings permissions|skills [--check] <path> ..."
  );
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  try {
    process.exitCode = cli(process.argv.slice(2));
  } catch (error) {
    writeErrorLine(
      `antigravity-settings: ${error instanceof Error ? error.message : String(error)}`
    );
    process.exitCode = 1;
  }
}
