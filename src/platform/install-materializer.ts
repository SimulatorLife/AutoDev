import { execFileSync } from 'node:child_process';
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { renderAgentDirectory } from '../config/render-agent-configs.ts';
import { runBridgeMcpCatalogue } from '../config/render-bridge-mcp-catalogue.ts';
import { runCompose } from '../config/compose-user-config.ts';
import { renderProviderSkillViews } from '../config/render-provider-skill-views.ts';
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
  'src/providers/copilot.ts', 'src/providers/antigravity.ts', 'src/providers/claude.ts', 'src/mcp/spawn-shim.ts',
  'src/shared/execution-contract.ts', 'src/router/status.ts', 'src/cli/router-status.ts', 'config/execution-contract.json',
  'agents/prompts/base.md', 'agents/prompts/leaf.md', 'agents/prompts/code-search.md', 'agents/prompts/orchestrator.md',
  'src/hooks/command-utils.ts', 'src/hooks/skill-read-telemetry.ts', 'src/hooks/session-start.ts', 'src/hooks/subagent-start.ts',
  'src/platform/macos/launchd.ts', 'src/platform/macos/launchagent.ts', 'src/platform/router-ensure.ts', 'src/platform/copilot-ensure.ts',
  'src/platform/antigravity-ensure.ts', 'src/platform/claude-ensure.ts', 'src/platform/minimax-ensure.ts', 'src/platform/antigravity-settings.ts',
  'src/platform/runtime-files.ts', 'src/platform/runtime-reconciliation.ts', 'src/platform/service-restart.ts', 'src/platform/otel-collector.ts',
  'src/platform/otel-provision.ts', 'src/platform/install-state.ts', 'src/platform/dependencies.ts', 'src/platform/install-materializer.ts', 'src/platform/install-command.ts', 'src/platform/install-check.ts', 'src/hooks/root-delegation.ts',
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
