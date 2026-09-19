import assert from "node:assert/strict";
import {
  chmodSync,
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

test("Collector run validates exact version/config before foreground execution", () =>
  withTempDir((directory) => {
    const binary = join(directory, "otelcol");
    const validated = join(directory, "validated");
    const args = join(directory, "args");
    writeFileSync(join(directory, "collector.yaml"), "receivers: {}\n");
    writeFileSync(join(directory, "collector.version"), "v0.160.0\n");
    writeFileSync(
      binary,
      `#!/bin/sh\nif [ "$1" = "--version" ]; then echo 'otelcol version v0.160.0'; exit 0; fi\nif [ "$1" = "validate" ]; then touch '${validated}'; exit 0; fi\nprintf '%s\\n' "$@" > '${args}'\n`
    );
    chmodSync(binary, 0o700);
    const result = runCollector(options(directory, binary));
    assert.equal(result, 0);
    assert.equal(
      readFileSync(args, "utf8").trim(),
      `--config\n${join(directory, "collector.yaml")}`
    );
    assert.equal(readFileSync(validated, "utf8"), "");
  }));

test("Collector run rejects a pinned-version mismatch before validation", () =>
  withTempDir((directory) => {
    const binary = join(directory, "otelcol");
    writeFileSync(join(directory, "collector.yaml"), "receivers: {}\n");
    writeFileSync(join(directory, "collector.version"), "v0.160.0\n");
    writeFileSync(binary, '#!/bin/sh\necho "otelcol version v0.160.1"\n');
    chmodSync(binary, 0o700);
    assert.throws(
      () => runCollector(options(directory, binary)),
      /version mismatch/
    );
  }));
