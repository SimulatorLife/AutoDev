import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { listBundledPlugins } from "@simulatorlife/autodev-runtime/shared/bundled-plugins";

function emptyCodexHome(): string {
  return mkdtempSync(path.join(tmpdir(), "autodev-bundled-plugins-"));
}

test("the bundled plugin list is the installed plugin names of the bundled marketplace", () => {
  const codexHome = emptyCodexHome();
  try {
    const cache = path.join(codexHome, "plugins", "cache", "openai-bundled");
    mkdirSync(path.join(cache, "browser", "26.1.1"), { recursive: true });
    mkdirSync(path.join(cache, "codex-app-tools", "26.1.1"), {
      recursive: true
    });
    writeFileSync(path.join(cache, "notes.txt"), "not a plugin");
    assert.deepEqual(listBundledPlugins(codexHome), [
      "browser",
      "codex-app-tools"
    ]);
  } finally {
    rmSync(codexHome, { recursive: true, force: true });
  }
});

test("an absent plugin cache is an empty list rather than an error", () => {
  const codexHome = emptyCodexHome();
  try {
    assert.deepEqual(listBundledPlugins(codexHome), []);
  } finally {
    rmSync(codexHome, { recursive: true, force: true });
  }
});
