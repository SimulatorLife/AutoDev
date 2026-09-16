import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

export function codexHome(): string {
  return process.env.CODEX_HOME?.trim() || join(homedir(), '.codex');
}

export function repositoryRoot(): string {
  return resolve(process.env.AUTODEV_REPO_ROOT?.trim() || join(dirname(import.meta.dirname), '..'));
}

export function findHookScript(name: string): string {
  const candidates = [
    join(codexHome(), 'hooks', name),
    join(repositoryRoot(), 'scripts', name),
  ];
  const found = candidates.find((candidate) => existsSync(candidate));
  return found ?? candidates[0]!;
}
