import { createHash } from 'node:crypto';
import { accessSync, chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, constants as fsConstants } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

interface Artifact { name: string; sha256: string }
interface ArtifactManifest { version: string; assets: Record<string, Artifact> }
export interface ProvisionOptions {
  readonly repositoryRoot: string;
  readonly codexHome: string;
  readonly artifactFile: string;
  readonly versionFile: string;
  readonly target: string;
  readonly explicitBinary: string | null;
}

function fail(message: string): never { throw new Error(message); }
function executable(path: string): boolean { try { accessSync(path, fsConstants.X_OK); return statSync(path).isFile(); } catch { return false; } }

export function resolveProvisionOptions(env: NodeJS.ProcessEnv = process.env): ProvisionOptions {
  const home = env.HOME?.trim() || homedir();
  const codexHome = env.CODEX_HOME?.trim() || join(home, '.codex');
  const repositoryRoot = env.AUTODEV_OTEL_REPO_ROOT?.trim() || join(import.meta.dirname, '..', '..');
  return {
    repositoryRoot,
    codexHome,
    artifactFile: env.AUTODEV_OTEL_ARTIFACTS?.trim() || join(repositoryRoot, 'config', 'otel', 'collector-artifacts.json'),
    versionFile: env.AUTODEV_OTEL_VERSION_FILE?.trim() || join(repositoryRoot, 'config', 'otel', 'collector.version'),
    target: env.AUTODEV_OTELCOL_TARGET?.trim() || join(codexHome, 'otelcol'),
    explicitBinary: env.AUTODEV_OTELCOL_BIN?.trim() || null,
  };
}

function readManifest(options: ProvisionOptions, version: string): ArtifactManifest {
  if (!existsSync(options.artifactFile)) fail(`artifact manifest is missing: ${options.artifactFile}`);
  const manifest = JSON.parse(readFileSync(options.artifactFile, 'utf8')) as ArtifactManifest;
  if (manifest.version !== version) fail(`manifest version ${manifest.version} does not match pinned ${version}`);
  if (!manifest.assets || typeof manifest.assets !== 'object') fail(`artifact manifest has no assets: ${options.artifactFile}`);
  return manifest;
}

function platformKey(): string {
  const os = process.platform === 'darwin' ? 'darwin' : process.platform === 'linux' ? 'linux' : '';
  const arch = process.arch === 'arm64' ? 'arm64' : process.arch === 'x64' ? 'amd64' : '';
  if (!os || !arch) fail(`unsupported host platform: ${process.platform}/${process.arch}`);
  return `${os}/${arch}`;
}

function walkFiles(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...walkFiles(path));
    else if (entry.isFile()) files.push(path);
  }
  return files;
}

export async function provisionCollector(options: ProvisionOptions = resolveProvisionOptions()): Promise<number> {
  if (options.explicitBinary) {
    if (!executable(options.explicitBinary)) fail(`AUTODEV_OTELCOL_BIN is not executable: ${options.explicitBinary}`);
    return 0;
  }
  if (executable(options.target)) return 0;
  if (!existsSync(options.versionFile)) fail(`collector version file is missing: ${options.versionFile}`);
  const version = readFileSync(options.versionFile, 'utf8').trim();
  if (!/^v[0-9]+\.[0-9]+\.[0-9]+$/u.test(version)) fail(`invalid pinned Collector version: ${version}`);
  const asset = readManifest(options, version).assets[platformKey()];
  if (!asset || !/^[^/]+\.tar\.gz$/u.test(asset.name) || !/^[0-9a-f]{64}$/u.test(asset.sha256)) fail(`no valid Collector artifact is pinned for ${platformKey()}`);

  const temporaryDir = mkdtempSync(join(tmpdir(), 'autodev-otelcol-'));
  try {
    const archive = join(temporaryDir, asset.name);
    const response = await fetch(`https://github.com/open-telemetry/opentelemetry-collector-releases/releases/download/${version}/${asset.name}`);
    if (!response.ok) fail(`Collector artifact download failed: HTTP ${response.status}`);
    writeFileSync(archive, Buffer.from(await response.arrayBuffer()), { mode: 0o600 });
    const checksum = createHash('sha256').update(readFileSync(archive)).digest('hex');
    if (checksum !== asset.sha256) fail(`Collector checksum mismatch for ${asset.name}`);
    const extracted = join(temporaryDir, 'extracted');
    mkdirSync(extracted);
    execFileSync('tar', ['-xzf', archive, '-C', extracted], { stdio: 'ignore' });
    const binary = walkFiles(extracted).find((path) => basename(path) === 'otelcol' && executable(path));
    if (!binary) fail('Collector archive did not contain an executable otelcol');
    mkdirSync(dirname(options.target), { recursive: true, mode: 0o700 });
    copyFileSync(binary, options.target);
    chmodSync(options.target, 0o700);
    console.log(`provisioned ${version} Collector at ${options.target}`);
    return 0;
  } finally {
    rmSync(temporaryDir, { recursive: true, force: true });
  }
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  provisionCollector().then((status) => { process.exitCode = status; }).catch((error) => { console.error(`provision-autodev-otel-collector: ${error instanceof Error ? error.message : String(error)}`); process.exitCode = 1; });
}
