import { lstatSync, rmSync, unlinkSync } from 'node:fs';

export type ReconciliationKind =
  | 'obsolete-launchagent'
  | 'obsolete-runtime-path'
  | 'obsolete-runtime-hook'
  | 'obsolete-runtime-directory';

export function stalePaths(paths: readonly string[]): string[] {
  return paths.filter((path) => {
    try { lstatSync(path); return true; } catch { return false; }
  });
}

export function removeStalePaths(paths: readonly string[], kind: ReconciliationKind): string[] {
  const removed: string[] = [];
  for (const path of stalePaths(paths)) {
    const stat = lstatSync(path);
    if (kind === 'obsolete-runtime-directory' && stat.isDirectory() && !stat.isSymbolicLink()) rmSync(path, { recursive: true, force: true });
    else unlinkSync(path);
    removed.push(path);
  }
  return removed;
}

function cli(argv: string[]): number {
  const [command, kind, ...paths] = argv;
  if ((command !== 'check' && command !== 'remove') || !isKind(kind) || paths.length === 0) {
    throw new Error('usage: runtime-reconciliation check|remove <kind> <path>...');
  }
  if (command === 'check') {
    const stale = stalePaths(paths);
    for (const path of stale) console.log(`${kind} ${path}`);
    return stale.length === 0 ? 0 : 1;
  }
  for (const path of removeStalePaths(paths, kind)) console.log(`removed ${kind} ${path}`);
  return 0;
}

function isKind(value: string | undefined): value is ReconciliationKind {
  return value === 'obsolete-launchagent' || value === 'obsolete-runtime-path' || value === 'obsolete-runtime-hook' || value === 'obsolete-runtime-directory';
}


if (process.argv[1] === new URL(import.meta.url).pathname) {
  try { process.exitCode = cli(process.argv.slice(2)); }
  catch (error) { console.error(`runtime-reconciliation: ${error instanceof Error ? error.message : String(error)}`); process.exitCode = 1; }
}
