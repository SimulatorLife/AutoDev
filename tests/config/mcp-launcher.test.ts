import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { resolveMcpCommand, runMcp } from '../../src/mcp/launcher.ts';

test('MCP launcher resolves pinned AutoDev binaries without shell commands', () => {
  assert.deepEqual(resolveMcpCommand('lsp', '/repo'), { binary: '/repo/node_modules/.bin/lsp-mcp-server', args: [] });
  assert.deepEqual(resolveMcpCommand('playwright', '/repo'), { binary: '/repo/node_modules/.bin/playwright-mcp', args: [] });
  assert.deepEqual(resolveMcpCommand('cocoindex-code', '/repo', { AUTODEV_COCOINDEX_BIN: '/custom/ccc' }), { binary: '/custom/ccc', args: ['mcp'] });
});

test('MCP launcher rejects unknown tools', () => {
  assert.throws(() => resolveMcpCommand('unknown', '/repo'), /unsupported AutoDev MCP/);
});

test('runMcp auto-initializes cocoindex-code if .cocoindex_code is absent', () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'autodev-mcp-launcher-'));
  const prevCwd = process.cwd();
  try {
    const mockBin = join(tempDir, 'mock-ccc');
    writeFileSync(mockBin, '#!/usr/bin/env bash\nif [ "$1" = "init" ]; then mkdir -p .cocoindex_code; fi\nexit 0\n');
    chmodSync(mockBin, 0o755);

    process.chdir(tempDir);
    assert.equal(existsSync(join(tempDir, '.cocoindex_code')), false);

    const status = runMcp('cocoindex-code', tempDir, { ...process.env, AUTODEV_COCOINDEX_BIN: mockBin });
    assert.equal(status, 0);
    assert.equal(existsSync(join(tempDir, '.cocoindex_code')), true);
  } finally {
    process.chdir(prevCwd);
    rmSync(tempDir, { recursive: true, force: true });
  }
});
