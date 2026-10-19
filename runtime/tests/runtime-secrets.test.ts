import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { readRuntimeSecret } from "@simulatorlife/autodev-runtime/shared/runtime-secrets";

function fixture(): { root: string; codexHome: string } {
  const root = mkdtempSync(path.join(tmpdir(), "autodev-runtime-secret-"));
  const codexHome = path.join(root, ".codex");
  mkdirSync(codexHome, { recursive: true, mode: 0o700 });
  return { root, codexHome };
}

test("readRuntimeSecret reads only the exact key from the protected Runtime file", () => {
  const f = fixture();
  try {
    writeFileSync(
      path.join(f.codexHome, "openlit-secrets.env"),
      [
        "AUTODEV_CONTROL_API_TOKEN=general-token",
        'export AUTODEV_PLAYTEST_CONTROL_API_TOKEN="runner-token"',
        "PREFIX_AUTODEV_PLAYTEST_CONTROL_API_TOKEN=not-the-key",
        "# AUTODEV_PLAYTEST_CONTROL_API_TOKEN=commented-out"
      ].join("\n") + "\n",
      { mode: 0o600 }
    );
    assert.equal(
      readRuntimeSecret("AUTODEV_PLAYTEST_CONTROL_API_TOKEN", {
        HOME: f.root
      }),
      "runner-token"
    );
    assert.equal(
      readRuntimeSecret("AUTODEV_CONTROL_API_TOKEN", { HOME: f.root }),
      "general-token"
    );
    assert.equal(
      readRuntimeSecret("AUTODEV_PLAYTEST_CONTROL_API_TOKEN", {
        HOME: f.root,
        AUTODEV_PLAYTEST_CONTROL_API_TOKEN: "process-runner-token"
      }),
      "process-runner-token"
    );
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("readRuntimeSecret fails closed when the exact key or secret file is absent", () => {
  const f = fixture();
  try {
    writeFileSync(
      path.join(f.codexHome, "openlit-secrets.env"),
      "AUTODEV_CONTROL_API_TOKEN=general-token\n"
    );
    assert.equal(
      readRuntimeSecret("AUTODEV_PLAYTEST_CONTROL_API_TOKEN", {
        HOME: f.root
      }),
      null
    );
    assert.equal(
      readRuntimeSecret("AUTODEV_PLAYTEST_CONTROL_API_TOKEN", {
        HOME: path.join(f.root, "missing")
      }),
      null
    );
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});
