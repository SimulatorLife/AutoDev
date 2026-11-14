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

import { writeErrorLine } from "@simulatorlife/autodev-runtime/shared/output";
import { resolveRuntimeSourceRoot } from "@simulatorlife/autodev-runtime/shared/runtime-source-root";

import { computeRepoPathsFingerprint } from "./runtime-files.ts";

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
    args: readonly string[],
    cwd: string,
    env: NodeJS.ProcessEnv
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

function defaultDeps(): ConsoleBuildDeps {
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
    run: (executable, args, cwd, env) => {
      execFileSync(executable, [...args], { cwd, env, stdio: "inherit" });
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
  return computeRepoPathsFingerprint(
    repositoryRoot,
    CONSOLE_BUILD_FINGERPRINT_PATHS
  );
}
const NEXT_ENV_FILE = "next-env.d.ts";
const TSCONFIG_FILE = "tsconfig.json";
const CACHE_DIR = "cache";
const RSC_INFO_FILE = ".rscinfo";
const SEEDED_CACHE_ENTRIES = [
  "webpack",
  "swc",
  ".tsbuildinfo",
  ".previewinfo"
] as const;
const STAGED_TYPES_INCLUDE_PATTERN =
  /^\.next-staging-[^/]+\/types\/\*\*\/\*\.ts$/u;
const PRODUCTION_TYPES_INCLUDE = `${PRODUCTION_DIST_DIR}/types/**/*.ts`;
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
  deps: ConsoleBuildDeps
): void {
  const nextEnvPath = path.join(consoleRoot, NEXT_ENV_FILE);
  if (!deps.fileExists(nextEnvPath)) return;
  const content = deps.readFile(nextEnvPath);
  const normalized = content.replaceAll(
    `./${stagingDistDir}/`,
    `./${PRODUCTION_DIST_DIR}/`
  );
  if (normalized !== content) deps.writeFile(nextEnvPath, normalized);
}

function isGeneratedTypesInclude(entry: string): boolean {
  return (
    STAGED_TYPES_INCLUDE_PATTERN.test(entry) ||
    entry === PRODUCTION_TYPES_INCLUDE
  );
}

function filterTsconfigInclude(
  includeList: readonly unknown[],
  targetTypesInclude: string
): unknown[] {
  const filtered: unknown[] = [];
  const seen = new Set<string>();
  let hadGeneratedTypesInclude = false;
  for (const entry of includeList) {
    if (typeof entry !== "string") {
      filtered.push(entry);
      continue;
    }
    if (isGeneratedTypesInclude(entry)) {
      hadGeneratedTypesInclude = true;
      if (entry !== targetTypesInclude) continue;
    }
    if (!seen.has(entry)) {
      seen.add(entry);
      filtered.push(entry);
    }
  }
  if (hadGeneratedTypesInclude && !seen.has(targetTypesInclude)) {
    const devTypesIndex = filtered.indexOf(".next-dev/types/**/*.ts");
    if (devTypesIndex === -1) {
      filtered.push(targetTypesInclude);
    } else {
      filtered.splice(devTypesIndex + 1, 0, targetTypesInclude);
    }
  }
  return filtered;
}

function normalizeGeneratedTsconfig(
  consoleRoot: string,
  deps: ConsoleBuildDeps,
  targetTypesInclude = PRODUCTION_TYPES_INCLUDE
): string | null {
  const tsconfigPath = path.join(consoleRoot, TSCONFIG_FILE);
  if (!deps.fileExists(tsconfigPath)) return null;
  const content = deps.readFile(tsconfigPath);
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
  record.include = filterTsconfigInclude(record.include, targetTypesInclude);
  const normalized = `${JSON.stringify(record, null, 2)}\n`;
  if (normalized !== content) deps.writeFile(tsconfigPath, normalized);
  return normalized;
}

function cleanStaleStagingDirs(
  consoleRoot: string,
  currentStagingDistDir: string,
  deps: ConsoleBuildDeps
): void {
  const readDir = deps.readDir ?? ((dirPath: string) => readdirSync(dirPath));
  const isAlive = deps.isProcessAlive ?? checkProcessAlive;
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
      deps.remove(path.join(consoleRoot, entry));
    }
  }
}

function seedStagingBuildCache(
  buildPath: string,
  stagingPath: string,
  deps: ConsoleBuildDeps
): readonly string[] {
  const buildCachePath = path.join(buildPath, CACHE_DIR);
  if (!deps.fileExists(buildCachePath)) return [];
  const stagingCachePath = path.join(stagingPath, CACHE_DIR);
  const ensureDir =
    deps.mkdir ??
    ((dirPath: string) => mkdirSync(dirPath, { recursive: true }));
  const movedSubdirs = SEEDED_CACHE_ENTRIES.filter((subdir) =>
    deps.fileExists(path.join(buildCachePath, subdir))
  );
  const rscInfoSource = path.join(buildCachePath, RSC_INFO_FILE);
  const hasRscInfo = deps.fileExists(rscInfoSource);
  if (!hasRscInfo && movedSubdirs.length === 0) return [];
  ensureDir(stagingCachePath);
  if (hasRscInfo) {
    deps.writeFile(
      path.join(stagingCachePath, RSC_INFO_FILE),
      deps.readFile(rscInfoSource)
    );
  }
  for (const subdir of movedSubdirs) {
    deps.rename(
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
  deps: ConsoleBuildDeps
): void {
  if (movedSubdirs.length === 0 || !deps.fileExists(buildPath)) return;
  const buildCachePath = path.join(buildPath, CACHE_DIR);
  const stagingCachePath = path.join(stagingPath, CACHE_DIR);
  const ensureDir =
    deps.mkdir ??
    ((dirPath: string) => mkdirSync(dirPath, { recursive: true }));
  ensureDir(buildCachePath);
  for (const subdir of movedSubdirs) {
    const stagedSubdir = path.join(stagingCachePath, subdir);
    const buildSubdir = path.join(buildCachePath, subdir);
    if (deps.fileExists(stagedSubdir) && !deps.fileExists(buildSubdir)) {
      try {
        deps.rename(stagedSubdir, buildSubdir);
      } catch {
        // Best-effort cache restoration on failed build.
      }
    }
  }
}

function restoreOptionalFile(
  filePath: string,
  previousContent: string | null,
  deps: ConsoleBuildDeps
): void {
  if (previousContent === null) {
    if (deps.fileExists(filePath)) deps.remove(filePath);
  } else {
    deps.writeFile(filePath, previousContent);
  }
}

function publishStagedBuild(
  stagingPath: string,
  buildPath: string,
  previousPath: string,
  deps: ConsoleBuildDeps
): void {
  if (deps.fileExists(previousPath)) deps.remove(previousPath);
  const hadCurrentBuild = deps.fileExists(buildPath);
  if (hadCurrentBuild) deps.rename(buildPath, previousPath);
  try {
    deps.rename(stagingPath, buildPath);
  } catch (error) {
    if (hadCurrentBuild && !deps.fileExists(buildPath)) {
      deps.rename(previousPath, buildPath);
    }
    throw error;
  }
  if (hadCurrentBuild) {
    try {
      deps.remove(previousPath);
    } catch {
      // A published build is usable; stale backup cleanup cannot invalidate it.
    }
  }
}

function recoverPreviousBuild(
  consoleRoot: string,
  deps: ConsoleBuildDeps
): void {
  const current = path.join(consoleRoot, PRODUCTION_DIST_DIR);
  const previous = path.join(consoleRoot, PREVIOUS_DIST_DIR);
  if (!deps.fileExists(current) && deps.fileExists(previous)) {
    deps.rename(previous, current);
  }
}

const BUILD_LOCK_DIR = ".next-build.lock";
const BUILD_LOCK_PID_FILE = "pid";
const BUILD_LOCK_POLL_MS = 100;
const BUILD_LOCK_TIMEOUT_MS = 300_000;
const BUILD_LOCK_EMPTY_GRACE_MS = 2000;

function readLockPid(pidFile: string, deps: ConsoleBuildDeps): number | null {
  if (!deps.fileExists(pidFile)) return null;
  const raw = deps.readFile(pidFile).trim();
  if (!DIGITS_ONLY_PATTERN.test(raw)) return null;
  const pid = Number(raw);
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

function isStaleLock(
  lockDir: string,
  pidFile: string,
  deps: ConsoleBuildDeps,
  missingPidSince: number | null,
  nowMs: number
): { readonly stale: boolean; readonly missingPidSince: number | null } {
  const pid = readLockPid(pidFile, deps);
  if (pid !== null) {
    const isAlive = deps.isProcessAlive ?? checkProcessAlive;
    return {
      stale: pid !== process.pid && !isAlive(pid),
      missingPidSince: null
    };
  }
  if (!deps.fileExists(lockDir)) {
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
  deps: ConsoleBuildDeps
): () => void {
  const tryCreate =
    deps.tryCreateDir ??
    (existsSync(consoleRoot) ? tryCreateDirSync : undefined);
  if (!tryCreate) return () => {};

  const lockDir = path.join(consoleRoot, BUILD_LOCK_DIR);
  const pidFile = path.join(lockDir, BUILD_LOCK_PID_FILE);
  const sleep = deps.sleepSync ?? sleepSyncDefault;
  const now = deps.now ?? Date.now;
  const start = now();
  let missingPidSince: number | null = null;

  for (;;) {
    if (tryCreate(lockDir)) {
      try {
        deps.writeFile(pidFile, `${process.pid}\n`);
      } catch (error) {
        deps.remove(lockDir);
        throw error;
      }
      return () => {
        deps.remove(lockDir);
      };
    }

    const nowMs = now();
    const staleCheck = isStaleLock(
      lockDir,
      pidFile,
      deps,
      missingPidSince,
      nowMs
    );
    missingPidSince = staleCheck.missingPidSince;
    if (staleCheck.stale) {
      deps.remove(lockDir);
      missingPidSince = null;
      continue;
    }

    if (nowMs - start >= BUILD_LOCK_TIMEOUT_MS) {
      const holder = readLockPid(pidFile, deps);
      throw new Error(
        `Timed out waiting for Console build lock at ${lockDir}${holder === null ? "" : ` (held by pid ${holder})`}.`
      );
    }
    sleep(BUILD_LOCK_POLL_MS);
  }
}

/**
 * Build in an isolated Next output directory, preserve the serving build until
 * compilation succeeds, then publish the new build for the managed Console
 * restart. A failed build must not damage the currently served artifact.
 */
export function buildConsole(
  options: ConsoleBuildOptions,
  deps: ConsoleBuildDeps = defaultDeps()
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
  if (!deps.fileExists(nextCli)) {
    throw new Error(
      `Console dependencies are missing at ${nextCli}; run pnpm install --frozen-lockfile first.`
    );
  }

  const releaseLock = acquireBuildLock(consoleRoot, deps);
  try {
    const stagingDistDir = `.next-staging-${process.pid}`;
    const stagingPath = path.join(consoleRoot, stagingDistDir);
    const buildPath = path.join(consoleRoot, PRODUCTION_DIST_DIR);
    const previousPath = path.join(consoleRoot, PREVIOUS_DIST_DIR);
    const buildIdPath = path.join(stagingPath, "BUILD_ID");
    const stampPath = path.join(buildPath, CONSOLE_BUILD_STAMP_FILE);
    const nextEnvPath = path.join(consoleRoot, NEXT_ENV_FILE);
    const tsconfigPath = path.join(consoleRoot, TSCONFIG_FILE);
    recoverPreviousBuild(consoleRoot, deps);
    if (
      !options.forceRebuild &&
      process.env.AUTODEV_FORCE_CONSOLE_BUILD !== "1" &&
      deps.fileExists(path.join(buildPath, "BUILD_ID")) &&
      deps.fileExists(stampPath) &&
      deps.readFile(stampPath).trim() ===
        computeConsoleBuildFingerprint(options.repositoryRoot)
    ) {
      cleanStaleStagingDirs(consoleRoot, stagingDistDir, deps);
      return;
    }
    cleanStaleStagingDirs(consoleRoot, stagingDistDir, deps);
    deps.remove(stagingPath);
    const previousNextEnv = deps.fileExists(nextEnvPath)
      ? deps.readFile(nextEnvPath)
      : null;
    const previousTsconfig = normalizeGeneratedTsconfig(consoleRoot, deps);
    normalizeGeneratedTsconfig(
      consoleRoot,
      deps,
      `${stagingDistDir}/types/**/*.ts`
    );
    const movedCacheSubdirs = seedStagingBuildCache(
      buildPath,
      stagingPath,
      deps
    );

    try {
      deps.run(
        options.nodeBin ?? process.execPath,
        [nextCli, "build"],
        consoleRoot,
        {
          ...process.env,
          AUTODEV_CONSOLE_BUILD_DIST_DIR: stagingDistDir
        }
      );
      if (!deps.fileExists(buildIdPath)) {
        throw new Error(
          "Next.js completed without producing the staged Console BUILD_ID."
        );
      }
      normalizeGeneratedTypeReference(consoleRoot, stagingDistDir, deps);
      normalizeGeneratedTsconfig(consoleRoot, deps);
      deps.writeFile(
        path.join(stagingPath, CONSOLE_BUILD_STAMP_FILE),
        `${computeConsoleBuildFingerprint(options.repositoryRoot)}\n`
      );
      publishStagedBuild(stagingPath, buildPath, previousPath, deps);
    } catch (error) {
      restoreBuildCacheOnFailure(
        buildPath,
        stagingPath,
        movedCacheSubdirs,
        deps
      );
      restoreOptionalFile(nextEnvPath, previousNextEnv, deps);
      restoreOptionalFile(tsconfigPath, previousTsconfig, deps);
      throw error;
    } finally {
      deps.remove(stagingPath);
    }
  } finally {
    releaseLock();
  }
}

export function runConsoleBuildCli(
  args: readonly string[] = process.argv.slice(2),
  env: NodeJS.ProcessEnv = process.env
): void {
  const repositoryRoot = path.resolve(
    env.AUTODEV_REPO_ROOT?.trim() ||
      resolveRuntimeSourceRoot(import.meta.dirname)
  );
  if (env.AUTODEV_CONSOLE_BUILD_DIST_DIR) {
    const consoleRoot = path.join(repositoryRoot, "console");
    const nextCli = path.join(
      consoleRoot,
      "node_modules",
      "next",
      "dist",
      "bin",
      "next"
    );
    execFileSync(process.execPath, [nextCli, "build", ...args], {
      cwd: consoleRoot,
      env,
      stdio: "inherit"
    });
    return;
  }
  buildConsole({
    repositoryRoot,
    forceRebuild: !args.includes("--if-needed")
  });
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  try {
    runConsoleBuildCli();
  } catch (error) {
    writeErrorLine(
      `console-build: ${error instanceof Error ? error.message : String(error)}`
    );
    process.exitCode = 1;
  }
}
