#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { createDefaultRouterEnsureDeps, resolveRouterEnsureOptions, runRouterEnsure, type RouterEnsureDeps, type RouterEnsureOptions, type RouterEnsureResult } from '../platform/router-ensure.ts';

export interface SessionStartRunner {
  runRouterEnsure(deps: RouterEnsureDeps, options: RouterEnsureOptions): Promise<RouterEnsureResult>;
}

export const defaultSessionStartRunner: SessionStartRunner = { runRouterEnsure };

export function createSessionStart(runner: SessionStartRunner = defaultSessionStartRunner): (input?: Buffer | string) => Promise<number> {
  return async function runSessionStart(input = readFileSync(0)): Promise<number> {
    const options = resolveRouterEnsureOptions(process.env, process.pid);
    const deps = createDefaultRouterEnsureDeps(options);
    const result = await runner.runRouterEnsure(deps, options);
    if (result.message && result.exitCode !== 0) process.stderr.write(`${result.message}\n`);
    if (result.logTail && result.logTail.length > 0) {
      for (const line of result.logTail) process.stderr.write(`${line}\n`);
    }
    return result.exitCode;
  };
}

export const runSessionStart: (input?: Buffer | string) => Promise<number> = createSessionStart();

if (process.argv[1] === new URL(import.meta.url).pathname) {
  runSessionStart().then((status) => { process.exitCode = status; });
}
