#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { findHookScript } from './command-utils.ts';

const ENSURE_HOOKS = [
  'ensure-codex-claude-bridge.sh',
  'ensure-codex-minimax-proxy.sh',
  'ensure-codex-antigravity-proxy.sh',
] as const;

export function runSubagentStart(input = readFileSync(0)): number {
  for (const hook of ENSURE_HOOKS) {
    const result = spawnSync('/bin/bash', [findHookScript(hook)], { input, stdio: ['pipe', 'inherit', 'inherit'] });
    if (result.status !== 0) return result.status ?? 1;
  }
  return 0;
}

if (process.argv[1] === new URL(import.meta.url).pathname) process.exitCode = runSubagentStart();
