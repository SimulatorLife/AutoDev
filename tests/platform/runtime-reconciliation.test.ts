import assert from 'node:assert/strict';
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { removeStalePaths, stalePaths } from '../../src/platform/runtime-reconciliation.ts';

function withTempDir<T>(callback: (directory: string) => T): T {
  const directory = mkdtempSync(join(tmpdir(), 'autodev-runtime-reconciliation-'));
  try { return callback(directory); }
  finally { rmSync(directory, { recursive: true, force: true }); }
}

test('stale path detection uses lstat and preserves input order', () => withTempDir((directory) => {
  const file = join(directory, 'file');
  const link = join(directory, 'link');
  const missing = join(directory, 'missing');
  writeFileSync(file, 'content');
  symlinkSync(join(directory, 'not-present'), link);
  assert.deepEqual(stalePaths([missing, link, file]), [link, file]);
}));

test('reconciliation removes obsolete files and symlinks without following links', () => withTempDir((directory) => {
  const file = join(directory, 'file');
  const link = join(directory, 'link');
  const outside = join(directory, 'outside');
  writeFileSync(file, 'content');
  writeFileSync(outside, 'keep');
  symlinkSync(outside, link);
  assert.deepEqual(removeStalePaths([file, link], 'obsolete-runtime-path'), [file, link]);
  assert.equal(lstatSync(file, { throwIfNoEntry: false }), undefined);
  assert.equal(lstatSync(link, { throwIfNoEntry: false }), undefined);
  assert.equal(readFileSync(outside, 'utf8'), 'keep');
}));

test('directory reconciliation recursively removes only real directories', () => withTempDir((directory) => {
  const obsolete = join(directory, 'obsolete');
  const nested = join(obsolete, 'nested');
  mkdirSync(nested, { recursive: true });
  writeFileSync(join(nested, 'file'), 'content');
  assert.deepEqual(removeStalePaths([obsolete], 'obsolete-runtime-directory'), [obsolete]);
  assert.equal(lstatSync(obsolete, { throwIfNoEntry: false }), undefined);
}));
