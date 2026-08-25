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
  assert.match(source, /prompt_repository: item\.promptRepository/);
  assert.match(source, /workflow_id: 'run-prompt\.yml'/);
  assert.match(source, /promptRepository[\s\S]*SimulatorLife\/AutoDev/);
});

test('generic prompt runner supports AutoDev and target prompt scopes', async () => {
  const source = await readWorkflow('run-prompt.yml');
  const runner = await readWorkflow('_agent-open-pr-and-ping.yml');
  assert.match(source, /prompt_repository/);
  assert.match(runner, /prompt_path must be a repository-relative \.agents\/prompts\/\*\.md path/);
  assert.match(source, /repository: \$\{\{ inputs\.target_repository \}\}/);
  assert.match(source, /uses: \.\/\.github\/workflows\/_agent-open-pr-and-ping\.yml/);
  assert.match(source, /prompt_repository:/);
  assert.match(source, /SimulatorLife\/RacingGame/);
  assert.match(source, /prompt_path:/);
});

test('generic prompt catalog contains only repository-agnostic Markdown prompts', async () => {
  for (const prompt of config.prompts) {
    assert.equal(prompt.promptRepository ?? 'SimulatorLife/AutoDev', 'SimulatorLife/AutoDev', prompt.name);
    assert.match(prompt.path, /^\.agents\/prompts\/[^/]+\.md$/u, prompt.name);
    const source = await readPrompt(path.basename(prompt.path));
    assert.ok(source.trim().length > 0, prompt.name);
  }
});

test('generic prompt catalog includes the migrated organization-wide inventory', async () => {
  assert.equal(config.prompts.length, 53);
  for (const prompt of config.prompts) {
    assert.equal(Object.hasOwn(prompt, 'promptRepository'), false, prompt.name);
    assert.equal(Object.hasOwn(prompt, 'sourceWorkflow'), false, prompt.name);
  }
  const forbiddenTargetAssumptions = /\b(?:GMLoop|GameMaker|pnpm)\b|@gml|\.gml\b/iu;
  for (const prompt of config.prompts) {
    const source = await readPrompt(path.basename(prompt.path));
    assert.doesNotMatch(source, forbiddenTargetAssumptions, prompt.name);
  }
});

test('central provider invocations accept target repository and PR number', async () => {
  for (const name of ['claude-invoke.yml', 'gemini-invoke.yml', 'qwen-invoke.yml', 'minimax-invoke.yml', 'minimax-codex-invoke.yml']) {
    const source = await readWorkflow(name);
    assert.match(source, /workflow_dispatch:/, name);
    assert.match(source, /target_repository:/, name);
    assert.match(source, /pr_number:/, name);
    if (name !== 'minimax-invoke.yml') assert.match(source, /github\.event_name == 'workflow_dispatch'/, name);
  }
});

test('target-aware reusable workflows use the PAT checkout', async () => {
  const openPr = await readWorkflow('_agent-open-pr-and-ping.yml');
  const invoke = await readWorkflow('agent-invoke.yml');
  assert.match(openPr, /repository: \$\{\{ inputs\.target_repository \}\}/);
  assert.match(openPr, /GH_USER_TOKEN does not have push permission/);
  assert.match(invoke, /repository: \$\{\{ inputs\.target_repository \}\}/);
  assert.match(invoke, /REPOSITORY: \$\{\{ inputs\.target_repository \}\}/);
  assert.match(invoke, /gh api --paginate --slurp.*repos\/\$\{REPOSITORY\}\/issues\/\$\{PR_NUMBER\}\/comments/);
  assert.match(invoke, /No \$\{mention\} task comment was found/);
  assert.match(invoke, /Detect target repository toolchain/);
  assert.match(invoke, /Read AutoDev package manager version/);
  assert.match(invoke, /Setup pnpm for provider tooling/);
  assert.ok(invoke.includes('node-version-file: ../../_temp/autodev.nvmrc'));
  assert.match(invoke, /elif \[ -f package-lock\.json \] \|\| \[ -f npm-shrinkwrap\.json \]/);
  assert.match(await readWorkflow('target-validation.yml'), /node-version-file: \.\.\/\.\.\/_temp\/autodev\.nvmrc/);
});

test('AutoDev CI is repository-native and pnpm-native', async () => {
  const packageJson = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  assert.equal(packageJson.packageManager, 'pnpm@10.32.1');
  assert.ok((await readFile(path.join(root, 'pnpm-lock.yaml'), 'utf8')).startsWith('lockfileVersion:'));
  const profiles = JSON.parse(await readFile(path.join(root, '.github', 'ci', 'validation-profiles.json'), 'utf8'));
  const profile = profiles['SimulatorLife/AutoDev'];
  assert.equal(profile.packageManager, 'pnpm');
  assert.equal(profile.pnpmVersion, undefined);
  for (const [key, item] of Object.entries(profiles)) {
    assert.equal(item.pnpmVersion, undefined, `pnpmVersion present in profile ${key}`);
  }
  assert.deepEqual(profile.commands.map(({ run }) => run), ['pnpm test', 'pnpm run test:python']);
  const source = await readWorkflow('copilot-setup-steps.yml');
  assert.match(source, /uses: pnpm\/action-setup@v6/);
  assert.match(source, /cache: pnpm/);
  assert.match(source, /pnpm install --frozen-lockfile/);
  assert.match(source, /pnpm test/);
  assert.match(source, /pnpm run test:python/);
  assert.doesNotMatch(source, /\bnpm\b/);
  assert.match(source, /node-version-file: \.nvmrc/);
});

test('central target PR janitor owns empty stale PR cleanup', async () => {
  const source = await readWorkflow('target-pr-janitor.yml');
  assert.match(source, /workflow_dispatch:/);
  assert.match(source, /SimulatorLife\/Colourful-Life/);
  assert.match(source, /weights\.json/);
  assert.match(source, /pulls\.list/);
  assert.match(source, /changed_files/);
  assert.match(source, /pulls\.update/);
  assert.match(source, /git\.deleteRef/);
  assert.match(source, /secrets\.GH_USER_TOKEN/);
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

test('MiniMax invocation configures headless OpenAI-compatible authentication', async () => {
  const source = await readWorkflow('minimax-invoke.yml');
  assert.match(source, /--auth-type openai/);
  assert.match(source, /--openai-api-key/);
  assert.match(source, /--openai-base-url/);
  assert.match(source, /pnpm --silent dlx @qwen-code\/qwen-code/);
  assert.doesNotMatch(source, /\bnpx\b/);
});

test('local provider tooling uses pnpm dlx', async () => {
  const source = await readFile(path.join(root, 'scripts', 'codex', 'config.toml'), 'utf8');
  assert.match(source, /command = "pnpm"/);
  assert.match(source, /args = \["dlx", "@playwright\/mcp@latest"\]/);
  assert.doesNotMatch(source, /\bnpx\b/);
});

test('private target validation clones through AutoDev and reports target status', async () => {
  const source = await readWorkflow('target-validation.yml');
  assert.match(source, /Checkout private target through AutoDev PAT/);
  assert.match(source, /Detect target package manager version/);
  assert.match(source, /if: \$\{\{ steps\.profile\.outputs\.package_manager == 'pnpm' \}\}/);
  assert.match(source, /packageManager as pnpm@<version>/);
  assert.match(source, /version: \$\{\{ steps\.toolchain\.outputs\.pnpm_version \}\}/);
  assert.match(source, /repository: \$\{\{ inputs\.target_repository \}\}/);
  assert.match(source, /token: \$\{\{ secrets\.GH_USER_TOKEN \}\}/);
  assert.match(source, /autodev\/validation/);
  assert.match(source, /run_browser/);
});

test('private target auto-merge trusts only AutoDev validation status', async () => {
  const source = await readWorkflow('target-automerge.yml');
  assert.match(source, /autodev\/validation/);
  assert.match(source, /autoDevValidation/);
  assert.match(source, /autoDevValidation\.state === 'success'/);
});

test('manual repository selectors expose the complete SimulatorLife choice list', async () => {
  const expected = ['SimulatorLife/3DSpider', 'SimulatorLife/AutoDev', 'SimulatorLife/Colourful-Life', 'SimulatorLife/GMLoop', 'SimulatorLife/RacingGame'];
  for (const name of ['run-prompt.yml', 'agent-01-custom-prompt.yml', 'target-validation.yml', 'target-automerge.yml', 'minimax-invoke.yml', 'claude-invoke.yml', 'gemini-invoke.yml', 'minimax-codex-invoke.yml', 'qwen-invoke.yml']) {
    const source = await readWorkflow(name);
    if (!source.includes('target_repository:')) continue;
    assert.match(source, /type: choice/, name);
    for (const repository of expected) assert.match(source, new RegExp(repository.replace('/', '\\/')), name);
  }
});

test('manual repository selectors keep each choice as a distinct option', async () => {
  const expected = ['SimulatorLife/3DSpider', 'SimulatorLife/AutoDev', 'SimulatorLife/Colourful-Life', 'SimulatorLife/GMLoop', 'SimulatorLife/RacingGame'];
  const optionBlock = expected.map((repository) => `          - ${repository}`).join('\n');
  for (const name of ['run-prompt.yml', 'agent-01-custom-prompt.yml', 'target-validation.yml', 'target-automerge.yml', 'minimax-invoke.yml', 'claude-invoke.yml', 'gemini-invoke.yml', 'minimax-codex-invoke.yml', 'qwen-invoke.yml']) {
    const source = await readWorkflow(name);
    if (source.includes('options: *simulator_life_repositories')) {
      assert.match(source, new RegExp(`options: &simulator_life_repositories\n${optionBlock.replaceAll('\n', '\\n')}`), name);
      continue;
    }
    assert.match(source, new RegExp(`options:\n(?:          - all\n)?${optionBlock.replaceAll('\n', '\\n')}`), name);
  }
});

test('validation profile selection is derived from target_repository', async () => {
  const source = await readWorkflow('target-validation.yml');
  assert.doesNotMatch(source, /validation_profile:/);
  assert.match(source, /validation-profiles\.json/);
  assert.match(source, /--arg repo/);
});

test('agent invocation interface omits unused compatibility inputs', async () => {
  const source = await readWorkflow('agent-invoke.yml');
  assert.doesNotMatch(source, /\n      target_sha:/);
  assert.doesNotMatch(source, /\n      working_branch:/);
});

test('Node actions use the AutoDev root .nvmrc', async () => {
  const nvmrc = await readFile(path.join(root, '.nvmrc'), 'utf8');
  assert.equal(nvmrc.trim(), '22');
  for (const name of ['copilot-setup-steps.yml', 'agent-invoke.yml', 'target-validation.yml']) {
    const source = await readWorkflow(name);
    assert.doesNotMatch(source, /node-version:\s*["']22["']/u, name);
    assert.match(source, /node-version-file:/u, name);
  }
});
