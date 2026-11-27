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
    arguments_: readonly string[],
    environment: NodeJS.ProcessEnv
  ) => number;
  readonly fileExists: (filePath: string) => boolean;
  readonly createDirectory: (directory: string) => void;
  readonly readFile?: (filePath: string) => string;
}

function defaultDependencies(): OpencliBrowserInstallDeps {
  return {
    run: (command, arguments_, environment) =>
      spawnSync(command, [...arguments_], { env: environment, stdio: "inherit" }).status ?? 1,
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
  dependencies: OpencliBrowserInstallDeps
): boolean {
  const manifestPath = path.join(playwrightRoot, "browsers.json");
  const readFile =
    dependencies.readFile ?? ((filePath: string) => readFileSync(filePath, "utf8"));
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
  const requiredDirectories = [`chromium-${chromium.revision}`];
  const ffmpeg = browsers.find((entry) => entry.name === "ffmpeg");
  if (ffmpeg) {
    if (
      !ffmpeg.revision ||
      (ffmpeg.revisionOverrides &&
        Object.keys(ffmpeg.revisionOverrides).length > 0)
    ) {
      return false;
    }
    requiredDirectories.push(`ffmpeg-${ffmpeg.revision}`);
  }
  return requiredDirectories.every((directory) =>
    dependencies.fileExists(path.join(browserCache, directory, "INSTALLATION_COMPLETE"))
  );
}

/**
Install the Chromium version pinned by Runtime's Playwright dependency.
*/
export function installOpencliBrowser(
  options: OpencliBrowserInstallOptions,
  dependencies: OpencliBrowserInstallDeps = defaultDependencies(),
  environment: NodeJS.ProcessEnv = process.env
): number {
  const playwrightRoot = path.join(
    options.repositoryRoot,
    "runtime",
    "node_modules",
    "playwright-core"
  );
  const playwrightCli = path.join(playwrightRoot, "cli.js");
  if (!dependencies.fileExists(playwrightCli)) {
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
  if (isPinnedChromiumInstalled(playwrightRoot, browserCache, dependencies)) {
    return 0;
  }
  dependencies.createDirectory(browserCache);
  writeLine("installing AutoDev's pinned opencli Chromium browser");
  const status = dependencies.run(
    process.execPath,
    [playwrightCli, "install", "chromium", "--no-shell"],
    {
      ...environment,
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
