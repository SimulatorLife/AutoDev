import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync
} from "node:fs";
import path from "node:path";

import { isEntryPoint } from "@simulatorlife/autodev-runtime/shared/entry-point";
import { writeErrorLine } from "@simulatorlife/autodev-runtime/shared/output";
import { resolveRuntimeSourceRoot } from "@simulatorlife/autodev-runtime/shared/runtime-source-root";

import { computeRepoPathsFingerprint as computeRepositoryPathsFingerprint } from "./runtime-files.ts";

export interface ConsoleBuildOptions {
  readonly repositoryRoot: string;
  readonly nodeBin?: string;
  readonly forceRebuild?: boolean;
}

export interface ConsoleBuildDeps {
  readonly fileExists: (filePath: string) => boolean;
  readonly mkdir?: (dirPath: string) => void;
  readonly tryCreateDir?: (dirPath: string) => boolean;
  readonly sleepSync?: (ms: number) => void;
  readonly now?: () => number;
  readonly readDir?: (dirPath: string) => readonly string[];
  readonly isProcessAlive?: (pid: number) => boolean;
  readonly remove: (filePath: string) => void;
  readonly rename: (from: string, to: string) => void;
  readonly readFile: (filePath: string) => string;
  readonly writeFile: (filePath: string, content: string) => void;
  readonly run: (
    executable: string,
    arguments_: readonly string[],
    cwd: string,
    environment: NodeJS.ProcessEnv
  ) => void;
}

function checkProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function tryCreateDirSync(dirPath: string): boolean {
  try {
    mkdirSync(dirPath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  }
}

function sleepSyncDefault(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function defaultDependencies(): ConsoleBuildDeps {
  return {
    fileExists: existsSync,
    mkdir: (dirPath) => mkdirSync(dirPath, { recursive: true }),
    tryCreateDir: tryCreateDirSync,
    sleepSync: sleepSyncDefault,
    now: Date.now,
    readDir: (dirPath) => readdirSync(dirPath),
    isProcessAlive: checkProcessAlive,
    remove: (filePath) => rmSync(filePath, { recursive: true, force: true }),
    rename: renameSync,
    readFile: (filePath) => readFileSync(filePath, "utf8"),
    writeFile: (filePath, content) => writeFileSync(filePath, content, "utf8"),
    run: (executable, arguments_, cwd, environment) => {
      execFileSync(executable, [...arguments_], { cwd, env: environment, stdio: "inherit" });
    }
  };
}

const PRODUCTION_DIST_DIR = ".next";
const PREVIOUS_DIST_DIR = ".next-previous";
const CONSOLE_BUILD_STAMP_FILE = ".autodev-build-stamp";
const CONSOLE_BUILD_FINGERPRINT_PATHS = [
  "package.json",
  "pnpm-lock.yaml",
  "console/package.json",
  "console/next.config.ts",
  "console/tsconfig.json",
  "console/.env.local",
  "console/app",
  "console/src",
  "console/public",
  "core/package.json",
  "core/src",
  "data/package.json",
  "data/src"
] as const;

export function computeConsoleBuildFingerprint(repositoryRoot: string): string {
  return computeRepositoryPathsFingerprint(
    repositoryRoot,
    CONSOLE_BUILD_FINGERPRINT_PATHS
  );
}
const NEXT_ENV_FILE = "next-env.d.ts";
const TSCONFIG_FILE = "tsconfig.json";
const CACHE_DIR = "cache";
const RSC_INFO_FILE = ".rscinfo";
const SEEDED_CACHE_ENTRIES = [
  "turbopack",
  "webpack",
  "swc",
  ".tsbuildinfo",
  ".previewinfo"
] as const;
const STAGED_TYPES_INCLUDE_PATTERN =
  /^\.next-staging-[^/]+\/types\/\*\*\/\*\.ts$/u;
const STAGED_DEV_TYPES_INCLUDE_PATTERN =
  /^\.next-staging-[^/]+\/dev\/types\/\*\*\/\*\.ts$/u;
const PRODUCTION_TYPES_INCLUDE = `${PRODUCTION_DIST_DIR}/types/**/*.ts`;
const PRODUCTION_DEV_TYPES_INCLUDE = `${PRODUCTION_DIST_DIR}/dev/types/**/*.ts`;
const DIGITS_ONLY_PATTERN = /^\d+$/u;

function parseStagingDirPid(entry: string): number | null {
  if (!entry.startsWith(".next-staging-")) return null;
  const suffix = entry.slice(".next-staging-".length);
  const normalized = suffix.startsWith("e2e-")
    ? suffix.slice("e2e-".length)
    : suffix;
  const separatorIndex = normalized.indexOf("-");
  const pidToken =
    separatorIndex === -1 ? normalized : normalized.slice(0, separatorIndex);
  if (!DIGITS_ONLY_PATTERN.test(pidToken)) return null;
  const pid = Number(pidToken);
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

function normalizeGeneratedTypeReference(
  consoleRoot: string,
  stagingDistDir: string,
  dependencies: ConsoleBuildDeps
): void {
  const nextEnvironmentPath = path.join(consoleRoot, NEXT_ENV_FILE);
  if (!dependencies.fileExists(nextEnvironmentPath)) return;
  const content = dependencies.readFile(nextEnvironmentPath);
  const normalized = content.replaceAll(
    `./${stagingDistDir}/`,
    `./${PRODUCTION_DIST_DIR}/`
  );
  if (normalized !== content) dependencies.writeFile(nextEnvironmentPath, normalized);
}

function isGeneratedTypesInclude(entry: string): boolean {
  return (
    STAGED_TYPES_INCLUDE_PATTERN.test(entry) ||
    entry === PRODUCTION_TYPES_INCLUDE
  );
}

function isGeneratedDevelopmentTypesInclude(entry: string): boolean {
  return (
    STAGED_DEV_TYPES_INCLUDE_PATTERN.test(entry) ||
    entry === PRODUCTION_DEV_TYPES_INCLUDE
  );
}

function filterTsconfigInclude(
  includeList: readonly unknown[],
  targetTypesInclude: string,
  targetDevelopmentTypesInclude: string
): unknown[] {
  const filtered: unknown[] = [];
  const seen = new Set<string>();
  for (const entry of includeList) {
    if (typeof entry !== "string") {
      filtered.push(entry);
      continue;
    }
    let normalized = entry;
    if (isGeneratedTypesInclude(entry)) {
      normalized = targetTypesInclude;
    } else if (isGeneratedDevelopmentTypesInclude(entry)) {
      normalized = targetDevelopmentTypesInclude;
    }
    if (seen.has(normalized)) {
      continue;
    }

    seen.add(normalized);
    filtered.push(normalized);
  }
  return filtered;
}

function normalizeGeneratedTsconfig(
  consoleRoot: string,
  dependencies: ConsoleBuildDeps,
  targetTypesInclude = PRODUCTION_TYPES_INCLUDE,
  targetDevelopmentTypesInclude = PRODUCTION_DEV_TYPES_INCLUDE
): string | null {
  const tsconfigPath = path.join(consoleRoot, TSCONFIG_FILE);
  if (!dependencies.fileExists(tsconfigPath)) return null;
  const content = dependencies.readFile(tsconfigPath);
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return content;
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    Array.isArray(parsed) ||
    !Array.isArray((parsed as { include?: unknown }).include)
  ) {
    return content;
  }
  const record = parsed as { include: unknown[] };
  record.include = filterTsconfigInclude(
    record.include,
    targetTypesInclude,
    targetDevelopmentTypesInclude
  );
  const normalized = `${JSON.stringify(record, null, 2)}\n`;
  if (normalized !== content) dependencies.writeFile(tsconfigPath, normalized);
  return normalized;
}

function cleanStaleStagingDirectories(
  consoleRoot: string,
  currentStagingDistDir: string,
  dependencies: ConsoleBuildDeps
): void {
  const readDir = dependencies.readDir ?? ((dirPath: string) => readdirSync(dirPath));
  const isAlive = dependencies.isProcessAlive ?? checkProcessAlive;
  let entries: readonly string[];
  try {
    entries = readDir(consoleRoot);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry === currentStagingDistDir) continue;
    const pid = parseStagingDirPid(entry);
    if (pid !== null && pid !== process.pid && !isAlive(pid)) {
      dependencies.remove(path.join(consoleRoot, entry));
    }
  }
}

function seedStagingBuildCache(
  buildPath: string,
  stagingPath: string,
  dependencies: ConsoleBuildDeps
): readonly string[] {
  const buildCachePath = path.join(buildPath, CACHE_DIR);
  if (!dependencies.fileExists(buildCachePath)) return [];
  const stagingCachePath = path.join(stagingPath, CACHE_DIR);
  const ensureDir =
    dependencies.mkdir ??
    ((dirPath: string) => mkdirSync(dirPath, { recursive: true }));
  const movedSubdirs = SEEDED_CACHE_ENTRIES.filter((subdir) =>
    dependencies.fileExists(path.join(buildCachePath, subdir))
  );
  const rscInfoSource = path.join(buildCachePath, RSC_INFO_FILE);
  const hasRscInfo = dependencies.fileExists(rscInfoSource);
  if (!hasRscInfo && movedSubdirs.length === 0) return [];
  ensureDir(stagingCachePath);
  if (hasRscInfo) {
    dependencies.writeFile(
      path.join(stagingCachePath, RSC_INFO_FILE),
      dependencies.readFile(rscInfoSource)
    );
  }
  // The renames in this file move whole build directories, which write-file-atomic cannot.
  for (const subdir of movedSubdirs) {
    dependencies.rename(
      path.join(buildCachePath, subdir),
      path.join(stagingCachePath, subdir)
    );
  }
  return movedSubdirs;
}

function restoreBuildCacheOnFailure(
  buildPath: string,
  stagingPath: string,
  movedSubdirs: readonly string[],
  dependencies: ConsoleBuildDeps
): void {
  if (movedSubdirs.length === 0 || !dependencies.fileExists(buildPath)) return;
  const buildCachePath = path.join(buildPath, CACHE_DIR);
  const stagingCachePath = path.join(stagingPath, CACHE_DIR);
  const ensureDir =
    dependencies.mkdir ??
    ((dirPath: string) => mkdirSync(dirPath, { recursive: true }));
  ensureDir(buildCachePath);
  for (const subdir of movedSubdirs) {
    const stagedSubdir = path.join(stagingCachePath, subdir);
    const buildSubdir = path.join(buildCachePath, subdir);
    if (dependencies.fileExists(stagedSubdir) && !dependencies.fileExists(buildSubdir)) {
      try {
        dependencies.rename(stagedSubdir, buildSubdir);
      } catch {
        // Best-effort cache restoration on failed build.
      }
    }
  }
}

function restoreOptionalFile(
  filePath: string,
  previousContent: string | null,
  dependencies: ConsoleBuildDeps
): void {
  if (previousContent === null) {
    if (dependencies.fileExists(filePath)) dependencies.remove(filePath);
  } else {
    dependencies.writeFile(filePath, previousContent);
  }
}

function publishStagedBuild(
  stagingPath: string,
  buildPath: string,
  previousPath: string,
  dependencies: ConsoleBuildDeps
): void {
  if (dependencies.fileExists(previousPath)) dependencies.remove(previousPath);
  const hadCurrentBuild = dependencies.fileExists(buildPath);
  if (hadCurrentBuild) dependencies.rename(buildPath, previousPath);
  try {
    dependencies.rename(stagingPath, buildPath);
  } catch (error) {
    if (hadCurrentBuild && !dependencies.fileExists(buildPath)) {
      dependencies.rename(previousPath, buildPath);
    }
    throw error;
  }
  if (hadCurrentBuild) {
    try {
      dependencies.remove(previousPath);
    } catch {
      // A published build is usable; stale backup cleanup cannot invalidate it.
    }
  }
}

function recoverPreviousBuild(
  consoleRoot: string,
  dependencies: ConsoleBuildDeps
): void {
  const current = path.join(consoleRoot, PRODUCTION_DIST_DIR);
  const previous = path.join(consoleRoot, PREVIOUS_DIST_DIR);
  if (!dependencies.fileExists(current) && dependencies.fileExists(previous)) {
    dependencies.rename(previous, current);
  }
}

const BUILD_LOCK_DIR = ".next-build.lock";
const BUILD_LOCK_PID_FILE = "pid";
const BUILD_LOCK_POLL_MS = 100;
const BUILD_LOCK_TIMEOUT_MS = 300_000;
const BUILD_LOCK_EMPTY_GRACE_MS = 2000;

function readLockPid(pidFile: string, dependencies: ConsoleBuildDeps): number | null {
  if (!dependencies.fileExists(pidFile)) return null;
  const raw = dependencies.readFile(pidFile).trim();
  if (!DIGITS_ONLY_PATTERN.test(raw)) return null;
  const pid = Number(raw);
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

function isStaleLock(
  lockDir: string,
  pidFile: string,
  dependencies: ConsoleBuildDeps,
  missingPidSince: number | null,
  nowMs: number
): { readonly stale: boolean; readonly missingPidSince: number | null } {
  const pid = readLockPid(pidFile, dependencies);
  if (pid !== null) {
    const isAlive = dependencies.isProcessAlive ?? checkProcessAlive;
    return {
      stale: pid !== process.pid && !isAlive(pid),
      missingPidSince: null
    };
  }
  if (!dependencies.fileExists(lockDir)) {
    return { stale: false, missingPidSince: null };
  }
  const since = missingPidSince ?? nowMs;
  return {
    stale: nowMs - since >= BUILD_LOCK_EMPTY_GRACE_MS,
    missingPidSince: since
  };
}

function acquireBuildLock(
  consoleRoot: string,
  dependencies: ConsoleBuildDeps
): () => void {
  const tryCreate =
    dependencies.tryCreateDir ??
    (existsSync(consoleRoot) ? tryCreateDirSync : undefined);
  if (!tryCreate) return () => {};

  const lockDir = path.join(consoleRoot, BUILD_LOCK_DIR);
  const pidFile = path.join(lockDir, BUILD_LOCK_PID_FILE);
  const sleep = dependencies.sleepSync ?? sleepSyncDefault;
  const now = dependencies.now ?? Date.now;
  const start = now();
  let missingPidSince: number | null = null;

  for (;;) {
    if (tryCreate(lockDir)) {
      try {
        dependencies.writeFile(pidFile, `${process.pid}\n`);
      } catch (error) {
        dependencies.remove(lockDir);
        throw error;
      }
      return () => {
        dependencies.remove(lockDir);
      };
    }

    const nowMs = now();
    const staleCheck = isStaleLock(
      lockDir,
      pidFile,
      dependencies,
      missingPidSince,
      nowMs
    );
    missingPidSince = staleCheck.missingPidSince;
    if (staleCheck.stale) {
      dependencies.remove(lockDir);
      missingPidSince = null;
      continue;
    }

    if (nowMs - start >= BUILD_LOCK_TIMEOUT_MS) {
      const holder = readLockPid(pidFile, dependencies);
      throw new Error(
        `Timed out waiting for Console build lock at ${lockDir}${holder === null ? "" : ` (held by pid ${holder})`}.`
      );
    }
    sleep(BUILD_LOCK_POLL_MS);
  }
}

/**
Build in an isolated Next output directory, preserve the serving build until
compilation succeeds, then publish the new build for the managed Console
restart. A failed build must not damage the currently served artifact.
*/
export function buildConsole(
  options: ConsoleBuildOptions,
  dependencies: ConsoleBuildDeps = defaultDependencies()
): void {
  const consoleRoot = path.join(options.repositoryRoot, "console");
  const nextCli = path.join(
    consoleRoot,
    "node_modules",
    "next",
    "dist",
    "bin",
    "next"
  );
  if (!dependencies.fileExists(nextCli)) {
    throw new Error(
      `Console dependencies are missing at ${nextCli}; run pnpm install --frozen-lockfile first.`
    );
  }

  const releaseLock = acquireBuildLock(consoleRoot, dependencies);
  try {
    const stagingDistDir = `.next-staging-${process.pid}`;
    const stagingPath = path.join(consoleRoot, stagingDistDir);
    const buildPath = path.join(consoleRoot, PRODUCTION_DIST_DIR);
    const previousPath = path.join(consoleRoot, PREVIOUS_DIST_DIR);
    const buildIdPath = path.join(stagingPath, "BUILD_ID");
    const stampPath = path.join(buildPath, CONSOLE_BUILD_STAMP_FILE);
    const nextEnvironmentPath = path.join(consoleRoot, NEXT_ENV_FILE);
    const tsconfigPath = path.join(consoleRoot, TSCONFIG_FILE);
    recoverPreviousBuild(consoleRoot, dependencies);
    if (
      !options.forceRebuild &&
      process.env.AUTODEV_FORCE_CONSOLE_BUILD !== "1" &&
      dependencies.fileExists(path.join(buildPath, "BUILD_ID")) &&
      dependencies.fileExists(stampPath) &&
      dependencies.readFile(stampPath).trim() ===
        computeConsoleBuildFingerprint(options.repositoryRoot)
    ) {
      cleanStaleStagingDirectories(consoleRoot, stagingDistDir, dependencies);
      return;
    }
    cleanStaleStagingDirectories(consoleRoot, stagingDistDir, dependencies);
    dependencies.remove(stagingPath);
    const previousNextEnvironment = dependencies.fileExists(nextEnvironmentPath)
      ? dependencies.readFile(nextEnvironmentPath)
      : null;
    const previousTsconfig = normalizeGeneratedTsconfig(consoleRoot, dependencies);
    normalizeGeneratedTsconfig(
      consoleRoot,
      dependencies,
      `${stagingDistDir}/types/**/*.ts`,
      `${stagingDistDir}/dev/types/**/*.ts`
    );
    const movedCacheSubdirs = seedStagingBuildCache(
      buildPath,
      stagingPath,
      dependencies
    );

    try {
      dependencies.run(
        options.nodeBin ?? process.execPath,
        [nextCli, "build"],
        consoleRoot,
        {
          ...process.env,
          AUTODEV_CONSOLE_BUILD_DIST_DIR: stagingDistDir
        }
      );
      if (!dependencies.fileExists(buildIdPath)) {
        throw new Error(
          "Next.js completed without producing the staged Console BUILD_ID."
        );
      }
      normalizeGeneratedTypeReference(consoleRoot, stagingDistDir, dependencies);
      normalizeGeneratedTsconfig(consoleRoot, dependencies);
      dependencies.writeFile(
        path.join(stagingPath, CONSOLE_BUILD_STAMP_FILE),
        `${computeConsoleBuildFingerprint(options.repositoryRoot)}\n`
      );
      publishStagedBuild(stagingPath, buildPath, previousPath, dependencies);
    } catch (error) {
      restoreBuildCacheOnFailure(
        buildPath,
        stagingPath,
        movedCacheSubdirs,
        dependencies
      );
      restoreOptionalFile(nextEnvironmentPath, previousNextEnvironment, dependencies);
      restoreOptionalFile(tsconfigPath, previousTsconfig, dependencies);
      throw error;
    } finally {
      dependencies.remove(stagingPath);
    }
  } finally {
    releaseLock();
  }
}

export function runConsoleBuildCli(
  arguments_: readonly string[] = process.argv.slice(2),
  environment: NodeJS.ProcessEnv = process.env
): void {
  const repositoryRoot = path.resolve(
    environment.AUTODEV_REPO_ROOT?.trim() ||
      resolveRuntimeSourceRoot(import.meta.dirname)
  );
  if (environment.AUTODEV_CONSOLE_BUILD_DIST_DIR) {
    const consoleRoot = path.join(repositoryRoot, "console");
    const nextCli = path.join(
      consoleRoot,
      "node_modules",
      "next",
      "dist",
      "bin",
      "next"
    );
    execFileSync(process.execPath, [nextCli, "build", ...arguments_], {
      cwd: consoleRoot,
      env: environment,
      stdio: "inherit"
    });
    return;
  }
  buildConsole({
    repositoryRoot,
    forceRebuild: !arguments_.includes("--if-needed")
  });
}

if (isEntryPoint(import.meta.url)) {
  try {
    runConsoleBuildCli();
  } catch (error) {
    writeErrorLine(
      `console-build: ${error instanceof Error ? error.message : String(error)}`
    );
    process.exitCode = 1;
  }
}
