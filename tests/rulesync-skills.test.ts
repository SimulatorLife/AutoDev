import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import test from 'node:test';

type JsonObject = Record<string, unknown>;
type RunResult = ReturnType<typeof spawnSync>;

const repositoryRoot = fileURLToPath(new URL('../', import.meta.url));
const sourceRoot = join(repositoryRoot, '.rulesync', 'skills');
const installerPath = join(repositoryRoot, 'scripts', 'codex', 'install-codex-integration.sh');
const rulesyncConfigPath = join(repositoryRoot, 'rulesync.jsonc');
const driftWorkflowPath = join(repositoryRoot, '.github', 'workflows', 'rulesync-mcp-shadow-drift.yml');
const copilotSetupWorkflowPath = join(repositoryRoot, '.github', 'workflows', 'copilot-setup-steps.yml');
const targets = ['copilot', 'claudecode', 'codexcli', 'antigravity-cli'] as const;
const canonicalSkills = [
  'autodev-codex-request-capture', 'ccc', 'code-simplification', 'diagnosing-bugs',
  'doubt-driven-development', 'improve-codebase-architecture', 'lsp-mcp-server',
  'orchestration', 'remove-legacy-shims', 'resolve-merge-conflicts', 'writing-agent-skills',
] as const;
const repositorySkills: Record<string, readonly string[]> = {
  '.github/skills': ['autodev-codex-request-capture', 'ccc', 'lsp-mcp-server', 'orchestration'],
  '.claude/skills': ['autodev-codex-request-capture'],
  '.agents/skills': ['autodev-codex-request-capture'],
};

function readJson(path: string): JsonObject { return JSON.parse(readFileSync(path, 'utf8')) as JsonObject; }
function asObject(value: unknown): JsonObject {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value));
  return value as JsonObject;
}
function runRulesync(outputRoot: string, ...mode: string[]): RunResult {
  return spawnSync('pnpm', ['exec', 'rulesync', 'generate', '--config', 'rulesync.jsonc', '--output-roots', outputRoot, ...mode, '--silent'], { cwd: repositoryRoot, encoding: 'utf8', timeout: 60_000 });
}
function splitFrontmatter(text: string): [string, string] {
  const match = /^---\n(?<front>[\s\S]*?)\n---\n(?<body>[\s\S]*)$/u.exec(text);
  assert.ok(match?.groups?.front !== undefined && match.groups.body !== undefined, 'missing skill frontmatter');
  return [match.groups.front, match.groups.body.replace(/^\n+|\n+$/gu, '')];
}
function description(frontmatter: string): string {
  const folded = /^description:\s*>-\s*\n(?<body>(?:^[ \t].*\n?)+)/mu.exec(frontmatter);
  const single = /^description:\s*(?<value>.+)$/mu.exec(frontmatter);
  const value = folded?.groups?.body ?? single?.groups?.value;
  assert.ok(value !== undefined, 'missing skill description');
  return value.replace(/\s+/gu, ' ').trim().replace(/^['"]|['"]$/gu, '');
}
function files(directory: string): string[] {
  const output: string[] = [];
  const visit = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile()) output.push(relative(directory, path));
    }
  };
  visit(directory);
  return output.sort();
}

const temporaryRoot = mkdtempSync(join(tmpdir(), 'autodev-rulesync-skills-'));
const generated = join(temporaryRoot, 'generated');
const result = runRulesync(generated);
assert.equal(result.status, 0, `Rulesync skills generation failed: ${result.stdout}\n${result.stderr}`);
test.after(() => rmSync(temporaryRoot, { recursive: true, force: true }));

function generatedSkillPath(folder: string, skill: string): string { return join(generated, folder, skill, 'SKILL.md'); }

test('canonical source holds every skill', () => {
  const names = readdirSync(sourceRoot, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
  assert.deepEqual(names, [...canonicalSkills].sort());
  for (const skill of canonicalSkills) {
    const document = join(sourceRoot, skill, 'SKILL.md');
    assert.equal(lstatSync(document).isSymbolicLink(), false, skill);
    const [front] = splitFrontmatter(readFileSync(document, 'utf8'));
    assert.match(front, new RegExp(`^name: ${skill}$`, 'mu'));
    assert.doesNotMatch(front, /^description:\s*>/mu);
  }
  assert.equal(existsSync(join(sourceRoot, 'orchestration', 'agents', 'openai.yaml')), true);
});

test('only the canonical skill source is tracked', () => {
  const tracked = spawnSync('git', ['ls-files', '--', '.github/skills', '.claude/skills', '.agents/skills'], { cwd: repositoryRoot, encoding: 'utf8' }).stdout.split('\n').filter(Boolean);
  assert.deepEqual(tracked.filter((path) => path.includes('/skills/')), []);
  const ignored = readFileSync(join(repositoryRoot, '.gitignore'), 'utf8').split('\n').map((line) => line.trim());
  assert.ok(ignored.includes('/.github/skills/'));
  assert.ok(ignored.includes('/.claude/skills/'));
  assert.deepEqual(ignored.filter((line) => line.includes('.agents/skills') && !line.startsWith('#')), []);
});

test('each tool folder receives exactly its repository skills with bundled files', () => {
  for (const [folder, skills] of Object.entries(repositorySkills)) {
    const root = join(generated, folder);
    assert.deepEqual(readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort(), [...skills].sort(), folder);
    for (const skill of skills) {
      assert.deepEqual(files(join(root, skill)), files(join(sourceRoot, skill)), `${folder}/${skill}`);
      for (const relativePath of files(join(sourceRoot, skill))) {
        if (relativePath !== 'SKILL.md') assert.deepEqual(readFileSync(join(root, skill, relativePath)), readFileSync(join(sourceRoot, skill, relativePath)), `${folder}/${skill}/${relativePath}`);
      }
    }
  }
  assert.deepEqual(readdirSync(generated, { withFileTypes: true }).flatMap((entry) => entry.isDirectory() ? [entry.name] : []).flatMap((tool) => existsSync(join(generated, tool, 'skills')) ? [`${tool}/skills`] : []).sort(), Object.keys(repositorySkills).sort());
});

test('repository folders never duplicate user-level skills', () => {
  const materializer = readFileSync(join(repositoryRoot, 'src/platform/install-materializer.ts'), 'utf8');
  const match = /export const SKILLS = \[(.*?)\]/su.exec(materializer);
  assert.ok(match?.[1] !== undefined);
  const userLevel = new Set(match[1].match(/[A-Za-z0-9-]+/gu) ?? []);
  for (const folder of ['.claude/skills', '.agents/skills']) {
    const projected = new Set(readdirSync(join(generated, folder), { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name));
    assert.deepEqual([...projected].filter((skill) => userLevel.has(skill)), [], folder);
  }
});

test('generated documents preserve name, description, and body without targets', () => {
  for (const [folder, skills] of Object.entries(repositorySkills)) for (const skill of skills) {
    const [sourceFront, sourceBody] = splitFrontmatter(readFileSync(join(sourceRoot, skill, 'SKILL.md'), 'utf8'));
    const [front, body] = splitFrontmatter(readFileSync(generatedSkillPath(folder, skill), 'utf8'));
    assert.match(front, new RegExp(`^name: ${skill}$`, 'mu'));
    assert.equal(description(front), description(sourceFront));
    assert.doesNotMatch(front, /^targets:/mu);
    assert.equal(body, sourceBody);
  }
});

test('Rulesync check detects edited, stale, and missing generated skills', () => {
  assert.equal(runRulesync(generated, '--check').status, 0);
  for (const [label, damage] of [
    ['edited', (root: string) => readFileSync(join(root, '.github/skills/ccc/SKILL.md'), 'utf8') && requireWrite(join(root, '.github/skills/ccc/SKILL.md'), 'drift\n')],
    ['stale', (root: string) => { const path = join(root, '.github/skills/stale'); requireMkdir(path); requireWrite(join(path, 'SKILL.md'), 'x\n'); }],
    ['missing', (root: string) => requireRemove(join(root, '.claude/skills/autodev-codex-request-capture/SKILL.md'))],
  ] as const) {
    const root = join(temporaryRoot, label);
    mkdirForTest(root);
    assert.equal(runRulesync(root).status, 0, label);
    damage(root);
    assert.notEqual(runRulesync(root, '--check').status, 0, label);
  }
});

test('installer delegates repository skill generation and checking to typed materialization', () => {
  const installer = readFileSync(installerPath, 'utf8');
  const materializer = readFileSync(join(repositoryRoot, 'src/platform/install-materializer.ts'), 'utf8');
  assert.match(installer, /src\/cli\/install\.ts/);
  assert.match(materializer, /rulesync\.jsonc/);
  assert.match(materializer, /rulesync/);
  assert.match(materializer, /ensureExclude/);
  assert.match(materializer, /renderProviderSkillViews/);
});

test('Copilot cloud setup generates repository skills after installing dependencies', () => {
  const workflow = readFileSync(copilotSetupWorkflowPath, 'utf8');
  assert.ok(workflow.indexOf('pnpm install --frozen-lockfile') < workflow.indexOf('pnpm exec rulesync generate --targets copilot --silent'));
  assert.match(workflow, /- "\.rulesync\/\*\*"/);
});

test('Rulesync config generates only repository skills and CI runs the Rulesync suite', () => {
  const config = readJson(rulesyncConfigPath);
  assert.deepEqual(config.targets, [...targets]);
  assert.deepEqual(config.features, ['skills', 'hooks']);
  assert.deepEqual(config.outputRoots, ['.']);
  assert.equal(config.delete, true);
  assert.equal(config.global, false);
  const workflow = readFileSync(driftWorkflowPath, 'utf8');
  assert.match(workflow, /run: node --test tests\/rulesync-mcp\.test\.ts tests\/rulesync-hooks-shadow\.test\.ts tests\/rulesync-skills\.test\.ts tests\/rulesync-permissions-inventory\.test\.ts/);
  assert.equal(workflow.match(/- "tests\/rulesync-\*\.test\.ts"/g)?.length, 2);
  assert.doesNotMatch(workflow, /rulesync generate/);
  assert.deepEqual(readdirSync(join(repositoryRoot, 'tests', 'fixtures'), { withFileTypes: true }).filter((entry) => entry.name.startsWith('rulesync-')), []);
});

// Small wrappers keep filesystem assertions above explicit while retaining the
// test's synchronous setup/cleanup semantics.
function mkdirForTest(path: string): void { mkdirSync(path, { recursive: true }); }
function requireMkdir(path: string): void { mkdirSync(path, { recursive: true }); }
function requireWrite(path: string, text: string): boolean { writeFileSync(path, text); return true; }
function requireRemove(path: string): void { rmSync(path); }
