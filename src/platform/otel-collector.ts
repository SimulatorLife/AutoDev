import { execFileSync, spawn, spawnSync } from "node:child_process";
import {
  accessSync,
  chmodSync,
  constants as fsConstants,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

import { writeErrorLine, writeLine } from "../shared/output.ts";

export interface CollectorOptions {
  readonly repositoryRoot: string;
  readonly codexHome: string;
  readonly host: string;
  readonly port: number;
  readonly configFile: string;
  readonly versionFile: string;
  readonly binary: string | null;
  readonly moduleFile: string;
  readonly runner: string;
  readonly runDir: string;
  readonly pidFile: string;
  readonly ensureLog: string;
  readonly startTimeoutSeconds: number;
}

const DEFAULT_VERSION = /^v[0-9]+\.[0-9]+\.[0-9]+(?:-[A-Za-z0-9.-]+)?$/u;

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function repoRoot(env: NodeJS.ProcessEnv): string {
  return (
    env.AUTODEV_OTEL_REPO_ROOT?.trim() || path.join(import.meta.dirname, "..", "..")
  );
}

export function resolveCollectorOptions(
  env: NodeJS.ProcessEnv = process.env
): CollectorOptions {
  const home = env.HOME?.trim() || homedir();
  const codexHome = env.CODEX_HOME?.trim() || path.join(home, ".codex");
  const root = repoRoot(env);
  const moduleFile =
    env.AUTODEV_OTEL_MODULE?.trim() ||
    path.join(codexHome, "src", "platform", "otel-collector.ts");
  return {
    repositoryRoot: root,
    codexHome,
    host: env.AUTODEV_OTEL_HOST?.trim() || "127.0.0.1",
    port: positiveInteger(env.AUTODEV_OTEL_PORT, 4318),
    configFile:
      env.AUTODEV_OTEL_CONFIG?.trim() ||
      path.join(root, "config", "otel", "collector.yaml"),
    versionFile:
      env.AUTODEV_OTEL_VERSION_FILE?.trim() ||
      path.join(root, "config", "otel", "collector.version"),
    binary: env.AUTODEV_OTELCOL_BIN?.trim() || null,
    moduleFile,
    runner: env.AUTODEV_OTEL_RUNNER?.trim() || moduleFile,
    runDir: env.AUTODEV_OTEL_RUN_DIR?.trim() || path.join(codexHome, "run"),
    pidFile: path.join(
      env.AUTODEV_OTEL_RUN_DIR?.trim() || path.join(codexHome, "run"),
      "autodev-otel-collector.pid"
    ),
    ensureLog:
      env.AUTODEV_OTEL_LOG?.trim() ||
      path.join(
        env.AUTODEV_OTEL_RUN_DIR?.trim() || path.join(codexHome, "run"),
        "autodev-otel-collector.ensure.log"
      ),
    startTimeoutSeconds: positiveInteger(env.AUTODEV_OTEL_START_TIMEOUT, 10)
  };
}

function httpStatus(options: CollectorOptions): string {
  try {
    return execFileSync(
      "curl",
      [
        "--silent",
        "--output",
        "/dev/null",
        "--write-out",
        "%{http_code}",
        "--max-time",
        "1",
        `http://${options.host}:${options.port}/`
      ],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }
    ).trim();
  } catch {
    return "000";
  }
}

function ready(options: CollectorOptions): boolean {
  return /^[1-5][0-9][0-9]$/u.test(httpStatus(options));
}

function tcpBusy(options: CollectorOptions): boolean {
  try {
    execFileSync("nc", ["-z", options.host, String(options.port)], {
      stdio: "ignore",
      timeout: 1000
    });
    return true;
  } catch {
    return false;
  }
}

function fail(message: string): never {
  throw new Error(message);
}

function expectedVersion(options: CollectorOptions): string {
  if (!existsSync(options.versionFile))
    fail(`collector version file is missing: ${options.versionFile}`);
  const version = readFileSync(options.versionFile, "utf8").trim();
  if (!DEFAULT_VERSION.test(version))
    fail(`collector.version is not a well-formed pinned version: '${version}'`);
  return version;
}

function resolveBinary(options: CollectorOptions): string {
  if (options.binary) {
    if (existsSync(options.binary)) {
      try {
        accessSync(options.binary, fsConstants.X_OK);
        return options.binary;
      } catch {
        /* report below */
      }
    }
    fail(`AUTODEV_OTELCOL_BIN is not executable: ${options.binary}`);
  }
  for (const candidate of [
    path.join(options.codexHome, "otelcol"),
    path.join(options.codexHome, "otelcol", "otelcol"),
    path.join(options.codexHome, "bin", "otelcol")
  ]) {
    try {
      accessSync(candidate, fsConstants.X_OK);
      return candidate;
    } catch {
      /* try next candidate */
    }
  }
  try {
    return execFileSync("which", ["otelcol"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    }).trim();
  } catch {
    return fail(
      "could not locate an executable otelcol; set AUTODEV_OTELCOL_BIN or install one under CODEX_HOME"
    );
  }
}

function validateBinary(
  options: CollectorOptions,
  binary: string,
  version: string
): void {
  const versionOutput = spawnSync(binary, ["--version"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  });
  if (versionOutput.status !== 0) fail("collector --version failed");
  const match =
    `${versionOutput.stdout ?? ""}${versionOutput.stderr ?? ""}`
      .replaceAll("\r", "")
      .match(/v?[0-9]+\.[0-9]+\.[0-9]+(?:-[A-Za-z0-9.-]+)?/u)?.[0] ?? "";
  const actual = match.startsWith("v") ? match : `v${match}`;
  if (actual !== version)
    fail(`collector version mismatch: expected ${version}`);
  if (
    spawnSync(binary, ["validate", "--config", options.configFile], {
      stdio: "ignore"
    }).status !== 0
  )
    fail(`collector fixture failed validation: ${options.configFile}`);
}

export function runCollector(
  options: CollectorOptions = resolveCollectorOptions(),
  checkOnly = false
): number {
  if (!existsSync(options.configFile))
    fail(`collector config is missing: ${options.configFile}`);
  const version = expectedVersion(options);
  const binary = resolveBinary(options);
  if (!checkOnly && ready(options))
    fail(
      `port ${options.host}:${options.port} already serving HTTP; refusing to start a duplicate Collector`
    );
  if (!checkOnly && tcpBusy(options))
    fail(
      `port ${options.host}:${options.port} is already in use by another process`
    );
  validateBinary(options, binary, version);
  if (checkOnly) {
    writeLine(
      `ok Collector ${version} (${binary}) validates ${options.configFile}`
    );
    return 0;
  }
  const result = spawnSync(binary, ["--config", options.configFile], {
    stdio: "inherit"
  });
  return result.status ?? 1;
}

function runCommand(options: CollectorOptions): {
  command: string;
  args: string[];
} {
  return options.runner.endsWith(".ts")
    ? { command: process.execPath, args: [options.runner, "run"] }
    : { command: "/bin/bash", args: [options.runner] };
}

export async function ensureCollector(
  options: CollectorOptions = resolveCollectorOptions()
): Promise<number> {
  if (ready(options)) return 0;
  if (tcpBusy(options))
    fail(
      `port ${options.host}:${options.port} is in use by a non-HTTP process`
    );
  if (options.runner.endsWith(".ts")) {
    if (!existsSync(options.runner))
      fail(`collector runner is missing: ${options.runner}`);
  } else {
    try {
      accessSync(options.runner, fsConstants.X_OK);
    } catch {
      fail(`collector runner is missing or not executable: ${options.runner}`);
    }
  }
  mkdirSync(options.runDir, { recursive: true, mode: 0o700 });
  chmodSync(options.runDir, 0o700);
  try {
    rmSync(options.pidFile, { force: true });
  } catch {
    /* already absent */
  }
  const fd = openSync(options.ensureLog, "a", 0o600);
  const command = runCommand(options);
  const child = spawn(command.command, command.args, {
    detached: true,
    stdio: ["ignore", fd, fd],
    env: process.env
  });
  child.unref();
  writeFileSync(options.pidFile, `${child.pid ?? ""}\n`, { mode: 0o600 });
  try {
    const deadline = Date.now() + options.startTimeoutSeconds * 1000;
    while (Date.now() < deadline) {
      if (ready(options)) return 0;
      if (child.exitCode !== null)
        fail("collector exited before becoming ready");
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    try {
      child.kill();
    } catch {
      /* already exited */
    }
    return fail(
      `collector did not become ready within ${options.startTimeoutSeconds}s`
    );
  } finally {
    try {
      rmSync(options.pidFile, { force: true });
    } catch {
      /* best effort */
    }
  }
}

function cli(argv: string[]): number | Promise<number> {
  if (argv[0] === "run")
    return runCollector(resolveCollectorOptions(), argv[1] === "--check");
  if (argv[0] === "ensure") return ensureCollector().then((status) => status);
  throw new Error("usage: otel-collector run [--check]|ensure");
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  try {
    const result = cli(process.argv.slice(2));
    if (result instanceof Promise)
      result.then((status) => {
        process.exitCode = status;
      });
    else process.exitCode = result;
  } catch (error) {
    writeErrorLine(
      `otel-collector: ${error instanceof Error ? error.message : String(error)}`
    );
    process.exitCode = 1;
  }
}
