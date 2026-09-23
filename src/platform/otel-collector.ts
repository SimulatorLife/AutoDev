import {
  type ChildProcess,
  execFileSync,
  spawn,
  spawnSync
} from "node:child_process";
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

const HTTP_STATUS_PATTERN = /^[1-5][0-9][0-9]$/u;
const COLLECTOR_VERSION_OUTPUT_PATTERN = /v?\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+|)/u;

const DIGIT_ONLY_PATTERN = /^\d+$/u;
const PRERELEASE_PATTERN = /^[A-Za-z0-9.-]+$/u;

function isValidPinnedVersion(value: string): boolean {
  if (!value.startsWith("v")) return false;
  const tail = value.slice(1);
  const dashIndex = tail.indexOf("-");
  const core = dashIndex === -1 ? tail : tail.slice(0, dashIndex);
  const dotParts = core.split(".");
  if (dotParts.length !== 3) return false;
  if (!dotParts.every((part) => DIGIT_ONLY_PATTERN.test(part))) return false;
  if (dashIndex === -1) return true;
  const prerelease = tail.slice(dashIndex + 1);
  return prerelease.length > 0 && PRERELEASE_PATTERN.test(prerelease);
}

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? "");
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function repoRoot(env: NodeJS.ProcessEnv): string {
  return (
    env.AUTODEV_OTEL_REPO_ROOT?.trim() ||
    path.join(import.meta.dirname, "..", "..")
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
  return HTTP_STATUS_PATTERN.test(httpStatus(options));
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
  if (!isValidPinnedVersion(version))
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

function checkVersion(binary: string, version: string): void {
  const versionOutput = spawnSync(binary, ["--version"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  });
  if (versionOutput.status !== 0) fail("collector --version failed");
  const raw =
    `${versionOutput.stdout ?? ""}${versionOutput.stderr ?? ""}`.replaceAll(
      "\r",
      ""
    );
  const versionMatch = COLLECTOR_VERSION_OUTPUT_PATTERN.exec(raw);
  const match = versionMatch?.[0] ?? "";
  const actual = match.startsWith("v") ? match : `v${match}`;
  if (actual !== version)
    fail(`collector version mismatch: expected ${version}`);
}

function validateConfig(options: CollectorOptions, binary: string): void {
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
  checkVersion(binary, version);
  if (checkOnly) {
    validateConfig(options, binary);
    writeLine(
      `ok Collector ${version} (${binary}) validates ${options.configFile}`
    );
    return 0;
  }
  // `otelcol --config` rejects an invalid config itself, so a separate
  // `validate` launch here only adds another start of this large binary.
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

async function pollCollectorReady(
  options: CollectorOptions,
  child: ChildProcess,
  deadline: number
): Promise<boolean> {
  if (Date.now() >= deadline) return false;
  if (ready(options)) return true;
  if (child.exitCode !== null) fail("collector exited before becoming ready");
  await new Promise((resolve) => {
    setTimeout(resolve, 100);
  });
  return pollCollectorReady(options, child, deadline);
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
    const readyBeforeDeadline = await pollCollectorReady(
      options,
      child,
      deadline
    );
    if (!readyBeforeDeadline) {
      try {
        child.kill();
      } catch {
        /* already exited */
      }
      return fail(
        `collector did not become ready within ${options.startTimeoutSeconds}s`
      );
    }
    return 0;
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
      result
        .then((status) => {
          process.exitCode = status;
          return status;
        })
        .catch((error) => {
          writeErrorLine(
            `otel-collector: ${error instanceof Error ? error.message : String(error)}`
          );
          process.exitCode = 1;
          return 1;
        });
    else process.exitCode = result;
  } catch (error) {
    writeErrorLine(
      `otel-collector: ${error instanceof Error ? error.message : String(error)}`
    );
    process.exitCode = 1;
  }
}
