import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { executableArch, hostArch } from "../../src/platform/host-arch.ts";
import {
  provisionCollector,
  type ProvisionOptions,
  resolveProvisionOptions
} from "../../src/platform/otel-provision.ts";
import { executableHeader } from "./executable-header.ts";

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

test("an existing Collector built for the wrong architecture is replaced with the native build", async () =>
  withTempDir(async (directory) => {
    const host = hostArch();
    const foreign = host === "arm64" ? "amd64" : "arm64";
    const current = options(directory, null);
    writeFileSync(current.target, executableHeader(foreign));
    chmodSync(current.target, 0o700);
    const replacedInode = statSync(current.target).ino;

    const staging = join(directory, "release");
    mkdirSync(staging);
    writeFileSync(join(staging, "otelcol"), executableHeader(host));
    chmodSync(join(staging, "otelcol"), 0o755);
    const archive = join(directory, "otelcol.tar.gz");
    execFileSync("tar", ["-czf", archive, "-C", staging, "otelcol"]);
    const archiveBytes = readFileSync(archive);
    const sha256 = createHash("sha256").update(archiveBytes).digest("hex");
    writeFileSync(current.versionFile, "v0.160.0\n");
    writeFileSync(
      current.artifactFile,
      JSON.stringify({
        version: "v0.160.0",
        assets: Object.fromEntries(
          ["darwin/arm64", "darwin/amd64", "linux/arm64", "linux/amd64"].map(
            (key) => [key, { name: "otelcol.tar.gz", sha256 }]
          )
        )
      })
    );

    const originalFetch = globalThis.fetch;
    const downloads: string[] = [];
    globalThis.fetch = (async (url: string | URL | Request) => {
      downloads.push(String(url));
      return new Response(archiveBytes);
    }) as typeof fetch;
    try {
      assert.equal(await provisionCollector(current), 0);
    } finally {
      globalThis.fetch = originalFetch;
    }
    assert.equal(downloads.length, 1);
    assert.equal(executableArch(current.target), host);
    assert.notEqual(
      statSync(current.target).ino,
      replacedInode,
      "the running Collector's file is replaced, not rewritten in place"
    );

    globalThis.fetch = (async () => {
      throw new Error("a native Collector must not be downloaded again");
    }) as typeof fetch;
    try {
      assert.equal(await provisionCollector(current), 0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  }));
