import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";

import {
  writeErrorLine,
  writeLine
} from "@simulatorlife/autodev-runtime/shared/output";

export interface OpencliBrowserInstallOptions {
  readonly repositoryRoot: string;
  readonly codexHome: string;
}

export interface OpencliBrowserInstallDeps {
  readonly run: (
    command: string,
    args: readonly string[],
    env: NodeJS.ProcessEnv
  ) => number;
  readonly fileExists: (filePath: string) => boolean;
  readonly createDirectory: (directory: string) => void;
  readonly readFile?: (filePath: string) => string;
}

function defaultDeps(): OpencliBrowserInstallDeps {
  return {
    run: (command, args, env) =>
      spawnSync(command, [...args], { env, stdio: "inherit" }).status ?? 1,
    fileExists: existsSync,
    createDirectory: (directory) =>
      mkdirSync(directory, { recursive: true, mode: 0o700 }),
    readFile: (filePath) => readFileSync(filePath, "utf8")
  };
}

interface PlaywrightBrowsersManifest {
  browsers?: Array<{
    name?: string;
    revision?: string;
    revisionOverrides?: Record<string, string>;
  }>;
}

function isPinnedChromiumInstalled(
  playwrightRoot: string,
  browserCache: string,
  deps: OpencliBrowserInstallDeps
): boolean {
  const manifestPath = path.join(playwrightRoot, "browsers.json");
  const readFile = deps.readFile ?? ((filePath: string) => readFileSync(filePath, "utf8"));
  let parsed: PlaywrightBrowsersManifest;
  try {
    parsed = JSON.parse(readFile(manifestPath)) as PlaywrightBrowsersManifest;
  } catch {
    return false;
  }
  const browsers = Array.isArray(parsed.browsers) ? parsed.browsers : [];
  const chromium = browsers.find((entry) => entry.name === "chromium");
  if (
    !chromium?.revision ||
    (chromium.revisionOverrides &&
      Object.keys(chromium.revisionOverrides).length > 0)
  ) {
    return false;
  }
  const requiredDirs = [`chromium-${chromium.revision}`];
  const ffmpeg = browsers.find((entry) => entry.name === "ffmpeg");
  if (ffmpeg) {
    if (
      !ffmpeg.revision ||
      (ffmpeg.revisionOverrides &&
        Object.keys(ffmpeg.revisionOverrides).length > 0)
    ) {
      return false;
    }
    requiredDirs.push(`ffmpeg-${ffmpeg.revision}`);
  }
  return requiredDirs.every((directory) =>
    deps.fileExists(path.join(browserCache, directory, "INSTALLATION_COMPLETE"))
  );
}

/** Install the Chromium version pinned by Runtime's Playwright dependency. */
export function installOpencliBrowser(
  options: OpencliBrowserInstallOptions,
  deps: OpencliBrowserInstallDeps = defaultDeps(),
  env: NodeJS.ProcessEnv = process.env
): number {
  const playwrightRoot = path.join(
    options.repositoryRoot,
    "runtime",
    "node_modules",
    "playwright-core"
  );
  const playwrightCli = path.join(playwrightRoot, "cli.js");
  if (!deps.fileExists(playwrightCli)) {
    writeErrorLine(
      `missing Runtime Playwright CLI at ${playwrightCli}; run pnpm install --frozen-lockfile`
    );
    return 1;
  }

  const browserCache = path.join(
    options.codexHome,
    "provider-runtime",
    "opencli",
    "browsers"
  );
  if (isPinnedChromiumInstalled(playwrightRoot, browserCache, deps)) {
    return 0;
  }
  deps.createDirectory(browserCache);
  writeLine("installing AutoDev's pinned opencli Chromium browser");
  const status = deps.run(
    process.execPath,
    [playwrightCli, "install", "chromium", "--no-shell"],
    {
      ...env,
      CODEX_HOME: options.codexHome,
      PLAYWRIGHT_BROWSERS_PATH: browserCache
    }
  );
  if (status !== 0) {
    writeErrorLine(
      `could not install the opencli browser (installer exited ${status})`
    );
  }
  return status;
}
