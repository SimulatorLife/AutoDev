import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  provisionCollector,
  type ProvisionOptions,
  resolveProvisionOptions
} from "../../src/platform/otel-provision.ts";

function withTempDir<T>(callback: (directory: string) => T): T {
  const directory = mkdtempSync(join(tmpdir(), "autodev-otel-provision-"));
  try {
    return callback(directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function options(
  directory: string,
  explicitBinary: string | null
): ProvisionOptions {
  return {
    repositoryRoot: directory,
    codexHome: directory,
    artifactFile: join(directory, "artifacts.json"),
    versionFile: join(directory, "collector.version"),
    target: join(directory, "otelcol"),
    explicitBinary
  };
}

test("provision options preserve repository and machine-local boundaries", () => {
  const result = resolveProvisionOptions({
    HOME: "/home/test",
    CODEX_HOME: "/home/test/.codex",
    AUTODEV_OTEL_REPO_ROOT: "/repo",
    AUTODEV_OTELCOL_BIN: "/bin/otelcol"
  });
  assert.equal(result.repositoryRoot, "/repo");
  assert.equal(result.codexHome, "/home/test/.codex");
  assert.equal(result.explicitBinary, "/bin/otelcol");
});

test("explicit host binaries are validated without downloading an artifact", async () =>
  withTempDir(async (directory) => {
    const binary = join(directory, "otelcol");
    writeFileSync(binary, "#!/bin/sh\nexit 0\n");
    chmodSync(binary, 0o700);
    assert.equal(await provisionCollector(options(directory, binary)), 0);
  }));

test("invalid explicit binaries fail before any network or filesystem provisioning", async () =>
  withTempDir(async (directory) => {
    await assert.rejects(
      () => provisionCollector(options(directory, join(directory, "missing"))),
      /not executable/
    );
  }));

test("manifest version drift fails before selecting a host artifact", async () =>
  withTempDir(async (directory) => {
    const current = options(directory, null);
    writeFileSync(current.versionFile, "v0.160.0\n");
    writeFileSync(
      current.artifactFile,
      JSON.stringify({ version: "v0.160.1", assets: {} })
    );
    await assert.rejects(() => provisionCollector(current), /manifest version/);
  }));
