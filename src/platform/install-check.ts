import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { runCompose } from '../config/compose-user-config.ts';
import { renderAgentDirectory } from '../config/render-agent-configs.ts';
import { runBridgeMcpCatalogue } from '../config/render-bridge-mcp-catalogue.ts';
import { renderExecutionContract } from '../config/render-execution-contract.ts';
import { renderProviderSkillViews } from '../config/render-provider-skill-views.ts';
import { checkCocoIndex, checkPythonLanguageServer, resolveDependencyOptions } from './dependencies.ts';
import { createCodexMcpSource } from './install-command.ts';
import { readCollectorMode } from './install-state.ts';
import { launchAgentMatches } from './macos/launchagent.ts';
import { antigravitySkillsStatus, missingAntigravityPermissions } from './antigravity-settings.ts';
import { resolveCollectorOptions, runCollector } from './otel-collector.ts';
import { RUNTIME_MODULES, OTEL_RUNTIME, HOOKS, DASHBOARD, MCP_LAUNCHERS, PROFILES, CATALOGS, ROLES, PROMPT_ROLES, SKILLS, RULES, LAUNCH_LABELS, OBSOLETE_HOOKS, OBSOLETE_DIRS } from './install-materializer.ts';
import { runtimeFileMatches, runtimeLinkMatches, skillLinkMatches, runtimeTarget } from './runtime-files.ts';
import { stalePaths } from './runtime-reconciliation.ts';

export interface InstallCheckOptions { readonly repositoryRoot?: string; readonly home?: string; readonly codexHome?: string; readonly materializeOnly?: boolean }

function commandAvailable(command: string): boolean { try { execFileSync('which', [command], { stdio: 'ignore' }); return true; } catch { return false; } }
function sourceRoot(options: InstallCheckOptions): string { return resolve(options.repositoryRoot ?? process.env.AUTODEV_REPO_ROOT ?? join(import.meta.dirname, '..', '..')); }
function lstatSafe(path: string): boolean { try { lstatSync(path); return true; } catch { return false; } }
function check(label: string, condition: boolean, failures: { value: number }): void { if (condition) console.log(`ok ${label}`); else { console.log(`missing-or-drifted ${label}`); failures.value = 1; } }
function tracked(repositoryRoot: string, path: string): boolean {
  try {
    const files = execFileSync('git', ['-C', repositoryRoot, 'ls-files'], { encoding: 'utf8' });
    const relative = path.startsWith(`${repositoryRoot}/`) ? path.slice(repositoryRoot.length + 1) : path;
    return files.split(/\r?\n/u).some((file) => file === relative || file.startsWith(`${relative}/`));
  } catch { return false; }
}
function staleCheck(options: { repositoryRoot: string; home: string; codexHome: string }, failures: { value: number }): void {
  const hooks = join(options.codexHome, 'hooks');
  const paths = [
    join(options.home, 'Library', 'LaunchAgents', 'com.codex.antigravity-litellm.plist'),
    join(options.home, '.config', 'litellm', 'antigravity.yaml'),
    join(options.home, '.codex', 'codex-antigravity-litellm-config.sha256'),
    join(hooks, 'codex', 'lib', 'codex-spawn-tools.mjs'), join(hooks, 'codex', 'lib', 'codex-state-collector.mjs'), join(hooks, 'codex', 'lib', 'spawn-shim-mcp.mjs'),
    ...OBSOLETE_HOOKS.map((name) => join(hooks, name)), ...OBSOLETE_DIRS.map((name) => join(hooks, name)),
  ];
  for (const path of stalePaths(paths)) { console.log(`obsolete-runtime-path ${path}`); failures.value = 1; }
}
function checkAuth(options: { codexHome: string }, failures: { value: number }): void {
  const envFile = process.env.CODEX_ENV_FILE?.trim() || join(options.codexHome, '.env');
  if (!existsSync(envFile)) { console.log('router auth token not staged (use --enable-router-auth during a planned restart)'); return; }
  const token = readFileSync(envFile, 'utf8').match(/^CODEX_ROUTER_AUTH_TOKEN=([^\n]*)$/mu)?.[1]?.trim() ?? '';
  if (!token) { console.log('router auth token not staged (use --enable-router-auth during a planned restart)'); return; }
  let status: { authentication?: { responseRequests?: boolean } };
  try { status = JSON.parse(execFileSync('curl', ['--silent', '--max-time', '1', 'http://127.0.0.1:4100/status'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })) as { authentication?: { responseRequests?: boolean } }; } catch { console.log('router auth token staged (router status unavailable)'); return; }
  if (!status?.authentication?.responseRequests) { console.log('router auth token staged; active router still needs a planned restart'); return; }
  if (process.env.AUTODEV_SKIP_LAUNCHCTL !== '1' && commandAvailable('launchctl')) {
    let launchd = ''; try { launchd = execFileSync('launchctl', ['getenv', 'CODEX_ROUTER_AUTH_TOKEN'], { encoding: 'utf8' }).trim(); } catch { /* unavailable */ }
    if (!launchd) { console.log('action required: router is enforcing auth but the launchd user environment has no token; Codex Desktop will 401 (restart the router agent, then relaunch Codex)'); failures.value = 1; return; }
    if (launchd !== token) { console.log('action required: router is enforcing auth but the launchd user environment holds a stale token; Codex Desktop will 401 (restart the router agent, then relaunch Codex)'); failures.value = 1; return; }
    let stalePids: string[] = [];
    try {
      const pids = execFileSync('pgrep', ['-x', 'codex'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim().split(/\s+/u).filter(Boolean);
      stalePids = pids.filter((pid) => {
        try {
          const command = execFileSync('ps', ['eww', '-o', 'command=', pid], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
          return !command.split(' ').map((entry) => entry.trim()).some((entry) => entry === `CODEX_ROUTER_AUTH_TOKEN=${token}`);
        } catch { return true; }
      });
    } catch { /* no running Codex process is an acceptable state */ }
    if (stalePids.length > 0) { console.log(`action required: running Codex process predates the current auth token and will 401 (pid${stalePids.length === 1 ? '' : 's'} ${stalePids.join(' ')}); quit and relaunch Codex`); failures.value = 1; return; }
  }
  console.log('ok router authentication is active');
}

export function runInstallCheck(overrides: InstallCheckOptions = {}): number {
  const repositoryRoot = sourceRoot(overrides), home = overrides.home ?? process.env.HOME ?? homedir(), codexHome = overrides.codexHome ?? process.env.CODEX_HOME ?? join(home, '.codex');
  const hooks = join(codexHome, 'hooks'), userSkills = join(home, '.agents', 'skills'), rules = join(codexHome, 'rules'), agents = join(codexHome, 'agents');
  const failures = { value: 0 };
  const mode = readCollectorMode(join(codexHome, 'otel-collector.mode'));
  const projection = createCodexMcpSource(repositoryRoot);
  try {
    for (const name of RULES) check(`rule link ${name}`, runtimeLinkMatches(join(repositoryRoot, 'agents/rules', name), join(rules, name)), failures);
    for (const name of SKILLS) check(`skill link ${join(userSkills, name)}`, skillLinkMatches(join(repositoryRoot, '.rulesync/skills', name), join(userSkills, name)), failures);
    for (const path of RUNTIME_MODULES) { check(`runtime ${path}`, runtimeFileMatches(join(repositoryRoot, path), runtimeTarget(path, codexHome, hooks)), failures); check(`tracked source ${path}`, tracked(repositoryRoot, join(repositoryRoot, path)), failures); }
    for (const path of OTEL_RUNTIME) check(`Collector runtime ${path}`, runtimeFileMatches(join(repositoryRoot, path), join(hooks, path.slice(8))), failures);
    for (const role of PROMPT_ROLES) check(`prompt role ${role}`, runtimeFileMatches(join(repositoryRoot, `agents/prompts/roles/${role}.md`), runtimeTarget(`agents/prompts/roles/${role}.md`, codexHome, hooks)), failures);
    for (const name of MCP_LAUNCHERS) check(`MCP launcher ${name}`, runtimeLinkMatches(join(repositoryRoot, `scripts/${name}`), join(hooks, name)), failures);
    for (const name of HOOKS) check(`hook ${name}`, runtimeFileMatches(join(repositoryRoot, `scripts/${name}`), join(hooks, name)), failures);
    for (const name of DASHBOARD) check(`dashboard ${name}`, runtimeFileMatches(join(repositoryRoot, `scripts/${name}`), join(hooks, name)), failures);
    for (const name of PROFILES) check(`profile ${name}`, runtimeLinkMatches(join(repositoryRoot, `config/profiles/${name}.config.toml`), join(codexHome, `${name}.config.toml`)), failures);
    for (const name of CATALOGS) check(`catalog ${name}`, runtimeLinkMatches(join(repositoryRoot, `config/catalogs/${name}-model-catalog.json`), join(codexHome, `${name}-model-catalog.json`)), failures);
    check('model routing', runtimeLinkMatches(join(repositoryRoot, 'config/model-routing.json'), join(codexHome, 'codex-model-routing.json')), failures);
    check('Codex hooks.json', runtimeLinkMatches(join(repositoryRoot, '.codex/hooks.json'), join(codexHome, 'hooks.json')), failures);
    const portable = readFileSync(join(repositoryRoot, 'config/config.autodev.toml'), 'utf8');
    for (const provider of ['local_model_router', 'claude_code_subscription', 'minimax', 'antigravity_cli']) check(`provider config ${provider}`, portable.includes(`[model_providers.${provider}]`), failures);
    check('provider auth boundary', portable.includes('requires_openai_auth = false'), failures);
    check('user config', runCompose(join(repositoryRoot, 'config/config.autodev.toml'), projection.source, join(codexHome, 'config.toml'), join(codexHome, 'config.toml'), true, mode) === 0, failures);
    const rendered = mkdtempSync(join(tmpdir(), 'autodev-check-agents-'));
    try { renderAgentDirectory(join(repositoryRoot, 'agents/roles'), join(repositoryRoot, 'agents/prompts'), rendered, projection.source); for (const role of ROLES) check(`agent ${role}`, runtimeFileMatches(join(rendered, `${role}.toml`), join(agents, `${role}.toml`)), failures); }
    finally { rmSync(rendered, { recursive: true, force: true }); }
    const expectedContract = `${JSON.stringify(renderExecutionContract(join(repositoryRoot, 'agents/roles'), projection.source, join(repositoryRoot, 'config/execution-contract.json')), null, 2)}\n`;
    check('execution contract', existsSync(join(repositoryRoot, 'config/execution-contract.json')) && readFileSync(join(repositoryRoot, 'config/execution-contract.json'), 'utf8') === expectedContract, failures);
    try { renderProviderSkillViews(join(repositoryRoot, 'config/execution-contract.json'), userSkills, join(codexHome, 'provider-runtime', 'claude'), 'claude', true); console.log('ok Claude role skill views'); } catch { console.log('missing-or-drifted Claude role skill views'); failures.value = 1; }
    check('bridge MCP catalogue', runBridgeMcpCatalogue(projection.source, join(codexHome, 'provider-runtime', 'mcp-servers.json'), true) === 0, failures);
    try { execFileSync(join(repositoryRoot, 'node_modules/.bin/rulesync'), ['generate', '--config', join(repositoryRoot, 'rulesync.jsonc'), '--check', '--silent'], { cwd: repositoryRoot, stdio: 'ignore' }); console.log(`ok repository outputs generated by ${repositoryRoot}/rulesync.jsonc`); } catch { console.log(`missing-or-drifted repository outputs generated by ${repositoryRoot}/rulesync.jsonc`); failures.value = 1; }
    const userTargets = [['claude', 'claudecode'], ['copilot', 'copilotcli'], ['agy', 'antigravity-cli'] as const].filter(([command]) => commandAvailable(command)).map(([, target]) => target).join(',');
    if (userTargets) {
      try { execFileSync(join(repositoryRoot, 'node_modules/.bin/rulesync'), ['generate', '--global', '--input-roots', join(repositoryRoot, '.rulesync'), '--targets', userTargets, '--features', 'mcp', '--check', '--silent'], { cwd: repositoryRoot, stdio: 'ignore' }); console.log(`ok user-level MCP (${userTargets}) generated from ${repositoryRoot}/.rulesync/mcp.jsonc`); } catch { console.log(`missing-or-drifted user-level MCP (${userTargets})`); failures.value = 1; }
    }
    check(`Collector mode ${mode}`, mode === 'direct' || mode === 'collector', failures);
    const collector = resolveCollectorOptions({ ...process.env, AUTODEV_OTEL_REPO_ROOT: repositoryRoot, CODEX_HOME: codexHome });
    if (mode === 'collector') { try { check('Collector binary/config', runCollector(collector, true) === 0, failures); } catch { console.log('missing-or-drifted Collector binary/config'); failures.value = 1; } } else console.log('ok OpenTelemetry Collector is disabled (direct OTLP ingress on 127.0.0.1:4100)');
    for (const skill of SKILLS) {
      for (const legacy of ['skills', 'agents/skills']) {
        const path = join(codexHome, legacy, skill);
        check(`obsolete skill path ${path}`, !lstatSafe(path), failures);
      }
    }
    if (commandAvailable('agy') && process.env.AUTODEV_SKIP_AGY_MCP !== '1') {
      const settingsPath = join(home, '.gemini', 'antigravity-cli', 'settings.json');
      const readRoots = process.env.AUTODEV_AGY_READ_ROOTS?.split(':').filter(Boolean) ?? [repositoryRoot];
      if (!existsSync(settingsPath)) {
        console.log(`missing Antigravity CLI permission settings ${settingsPath}`);
        failures.value = 1;
      } else {
        const missing = missingAntigravityPermissions(settingsPath, readRoots, home);
        if (missing.length > 0) { console.log(`missing Antigravity CLI permission grants: ${missing.join(', ')}`); failures.value = 1; }
        else console.log('ok Antigravity CLI permission grants (MCP and read_file)');
      }
      const skillsPath = join(home, '.gemini', 'config', 'skills.json');
      const skillStatus = existsSync(skillsPath) ? antigravitySkillsStatus(skillsPath, join(repositoryRoot, '.rulesync', 'skills'), [join(repositoryRoot, 'agents/skills'), join(repositoryRoot, 'scripts/codex/skills')]) : { missing: true, stale: [] };
      check('Antigravity skills', !skillStatus.missing && skillStatus.stale.length === 0, failures);
    }
    try {
      const exclude = execFileSync('git', ['-C', repositoryRoot, 'rev-parse', '--path-format=absolute', '--git-path', 'info/exclude'], { encoding: 'utf8' }).trim();
      const content = readFileSync(exclude, 'utf8');
      for (const entry of ['/.agents/skills/', '/.codex/hooks.json', '/.claude/settings.json', '/.github/hooks/', '/.agents/hooks.json']) check(`git exclude ${entry}`, content.split(/\r?\n/u).includes(entry), failures);
    } catch { check('git excludes', false, failures); }
    if (checkCocoIndex(resolveDependencyOptions(process.env)) !== 0) failures.value = 1;
    if (checkPythonLanguageServer(resolveDependencyOptions(process.env)) !== 0) failures.value = 1;
    checkAuth({ codexHome }, failures); staleCheck({ repositoryRoot, home, codexHome }, failures);
    for (const label of LAUNCH_LABELS) check(`LaunchAgent ${label}`, launchAgentMatches(join(repositoryRoot, `config/launchagents/${label}.plist`), join(home, 'Library/LaunchAgents', `${label}.plist`), { codexHome, home, repositoryRoot }), failures);
    return failures.value;
  } finally { rmSync(projection.root, { recursive: true, force: true }); }
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  try { process.exitCode = runInstallCheck(); } catch (error) { console.error(`install-check: ${error instanceof Error ? error.message : String(error)}`); process.exitCode = 1; }
}
