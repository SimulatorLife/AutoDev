import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, relative, resolve } from 'node:path';
import test from 'node:test';
import { parse } from 'smol-toml';

const REPO_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const CLAUDE_TOKEN = 'CLAUDE_CODE_OAUTH_TOKEN';
const REVIEWED_CLAUDE_TOKEN_CONSUMERS = new Set([
  'src/providers/claude.ts',
  'scripts/run-codex-claude-bridge.sh',
  'scripts/ensure-codex-claude-bridge.sh',
  '.github/workflows/claude-invoke.yml',
  'scripts/codex/run-ci-provider.sh',
  '.github/workflows/agent-invoke.yml',
]);
const UNSUPPORTED_SUBSCRIPTION_TRANSPORTS = new Map([
  ['copilot_internal', 'undocumented GitHub Copilot token endpoint'],
  ['Iv1.b507a08c87ecfe98', 'Copilot editor OAuth client id reused by LiteLLM'],
  ['api.githubcopilot.com', 'Copilot model endpoint reached without the Copilot CLI'],
  ['github_copilot/', 'LiteLLM GitHub Copilot provider route'],
  ['cloudcode-pa.googleapis.com', 'Antigravity/Gemini CLI OAuth backend reached without agy'],
]);

type JsonRecord = Record<string, any>;

type RuntimeTexts = Record<string, string>;

function trackedRuntimeTexts(): RuntimeTexts {
  const listed = execFileSync('git', ['ls-files'], { cwd: REPO_ROOT, encoding: 'utf8' });
  const texts: RuntimeTexts = {};
  for (const path of listed.split('\n').filter(Boolean)) {
    if (path.startsWith('docs/') || path.startsWith('tests/') || path.endsWith('.md')) continue;
    try { texts[path] = readFileSync(join(REPO_ROOT, path), 'utf8'); } catch { /* deleted or binary */ }
  }
  return texts;
}

function route(provider: string): string {
  const routing = readFileSync(join(REPO_ROOT, 'src/router/routing.ts'), 'utf8');
  const match = routing.match(new RegExp(`\\{ provider: ['"]${provider}['"],[^\\n]*\\}`));
  assert.ok(match, `router route for ${provider}`);
  return match[0];
}

const texts = trackedRuntimeTexts();
const router = readFileSync(join(REPO_ROOT, 'scripts/codex-model-router.mjs'), 'utf8');

for (const [needle, reason] of UNSUPPORTED_SUBSCRIPTION_TRANSPORTS) {
  test(`no runtime file uses ${reason}`, () => {
    assert.deepEqual(Object.keys(texts).filter((path) => texts[path]?.includes(needle)), []);
  });
}

test('every Codex model provider targets a local adapter', () => {
  const config = parse(readFileSync(join(REPO_ROOT, 'scripts/codex/config.autodev.toml'), 'utf8')) as JsonRecord;
  const providers = (config.model_providers ?? {}) as JsonRecord;
  for (const [name, provider] of Object.entries(providers)) {
    assert.match(String((provider as JsonRecord).base_url ?? ''), /^http:\/\/127\.0\.0\.1:\d+\/v1$/, name);
  }
});

test('only reviewed runtime files reference the Claude subscription token', () => {
  const consumers = new Set(Object.keys(texts).filter((path) => texts[path]?.includes(CLAUDE_TOKEN)));
  assert.deepEqual(consumers, REVIEWED_CLAUDE_TOKEN_CONSUMERS);
});

test('the Claude bridge hands the token only to the Claude Code binary', () => {
  const source = readFileSync(join(REPO_ROOT, 'src/providers/claude.ts'), 'utf8');
  assert.match(source, /CLI\s*=.*claude/);
  assert.doesNotMatch(source, /anthropic\.com/);
  assert.match(route('claude'), /baseUrl: 'http:\/\/127\.0\.0\.1:4000\/v1'/);
  assert.doesNotMatch(router, /anthropic\.com/);
});

test('CI runs the pinned official Claude Code package', () => {
  const manifest = JSON.parse(readFileSync(join(REPO_ROOT, '.github/ci/provider-tools.json'), 'utf8')) as JsonRecord;
  assert.match(String(manifest.tools.claude.package), /^@anthropic-ai\/claude-code@\d+\.\d+\.\d+$/);
  const branch = texts['scripts/codex/run-ci-provider.sh']!.split('  claude)', 2)[1]!.split(';;', 1)[0]!;
  assert.match(branch, /pnpm --silent dlx "\$AUTODEV_CLAUDE_PACKAGE"/);
});

test('Copilot and Antigravity bridges run their official CLIs', () => {
  assert.match(texts['src/providers/copilot.ts']!, /spawn\(process\.env\.COPILOT_BIN \?\? "copilot", args/);
  assert.match(texts['src/providers/antigravity.ts']!, /const CLI = process\.env\.AGY_CLI_PATH/);
  assert.match(texts['src/providers/antigravity.ts']!, /spawn\(CLI, agyArgs\(/);
  assert.match(route('copilot'), /baseUrl: 'http:\/\/127\.0\.0\.1:4003\/v1'/);
  assert.match(route('antigravity'), /baseUrl: 'http:\/\/127\.0\.0\.1:4002\/v1'/);
});
