import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
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
import { fileURLToPath } from "node:url";

import {
  type CollectorOptions,
  ensureCollector,
  runCollector
} from "../../src/platform/otel-collector.ts";

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
const originalPath = process.env.PATH;

function withTempDir<T>(callback: (directory: string) => T): T {
  const directory = mkdtempSync(join(tmpdir(), "autodev-otel-runtime-"));
  try {
    return callback(directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
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

function withPath<T>(directory: string, callback: () => T): T {
  process.env.PATH = `${join(directory, "bin")}:${originalPath ?? ""}`;
  try {
    return callback();
  } finally {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
  }
}

test("Collector run uses an explicit binary and exact version/config", () =>
  withTempDir((directory) => {
    baseFiles(directory);
    const binary = fakeBinary(directory);
    const result = runCollector(options(directory, binary));
    assert.equal(result, 0);
    assert.equal(readFileSync(join(directory, "validated"), "utf8"), "");
    assert.equal(
      readFileSync(join(directory, "args"), "utf8").trim(),
      `--config\n${join(directory, "collector.yaml")}`
    );
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
    assert.equal(existsSync(join(directory, "validated")), false);
  }));

test("Collector check validates an existing listener without starting a duplicate", () =>
  withTempDir((directory) => {
    baseFiles(directory);
    const binary = fakeBinary(directory);
    const result = runCollector(options(directory, binary), true);
    assert.equal(result, 0);
  }));

test("Collector run refuses an existing HTTP service as a duplicate", () =>
  withTempDir((directory) => {
    baseFiles(directory);
    const binary = fakeBinary(directory);
    const bin = join(directory, "bin");
    writeFileSync(join(directory, "curl"), "#!/bin/sh\nprintf 200\n");
    chmodSync(join(directory, "curl"), 0o700);
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, "curl"), "#!/bin/sh\nprintf 200\n");
    chmodSync(join(bin, "curl"), 0o700);
    assert.throws(
      () => withPath(directory, () => runCollector(options(directory, binary))),
      /duplicate/
    );
  }));

test("Collector ensure starts once and keeps its state private", async () => {
  const directory = mkdtempSync(join(tmpdir(), "autodev-otel-ensure-"));
  try {
    baseFiles(directory);
    const runDir = join(directory, "run");
    const ready = join(directory, "ready");
    const childPid = join(directory, "child.pid");
    const runner = join(directory, "runner.sh");
    const bin = join(directory, "bin");
    mkdirSync(bin, { recursive: true });
    writeFileSync(
      runner,
      `#!/bin/sh
echo $$ > '${childPid}'
touch '${ready}'
sleep 30
`
    );
    chmodSync(runner, 0o700);
    writeFileSync(
      join(bin, "curl"),
      `#!/bin/sh
test -f '${ready}' && printf 404 || printf 000
`
    );
    chmodSync(join(bin, "curl"), 0o700);
    const collectorOptions = {
      ...options(directory, join(directory, "otelcol")),
      runner,
      runDir,
      pidFile: join(runDir, "collector.pid"),
      ensureLog: join(runDir, "collector.log"),
      startTimeoutSeconds: 3
    };
    await withPath(directory, () => ensureCollector(collectorOptions));
    assert.equal(readFileSync(childPid, "utf8").trim().length > 0, true);
    assert.equal(statSync(runDir).mode & 0o777, 0o700);
    assert.equal(existsSync(collectorOptions.pidFile), false);
    const pid = Number(readFileSync(childPid, "utf8").trim());
    if (Number.isInteger(pid) && pid > 0) {
      try {
        process.kill(pid, "SIGTERM");
      } catch {
        /* already exited */
      }
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("Collector LaunchAgent stays foreground, keep-alive, and private", () => {
  const plist = readFileSync(
    join(repositoryRoot, "config/launchagents/com.codex.otel-collector.plist"),
    "utf8"
  );
  assert.match(
    plist,
    /<key>Label<\/key>\s*<string>com\.codex\.otel-collector<\/string>/
  );
  assert.match(plist, /<key>KeepAlive<\/key>\s*<true\/>/);
  assert.match(plist, /<string>\/bin\/bash<\/string>/);
  assert.match(plist, /run-autodev-otel-collector\.sh/);
  assert.match(plist, /__CODEX_HOME__\/run\//);
});
