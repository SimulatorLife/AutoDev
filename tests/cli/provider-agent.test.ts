import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import {
  buildProviderPrompt,
  parseProviderAgentArgs,
  readRoleExecutionSettings,
  runProviderAgent,
  type ProviderAgentDeps,
} from '../../src/cli/provider-agent.ts';

const repositoryRoot = fileURLToPath(new URL('../../', import.meta.url));

function fixture(): { root: string; env: NodeJS.ProcessEnv; roleFile: string; codex: string } {
  const root = mkdtempSync(join(tmpdir(), 'autodev-provider-agent-'));
  const codexHome = join(root, '.codex');
  const workspace = join(root, 'workspace');
  mkdirSync(join(codexHome, 'agents'), { recursive: true });
  mkdirSync(workspace);
  const roleFile = join(codexHome, 'agents', 'smart.toml');
  writeFileSync(roleFile, 'name = "smart"\ndeveloper_instructions = "Use the typed path."\nmodel_reasoning_effort = "high"\nmodel_reasoning_summary = "concise"\nsandbox_mode = "read-only"\n');
  const codex = join(root, 'codex');
  writeFileSync(codex, '#!/bin/sh\nexit 0\n');
  chmodSync(codex, 0o700);
  return { root, env: { ...process.env, HOME: root, CODEX_HOME: codexHome, AUTODEV_REPO_ROOT: repositoryRoot, CODEX_BIN: codex }, roleFile, codex };
}

test('role settings are read from typed TOML without Python or shell parsing', () => {
  const f = fixture();
  try {
    assert.deepEqual(readRoleExecutionSettings(f.roleFile), {
      developerInstructions: 'Use the typed path.',
      reasoningEffort: 'high',
      reasoningSummary: 'concise',
      sandboxMode: 'read-only',
    });
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('argument parsing resolves role, workspace, prompt file, and executable', () => {
  const f = fixture();
  try {
    const promptFile = join(f.root, 'prompt.txt');
    writeFileSync(promptFile, 'read this prompt');
    const options = parseProviderAgentArgs(['--role', 'smart', '--cwd', join(f.root, 'workspace'), '--prompt-file', promptFile, '--check'], f.env);
    assert.equal(options.role, 'smart');
    assert.equal(options.workspace, join(f.root, 'workspace'));
    assert.equal(options.prompt, 'read this prompt');
    assert.equal(options.checkOnly, true);
    assert.equal(options.codexBinary, f.codex);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('provider agent builds the bounded prompt and role-specific Codex flags', async () => {
  const f = fixture();
  try {
    const calls: Array<{ binary: string; args: string[]; env: NodeJS.ProcessEnv; checkOnly: boolean }> = [];
    const deps: ProviderAgentDeps = {
      ensureRouter: async () => undefined,
      runCodex: (binary, args, env, checkOnly) => { calls.push({ binary, args, env, checkOnly }); return 0; },
    };
    assert.equal(buildProviderPrompt('do the task', readRoleExecutionSettings(f.roleFile)), 'Provider-neutral role instructions:\nUse the typed path.\n\nBounded task:\ndo the task');
    assert.equal(await runProviderAgent(['--role', 'smart', '--cwd', join(f.root, 'workspace'), '--prompt', 'do the task'], f.env, deps), 0);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.binary, f.codex);
    assert.equal(calls[0]?.checkOnly, false);
    assert.deepEqual(calls[0]?.args.slice(0, 8), ['--strict-config', '-C', join(f.root, 'workspace'), '-c', 'model_reasoning_effort=high', '-c', 'model_reasoning_summary=concise', '-c']);
    assert.ok(calls[0]?.args.includes('sandbox_mode=read-only'));
    assert.equal(calls[0]?.args.at(-1), 'Provider-neutral role instructions:\nUse the typed path.\n\nBounded task:\ndo the task');
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('provider agent check mode validates the role without requiring a prompt', async () => {
  const f = fixture();
  try {
    const calls: boolean[] = [];
    const deps: ProviderAgentDeps = { ensureRouter: async () => undefined, runCodex: (_binary, _args, _env, checkOnly) => { calls.push(checkOnly); return 0; } };
    assert.equal(await runProviderAgent(['--role', 'smart', '--check'], f.env, deps), 0);
    assert.deepEqual(calls, [true]);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('provider agent rejects obsolete provider selection and invalid roles', () => {
  const f = fixture();
  try {
    assert.throws(() => parseProviderAgentArgs(['--provider', 'claude'], f.env), /obsolete/);
    assert.throws(() => parseProviderAgentArgs(['--role', 'unknown'], f.env), /Unsupported role/);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('provider-agent help is a successful typed CLI path', () => {
  const module = fileURLToPath(new URL('../../src/cli/provider-agent.ts', import.meta.url));
  const output = execFileSync(process.execPath, [module, '--help'], { encoding: 'utf8' });
  assert.match(output, /Usage: run-provider-agent\.sh/);
});
