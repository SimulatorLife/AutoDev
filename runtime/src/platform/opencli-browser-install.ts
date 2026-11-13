import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
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
}

function defaultDeps(): OpencliBrowserInstallDeps {
  return {
    run: (command, args, env) =>
      spawnSync(command, [...args], { env, stdio: "inherit" }).status ?? 1,
    fileExists: existsSync,
    createDirectory: (directory) =>
      mkdirSync(directory, { recursive: true, mode: 0o700 })
  };
}

/** Install the Chromium version pinned by Runtime's Playwright dependency. */
export function installOpencliBrowser(
  options: OpencliBrowserInstallOptions,
  deps: OpencliBrowserInstallDeps = defaultDeps(),
  env: NodeJS.ProcessEnv = process.env
): number {
  const playwrightCli = path.join(
    options.repositoryRoot,
    "runtime",
    "node_modules",
    "playwright-core",
    "cli.js"
  );
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
