import { execFileSync } from "node:child_process";
import {
  existsSync,
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

function defaultDeps(): ConsoleBuildDeps {
  return {
    fileExists: existsSync,
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
  recoverPreviousBuild(consoleRoot, deps);
  deps.remove(stagingPath);
  const previousNextEnv = deps.fileExists(nextEnvPath)
    ? deps.readFile(nextEnvPath)
    : undefined;

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
  } catch (error) {
    if (previousNextEnv === undefined) {
      if (deps.fileExists(nextEnvPath)) deps.remove(nextEnvPath);
    } else {
      deps.writeFile(nextEnvPath, previousNextEnv);
    }
    throw error;
  } finally {
    deps.remove(stagingPath);
  }
}
