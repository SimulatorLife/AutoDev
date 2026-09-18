import { execFileSync, spawnSync } from 'node:child_process';
import { accessSync, constants as fsConstants, existsSync, readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseTomlFile, type TomlTable, type TomlValue } from '../config/toml.ts';
import { createDefaultRouterEnsureDeps, resolveRouterEnsureOptions, runRouterEnsure } from '../platform/router-ensure.ts';

const repositoryRoot = resolve(fileURLToPath(new URL('../../', import.meta.url)));
const SUPPORTED_ROLES = ['default', 'docs-researcher', 'browser-tester', 'explorer', 'worker', 'validator', 'smart'] as const;
export type ProviderAgentRole = (typeof SUPPORTED_ROLES)[number];

export interface ProviderAgentOptions {
  readonly role: ProviderAgentRole;
  readonly workspace: string;
  readonly prompt: string;
  readonly checkOnly: boolean;
  readonly repositoryRoot: string;
  readonly codexHome: string;
  readonly codexBinary: string;
  readonly roleFile: string;
}

export interface RoleExecutionSettings {
  readonly developerInstructions: string;
  readonly reasoningEffort: string;
  readonly reasoningSummary: string;
  readonly sandboxMode: string;
}

function usage(): string {
  return `Usage: run-provider-agent.sh --role ROLE [options]

The role is model-agnostic. The local model router chooses providers in its
configured priority order and falls back when a provider is unavailable,
quota-limited, or session-limited.

Options:
  --role ROLE          Role label (default: default)
  --prompt TEXT        Prompt to send to the role
  --prompt-file FILE   Read the prompt from FILE; use - for stdin
  --cwd DIR            Run the role against DIR instead of AutoDev
  --check              Validate the role and local router launcher only`;
}

function isRole(value: string): value is ProviderAgentRole {
  return (SUPPORTED_ROLES as readonly string[]).includes(value);
}

function executable(path: string): boolean {
  try { accessSync(path, fsConstants.X_OK); return true; } catch { return false; }
}

function resolveCodexBinary(env: NodeJS.ProcessEnv, home: string): string {
  const configured = env.CODEX_BIN?.trim();
  if (configured) {
    if (executable(configured)) return configured;
    throw new Error(`Codex CLI is not executable: ${configured}`);
  }
  try {
    const found = execFileSync('which', ['codex'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    if (executable(found)) return found;
  } catch { /* try the version-managed installation below */ }
  const nvmRoot = join(home, '.nvm', 'versions', 'node');
  if (existsSync(nvmRoot)) {
    const versions = readdirSync(nvmRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort((left, right) => right.localeCompare(left, undefined, { numeric: true }));
    for (const version of versions) {
      const candidate = join(nvmRoot, version, 'bin', 'codex');
      if (executable(candidate)) return candidate;
    }
  }
  throw new Error('Codex CLI not found; set CODEX_BIN to the current codex executable.');
}

function stringValue(value: TomlValue | undefined): string {
  return typeof value === 'string' ? value : '';
}

export function readRoleExecutionSettings(roleFile: string): RoleExecutionSettings {
  const config = parseTomlFile(roleFile, 'role configuration');
  return {
    developerInstructions: stringValue(config.developer_instructions),
    reasoningEffort: stringValue(config.model_reasoning_effort),
    reasoningSummary: stringValue(config.model_reasoning_summary),
    sandboxMode: stringValue(config.sandbox_mode),
  };
}

function readPromptFile(path: string): string {
  return readFileSync(path === '-' ? 0 : path, 'utf8');
}

export function parseProviderAgentArgs(argv: readonly string[], env: NodeJS.ProcessEnv = process.env): ProviderAgentOptions {
  let role = 'default';
  let workspace = env.AUTODEV_REPO_ROOT?.trim() || repositoryRoot;
  let prompt = '';
  let promptFile = '';
  let checkOnly = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    switch (argument) {
      case '--role':
        role = argv[index += 1] ?? '';
        break;
      case '--prompt':
        prompt = argv[index += 1] ?? '';
        break;
      case '--prompt-file':
        promptFile = argv[index += 1] ?? '';
        break;
      case '--cwd':
      case '-C':
        workspace = argv[index += 1] ?? '';
        break;
      case '--check':
        checkOnly = true;
        break;
      case '--help':
      case '-h':
        throw new Error(usage());
      case '--provider':
        throw new Error('--provider is obsolete; select a capability role with --role instead.');
      default:
        throw new Error(`Unknown option: ${argument ?? ''}\n${usage()}`);
    }
  }
  if (!isRole(role)) throw new Error(`Unsupported role: ${role}\n${usage()}`);
  if (promptFile) prompt = readPromptFile(promptFile);
  if (!workspace || !existsSync(workspace)) throw new Error(`Workspace is not a directory: ${workspace}`);
  const normalizedWorkspace = resolve(workspace);
  const home = env.HOME?.trim() || homedir();
  const codexHome = env.CODEX_HOME?.trim() || join(home, '.codex');
  const roleFile = join(codexHome, 'agents', `${role}.toml`);
  if (!existsSync(roleFile)) throw new Error(`Missing materialized role: ${roleFile}`);
  return {
    role,
    workspace: normalizedWorkspace,
    prompt,
    checkOnly,
    repositoryRoot: env.AUTODEV_REPO_ROOT?.trim() || repositoryRoot,
    codexHome,
    codexBinary: resolveCodexBinary(env, home),
    roleFile,
  };
}

function loadEnvironmentFile(path: string, environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  if (!existsSync(path)) return environment;
  const result = { ...environment };
  for (const rawLine of readFileSync(path, 'utf8').split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const assignment = line.startsWith('export ') ? line.slice(7) : line;
    const separator = assignment.indexOf('=');
    if (separator < 1) continue;
    const key = assignment.slice(0, separator).trim();
    let value = assignment.slice(separator + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    result[key] = value;
  }
  return result;
}

async function ensureRouter(environment: NodeJS.ProcessEnv): Promise<void> {
  const options = resolveRouterEnsureOptions(environment, process.pid);
  const result = await runRouterEnsure(createDefaultRouterEnsureDeps(options), options);
  if (result.exitCode !== 0) throw new Error(result.message ?? 'model router ensure failed');
}

export function buildProviderPrompt(prompt: string, settings: RoleExecutionSettings): string {
  return `Provider-neutral role instructions:\n${settings.developerInstructions}\n\nBounded task:\n${prompt}`;
}

export async function runProviderAgent(argv: readonly string[] = process.argv.slice(2), env: NodeJS.ProcessEnv = process.env): Promise<number> {
  const options = parseProviderAgentArgs(argv, env);
  await ensureRouter(env);
  if (options.checkOnly) {
    const result = spawnSync(options.codexBinary, ['--strict-config', '-C', options.repositoryRoot, 'exec', '--model', `autodev/${options.role}`, '--help'], { stdio: 'ignore', env });
    if (result.status !== 0) throw new Error(`Codex role validation failed for ${options.role}`);
    process.stdout.write(`role=${options.role} model=autodev/${options.role} router=http://127.0.0.1:4100/v1 status=ready\n`);
    return 0;
  }
  if (!options.prompt) throw new Error('Provide --prompt or --prompt-file (use - for stdin).');
  const environment = loadEnvironmentFile(env.CODEX_ENV_FILE?.trim() || join(options.codexHome, '.env'), env);
  const settings = readRoleExecutionSettings(options.roleFile);
  const args = ['--strict-config', '-C', options.workspace];
  if (settings.reasoningEffort) args.push('-c', `model_reasoning_effort=${settings.reasoningEffort}`);
  if (settings.reasoningSummary) args.push('-c', `model_reasoning_summary=${settings.reasoningSummary}`);
  if (settings.sandboxMode) args.push('-c', `sandbox_mode=${settings.sandboxMode}`);
  args.push('exec', '--model', `autodev/${options.role}`, '--ephemeral', '--json', '--skip-git-repo-check', buildProviderPrompt(options.prompt, settings));
  const result = spawnSync(options.codexBinary, args, { stdio: ['ignore', 'inherit', 'inherit'], env: environment });
  return result.status ?? 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runProviderAgent().then((status) => { process.exitCode = status; }).catch((error: unknown) => { console.error(`run-provider-agent: ${error instanceof Error ? error.message : String(error)}`); process.exitCode = 2; });
}
