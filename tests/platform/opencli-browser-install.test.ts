import assert from "node:assert/strict";
import test from "node:test";

import { installOpencliBrowser } from "@simulatorlife/autodev-runtime/platform/opencli-browser-install";

const repositoryRoot = "/workspace/autodev";
const codexHome = "/home/operator/.codex";
const playwrightCli = `${repositoryRoot}/runtime/node_modules/playwright-core/cli.js`;
const browserCache = `${codexHome}/provider-runtime/opencli/browsers`;

function dependencies(
  overrides: {
    readonly fileExists?: (filePath: string) => boolean;
    readonly createDirectory?: (directory: string) => void;
    readonly run?: (
      command: string,
      args: readonly string[],
      env: NodeJS.ProcessEnv
    ) => number;
  } = {}
) {
  return {
    fileExists: overrides.fileExists ?? (() => true),
    createDirectory: overrides.createDirectory ?? (() => undefined),
    run: overrides.run ?? (() => 0)
  };
}

test("installs only the Runtime-pinned headed Chromium into AutoDev's private cache", () => {
  let directory = "";
  let invocation: {
    command: string;
    args: readonly string[];
    env: NodeJS.ProcessEnv;
  } | null = null;
  const status = installOpencliBrowser(
    { repositoryRoot, codexHome },
    dependencies({
      createDirectory: (path) => {
        directory = path;
      },
      run: (command, args, env) => {
        invocation = { command, args, env };
        return 0;
      }
    }),
    { KEEP: "value" }
  );

  assert.equal(status, 0);
  assert.equal(directory, browserCache);
  assert.deepEqual(invocation, {
    command: process.execPath,
    args: [playwrightCli, "install", "chromium", "--no-shell"],
    env: {
      KEEP: "value",
      CODEX_HOME: codexHome,
      PLAYWRIGHT_BROWSERS_PATH: browserCache
    }
  });
});

test("does not run Playwright when the pinned Runtime CLI is missing", () => {
  let ran = false;
  let createdDirectory = false;
  const status = installOpencliBrowser(
    { repositoryRoot, codexHome },
    dependencies({
      fileExists: (filePath) => filePath !== playwrightCli,
      createDirectory: () => {
        createdDirectory = true;
      },
      run: () => {
        ran = true;
        return 0;
      }
    })
  );

  assert.equal(status, 1);
  assert.equal(ran, false);
  assert.equal(createdDirectory, false);
});

test("propagates a failed browser download to the normal installer", () => {
  const status = installOpencliBrowser(
    { repositoryRoot, codexHome },
    dependencies({ run: () => 17 })
  );

  assert.equal(status, 17);
});

test("skips Playwright download when the pinned Chromium and ffmpeg markers already exist", () => {
  let ran = false;
  let createdDirectory = false;
  const manifestPath = `${repositoryRoot}/runtime/node_modules/playwright-core/browsers.json`;
  const status = installOpencliBrowser(
    { repositoryRoot, codexHome },
    {
      fileExists: (filePath) =>
        filePath === playwrightCli ||
        filePath === `${browserCache}/chromium-1243/INSTALLATION_COMPLETE` ||
        filePath === `${browserCache}/ffmpeg-1011/INSTALLATION_COMPLETE`,
      createDirectory: () => {
        createdDirectory = true;
      },
      readFile: (filePath) => {
        if (filePath !== manifestPath) throw new Error(`unexpected read ${filePath}`);
        return JSON.stringify({
          browsers: [
            { name: "chromium", revision: "1243" },
            { name: "ffmpeg", revision: "1011" }
          ]
        });
      },
      run: () => {
        ran = true;
        return 0;
      }
    }
  );

  assert.equal(status, 0);
  assert.equal(ran, false);
  assert.equal(createdDirectory, false);
});

test("reinstalls when the Playwright manifest bumps the pinned Chromium revision", () => {
  let ran = false;
  const manifestPath = `${repositoryRoot}/runtime/node_modules/playwright-core/browsers.json`;
  const status = installOpencliBrowser(
    { repositoryRoot, codexHome },
    {
      fileExists: (filePath) =>
        filePath === playwrightCli ||
        filePath === `${browserCache}/chromium-1243/INSTALLATION_COMPLETE` ||
        filePath === `${browserCache}/ffmpeg-1011/INSTALLATION_COMPLETE`,
      createDirectory: () => undefined,
      readFile: (filePath) => {
        if (filePath !== manifestPath) throw new Error(`unexpected read ${filePath}`);
        return JSON.stringify({
          browsers: [
            { name: "chromium", revision: "1250" },
            { name: "ffmpeg", revision: "1011" }
          ]
        });
      },
      run: () => {
        ran = true;
        return 0;
      }
    }
  );

  assert.equal(status, 0);
  assert.equal(ran, true);
});
