import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ConfigError } from '../config/toml.ts';
import { installCocoIndex, installPythonLanguageServer, resolveDependencyOptions } from './dependencies.ts';
import { ensureRouterAuth, readCollectorMode, writeCollectorMode, type OtelCollectorMode } from './install-state.ts';
import { materializeInstallation } from './install-materializer.ts';

export interface InstallCommandOptions {
  readonly repositoryRoot?: string;
  readonly home?: string;
  readonly codexHome?: string;
}

interface InstallFlags { materializeOnly: boolean; routerAuth: boolean; otelMode: OtelCollectorMode | null }

function parseFlags(args: readonly string[]): InstallFlags {
  const flags: InstallFlags = { materializeOnly: false, routerAuth: false, otelMode: null };
  for (const arg of args) {
    if (arg === '--materialize-only') flags.materializeOnly = true;
    else if (arg === '--enable-router-auth') flags.routerAuth = true;
    else if (arg === '--enable-otel-collector') {
      if (flags.otelMode === 'direct') throw new ConfigError('Collector enable/disable options are mutually exclusive.');
      flags.otelMode = 'collector';
    } else if (arg === '--disable-otel-collector') {
      if (flags.otelMode === 'collector') throw new ConfigError('Collector enable/disable options are mutually exclusive.');
      flags.otelMode = 'direct';
    } else if (arg === '--check') {
      throw new ConfigError('autodev install --check is still owned by the installer check boundary; run scripts/install.sh --check');
    } else {
      throw new ConfigError(arg === '--restart' ? 'unsupported install option: --restart; normal installs restart services, use --materialize-only for a live session' : `unsupported install option: ${arg}`);
    }
  }
  return flags;
}

function runNodeModule(modulePath: string, args: readonly string[], env: NodeJS.ProcessEnv): void {
  try { execFileSync(process.execPath, [modulePath, ...args], { env: { ...process.env, ...env }, stdio: 'inherit' }); }
  catch (error) { throw new ConfigError(`${modulePath} failed: ${error instanceof Error ? error.message : String(error)}`); }
}

export function createCodexMcpSource(repositoryRoot: string): { root: string; source: string } {
  const root = mkdtempSync(join(process.env.TMPDIR ?? '/tmp', 'autodev-codex-mcp-'));
  try {
    const rulesync = join(repositoryRoot, 'node_modules', '.bin', 'rulesync');
    if (!existsSync(rulesync)) throw new ConfigError(`missing-rulesync ${rulesync}; run pnpm install --frozen-lockfile`);
    execFileSync(rulesync, ['generate', '--input-roots', join(repositoryRoot, '.rulesync'), '--targets', 'codexcli', '--features', 'mcp', '--output-roots', root, '--silent'], { cwd: repositoryRoot, stdio: 'inherit' });
    const source = join(root, '.codex', 'config.toml');
    if (!existsSync(source)) throw new ConfigError(`Rulesync did not generate Codex MCP source: ${source}`);
    return { root, source };
  } catch (error) {
    rmSync(root, { recursive: true, force: true });
    if (error instanceof ConfigError) throw error;
    throw new ConfigError(`could not generate Codex MCP projection: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** Typed normal-install coordinator; `autodev install --check` is owned by the typed install-check boundary. */
export function runInstallCommand(args: readonly string[] = [], overrides: InstallCommandOptions = {}): number {
  const flags = parseFlags(args);
  const repositoryRoot = resolve(overrides.repositoryRoot ?? process.env.AUTODEV_REPO_ROOT ?? fileURLToPath(new URL('../../', import.meta.url)));
  const home = overrides.home ?? process.env.HOME ?? homedir();
  const codexHome = overrides.codexHome ?? process.env.CODEX_HOME ?? join(home, '.codex');
  const modePath = join(codexHome, 'otel-collector.mode');
  const otelMode = flags.otelMode ?? readCollectorMode(modePath);
  const projection = createCodexMcpSource(repositoryRoot);
  const env = { AUTODEV_REPO_ROOT: repositoryRoot, CODEX_HOME: codexHome, HOME: home, AUTODEV_OTEL_MODE: otelMode };
  try {
    if (otelMode === 'collector' && !flags.materializeOnly) runNodeModule(join(repositoryRoot, 'src/platform/otel-provision.ts'), [], env);
    if (flags.routerAuth) ensureRouterAuth(process.env.CODEX_ENV_FILE ?? join(codexHome, '.env'), env);
    if (!flags.materializeOnly) {
      if (installCocoIndex(resolveDependencyOptions(process.env)) !== 0) return 1;
      if (installPythonLanguageServer(resolveDependencyOptions(process.env)) !== 0) return 1;
    }
    materializeInstallation({ repositoryRoot, home, codexHome, otelMode, materializeOnly: flags.materializeOnly, codexMcpSource: projection.source });
    if (!flags.materializeOnly) runNodeModule(join(repositoryRoot, 'src/platform/service-restart.ts'), [], env);
    else console.error('Materialized AutoDev integration without restarting services.');
    if (flags.otelMode !== null) writeCollectorMode(modePath, otelMode);
    return 0;
  } finally {
    rmSync(projection.root, { recursive: true, force: true });
  }
}
