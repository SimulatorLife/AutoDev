import { execFileSync, spawn } from "node:child_process";
import { existsSync, openSync, rmdirSync, rmSync } from "node:fs";
import {
  chmod as chmodP,
  lstat as lstatP,
  mkdir as mkdirP,
  readFile as readFileP,
  rename as renameP,
  rm as rmP,
  stat as statP,
  writeFile as writeFileP
} from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

import { isEntryPoint } from "@simulatorlife/autodev-runtime/shared/entry-point";
import { parseNonNegativeInteger } from "@simulatorlife/autodev-runtime/shared/env";
import { writeErrorLine } from "@simulatorlife/autodev-runtime/shared/output";

import { httpHealthProbe } from "./health-probe.ts";
import { LaunchdClient } from "./macos/launchd.ts";
import { ensureOpencliProxy } from "./opencli-ensure.ts";
import { sleep } from "./sleep.ts";

export interface RouterEnsurePaths {
  readonly codexHome: string;
  readonly runDir: string;
  readonly launchdRunDir: string;
  readonly ensureLock: string;
  readonly lockDir: string;
  readonly fallbackLog: string;
  readonly fallbackPidFile: string;
  readonly launcher: string;
  readonly plistLink: string;
  readonly launchdLogOut: string;
  readonly launchdLogErr: string;
}

export interface RouterEnsureOptions {
  readonly paths: RouterEnsurePaths;
  readonly label: string;
  readonly domain: string;
  readonly routerHost: string;
  readonly routerPort: number;
  readonly readyTimeoutMs: number;
  readonly fallbackLogMaxBytes: number;
  readonly initialBackoffMs: number;
  readonly maxBackoffMs: number;
  readonly myPid: number;
}

export type PidSignal = "SIGTERM" | "SIGKILL";

export interface StartedLauncher {
  readonly pid: number;
}

export interface RouterEnsureDeps {
  readonly launchd: LaunchdClient;
  readonly probe: () => Promise<boolean>;
  readonly pidExists: (pid: number) => boolean;
  readonly pidCommandLine: (pid: number) => string | null;
  readonly listenerPid: (port: number) => number | null;
  readonly startLauncher: (
    command: string,
    arguments_: string[],
    logPath: string
  ) => StartedLauncher;
  readonly signalPid: (pid: number, signal: PidSignal) => boolean;
  readonly sleep: (ms: number) => Promise<void>;
  readonly now: () => number;
  readonly mkdir: (
    filePath: string,
    options?: { recursive?: boolean }
  ) => Promise<void>;
  readonly chmod: (filePath: string, mode: number) => Promise<void>;
  readonly lstat: (
    filePath: string
  ) => Promise<{ isSymbolicLink(): boolean } | null>;
  readonly writeFile: (filePath: string, data: string) => Promise<void>;
  readonly readFile: (filePath: string) => Promise<string>;
  readonly unlink: (filePath: string) => Promise<void>;
  readonly rename: (from: string, to: string) => Promise<void>;
  readonly stat: (filePath: string) => Promise<{ size: number } | null>;
  readonly setExitHandler: (handler: () => void) => () => void;
  /**
  The optional provider bridges (Copilot, opencli) the router ensure hook
  starts once the router itself is healthy. Each is best effort: an optional
  provider that is missing or fails to start never changes the router's
  result.
  */
  readonly ensureOptionalBridges?: readonly (() => Promise<boolean>)[];
}

export type RouterEnsureStatus =
  | "healthy-launchd"
  | "healthy-fallback"
  | "launchd-failed"
  | "fallback-failed"
  | "duplicate-detected"
  | "lock-contended";

export interface RouterEnsureResult {
  readonly status: RouterEnsureStatus;
  readonly exitCode: 0 | 1;
  readonly message?: string;
  readonly logTail?: readonly string[];
}

const DEFAULT_LAUNCHD_LABEL = "com.codex.model-router";
const FALLBACK_LOG_MAX_BYTES = 10 * 1024 * 1024;
const READY_TIMEOUT_MS_DEFAULT = 5000;
const INITIAL_BACKOFF_MS_DEFAULT = 50;
const MAX_BACKOFF_MS_DEFAULT = 1000;
const PID_PATTERN = /^\d+$/u;
const LAUNCHD_PID_LINE_PATTERN = /^\s*pid\s*=\s*(\d+)\s*$/u;
const LOG_LINE_SPLIT_PATTERN = /\r?\n/u;
const PROCESS_EXIT_ATTEMPTS = 50;
const PROCESS_EXIT_DELAY_MS = 100;

function resolveRouterEnsureOptionsFromEnvironment(
  environment: NodeJS.ProcessEnv,
  myPid: number
): RouterEnsureOptions {
  const codexHome = environment.CODEX_HOME?.trim() || path.join(homedir(), ".codex");
  const runDir =
    environment.CODEX_MODEL_ROUTER_RUN_DIR?.trim() || path.join(codexHome, "run");
  const launchdRunDir = path.join(codexHome, "run");
  const ensureLock =
    environment.CODEX_MODEL_ROUTER_ENSURE_LOCK?.trim() ||
    path.join(runDir, "codex-model-router.ensure.lock");
  const fallbackLog =
    environment.CODEX_MODEL_ROUTER_FALLBACK_LOG?.trim() ||
    path.join(runDir, "codex-model-router.fallback.log");
  const fallbackPidFile =
    environment.CODEX_MODEL_ROUTER_FALLBACK_PID_FILE?.trim() ||
    path.join(runDir, "codex-model-router.fallback.pid");
  const label = DEFAULT_LAUNCHD_LABEL;
  const plistLink = path.join(
    homedir(),
    "Library",
    "LaunchAgents",
    `${label}.plist`
  );
  const uid = typeof process.getuid === "function" ? process.getuid() : 0;
  const domain = `gui/${uid}`;
  return {
    paths: {
      codexHome,
      runDir,
      launchdRunDir,
      ensureLock,
      lockDir: `${ensureLock}.d`,
      fallbackLog,
      fallbackPidFile,
      launcher: path.join(codexHome, "hooks", "run-autodev-model-router.sh"),
      plistLink,
      launchdLogOut: path.join(
        launchdRunDir,
        "codex-model-router.launchd.out.log"
      ),
      launchdLogErr: path.join(
        launchdRunDir,
        "codex-model-router.launchd.err.log"
      )
    },
    label,
    domain,
    routerHost: environment.CODEX_MODEL_ROUTER_HOST?.trim() || "127.0.0.1",
    routerPort: parseNonNegativeInteger(environment.CODEX_MODEL_ROUTER_PORT, 4100),
    readyTimeoutMs: parseNonNegativeInteger(
      environment.CODEX_MODEL_ROUTER_READY_TIMEOUT_MS,
      READY_TIMEOUT_MS_DEFAULT
    ),
    fallbackLogMaxBytes: FALLBACK_LOG_MAX_BYTES,
    initialBackoffMs: INITIAL_BACKOFF_MS_DEFAULT,
    maxBackoffMs: MAX_BACKOFF_MS_DEFAULT,
    myPid
  };
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readPsCommandLine(pid: number): string | null {
  try {
    const stdout = execFileSync("ps", ["-p", String(pid), "-o", "command="], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    });
    return stdout.trim();
  } catch {
    return null;
  }
}

function readListenerPid(port: number): number | null {
  try {
    const stdout = execFileSync(
      "lsof",
      ["-nP", "-a", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }
    );
    const newlineIndex = stdout.indexOf("\n");
    const first = (
      newlineIndex === -1 ? stdout : stdout.slice(0, newlineIndex)
    ).trim();
    return PID_PATTERN.test(first) ? Number.parseInt(first) : null;
  } catch {
    return null;
  }
}

function defaultStartLauncher(
  command: string,
  arguments_: readonly string[],
  logPath: string
): StartedLauncher {
  const fd = openSync(logPath, "a");
  const child = spawn(command, [...arguments_], {
    detached: true,
    stdio: ["ignore", fd, fd]
  });
  child.unref();
  return { pid: child.pid ?? -1 };
}

function defaultSetExitHandler(handler: () => void): () => void {
  process.on("exit", handler);
  return () => process.removeListener("exit", handler);
}

export function createDefaultRouterEnsureDeps(
  options: RouterEnsureOptions
): RouterEnsureDeps {
  const probeUrl = `http://${options.routerHost}:${options.routerPort}/health/liveliness`;
  return {
    launchd: new LaunchdClient(),
    probe: httpHealthProbe(probeUrl),
    pidExists: pidAlive,
    pidCommandLine: readPsCommandLine,
    listenerPid: readListenerPid,
    startLauncher: defaultStartLauncher,
    signalPid: (pid, signal) => {
      try {
        process.kill(pid, signal);
        return true;
      } catch {
        return false;
      }
    },
    sleep,
    now: () => Date.now(),
    mkdir: async (filePath, options_) => {
      await mkdirP(filePath, options_);
    },
    chmod: (filePath, mode) => chmodP(filePath, mode),
    lstat: async (filePath) => {
      try {
        return await lstatP(filePath);
      } catch {
        return null;
      }
    },
    writeFile: (filePath, data) =>
      writeFileP(filePath, data, { encoding: "utf8" }),
    readFile: async (filePath) => {
      try {
        return await readFileP(filePath, { encoding: "utf8" });
      } catch {
        return "";
      }
    },
    unlink: async (filePath) => {
      try {
        await rmP(filePath, { recursive: true, force: true });
      } catch {
        /*
        ignore
        */
      }
    },
    rename: async (from, to) => {
      try {
        await renameP(from, to);
      } catch {
        /*
        ignore
        */
      }
    },
    stat: async (filePath) => {
      try {
        const s = await statP(filePath);
        return { size: s.size };
      } catch {
        return null;
      }
    },
    setExitHandler: defaultSetExitHandler,
    ensureOptionalBridges: [ensureOpencliProxy]
  };
}

export { resolveRouterEnsureOptionsFromEnvironment as resolveRouterEnsureOptions };

function parseLaunchdPid(output: string): number | null {
  for (const line of output.split("\n")) {
    const match = LAUNCHD_PID_LINE_PATTERN.exec(line);
    if (match && match[1] !== undefined) return Number.parseInt(match[1]);
  }
  return null;
}

async function pollRouterReadyWithBackoff(
  dependencies: RouterEnsureDeps,
  options: RouterEnsureOptions,
  deadline: number,
  backoff: number
): Promise<boolean> {
  if (await dependencies.probe()) return true;
  if (dependencies.now() >= deadline) return false;
  await dependencies.sleep(backoff);
  const nextBackoff = Math.min(backoff * 2, options.maxBackoffMs);
  return pollRouterReadyWithBackoff(dependencies, options, deadline, nextBackoff);
}

function waitForProbe(
  dependencies: RouterEnsureDeps,
  options: RouterEnsureOptions
): Promise<boolean> {
  const deadline = dependencies.now() + options.readyTimeoutMs;
  return pollRouterReadyWithBackoff(
    dependencies,
    options,
    deadline,
    options.initialBackoffMs
  );
}

/**
Bounded wait for a signalled process to exit. The wait must terminate so the
caller can escalate to SIGKILL when the process ignores SIGTERM.
*/
async function waitForProcessExit(
  dependencies: RouterEnsureDeps,
  pid: number,
  attempts = PROCESS_EXIT_ATTEMPTS
): Promise<boolean> {
  if (!dependencies.pidExists(pid)) return true;
  if (attempts <= 0) return false;
  await dependencies.sleep(PROCESS_EXIT_DELAY_MS);
  return waitForProcessExit(dependencies, pid, attempts - 1);
}

async function secureLogFile(
  dependencies: RouterEnsureDeps,
  filePath: string
): Promise<void> {
  const stat = await dependencies.lstat(filePath);
  if (stat && stat.isSymbolicLink()) {
    throw new Error(`refusing to use symlinked log path: ${filePath}`);
  }
  if (!stat) await dependencies.writeFile(filePath, "");
  await dependencies.chmod(filePath, 0o600);
}

async function acquireLock(
  dependencies: RouterEnsureDeps,
  options: RouterEnsureOptions
): Promise<boolean> {
  const { paths } = options;
  await dependencies.mkdir(paths.runDir, { recursive: true });
  await dependencies.chmod(paths.runDir, 0o700);
  await dependencies.mkdir(paths.launchdRunDir, { recursive: true });
  await dependencies.chmod(paths.launchdRunDir, 0o700);
  await dependencies.mkdir(path.dirname(paths.ensureLock), { recursive: true });
  await Promise.all(
    [paths.launchdLogOut, paths.launchdLogErr].map(async (logPath) => {
      await rotateLog(dependencies, logPath, options.fallbackLogMaxBytes);
      await secureLogFile(dependencies, logPath);
    })
  );

  if (await tryMakeLockDir(dependencies, paths.lockDir, options.myPid)) return true;

  const ownerRaw = await dependencies.readFile(path.join(paths.lockDir, "pid"));
  const owner = PID_PATTERN.test(ownerRaw.trim())
    ? Number.parseInt(ownerRaw.trim())
    : NaN;
  if (Number.isFinite(owner) && !dependencies.pidExists(owner)) {
    const stale = `${paths.lockDir}.stale.${options.myPid}`;
    try {
      // Rename is the compare-and-swap that claims a stale lock directory; write-file-atomic cannot move one.
      await dependencies.rename(paths.lockDir, stale);
      await dependencies.unlink(path.join(stale, "pid"));
      await dependencies.unlink(stale);
    } catch {
      /*
      ignore
      */
    }
    if (await tryMakeLockDir(dependencies, paths.lockDir, options.myPid)) return true;
  }

  return false;
}

async function tryMakeLockDir(
  dependencies: RouterEnsureDeps,
  lockDir: string,
  pid: number
): Promise<boolean> {
  try {
    await dependencies.mkdir(lockDir);
  } catch {
    return false;
  }
  await dependencies.chmod(lockDir, 0o700);
  await dependencies.writeFile(path.join(lockDir, "pid"), `${pid}\n`);
  await dependencies.chmod(path.join(lockDir, "pid"), 0o600);
  return true;
}

function launchdOwnsListener(
  dependencies: RouterEnsureDeps,
  options: RouterEnsureOptions,
  launchdPid: number | null
): boolean {
  if (launchdPid === null) return false;
  const listener = dependencies.listenerPid(options.routerPort);
  return listener !== null && listener === launchdPid;
}

function fallbackPidOwned(dependencies: RouterEnsureDeps, pid: number): boolean {
  const command = dependencies.pidCommandLine(pid);
  if (command === null) return false;
  return (
    command.includes("run-autodev-model-router.sh") ||
    command.includes("run-codex-model-router.sh") ||
    command.includes("codex-model-router.mjs")
  );
}

/**
Keep a router log bounded so a crash loop cannot fill the disk.
*/
async function rotateLog(
  dependencies: RouterEnsureDeps,
  filePath: string,
  maxBytes: number
): Promise<void> {
  const stat = await dependencies.stat(filePath);
  if (!stat || stat.size <= maxBytes) return;
  try {
    // Log rotation moves an existing file; there are no new bytes to write atomically.
    await dependencies.rename(filePath, `${filePath}.1`);
  } catch {
    /*
    ignore
    */
  }
}

function safeLaunchctlAvailable(): boolean {
  return existsSync("/bin/launchctl") || existsSync("/usr/bin/launchctl");
}

function safeLaunchctlPrint(
  dependencies: RouterEnsureDeps,
  options: RouterEnsureOptions
): string | null {
  try {
    return dependencies.launchd.print(options.label);
  } catch {
    return null;
  }
}

async function ensureViaLaunchd(
  dependencies: RouterEnsureDeps,
  options: RouterEnsureOptions
): Promise<0 | 1 | 2> {
  if (!safeLaunchctlAvailable()) return 2;

  if (dependencies.launchd.isLoaded(options.label)) {
    if (await dependencies.probe()) {
      const ownerPid = parseLaunchdPid(safeLaunchctlPrint(dependencies, options) ?? "");
      if (launchdOwnsListener(dependencies, options, ownerPid)) return 0;
      return 1;
    }
    try {
      dependencies.launchd.kickstart(options.label);
    } catch {
      return 1;
    }
    const started = await waitForProbe(dependencies, options);
    const ownerPid = parseLaunchdPid(safeLaunchctlPrint(dependencies, options) ?? "");
    if (started && launchdOwnsListener(dependencies, options, ownerPid)) return 0;
    return 1;
  }

  if (await dependencies.probe()) return 2;

  const isPlistExists = (await dependencies.stat(options.paths.plistLink)) !== null;
  if (!isPlistExists) return 2;
  // RunAtLoad starts the router on bootstrap; kickstart -k here would kill that
  // instance mid-startup and wait out ThrottleInterval before respawning it.
  try {
    dependencies.launchd.bootstrap(options.paths.plistLink);
  } catch {
    return 2;
  }
  const started = await waitForProbe(dependencies, options);
  const ownerPid = parseLaunchdPid(safeLaunchctlPrint(dependencies, options) ?? "");
  if (started && launchdOwnsListener(dependencies, options, ownerPid)) return 0;
  return 1;
}

async function ensureViaFallback(
  dependencies: RouterEnsureDeps,
  options: RouterEnsureOptions
): Promise<0 | 2 | 3> {
  await dependencies.mkdir(options.paths.runDir, { recursive: true });
  await dependencies.chmod(options.paths.runDir, 0o700);

  const launcherStat = await dependencies.stat(options.paths.launcher);
  if (launcherStat === null) {
    return 2;
  }

  const existingPidRaw = await dependencies.readFile(options.paths.fallbackPidFile);
  const existingPid = PID_PATTERN.test(existingPidRaw.trim())
    ? Number.parseInt(existingPidRaw.trim())
    : NaN;

  if (Number.isFinite(existingPid) && dependencies.pidExists(existingPid)) {
    if (fallbackPidOwned(dependencies, existingPid)) {
      if (await dependencies.probe()) return 0;
      dependencies.signalPid(existingPid, "SIGTERM");
      await waitForProcessExit(dependencies, existingPid);
      if (dependencies.pidExists(existingPid)) dependencies.signalPid(existingPid, "SIGKILL");
    }
    await dependencies.unlink(options.paths.fallbackPidFile);
  } else if (Number.isFinite(existingPid)) {
    await dependencies.unlink(options.paths.fallbackPidFile);
  }

  if (await dependencies.probe()) return 3;

  await rotateLog(dependencies, options.paths.fallbackLog, options.fallbackLogMaxBytes);
  await dependencies.writeFile(options.paths.fallbackLog, "");
  await dependencies.chmod(options.paths.fallbackLog, 0o600);

  const started = dependencies.startLauncher(
    "/bin/bash",
    [options.paths.launcher],
    options.paths.fallbackLog
  );
  await dependencies.writeFile(options.paths.fallbackPidFile, `${started.pid}\n`);
  await dependencies.chmod(options.paths.fallbackPidFile, 0o600);

  if (await waitForProbe(dependencies, options)) return 0;

  if (dependencies.pidExists(started.pid) && fallbackPidOwned(dependencies, started.pid)) {
    dependencies.signalPid(started.pid, "SIGKILL");
  }
  await dependencies.unlink(options.paths.fallbackPidFile);
  return 2;
}

async function readLogTail(
  dependencies: RouterEnsureDeps,
  logPath: string,
  lineCount = 40
): Promise<string[]> {
  const raw = await dependencies.readFile(logPath);
  if (!raw) return [];
  const lines = raw.split(LOG_LINE_SPLIT_PATTERN);
  return lines
    .slice(Math.max(0, lines.length - 1 - lineCount), -1)
    .filter((line) => line.length > 0);
}

function lockDirCleanup(lockDir: string, owned: boolean): void {
  if (!owned) return;
  try {
    rmSync(path.join(lockDir, "pid"), { force: true });
  } catch {
    /*
    ignore
    */
  }
  try {
    rmdirSync(lockDir);
  } catch {
    /*
    ignore
    */
  }
}

async function bestEffortOptionalBridges(
  dependencies: RouterEnsureDeps
): Promise<void> {
  await Promise.all(
    (dependencies.ensureOptionalBridges ?? []).map(async (ensure) => {
      try {
        await ensure();
      } catch {
        /*
        Optional bridges are fallbacks; the router serves without them.
        */
      }
    })
  );
}

export async function runRouterEnsure(
  dependencies: RouterEnsureDeps,
  options: RouterEnsureOptions
): Promise<RouterEnsureResult> {
  let isLockOwned = false;
  const removeExit = dependencies.setExitHandler(() =>
    lockDirCleanup(options.paths.lockDir, isLockOwned)
  );
  try {
    if (!(await acquireLock(dependencies, options))) {
      return {
        status: "lock-contended",
        exitCode: 1,
        message: `another ensure invocation is in progress (lock held at ${options.paths.lockDir}).`
      };
    }
    isLockOwned = true;

    const launchdResult = await ensureViaLaunchd(dependencies, options);
    if (launchdResult === 0) {
      await bestEffortOptionalBridges(dependencies);
      return { status: "healthy-launchd", exitCode: 0 };
    }
    if (launchdResult === 1) {
      return {
        status: "launchd-failed",
        exitCode: 1,
        message: `Codex model router failed to start under launchd. LaunchAgent: ${options.paths.plistLink}; log: ${options.paths.launchdLogErr}`,
        logTail: await readLogTail(dependencies, options.paths.launchdLogErr)
      };
    }

    const fallbackResult = await ensureViaFallback(dependencies, options);
    if (fallbackResult === 0) {
      await bestEffortOptionalBridges(dependencies);
      return { status: "healthy-fallback", exitCode: 0 };
    }
    if (fallbackResult === 3) {
      return {
        status: "duplicate-detected",
        exitCode: 1,
        message: `Codex model router: http://${options.routerHost}:${options.routerPort} is already serving traffic from an untracked process; refusing to start a duplicate.`
      };
    }
    const logTail = await readLogTail(dependencies, options.paths.fallbackLog);
    const message = `Codex model router fallback failed to start. Log: ${options.paths.fallbackLog}`;
    return { status: "fallback-failed", exitCode: 1, message, logTail };
  } finally {
    lockDirCleanup(options.paths.lockDir, isLockOwned);
    isLockOwned = false;
    removeExit();
  }
}

export const __testing = {
  parseLaunchdPid,
  waitForProbe,
  acquireLock,
  ensureViaLaunchd,
  ensureViaFallback,
  safeLaunchctlAvailable,
  safeLaunchctlPrint,
  fallbackPidOwned,
  launchdOwnsListener,
  lockDirCleanup,
  secureLogFile,
  resolveRouterEnsureOptionsFromEnv: resolveRouterEnsureOptionsFromEnvironment
};

if (isEntryPoint(import.meta.url)) {
  const options = resolveRouterEnsureOptionsFromEnvironment(process.env, process.pid);
  runRouterEnsure(createDefaultRouterEnsureDeps(options), options)
    .then((result) => {
      if (result.message && result.exitCode !== 0)
        process.stderr.write(`${result.message}\n`);
      for (const line of result.logTail ?? [])
        process.stderr.write(`${line}\n`);
      process.exitCode = result.exitCode;
      return result.exitCode;
    })
    .catch((error) => {
      writeErrorLine(
        `router-ensure: ${error instanceof Error ? error.message : String(error)}`
      );
      process.exitCode = 1;
      return 1;
    });
}
