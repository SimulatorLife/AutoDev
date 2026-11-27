import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";

import { atomicWriteSync } from "@simulatorlife/autodev-data/files";
import { isEntryPoint } from "@simulatorlife/autodev-runtime/shared/entry-point";
import {
  writeErrorLine,
  writeLine
} from "@simulatorlife/autodev-runtime/shared/output";
import { resolveRuntimeSourceRoot } from "@simulatorlife/autodev-runtime/shared/runtime-source-root";

import { runRulesyncGenerate } from "./runtime-files.ts";

export type JsonValue =
  null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

export const MANAGED_CODE_SKILLS = [
  "ccc",
  "lsp-mcp-server",
  "orchestration"
] as const;

const ANTIGRAVITY_CLI_SETTINGS_RELATIVE = path.join(
  ".gemini",
  "antigravity-cli",
  "settings.json"
);
const PERMISSIONS_SOURCE_RELATIVE = path.join(".rulesync", "permissions.jsonc");
const TRAILING_SLASH_PATTERN = /\/+$/u;

interface ProjectedAntigravityBaseline {
  readonly allow: readonly string[];
  readonly deny: readonly string[];
  readonly topLevelOverrides: Readonly<Record<string, JsonValue>>;
}

const BASELINE_CACHE = new Map<string, ProjectedAntigravityBaseline>();

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
  mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  atomicWriteSync(filePath, `${JSON.stringify(value, null, 2)}\n`, {
    mode: 0o600
  });
}

function expandHome(value: string, home: string): string {
  return value === "~"
    ? home
    : value.startsWith("~/")
      ? path.join(home, value.slice(2))
      : value;
}

function resolveRepositoryRoot(repositoryRoot?: string): string {
  return path.resolve(
    repositoryRoot ??
      process.env.AUTODEV_REPO_ROOT ??
      resolveRuntimeSourceRoot(import.meta.dirname)
  );
}

function normalizePosixHome(home: string): string {
  return path
    .resolve(home)
    .replaceAll("\\", "/")
    .replace(TRAILING_SLASH_PATTERN, "");
}

/**
Rewrite `read_file(...)` targets rooted at the throwaway Rulesync staging
home back to the caller's real `home` directory. Rulesync expands `~/`
against `outputRoot` (`HOME`), which during staged projection is the temp dir.
*/
function rewriteProjectedHomeEntry(
  entry: JsonValue,
  projectedHome: string,
  targetHome: string
): JsonValue {
  if (typeof entry !== "string") return entry;
  const fromHome = normalizePosixHome(projectedHome);
  const toHome = normalizePosixHome(targetHome);
  if (fromHome === toHome) return entry;
  const exact = `read_file(${fromHome})`;
  if (entry === exact) return `read_file(${toHome})`;
  const prefix = `read_file(${fromHome}/`;
  if (entry.startsWith(prefix)) {
    return `read_file(${toHome}/${entry.slice(prefix.length)}`;
  }
  return entry;
}

function stringEntries(value: JsonValue | undefined, label: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new TypeError(`${label} must be an array`);
  }
  return value.filter((entry): entry is string => typeof entry === "string");
}

function runAntigravityPermissionsProjection(
  repositoryRoot: string,
  home: string,
  existingSettings?: JsonObject
): JsonObject {
  const sourceDirectory = path.join(repositoryRoot, ".rulesync");
  const sourceFile = path.join(repositoryRoot, PERMISSIONS_SOURCE_RELATIVE);
  if (!existsSync(sourceFile)) {
    throw new Error(
      `Missing canonical RuleSync permissions file: ${sourceFile}`
    );
  }
  const projectedHome = mkdtempSync(
    path.join(tmpdir(), "autodev-agy-permissions-")
  );
  try {
    const projectedSettingsPath = path.join(
      projectedHome,
      ANTIGRAVITY_CLI_SETTINGS_RELATIVE
    );
    if (existingSettings !== undefined) {
      mkdirSync(path.dirname(projectedSettingsPath), {
        recursive: true,
        mode: 0o700
      });
      writeFileSync(
        projectedSettingsPath,
        `${JSON.stringify(existingSettings, null, 2)}\n`
      );
    }
    runRulesyncGenerate(
      repositoryRoot,
      {
        global: true,
        inputRoots: [sourceDirectory],
        targets: ["antigravity-cli"],
        features: ["permissions"],
        silent: true
      },
      projectedHome
    );
    const projected = readObject(projectedSettingsPath);
    const permissions = asObject(projected.permissions);
    if (Array.isArray(permissions.allow)) {
      permissions.allow = permissions.allow.map((entry) =>
        rewriteProjectedHomeEntry(entry, projectedHome, home)
      );
    }
    if (Array.isArray(permissions.deny)) {
      permissions.deny = permissions.deny.map((entry) =>
        rewriteProjectedHomeEntry(entry, projectedHome, home)
      );
    }
    if (Object.keys(permissions).length > 0) {
      projected.permissions = permissions;
    }
    return projected;
  } finally {
    rmSync(projectedHome, { recursive: true, force: true });
  }
}

export function projectedAntigravityBaseline(
  home = process.env.HOME?.trim() || homedir(),
  repositoryRoot?: string
): ProjectedAntigravityBaseline {
  const resolvedRoot = resolveRepositoryRoot(repositoryRoot);
  const resolvedHome = path.resolve(home);
  const sourceFile = path.join(resolvedRoot, PERMISSIONS_SOURCE_RELATIVE);
  if (!existsSync(sourceFile)) {
    throw new Error(
      `Missing canonical RuleSync permissions file: ${sourceFile}`
    );
  }
  const digest = createHash("sha256")
    .update(readFileSync(sourceFile))
    .digest("hex");
  const cacheKey = `${resolvedRoot}\0${resolvedHome}\0${digest}`;
  const cached = BASELINE_CACHE.get(cacheKey);
  if (cached) return cached;

  const projected = runAntigravityPermissionsProjection(
    resolvedRoot,
    resolvedHome
  );
  const permissions = asObject(projected.permissions);
  const topLevelOverrides: Record<string, JsonValue> = {};
  for (const [key, value] of Object.entries(projected)) {
    if (key !== "permissions") topLevelOverrides[key] = value;
  }
  const baseline: ProjectedAntigravityBaseline = {
    allow: stringEntries(permissions.allow, "Antigravity permissions.allow"),
    deny: stringEntries(permissions.deny, "Antigravity permissions.deny"),
    topLevelOverrides
  };
  BASELINE_CACHE.set(cacheKey, baseline);
  return baseline;
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
  home = process.env.HOME?.trim() || homedir(),
  repositoryRoot?: string
): string[] {
  const baseline = projectedAntigravityBaseline(home, repositoryRoot);
  const grants: string[] = [...baseline.allow];
  for (const root of normalizedReadRoots(readRoots, home)) {
    for (const entry of [`read_file(${root})`, `read_file(${root}/**)`]) {
      if (!grants.includes(entry)) grants.push(entry);
    }
  }
  return grants;
}

function permissionList(config: JsonObject): JsonValue[] {
  const allow = asObject(config.permissions).allow;
  if (allow === undefined) return [];
  if (!Array.isArray(allow))
    throw new TypeError("Antigravity permissions.allow must be an array");
  return [...allow];
}

export function updateAntigravityPermissions(
  filePath: string,
  readRoots: readonly string[],
  home = process.env.HOME?.trim() || homedir(),
  repositoryRoot?: string
): void {
  const resolvedRoot = resolveRepositoryRoot(repositoryRoot);
  const resolvedHome = path.resolve(home);
  const existing = readObject(filePath);
  const existingAllow = permissionList(existing);
  const existingReadFiles = existingAllow.filter(
    (entry): entry is string =>
      typeof entry === "string" && entry.startsWith("read_file(")
  );
  const projected = runAntigravityPermissionsProjection(
    resolvedRoot,
    resolvedHome,
    existing
  );
  const permissions = asObject(projected.permissions);
  const allow = permissionList(projected);
  // Preserve user-authored read_file grants alongside Rulesync's ~/.agents and
  // ~/.codex rules and the dynamic machine-local workspace read roots.
  for (const entry of existingReadFiles) {
    if (!allow.includes(entry)) allow.push(entry);
  }
  for (const root of normalizedReadRoots(readRoots, resolvedHome)) {
    for (const grant of [`read_file(${root})`, `read_file(${root}/**)`]) {
      if (!allow.includes(grant)) allow.push(grant);
    }
  }
  permissions.allow = allow;
  projected.permissions = permissions;
  writeObject(filePath, projected);
}

export function missingAntigravityPermissions(
  filePath: string,
  readRoots: readonly string[],
  home = process.env.HOME?.trim() || homedir(),
  repositoryRoot?: string
): string[] {
  const object = readObject(filePath);
  const allow = permissionList(object);
  const baseline = projectedAntigravityBaseline(home, repositoryRoot);
  const missingAllow = expectedPermissionGrants(
    readRoots,
    home,
    repositoryRoot
  ).filter((grant) => !allow.includes(grant));
  const deny = Array.isArray(asObject(object.permissions).deny)
    ? (asObject(object.permissions).deny as JsonValue[])
    : [];
  const missingDeny = baseline.deny.filter((denial) => !deny.includes(denial));
  const missingOverrides = Object.entries(baseline.topLevelOverrides)
    .filter(
      ([key, expected]) => JSON.stringify(object[key]) !== JSON.stringify(expected)
    )
    .map(([key, expected]) => `${key}=${JSON.stringify(expected)}`);
  return [...missingAllow, ...missingDeny, ...missingOverrides];
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
    writeErrorLine(
      "ok Antigravity CLI permissions granted (MCP and read_file)"
    );
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

function runSkills(filePath: string, check: boolean, rest: string[]): number {
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
  const isCheck = modeOrPath === "--check";
  const filePath = isCheck ? rest.shift() : modeOrPath;
  if (!filePath)
    throw new Error(
      "usage: antigravity-settings permissions|skills [--check] <path> ..."
    );
  if (kind === "permissions") return runPermissions(filePath, isCheck, rest);
  if (kind === "skills") return runSkills(filePath, isCheck, rest);
  throw new Error(
    "usage: antigravity-settings permissions|skills [--check] <path> ..."
  );
}

if (isEntryPoint(import.meta.url)) {
  try {
    process.exitCode = cli(process.argv.slice(2));
  } catch (error) {
    writeErrorLine(
      `antigravity-settings: ${error instanceof Error ? error.message : String(error)}`
    );
    process.exitCode = 1;
  }
}
