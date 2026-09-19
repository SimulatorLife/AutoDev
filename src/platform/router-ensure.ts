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

import { ensureCopilotProxy } from "./copilot-ensure.ts";
import { LaunchdClient } from "./macos/launchd.ts";

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
    args: string[],
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
  /** Best-effort legacy side effect retained by the router ensure hook. */
  readonly ensureCopilot?: () => Promise<boolean>;
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

function positiveInteger(value: string | undefined, fallback: number): number {
  if (value === undefined || value === "") return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function resolveRouterEnsureOptionsFromEnv(
  env: NodeJS.ProcessEnv,
  myPid: number
): RouterEnsureOptions {
  const codexHome = env.CODEX_HOME?.trim() || path.join(homedir(), ".codex");
  const runDir =
    env.CODEX_MODEL_ROUTER_RUN_DIR?.trim() || path.join(codexHome, "run");
  const launchdRunDir = path.join(codexHome, "run");
  const ensureLock =
    env.CODEX_MODEL_ROUTER_ENSURE_LOCK?.trim() ||
    path.join(runDir, "codex-model-router.ensure.lock");
  const fallbackLog =
    env.CODEX_MODEL_ROUTER_FALLBACK_LOG?.trim() ||
    path.join(runDir, "codex-model-router.fallback.log");
  const fallbackPidFile =
    env.CODEX_MODEL_ROUTER_FALLBACK_PID_FILE?.trim() ||
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
      launcher: path.join(codexHome, "hooks", "run-codex-model-router.sh"),
      plistLink,
      launchdLogOut: path.join(launchdRunDir, "codex-model-router.launchd.out.log"),
      launchdLogErr: path.join(launchdRunDir, "codex-model-router.launchd.err.log")
    },
    label,
    domain,
    routerHost: env.CODEX_MODEL_ROUTER_HOST?.trim() || "127.0.0.1",
    routerPort: positiveInteger(env.CODEX_MODEL_ROUTER_PORT, 4100),
    readyTimeoutMs: positiveInteger(
      env.CODEX_MODEL_ROUTER_READY_TIMEOUT_MS,
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
    const first = stdout.split("\n", 1)[0]?.trim() ?? "";
    return /^[0-9]+$/.test(first) ? Number.parseInt(first, 10) : null;
  } catch {
    return null;
  }
}

function defaultStartLauncher(
  command: string,
  args: readonly string[],
  logPath: string
): StartedLauncher {
  const fd = openSync(logPath, "a");
  const child = spawn(command, [...args], {
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
    probe: async () => {
      try {
        const res = await fetch(probeUrl, {
          signal: AbortSignal.timeout(1000)
        });
        return res.ok;
      } catch {
        return false;
      }
    },
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
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now: () => Date.now(),
    mkdir: async (filePath, opts) => {
      await mkdirP(filePath, opts);
    },
    chmod: (filePath, mode) => chmodP(filePath, mode),
    lstat: async (filePath) => {
      try {
        return await lstatP(filePath);
      } catch {
        return null;
      }
    },
    writeFile: (filePath, data) => writeFileP(filePath, data, { encoding: "utf8" }),
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
        /* ignore */
      }
    },
    rename: async (from, to) => {
      try {
        await renameP(from, to);
      } catch {
        /* ignore */
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
    ensureCopilot: () => ensureCopilotProxy()
  };
}

export { resolveRouterEnsureOptionsFromEnv as resolveRouterEnsureOptions };

function parseLaunchdPid(output: string): number | null {
  for (const line of output.split("\n")) {
    const match = /^\s*pid\s*=\s*([0-9]+)\s*$/.exec(line);
    if (match && match[1] !== undefined) return Number.parseInt(match[1], 10);
  }
  return null;
}

async function waitForProbe(
  deps: RouterEnsureDeps,
  options: RouterEnsureOptions
): Promise<boolean> {
  const startMs = deps.now();
  const deadline = startMs + options.readyTimeoutMs;
  let backoff = options.initialBackoffMs;
  while (true) {
    if (await deps.probe()) return true;
    if (deps.now() >= deadline) return false;
    await deps.sleep(backoff);
    backoff = Math.min(backoff * 2, options.maxBackoffMs);
  }
}

async function secureLogFile(
  deps: RouterEnsureDeps,
  filePath: string
): Promise<void> {
  const stat = await deps.lstat(filePath);
  if (stat && stat.isSymbolicLink()) {
    throw new Error(`refusing to use symlinked log path: ${filePath}`);
  }
  if (!stat) await deps.writeFile(filePath, "");
  await deps.chmod(filePath, 0o600);
}

async function acquireLock(
  deps: RouterEnsureDeps,
  options: RouterEnsureOptions
): Promise<boolean> {
  const { paths } = options;
  await deps.mkdir(paths.runDir, { recursive: true });
  await deps.chmod(paths.runDir, 0o700);
  await deps.mkdir(paths.launchdRunDir, { recursive: true });
  await deps.chmod(paths.launchdRunDir, 0o700);
  await deps.mkdir(path.dirname(paths.ensureLock), { recursive: true });
  await secureLogFile(deps, paths.launchdLogOut);
  await secureLogFile(deps, paths.launchdLogErr);

  if (await tryMakeLockDir(deps, paths.lockDir, options.myPid)) return true;

  const ownerRaw = await deps.readFile(path.join(paths.lockDir, "pid"));
  const owner = /^[0-9]+$/.test(ownerRaw.trim())
    ? Number.parseInt(ownerRaw.trim(), 10)
    : Number.NaN;
  if (Number.isFinite(owner) && !deps.pidExists(owner)) {
    const stale = `${paths.lockDir}.stale.${options.myPid}`;
    try {
      await deps.rename(paths.lockDir, stale);
      await deps.unlink(path.join(stale, "pid"));
      await deps.unlink(stale);
    } catch {
      /* ignore */
    }
    if (await tryMakeLockDir(deps, paths.lockDir, options.myPid)) return true;
  }

  return false;
}

async function tryMakeLockDir(
  deps: RouterEnsureDeps,
  lockDir: string,
  pid: number
): Promise<boolean> {
  try {
    await deps.mkdir(lockDir);
  } catch {
    return false;
  }
  await deps.chmod(lockDir, 0o700);
  await deps.writeFile(path.join(lockDir, "pid"), `${pid}\n`);
  await deps.chmod(path.join(lockDir, "pid"), 0o600);
  return true;
}

function launchdOwnsListener(
  deps: RouterEnsureDeps,
  options: RouterEnsureOptions,
  launchdPid: number | null
): boolean {
  if (launchdPid === null) return false;
  const listener = deps.listenerPid(options.routerPort);
  return listener !== null && listener === launchdPid;
}

function fallbackPidOwned(deps: RouterEnsureDeps, pid: number): boolean {
  const cmd = deps.pidCommandLine(pid);
  if (cmd === null) return false;
  return (
    cmd.includes("run-codex-model-router.sh") ||
    cmd.includes("codex-model-router.mjs")
  );
}

async function rotateFallbackLog(
  deps: RouterEnsureDeps,
  options: RouterEnsureOptions
): Promise<void> {
  const stat = await deps.stat(options.paths.fallbackLog);
  if (stat && stat.size > options.fallbackLogMaxBytes) {
    try {
      await deps.rename(
        options.paths.fallbackLog,
        `${options.paths.fallbackLog}.1`
      );
    } catch {
      /* ignore */
    }
  }
}

function safeLaunchctlAvailable(): boolean {
  return existsSync("/bin/launchctl") || existsSync("/usr/bin/launchctl");
}

function safeLaunchctlPrint(
  deps: RouterEnsureDeps,
  options: RouterEnsureOptions
): string | null {
  try {
    return deps.launchd.print(options.label);
  } catch {
    return null;
  }
}

async function ensureViaLaunchd(
  deps: RouterEnsureDeps,
  options: RouterEnsureOptions
): Promise<0 | 1 | 2> {
  if (!safeLaunchctlAvailable()) return 2;

  if (deps.launchd.isLoaded(options.label)) {
    if (await deps.probe()) {
      const ownerPid = parseLaunchdPid(safeLaunchctlPrint(deps, options) ?? "");
      if (launchdOwnsListener(deps, options, ownerPid)) return 0;
      return 1;
    }
    try {
      deps.launchd.kickstart(options.label);
    } catch {
      return 1;
    }
    const started = await waitForProbe(deps, options);
    const ownerPid = parseLaunchdPid(safeLaunchctlPrint(deps, options) ?? "");
    if (started && launchdOwnsListener(deps, options, ownerPid)) return 0;
    return 1;
  }

  if (await deps.probe()) return 2;

  const plistExists = (await deps.stat(options.paths.plistLink)) !== null;
  if (!plistExists) return 2;
  try {
    deps.launchd.bootstrap(options.paths.plistLink);
  } catch {
    return 2;
  }
  try {
    deps.launchd.kickstart(options.label);
  } catch {
    return 1;
  }
  const started = await waitForProbe(deps, options);
  const ownerPid = parseLaunchdPid(safeLaunchctlPrint(deps, options) ?? "");
  if (started && launchdOwnsListener(deps, options, ownerPid)) return 0;
  return 1;
}

async function ensureViaFallback(
  deps: RouterEnsureDeps,
  options: RouterEnsureOptions
): Promise<0 | 2 | 3> {
  await deps.mkdir(options.paths.runDir, { recursive: true });
  await deps.chmod(options.paths.runDir, 0o700);

  const launcherStat = await deps.stat(options.paths.launcher);
  if (launcherStat === null) {
    return 2;
  }

  const existingPidRaw = await deps.readFile(options.paths.fallbackPidFile);
  const existingPid = /^[0-9]+$/.test(existingPidRaw.trim())
    ? Number.parseInt(existingPidRaw.trim(), 10)
    : Number.NaN;

  if (Number.isFinite(existingPid) && deps.pidExists(existingPid)) {
    if (fallbackPidOwned(deps, existingPid)) {
      if (await deps.probe()) return 0;
      deps.signalPid(existingPid, "SIGTERM");
      for (let i = 0; i < 50; i += 1) {
        if (!deps.pidExists(existingPid)) break;
        await deps.sleep(100);
      }
      if (deps.pidExists(existingPid)) deps.signalPid(existingPid, "SIGKILL");
    }
    await deps.unlink(options.paths.fallbackPidFile);
  } else if (Number.isFinite(existingPid)) {
    await deps.unlink(options.paths.fallbackPidFile);
  }

  if (await deps.probe()) return 3;

  await rotateFallbackLog(deps, options);
  await deps.writeFile(options.paths.fallbackLog, "");
  await deps.chmod(options.paths.fallbackLog, 0o600);

  const started = deps.startLauncher(
    "/bin/bash",
    [options.paths.launcher],
    options.paths.fallbackLog
  );
  await deps.writeFile(options.paths.fallbackPidFile, `${started.pid}\n`);
  await deps.chmod(options.paths.fallbackPidFile, 0o600);

  if (await waitForProbe(deps, options)) return 0;

  if (deps.pidExists(started.pid) && fallbackPidOwned(deps, started.pid)) {
    deps.signalPid(started.pid, "SIGKILL");
  }
  await deps.unlink(options.paths.fallbackPidFile);
  return 2;
}

async function readLogTail(
  deps: RouterEnsureDeps,
  logPath: string,
  lineCount = 40
): Promise<string[]> {
  const raw = await deps.readFile(logPath);
  if (!raw) return [];
  const lines = raw.split(/\r?\n/);
  return lines
    .slice(Math.max(0, lines.length - 1 - lineCount), -1)
    .filter((line) => line.length > 0);
}

function lockDirCleanup(lockDir: string, owned: boolean): void {
  if (!owned) return;
  try {
    rmSync(path.join(lockDir, "pid"), { force: true });
  } catch {
    /* ignore */
  }
  try {
    rmdirSync(lockDir);
  } catch {
    /* ignore */
  }
}

async function bestEffortCopilot(deps: RouterEnsureDeps): Promise<void> {
  if (!deps.ensureCopilot) return;
  try {
    await deps.ensureCopilot();
  } catch {
    /* Copilot is an optional fallback. */
  }
}

export async function runRouterEnsure(
  deps: RouterEnsureDeps,
  options: RouterEnsureOptions
): Promise<RouterEnsureResult> {
  let lockOwned = false;
  const removeExit = deps.setExitHandler(() =>
    lockDirCleanup(options.paths.lockDir, lockOwned)
  );
  try {
    if (!(await acquireLock(deps, options))) {
      return {
        status: "lock-contended",
        exitCode: 1,
        message: `another ensure invocation is in progress (lock held at ${options.paths.lockDir}).`
      };
    }
    lockOwned = true;

    const launchdResult = await ensureViaLaunchd(deps, options);
    if (launchdResult === 0) {
      await bestEffortCopilot(deps);
      return { status: "healthy-launchd", exitCode: 0 };
    }
    if (launchdResult === 1) {
      return {
        status: "launchd-failed",
        exitCode: 1,
        message: `Codex model router failed to start under launchd. LaunchAgent: ${options.paths.plistLink}`
      };
    }

    const fallbackResult = await ensureViaFallback(deps, options);
    if (fallbackResult === 0) {
      await bestEffortCopilot(deps);
      return { status: "healthy-fallback", exitCode: 0 };
    }
    if (fallbackResult === 3) {
      return {
        status: "duplicate-detected",
        exitCode: 1,
        message: `Codex model router: http://${options.routerHost}:${options.routerPort} is already serving traffic from an untracked process; refusing to start a duplicate.`
      };
    }
    const logTail = await readLogTail(deps, options.paths.fallbackLog);
    const message = `Codex model router fallback failed to start. Log: ${options.paths.fallbackLog}`;
    return { status: "fallback-failed", exitCode: 1, message, logTail };
  } finally {
    lockDirCleanup(options.paths.lockDir, lockOwned);
    lockOwned = false;
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
  resolveRouterEnsureOptionsFromEnv
};

if (process.argv[1] === new URL(import.meta.url).pathname) {
  const options = resolveRouterEnsureOptionsFromEnv(process.env, process.pid);
  runRouterEnsure(createDefaultRouterEnsureDeps(options), options).then(
    (result) => {
      if (result.message && result.exitCode !== 0)
        process.stderr.write(`${result.message}\n`);
      for (const line of result.logTail ?? [])
        process.stderr.write(`${line}\n`);
      process.exitCode = result.exitCode;
    }
  );
}
