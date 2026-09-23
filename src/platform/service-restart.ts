import { execFileSync, spawnSync } from "node:child_process";
import {
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  readSync,
  statSync
} from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

import { writeErrorLine } from "../shared/output.ts";
import { LaunchdClient } from "./macos/launchd.ts";

const WHITESPACE_SPLIT_PATTERN = /\s+/u;
const PID_NUMERIC_PATTERN = /^\d+$/u;
const AUTH_TOKEN_PATTERN =
  /<key>CODEX_HOME<\/key>\s*<string>([^<]+)<\/string>/u;
const JOB_PID_PATTERN = /^\tpid = (\d+)$/mu;
const JOB_LAST_EXIT_PATTERN = /^\tlast exit code = (\d+)/mu;
const JOB_STDERR_PATTERN = /^\tstderr path = (.+)$/mu;
const LOG_LINE_SPLIT_PATTERN = /\r?\n/u;

export const LABEL_MODEL_ROUTER = "com.codex.model-router";
export const LABEL_CLAUDE_BRIDGE = "com.codex.claude-bridge";
export const LABEL_MINIMAX_PROXY = "com.codex.minimax-proxy";
export const LABEL_ANTIGRAVITY_PROXY = "com.codex.antigravity-proxy";
export const LABEL_COPILOT_PROXY = "com.codex.copilot-proxy";
export const LABEL_OTEL_COLLECTOR = "com.codex.otel-collector";
export const MANAGED_SERVICE_LABELS = [
  LABEL_MODEL_ROUTER,
  LABEL_CLAUDE_BRIDGE,
  LABEL_MINIMAX_PROXY,
  LABEL_ANTIGRAVITY_PROXY,
  LABEL_COPILOT_PROXY,
  LABEL_OTEL_COLLECTOR
] as const;
export type ManagedServiceLabel = (typeof MANAGED_SERVICE_LABELS)[number];
export type OtelMode = "direct" | "collector";
export type KillSignal = "SIGTERM" | "SIGKILL";

export interface ServiceRestartOptions {
  readonly repositoryRoot: string;
  readonly home: string;
  readonly codexHome: string;
  readonly otelMode: OtelMode;
  readonly readyAttempts: number;
  readonly readyDelayMs: number;
}

export interface ServiceRestartDeps {
  readonly launchd: Pick<
    LaunchdClient,
    "isLoaded" | "print" | "bootout" | "bootstrap" | "enable"
  >;
  readonly fileExists: (filePath: string) => boolean;
  readonly readFile: (filePath: string) => string;
  readonly logTail: (filePath: string, lines: number) => readonly string[];
  readonly commandAvailable: (command: string) => boolean;
  /** GET the URL, or POST `jsonBody` as JSON when one is given. */
  readonly probe: (url: string, jsonBody?: string) => Promise<boolean>;
  readonly sleep: (ms: number) => Promise<void>;
  readonly run: (
    command: string,
    args: readonly string[],
    input?: string,
    env?: NodeJS.ProcessEnv
  ) => number;
  readonly listeningPids: (port: number) => readonly number[] | null;
  readonly commandLine: (pid: number) => string | null;
  readonly kill: (pid: number, signal: KillSignal) => void;
}

const DEFAULT_ATTEMPTS = 80;
const DEFAULT_DELAY_MS = 250;
// An unmanaged process gets the same graceful budget launchd gives the router
// (ExitTimeOut 45s) before it is killed outright.
const REAP_TERM_ATTEMPTS = 180;
const REAP_KILL_ATTEMPTS = 20;
const REAP_DELAY_MS = 250;
const FAILURE_LOG_LINES = 8;
const LOG_TAIL_BYTES = 16_384;

interface ServiceSpec {
  readonly label: ManagedServiceLabel;
  readonly probe: string;
  readonly jsonBody?: string;
  /** Only set where the launcher execs the server, so the job pid is the listener. */
  readonly ownedPort: number | null;
  readonly required: boolean;
}

const SERVICE_PORTS = {
  [LABEL_MODEL_ROUTER]: 4100,
  [LABEL_CLAUDE_BRIDGE]: 4000,
  [LABEL_MINIMAX_PROXY]: 18_765,
  [LABEL_ANTIGRAVITY_PROXY]: 4002,
  [LABEL_COPILOT_PROXY]: 4003,
  [LABEL_OTEL_COLLECTOR]: 4318
} as const satisfies Record<ManagedServiceLabel, number>;

const BRIDGE_SPECS: readonly ServiceSpec[] = [
  {
    label: LABEL_MODEL_ROUTER,
    probe: "http://127.0.0.1:4100/health/readiness",
    ownedPort: SERVICE_PORTS[LABEL_MODEL_ROUTER],
    required: true
  },
  {
    label: LABEL_CLAUDE_BRIDGE,
    probe: "http://127.0.0.1:4000/health/liveliness",
    ownedPort: SERVICE_PORTS[LABEL_CLAUDE_BRIDGE],
    required: false
  },
  {
    label: LABEL_MINIMAX_PROXY,
    probe: "http://127.0.0.1:18765/health",
    ownedPort: SERVICE_PORTS[LABEL_MINIMAX_PROXY],
    required: false
  },
  {
    label: LABEL_ANTIGRAVITY_PROXY,
    probe: "http://127.0.0.1:4002/health/liveliness",
    ownedPort: SERVICE_PORTS[LABEL_ANTIGRAVITY_PROXY],
    required: false
  },
  {
    label: LABEL_COPILOT_PROXY,
    probe: "http://127.0.0.1:4003/health/liveliness",
    ownedPort: SERVICE_PORTS[LABEL_COPILOT_PROXY],
    required: false
  }
];

const COLLECTOR_SPEC: ServiceSpec = {
  label: LABEL_OTEL_COLLECTOR,
  probe: "http://127.0.0.1:4318/v1/logs",
  // An empty OTLP export: a bare POST is refused with 415 by the receiver.
  jsonBody: "{}",
  ownedPort: null,
  required: true
};

export function resolveServiceRestartOptions(
  env: NodeJS.ProcessEnv = process.env
): ServiceRestartOptions {
  const home = env.HOME?.trim() || homedir();
  return {
    repositoryRoot: env.AUTODEV_REPO_ROOT?.trim() || process.cwd(),
    home,
    codexHome: env.CODEX_HOME?.trim() || path.join(home, ".codex"),
    otelMode: env.AUTODEV_OTEL_MODE === "collector" ? "collector" : "direct",
    readyAttempts: positiveInteger(
      env.AUTODEV_SERVICE_READY_ATTEMPTS,
      DEFAULT_ATTEMPTS
    ),
    readyDelayMs: positiveInteger(
      env.AUTODEV_SERVICE_READY_DELAY_MS,
      DEFAULT_DELAY_MS
    )
  };
}

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? "");
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function readLogTail(filePath: string, lines: number): string[] {
  let fd: number | null = null;
  try {
    const size = statSync(filePath).size;
    const length = Math.min(size, LOG_TAIL_BYTES);
    const buffer = Buffer.alloc(length);
    fd = openSync(filePath, "r");
    readSync(fd, buffer, 0, length, size - length);
    return buffer
      .toString("utf8")
      .split(LOG_LINE_SPLIT_PATTERN)
      .filter((line) => line.trim().length > 0)
      .slice(-lines);
  } catch {
    return [];
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

function defaultDeps(): ServiceRestartDeps {
  return {
    launchd: new LaunchdClient(),
    fileExists: existsSync,
    readFile: (filePath) => {
      try {
        return readFileSync(filePath, "utf8");
      } catch {
        return "";
      }
    },
    logTail: readLogTail,
    commandAvailable: (command) => {
      try {
        execFileSync("which", [command], { stdio: "ignore" });
        return true;
      } catch {
        return false;
      }
    },
    probe: async (url, jsonBody) => {
      try {
        const response = await fetch(url, {
          ...(jsonBody === undefined
            ? {}
            : {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: jsonBody
              }),
          signal: AbortSignal.timeout(1000)
        });
        return response.ok;
      } catch {
        return false;
      }
    },
    sleep: (ms) =>
      new Promise((resolve) => {
        setTimeout(resolve, ms);
      }),
    run: (command, args, input, env) => {
      const stdio: "inherit" | ["pipe", "inherit", "inherit"] =
        input === undefined ? "inherit" : ["pipe", "inherit", "inherit"];
      return (
        spawnSync(command, [...args], {
          input,
          env: { ...process.env, ...env },
          stdio
        }).status ?? 1
      );
    },
    listeningPids: (port) => {
      try {
        const output = execFileSync(
          "lsof",
          ["-nP", "-tiTCP:" + port, "-sTCP:LISTEN"],
          { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }
        );
        return output
          .split(WHITESPACE_SPLIT_PATTERN)
          .filter((pid) => PID_NUMERIC_PATTERN.test(pid))
          .map(Number);
      } catch {
        return null;
      }
    },
    commandLine: (pid) => {
      try {
        return execFileSync("ps", ["-o", "command=", "-p", String(pid)], {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"]
        }).trim();
      } catch {
        return null;
      }
    },
    kill: (pid, signal) => {
      try {
        process.kill(pid, signal);
      } catch {
        /* process exited */
      }
    }
  };
}

function plistPath(
  options: ServiceRestartOptions,
  label: ManagedServiceLabel
): string {
  return path.join(options.home, "Library", "LaunchAgents", `${label}.plist`);
}

function serviceLauncher(
  options: ServiceRestartOptions,
  label: ManagedServiceLabel
): string {
  const hooks = path.join(options.codexHome, "hooks");
  switch (label) {
    case LABEL_MODEL_ROUTER: {
      return path.join(hooks, "run-codex-model-router.sh");
    }
    case LABEL_CLAUDE_BRIDGE: {
      return path.join(hooks, "run-codex-claude-bridge.sh");
    }
    case LABEL_ANTIGRAVITY_PROXY: {
      return path.join(hooks, "run-codex-antigravity-proxy.sh");
    }
    case LABEL_COPILOT_PROXY: {
      return path.join(hooks, "run-codex-copilot-cli-responses-proxy.sh");
    }
    case LABEL_MINIMAX_PROXY: {
      return path.join(hooks, "ensure-codex-minimax-proxy.sh");
    }
    case LABEL_OTEL_COLLECTOR: {
      return path.join(hooks, "otel", "run-autodev-otel-collector.sh");
    }
    default: {
      throw new Error(`unknown managed service label: ${label}`);
    }
  }
}

function serviceHook(
  options: ServiceRestartOptions,
  label: ManagedServiceLabel
): string {
  switch (label) {
    case LABEL_MODEL_ROUTER: {
      return path.join(options.codexHome, "src", "router", "server.ts");
    }
    case LABEL_CLAUDE_BRIDGE: {
      return path.join(options.codexHome, "src", "providers", "claude.ts");
    }
    case LABEL_ANTIGRAVITY_PROXY: {
      return path.join(options.codexHome, "src", "providers", "antigravity.ts");
    }
    case LABEL_COPILOT_PROXY: {
      return path.join(options.codexHome, "src", "providers", "copilot.ts");
    }
    case LABEL_MINIMAX_PROXY: {
      return path.join(options.codexHome, "src", "providers", "minimax.ts");
    }
    case LABEL_OTEL_COLLECTOR: {
      return serviceLauncher(options, label);
    }
    default: {
      throw new Error(`unknown managed service label: ${label}`);
    }
  }
}

function plistOwner(
  options: ServiceRestartOptions,
  deps: ServiceRestartDeps
): string | null {
  const filePath = plistPath(options, LABEL_MODEL_ROUTER);
  if (!deps.fileExists(filePath)) return null;
  const match = AUTH_TOKEN_PATTERN.exec(deps.readFile(filePath));
  return match?.[1] ?? null;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message.trim() : String(error);
}

async function waitForPortRelease(
  deps: ServiceRestartDeps,
  port: number,
  pid: number,
  attempts: number
): Promise<boolean> {
  if (!(deps.listeningPids(port) ?? []).includes(pid)) return true;
  if (attempts <= 0) return false;
  await deps.sleep(REAP_DELAY_MS);
  return waitForPortRelease(deps, port, pid, attempts - 1);
}

/**
 * Stop a process this CODEX_HOME's hook runs outside launchd, and wait until
 * it has let go of the port: bootstrapping while it still listens starts a
 * KeepAlive EADDRINUSE crash loop.
 */
async function reapUnmanaged(
  options: ServiceRestartOptions,
  label: ManagedServiceLabel,
  deps: ServiceRestartDeps,
  pids: readonly number[] = deps.listeningPids(SERVICE_PORTS[label]) ?? []
): Promise<boolean> {
  const [pid, ...rest] = pids;
  if (pid === undefined) return true;
  const port = SERVICE_PORTS[label];
  if (!deps.commandLine(pid)?.includes(serviceHook(options, label))) {
    writeErrorLine(
      `port ${port} held by a process this installer does not own (pid ${pid}); ${label} not started`
    );
    return false;
  }
  writeErrorLine(`reaping unmanaged ${label} on port ${port} (pid ${pid})`);
  deps.kill(pid, "SIGTERM");
  if (!(await waitForPortRelease(deps, port, pid, REAP_TERM_ATTEMPTS))) {
    deps.kill(pid, "SIGKILL");
    if (!(await waitForPortRelease(deps, port, pid, REAP_KILL_ATTEMPTS))) {
      writeErrorLine(
        `pid ${pid} still holds port ${port}; ${label} not started`
      );
      return false;
    }
  }
  return reapUnmanaged(options, label, deps, rest);
}

async function runDirectEnsures(
  options: ServiceRestartOptions,
  deps: ServiceRestartDeps
): Promise<number> {
  await Promise.resolve();
  const run = (
    script: string,
    input?: string,
    env?: NodeJS.ProcessEnv
  ): number => deps.run("/bin/bash", [script], input, env);
  if (
    run(
      path.join(
        options.repositoryRoot,
        "scripts",
        "ensure-codex-model-router.sh"
      )
    ) !== 0
  )
    return 1;
  if (options.otelMode === "collector") {
    const collector = path.join(
      options.codexHome,
      "hooks",
      "otel",
      "ensure-autodev-otel-collector.sh"
    );
    if (
      run(collector, undefined, {
        AUTODEV_OTEL_REPO_ROOT: options.repositoryRoot,
        AUTODEV_OTEL_CONFIG: path.join(
          options.repositoryRoot,
          "config",
          "otel",
          "collector.yaml"
        ),
        AUTODEV_OTEL_VERSION_FILE: path.join(
          options.repositoryRoot,
          "config",
          "otel",
          "collector.version"
        )
      }) !== 0
    )
      return 1;
  }
  for (const [model, script] of [
    ["sonnet", "ensure-codex-claude-bridge.sh"],
    ["MiniMax-M3", "ensure-codex-minimax-proxy.sh"],
    ["gemini-3.8-flash-medium", "ensure-codex-antigravity-proxy.sh"]
  ] as const) {
    if (
      run(
        path.join(options.repositoryRoot, "scripts", script),
        `{"model":"${model}"}\n`
      ) !== 0
    )
      writeErrorLine(
        `bridge start failed: ${script} (router will route around it)`
      );
  }
  if (
    run(
      path.join(
        options.repositoryRoot,
        "scripts",
        "ensure-codex-copilot-proxy.sh"
      )
    ) !== 0
  )
    writeErrorLine(
      "bridge start failed: ensure-codex-copilot-proxy.sh (router will route around it)"
    );
  return 0;
}

function isOwnedService(
  options: ServiceRestartOptions,
  label: ManagedServiceLabel,
  jobDump: string
): boolean {
  if (jobDump.includes(serviceLauncher(options, label))) return true;
  const hooks = path.join(options.codexHome, "hooks");
  return jobDump.includes(options.codexHome) || jobDump.includes(hooks);
}

interface JobState {
  readonly pid: number | null;
  readonly lastExitCode: number | null;
  readonly stderrPath: string | null;
}

function parseJobState(jobDump: string): JobState {
  const pid = JOB_PID_PATTERN.exec(jobDump)?.[1];
  const exit = JOB_LAST_EXIT_PATTERN.exec(jobDump)?.[1];
  return {
    pid: pid === undefined ? null : Number.parseInt(pid),
    lastExitCode: exit === undefined ? null : Number.parseInt(exit),
    stderrPath: JOB_STDERR_PATTERN.exec(jobDump)?.[1]?.trim() ?? null
  };
}

type ServiceCheck =
  | { readonly ready: true }
  | {
      readonly ready: false;
      readonly reason: string;
      readonly stderrPath: string | null;
    };

/**
 * A freshly bootstrapped job has never exited, so any recorded exit code means
 * it is crash-looping under KeepAlive: report that at once instead of waiting
 * out the readiness budget on a process that will never answer.
 */
async function checkService(
  deps: ServiceRestartDeps,
  options: ServiceRestartOptions,
  spec: ServiceSpec,
  attempt = 0
): Promise<ServiceCheck> {
  const job = parseJobState(readLaunchdJobDump(deps, spec.label));
  if (job.lastExitCode !== null && job.lastExitCode !== 0)
    return {
      ready: false,
      reason: `exited with code ${job.lastExitCode}`,
      stderrPath: job.stderrPath
    };
  if (await deps.probe(spec.probe, spec.jsonBody)) {
    if (spec.ownedPort === null) return { ready: true };
    const listeners = deps.listeningPids(spec.ownedPort) ?? [];
    if (job.pid !== null && listeners.includes(job.pid)) return { ready: true };
    return {
      ready: false,
      reason: `port ${spec.ownedPort} is served by pid ${listeners.join(", ") || "unknown"}, not the launchd job (pid ${job.pid ?? "none"})`,
      stderrPath: job.stderrPath
    };
  }
  if (attempt + 1 >= options.readyAttempts)
    return {
      ready: false,
      reason: `did not become ready within ${options.readyAttempts * options.readyDelayMs}ms`,
      stderrPath: job.stderrPath
    };
  await deps.sleep(options.readyDelayMs);
  return checkService(deps, options, spec, attempt + 1);
}

/** Confirm every supervised service is up and owned by its launchd job. */
async function verifySupervisedServices(
  deps: ServiceRestartDeps,
  options: ServiceRestartOptions
): Promise<number> {
  const specs =
    options.otelMode === "collector"
      ? [...BRIDGE_SPECS, COLLECTOR_SPEC]
      : BRIDGE_SPECS;
  const checks = await Promise.all(
    specs.map((spec) => checkService(deps, options, spec))
  );
  let status = 0;
  for (const [index, check] of checks.entries()) {
    const spec = specs[index];
    if (!spec || check.ready) continue;
    writeErrorLine(
      `${spec.label} is not running: ${check.reason}${spec.required ? "" : " (router will route around it)"}`
    );
    if (check.stderrPath) {
      writeErrorLine(`  log: ${check.stderrPath}`);
      for (const line of deps.logTail(check.stderrPath, FAILURE_LOG_LINES))
        writeErrorLine(`  | ${line}`);
    }
    if (spec.required) status = 1;
  }
  return status;
}

function foreignOwnedHookResult(
  options: ServiceRestartOptions,
  owner: string | null
): number | null {
  if (
    !owner ||
    path.join(options.codexHome, "hooks") === path.join(owner, "hooks")
  )
    return null;
  writeErrorLine(
    `materialized into ${path.join(options.codexHome, "hooks")}; leaving the services under ${path.join(owner, "hooks")} alone.`
  );
  return 0;
}

function readLaunchdJobDump(
  deps: ServiceRestartDeps,
  label: ManagedServiceLabel
): string {
  try {
    return deps.launchd.print(label);
  } catch {
    /* treat as unavailable */
  }
  return "";
}

type ReloadResult = "ok" | "no-plist" | "disabled-otel" | "failed";

function foreignLabels(
  deps: ServiceRestartDeps,
  options: ServiceRestartOptions
): ManagedServiceLabel[] {
  return MANAGED_SERVICE_LABELS.filter(
    (label) =>
      deps.launchd.isLoaded(label) &&
      !isOwnedService(options, label, readLaunchdJobDump(deps, label))
  );
}

/**
 * Replace a label's job: unload the old one, clear stray listeners, then
 * bootstrap. Every managed plist sets RunAtLoad, so bootstrap starts the
 * service; a following `kickstart -k` would kill that fresh instance
 * mid-startup and stall for launchd's ThrottleInterval before respawning it.
 */
async function reloadOneLabel(
  deps: ServiceRestartDeps,
  options: ServiceRestartOptions,
  label: ManagedServiceLabel
): Promise<ReloadResult> {
  const disableCollector =
    label === LABEL_OTEL_COLLECTOR && options.otelMode === "direct";
  const plist = plistPath(options, label);
  if (!disableCollector && !deps.fileExists(plist)) return "no-plist";
  try {
    deps.launchd.bootout(label);
  } catch (error) {
    writeErrorLine(`could not unload ${label}: ${errorText(error)}`);
    return "failed";
  }
  if (disableCollector) return "disabled-otel";
  if (!(await reapUnmanaged(options, label, deps))) return "failed";
  try {
    deps.launchd.enable(label);
    deps.launchd.bootstrap(plist);
    return "ok";
  } catch (error) {
    writeErrorLine(`could not load ${label}: ${errorText(error)}`);
    return "failed";
  }
}

async function reloadLabels(
  deps: ServiceRestartDeps,
  options: ServiceRestartOptions,
  index = 0,
  results: ReloadResult[] = []
): Promise<ReloadResult[]> {
  const label = MANAGED_SERVICE_LABELS[index];
  if (label === undefined) return results;
  results.push(await reloadOneLabel(deps, options, label));
  return reloadLabels(deps, options, index + 1, results);
}

export async function restartServices(
  options: ServiceRestartOptions = resolveServiceRestartOptions(),
  deps: ServiceRestartDeps = defaultDeps()
): Promise<number> {
  const owner = plistOwner(options, deps);
  const foreignOwnerResult = foreignOwnedHookResult(options, owner);
  if (foreignOwnerResult !== null) return foreignOwnerResult;

  if (!deps.commandAvailable("launchctl")) {
    writeErrorLine(
      "launchctl unavailable (sandbox?); starting bridges through the direct ensure-hook path."
    );
    return runDirectEnsures(options, deps);
  }
  const foreign = foreignLabels(deps, options);
  if (foreign.length > 0) {
    for (const label of foreign)
      writeErrorLine(
        `loaded ${label} belongs to another runtime; leaving it alone.`
      );
    writeErrorLine(
      "another AutoDev runtime owns one or more labels; leaving all active services untouched."
    );
    return 0;
  }
  const results = await reloadLabels(deps, options);
  const failedLabels = MANAGED_SERVICE_LABELS.filter(
    (_label, index) => results[index] === "failed"
  );
  if (failedLabels.length > 0) {
    writeErrorLine(
      `launchd could not load ${failedLabels.join(", ")}; starting bridges through the direct ensure-hook path.`
    );
    return runDirectEnsures(options, deps);
  }
  writeErrorLine(
    "Provider bridges supervised by launchd (KeepAlive; survive restart/crash/sleep)."
  );
  return verifySupervisedServices(deps, options);
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  restartServices()
    .then((status) => {
      process.exitCode = status;
      return status;
    })
    .catch((error) => {
      writeErrorLine(
        `service-restart: ${error instanceof Error ? error.message : String(error)}`
      );
      process.exitCode = 1;
      return 1;
    });
}
