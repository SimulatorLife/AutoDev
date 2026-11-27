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

import * as hookRoots from "../src/hooks/hook-roots.ts";

test("hook root helpers expose AutoDev and Codex home roots", () => {
  assert.deepEqual(Object.keys(hookRoots).sort(), [
    "autodevHome",
    "autodevStateHome",
    "codexHome",
    "repositoryRoot"
  ]);
});

test("repositoryRoot resolves the Runtime source tree without a configured override", () => {
  const previous = process.env.AUTODEV_REPO_ROOT;
  delete process.env.AUTODEV_REPO_ROOT;
  try {
    assert.equal(
      hookRoots.repositoryRoot(),
      path.resolve(fileURLToPath(new URL("../../", import.meta.url)))
    );
    assert.equal(
      resolveRuntimeSourcePath(hookRoots.repositoryRoot(), "mcp/launcher.ts"),
      path.resolve(
        fileURLToPath(new URL("../src/mcp/launcher.ts", import.meta.url))
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
  const installedModule = path.join(installedHooks, "hook-roots.ts");
  mkdirSync(installedHooks, { recursive: true });
  symlinkSync(
    fileURLToPath(new URL("../../node_modules", import.meta.url)),
    path.join(codexHome, "node_modules"),
    "dir"
  );
  copyFileSync(
    fileURLToPath(new URL("../src/hooks/hook-roots.ts", import.meta.url)),
    installedModule
  );
  delete process.env.AUTODEV_REPO_ROOT;
  process.env.CODEX_HOME = codexHome;
  try {
    const installed = await import(pathToFileURL(installedModule).href);
    assert.equal(installed.repositoryRoot(), realpathSync(codexHome));
    assert.equal(
      resolveRuntimeSourcePath(realpathSync(codexHome), "mcp/launcher.ts"),
      path.join(realpathSync(codexHome), "src", "mcp", "launcher.ts")
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
