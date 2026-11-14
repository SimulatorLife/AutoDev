import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  accessSync,
  chmodSync,
  constants as fsConstants,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync
} from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  MessageChannel,
  receiveMessageOnPort,
  Worker
} from "node:worker_threads";

import {
  writeErrorLine,
  writeLine
} from "@simulatorlife/autodev-runtime/shared/output";

export type RuntimeFileMode = 0o644 | 0o755;

export interface RulesyncGenerateOptions {
  readonly configPath?: string;
  readonly inputRoots?: readonly string[];
  readonly targets?: readonly string[];
  readonly features?: readonly string[];
  readonly outputRoots?: readonly string[];
  readonly global?: boolean;
  readonly check?: boolean;
  readonly silent?: boolean;
  readonly delete?: boolean;
}

const RULESYNC_WORKER_SCRIPT = `
import fsPromises from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import { parentPort } from "node:worker_threads";
const origCwd = process.cwd.bind(process);
let activeCwd = origCwd();
process.cwd = () => activeCwd;
const origReadFile = fsPromises.readFile.bind(fsPromises);
let activeReadRoot = null;
let activeReadCache = null;
function resolveReadCacheKey(filePath, options) {
  if (typeof filePath !== "string" || !activeReadRoot || !activeReadCache) return null;
  let encKey;
  if (options == null) {
    encKey = "buffer";
  } else if (options === "utf8" || options === "utf-8") {
    encKey = "utf8";
  } else if (
    typeof options === "object" &&
    !options.signal &&
    !options.flag &&
    (options.encoding === "utf8" || options.encoding === "utf-8")
  ) {
    encKey = "utf8";
  } else {
    return null;
  }
  const resolved = path.isAbsolute(filePath)
    ? path.normalize(filePath)
    : path.resolve(activeReadRoot, filePath);
  const rulesyncPrefix = activeReadRoot + path.sep + ".rulesync" + path.sep;
  if (!resolved.startsWith(rulesyncPrefix)) return null;
  return resolved + "\\0" + encKey;
}
fsPromises.readFile = function cachedRulesyncReadFile(filePath, options) {
  const key = resolveReadCacheKey(filePath, options);
  if (!key) return origReadFile(filePath, options);
  let pending = activeReadCache.get(key);
  if (!pending) {
    pending = origReadFile(filePath, options);
    activeReadCache.set(key, pending);
  }
  return pending.then((value) => (Buffer.isBuffer(value) ? Buffer.from(value) : value));
};
syncBuiltinESMExports();
async function runWithRulesyncReadCache(resolvedCwd, fn) {
  activeReadRoot = resolvedCwd;
  activeReadCache = new Map();
  try {
    return await fn();
  } finally {
    activeReadCache = null;
    activeReadRoot = null;
  }
}
let cachedUrl = null;
let cachedMod = null;
parentPort.on("message", async ({ rulesyncUrl, cwd, home, options, port, signal }) => {
  const prevCwd = activeCwd;
  const prevHome = process.env.HOME;
  const prevHomeDir = process.env.HOME_DIR;
  try {
    if (cachedUrl !== rulesyncUrl) {
      cachedMod = await import(rulesyncUrl);
      cachedUrl = rulesyncUrl;
    }
    const resolvedCwd = path.resolve(cwd);
    activeCwd = resolvedCwd;
    if (home !== undefined) {
      const resolvedHome = path.resolve(home);
      process.env.HOME = resolvedHome;
      process.env.HOME_DIR = resolvedHome;
    }
    const result = await runWithRulesyncReadCache(resolvedCwd, () =>
      cachedMod.generate(options)
    );
    if (result.sourceLoadFailed) {
      throw new Error(
        "Failed to load rulesync sources: " +
          result.sourceLoadFailedFeatures.join(", ")
      );
    }
    if (options.check && result.hasDiff) {
      throw new Error(
        "Files are not up to date. Run 'rulesync generate' to update."
      );
    }
    port.postMessage({ ok: true });
  } catch (error) {
    port.postMessage({
      ok: false,
      message: error instanceof Error ? error.message : String(error)
    });
  } finally {
    activeCwd = prevCwd;
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    if (prevHomeDir === undefined) delete process.env.HOME_DIR;
    else process.env.HOME_DIR = prevHomeDir;
    Atomics.store(signal, 0, 1);
    Atomics.notify(signal, 0);
    port.close();
  }
});
`;

let sharedRulesyncWorker: Worker | null = null;

function getRulesyncWorker(): Worker {
  if (sharedRulesyncWorker === null) {
    const worker = new Worker(RULESYNC_WORKER_SCRIPT, { eval: true });
    worker.unref();
    worker.on("exit", () => {
      if (sharedRulesyncWorker === worker) sharedRulesyncWorker = null;
    });
    sharedRulesyncWorker = worker;
  }
  return sharedRulesyncWorker;
}

const REPO_INSTALL_CACHE_SCHEMA = "autodev-install-cache-v1";

export interface RepoInstallCache {
  schema: string;
  rulesyncInstallFingerprint?: string;
  rulesyncGenerate?: Record<string, string>;
  [key: string]: unknown;
}

const memoryRepoInstallCache = new Map<string, RepoInstallCache>();

function repoInstallCachePath(repositoryRoot: string): string | null {
  const gitDir = path.join(path.resolve(repositoryRoot), ".git");
  try {
    if (!lstatSync(gitDir).isDirectory()) return null;
  } catch {
    return null;
  }
  return path.join(gitDir, "autodev-install-cache.json");
}

function readDiskInstallCache(cachePath: string | null): RepoInstallCache | null {
  if (!cachePath || !existsSync(cachePath)) return null;
  try {
    const parsed = JSON.parse(
      readFileSync(cachePath, "utf8")
    ) as Partial<RepoInstallCache>;
    if (parsed.schema === REPO_INSTALL_CACHE_SCHEMA) {
      return {
        ...parsed,
        schema: REPO_INSTALL_CACHE_SCHEMA,
        ...(typeof parsed.rulesyncInstallFingerprint === "string"
          ? { rulesyncInstallFingerprint: parsed.rulesyncInstallFingerprint }
          : {}),
        ...(parsed.rulesyncGenerate &&
        typeof parsed.rulesyncGenerate === "object"
          ? { rulesyncGenerate: { ...parsed.rulesyncGenerate } }
          : {})
      };
    }
  } catch {
    /* Ignore corrupt cache file and recompute cleanly. */
  }
  return null;
}

/** Reads the cached install-fingerprint record for `repositoryRoot` (memory + `.git` cache). */
export function readRepoInstallCache(repositoryRoot: string): RepoInstallCache {
  const resolved = path.resolve(repositoryRoot);
  const disk = readDiskInstallCache(repoInstallCachePath(resolved));
  if (disk) {
    memoryRepoInstallCache.set(resolved, disk);
    return disk;
  }
  return (
    memoryRepoInstallCache.get(resolved) ?? {
      schema: REPO_INSTALL_CACHE_SCHEMA
    }
  );
}

/** Persists `cache` in memory and (when `.git` is a directory) to `.git/autodev-install-cache.json`. */
export function writeRepoInstallCache(
  repositoryRoot: string,
  cache: RepoInstallCache
): void {
  const resolved = path.resolve(repositoryRoot);
  const cachePath = repoInstallCachePath(resolved);
  const onDisk = readDiskInstallCache(cachePath);
  const next: RepoInstallCache = {
    ...(onDisk ?? {}),
    ...cache,
    schema: REPO_INSTALL_CACHE_SCHEMA,
    ...(cache.rulesyncInstallFingerprint !== undefined
      ? { rulesyncInstallFingerprint: cache.rulesyncInstallFingerprint }
      : {}),
    ...(cache.rulesyncGenerate !== undefined
      ? { rulesyncGenerate: { ...cache.rulesyncGenerate } }
      : {})
  };
  memoryRepoInstallCache.set(resolved, next);
  if (!cachePath) return;
  try {
    const tmpPath = `${cachePath}.${process.pid}.tmp`;
    writeFileSync(tmpPath, `${JSON.stringify(next, null, 2)}\n`, "utf8");
    renameSync(tmpPath, cachePath);
  } catch {
    /* Cache persistence failure is non-fatal. */
  }
}

function hashTreePath(
  hash: ReturnType<typeof createHash>,
  absolutePath: string,
  logicalName: string
): void {
  let stat;
  try {
    stat = lstatSync(absolutePath);
  } catch {
    hash.update(`missing:${logicalName}\0`);
    return;
  }
  if (stat.isSymbolicLink()) {
    hash.update(`symlink:${logicalName}:${readlinkSync(absolutePath)}\0`);
    return;
  }
  if (stat.isDirectory()) {
    hash.update(`dir:${logicalName}\0`);
    const entries = readdirSync(absolutePath, { withFileTypes: true }).sort(
      (a, b) => a.name.localeCompare(b.name)
    );
    for (const entry of entries) {
      hashTreePath(
        hash,
        path.join(absolutePath, entry.name),
        `${logicalName}/${entry.name}`
      );
    }
    return;
  }
  if (stat.isFile()) {
    hash.update(`file:${logicalName}:${stat.mode & 0o777}:${stat.size}\0`);
    hash.update(readFileSync(absolutePath));
    hash.update("\0");
  }
}

/** Computes a deterministic SHA-256 fingerprint across relative repo paths and extra strings. */
export function computeRepoPathsFingerprint(
  repositoryRoot: string,
  relativePaths: readonly string[],
  extras: readonly string[] = []
): string {
  const resolvedRoot = path.resolve(repositoryRoot);
  const hash = createHash("sha256");
  hash.update(`${REPO_INSTALL_CACHE_SCHEMA}\0`);
  for (const extra of extras) {
    hash.update(`extra:${extra}\0`);
  }
  const uniquePaths = [...new Set(relativePaths)].sort();
  for (const relativePath of uniquePaths) {
    hashTreePath(hash, path.join(resolvedRoot, relativePath), relativePath);
  }
  return hash.digest("hex");
}

/** Reads the installed `rulesync` package version for fingerprint invalidation. */
export function readRulesyncPackageVersion(repositoryRoot: string): string {
  const packageJsonPath = path.join(
    repositoryRoot,
    "node_modules",
    "rulesync",
    "package.json"
  );
  try {
    const parsed = JSON.parse(readFileSync(packageJsonPath, "utf8")) as {
      version?: unknown;
    };
    return typeof parsed.version === "string" ? parsed.version : "unknown";
  } catch {
    return "unknown";
  }
}

function computeRulesyncInstallFingerprint(repositoryRoot: string): string {
  const curatedRelative = path.join(".rulesync", "skills", ".curated");
  return computeRepoPathsFingerprint(
    repositoryRoot,
    ["rulesync.lock", "rulesync.jsonc", curatedRelative],
    [`rulesync:${readRulesyncPackageVersion(repositoryRoot)}`]
  );
}

export function runRulesyncInstallFrozen(repositoryRoot: string): void {
  const normalizedRoot = path.resolve(repositoryRoot);
  if (!existsSync(path.join(normalizedRoot, "rulesync.lock"))) {
    return;
  }
  const cache =
    process.env.AUTODEV_FORCE_RULESYNC === "1"
      ? null
      : readRepoInstallCache(normalizedRoot);
  const preFingerprint = computeRulesyncInstallFingerprint(normalizedRoot);
  if (cache?.rulesyncInstallFingerprint === preFingerprint) {
    return;
  }
  const rulesyncBin = path.join(
    normalizedRoot,
    "node_modules",
    ".bin",
    "rulesync"
  );
  if (!existsSync(rulesyncBin)) {
    throw new Error(
      `missing-rulesync ${rulesyncBin}; run pnpm install --frozen-lockfile`
    );
  }
  execFileSync(rulesyncBin, ["install", "--frozen", "--silent"], {
    cwd: normalizedRoot,
    stdio: "pipe"
  });
  const latestCache = readRepoInstallCache(normalizedRoot);
  writeRepoInstallCache(normalizedRoot, {
    ...latestCache,
    rulesyncInstallFingerprint:
      computeRulesyncInstallFingerprint(normalizedRoot)
  });
}

export function runRulesyncGenerate(
  repositoryRoot: string,
  options: RulesyncGenerateOptions,
  home?: string
): void {
  const normalizedRoot = path.resolve(repositoryRoot);
  const rulesyncBin = path.join(
    normalizedRoot,
    "node_modules",
    ".bin",
    "rulesync"
  );
  if (!existsSync(rulesyncBin)) {
    throw new Error(
      `missing-rulesync ${rulesyncBin}; run pnpm install --frozen-lockfile`
    );
  }
  const rulesyncEntry = path.join(
    normalizedRoot,
    "node_modules",
    "rulesync",
    "dist",
    "index.js"
  );
  const rulesyncUrl = pathToFileURL(rulesyncEntry).href;
  const worker = getRulesyncWorker();
  const { port1, port2 } = new MessageChannel();
  const signal = new Int32Array(new SharedArrayBuffer(4));
  worker.postMessage(
    {
      rulesyncUrl,
      cwd: normalizedRoot,
      home: home === undefined ? undefined : path.resolve(home),
      options: { silent: true, ...options },
      port: port2,
      signal
    },
    [port2]
  );
  Atomics.wait(signal, 0, 0);
  const response = receiveMessageOnPort(port1)?.message as
    { ok: boolean; message?: string } | undefined;
  port1.close();
  if (!response?.ok) {
    throw new Error(response?.message ?? "rulesync generate failed");
  }
}

export function resolveCommandOnPath(
  command: string,
  envOrPath: string | NodeJS.ProcessEnv | undefined = process.env.PATH
): string | null {
  if (!command) return null;
  if (command.includes(path.sep)) {
    try {
      accessSync(command, fsConstants.X_OK);
      return statSync(command).isFile() ? command : null;
    } catch {
      return null;
    }
  }
  const envPath = typeof envOrPath === "string" ? envOrPath : envOrPath?.PATH;
  if (!envPath) return null;
  for (const rawEntry of envPath.split(path.delimiter)) {
    const candidate = path.join(rawEntry || ".", command);
    try {
      accessSync(candidate, fsConstants.X_OK);
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      /* continue searching PATH */
    }
  }
  return null;
}

export function runtimeTarget(
  repoPath: string,
  codexHome: string,
  hooksDir = path.join(codexHome, "hooks")
): string {
  if (repoPath.startsWith("scripts/"))
    return path.join(hooksDir, repoPath.slice("scripts/".length));
  const installedPath = repoPath.startsWith("runtime/")
    ? repoPath.slice("runtime/".length)
    : repoPath;
  return path.join(codexHome, installedPath);
}

function ensureParent(filePath: string): void {
  mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
}

/** Atomically materialize a versioned runtime file with its execution mode. */
export function materializeRuntimeFile(
  source: string,
  target: string,
  mode: RuntimeFileMode
): void {
  ensureParent(target);
  try {
    const stat = lstatSync(target);
    if (stat.isSymbolicLink()) {
      unlinkSync(target);
    } else if (
      stat.isFile() &&
      (stat.mode & 0o777) === mode &&
      readFileSync(source).equals(readFileSync(target))
    ) {
      return;
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const temporary = `${target}.autodev-${process.pid}-${Date.now()}`;
  try {
    copyFileSync(source, temporary);
    chmodSync(temporary, mode);
    renameSync(temporary, target);
  } finally {
    try {
      unlinkSync(temporary);
    } catch {
      /* already renamed or absent */
    }
  }
}

/**
 * Atomically materialize generated Runtime content with its execution mode.
 *
 * The installed tree's package manifest is derived from the workspace package
 * manifest rather than copied, so it is written from memory instead of from a
 * repository file.
 */
export function materializeRuntimeContent(
  content: string,
  target: string,
  mode: RuntimeFileMode
): void {
  ensureParent(target);
  try {
    const stat = lstatSync(target);
    if (stat.isSymbolicLink()) {
      unlinkSync(target);
    } else if (
      stat.isFile() &&
      (stat.mode & 0o777) === mode &&
      readFileSync(target, "utf8") === content
    ) {
      return;
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const temporary = `${target}.autodev-${process.pid}-${Date.now()}`;
  try {
    writeFileSync(temporary, content, { mode });
    renameSync(temporary, target);
  } finally {
    try {
      unlinkSync(temporary);
    } catch {
      /* already renamed or absent */
    }
  }
}

export function linkRuntimeSource(source: string, target: string): void {
  if (!source.startsWith("/"))
    throw new Error(`refusing-relative-symlink-source ${source}`);
  ensureParent(target);
  try {
    const stat = lstatSync(target);
    if (stat.isSymbolicLink()) {
      if (readlinkSync(target) === source) return;
      unlinkSync(target);
    } else if (stat.isDirectory()) {
      throw new Error(`refusing to replace directory ${target}`);
    } else {
      unlinkSync(target);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  try {
    symlinkSync(source, target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      const stat = lstatSync(target);
      if (stat.isSymbolicLink() && readlinkSync(target) === source) return;
      unlinkSync(target);
      symlinkSync(source, target);
    } else {
      throw error;
    }
  }
}

export function runtimeLinkMatches(source: string, target: string): boolean {
  try {
    return (
      source.startsWith("/") &&
      lstatSync(target).isSymbolicLink() &&
      readlinkSync(target) === source
    );
  } catch {
    return false;
  }
}

export function validateSkillSource(source: string): void {
  if (!source.startsWith("/"))
    throw new Error(`refusing-relative-skill-source ${source}`);
  const directory = lstatSync(source);
  if (!directory.isDirectory() || directory.isSymbolicLink())
    throw new Error(`invalid-skill-directory ${source}`);
  const document = lstatSync(`${source}/SKILL.md`);
  if (!document.isFile() || document.isSymbolicLink())
    throw new Error(`invalid-skill-document ${source}/SKILL.md`);
}

export function linkSkillSource(source: string, target: string): void {
  validateSkillSource(source);
  linkRuntimeSource(source, target);
}

export function skillLinkMatches(source: string, target: string): boolean {
  try {
    validateSkillSource(source);
    if (!runtimeLinkMatches(source, target)) return false;
    const skillDoc = lstatSync(`${target}/SKILL.md`);
    return skillDoc.isFile() && !skillDoc.isSymbolicLink();
  } catch {
    return false;
  }
}

export function runtimeFileMatches(source: string, target: string): boolean {
  try {
    const stat = lstatSync(target);
    if (!stat.isFile() || stat.isSymbolicLink()) return false;
    return readFileSync(source).equals(readFileSync(target));
  } catch {
    return false;
  }
}

function parseMode(value: string | undefined): RuntimeFileMode {
  if (value === "0644") return 0o644;
  if (value === "0755") return 0o755;
  throw new Error(`unsupported runtime file mode: ${value ?? "(missing)"}`);
}

function cli(argv: string[]): number {
  const [command, ...args] = argv;
  if (command === "target" && args.length === 3) {
    writeLine(runtimeTarget(args[2]!, args[0]!, args[1]!));
    return 0;
  }
  if (command === "copy" && args.length === 3) {
    materializeRuntimeFile(args[1]!, args[2]!, parseMode(args[0]));
    return 0;
  }
  if (command === "check" && args.length === 2)
    return runtimeFileMatches(args[0]!, args[1]!) ? 0 : 1;
  if (command === "link" && args.length === 2) {
    linkRuntimeSource(args[0]!, args[1]!);
    return 0;
  }
  if (command === "check-link" && args.length === 2)
    return runtimeLinkMatches(args[0]!, args[1]!) ? 0 : 1;
  if (command === "link-skill" && args.length === 2) {
    linkSkillSource(args[0]!, args[1]!);
    return 0;
  }
  if (command === "check-skill" && args.length === 2)
    return skillLinkMatches(args[0]!, args[1]!) ? 0 : 1;
  throw new Error(
    "usage: runtime-files target <codex-home> <hooks-dir> <repo-path> | copy <0644|0755> <source> <target> | check <source> <target> | link <source> <target> | check-link <source> <target> | link-skill <source> <target> | check-skill <source> <target>"
  );
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  try {
    process.exitCode = cli(process.argv.slice(2));
  } catch (error) {
    writeErrorLine(
      `runtime-files: ${error instanceof Error ? error.message : String(error)}`
    );
    process.exitCode = 1;
  }
}
