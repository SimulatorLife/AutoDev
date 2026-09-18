import { accessSync, constants, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join, delimiter } from 'node:path';

export type McpName = 'lsp' | 'playwright' | 'cocoindex-code';
export interface McpCommand { binary: string; args: string[] }

function executable(path: string): boolean {
  try { accessSync(path, constants.X_OK); return true; } catch { return false; }
}

function findExecutable(name: string, pathValue = process.env.PATH ?? ''): string | null {
  for (const directory of pathValue.split(delimiter)) {
    if (!directory) continue;
    const candidate = join(directory, name);
    if (executable(candidate)) return candidate;
  }
  return null;
}

export function resolveMcpCommand(name: string, repoRoot: string, env: NodeJS.ProcessEnv = process.env): McpCommand {
  const tool = name as McpName;
  if (tool === 'lsp') return { binary: join(repoRoot, 'node_modules/.bin/lsp-mcp-server'), args: [] };
  if (tool === 'playwright') return { binary: join(repoRoot, 'node_modules/.bin/playwright-mcp'), args: [] };
  if (tool === 'cocoindex-code') {
    const configured = env.AUTODEV_COCOINDEX_BIN;
    const binary = configured
      ?? (env.HOME ? join(env.HOME, '.local/bin/ccc') : null)
      ?? findExecutable('ccc', env.PATH);
    if (!binary) throw new Error('AutoDev CocoIndex MCP binary is missing; install ccc or set AUTODEV_COCOINDEX_BIN');
    return { binary, args: ['mcp'] };
  }
  throw new Error(`unsupported AutoDev MCP: ${name || '<missing>'}`);
}

export function runMcp(name: string, repoRoot: string, env: NodeJS.ProcessEnv = process.env): number {
  const command = resolveMcpCommand(name, repoRoot, env);
  if (!existsSync(command.binary) || !executable(command.binary)) throw new Error(`AutoDev MCP binary is missing or not executable: ${command.binary}`);
  const result = spawnSync(command.binary, command.args, { cwd: process.cwd(), env, stdio: 'inherit' });
  if (result.error) throw result.error;
  return result.status ?? 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const repoRoot = process.env.AUTODEV_REPO_ROOT?.trim() || fileURLToPath(new URL('../../', import.meta.url));
    process.exitCode = runMcp(process.argv[2] ?? '', repoRoot);
  } catch (error) {
    console.error(`autodev mcp: ${error instanceof Error ? error.message : error}`);
    process.exitCode = 2;
  }
}
