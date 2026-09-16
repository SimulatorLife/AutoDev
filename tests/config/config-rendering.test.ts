import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parse } from 'smol-toml';
import test from 'node:test';
import { compose } from '../../src/config/compose-user-config.ts';
import { renderBridgeMcpCatalogue } from '../../src/config/render-bridge-mcp-catalogue.ts';
import { atomicWrite, serializeToml, type TomlTable } from '../../src/config/toml.ts';

test('TOML serialization is parseable and ends with one newline', () => {
  const input: TomlTable = { z: 'last', a: true, nested: { value: 2 } };
  const output = serializeToml(input);
  assert.equal(output.endsWith('\n'), true);
  assert.equal(output.endsWith('\n\n'), false);
  assert.deepEqual(parse(output), input);
});

test('composition preserves local state while AutoDev-owned keys win', () => {
  const result = compose(
    { owner: 'autodev', hooks: { generated: true }, mcp_servers: { lsp: { command: 'lsp' } } },
    { owner: 'local', hooks: { state: { disabled: true }, stale: true }, notify: 'desktop', mcp_servers: { custom: { command: 'custom' } } },
  );
  assert.equal(result.owner, 'autodev');
  assert.deepEqual(result.hooks, { state: { disabled: true } });
  assert.deepEqual(result.mcp_servers, { lsp: { command: 'lsp' }, custom: { command: 'custom' } });
  assert.equal(result.notify, 'desktop');
});

test('atomic writes replace the target without leaving temporary files', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'autodev-config-'));
  try {
    const output = join(directory, 'config.toml');
    atomicWrite(output, 'value = 1\n');
    assert.equal(await readFile(output, 'utf8'), 'value = 1\n');
    assert.deepEqual(await readdir(directory), ['config.toml']);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('bridge MCP catalogues are deterministic and sorted', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'autodev-mcp-'));
  try {
    const source = join(directory, 'mcp.toml');
    await writeFile(source, '[mcp_servers.zed]\ncommand = "z"\n\n[mcp_servers.alpha]\ncommand = "a"\nargs = ["--stdio"]\n');
    assert.equal(renderBridgeMcpCatalogue(source), '{\n  "alpha": {\n    "command": "a",\n    "args": [\n      "--stdio"\n    ]\n  },\n  "zed": {\n    "command": "z"\n  }\n}\n');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
