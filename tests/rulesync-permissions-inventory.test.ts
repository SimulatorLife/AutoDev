import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'smol-toml';
import test from 'node:test';

type JsonObject = Record<string, unknown>;
const repositoryRoot = fileURLToPath(new URL('../', import.meta.url));
const read = (relativePath: string): string => readFileSync(join(repositoryRoot, relativePath), 'utf8');
const readJson = (relativePath: string): JsonObject => JSON.parse(read(relativePath)) as JsonObject;
const asObject = (value: unknown): JsonObject => {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value));
  return value as JsonObject;
};

const portableConfig = parse(read('scripts/codex/config.autodev.toml')) as unknown as JsonObject;
const rulesyncMcp = readJson('.rulesync/mcp.jsonc');

test('Codex portable permission surface is explicit', () => {
  assert.equal(portableConfig.approval_policy, 'never');
  assert.equal(portableConfig.sandbox_mode, 'workspace-write');
  assert.equal(portableConfig.approvals_reviewer, 'user');
  assert.equal(asObject(portableConfig.sandbox_workspace_write).network_access, true);
  assert.equal(asObject(portableConfig.tools).web_search, true);
  assert.equal(asObject(portableConfig.features).hooks, true);
  assert.equal(Object.hasOwn(asObject(portableConfig.features), 'permissions'), false);
  for (const provider of Object.values(asObject(portableConfig.model_providers))) {
    assert.equal(asObject(provider).wire_api, 'responses');
  }
  assert.equal(Object.hasOwn(portableConfig, 'mcp_servers'), false);
  for (const server of Object.values(asObject(asObject(rulesyncMcp).codexcli).mcpServers as JsonObject)) {
    const settings = asObject(server);
    if (Object.hasOwn(settings, 'command')) assert.equal(settings.default_tools_approval_mode, 'approve');
  }
});

test('Claude bridge permission policy remains role-aware', () => {
  const source = read('src/providers/claude.ts');
  for (const marker of [
    'DISALLOWED_CLAUDE_TOOLS = [ "Agent", "Task" ]',
    'DISALLOWED_CLI_COMMANDS = [ "Bash(ccc *)" ]',
    'CROSS_SESSION_CLAUDE_TOOLS = [ "SendMessage", "ListAgents" ]',
    'CLAUDE_RESEARCH_ALLOWED_TOOLS = [ "WebSearch", "WebFetch" ]',
    'PLAYWRIGHT_AGENT_ROLES', 'PLAYWRIGHT_DISALLOWED_TOOLS', 'RESEARCH_CAPABLE_ROLES',
    'denied.push("Bash", "Edit", "Write", "NotebookEdit")', '"--allowed-tools"',
    '"--permission-mode"', 'CLAUDE_CODE_PERMISSION_MODE ?? "bypassPermissions"',
  ]) assert.ok(source.includes(marker), marker);
});

test('Antigravity permissions are dynamic and machine-local', () => {
  const source = read('src/platform/antigravity-settings.ts');
  const materializer = read('src/platform/install-materializer.ts');
  assert.ok(materializer.includes('updateAntigravityPermissions'));
  for (const marker of [
    'updateAntigravityPermissions', 'missingAntigravityPermissions', 'const permissions = asObject(config.permissions)',
    'function permissionList(config: JsonObject)', 'normalizedReadRoots', 'read_file(${root})', 'read_file(${root}/**)',
    "join(home, '.agents')", "join(home, '.codex')", 'mcp(cocoindex-code)', 'mcp(lsp)', 'read_url(*)',
    'unsandboxed(pwd)', 'unsandboxed(pnpm test)', "unsandboxed(python3 -m unittest discover -s tests -p 'test_*.py')", 'mcp(playwright)',
  ]) assert.ok(source.includes(marker), marker);
  assert.ok(source.includes("openSync(temporary, 'wx'"));
  assert.ok(source.includes('renameSync(temporary, path)'));
});

test('Rulesync permissions and subagent generation remain deferred', () => {
  assert.equal(read('rulesync.jsonc').includes('"permissions"'), false);
  const rulesyncConfig = readJson('rulesync.jsonc');
  const features = rulesyncConfig.features as unknown[];
  assert.equal(features.includes('permissions'), false);
  assert.equal(features.includes('subagents'), false);
  assert.equal(existsSync(join(repositoryRoot, '.rulesync', 'subagents')), false);

  const contract = readJson('scripts/codex/execution-contract.json');
  const providers = asObject(contract.providers);
  assert.deepEqual(
    Object.fromEntries(['codex', 'claude', 'antigravity', 'copilot', 'minimax'].map((name) => [name, asObject(providers[name]).delegation])),
    { codex: 'native', claude: 'codex-shim', antigravity: 'codex-shim', copilot: 'codex-shim', minimax: 'none' },
  );
  const mcpTargets = asObject(rulesyncMcp);
  assert.ok(Object.hasOwn(asObject(asObject(mcpTargets['antigravity-cli']).mcpServers), 'autodev_spawn'));
  for (const target of ['codexcli', 'copilotcli']) assert.equal(Object.hasOwn(asObject(asObject(mcpTargets[target]).mcpServers), 'autodev_spawn'), false);
});

test('the permission inventory reads sources without changing them', () => {
  const paths = ['scripts/codex/config.autodev.toml', 'src/providers/claude.ts', 'scripts/codex/install-codex-integration.sh', 'rulesync.jsonc', '.rulesync/mcp.jsonc'];
  const before = paths.map(read);
  for (const content of before) assert.ok(content.length > 0);
  assert.deepEqual(paths.map(read), before);
});
