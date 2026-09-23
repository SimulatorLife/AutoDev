import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  type CollectorOptions,
  resolveCollectorOptions,
  runCollector
} from "../../src/platform/otel-collector.ts";

function withTempDir<T>(callback: (directory: string) => T): T {
  const directory = mkdtempSync(join(tmpdir(), "autodev-otel-collector-"));
  try {
    return callback(directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function options(directory: string, binary: string): CollectorOptions {
  return {
    repositoryRoot: directory,
    codexHome: directory,
    host: "127.0.0.1",
    port: 0,
    configFile: join(directory, "collector.yaml"),
    versionFile: join(directory, "collector.version"),
    binary,
    moduleFile: join(directory, "otel-collector.ts"),
    runner: join(directory, "runner.sh"),
    runDir: join(directory, "run"),
    pidFile: join(directory, "run", "collector.pid"),
    ensureLog: join(directory, "run", "collector.log"),
    startTimeoutSeconds: 1
  };
}

function baseFiles(directory: string): void {
  writeFileSync(join(directory, "collector.yaml"), "receivers: {}\n");
  writeFileSync(join(directory, "collector.version"), "v0.160.0\n");
}

function fakeBinary(directory: string, version = "0.160.0"): string {
  const binary = join(directory, "otelcol");
  const validated = join(directory, "validated");
  const args = join(directory, "args");
  writeFileSync(
    binary,
    String.raw`#!/bin/sh
if [ "$1" = "--version" ]; then echo 'otelcol version ${version}'; exit 0; fi
if [ "$1" = "validate" ]; then : > '${validated}'; exit 0; fi
printf '%s\n' "$@" > '${args}'
`
  );
  chmodSync(binary, 0o700);
  return binary;
}

test("Collector option resolution keeps repository and CODEX_HOME boundaries explicit", () => {
  const result = resolveCollectorOptions({
    HOME: "/home/test",
    CODEX_HOME: "/home/test/.codex",
    AUTODEV_OTEL_REPO_ROOT: "/repo",
    AUTODEV_OTEL_MODE: "collector"
  });
  assert.equal(result.repositoryRoot, "/repo");
  assert.equal(result.codexHome, "/home/test/.codex");
  assert.equal(result.configFile, "/repo/config/otel/collector.yaml");
});

test("Collector run checks the pinned version and leaves config validation to the Collector's own start", () =>
  withTempDir((directory) => {
    baseFiles(directory);
    const binary = fakeBinary(directory);
    const result = runCollector(options(directory, binary));
    assert.equal(result, 0);
    assert.equal(
      readFileSync(join(directory, "args"), "utf8").trim(),
      `--config\n${join(directory, "collector.yaml")}`
    );
    assert.equal(
      existsSync(join(directory, "validated")),
      false,
      "otelcol --config validates on start; a separate validate launch is redundant"
    );
  }));

test("Collector check still validates the config with the pinned binary", () =>
  withTempDir((directory) => {
    baseFiles(directory);
    const binary = fakeBinary(directory);
    assert.equal(runCollector(options(directory, binary), true), 0);
    assert.equal(existsSync(join(directory, "validated")), true);
    assert.equal(existsSync(join(directory, "args")), false);
  }));

test("Collector run accepts v-prefixed version output", () =>
  withTempDir((directory) => {
    baseFiles(directory);
    const binary = fakeBinary(directory, "v0.160.0");
    const result = runCollector(options(directory, binary));
    assert.equal(result, 0);
  }));

test("Collector run rejects a pinned-version mismatch before validation", () =>
  withTempDir((directory) => {
    baseFiles(directory);
    const binary = fakeBinary(directory, "0.160.1");
    assert.throws(
      () => runCollector(options(directory, binary)),
      /version mismatch/
    );
  }));
