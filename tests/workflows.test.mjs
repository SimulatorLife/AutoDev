import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

const root = path.resolve(new URL('..', import.meta.url).pathname);
const workflows = path.join(root, '.github', 'workflows');
const prompts = path.join(root, '.agents', 'prompts');
const readWorkflow = (name) => readFile(path.join(workflows, name), 'utf8');
const readPrompt = (name) => readFile(path.join(prompts, name), 'utf8');

const config = JSON.parse(await readFile(path.join(workflows, 'weights.json'), 'utf8'));

test('scheduler routes prompt, agent, and target repository', async () => {
  const source = await readWorkflow('_scheduler.yml');
  assert.match(source, /cfg\.prompts/);
  assert.match(source, /target_repository: item\.targetRepository/);
  assert.match(source, /prompt_path: item\.promptPath/);
  assert.match(source, /prompt_scope: item\.promptScope/);
  assert.match(source, /workflow_id: 'run-prompt\.yml'/);
});

test('generic prompt runner supports AutoDev and target prompt scopes', async () => {
  const source = await readWorkflow('run-prompt.yml');
  const runner = await readWorkflow('_agent-open-pr-and-ping.yml');
  assert.match(source, /prompt_scope/);
  assert.match(runner, /prompt_path must be a repository-relative \.agents\/prompts\/\*\.md path/);
  assert.match(source, /repository: \$\{\{ inputs\.target_repository \}\}/);
  assert.match(source, /uses: \.\/\.github\/workflows\/_agent-open-pr-and-ping\.yml/);
  assert.match(source, /prompt_scope:/);
  assert.match(source, /prompt_path:/);
});

test('generic prompt catalog contains only repository-agnostic Markdown prompts', async () => {
  for (const prompt of config.prompts) {
    assert.equal(prompt.scope, 'autodev', prompt.name);
    assert.match(prompt.path, /^\.agents\/prompts\/[^/]+\.md$/u, prompt.name);
    const source = await readPrompt(path.basename(prompt.path));
    assert.ok(source.trim().length > 0, prompt.name);
  }
});

test('central provider invocations accept target repository and PR number', async () => {
  for (const name of ['claude-invoke.yml', 'gemini-invoke.yml', 'qwen-invoke.yml', 'minimax-invoke.yml', 'minimax-codex-invoke.yml']) {
    const source = await readWorkflow(name);
    assert.match(source, /workflow_dispatch:/, name);
    assert.match(source, /target_repository:/, name);
    assert.match(source, /pr_number:/, name);
    assert.match(source, /github\.event_name == 'workflow_dispatch'/, name);
  }
});

test('target-aware reusable workflows use the PAT checkout', async () => {
  const openPr = await readWorkflow('_agent-open-pr-and-ping.yml');
  const invoke = await readWorkflow('agent-invoke.yml');
  assert.match(openPr, /repository: \$\{\{ inputs\.target_repository \}\}/);
  assert.match(openPr, /GH_USER_TOKEN does not have push permission/);
  assert.match(invoke, /repository: \$\{\{ inputs\.target_repository \}\}/);
  assert.match(invoke, /REPOSITORY: \$\{\{ inputs\.target_repository \}\}/);
});

test('AutoDev CI is repository-native rather than GMLoop-specific', async () => {
  const source = await readWorkflow('copilot-setup-steps.yml');
  assert.match(source, /npm test/);
  assert.match(source, /npm run test:python/);
  assert.doesNotMatch(source, /pnpm run build:ts/);
  assert.doesNotMatch(source, /node-version-file: \.nvmrc/);
});

test('target auto-merge requires completed target check evidence', async () => {
  const source = await readWorkflow('target-automerge.yml');
  assert.match(source, /target_repository:/);
  assert.match(source, /pr_number:/);
  assert.match(source, /checks\.listForRef/);
  assert.match(source, /listCommitStatusesForRef/);
  assert.match(source, /hasEvidence/);
  assert.match(source, /pulls\.merge/);
  assert.match(source, /GH_USER_TOKEN/);
});
