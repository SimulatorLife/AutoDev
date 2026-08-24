import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

const root = path.resolve(new URL('..', import.meta.url).pathname);
const workflows = path.join(root, '.github', 'workflows');
const read = (name) => readFile(path.join(workflows, name), 'utf8');

const agentFiles = (await readdir(workflows)).filter((name) => name.startsWith('agent-') && name !== 'agent-invoke.yml' && name.endsWith('.yml'));

test('scheduler routes an explicit target repository', async () => {
  const source = await read('_scheduler.yml');
  assert.match(source, /parseRepositories\(cfg\.repositories\)/);
  assert.match(source, /target_repository: selected\.targetRepository/);
  assert.match(source, /target_repository: targetRepository/);
});

test('agent workflows expose and forward target_repository', async () => {
  for (const name of agentFiles) {
    const source = await read(name);
    assert.match(source, /workflow_dispatch:/, name);
    assert.match(source, /target_repository:/, name);
    if (source.includes('uses: ./.github/workflows/_agent-')) {
      assert.match(source, /target_repository: \$\{\{ inputs\.target_repository \}\}/, name);
    }
  }
});

test('central provider invocations accept target repository and PR number', async () => {
  for (const name of ['claude-invoke.yml', 'gemini-invoke.yml', 'qwen-invoke.yml', 'minimax-invoke.yml', 'minimax-codex-invoke.yml']) {
    const source = await read(name);
    assert.match(source, /workflow_dispatch:/, name);
    assert.match(source, /target_repository:/, name);
    assert.match(source, /pr_number:/, name);
    assert.match(source, /github\.event_name == 'workflow_dispatch'/, name);
  }
});

test('target-aware reusable workflows use the PAT checkout', async () => {
  const openPr = await read('_agent-open-pr-and-ping.yml');
  const invoke = await read('agent-invoke.yml');
  assert.match(openPr, /repository: \$\{\{ inputs\.target_repository \}\}/);
  assert.match(openPr, /GH_USER_TOKEN does not have push permission/);
  assert.match(invoke, /repository: \$\{\{ inputs\.target_repository \}\}/);
  assert.match(invoke, /REPOSITORY: \$\{\{ inputs\.target_repository \}\}/);
});
