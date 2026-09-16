import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveMcpCommand } from '../../src/mcp/launcher.ts';

test('MCP launcher resolves pinned AutoDev binaries without shell commands', () => {
  assert.deepEqual(resolveMcpCommand('lsp', '/repo'), { binary: '/repo/node_modules/.bin/lsp-mcp-server', args: [] });
  assert.deepEqual(resolveMcpCommand('playwright', '/repo'), { binary: '/repo/node_modules/.bin/playwright-mcp', args: [] });
  assert.deepEqual(resolveMcpCommand('cocoindex-code', '/repo', { AUTODEV_COCOINDEX_BIN: '/custom/ccc' }), { binary: '/custom/ccc', args: ['mcp'] });
});

test('MCP launcher rejects unknown tools', () => {
  assert.throws(() => resolveMcpCommand('unknown', '/repo'), /unsupported AutoDev MCP/);
});
