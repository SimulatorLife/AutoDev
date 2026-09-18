import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

export const REQUIRED_MCP_PERMISSIONS = [
  'mcp(cocoindex-code)', 'mcp(cocoindex-code/search)', 'mcp(lsp)', 'mcp(lsp/*)',
  'read_url(*)', 'mcp(openaiDeveloperDocs)', 'mcp(openaiDeveloperDocs/*)',
  'mcp(autodev_spawn)', 'mcp(autodev_spawn/*)', 'unsandboxed(pwd)',
  'unsandboxed(pnpm test)', "unsandboxed(python3 -m unittest discover -s tests -p 'test_*.py')",
] as const;
export const DISABLED_MCP_PERMISSIONS = ['mcp(playwright)', 'mcp(playwright/*)'] as const;
export const MANAGED_CODE_SKILLS = ['ccc', 'lsp-mcp-server'] as const;

type JsonMap = { [key: string]: JsonValue };
function asObject(value: JsonValue | undefined): JsonMap {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as JsonMap : {};
}

function readObject(path: string): JsonObject {
  if (!existsSync(path)) return {};
  const value: unknown = JSON.parse(readFileSync(path, 'utf8'));
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(`JSON object expected: ${path}`);
  return value as JsonObject;
}

function writeObject(path: string, value: JsonObject): void {
  const directory = dirname(path);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temporary = join(directory, `.autodev-${randomBytes(8).toString('hex')}.json`);
  const fd = openSync(temporary, 'wx', 0o600);
  try { writeSync(fd, `${JSON.stringify(value, null, 2)}\n`, undefined, 'utf8'); }
  finally { closeSync(fd); }
  try {
    chmodSync(temporary, 0o600);
    renameSync(temporary, path);
    chmodSync(path, 0o600);
  } finally {
    try { unlinkSync(temporary); } catch { /* already renamed */ }
  }
}

function expandHome(value: string, home: string): string {
  return value === '~' ? home : value.startsWith('~/') ? join(home, value.slice(2)) : value;
}

export function normalizedReadRoots(readRoots: readonly string[], home = process.env.HOME?.trim() || homedir()): string[] {
  return [...new Set(readRoots.map((root) => expandHome(root, home)).filter(Boolean).map((root) => resolve(root)))];
}

export function expectedPermissionGrants(readRoots: readonly string[], home = process.env.HOME?.trim() || homedir()): string[] {
  const grants: string[] = [...REQUIRED_MCP_PERMISSIONS];
  for (const root of normalizedReadRoots(readRoots, home)) grants.push(`read_file(${root})`, `read_file(${root}/**)`);
  for (const shared of [join(home, '.agents'), join(home, '.codex')]) grants.push(`read_file(${shared})`, `read_file(${shared}/**)`);
  return grants;
}

function permissionList(config: JsonObject): JsonValue[] {
  const allow = asObject(config.permissions).allow;
  if (allow === undefined) return [];
  if (!Array.isArray(allow)) throw new Error('Antigravity permissions.allow must be an array');
  return [...allow];
}

export function updateAntigravityPermissions(path: string, readRoots: readonly string[], home = process.env.HOME?.trim() || homedir()): void {
  const config = readObject(path);
  const permissions = asObject(config.permissions);
  const allow = permissionList(config).filter((entry) => typeof entry !== 'string' || !DISABLED_MCP_PERMISSIONS.includes(entry as typeof DISABLED_MCP_PERMISSIONS[number]));
  for (const grant of expectedPermissionGrants(readRoots, home)) if (!allow.includes(grant)) allow.push(grant);
  permissions.allow = allow;
  config.permissions = permissions;
  writeObject(path, config);
}

export function missingAntigravityPermissions(path: string, readRoots: readonly string[], home = process.env.HOME?.trim() || homedir()): string[] {
  const allow = permissionList(readObject(path));
  return expectedPermissionGrants(readRoots, home).filter((grant) => !allow.includes(grant));
}

function entryPath(entry: JsonValue): string | null {
  if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) return null;
  const path = (entry as JsonMap).path;
  return typeof path === 'string' ? path : null;
}

export function updateAntigravitySkills(path: string, expectedPath: string, obsoletePaths: readonly string[]): void {
  const config = readObject(path);
  const entriesValue = config.entries;
  if (entriesValue !== undefined && !Array.isArray(entriesValue)) throw new Error('Antigravity skills entries must be an array');
  const entries = entriesValue === undefined ? [] : entriesValue;
  const replaced = new Set([expectedPath, ...obsoletePaths]);
  config.entries = [...entries.filter((entry) => !replaced.has(entryPath(entry) ?? '')), { path: expectedPath, include_only: [...MANAGED_CODE_SKILLS] }];
  writeObject(path, config);
}

export function antigravitySkillsStatus(path: string, expectedPath: string, obsoletePaths: readonly string[]): { missing: boolean; stale: string[] } {
  const entriesValue = readObject(path).entries;
  const entries = Array.isArray(entriesValue) ? entriesValue : [];
  const obsolete = new Set(obsoletePaths);
  const stale = entries.flatMap((entry) => { const path = entryPath(entry); return path && obsolete.has(path) ? [path] : []; }).sort();
  const managed = entries.some((entry) => {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) return false;
    const value = entry as JsonMap;
    return value.path === expectedPath && Array.isArray(value.include_only) && JSON.stringify(value.include_only) === JSON.stringify(MANAGED_CODE_SKILLS);
  });
  return { missing: !managed, stale };
}

function cli(argv: string[]): number {
  const [kind, modeOrPath, ...rest] = argv;
  const check = modeOrPath === '--check';
  const path = check ? rest.shift() : modeOrPath;
  if (!path) throw new Error('usage: antigravity-settings permissions|skills [--check] <path> ...');
  if (kind === 'permissions') {
    if (check) {
      const missing = missingAntigravityPermissions(path, rest);
      if (missing.length > 0) { console.log(`missing Antigravity CLI permission grants: ${missing.join(', ')}`); return 1; }
      console.log('ok Antigravity CLI permission grants (MCP and read_file)');
    } else {
      updateAntigravityPermissions(path, rest);
      console.error('ok Antigravity CLI permissions granted (MCP and read_file)');
    }
    return 0;
  }
  if (kind === 'skills') {
    const expected = rest.shift();
    if (!expected) throw new Error('usage: antigravity-settings skills [--check] <path> <expected> [obsolete...]');
    if (check) {
      const status = antigravitySkillsStatus(path, expected, rest);
      if (status.stale.length > 0) { console.log(`obsolete agy skill registration ${status.stale.join(', ')}`); return 1; }
      if (status.missing) { console.log('missing agy global ccc/lsp skill registration'); return 1; }
      console.log('ok agy code skills (ccc, lsp-mcp-server)');
    } else {
      updateAntigravitySkills(path, expected, rest);
      console.error('ok agy code skills registered (ccc, lsp-mcp-server)');
    }
    return 0;
  }
  throw new Error('usage: antigravity-settings permissions|skills [--check] <path> ...');
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  try { process.exitCode = cli(process.argv.slice(2)); }
  catch (error) { console.error(`antigravity-settings: ${error instanceof Error ? error.message : String(error)}`); process.exitCode = 1; }
}
