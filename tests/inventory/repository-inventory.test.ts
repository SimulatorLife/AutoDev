import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

const root = new URL('../../', import.meta.url);
const trackedFiles = execFileSync('git', ['ls-files', '-co', '--exclude-standard', '-z'], {
  cwd: root,
  encoding: 'utf8',
})
  .split('\0')
  .filter(Boolean)
  .filter((file) => existsSync(join(new URL('../../', import.meta.url).pathname, file)));

const approvedLegacyFiles = new Set([
  '.rulesync/skills/resolve-merge-conflicts/scripts/extract_conflict_context.py',
  'install.sh',
  'scripts/enforce-root-delegation.sh',
  'scripts/ensure-codex-antigravity-proxy.sh',
  'scripts/ensure-codex-claude-bridge.sh',
  'scripts/ensure-codex-copilot-proxy.sh',
  'scripts/ensure-codex-minimax-proxy.sh',
  'scripts/ensure-codex-model-router.sh',
  'scripts/otel/ensure-autodev-otel-collector.sh',
  'scripts/otel/provision-autodev-otel-collector.sh',
  'scripts/otel/run-autodev-otel-collector.sh',
  'scripts/run-autodev-mcp.sh',
  'scripts/run-ci-provider.sh',
  'scripts/run-codex-antigravity-proxy.sh',
  'scripts/run-codex-claude-bridge.sh',
  'scripts/run-codex-copilot-cli-responses-proxy.sh',
  'scripts/run-codex-model-router.sh',
  'scripts/run-provider-agent.sh',
]);

const forbiddenImplementationFiles = trackedFiles.filter((file) => {
  if (approvedLegacyFiles.has(file)) return false;
  return /\.(?:c?js|mjs|py|sh)$/u.test(file);
});

test('first-party implementation inventory uses native TypeScript', { skip: process.env.AUTODEV_ENFORCE_INVENTORY !== '1' }, () => {
  assert.deepEqual(
    forbiddenImplementationFiles,
    [],
    `legacy implementation files remain:\n${forbiddenImplementationFiles.join('\n')}`,
  );
});

test('approved non-TypeScript files remain explicit and bounded', () => {
  assert.deepEqual(
    trackedFiles.filter((file) => /\.(?:c?js|mjs|py|sh)$/u.test(file) && approvedLegacyFiles.has(file)).sort(),
    [...approvedLegacyFiles].sort(),
  );
});
