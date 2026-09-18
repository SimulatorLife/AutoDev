import { randomBytes } from 'node:crypto';
import { appendFileSync, chmodSync, closeSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname } from 'node:path';

export type OtelCollectorMode = 'direct' | 'collector';
export const ROUTER_AUTH_VARIABLE = 'CODEX_ROUTER_AUTH_TOKEN';

function fail(message: string): never { throw new Error(message); }
function mode(value: string): OtelCollectorMode {
  if (value === 'direct' || value === 'collector') return value;
  return fail(`invalid Collector mode: ${value}`);
}

export function readCollectorMode(path: string): OtelCollectorMode {
  try {
    if (lstatSync(path).isSymbolicLink()) fail(`refusing symlinked Collector mode file: ${path}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  if (!existsSync(path)) return 'direct';
  return mode(readFileSync(path, 'utf8').replace(/\s+/gu, ''));
}

export function writeCollectorMode(path: string, value: OtelCollectorMode): void {
  const directory = dirname(path);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.tmp`;
  const fd = openSync(temporary, 'wx', 0o600);
  try { writeSync(fd, `${mode(value)}\n`, undefined, 'utf8'); }
  finally { closeSync(fd); }
  try { chmodSync(temporary, 0o600); renameSync(temporary, path); chmodSync(path, 0o600); }
  finally { try { unlinkSync(temporary); } catch { /* already renamed */ } }
}

function existingToken(path: string): string | null {
  if (!existsSync(path)) return null;
  const matches = readFileSync(path, 'utf8').match(new RegExp(`^${ROUTER_AUTH_VARIABLE}=([^\\n]*)$`, 'gmu'));
  const value = matches?.at(-1)?.slice(`${ROUTER_AUTH_VARIABLE}=`.length).trim() ?? '';
  return value || null;
}

function appendToken(path: string, token: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  if (existsSync(path)) {
    const contents = readFileSync(path, 'utf8');
    if (contents.length > 0 && !contents.endsWith('\n')) appendFileSync(path, '\n');
  }
  appendFileSync(path, `${ROUTER_AUTH_VARIABLE}=${token}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
}

function publishLaunchdToken(token: string, env: NodeJS.ProcessEnv): void {
  if (env.AUTODEV_SKIP_LAUNCHCTL === '1') return;
  try { execFileSync('launchctl', ['setenv', ROUTER_AUTH_VARIABLE, token], { stdio: 'ignore' }); } catch { /* launchd may be inaccessible in a sandbox */ }
}

export function ensureRouterAuth(path: string, env: NodeJS.ProcessEnv = process.env): string {
  const token = existingToken(path);
  if (token) {
    chmodSync(path, 0o600);
    console.error(`ok router auth token already exists in ${path}`);
    publishLaunchdToken(token, env);
    return token;
  }
  const generated = randomBytes(32).toString('hex');
  appendToken(path, generated);
  console.error(`created router auth token in ${path}`);
  publishLaunchdToken(generated, env);
  return generated;
}

function cli(argv: string[]): number {
  const [command, path, value] = argv;
  if (command === 'mode-read' && path && value === undefined) { console.log(readCollectorMode(path)); return 0; }
  if (command === 'mode-write' && path && value) { writeCollectorMode(path, mode(value)); return 0; }
  if (command === 'auth' && path && value === undefined) { ensureRouterAuth(path); return 0; }
  throw new Error('usage: install-state mode-read <path> | mode-write <path> <direct|collector> | auth <env-file>');
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  try { process.exitCode = cli(process.argv.slice(2)); }
  catch (error) { console.error(`install-state: ${error instanceof Error ? error.message : String(error)}`); process.exitCode = 1; }
}

