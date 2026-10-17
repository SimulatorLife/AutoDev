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

export interface ConsoleBuildOptions {
  readonly repositoryRoot: string;
  readonly nodeBin?: string;
}

export interface ConsoleBuildDeps {
  readonly fileExists: (filePath: string) => boolean;
  readonly mkdir?: (dirPath: string) => void;
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

function defaultDeps(): ConsoleBuildDeps {
  return {
    fileExists: existsSync,
    mkdir: (dirPath) => mkdirSync(dirPath, { recursive: true }),
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

  const stagingDistDir = `.next-staging-${process.pid}`;
  const stagingPath = path.join(consoleRoot, stagingDistDir);
  const buildPath = path.join(consoleRoot, PRODUCTION_DIST_DIR);
  const previousPath = path.join(consoleRoot, PREVIOUS_DIST_DIR);
  const buildIdPath = path.join(stagingPath, "BUILD_ID");
  const nextEnvPath = path.join(consoleRoot, NEXT_ENV_FILE);
  const tsconfigPath = path.join(consoleRoot, TSCONFIG_FILE);
  recoverPreviousBuild(consoleRoot, deps);
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
  const movedCacheSubdirs = seedStagingBuildCache(buildPath, stagingPath, deps);

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
}
