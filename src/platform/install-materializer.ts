import { execFileSync } from 'node:child_process';
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { renderAgentDirectory } from '../config/render-agent-configs.ts';
import { runBridgeMcpCatalogue } from '../config/render-bridge-mcp-catalogue.ts';
import { runCompose } from '../config/compose-user-config.ts';
import { renderProviderSkillViews } from '../config/render-provider-skill-views.ts';
import { atomicWrite, parseTomlFile, serializeToml, type TomlTable } from '../config/toml.ts';
import { linkRuntimeSource, linkSkillSource, materializeRuntimeFile, runtimeTarget } from './runtime-files.ts';
import { removeStalePaths } from './runtime-reconciliation.ts';
import { LaunchdClient } from './macos/launchd.ts';
import { renderLaunchAgent } from './macos/launchagent.ts';
import { updateAntigravityPermissions, updateAntigravitySkills } from './antigravity-settings.ts';

export const RUNTIME_MODULES = [
  'src/shared/resolve-workspace.ts', 'src/agents/bridge-role.ts', 'src/telemetry/agent-events.ts', 'src/agents/agent-activity.ts',
  'src/shared/provider-limits.ts', 'src/shared/responses-item-ids.ts', 'src/agents/spawn-tools.ts', 'src/router/state-collector.ts',
  'src/router/routing.ts', 'src/router/cooldown.ts', 'src/router/responses.ts', 'src/router/concurrency.ts', 'src/router/lifecycle.ts',
  'src/router/auth.ts', 'src/router/events.ts', 'src/router/subagents.ts', 'src/router/persistence.ts', 'src/router/usage.ts',
  'src/router/otel.ts', 'src/router/proxy.ts', 'src/router/http.ts', 'src/router/server.ts', 'src/agents/bridge-spawn-session.ts', 'src/providers/minimax.ts',
  'src/providers/copilot.ts', 'src/providers/antigravity.ts', 'src/providers/claude.ts', 'src/mcp/spawn-shim.ts', 'src/mcp/launcher.ts',
  'src/shared/execution-contract.ts', 'src/router/status.ts', 'src/cli/router-status.ts', 'config/execution-contract.json',
  'agents/prompts/base.md', 'agents/prompts/leaf.md', 'agents/prompts/code-search.md', 'agents/prompts/orchestrator.md',
  'src/hooks/command-utils.ts', 'src/hooks/skill-read-telemetry.ts', 'src/hooks/session-start.ts', 'src/hooks/subagent-start.ts',
  'src/platform/macos/launchd.ts', 'src/platform/macos/launchagent.ts', 'src/platform/router-ensure.ts', 'src/platform/copilot-ensure.ts',
  'src/platform/antigravity-ensure.ts', 'src/platform/claude-ensure.ts', 'src/platform/minimax-ensure.ts', 'src/platform/antigravity-settings.ts',
  'src/platform/runtime-files.ts', 'src/platform/runtime-reconciliation.ts', 'src/platform/service-restart.ts', 'src/platform/otel-collector.ts',
  'src/platform/otel-provision.ts', 'src/platform/install-state.ts', 'src/platform/dependencies.ts', 'src/platform/install-materializer.ts', 'src/platform/install-command.ts', 'src/platform/install-check.ts', 'src/hooks/root-delegation.ts',
  'src/hooks/block-ccc-cli.ts',
  '.rulesync/skills/orchestration/SKILL.md',
] as const;
export const OTEL_RUNTIME = ['scripts/otel/provision-autodev-otel-collector.sh', 'scripts/otel/ensure-autodev-otel-collector.sh', 'scripts/otel/run-autodev-otel-collector.sh'] as const;
export const HOOKS = ['enforce-root-delegation.sh', 'ensure-codex-antigravity-proxy.sh', 'ensure-codex-claude-bridge.sh', 'ensure-codex-copilot-proxy.sh', 'ensure-codex-model-router.sh', 'ensure-codex-minimax-proxy.sh', 'run-codex-antigravity-proxy.sh', 'run-codex-claude-bridge.sh', 'run-codex-copilot-cli-responses-proxy.sh', 'run-codex-model-router.sh'] as const;
export const DASHBOARD = ['codex-model-router-dashboard.html'] as const;
export const MCP_LAUNCHERS = ['run-autodev-mcp.sh'] as const;
export const PROFILES = ['claude', 'minimax', 'antigravity'] as const;
export const CATALOGS = ['claude', 'minimax', 'antigravity', 'codex'] as const;
export const ROLES = ['browser-tester', 'default', 'docs-researcher', 'explorer', 'smart', 'validator', 'worker'] as const;
export const PROMPT_ROLES = [...ROLES, 'orchestrator'] as const;
export const SKILLS = ['ccc', 'code-simplification', 'diagnosing-bugs', 'improve-codebase-architecture', 'lsp-mcp-server', 'orchestration', 'remove-legacy-shims', 'resolve-merge-conflicts'] as const;
export const LEGACY_SKILL_DIRS = ['skills', 'agents/skills'] as const;
export const RULES = ['default.rules'] as const;
export const LAUNCH_LABELS = ['com.codex.model-router', 'com.codex.claude-bridge', 'com.codex.minimax-proxy', 'com.codex.antigravity-proxy', 'com.codex.copilot-proxy', 'com.codex.otel-collector'] as const;
export const OBSOLETE_LAUNCH = ['com.codex.antigravity-litellm'] as const;
export const OBSOLETE_PATHS = ['.config/litellm/antigravity.yaml', '.codex/codex-antigravity-litellm-config.sha256'] as const;
export const OBSOLETE_HOOKS = ['codex-model-router.mjs', 'log-subagent-model.sh', 'run-codex-antigravity-litellm.sh', 'codex-minimax-responses-proxy.mjs', 'codex-copilot-cli-responses-proxy.mjs', 'codex-antigravity-cli-responses-proxy.mjs', 'codex-model-router-status.mjs', 'codex-claude-cli-responses-proxy.py'] as const;
export const OBSOLETE_DIRS = ['scripts', 'codex', 'codex/skills'] as const;
export const CANONICAL_HOOK_HASHES = {
  'pre_tool_use:0:0': 'sha256:5f1d5b28fdc75a6290e2dc8deecebe92ffaad5e7352e1122f02a1680e10f0567',
  'pre_tool_use:1:0': 'sha256:f81073b7b43edd2b08ba8a6f8a07d3f269326f0b133157c8f5367851c99167ce',
  'session_start:0:0': 'sha256:ffe71c68625270b1a58ea48db245f1a4f35f9071c086be5988514a329b14933d',
  'user_prompt_submit:0:0': 'sha256:e90b5998c2d5b47752bcb486784d5e66a32f92dbabda14b5d04e2f47282fe019',
  'subagent_start:0:0': 'sha256:d3796d1a79be308b1fd16b311ee343c7f0797c03f9a4fc267082ab2ffd53b596',
} as const;

export function syncHookTrust(configPath: string, codexHome: string, repositoryRoot: string): void {
  if (!exists(configPath)) return;
  const config = parseTomlFile(configPath, 'config', false);
  const hooksTable = (config.hooks && typeof config.hooks === 'object' && !Array.isArray(config.hooks))
    ? (config.hooks as TomlTable)
    : {};
  const stateTable = (hooksTable.state && typeof hooksTable.state === 'object' && !Array.isArray(hooksTable.state))
    ? (hooksTable.state as TomlTable)
    : {};

  for (const key of Object.keys(stateTable)) {
    if (key.includes('config.toml:')) delete stateTable[key];
  }

  const userHooksJson = join(codexHome, 'hooks.json');
  const projectHooksJson = join(repositoryRoot, '.codex', 'hooks.json');

  for (const [suffix, hash] of Object.entries(CANONICAL_HOOK_HASHES)) {
    stateTable[`${userHooksJson}:${suffix}`] = { trusted_hash: hash };
    if (exists(projectHooksJson)) {
      stateTable[`${projectHooksJson}:${suffix}`] = { trusted_hash: hash };
    }
  }

  hooksTable.state = stateTable;
  config.hooks = hooksTable;
  atomicWrite(configPath, serializeToml(config));
}

export function checkHookTrust(configPath: string, codexHome: string, repositoryRoot: string): boolean {
  if (!exists(configPath)) return false;
  try {
    const config = parseTomlFile(configPath, 'config', false);
    const hooksTable = (config.hooks && typeof config.hooks === 'object' && !Array.isArray(config.hooks))
      ? (config.hooks as TomlTable)
      : null;
    if (!hooksTable) return false;
    const stateTable = (hooksTable.state && typeof hooksTable.state === 'object' && !Array.isArray(hooksTable.state))
      ? (hooksTable.state as TomlTable)
      : null;
    if (!stateTable) return false;

    for (const key of Object.keys(stateTable)) {
      if (key.includes('config.toml:')) return false;
    }

    const userHooksJson = join(codexHome, 'hooks.json');
    const projectHooksJson = join(repositoryRoot, '.codex', 'hooks.json');

    for (const [suffix, hash] of Object.entries(CANONICAL_HOOK_HASHES)) {
      const userEntry = stateTable[`${userHooksJson}:${suffix}`] as { trusted_hash?: string } | undefined;
      if (userEntry?.trusted_hash !== hash) return false;
      if (exists(projectHooksJson)) {
        const projectEntry = stateTable[`${projectHooksJson}:${suffix}`] as { trusted_hash?: string } | undefined;
        if (projectEntry?.trusted_hash !== hash) return false;
      }
    }
    return true;
  } catch {
    return false;
  }
}

interface MaterializeOptions { repositoryRoot: string; home: string; codexHome: string; otelMode: string; materializeOnly: boolean; codexMcpSource: string; }

function commandAvailable(command: string): boolean { try { execFileSync('which', [command], { stdio: 'ignore' }); return true; } catch { return false; } }
function run(command: string, args: readonly string[], cwd: string): void { const result = execFileSync(command, [...args], { cwd, stdio: 'inherit' }); void result; }
function rulesync(options: MaterializeOptions, args: readonly string[]): void { run(join(options.repositoryRoot, 'node_modules/.bin/rulesync'), args, options.repositoryRoot); }
function ensureExclude(options: MaterializeOptions): void {
  const exclude = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-path', 'info/exclude'], { cwd: options.repositoryRoot, encoding: 'utf8' }).trim();
  mkdirSync(dirname(exclude), { recursive: true });
  const entries = ['/.agents/skills/', '/.codex/hooks.json', '/.claude/settings.json', '/.github/hooks/', '/.agents/hooks.json'];
  const existing = readFileSync(exclude, 'utf8');
  const missing = entries.filter((entry) => !existing.split(/\r?\n/u).includes(entry));
  if (missing.length) writeFileSync(exclude, `${existing}${existing.endsWith('\n') || existing.length === 0 ? '' : '\n'}${missing.join('\n')}\n`);
}
function roots(options: MaterializeOptions): string[] {
  const raw = process.env.AUTODEV_AGY_READ_ROOTS?.split(':').filter(Boolean) ?? [options.repositoryRoot];
  return [...new Set(raw.map((root) => root === '~' ? options.home : root.startsWith('~/') ? join(options.home, root.slice(2)) : root))];
}

export function materializeInstallation(options: MaterializeOptions): void {
  const hooks = join(options.codexHome, 'hooks'), agents = join(options.codexHome, 'agents'), rules = join(options.codexHome, 'rules'), userSkills = join(options.home, '.agents', 'skills'), skillsRoot = join(options.repositoryRoot, '.rulesync', 'skills');
  const launchd = new LaunchdClient();
  for (const label of OBSOLETE_LAUNCH) { try { launchd.bootout(label); } catch { /* obsolete job may not be loaded */ } }
  const obsoletePaths = [
    ...OBSOLETE_PATHS.map((path) => join(options.home, path)),
    join(hooks, 'codex/lib/codex-spawn-tools.mjs'),
    join(hooks, 'codex/lib/codex-state-collector.mjs'),
    join(hooks, 'codex/lib/spawn-shim-mcp.mjs'),
  ];
  removeStalePaths(obsoletePaths, 'obsolete-runtime-path');
  removeStalePaths(OBSOLETE_HOOKS.map((name) => join(hooks, name)), 'obsolete-runtime-hook');
  removeStalePaths(OBSOLETE_DIRS.map((name) => join(hooks, name)), 'obsolete-runtime-directory');
  const source = (path: string) => join(options.repositoryRoot, path);
  const target = (path: string) => runtimeTarget(path, options.codexHome, hooks);
  for (const path of RUNTIME_MODULES) materializeRuntimeFile(source(path), target(path), 0o644);
  for (const path of OTEL_RUNTIME) materializeRuntimeFile(source(path), target(path), 0o755);
  for (const role of PROMPT_ROLES) materializeRuntimeFile(source(`agents/prompts/roles/${role}.md`), target(`agents/prompts/roles/${role}.md`), 0o644);
  for (const name of HOOKS) { chmodSync(source(`scripts/${name}`), 0o755); materializeRuntimeFile(source(`scripts/${name}`), join(hooks, name), 0o755); }
  for (const name of DASHBOARD) materializeRuntimeFile(source(`scripts/${name}`), join(hooks, name), 0o644);
  for (const name of MCP_LAUNCHERS) linkRuntimeSource(source(`scripts/${name}`), join(hooks, name));
  for (const name of PROFILES) linkRuntimeSource(source(`config/profiles/${name}.config.toml`), join(options.codexHome, `${name}.config.toml`));
  for (const name of CATALOGS) linkRuntimeSource(source(`config/catalogs/${name}-model-catalog.json`), join(options.codexHome, `${name}-model-catalog.json`));
  for (const name of RULES) linkRuntimeSource(source(`agents/rules/${name}`), join(rules, name));
  for (const name of SKILLS) {
    for (const legacy of LEGACY_SKILL_DIRS) { const path = join(options.codexHome, legacy, name); if (exists(path) && !isSymlink(path)) throw new Error(`refusing to replace obsolete non-symlink skill path: ${path}`); if (isSymlink(path)) unlinkSync(path); }
    linkSkillSource(join(skillsRoot, name), join(userSkills, name));
  }
  mkdirSync(agents, { recursive: true, mode: 0o700 });
  const rendered = mkdtempSync(join(options.codexHome, '.autodev-rendered-agents-'));
  try { renderAgentDirectory(join(options.repositoryRoot, 'agents/roles'), join(options.repositoryRoot, 'agents/prompts'), rendered, options.codexMcpSource); for (const role of ROLES) materializeRuntimeFile(join(rendered, `${role}.toml`), join(agents, `${role}.toml`), 0o644); }
  finally { rmSync(rendered, { recursive: true, force: true }); }
  renderProviderSkillViews(source('config/execution-contract.json'), userSkills, join(options.codexHome, 'provider-runtime', 'claude'), 'claude');
  runBridgeMcpCatalogue(options.codexMcpSource, join(options.codexHome, 'provider-runtime', 'mcp-servers.json'));
  rulesync(options, ['generate', '--config', join(options.repositoryRoot, 'rulesync.jsonc'), '--silent']);
  ensureExclude(options);
  runCompose(source('config/config.autodev.toml'), options.codexMcpSource, join(options.codexHome, 'config.toml'), join(options.codexHome, 'config.toml'), false, options.otelMode);
  if (isSymlink(join(options.codexHome, 'config.toml'))) throw new Error(`refusing-symlinked-user-config ${join(options.codexHome, 'config.toml')}`);
  linkRuntimeSource(source('config/model-routing.json'), join(options.codexHome, 'codex-model-routing.json'));
  linkRuntimeSource(source('.codex/hooks.json'), join(options.codexHome, 'hooks.json'));
  syncHookTrust(join(options.codexHome, 'config.toml'), options.codexHome, options.repositoryRoot);
  const targets = ([['claude', 'claudecode'], ['copilot', 'copilotcli'], ['agy', 'antigravity-cli']] as const).filter(([command]) => commandAvailable(command)).map(([, targetName]) => targetName).join(',');
  if (targets) rulesync(options, ['generate', '--global', '--input-roots', join(options.repositoryRoot, '.rulesync'), '--targets', targets, '--features', 'mcp', '--silent']);
  if (!options.materializeOnly && commandAvailable('agy') && process.env.AUTODEV_SKIP_AGY_MCP !== '1') {
    updateAntigravityPermissions(join(options.home, '.gemini', 'antigravity-cli', 'settings.json'), roots(options), options.home);
    updateAntigravitySkills(join(options.home, '.gemini', 'config', 'skills.json'), skillsRoot, [join(options.repositoryRoot, 'agents/skills'), join(options.repositoryRoot, 'scripts/codex/skills')]);
  }
  for (const label of LAUNCH_LABELS) renderLaunchAgent(source(`config/launchagents/${label}.plist`), join(options.home, 'Library', 'LaunchAgents', `${label}.plist`), { codexHome: options.codexHome, home: options.home, repositoryRoot: options.repositoryRoot });
  const runDir = join(options.codexHome, 'run');
  mkdirSync(runDir, { recursive: true, mode: 0o700 });
  chmodSync(runDir, 0o700);
  for (const name of ['codex-model-router.launchd.out.log', 'codex-model-router.launchd.err.log']) {
    const path = join(runDir, name);
    if (isSymlink(path)) throw new Error(`refusing symlinked router log path: ${path}`);
    if (!exists(path)) writeFileSync(path, '', { mode: 0o600 });
    chmodSync(path, 0o600);
  }
}
function exists(path: string): boolean { try { lstatSync(path); return true; } catch { return false; } }
function isSymlink(path: string): boolean { try { return lstatSync(path).isSymbolicLink(); } catch { return false; } }

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const env = process.env; const repositoryRoot = env.AUTODEV_REPO_ROOT ?? resolve(join(import.meta.dirname, '..', '..')); const home = env.HOME ?? homedir(); const codexHome = env.CODEX_HOME ?? join(home, '.codex'); const mcp = env.AUTODEV_CODEX_MCP_SOURCE; if (!mcp) throw new Error('AUTODEV_CODEX_MCP_SOURCE is required'); materializeInstallation({ repositoryRoot, home, codexHome, otelMode: env.AUTODEV_OTEL_MODE ?? 'direct', materializeOnly: env.AUTODEV_MATERIALIZE_ONLY === '1', codexMcpSource: mcp });
  } catch (error) { console.error(`install-materializer: ${error instanceof Error ? error.message : String(error)}`); process.exitCode = 1; }
}
