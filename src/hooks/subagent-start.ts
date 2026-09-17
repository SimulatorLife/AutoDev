#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { ensureAntigravityProxy } from '../platform/antigravity-ensure.ts';
import { ensureClaudeBridge } from '../platform/claude-ensure.ts';
import { ensureMiniMaxProxy } from '../platform/minimax-ensure.ts';

export interface SubagentStartEnsurers {
  readonly claude: (input: string) => Promise<number>;
  readonly minimax: (input: string) => Promise<number>;
  readonly antigravity: (input: string) => Promise<number>;
}

const defaultEnsurers: SubagentStartEnsurers = {
  claude: (input) => ensureClaudeBridge(input),
  minimax: (input) => ensureMiniMaxProxy(input),
  antigravity: (input) => ensureAntigravityProxy(input),
};

/**
 * Start only the provider service relevant to this subagent. Provider
 * lifecycle decisions belong to typed platform owners; this hook only keeps
 * their model-gated calls in a stable order and fails closed on failure.
 */
export function createSubagentStart(ensurers: SubagentStartEnsurers = defaultEnsurers): (input?: Buffer | string) => Promise<number> {
  return async function runSubagentStart(input = readFileSync(0)) {
    const raw = typeof input === 'string' ? input : input.toString('utf8');
    for (const ensure of [ensurers.claude, ensurers.minimax, ensurers.antigravity]) {
      const status = await ensure(raw);
      if (status !== 0) return status;
    }
    return 0;
  };
}

export const runSubagentStart = createSubagentStart();

if (process.argv[1] === new URL(import.meta.url).pathname) {
  runSubagentStart().then((status) => { process.exitCode = status; });
}
