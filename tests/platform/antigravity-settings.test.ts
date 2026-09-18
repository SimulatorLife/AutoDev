import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  antigravitySkillsStatus,
  DENIED_COMMAND_PERMISSIONS,
  expectedPermissionGrants,
  missingAntigravityPermissions,
  normalizedReadRoots,
  updateAntigravityPermissions,
  updateAntigravitySkills,
} from '../../src/platform/antigravity-settings.ts';

function withTempDir<T>(callback: (directory: string) => T): T {
  const directory = mkdtempSync(join(tmpdir(), 'autodev-antigravity-settings-'));
  try { return callback(directory); }
  finally { rmSync(directory, { recursive: true, force: true }); }
}

test('normalizes Antigravity read roots without allowing duplicates', () => withTempDir((directory) => {
  const home = join(directory, 'home');
  const workspace = join(directory, 'workspace');
  assert.deepEqual(normalizedReadRoots([workspace, workspace, '~/project'], home), [workspace, join(home, 'project')]);
  assert.deepEqual(expectedPermissionGrants([workspace], home).slice(-6), [
    `read_file(${workspace})`, `read_file(${workspace}/**)`,
    `read_file(${join(home, '.agents')})`, `read_file(${join(home, '.agents')}/**)`,
    `read_file(${join(home, '.codex')})`, `read_file(${join(home, '.codex')}/**)`,
  ]);
}));

test('permission update preserves user grants, removes disabled Playwright grants, populates deny list, and is idempotent', () => withTempDir((directory) => {
  const path = join(directory, 'settings.json');
  const home = join(directory, 'home');
  writeFileSync(path, JSON.stringify({ permissions: { allow: ['user-grant', 'mcp(playwright)', 'mcp(playwright/*)'] }, other: true }));
  assert.deepEqual(missingAntigravityPermissions(path, [directory], home).slice(-4), [...DENIED_COMMAND_PERMISSIONS]);
  updateAntigravityPermissions(path, [directory], home);
  const first = readFileSync(path, 'utf8');
  updateAntigravityPermissions(path, [directory, directory], home);
  const second = readFileSync(path, 'utf8');
  assert.equal(second, first);
  const config = JSON.parse(second) as { permissions: { allow: string[]; deny: string[] }; other: boolean };
  assert.equal(config.other, true);
  assert.deepEqual(config.permissions.allow.filter((entry) => entry.startsWith('mcp(playwright')), []);
  assert.equal(config.permissions.allow.filter((entry) => entry === `read_file(${directory})`).length, 1);
  assert.deepEqual(config.permissions.deny, [...DENIED_COMMAND_PERMISSIONS]);
  assert.deepEqual(missingAntigravityPermissions(path, [directory], home), []);
}));

test('skill update replaces managed and obsolete entries while preserving unrelated entries', () => withTempDir((directory) => {
  const path = join(directory, 'skills.json');
  const expected = join(directory, 'canonical');
  const obsolete = join(directory, 'obsolete');
  const unrelated = { path: join(directory, 'unrelated'), include_only: ['mine'] };
  writeFileSync(path, JSON.stringify({ entries: [
    { path: obsolete, include_only: ['ccc'] },
    { path: expected, include_only: ['old'] },
    unrelated,
  ] }));
  updateAntigravitySkills(path, expected, [obsolete]);
  const config = JSON.parse(readFileSync(path, 'utf8')) as { entries: { path: string; include_only: string[] }[] };
  assert.deepEqual(config.entries, [unrelated, { path: expected, include_only: ['ccc', 'lsp-mcp-server', 'orchestration'] }]);
  assert.deepEqual(antigravitySkillsStatus(path, expected, [obsolete]), { missing: false, stale: [] });
}));

test('skill status reports stale and missing registrations', () => withTempDir((directory) => {
  const path = join(directory, 'skills.json');
  const expected = join(directory, 'canonical');
  const obsolete = join(directory, 'obsolete');
  writeFileSync(path, JSON.stringify({ entries: [{ path: obsolete, include_only: ['ccc'] }] }));
  assert.deepEqual(antigravitySkillsStatus(path, expected, [obsolete]), { missing: true, stale: [obsolete] });
}));
