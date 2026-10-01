import assert from "node:assert/strict";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { resolveRuntimeSourcePath } from "@simulatorlife/autodev-runtime/shared/runtime-source-root";

import * as commandUtils from "../../runtime/src/hooks/command-utils.ts";

test("command utilities expose only paths consumed by root delegation", () => {
  assert.deepEqual(Object.keys(commandUtils).sort(), [
    "codexHome",
    "repositoryRoot"
  ]);
});

test("repositoryRoot resolves the Runtime source tree without a configured override", () => {
  const previous = process.env.AUTODEV_REPO_ROOT;
  delete process.env.AUTODEV_REPO_ROOT;
  try {
    assert.equal(
      commandUtils.repositoryRoot(),
      path.resolve(fileURLToPath(new URL("../../", import.meta.url)))
    );
    assert.equal(
      resolveRuntimeSourcePath(
        commandUtils.repositoryRoot(),
        "mcp/tool-filter.ts"
      ),
      path.resolve(
        fileURLToPath(
          new URL("../../runtime/src/mcp/tool-filter.ts", import.meta.url)
        )
      )
    );
  } finally {
    if (previous === undefined) delete process.env.AUTODEV_REPO_ROOT;
    else process.env.AUTODEV_REPO_ROOT = previous;
  }
});

test("repositoryRoot falls back to CODEX_HOME for an installed hook copy", async () => {
  const previousRepositoryRoot = process.env.AUTODEV_REPO_ROOT;
  const previousCodexHome = process.env.CODEX_HOME;
  const temporaryRoot = mkdtempSync(path.join(tmpdir(), "autodev-hook-home-"));
  const codexHome = path.join(temporaryRoot, ".codex");
  const installedHooks = path.join(codexHome, "src", "hooks");
  const installedModule = path.join(installedHooks, "command-utils.ts");
  mkdirSync(installedHooks, { recursive: true });
  symlinkSync(
    fileURLToPath(new URL("../../node_modules", import.meta.url)),
    path.join(codexHome, "node_modules"),
    "dir"
  );
  copyFileSync(
    fileURLToPath(
      new URL("../../runtime/src/hooks/command-utils.ts", import.meta.url)
    ),
    installedModule
  );
  delete process.env.AUTODEV_REPO_ROOT;
  process.env.CODEX_HOME = codexHome;
  try {
    const installed = await import(pathToFileURL(installedModule).href);
    assert.equal(installed.repositoryRoot(), realpathSync(codexHome));
    assert.equal(
      resolveRuntimeSourcePath(realpathSync(codexHome), "mcp/tool-filter.ts"),
      path.join(realpathSync(codexHome), "src", "mcp", "tool-filter.ts")
    );
  } finally {
    if (previousRepositoryRoot === undefined)
      delete process.env.AUTODEV_REPO_ROOT;
    else process.env.AUTODEV_REPO_ROOT = previousRepositoryRoot;
    if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousCodexHome;
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
});
