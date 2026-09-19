import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  accessSync,
  chmodSync,
  constants as fsConstants,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";

import { writeErrorLine, writeLine } from "../shared/output.ts";

const COLLECTOR_PINNED_VERSION_PATTERN = /^v[0-9]+\.[0-9]+\.[0-9]+$/u;
const TAR_GZ_ARCHIVE_PATTERN = /^[^/]+\.tar\.gz$/u;
const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/u;

interface Artifact {
  name: string;
  sha256: string;
}
interface ArtifactManifest {
  version: string;
  assets: Record<string, Artifact>;
}
export interface ProvisionOptions {
  readonly repositoryRoot: string;
  readonly codexHome: string;
  readonly artifactFile: string;
  readonly versionFile: string;
  readonly target: string;
  readonly explicitBinary: string | null;
}

function fail(message: string): never {
  throw new Error(message);
}
function executable(filePath: string): boolean {
  try {
    accessSync(filePath, fsConstants.X_OK);
    return statSync(filePath).isFile();
  } catch {
    return false;
  }
}

export function resolveProvisionOptions(
  env: NodeJS.ProcessEnv = process.env
): ProvisionOptions {
  const home = env.HOME?.trim() || homedir();
  const codexHome = env.CODEX_HOME?.trim() || path.join(home, ".codex");
  const repositoryRoot =
    env.AUTODEV_OTEL_REPO_ROOT?.trim() ||
    path.join(import.meta.dirname, "..", "..");
  return {
    repositoryRoot,
    codexHome,
    artifactFile:
      env.AUTODEV_OTEL_ARTIFACTS?.trim() ||
      path.join(repositoryRoot, "config", "otel", "collector-artifacts.json"),
    versionFile:
      env.AUTODEV_OTEL_VERSION_FILE?.trim() ||
      path.join(repositoryRoot, "config", "otel", "collector.version"),
    target:
      env.AUTODEV_OTELCOL_TARGET?.trim() || path.join(codexHome, "otelcol"),
    explicitBinary: env.AUTODEV_OTELCOL_BIN?.trim() || null
  };
}

function readManifest(
  options: ProvisionOptions,
  version: string
): ArtifactManifest {
  if (!existsSync(options.artifactFile))
    fail(`artifact manifest is missing: ${options.artifactFile}`);
  const manifest = JSON.parse(
    readFileSync(options.artifactFile, "utf8")
  ) as ArtifactManifest;
  if (manifest.version !== version)
    fail(
      `manifest version ${manifest.version} does not match pinned ${version}`
    );
  if (!manifest.assets || typeof manifest.assets !== "object")
    fail(`artifact manifest has no assets: ${options.artifactFile}`);
  return manifest;
}

function platformKey(): string {
  const os =
    process.platform === "darwin"
      ? "darwin"
      : process.platform === "linux"
        ? "linux"
        : "";
  const arch =
    process.arch === "arm64" ? "arm64" : process.arch === "x64" ? "amd64" : "";
  if (!os || !arch)
    fail(`unsupported host platform: ${process.platform}/${process.arch}`);
  return `${os}/${arch}`;
}

function walkFiles(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const filePath = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...walkFiles(filePath));
    else if (entry.isFile()) files.push(filePath);
  }
  return files;
}

export async function provisionCollector(
  options: ProvisionOptions = resolveProvisionOptions()
): Promise<number> {
  if (options.explicitBinary) {
    if (!executable(options.explicitBinary))
      fail(`AUTODEV_OTELCOL_BIN is not executable: ${options.explicitBinary}`);
    return 0;
  }
  if (executable(options.target)) return 0;
  if (!existsSync(options.versionFile))
    fail(`collector version file is missing: ${options.versionFile}`);
  const version = readFileSync(options.versionFile, "utf8").trim();
  if (!COLLECTOR_PINNED_VERSION_PATTERN.test(version))
    fail(`invalid pinned Collector version: ${version}`);
  const asset = readManifest(options, version).assets[platformKey()];
  if (
    !asset ||
    !TAR_GZ_ARCHIVE_PATTERN.test(asset.name) ||
    !SHA256_HEX_PATTERN.test(asset.sha256)
  )
    fail(`no valid Collector artifact is pinned for ${platformKey()}`);

  const temporaryDir = mkdtempSync(path.join(tmpdir(), "autodev-otelcol-"));
  try {
    const archive = path.join(temporaryDir, asset.name);
    const response = await fetch(
      `https://github.com/open-telemetry/opentelemetry-collector-releases/releases/download/${version}/${asset.name}`
    );
    if (!response.ok)
      fail(`Collector artifact download failed: HTTP ${response.status}`);
    writeFileSync(archive, Buffer.from(await response.arrayBuffer()), {
      mode: 0o600
    });
    const checksum = createHash("sha256")
      .update(readFileSync(archive))
      .digest("hex");
    if (checksum !== asset.sha256)
      fail(`Collector checksum mismatch for ${asset.name}`);
    const extracted = path.join(temporaryDir, "extracted");
    mkdirSync(extracted);
    execFileSync("tar", ["-xzf", archive, "-C", extracted], {
      stdio: "ignore"
    });
    const binary = walkFiles(extracted).find(
      (filePath) =>
        path.basename(filePath) === "otelcol" && executable(filePath)
    );
    if (!binary)
      fail("Collector archive did not contain an executable otelcol");
    mkdirSync(path.dirname(options.target), { recursive: true, mode: 0o700 });
    copyFileSync(binary, options.target);
    chmodSync(options.target, 0o700);
    writeLine(`provisioned ${version} Collector at ${options.target}`);
    return 0;
  } finally {
    rmSync(temporaryDir, { recursive: true, force: true });
  }
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  provisionCollector()
    .then((status) => {
      process.exitCode = status;
      return status;
    })
    .catch((error) => {
      writeErrorLine(
        `provision-autodev-otel-collector: ${error instanceof Error ? error.message : String(error)}`
      );
      process.exitCode = 1;
      return 1;
    });
}
