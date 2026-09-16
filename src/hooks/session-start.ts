#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { findHookScript } from './command-utils.ts';

export function runSessionStart(input = readFileSync(0)): number {
  const result = spawnSync('/bin/bash', [findHookScript('ensure-codex-model-router.sh')], { input, stdio: ['pipe', 'inherit', 'inherit'] });
  return result.status ?? 1;
}

if (process.argv[1] === new URL(import.meta.url).pathname) process.exitCode = runSessionStart();
